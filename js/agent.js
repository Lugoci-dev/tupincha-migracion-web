/* =============================================================================
   Vista "Agente": texto plano -> proveedores.

   Pegas un texto y el agente (un workflow de GitHub Actions) crea él mismo los
   proveedores que salgan completos. Aquí solo se ve el resultado, una línea por
   proveedor:

     creado      ya está en Contactos, con su aviso listo
     existente   ya había una cuenta con ese correo: no se tocó nada
     pendiente   le falta algo que solo tú puedes poner (casi siempre el correo)
                 -> "Completar" abre el formulario con lo que sí se entendió

   La validación es la del alta manual y corre en la base de datos: lo que el
   modelo invente fuera del catálogo ya llega descartado.

   Estados de un análisis: PENDING (en cola) · RUNNING · READY · FAILED.
   ============================================================================= */

import { rpc } from "./api.js";
import { store, emitir, escuchar } from "./store.js";
import { $, esc, plural, fechaCorta, aviso, motivo, confirmar, textoProblema } from "./ui.js";

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
  DISPATCH_404: "GitHub no encontró el workflow",
  DISPATCH_422: "GitHub no aceptó el disparo del workflow",
};

/** Qué le falta a un pendiente, en dos palabras. */
const FALTA = {
  EMAIL_REQUIRED: "Falta el correo",
  EMAIL_INVALID: "Correo no válido",
  PHONE_INVALID: "Teléfono no válido",
  BRAND_REQUIRED: "Falta el nombre",
  CREATE_FAILED: "No se pudo crear",
};

/** Avisos de un proveedor ya creado: cortos, solo informan. */
const NOTAS = {
  DEFAULT_LOCATION: () => "Sin zona en el texto: se le puso La Habana.",
  PHONE_MISSING: () => "Sin teléfono.",
  EMAIL_PLACEHOLDER: (i) => "Sin correo: entra con " + i.detail + ".",
  NO_SERVICES: () => "Sin servicios.",
  NO_LOCATION: () => "Sin ubicación.",
  PHONE_DUPLICATE: (i) => "Mismo teléfono que " + (i.detail || "otro contacto") + ".",
  SUBCATEGORY_NOT_FOUND: (i) => "Se omitió un servicio fuera del catálogo" + (i.detail ? " (" + i.detail + ")." : "."),
};

let reloj = null;
let visible = false;
/** legacy_id que ya se sabía creados: los nuevos avisan a Contactos. */
let conocidos = null;

function activos() {
  return store.trabajos.some((t) =>
    t.status === "RUNNING" || (t.status === "PENDING" && t.dispatch_note === "DISPATCHED"));
}

function contar(t, estado) {
  return (t.proposals || []).filter((p) => p.state === estado).length;
}

export function pendientes() {
  return store.trabajos.reduce((n, t) => n + contar(t, "pendiente"), 0);
}

/* ------------------------------------------------------------------ carga */

export async function cargar() {
  try {
    const data = await rpc("agentJobs");
    store.trabajos = data.jobs || [];
    avisarDeCreados();
    render();
  } catch (err) {
    if (err.code !== "P0010") aviso("No se pudieron cargar los análisis: " + motivo(err), "error");
  }
  programar();
}

/** Lo que el agente crea mientras miras aparece en Contactos sin recargar. */
function avisarDeCreados() {
  const ahora = {};
  store.trabajos.forEach((t) => (t.proposals || []).forEach((p) => {
    if (p.state === "creado" && p.legacy_id) ahora[p.legacy_id] = true;
  }));
  if (conocidos) {
    const nuevos = Object.keys(ahora).filter((id) => !conocidos[id]).length;
    if (nuevos) {
      aviso("El agente creó " + plural(nuevos, "proveedor", "proveedores") + ".", "ok");
      emitir("proveedor-creado", { irALista: false });
    }
  }
  conocidos = ahora;
}

/** Solo se consulta mientras haya algo en curso y la vista esté a la vista. */
function programar() {
  clearTimeout(reloj);
  if (visible && activos()) reloj = setTimeout(cargar, 6000);
}

/* ----------------------------------------------------------------- render */

function fila(t, p) {
  const d = p.data || {};
  const ids = 'data-job="' + t.id + '" data-prop="' + esc(p.id) + '"';
  const contacto = [d.email, d.phone].filter(Boolean).map(esc).join(" · ");
  const servicios = (d.services || []).map((s) => esc(s.subcategory_label)).join(", ");
  const avisos = (p.issues || []).filter((i) => i.level === "warn");

  let pill;
  let acciones = "";
  let detalle = [contacto, servicios].filter(Boolean).join(" — ");

  if (p.state === "creado") {
    pill = '<span class="pill ok">Creado</span>';
    if (avisos.length) detalle += '<small class="row-note">' + avisos.map((i) => esc(NOTAS[i.code] ? NOTAS[i.code](i) : textoProblema(i))).join(" ") + "</small>";
  } else if (p.state === "existente") {
    pill = '<span class="pill muted">Ya existía</span>';
    detalle = contacto + '<small class="row-note">Ya hay una cuenta con ese correo. No se cambió nada.</small>';
  } else if (p.state === "descartado") {
    pill = '<span class="pill muted">Descartado</span>';
    acciones = '<button class="link" data-agente="restaurar" ' + ids + ">Recuperar</button>";
  } else {
    const error = (p.issues || []).find((i) => i.level === "error");
    pill = '<span class="pill warn">' + esc((error && FALTA[error.code]) || "Por completar") + "</span>";
    // Lo único que le falta es el correo y tiene teléfono: se puede crear ya
    // con un correo temporal (el aviso le llega por WhatsApp).
    const soloCorreo = error && error.code === "EMAIL_REQUIRED" && d.phone &&
      (p.issues || []).filter((i) => i.level === "error").length === 1;
    acciones =
      (soloCorreo
        ? '<button class="btn btn-primary" data-agente="temporal" ' + ids + ">Crear con correo temporal</button>" +
          '<button class="btn btn-outline" data-agente="completar" ' + ids + ">Completar</button>"
        : '<button class="btn btn-primary" data-agente="completar" ' + ids + ">Completar</button>") +
      '<button class="link" data-agente="descartar" ' + ids + ">Descartar</button>";
  }

  return (
    '<li class="row ' + esc(p.state) + '">' +
      pill +
      '<div class="row-main"><b>' + esc(d.brand || "(sin nombre)") + "</b>" +
        (detalle ? "<span>" + detalle + "</span>" : "") + "</div>" +
      (acciones ? '<div class="row-actions">' + acciones + "</div>" : "") +
    "</li>"
  );
}

