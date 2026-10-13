/* =============================================================================
   Vista "Agente": texto plano -> propuestas de proveedor.

   El texto se guarda en Supabase y un workflow de GitHub Actions lo convierte en
   propuestas. El agente NO crea cuentas: cada propuesta la crea (o la descarta)
   un administrador, y al crearla pasa por la misma validación que el alta
   manual. Lo que el modelo invente fuera del catálogo ya llega descartado.

   Estados de un trabajo:
     PENDING  en cola (o sin despachar, si falta el token de GitHub)
     RUNNING  el runner lo está procesando
     READY    hay propuestas para revisar
     FAILED   algo falló: se puede reintentar
   ============================================================================= */

import { rpc } from "./api.js";
import { store, emitir, escuchar } from "./store.js";
import { $, esc, plural, fechaCorta, aviso, motivo, confirmar, listaProblemas, tieneErrores } from "./ui.js";

const ESTADOS = {
  PENDING: { etiqueta: "En cola", tono: "warn" },
  RUNNING: { etiqueta: "Analizando…", tono: "warn" },
  READY: { etiqueta: "Listo", tono: "ok" },
  FAILED: { etiqueta: "Falló", tono: "error" },
};

const FALLOS = {
  MODEL_NO_OUTPUT: "ningún modelo devolvió un resultado utilizable",
  NO_PROVIDERS_FOUND: "no se reconoció ningún proveedor en el texto",
  BAD_OUTPUT: "el agente devolvió algo inesperado",
  RUNNER_ERROR: "el runner falló",
  TIMEOUT: "pasaron 20 minutos sin respuesta",
  DISPATCH_401: "GitHub rechazó el token (caducado o sin permiso)",
  DISPATCH_403: "GitHub rechazó el token (sin permiso de Actions)",
  DISPATCH_404: "GitHub no encontró el workflow (¿ya está publicado en main?)",
  DISPATCH_422: "GitHub no aceptó el disparo del workflow",
};

let reloj = null;
let visible = false;

function activos() {
  return store.trabajos.some((t) =>
    t.status === "RUNNING" || (t.status === "PENDING" && t.dispatch_note === "DISPATCHED"));
}

export function pendientes() {
  let n = 0;
  store.trabajos.forEach((t) => (t.proposals || []).forEach((p) => { if (p.state === "pendiente") n += 1; }));
  return n;
}

/* ------------------------------------------------------------------ carga */

export async function cargar() {
  try {
    const data = await rpc("agentJobs");
    store.trabajos = data.jobs || [];
    render();
  } catch (err) {
    if (err.code !== "P0010") aviso("No se pudieron cargar los análisis: " + motivo(err), "error");
  }
  programar();
}

/** Solo se consulta mientras haya algo en curso y la vista esté a la vista. */
function programar() {
  clearTimeout(reloj);
  if (visible && activos()) reloj = setTimeout(cargar, 6000);
}

/* ----------------------------------------------------------------- render */

function propuesta(trabajo, p) {
  const d = p.data || {};
  const zona = [d.address_text, d.region_text].filter(Boolean).join(", ");
  const ids = 'data-job="' + trabajo.id + '" data-prop="' + esc(p.id) + '"';
  const conErrores = tieneErrores(p.issues);

  let acciones;
  if (p.state === "creado") {
    acciones = '<span class="pill ok">Creado</span>';
  } else if (p.state === "descartado") {
    acciones = '<span class="pill muted">Descartado</span>' +
      '<button class="link" data-agente="restaurar" ' + ids + ">Recuperar</button>";
  } else {
    acciones =
      '<button class="btn btn-primary" data-agente="crear" ' + ids + (conErrores ? " disabled" : "") +
        (conErrores ? ' title="Tiene errores: revísala primero"' : "") + ">Crear</button>" +
      '<button class="btn btn-outline" data-agente="revisar" ' + ids + ">Revisar y editar</button>" +
      '<button class="btn btn-ghost danger" data-agente="descartar" ' + ids + ">Descartar</button>";
  }

  return (
    '<article class="proposal ' + esc(p.state) + '">' +
      "<h4>" + esc(d.brand || "(sin nombre)") + "</h4>" +
      '<p class="meta">' + [d.specialty, zona].filter(Boolean).map(esc).join(" · ") + "</p>" +
      '<div class="contact">' +
        (d.email ? "<span>" + esc(d.email) + "</span>" : '<span class="faint">sin correo</span>') +
        (d.phone ? "<span>" + esc(d.phone) + "</span>" : '<span class="faint">sin teléfono</span>') +
      "</div>" +
      '<div class="tags">' +
        ((d.services || []).length
          ? d.services.map((s) => '<span class="tag sub" title="' + esc(s.category_label) + '">' +
              esc(s.name === s.subcategory_label ? s.name : s.name + " · " + s.subcategory_label) + "</span>").join("")
          : '<span class="tag none">sin servicios</span>') +
      "</div>" +
      (d.bio ? '<p class="bio">' + esc(d.bio) + "</p>" : "") +
      (p.note ? '<p class="note">Nota del agente: ' + esc(p.note) + "</p>" : "") +
      (p.state === "pendiente" ? listaProblemas(p.issues) : "") +
      '<div class="actions">' + acciones + "</div>" +
    "</article>"
  );
}

