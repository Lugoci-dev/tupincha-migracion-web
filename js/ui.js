/* =============================================================================
   Piezas de interfaz compartidas: escape, fechas, avisos y el diálogo.
   Todo lo que llega del servidor pasa por esc() antes de tocar innerHTML.
   ============================================================================= */

export const $ = (id) => document.getElementById(id);

export function esc(valor) {
  return String(valor == null ? "" : valor)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function plural(n, uno, varios) {
  return n + " " + (n === 1 ? uno : varios);
}

export function fechaCorta(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return d.toLocaleDateString("es-CU", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("es-CU", { hour: "2-digit", minute: "2-digit" });
}

/* ------------------------------------------------------------------ avisos */

/** Aviso breve que no interrumpe. tono: "ok" | "error" | "info". */
export function aviso(texto, tono) {
  const el = document.createElement("div");
  el.className = "toast " + (tono || "info");
  el.setAttribute("role", tono === "error" ? "alert" : "status");
  el.textContent = texto;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("fuera");
    setTimeout(() => el.remove(), 250);
  }, tono === "error" ? 7000 : 4000);
}

/** Traduce un error de RPC a algo que se pueda leer. */
export function motivo(err) {
  const conocidos = {
    NOT_ALLOWED: "tu usuario no tiene permiso para esto",
    NOT_FOUND: "ya no existe",
    UNAUTHENTICATED: "la sesión caducó",
    CAMPAIGN_KEY_NOT_CONFIGURED: "falta configurar la clave de envío",
    TEXT_TOO_SHORT: "el texto es demasiado corto",
    TEXT_TOO_LONG: "el texto pasa de 20 000 caracteres: divídelo",
    TOO_MANY_JOBS: "ya hay varios análisis en curso, espera a que terminen",
    INVALID_STATUS: "ese cambio ya no es posible",
  };
  if (err && conocidos[err.message]) return conocidos[err.message];
  if (err instanceof TypeError) return "sin conexión";
  return (err && err.message) || "error desconocido";
}

/* ----------------------------------------------------------------- diálogo */

let antesDeAbrir = null;

export function abrirDialogo({ titulo, cuerpo, pie }) {
  antesDeAbrir = document.activeElement;
  $("dialogTitle").textContent = titulo;
  $("dialogBody").innerHTML = cuerpo || "";
  $("dialogFooter").innerHTML = pie || "";
  $("dialogFooter").hidden = !pie;
  const dlg = $("dialog");
  if (!dlg.open) dlg.showModal();
}

export function actualizarDialogo({ cuerpo, pie }) {
  if (cuerpo !== undefined) $("dialogBody").innerHTML = cuerpo;
  if (pie !== undefined) {
    $("dialogFooter").innerHTML = pie;
    $("dialogFooter").hidden = !pie;
  }
}

export function cerrarDialogo() {
  const dlg = $("dialog");
  if (dlg.open) dlg.close();
  if (antesDeAbrir && antesDeAbrir.focus) antesDeAbrir.focus();
}

/** Confirmación para acciones que no se deshacen. Resuelve true / false. */
export function confirmar({ titulo, texto, aceptar, peligro }) {
  return new Promise((resolve) => {
    abrirDialogo({
      titulo,
      cuerpo: '<p class="lead">' + esc(texto) + "</p>",
      pie:
        '<button class="btn btn-ghost" data-confirmar="no">Cancelar</button>' +
        '<button class="btn ' + (peligro ? "btn-danger" : "btn-primary") +
        '" data-confirmar="si">' + esc(aceptar) + "</button>",
    });
    const dlg = $("dialog");
    const alClic = (ev) => {
      const b = ev.target.closest("[data-confirmar]");
      if (!b) return;
      terminar(b.dataset.confirmar === "si");
    };
    const alCerrar = () => terminar(false);
    function terminar(valor) {
      dlg.removeEventListener("click", alClic);
      dlg.removeEventListener("close", alCerrar);
      cerrarDialogo();
      resolve(valor);
    }
    dlg.addEventListener("click", alClic);
    dlg.addEventListener("close", alCerrar);
  });
}

/* -------------------------------------------------- problemas de validación */

const PROBLEMAS = {
  BRAND_REQUIRED: "Falta el nombre o la marca.",
  EMAIL_REQUIRED: "Falta el correo: sin correo no se puede crear la cuenta.",
  EMAIL_INVALID: "El correo no tiene un formato válido.",
  EMAIL_EXISTS: "Ya existe una cuenta con ese correo.",
  PHONE_INVALID: "El teléfono no es válido (8 dígitos, o con +código de país).",
  PHONE_DUPLICATE: "Ese teléfono ya lo tiene otro contacto",
  PHONE_MISSING: "Sin teléfono: solo se le podrá avisar por correo, y no saldrá en la app hasta que añada uno y lo verifique.",
  SUBCATEGORY_NOT_FOUND: "Servicio fuera del catálogo, no se incluye",
  NO_SERVICES: "Sin servicios: se crea solo la cuenta y el perfil.",
  CREATE_FAILED: "No se pudo crear automáticamente: complétalo a mano.",
  NO_LOCATION: "Sin ubicación conocida para esa zona: no saldrá en la búsqueda por cercanía hasta que la ponga en la app.",
  DEFAULT_LOCATION: "Zona sin indicar o no reconocida: se le pone La Habana por defecto para que el perfil quede completo. Corrígela aquí si la sabes; si no, la cambia él en la app. Zona usada",
};

export function textoProblema(p) {
  const base = PROBLEMAS[p.code] || p.code;
  return p.detail ? base.replace(/\.$/, "") + ": " + p.detail + "." : base;
}

export function listaProblemas(problemas) {
  if (!problemas || !problemas.length) return "";
  return '<ul class="issues">' + problemas.map((p) =>
    '<li class="' + (p.level === "error" ? "error" : "warn") + '">' + esc(textoProblema(p)) + "</li>"
  ).join("") + "</ul>";
}

export function tieneErrores(problemas) {
  return (problemas || []).some((p) => p.level === "error");
}
