/* Estado compartido entre vistas. Lo llena app.js al entrar. */

export const store = {
  admin: null,
  /** [{ id, label, subcategories: [{ id, label }] }] — catálogo vivo */
  catalogo: [],
  /** [{ region, cities: [] }] — zonas que la campaña ya conoce */
  lugares: [],
  agente: { dispatch_ready: false, runner_ready: false },
  contactos: [],
  trabajos: [],
};

/** Las vistas se avisan entre sí sin importarse unas a otras. */
export function emitir(nombre, detalle) {
  document.dispatchEvent(new CustomEvent("tp:" + nombre, { detail: detalle }));
}

export function escuchar(nombre, fn) {
  document.addEventListener("tp:" + nombre, (ev) => fn(ev.detail));
}
