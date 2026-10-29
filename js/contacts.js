/* =============================================================================
   Vista "Contactos": a quién se le avisó, cómo, y quién activó ya su cuenta.

   ── Qué significa cada estado de aviso ───────────────────────────────────────
     enviado        Resend aceptó el correo. Es un HECHO, lo dice el servidor.
     avisado        Un admin afirma que lo mandó (WhatsApp o su correo). Es una
                    afirmación humana: cuenta como avisado, pero se muestra
                    aparte de lo confirmado por Resend.
     fallido        Resend o la función fallaron. Reintentable.
     encolado /     Se pidió el envío y aún no hay (o ya no hay) respuesta.
     sin-respuesta
     abierto-*      Se abrió wa.me / mailto:. No prueba que el mensaje saliera.
     pendiente      Nadie hizo nada.

   Todo esto vive en el servidor: lo comparten todos los administradores.

   El envío por correo es SIEMPRE por selección explícita: no existe "enviar a
   todos los visibles".
   ============================================================================= */

import { rpc } from "./api.js";
import { store, emitir, escuchar } from "./store.js";
import {
  $, esc, plural, fechaCorta, aviso, motivo, confirmar,
  abrirDialogo, actualizarDialogo, cerrarDialogo,
} from "./ui.js";

const CFG = window.TUPINCHA_WEB;

const vista = {
  filtro: "por-avisar",
  busqueda: "",
  /** { [legacy_id]: true } — marcados para envío por correo */
  seleccion: {},
  cargando: false,
};

try { vista.filtro = localStorage.getItem(CFG.storage.filtro) || vista.filtro; } catch (e) { /* da igual */ }

/* ------------------------------------------------------------- situación */

const SITUACIONES = {
  enviado:         { etiqueta: "Correo enviado",   detalle: "confirmado por Resend", tono: "ok" },
  avisado:         { etiqueta: "Avisado",          detalle: "marcado a mano",        tono: "ok-soft" },
  fallido:         { etiqueta: "Correo falló",     detalle: "se puede reintentar",   tono: "error" },
  encolado:        { etiqueta: "Correo en cola",   detalle: "esperando a Resend",    tono: "warn" },
  "sin-respuesta": { etiqueta: "Sin respuesta",    detalle: "no se pudo confirmar",  tono: "warn" },
  "abierto-wa":    { etiqueta: "WhatsApp abierto", detalle: "sin confirmar",         tono: "muted" },
  "abierto-mail":  { etiqueta: "Correo abierto",   detalle: "sin confirmar",         tono: "muted" },
  pendiente:       { etiqueta: "Por avisar",       detalle: "",                      tono: "idle" },
};

function canalAvisado(c) {
  const m = c.manual || {};
  if (m.wa && m.wa.state === "avisado") return "wa";
  if (m.mail && m.mail.state === "avisado") return "mail";
  return null;
}

/** Un solo lugar decide qué se dice de cada contacto. */
function situacion(c) {
  if (c.email_status === "enviado") return "enviado";
  if (canalAvisado(c)) return "avisado";
  if (c.email_status && SITUACIONES[c.email_status]) return c.email_status;
  const m = c.manual || {};
  if (m.wa) return "abierto-wa";
  if (m.mail) return "abierto-mail";
  return "pendiente";
}

const GRUPOS = {
  "por-avisar":    (k) => k === "pendiente",
  "sin-confirmar": (k) => k === "abierto-wa" || k === "abierto-mail" || k === "encolado" || k === "sin-respuesta",
  avisados:        (k) => k === "enviado" || k === "avisado",
  fallidos:        (k) => k === "fallido",
};

function pasaFiltro(c) {
  if (GRUPOS[vista.filtro]) return GRUPOS[vista.filtro](situacion(c));
  if (vista.filtro === "activadas") return c.account_status === "activada";
  if (vista.filtro === "nuevos") return c.source !== "legacy";
  return true;
}

function coincideBusqueda(c) {
  if (!vista.busqueda) return true;
  const cont = c.contact || {};
  const todo = [
    c.brand, c.email, c.phone, cont.specialty, cont.bio, cont.region_text, cont.address_text,
    Object.values(c.category_labels || {}).join(" "),
    Object.values(c.subcategory_labels || {}).join(" "),
  ].join(" ").toLowerCase();
  return todo.indexOf(vista.busqueda) !== -1;
}

function visibles() {
  return store.contactos.filter((c) => pasaFiltro(c) && coincideBusqueda(c));
}