function trabajo(t) {
  const e = ESTADOS[t.status] || ESTADOS.FAILED;
  const sinDespachar = t.status === "PENDING" && t.dispatch_note === "NO_TOKEN";
  const props = t.proposals || [];
  const quedan = props.filter((p) => p.state === "pendiente").length;
  const extracto = (t.input_text || "").replace(/\s+/g, " ").slice(0, 140);

  let estado = "";
  if (sinDespachar) {
    estado = '<p class="alert warn">Guardado, pero no se pudo avisar a GitHub: falta el token de despacho. ' +
      "Lánzalo a mano desde Actions → provider-agent → Run workflow, o configura el token y pulsa Reintentar.</p>";
  } else if (t.status === "FAILED") {
    estado = '<p class="alert">No se pudo analizar: ' + esc(FALLOS[t.error] || t.error || "error desconocido") + ".</p>";
  } else if (t.status === "PENDING" || t.status === "RUNNING") {
    estado = '<p class="hint">Suele tardar entre uno y tres minutos. Puedes seguir trabajando: esta lista se actualiza sola.</p>';
  }

  return (
    '<section class="job">' +
      '<header class="job-head">' +
        '<span class="pill ' + (sinDespachar ? "muted" : e.tono) + '">' + (sinDespachar ? "Sin despachar" : e.etiqueta) + "</span>" +
        "<time>" + esc(fechaCorta(t.created_at)) + "</time>" +
        (props.length ? "<span>" + plural(props.length, "propuesta", "propuestas") +
          (quedan ? " · " + quedan + " por revisar" : " · todas resueltas") + "</span>" : "") +
        '<span class="spacer"></span>' +
        (t.status === "FAILED" || sinDespachar
          ? '<button class="btn btn-outline" data-agente="reintentar" data-job="' + t.id + '">Reintentar</button>' : "") +
        '<button class="btn btn-ghost danger" data-agente="borrar" data-job="' + t.id + '">Borrar</button>' +
      "</header>" +
      '<p class="job-text">' + esc(extracto) + ((t.input_text || "").length > 140 ? "…" : "") + "</p>" +
      estado +
      (props.length ? '<div class="proposals">' + props.map((p) => propuesta(t, p)).join("") + "</div>" : "") +
    "</section>"
  );
}

export function render() {
  const a = store.agente;
  const aviso_ = $("agentSetup");
  if (!a.runner_ready) {
    aviso_.hidden = false;
    aviso_.textContent = "El agente todavía no está configurado (falta la clave del runner). Mira el README.";
  } else if (!a.dispatch_ready) {
    aviso_.hidden = false;
    aviso_.textContent = "Falta el token de GitHub para lanzar el agente automáticamente: " +
      "los análisis se guardan, pero hay que lanzarlos a mano desde Actions.";
  } else {
    aviso_.hidden = true;
  }

  $("jobs").innerHTML = store.trabajos.map(trabajo).join("");
  $("jobsEmpty").hidden = store.trabajos.length > 0;
  emitir("propuestas", pendientes());
}

/* --------------------------------------------------------------- acciones */

