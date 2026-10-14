#!/usr/bin/env python3
"""
Agente de alta de proveedores (corre en GitHub Actions).

  1. web_campaign_agent_claim   -> toma un trabajo: texto pegado + catálogo vivo
  2. OpenCode (modelos free)    -> texto plano -> JSON de proveedores
  3. web_campaign_agent_finish  -> la base de datos valida y crea los completos

La base de datos crea los proveedores que salgan completos y deja el resto
para que un administrador los complete en la web.

── Este repositorio y sus logs son PÚBLICOS ───────────────────────────────────
  · Nada de lo que se lee o genera se imprime: ni el texto, ni la salida del
    modelo, ni un error que pueda arrastrarlos. El log solo lleva códigos y
    conteos.
  · El texto pegado es un dato no confiable y el modelo corre con herramientas
    (el nivel gratuito de OpenCode rechaza las peticiones si se le quitan). Por
    eso corre en un directorio vacío, con un entorno sin secretos, y la clave
    del runner llega por un fichero que se borra ANTES de lanzarlo: ningún
    proceso la tiene en su entorno.
  · Esa clave solo abre las dos RPC de arriba (no es la service role): sirve
    para leer el texto en cola y dar de alta proveedores, nada más.

Solo biblioteca estándar.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

AQUI = Path(__file__).resolve().parent

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
AGENT_KEY = ""
JOB_ID = os.environ.get("JOB_ID", "").strip()

MODELO_BASE = "opencode/big-pickle"
MAX_INTENTOS = 5
TIMEOUT_MODELO = 240
MAX_TRABAJOS = 5

CAMPOS_TEXTO = (
    "brand", "email", "phone", "first_name", "last_name",
    "specialty", "bio", "region_text", "address_text", "note",
)


def log(mensaje: str) -> None:
    print(mensaje, flush=True)


# --------------------------------------------------------------------------- rpc

def rpc(nombre: str, params: dict) -> dict:
    """Llama a una RPC. Los errores se reducen a un código: el cuerpo no se imprime."""
    peticion = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{nombre}",
        data=json.dumps({"p_params": params}).encode("utf-8"),
        headers={
            "apikey": ANON_KEY,
            "Authorization": f"Bearer {ANON_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(peticion, timeout=30) as respuesta:
            return json.loads(respuesta.read().decode("utf-8") or "null") or {}
    except urllib.error.HTTPError as error:
        codigo = ""
        try:
            codigo = str(json.loads(error.read().decode("utf-8")).get("message", ""))[:40]
        except Exception:
            pass
        raise RuntimeError(f"RPC_{error.code}_{re.sub(r'[^A-Z_]', '', codigo)}") from None
    except Exception:
        raise RuntimeError("RPC_SIN_CONEXION") from None


# ------------------------------------------------------------------------ prompt

def construir_prompt(trabajo: dict) -> tuple[str, set[str]]:
    plantilla = (AQUI / "prompt.md").read_text(encoding="utf-8")

    lineas, ids = [], set()
    for categoria in trabajo.get("catalog") or []:
        for sub in categoria.get("subcategories") or []:
            ids.add(sub["id"])
            lineas.append(f"{sub['id']} | {categoria['label']} › {sub['label']}")

    lugares = []
    for lugar in trabajo.get("places") or []:
        municipios = ", ".join(lugar.get("cities") or [])
        lugares.append(f"{lugar['region']}: {municipios}" if municipios else lugar["region"])

    partes = [
        plantilla,
        "---",
        "CATÁLOGO (id | categoría › subcategoría):\n" + "\n".join(lineas),
        "LUGARES conocidos (provincia: municipios):\n" + ("\n".join(lugares) or "(ninguno)"),
        "INSTRUCCIONES del administrador:\n" + (trabajo.get("instructions") or "(ninguna)"),
        "TEXTO:\n<<<\n" + (trabajo.get("text") or "") + "\n>>>",
    ]
    return "\n\n".join(partes), ids


# ------------------------------------------------------------------------ modelo

def cadena_de_modelos() -> list[str]:
    """Los configurados, luego los free del catálogo vivo del CLI, luego el base."""
    cadena = [m.strip() for m in os.environ.get("AGENT_MODELS", "").split(",") if m.strip()]
    try:
        salida = subprocess.run(
            ["opencode", "models"], capture_output=True, text=True, timeout=60,
            env=entorno_limpio(),
        ).stdout
        cadena += [l.strip() for l in salida.splitlines()
                   if l.startswith("opencode/") and "free" in l]
    except Exception:
        pass
    cadena.append(MODELO_BASE)

    vistos, unicos = set(), []
    for modelo in cadena:
        if "/" not in modelo:
            modelo = f"opencode/{modelo}"
        if modelo not in vistos:
            vistos.add(modelo)
            unicos.append(modelo)
    return unicos


def entorno_limpio() -> dict:
    """Entorno del modelo: sin la clave del runner ni nada de GitHub."""
    return {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "LANG", "TERM")}


def extraer_json(texto: str):
    """El último objeto JSON de la salida que tenga la clave 'providers'."""
    candidatos, i = [], 0
    while i < len(texto):
        if texto[i] == "{":
            nivel, j, en_cadena, escape = 0, i, False, False
            while j < len(texto):
                c = texto[j]
                if en_cadena:
                    if escape:
                        escape = False
                    elif c == "\\":
                        escape = True
                    elif c == '"':
                        en_cadena = False
                elif c == '"':
                    en_cadena = True
                elif c == "{":
                    nivel += 1
                elif c == "}":
                    nivel -= 1
                    if nivel == 0:
                        candidatos.append(texto[i:j + 1])
                        i = j
                        break
                j += 1
        i += 1

    for bloque in reversed(candidatos):
        try:
            dato = json.loads(bloque)
        except Exception:
            continue
        if isinstance(dato, dict) and isinstance(dato.get("providers"), list):
            return dato
    return None


def preguntar(prompt: str, modelo: str):
    carpeta = Path(tempfile.mkdtemp(prefix="agente-"))
    try:
        proceso = subprocess.run(
            ["opencode", "run", "--pure", "--auto", "--model", modelo, prompt],
            capture_output=True, text=True, timeout=TIMEOUT_MODELO,
            cwd=carpeta, env=entorno_limpio(), stdin=subprocess.DEVNULL,
        )
        return extraer_json(proceso.stdout or "")
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None
    finally:
        shutil.rmtree(carpeta, ignore_errors=True)


# --------------------------------------------------------------------- limpieza

def solo_digitos(valor: str) -> str:
    return re.sub(r"\D", "", valor or "")


def limpiar(dato: dict, texto: str, ids: set[str]) -> tuple[list[dict], dict]:
    """
    Segunda barrera contra lo inventado (la tercera es la base de datos):
      · un correo o un teléfono que no esté escrito en el texto se descarta;
      · un subcategory_id que no esté en el catálogo se descarta.
    """
    texto_min = texto.lower()
    digitos_texto = solo_digitos(texto)
    cuenta = {"correos": 0, "telefonos": 0, "servicios": 0}
    salida = []

    for bruto in dato.get("providers") or []:
        if not isinstance(bruto, dict):
            continue

        p = {}
        for campo in CAMPOS_TEXTO:
            valor = bruto.get(campo)
            p[campo] = str(valor).strip() if isinstance(valor, (str, int, float)) and str(valor).strip() else None

        if not p["brand"]:
            continue

        if p["email"] and p["email"].lower() not in texto_min:
            p["email"] = None
            cuenta["correos"] += 1

        if p["phone"]:
            nacional = solo_digitos(p["phone"])
            nacional = nacional[2:] if nacional.startswith("53") and len(nacional) == 10 else nacional
            if len(nacional) < 6 or nacional not in digitos_texto:
                p["phone"] = None
                cuenta["telefonos"] += 1

        servicios = []
        for s in bruto.get("services") or []:
            if not isinstance(s, dict):
                continue
            if s.get("subcategory_id") not in ids:
                cuenta["servicios"] += 1
                continue
            servicios.append({
                "subcategory_id": s["subcategory_id"],
                "name": s.get("name") if isinstance(s.get("name"), str) else None,
                "description": s.get("description") if isinstance(s.get("description"), str) else None,
                "min_price": s.get("min_price") if isinstance(s.get("min_price"), (int, float)) else None,
                "max_price": s.get("max_price") if isinstance(s.get("max_price"), (int, float)) else None,
            })
        p["services"] = servicios
        salida.append(p)

    return salida, cuenta


# ------------------------------------------------------------------------- main

def procesar(trabajo: dict, modelos: list[str]) -> None:
    job_id = trabajo["job_id"]
    log(f"::group::trabajo {job_id}")
    prompt, ids = construir_prompt(trabajo)
    log(f"catálogo: {len(ids)} subcategorías · texto: {len(trabajo.get('text') or '')} caracteres")

    resultado, usado = None, None
    for intento, modelo in enumerate(modelos[:MAX_INTENTOS], 1):
        log(f"intento {intento}: {modelo}")
        resultado = preguntar(prompt, modelo)
        if resultado is not None:
            usado = modelo
            break
        log("  sin JSON válido, se prueba el siguiente")

    if resultado is None:
        rpc("web_campaign_agent_finish",
            {"key": AGENT_KEY, "job_id": job_id, "error": "MODEL_NO_OUTPUT"})
        log("::warning::ningún modelo devolvió el JSON esperado")
        log("::endgroup::")
        return

    proveedores, cuenta = limpiar(resultado, trabajo.get("text") or "", ids)
    fin = rpc("web_campaign_agent_finish", {
        "key": AGENT_KEY, "job_id": job_id, "model": usado, "providers": proveedores,
    })
    log(f"proveedores: {fin.get('proposals', 0)} · creados: {fin.get('created', 0)} · descartado por no estar en el texto/catálogo: "
        f"{cuenta['correos']} correos, {cuenta['telefonos']} teléfonos, {cuenta['servicios']} servicios")
    if fin.get("error"):
        log(f"::warning::{fin['error']}")
    log("::endgroup::")


def leer_clave() -> str:
    """La clave llega en un fichero de un solo uso (ver el workflow)."""
    ruta = os.environ.get("AGENT_KEY_FILE", "")
    if not ruta:
        return ""
    try:
        clave = Path(ruta).read_text(encoding="utf-8").strip()
        Path(ruta).unlink()
        return clave
    except Exception:
        return ""


def main() -> int:
    global AGENT_KEY
    AGENT_KEY = leer_clave()
    if not (SUPABASE_URL and ANON_KEY and AGENT_KEY):
        log("::error::faltan SUPABASE_URL / SUPABASE_ANON_KEY / la clave del runner")
        return 1
    if JOB_ID and not re.fullmatch(r"[0-9a-fA-F-]{36}", JOB_ID):
        log("::error::job_id no es un uuid")
        return 1

    modelos = None
    for _ in range(MAX_TRABAJOS):
        try:
            trabajo = rpc("web_campaign_agent_claim",
                          {"key": AGENT_KEY, **({"job_id": JOB_ID} if JOB_ID else {})})
        except RuntimeError as error:
            log(f"::error::{error}")
            return 1

        if not trabajo.get("job_id"):
            log("no hay trabajos pendientes")
            break

        if modelos is None:
            modelos = cadena_de_modelos()

        try:
            procesar(trabajo, modelos)
        except RuntimeError as error:
            log(f"::error::{error}")
            return 1
        except Exception as error:  # nunca el mensaje: puede arrastrar el texto
            log(f"::error::fallo interno ({type(error).__name__})")
            try:
                rpc("web_campaign_agent_finish",
                    {"key": AGENT_KEY, "job_id": trabajo["job_id"], "error": "RUNNER_ERROR"})
            except RuntimeError:
                pass
            return 1

        if JOB_ID:
            break

    return 0


if __name__ == "__main__":
    sys.exit(main())