function porId(id) {
  return store.contactos.find((c) => c.legacy_id === id);
}

/* ------------------------------------------------------------------ carga */

export async function cargar({ silencioso } = {}) {
  if (vista.cargando) return;
  vista.cargando = true;
  if (!silencioso) $("grid").setAttribute("aria-busy", "true");
  try {
    const data = await rpc("list");
    store.contactos = data.contacts || [];
    const vivos = {};
    store.contactos.forEach((c) => { vivos[c.legacy_id] = true; });
    Object.keys(vista.seleccion).forEach((k) => { if (!vivos[k]) delete vista.seleccion[k]; });
    render();
  } catch (err) {
    if (err.code !== "P0010") aviso("No se pudo cargar la lista: " + motivo(err), "error");
  } finally {
    vista.cargando = false;
    $("grid").removeAttribute("aria-busy");
  }
}

/* ----------------------------------------------------------------- render */

function tagsDe(c) {
  const cats = (c.category_slugs || []).map((slug) =>
    '<span class="tag cat">' + esc((c.category_labels || {})[slug] || slug) + "</span>");
  const subs = (c.subcategory_ids || []).map((id) =>
    '<span class="tag sub">' + esc((c.subcategory_labels || {})[id] || id) + "</span>");
  const todas = cats.concat(subs);
  return todas.length ? todas.join("") : '<span class="tag none">sin servicios</span>';
}

function lineaEstado(c) {
  const clave = situacion(c);
  if (clave === "pendiente") return "";
  const s = SITUACIONES[clave];
  const m = c.manual || {};
  const id = c.legacy_id;
  let detalle = s.detalle;
  let cuando = null;
  let acciones = "";

  if (clave === "enviado") {
    cuando = c.email_sent_at;
  } else if (clave === "avisado") {
    const canal = canalAvisado(c);
    detalle = (canal === "wa" ? "por WhatsApp" : "por su correo") + " · marcado a mano";
    cuando = m[canal].at;
    acciones = boton("desmarcar", id, "Quitar marca", canal);
  } else if (clave === "abierto-wa" || clave === "abierto-mail") {
    const canal = clave === "abierto-wa" ? "wa" : "mail";
    cuando = m[canal].at;
    acciones = boton("avisado", id, "Ya lo envié", canal) + boton("desmarcar", id, "Quitar", canal);
  }

  return (
    '<div class="status-line">' +
      '<span class="pill ' + s.tono + '">' + esc(s.etiqueta) + "</span>" +
      "<span>" + esc(detalle) + "</span>" +
      (cuando ? "<time>" + esc(fechaCorta(cuando)) + "</time>" : "") +
      (c.email_attempts > 1 ? "<span>· " + c.email_attempts + " intentos</span>" : "") +
      acciones +
    "</div>"
  );
}

function boton(accion, id, texto, canal) {
  return '<button class="link" data-accion="' + accion + '" data-id="' + id + '"' +
    (canal ? ' data-canal="' + canal + '"' : "") + ">" + esc(texto) + "</button>";
}

function tarjeta(c) {
  const clave = situacion(c);
  const cont = c.contact || {};
  const sel = !!vista.seleccion[c.legacy_id];
  const id = c.legacy_id;

  const meta = [];
  if (cont.specialty) meta.push(esc(cont.specialty));
  const zona = [cont.address_text, cont.region_text].filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i).join(", ");
  if (zona) meta.push(esc(zona));

  const insignias =
    (c.account_status === "activada"
      ? '<span class="badge ok" title="Confirmó su correo: la cuenta ya está activa">Cuenta activada</span>' : "") +
    (c.source === "manual" ? '<span class="badge new">Nuevo</span>' : "") +
    (c.source === "agent" ? '<span class="badge new">Nuevo · agente</span>' : "") +
    (c.email_placeholder
      ? '<span class="badge warn" title="Se creó sin correo: entra con uno temporal hasta que ponga el suyo">Correo temporal</span>' : "") +
    (c.staging_warning
      ? '<span class="badge warn" title="' + esc(c.staging_warning) + '">Activada con avisos</span>' : "");

  return (
    '<article class="card ' + clave + (sel ? " seleccionada" : "") + '">' +
      '<div class="card-top">' +
        (c.email_placeholder ? '<span class="card-pick"></span>' :
          '<input class="card-pick" type="checkbox" data-accion="elegir" data-id="' + id + '"' +
          (sel ? " checked" : "") + ' aria-label="Seleccionar a ' + esc(c.brand) + ' para envío por correo" />') +
        '<div class="card-title"><h3>' + esc(c.brand) + "</h3>" +
          (meta.length ? '<p class="meta">' + meta.join(" · ") + "</p>" : "") + "</div>" +
      "</div>" +
      (insignias ? '<div class="badges">' + insignias + "</div>" : "") +
      '<div class="tags">' + tagsDe(c) + "</div>" +
      (cont.bio ? '<p class="bio">' + esc(cont.bio) + "</p>" : "") +
      '<div class="contact">' +
        (c.phone ? "<span>" + esc(c.phone) + "</span>" : '<span class="faint">sin teléfono</span>') +
        "<span>" + esc(c.email) + "</span>" +
      "</div>" +
      lineaEstado(c) +
      '<div class="actions">' +
        (c.wa_digits
          ? '<button class="btn btn-wa" data-accion="whatsapp" data-id="' + id + '">WhatsApp</button>' : "") +
        (c.email_placeholder ? "" :
          '<button class="btn btn-outline" data-accion="enviar" data-id="' + id + '">Enviar correo</button>') +
        '<button class="btn btn-ghost" data-accion="ver" data-id="' + id + '">Ver aviso</button>' +
        (c.can_delete
          ? '<button class="btn btn-ghost danger" data-accion="eliminar" data-id="' + id + '">Eliminar</button>' : "") +
      "</div>" +
    "</article>"
  );
}

