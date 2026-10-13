/* =============================================================================
   Sesión de administrador y llamadas a Supabase. Sin SDK: son tres endpoints.

   La sesión es la de Supabase Auth (correo + contraseña de un administrador).
   Que el usuario sea admin NO se decide aquí: lo comprueba cada RPC en el
   servidor. Un usuario normal puede iniciar sesión y aun así no ver nada.
   ============================================================================= */

const CFG = window.TUPINCHA_WEB;

let sesion = leer();
let renovando = null;
let alCaducar = () => {};

function leer() {
  try { return JSON.parse(localStorage.getItem(CFG.storage.session)) || null; }
  catch (e) { return null; }
}

function guardar(nueva) {
  sesion = nueva;
  try {
    if (nueva) localStorage.setItem(CFG.storage.session, JSON.stringify(nueva));
    else localStorage.removeItem(CFG.storage.session);
  } catch (e) { /* modo privado: la sesión dura lo que dure la pestaña */ }
}

function error(mensaje, extra) {
  return Object.assign(new Error(mensaje), extra);
}

async function auth(ruta, cuerpo, token) {
  const res = await fetch(CFG.supabaseUrl + "/auth/v1/" + ruta, {
    method: "POST",
    headers: {
      apikey: CFG.supabaseAnonKey,
      Authorization: "Bearer " + (token || CFG.supabaseAnonKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cuerpo || {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw error((data && (data.msg || data.error_description || data.message)) || "HTTP " + res.status, {
      status: res.status,
      code: data && (data.error_code || data.error),
      auth: true,
    });
  }
  return data;
}

function deRespuesta(data) {
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    email: data.user && data.user.email,
  };
}

export function haySesion() {
  return !!(sesion && sesion.refresh_token);
}

export function onSesionCaducada(fn) {
  alCaducar = fn;
}

export async function entrar(email, password) {
  guardar(deRespuesta(await auth("token?grant_type=password", { email, password })));
}

export async function salir() {
  const token = sesion && sesion.access_token;
  guardar(null);
  if (token) await auth("logout", {}, token).catch(() => {});
}

/** Un solo refresh aunque varias llamadas lo pidan a la vez. */
function renovar() {
  if (!renovando) {
    renovando = auth("token?grant_type=refresh_token", { refresh_token: sesion.refresh_token })
      .then((data) => guardar(deRespuesta(data)))
      .finally(() => { renovando = null; });
  }
  return renovando;
}

async function tokenVigente() {
  if (!haySesion()) throw error("UNAUTHENTICATED", { code: "P0010" });
  if (sesion.expires_at - Date.now() < 60000) await renovar();
  return sesion.access_token;
}

async function llamar(nombre, params, token) {
  const res = await fetch(CFG.supabaseUrl + "/rest/v1/rpc/" + nombre, {
    method: "POST",
    headers: {
      apikey: CFG.supabaseAnonKey,
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_params: params || {} }),
  });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
  if (!res.ok) {
    throw error((data && data.message) || "HTTP " + res.status, {
      status: res.status,
      code: data && data.code,
    });
  }
  return data;
}

/**
 * RPC con sesión de admin. Si el token caducó a mitad de camino se renueva una
 * vez; si ni así, la sesión se da por perdida y se vuelve al login.
 */
export async function rpc(clave, params) {
  const nombre = CFG.rpc[clave];
  try {
    try {
      return await llamar(nombre, params, await tokenVigente());
    } catch (e) {
      if (e.status !== 401) throw e;
      await renovar();
      return await llamar(nombre, params, sesion.access_token);
    }
  } catch (e) {
    // e.auth: falló el propio refresh (token revocado o caducado del todo).
    if (e.code === "P0010" || e.status === 401 || e.auth) {
      guardar(null);
      alCaducar();
    }
    throw e;
  }
}