function resumen(t) {
  const partes = [];
  const c = contar(t, "creado");
  const f = contar(t, "pendiente");
  const e = contar(t, "existente");
  if (c) partes.push(plural(c, "creado", "creados"));
  if (f) partes.push(f + " por completar");
  if (e) partes.push(plural(e, "ya existía", "ya existían"));
  return partes.join(" · ");
}

function trabajo(t) {
  const e = ESTADOS[t.status] || ESTADOS.FAILED;
  const sinDespachar = t.status === "PENDING" && t.dispatch_note === "NO_TOKEN";
  const props = t.proposals || [];

  let estado = "";
  if (sinDespachar) {
    estado = '<p class="alert warn">Guardado, pero no se pudo avisar a GitHub. Pulsa Reintentar.</p>';
  } else if (t.status === "FAILED") {
    estado = '<p class="alert">No se pudo analizar: ' + esc(FALLOS[t.error] || t.error || "error desconocido") + ".</p>";
  } else if (t.status === "PENDING" || t.status === "RUNNING") {
    estado = '<p class="hint">Tarda alrededor de un minuto. Esta lista se actualiza sola.</p>';
  }

  return (
    '<section class="job">' +
      '<header class="job-head">' +
        '<span class="pill ' + (sinDespachar ? "muted" : e.tono) + '">' + (sinDespachar ? "Sin lanzar" : e.etiqueta) + "</span>" +
        (props.length ? "<b>" + esc(resumen(t)) + "</b>" : "") +
        "<time>" + esc(fechaCorta(t.created_at)) + "</time>" +
        '<span class="spacer"></span>' +
        (t.status === "FAILED" || sinDespachar
          ? '<button class="btn btn-outline" data-agente="reintentar" data-job="' + t.id + '">Reintentar</button>' : "") +
        '<button class="btn btn-ghost" data-agente="borrar" data-job="' + t.id + '">Quitar</button>' +
      "</header>" +
      estado +
      (props.length ? '<ul class="rows">' + props.map((p) => fila(t, p)).join("") + "</ul>" : "") +
    "</section>"
  );
}

export function render() {
  const a = store.agente;
  const nota = $("agentSetup");
  nota.hidden = a.runner_ready && a.dispatch_ready;
  nota.textContent = !a.runner_ready
    ? "El agente todavía no está configurado (falta la clave del runner). Mira el README."
    : "Falta el token de GitHub para lanzar el agente automáticamente.";

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
      ? "Enviado al agente. El resultado aparece abajo en un minuto."
      : "Guardado, pero no se pudo lanzar el agente.", res.dispatch === "DISPATCHED" ? "ok" : "info");
    await cargar();
  } catch (err) {
    aviso("No se pudo enviar: " + motivo(err), "error");
  } finally {
    btn.disabled = false;
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

async function crearConCorreoTemporal(b) {
  const { p } = buscar(b.dataset.job, b.dataset.prop);
  if (!p) return;
  b.disabled = true;
  // Las coordenadas y el formato de la app los vuelve a calcular el servidor.
  const { lat, lng, precision, state, city, ...proveedor } = p.data;
  try {
    const res = await rpc("providerCreate", {
      provider: Object.assign(proveedor, { email: "", email_placeholder: true }),
      job_id: b.dataset.job,
      proposal_id: b.dataset.prop,
    });
    if (!res.ok) {
      b.disabled = false;
      aviso("No se pudo crear: " + (res.issues || []).filter((i) => i.level === "error")
        .map((i) => textoProblema(i)).join(" "), "error");
      return;
    }
    aviso((p.data.brand || "Proveedor") + " creado con correo temporal. Su cuenta ya está activa: avísale por WhatsApp.", "ok");
    emitir("proveedor-creado", { irALista: false });
    await cargar();
  } catch (err) {
    b.disabled = false;
    aviso("No se pudo crear: " + motivo(err), "error");
  }
}

const ACCIONES = {
  temporal: (b) => crearConCorreoTemporal(b),
  completar: (b) => {
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
    const quedan = t ? contar(t, "pendiente") : 0;
    // Sin nada por completar no hay nada que perder: se quita sin preguntar.
    const si = !quedan || await confirmar({
      titulo: "Quitar este análisis",
      texto: (quedan === 1
        ? "Queda un proveedor por completar y se perderá lo que el agente entendió de él."
        : "Quedan " + quedan + " proveedores por completar y se perderá lo que el agente entendió de ellos.") +
        " Los que ya se crearon no se tocan.",
      aceptar: "Quitar",
      peligro: true,
    });
    if (si) actualizar({ job_id: b.dataset.job, action: "delete" }, "No se pudo quitar");
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
  conocidos = null;
  store.trabajos = [];
  $("jobs").innerHTML = "";
  $("agentText").value = "";
}