function renderResumen() {
  const n = { enviado: 0, avisado: 0, fallido: 0, pendiente: 0, incierto: 0, activadas: 0 };
  store.contactos.forEach((c) => {
    const k = situacion(c);
    if (k in n) n[k] += 1; else n.incierto += 1;
    if (c.account_status === "activada") n.activadas += 1;
  });
  const total = store.contactos.length;
  const avisados = n.enviado + n.avisado;
  const pct = total ? Math.round((avisados / total) * 100) : 0;

  $("stats").innerHTML =
    stat(avisados + " / " + total, "Avisados", n.enviado + " por Resend · " + n.avisado + " a mano") +
    stat(n.pendiente, "Por avisar", "nadie les ha escrito") +
    stat(n.incierto, "Sin confirmar", "abiertos o en cola") +
    (n.fallido ? stat(n.fallido, "Fallidos", "correo rechazado", "error") : "") +
    stat(n.activadas, "Cuentas activadas", "ya confirmaron su correo", "ok");

  $("progressBar").style.width = pct + "%";
  $("progress").setAttribute("aria-valuenow", pct);
}

function stat(valor, titulo, pie, tono) {
  return '<div class="stat ' + (tono || "") + '"><b>' + esc(valor) + "</b><span>" + esc(titulo) +
    "</span><small>" + esc(pie) + "</small></div>";
}

export function render() {
  const vis = visibles();
  renderResumen();

  Array.prototype.forEach.call($("chips").children, (chip) => {
    const activo = chip.dataset.filtro === vista.filtro;
    chip.classList.toggle("active", activo);
    chip.setAttribute("aria-selected", activo ? "true" : "false");
  });

  const nSel = Object.keys(vista.seleccion).length;
  const btn = $("sendSelectedBtn");
  btn.disabled = nSel === 0;
  btn.textContent = nSel === 0 ? "Enviar correo a los seleccionados"
    : "Enviar correo a " + plural(nSel, "seleccionado", "seleccionados");

  const visIds = vis.map((c) => c.legacy_id);
  const enVista = visIds.filter((id) => vista.seleccion[id]).length;
  const todo = $("selectAll");
  todo.checked = visIds.length > 0 && enVista === visIds.length;
  todo.indeterminate = enVista > 0 && enVista < visIds.length;
  $("selectAllLabel").textContent = enVista
    ? "Quitar de la selección (" + enVista + ")"
    : "Seleccionar los " + visIds.length + " visibles";

  $("grid").innerHTML = vis.map(tarjeta).join("");
  $("emptyMsg").hidden = vis.length > 0;
  $("emptyMsg").textContent = store.contactos.length
    ? "Ningún contacto coincide con el filtro o la búsqueda."
    : "Todavía no hay contactos.";
}

/* ----------------------------------------------------- marcas (servidor) */

async function marcar(id, canal, estado) {
  try {
    const res = await rpc("mark", { legacy_id: id, channel: canal, state: estado });
    const c = porId(id);
    if (c) c.manual = res.manual;
    render();
  } catch (err) {
    aviso("No se pudo guardar la marca: " + motivo(err), "error");
  }
}

