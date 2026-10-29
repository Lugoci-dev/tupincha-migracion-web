/* =============================================================================
   Vista "Nuevo proveedor": alta manual, uno a uno.

   El mismo formulario sirve para revisar una propuesta del agente antes de
   crearla. En los dos casos manda el servidor: valida, normaliza el teléfono,
   deduce la categoría a partir de la subcategoría y genera la contraseña.

   Las subcategorías salen de un <select> cargado con el catálogo vivo: desde
   aquí no se puede escribir una que no exista.
   ============================================================================= */

import { rpc } from "./api.js";
import { store, emitir, escuchar } from "./store.js";
import { $, esc, aviso, motivo, listaProblemas, tieneErrores } from "./ui.js";

const CAMPOS = ["brand", "email", "phone", "first_name", "last_name", "specialty", "bio", "region_text", "address_text"];

/** { job_id, proposal_id } cuando el formulario viene de una propuesta. */
let origen = null;
/** Avisos ya mostrados para estos mismos datos: el segundo clic crea. */
let avisosVistos = null;

function opcionesCatalogo(elegida) {
  return '<option value="">Elige una subcategoría…</option>' + store.catalogo.map((cat) =>
    '<optgroup label="' + esc(cat.label) + '">' + cat.subcategories.map((sub) =>
      '<option value="' + esc(sub.id) + '"' + (sub.id === elegida ? " selected" : "") + ">" +
      esc(sub.label) + "</option>").join("") + "</optgroup>").join("");
}

function filaServicio(s) {
  s = s || {};
  const num = (v) => (v == null ? "" : esc(v));
  return (
    '<div class="service-row">' +
      '<label class="f grow"><span>Subcategoría</span>' +
        '<select class="field" data-svc="subcategory_id" required>' + opcionesCatalogo(s.subcategory_id) + "</select></label>" +
      '<label class="f grow"><span>Nombre del servicio <i>(opcional)</i></span>' +
        '<input class="field" data-svc="name" maxlength="120" value="' + esc(s.name || "") + '" placeholder="Se usa el de la subcategoría" /></label>' +
      '<label class="f price"><span>Precio desde</span>' +
        '<input class="field" data-svc="min_price" inputmode="decimal" value="' + num(s.min_price) + '" /></label>' +
      '<label class="f price"><span>hasta</span>' +
        '<input class="field" data-svc="max_price" inputmode="decimal" value="' + num(s.max_price) + '" /></label>' +
      '<button type="button" class="btn btn-ghost danger" data-quitar-servicio aria-label="Quitar este servicio">Quitar</button>' +
    "</div>"
  );
}

function pintarLugares() {
  $("regionList").innerHTML = store.lugares.map((l) => '<option value="' + esc(l.region) + '">').join("");
  const region = $("f_region_text").value.trim().toLowerCase();
  const lugar = store.lugares.find((l) => l.region.toLowerCase() === region);
  $("cityList").innerHTML = ((lugar && lugar.cities) || []).map((c) => '<option value="' + esc(c) + '">').join("");
}

function leer() {
  const p = {};
  CAMPOS.forEach((campo) => { p[campo] = $("f_" + campo).value.trim(); });
  p.services = Array.prototype.map.call($("serviceRows").children, (fila) => {
    const s = {};
    fila.querySelectorAll("[data-svc]").forEach((el) => { s[el.dataset.svc] = el.value.trim(); });
    return s;
  }).filter((s) => s.subcategory_id);
  if ($("f_email_placeholder").checked) {
    p.email = "";
    p.email_placeholder = true;
  }
  return p;
}

/** Sin correo: el campo se vacía y se bloquea, y se explica qué pasará. */
function pintarCorreoTemporal() {
  const tmp = $("f_email_placeholder").checked;
  $("f_email").disabled = tmp;
  if (tmp) $("f_email").value = "";
  $("placeholderInfo").hidden = !tmp;
}

