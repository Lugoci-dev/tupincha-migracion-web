/* =============================================================================
   TuPincha · Campaña de proveedores
   Arranque, sesión y navegación entre las tres vistas. Sin framework ni build:
   son módulos ES que GitHub Pages sirve tal cual.

     Contactos        js/contacts.js       a quién se avisó y quién activó
     Nuevo proveedor  js/provider-form.js  alta manual
     Agente           js/agent.js          texto plano -> propuestas
   ============================================================================= */

import * as api from "./api.js";
import { store, escuchar, emitir } from "./store.js";
import { $, aviso, motivo, cerrarDialogo } from "./ui.js";
import * as contactos from "./contacts.js";
import * as formulario from "./provider-form.js";
import * as agente from "./agent.js";

const VISTAS = ["contactos", "nuevo", "agente"];

/* ------------------------------------------------------------- navegación */

function ir(nombre) {
  if (VISTAS.indexOf(nombre) === -1) nombre = "contactos";
  VISTAS.forEach((v) => {
    $("view-" + v).hidden = v !== nombre;
    const tab = $("tab-" + v);
    tab.classList.toggle("active", v === nombre);
    tab.setAttribute("aria-selected", v === nombre ? "true" : "false");
  });
  if (location.hash !== "#" + nombre) history.replaceState(null, "", "#" + nombre);
  window.scrollTo(0, 0);
  emitir("vista", nombre);
}

/* ------------------------------------------------------------------ login */

function mostrarLogin(mensaje) {
  cerrarDialogo();
  contactos.limpiar();
  agente.limpiar();
  store.contactos = [];
  $("app").hidden = true;
  $("loginScreen").hidden = false;
  $("loginError").hidden = !mensaje;
  $("loginError").textContent = mensaje || "";
  $("passwordInput").value = "";
  ($("emailInput").value ? $("passwordInput") : $("emailInput")).focus();
}

/** Carga lo que necesitan todas las vistas y abre la aplicación. */
async function abrir() {
  let datos;
  try {
    datos = await api.rpc("bootstrap");
  } catch (err) {
    if (err.code === "P0011") {
      // Sesión válida, pero el usuario no es administrador.
      await api.salir();
      mostrarLogin("Ese usuario no es administrador de TuPincha.");
    } else if (api.haySesion()) {
      mostrarLogin("No se pudo conectar: " + motivo(err));
    }
    return;
  }

  store.admin = datos.admin;
  store.catalogo = datos.catalog || [];
  store.lugares = datos.places || [];
  store.agente = datos.agent || store.agente;

  $("adminEmail").textContent = store.admin.email;
  $("loginScreen").hidden = true;
  $("app").hidden = false;

  formulario.preparar();
  agente.render();
  ir(location.hash.slice(1));
  contactos.cargar();
  if (location.hash !== "#agente") agente.cargar();
}

async function alEntrar(ev) {
  ev.preventDefault();
  const btn = $("loginBtn");
  btn.disabled = true;
  btn.textContent = "Entrando…";
  try {
    await api.entrar($("emailInput").value.trim(), $("passwordInput").value);
    $("loginError").hidden = true;
    await abrir();
  } catch (err) {
    mostrarLogin(err.status === 400
      ? "Correo o contraseña incorrectos."
      : "No se pudo entrar: " + motivo(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar";
  }
}

/* ------------------------------------------------------------------- boot */

contactos.iniciar();
formulario.iniciar();
agente.iniciar();

$("loginForm").addEventListener("submit", alEntrar);

$("logoutBtn").addEventListener("click", async () => {
  await api.salir();
  mostrarLogin();
});

$("tabs").addEventListener("click", (ev) => {
  const tab = ev.target.closest("[data-vista]");
  if (tab) ir(tab.dataset.vista);
});

$("dialogClose").addEventListener("click", cerrarDialogo);
$("dialog").addEventListener("click", (ev) => {
  if (ev.target === $("dialog")) cerrarDialogo();   // clic en el fondo
});

window.addEventListener("hashchange", () => {
  if (!$("app").hidden) ir(location.hash.slice(1));
});

escuchar("ir", ir);

escuchar("propuestas", (n) => {
  $("agentBadge").hidden = !n;
  $("agentBadge").textContent = n;
});

api.onSesionCaducada(() => {
  if (!$("app").hidden) {
    mostrarLogin("La sesión caducó. Vuelve a entrar.");
    aviso("La sesión caducó.", "error");
  }
});

if (api.haySesion()) abrir();
else mostrarLogin();