/* ----------------------------------------------------- WhatsApp y mailto */

/**
 * La pestaña se abre en el mismo clic (si se abre después del fetch, el
 * navegador la bloquea como pop-up) y se le pone la dirección cuando llega el
 * texto. Abrir el enlace NO es enviar: queda como "abierto, sin confirmar".
 */
async function abrirWhatsApp(id) {
  const pestana = window.open("about:blank", "_blank");
  try {
    const m = await rpc("message", { legacy_id: id });
    const url = "https://wa.me/" + m.wa_digits + "?text=" + encodeURIComponent(m.wa_message);
    if (pestana) { pestana.opener = null; pestana.location.href = url; }
    else window.location.href = url;
    marcar(id, "wa", "abierto");
  } catch (err) {
    if (pestana) pestana.close();
    aviso("No se pudo abrir WhatsApp: " + motivo(err), "error");
  }
}

async function abrirMailto(id) {
  try {
    const m = await rpc("message", { legacy_id: id });
    window.location.href = "mailto:" + m.email +
      "?subject=" + encodeURIComponent(m.email_subject) +
      "&body=" + encodeURIComponent(m.email_body);
    marcar(id, "mail", "abierto");
  } catch (err) {
    aviso("No se pudo abrir el correo: " + motivo(err), "error");
  }
}

async function copiar(id) {
  try {
    const m = await rpc("message", { legacy_id: id });
    await navigator.clipboard.writeText(m.wa_message);
    aviso("Mensaje copiado.", "ok");
  } catch (err) {
    aviso("No se pudo copiar: " + motivo(err), "error");
  }
}

/* -------------------------------------------------------------- ver aviso */

async function verAviso(id) {
  const c = porId(id);
  if (!c) return;
  abrirDialogo({ titulo: c.brand, cuerpo: '<p class="hint">Cargando el aviso…</p>' });

  try {
    const m = await rpc("message", { legacy_id: id });
    const s = SITUACIONES[situacion(c)];
    actualizarDialogo({
      cuerpo:
        '<div class="credenciales">' +
          '<div class="cred"><span>Correo</span><b>' + esc(m.email) + "</b></div>" +
          '<div class="cred"><span>Contraseña</span><b>' + esc(m.password) + "</b></div>" +
          (m.phone ? '<div class="cred"><span>Teléfono</span><b>' + esc(m.phone) + "</b></div>" : "") +
        "</div>" +
        '<div class="msg">' + esc(m.wa_message) + "</div>" +
        '<p class="hint">Este es el texto de WhatsApp. El correo lleva el mismo contenido con su propio formato.' +
        "<br/><b>Estado:</b> " + esc(s.etiqueta) + (s.detalle ? " — " + esc(s.detalle) : "") + ".</p>",
      pie:
        (m.wa_digits ? '<button class="btn btn-wa" data-accion="whatsapp" data-id="' + id + '">Abrir WhatsApp</button>' : "") +
        (c.email_placeholder ? "" :
          '<button class="btn btn-outline" data-accion="mailto" data-id="' + id + '">Abrir en mi correo</button>') +
        '<button class="btn btn-ghost" data-accion="copiar" data-id="' + id + '">Copiar texto</button>' +
        (c.email_placeholder ? "" :
          '<button class="btn btn-primary" data-accion="enviar" data-id="' + id + '">Enviar por correo</button>'),
    });
  } catch (err) {
    actualizarDialogo({ cuerpo: '<div class="alert">No se pudo cargar: ' + esc(motivo(err)) + "</div>" });
  }
}

/* --------------------------------------------------------- envío por Resend */

const MOTIVOS = {
  EMAIL_INVALIDO: "correo no válido",
  CORREO_TEMPORAL: "correo temporal: avísale por WhatsApp",
  SIN_ASUNTO: "sin asunto",
  SIN_CUERPO: "sin cuerpo",
  DESACTIVADO: "desactivado",
};

/**
 * Antes de mandar nada: quién lo recibe y cómo se ve. La comprobación corre en
 * Supabase y la muestra la renderiza la Edge Function en modo prueba. Con más
 * de un destinatario hay que escribir el número para habilitar el botón.
 */