function buscar(jobId, propId) {
  const t = store.trabajos.find((x) => x.id === jobId);
  const p = t && (t.proposals || []).find((x) => x.id === propId);
  return { t, p };
}

async function analizar(ev) {
  ev.preventDefault();
  const texto = $("agentText").value.trim();
  if (texto.length < 10) { aviso("Pega primero el texto con los proveedores.", "error"); return; }

  const btn = $("agentSubmit");
  btn.disabled = true;
  try {
    const res = await rpc("agentSubmit", { text: texto, instructions: $("agentInstructions").value.trim() });
    $("agentText").value = "";
    aviso(res.dispatch === "DISPATCHED"
      ? "Enviado al agente. Las propuestas aparecen abajo en un par de minutos."
      : "Guardado, pero no se pudo lanzar el agente automáticamente.", res.dispatch === "DISPATCHED" ? "ok" : "info");
    await cargar();
  } catch (err) {
    aviso("No se pudo enviar: " + motivo(err), "error");
  } finally {
    btn.disabled = false;
  }
}

async function crear(jobId, propId, boton) {
  const { p } = buscar(jobId, propId);
  if (!p) return;
  boton.disabled = true;
  try {
    // Las coordenadas de la propuesta son el centroide que dedujo el servidor:
    // no se reenvían, para que las vuelva a deducir y no queden como "exactas".
    const { lat, lng, precision, ...proveedor } = p.data;
    const res = await rpc("providerCreate", { provider: proveedor, job_id: jobId, proposal_id: propId });
    if (!res.ok) {
      // Algo cambió desde que se propuso (p. ej. el correo ya existe ahora).
      p.issues = res.issues;
      render();
      aviso("No se pudo crear: revisa los problemas marcados.", "error");
      return;
    }
    aviso((p.data.brand || "Proveedor") + " creado.", "ok");
    emitir("proveedor-creado", { irALista: false });
    await cargar();
  } catch (err) {
    boton.disabled = false;
    aviso("No se pudo crear: " + motivo(err), "error");
  }
}

async function actualizar(params, mensajeError) {
  try {
    await rpc("agentUpdate", params);
    await cargar();
  } catch (err) {
    aviso(mensajeError + ": " + motivo(err), "error");
  }
}

const ACCIONES = {
  crear: (b) => crear(b.dataset.job, b.dataset.prop, b),
  revisar: (b) => {
    const { p } = buscar(b.dataset.job, b.dataset.prop);
    if (p) emitir("revisar-propuesta", { job_id: b.dataset.job, proposal_id: p.id, data: p.data, issues: p.issues });
  },
  descartar: (b) => actualizar(
    { job_id: b.dataset.job, action: "proposal", proposal_id: b.dataset.prop, state: "descartado" },
    "No se pudo descartar"),
  restaurar: (b) => actualizar(
    { job_id: b.dataset.job, action: "proposal", proposal_id: b.dataset.prop, state: "pendiente" },
    "No se pudo recuperar"),
  reintentar: (b) => actualizar({ job_id: b.dataset.job, action: "retry" }, "No se pudo reintentar"),
  borrar: async (b) => {
    const { t } = buscar(b.dataset.job);
    const quedan = t ? (t.proposals || []).filter((p) => p.state === "pendiente").length : 0;
    const si = await confirmar({
      titulo: "Borrar este análisis",
      texto: "Se borra el texto pegado y sus propuestas" +
        (quedan ? " (" + plural(quedan, "queda", "quedan") + " sin revisar)" : "") +
        ". Los proveedores que ya creaste no se tocan.",
      aceptar: "Borrar",
      peligro: true,
    });
    if (si) actualizar({ job_id: b.dataset.job, action: "delete" }, "No se pudo borrar");
  },
};

export function iniciar() {
  $("agentForm").addEventListener("submit", analizar);

  $("jobs").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-agente]");
    if (b && ACCIONES[b.dataset.agente]) ACCIONES[b.dataset.agente](b);
  });

  escuchar("vista", (nombre) => {
    visible = nombre === "agente";
    if (visible) cargar(); else clearTimeout(reloj);
  });
}

export function limpiar() {
  clearTimeout(reloj);
  store.trabajos = [];
  $("jobs").innerHTML = "";
  $("agentText").value = "";
}