function rellenar(datos) {
  datos = datos || {};
  CAMPOS.forEach((campo) => { $("f_" + campo).value = datos[campo] || ""; });
  $("f_email_placeholder").checked = !!datos.email_placeholder;
  pintarCorreoTemporal();
  $("serviceRows").innerHTML = (datos.services || []).map(filaServicio).join("");
  pintarLugares();
  mostrarProblemas(null);
  avisosVistos = null;
  $("createBtn").textContent = "Crear proveedor";
}

function mostrarProblemas(problemas) {
  $("formIssues").innerHTML = listaProblemas(problemas);
  $("formIssues").hidden = !problemas || !problemas.length;
  document.querySelectorAll("#providerForm .invalid").forEach((el) => el.classList.remove("invalid"));
  (problemas || []).filter((p) => p.level === "error").forEach((p) => {
    const el = $("f_" + p.field);
    if (el) el.classList.add("invalid");
  });
}

function ponerOrigen(nuevo) {
  origen = nuevo;
  $("formOrigin").hidden = !nuevo;
  $("formTitle").textContent = nuevo ? "Completar proveedor" : "Nuevo proveedor";
  $("resetBtn").textContent = nuevo ? "Volver al agente" : "Limpiar";
}

function ocupar(si) {
  $("createBtn").disabled = si;
  $("resetBtn").disabled = si;
}

/**
 * Primer clic: se comprueba. Con errores no se crea. Con solo avisos se
 * enseñan y el botón pasa a "Crear de todos modos"; el segundo clic con los
 * mismos datos crea. Sin nada que avisar, crea directo.
 */
async function enviar(ev) {
  ev.preventDefault();
  const proveedor = leer();
  const huella = JSON.stringify(proveedor);
  ocupar(true);

  try {
    if (avisosVistos !== huella) {
      const check = await rpc("providerCheck", { provider: proveedor });
      mostrarProblemas(check.issues);
      if (tieneErrores(check.issues)) return;
      if (check.issues.length) {
        avisosVistos = huella;
        $("createBtn").textContent = "Crear de todos modos";
        return;
      }
    }

    const res = await rpc("providerCreate", Object.assign({ provider: proveedor }, origen || {}));
    if (!res.ok) {
      mostrarProblemas(res.issues);
      avisosVistos = null;
      $("createBtn").textContent = "Crear proveedor";
      return;
    }

    aviso(proveedor.brand + " creado. Su aviso ya está listo para enviar.", "ok");
    const veniaDelAgente = !!origen;
    ponerOrigen(null);
    rellenar(null);
    emitir("proveedor-creado", { irALista: !veniaDelAgente });
    if (veniaDelAgente) emitir("ir", "agente");
  } catch (err) {
    aviso("No se pudo crear: " + motivo(err), "error");
  } finally {
    ocupar(false);
  }
}

export function iniciar() {
  $("providerForm").addEventListener("submit", enviar);

  // Cualquier cambio invalida los avisos que ya se habían aceptado.
  $("providerForm").addEventListener("input", () => {
    if (avisosVistos === null) return;
    avisosVistos = null;
    $("createBtn").textContent = "Crear proveedor";
  });

  $("addServiceBtn").addEventListener("click", () => {
    $("serviceRows").insertAdjacentHTML("beforeend", filaServicio());
    $("serviceRows").lastElementChild.querySelector("select").focus();
  });

  $("serviceRows").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-quitar-servicio]");
    if (b) b.closest(".service-row").remove();
  });

  $("f_region_text").addEventListener("input", pintarLugares);
  $("f_email_placeholder").addEventListener("change", pintarCorreoTemporal);

  $("resetBtn").addEventListener("click", () => {
    const veniaDelAgente = !!origen;
    ponerOrigen(null);
    rellenar(null);
    if (veniaDelAgente) emitir("ir", "agente");
  });

  escuchar("revisar-propuesta", (d) => {
    ponerOrigen({ job_id: d.job_id, proposal_id: d.proposal_id });
    rellenar(d.data);
    mostrarProblemas(d.issues);
    emitir("ir", "nuevo");
    $("f_" + (d.data.email ? "brand" : "email")).focus();
  });
}

export function preparar() {
  ponerOrigen(null);
  rellenar(null);
}