async function prepararEnvio(ids) {
  abrirDialogo({
    titulo: ids.length === 1 ? "Enviar correo" : "Enviar " + ids.length + " correos",
    cuerpo: '<p class="hint">Comprobando ' + plural(ids.length, "contacto", "contactos") + "…</p>",
  });

  let r;
  try {
    r = await rpc("preview", { legacy_ids: ids });
  } catch (err) {
    actualizarDialogo({ cuerpo: '<div class="alert">No se pudo comprobar: ' + esc(motivo(err)) + "</div>" });
    return;
  }

  if (!r || typeof r.listos !== "number") {
    actualizarDialogo({
      cuerpo: '<div class="alert">La comprobación no devolvió datos válidos. No se envió nada.</div>',
    });
    return;
  }

  const fuera = {};
  (r.faltan || []).forEach((f) => { fuera[f.legacy_id] = f; });
  const listos = ids.filter((id) => !fuera[id]);
  const lista = listos.map(porId).filter(Boolean);
  const LIMITE = 40;

  actualizarDialogo({
    cuerpo:
      '<div class="check"><div class="check-ok"><b>' + r.listos + "</b> " +
        (r.listos === 1 ? "listo para enviar" : "listos para enviar") + "</div>" +
      ((r.faltan || []).length
        ? '<div class="check-bad"><b>' + r.faltan.length + "</b> se quedan fuera:<ul>" +
          r.faltan.map((f) => "<li>" + esc(f.brand || f.legacy_id) + " — " +
            esc(MOTIVOS[f.reason] || f.reason) + "</li>").join("") + "</ul></div>"
        : "") + "</div>" +
      '<p class="hint">Destinatarios exactos. Cada uno recibe su propia contraseña.</p>' +
      '<ul class="destinatarios">' +
        lista.slice(0, LIMITE).map((c) =>
          "<li><b>" + esc(c.brand) + "</b><span>" + esc(c.email) + "</span></li>").join("") +
        (lista.length > LIMITE ? '<li class="mas">… y ' + (lista.length - LIMITE) + " más</li>" : "") +
      "</ul>" +
      (r.muestra
        ? '<p class="hint">Así se verá (muestra de <b>' + esc(r.muestra.brand) + "</b>; todavía no se envía nada):</p>" +
          '<iframe class="preview" id="mailPreview" title="Muestra del correo" sandbox></iframe>'
        : ""),
    pie: !listos.length ? "" :
      (listos.length > 1
        ? '<label class="confirm"><span>Escribe <b>' + listos.length + "</b> para confirmar</span>" +
          '<input class="field" id="confirmInput" inputmode="numeric" autocomplete="off" /></label>'
        : "") +
      '<button class="btn btn-primary" id="confirmSend"' + (listos.length > 1 ? " disabled" : "") + ">Enviar " +
      plural(listos.length, "correo", "correos") + "</button>",
  });

  if (r.muestra) cargarMuestra(r.muestra.legacy_id);
  if (!listos.length) return;

  const ok = $("confirmSend");
  const input = $("confirmInput");
  if (input) {
    input.addEventListener("input", () => {
      ok.disabled = input.value.trim() !== String(listos.length);
    });
    input.focus();
  }
  ok.addEventListener("click", () => enviar(listos, ok));
}

/** El render es asíncrono (pg_net): se pide y se consulta hasta que llegue. */
async function cargarMuestra(id) {
  const pintar = (html) => { const f = $("mailPreview"); if (f) f.srcdoc = html; };
  try {
    await rpc("sendEmail", { legacy_ids: [id], dry_run: true });
    for (let i = 0; i < 8; i += 1) {
      await new Promise((r) => setTimeout(r, 1200));
      if (!$("mailPreview")) return;
      const res = await rpc("sample", { legacy_id: id });
      if (res && res.html) { pintar(res.html); return; }
    }
    pintar("<p style='font-family:sans-serif;color:#6b7280'>La muestra tardó demasiado. Los destinatarios son los de arriba.</p>");
  } catch (err) {
    pintar("<p style='font-family:sans-serif;color:#6b7280'>No se pudo cargar la muestra.</p>");
  }
}

async function enviar(ids, boton) {
  boton.disabled = true;
  boton.textContent = "Enviando…";
  try {
    const res = await rpc("sendEmail", { legacy_ids: ids, dry_run: false });
    ids.forEach((id) => { delete vista.seleccion[id]; });
    cerrarDialogo();
    aviso(plural(res.queued, "correo encolado", "correos encolados") +
      ". Resend los manda en segundo plano; el estado se actualiza solo.", "ok");
    await cargar({ silencioso: true });
    // El resultado real llega unos segundos después.
    setTimeout(() => cargar({ silencioso: true }), 6000);
    setTimeout(() => cargar({ silencioso: true }), 20000);
  } catch (err) {
    boton.disabled = false;
    boton.textContent = "Reintentar";
    aviso("No se pudo encolar el envío: " + motivo(err), "error");
  }
}

/* -------------------------------------------------------------- eliminar */

async function eliminar(id) {
  const c = porId(id);
  if (!c) return;
  const si = await confirmar({
    titulo: "Eliminar a " + c.brand,
    texto: "Se borra su cuenta (aún sin activar), su perfil pendiente y su fila de campaña. " +
      "Si ya le mandaste la contraseña, dejará de servirle. No se puede deshacer.",
    aceptar: "Eliminar",
    peligro: true,
  });
  if (!si) return;
  try {
    await rpc("providerDelete", { legacy_id: id });
    aviso(c.brand + " eliminado.", "ok");
    await cargar({ silencioso: true });
  } catch (err) {
    aviso("No se pudo eliminar: " + motivo(err), "error");
  }
}

/* ------------------------------------------------------------------- csv */

function descargarCsv() {
  const filas = [[
    "id", "origen", "marca", "correo", "telefono", "provincia", "municipio",
    "aviso", "aviso_detalle", "correo_resend", "correo_enviado_el", "intentos",
    "whatsapp_manual", "correo_manual", "cuenta", "cuenta_activada_el",
  ]];
  store.contactos.forEach((c) => {
    const s = SITUACIONES[situacion(c)];
    const m = c.manual || {};
    const cont = c.contact || {};
    filas.push([
      c.legacy_id, c.source, c.brand, c.email, c.phone || "",
      cont.region_text || "", cont.address_text || "",
      s.etiqueta, s.detalle, c.email_status || "", c.email_sent_at || "", c.email_attempts || 0,
      m.wa ? m.wa.state : "", m.mail ? m.mail.state : "",
      c.account_status, c.account_confirmed_at || "",
    ]);
  });

  const csv = filas.map((f) => f.map((v) => {
    v = String(v == null ? "" : v);
    // Una celda que empieza por = + - @ se ejecuta como fórmula al abrir el CSV.
    if (/^[=+\-@]/.test(v)) v = "'" + v;
    return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }).join(";")).join("\n");

  const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "campana-tupincha.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------------------------------------------------------- eventos */

const ACCIONES = {
  elegir: (id) => {
    if (vista.seleccion[id]) delete vista.seleccion[id]; else vista.seleccion[id] = true;
    render();
  },
  whatsapp: (id) => abrirWhatsApp(id),
  mailto: (id) => abrirMailto(id),
  copiar: (id) => copiar(id),
  ver: (id) => verAviso(id),
  enviar: (id) => prepararEnvio([id]),
  eliminar: (id) => eliminar(id),
  avisado: (id, b) => marcar(id, b.dataset.canal, "avisado"),
  desmarcar: (id, b) => marcar(id, b.dataset.canal, null),
};

export function iniciar() {
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-accion]");
    if (!b || !ACCIONES[b.dataset.accion]) return;
    ACCIONES[b.dataset.accion](parseInt(b.dataset.id, 10), b);
  });

  $("sendSelectedBtn").addEventListener("click", () => {
    const ids = store.contactos.filter((c) => vista.seleccion[c.legacy_id]).map((c) => c.legacy_id);
    if (ids.length) prepararEnvio(ids);
  });

  $("selectAll").addEventListener("change", (ev) => {
    visibles().forEach((c) => {
      if (ev.target.checked) vista.seleccion[c.legacy_id] = true;
      else delete vista.seleccion[c.legacy_id];
    });
    render();
  });

  $("searchInput").addEventListener("input", (ev) => {
    vista.busqueda = ev.target.value.trim().toLowerCase();
    render();
  });

  $("chips").addEventListener("click", (ev) => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    vista.filtro = chip.dataset.filtro;
    try { localStorage.setItem(CFG.storage.filtro, vista.filtro); } catch (e) { /* da igual */ }
    render();
  });

  $("csvBtn").addEventListener("click", descargarCsv);
  $("reloadBtn").addEventListener("click", () => cargar());

  // Un alta nueva aparece en la lista sin recargar la página.
  escuchar("proveedor-creado", (d) => {
    vista.filtro = "nuevos";
    cargar({ silencioso: true }).then(() => { if (d && d.irALista) emitir("ir", "contactos"); });
  });
}

export function limpiar() {
  vista.seleccion = {};
  vista.busqueda = "";
  $("searchInput").value = "";
  $("grid").innerHTML = "";
}
