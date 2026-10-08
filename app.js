/* =============================================================================
   TuPincha · Campaña de migración
   Lógica del sitio. Sin framework ni build: se publica tal cual en GitHub Pages.

   ── De dónde sale el estado de cada contacto ─────────────────────────────────
   Antes todo vivía en localStorage y la app llamaba "enviado" a tres cosas que
   no son lo mismo:

     · abrir un wa.me / un mailto:  ->  no prueba que se mandara
     · encolar en Resend            ->  no prueba que Resend lo aceptara
     · Resend aceptó el correo      ->  esto SÍ es un hecho

   Ahora se separan las dos fuentes y no se mezclan:

     SERVIDOR  web_migration_list() devuelve email_status / email_sent_at /
              email_attempts, derivados de web_migration_email_log. Es el único
              hecho comprobable y lo comparten todas las máquinas.

     LOCAL     state.manual guarda solo lo manual (abriste wa.me o mailto:).
              No hay registro servidor de eso y no lo vamos a inventar, pero
              tampoco lo tomamos por un envío.

   Precedencia: el servidor manda. Si el servidor dice 'fallido', se muestra
   fallido aunque localement alguien haya abierto el mailto.

   El envío en masa es SIEMPRE por selección explícita: no existe forma de
   mandarle a "todos los visibles" por accidente.
   ============================================================================= */

(function () {
  "use strict";

  var CFG = window.TUPINCHA_WEB;

  var state = {
    token: null,
    contactos: [],
    cargando: false,
    filtro: "pendientes",
    busqueda: "",
    /** { [legacy_id]: { canal: "wa"|"mail", at: ISO } } — solo acciones manuales */
    manual: {},
    /** Set de legacy_id marcados para envío por correo. */
    seleccion: {},
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- utilities */

  function esc(valor) {
    return String(valor == null ? "" : valor)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function store(clave, valor) {
    try {
      if (valor === null) localStorage.removeItem(clave);
      else localStorage.setItem(clave, valor);
    } catch (e) { /* modo privado: la web sigue funcionando sin persistencia */ }
  }

  function cargar(clave, porDefecto) {
    try { return localStorage.getItem(clave) || porDefecto; } catch (e) { return porDefecto; }
  }

  function fechaCorta(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return "";
    return d.toLocaleDateString("es-CU", { day: "2-digit", month: "2-digit" }) +
      " " + d.toLocaleTimeString("es-CU", { hour: "2-digit", minute: "2-digit" });
  }

  function plural(n, singular, plural_) {
    return n + " " + (n === 1 ? singular : plural_);
  }

  /* -------------------------------------------------------------------- rpc */

  function rpc(nombre, parametros) {
    return fetch(CFG.supabaseUrl + "/rest/v1/rpc/" + nombre, {
      method: "POST",
      headers: {
        apikey: CFG.supabaseAnonKey,
        Authorization: "Bearer " + CFG.supabaseAnonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parametros || {}),
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error((data && (data.message || data.hint)) || ("HTTP " + res.status));
          err.code = data && data.code;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* ------------------------------------------------------------------ login */

  function mostrarLogin(mensaje) {
    $("app").hidden = true;
    $("loginScreen").hidden = false;
    var box = $("loginError");
    if (mensaje) { box.hidden = false; box.textContent = mensaje; }
    else { box.hidden = true; }
    $("passcodeInput").focus();
  }

  function guardarToken(data) {
    state.token = data.token;
    store(CFG.storage.token, data.token);
    store(CFG.storage.tokenExpires, data.expires_at);
  }

  function entrar(passcode) {
    var btn = $("loginBtn");
    btn.disabled = true;
    btn.textContent = "Entrando…";
    return rpc(CFG.rpc.login, { p_params: { passcode: passcode } })
      .then(function (data) {
        guardarToken(data);
        $("loginError").hidden = true;
        return cargarLista();
      })
      .catch(function (err) {
        mostrarLogin(
          err.code === "P0010"
            ? "Código incorrecto."
            : "No se pudo entrar: " + err.message
        );
      })
      .finally(function () {
        btn.disabled = false;
        btn.textContent = "Entrar";
      });
  }

  function salir() {
    var token = state.token;
    rpc(CFG.rpc.logout, { p_token: token }).catch(function () { /* da igual */ });
    state.token = null;
    state.seleccion = {};
    store(CFG.storage.token, null);
    store(CFG.storage.tokenExpires, null);
    mostrarLogin();
  }

  /* --------------------------------------------------------------- listar */

  function cargarLista() {
    state.cargando = true;
    return rpc(CFG.rpc.list, { p_token: state.token })
      .then(function (data) {
        state.contactos = data.contacts || [];
        // Descarta selección de contactos que ya no estén en la lista.
        var ids = {};
        state.contactos.forEach(function (c) { ids[c.legacy_id] = true; });
        Object.keys(state.seleccion).forEach(function (k) {
          if (!ids[k]) delete state.seleccion[k];
        });
        $("loginScreen").hidden = true;
        $("app").hidden = false;
        render();
      })
      .catch(function (err) {
        if (err.code === "P0010") {
          state.token = null;
          store(CFG.storage.token, null);
          store(CFG.storage.tokenExpires, null);
          mostrarLogin("La sesión caducó. Vuelve a entrar.");
        } else {
          mostrarLogin("No se pudo cargar la lista: " + err.message);
        }
      })
      .finally(function () { state.cargando = false; });
  }

  /* ------------------------------------------------- estado manual (local) */

  function leerManual() {
    var bruto;
    try { bruto = JSON.parse(cargar(CFG.storage.estado, "{}")) || {}; }
    catch (e) { state.manual = {}; return; }

    // Migración: antes el canal era "whatsapp" | "correo" | "correo-enviado".
    // Los dos primeros son acciones manuales y se conservan. "correo-enviado"
    // era una suposición local de un envío por Resend: se descarta, porque esa
    // verdad ahora la tiene el servidor en web_migration_email_log.
    var nuevo = {};
    Object.keys(bruto).forEach(function (id) {
      var e = bruto[id];
      if (!e) return;
      if (e.canal === "whatsapp" || e.canal === "wa") nuevo[id] = { canal: "wa", at: e.at };
      else if (e.canal === "correo" || e.canal === "mail") nuevo[id] = { canal: "mail", at: e.at };
    });
    state.manual = nuevo;
    store(CFG.storage.estado, JSON.stringify(nuevo));
  }

  function marcarManual(legacyId, canal) {
    state.manual[legacyId] = { canal: canal, at: new Date().toISOString() };
    store(CFG.storage.estado, JSON.stringify(state.manual));
    render();
  }

  function borrarManual(legacyId) {
    delete state.manual[legacyId];
    store(CFG.storage.estado, JSON.stringify(state.manual));
    render();
  }

  /* ------------------------------------------------------------- situación */

  // Un solo lugar que decide qué se le dice a cada contacto. El servidor tiene
  // precedencia; lo manual solo aparece si el servidor no sabe nada.
  var SITUACIONES = {
    enviado:        { etiqueta: "Enviado",        detalle: "confirmado por Resend", tono: "ok",    hecho: true },
    fallido:        { etiqueta: "Falló",          detalle: "reintentable",          tono: "error", hecho: true },
    encolado:       { etiqueta: "Encolado",       detalle: "esperando confirmación", tono: "warn", hecho: false },
    "sin-respuesta": { etiqueta: "Sin respuesta", detalle: "no se pudo confirmar", tono: "warn",   hecho: false },
    "abierto-wa":   { etiqueta: "WhatsApp abierto", detalle: "sin confirmar",        tono: "muted", hecho: false },
    "abierto-mail": { etiqueta: "Correo abierto",   detalle: "sin confirmar",        tono: "muted", hecho: false },
    pendiente:      { etiqueta: "",                detalle: "",                      tono: "idle",  hecho: false },
  };

  function situacion(c) {
    if (c.email_status && SITUACIONES[c.email_status]) return c.email_status;
    var m = state.manual[c.legacy_id];
    if (m) return m.canal === "wa" ? "abierto-wa" : "abierto-mail";
    return "pendiente";
  }

  function info(c) {
    var clave = situacion(c);
    return { clave: clave, s: SITUACIONES[clave] };
  }

  /* ---------------------------------------------------------------- render */

  function coincideBusqueda(c) {
    if (!state.busqueda) return true;
    var q = state.busqueda;
    var todo = [
      c.brand, c.email, c.phone,
      (c.contact || {}).specialty, (c.contact || {}).bio,
      (c.contact || {}).region_text, (c.contact || {}).address_text,
      (c.category_slugs || []).join(" "),
      Object.keys(c.category_labels || {}).join(" "),
      (c.subcategory_ids || []).join(" "),
      Object.keys(c.subcategory_labels || {}).join(" "),
      situacion(c),
    ].join(" ").toLowerCase();
    return todo.indexOf(q) !== -1;
  }

  function pasaFiltro(c) {
    var clave = situacion(c);
    switch (state.filtro) {
      case "pendientes": return clave === "pendiente";
      case "sin-confirmar":
        return clave === "abierto-wa" || clave === "abierto-mail" ||
               clave === "encolado" || clave === "sin-respuesta";
      case "enviados": return clave === "enviado";
      case "fallidos": return clave === "fallido";
      case "sin-categoria": return !(c.category_slugs || []).length;
      default: return true;
    }
  }

  function visibles() {
    return state.contactos.filter(function (c) {
      return pasaFiltro(c) && coincideBusqueda(c);
    });
  }

  function tagsDe(c) {
    var etiquetas = (c.category_slugs || []).map(function (slug) {
      return '<span class="tag cat">' + esc((c.category_labels || {})[slug] || slug) + "</span>";
    });
    etiquetas = etiquetas.concat(
      (c.subcategory_ids || []).map(function (id) {
        return '<span class="tag sub">' + esc((c.subcategory_labels || {})[id] || id) + "</span>";
      })
    );
    if (!etiquetas.length) etiquetas.push('<span class="tag none">sin categoría</span>');
    return etiquetas.join("");
  }

  function lineaEstado(c) {
    var i = info(c);
    if (i.clave === "pendiente") return "";

    var m = state.manual[c.legacy_id];
    var cuando = c.email_sent_at || (m && m.at) || null;

    return (
      '<div class="status-line">' +
        '<span class="pill ' + i.s.tono + '">' + esc(i.s.etiqueta) + "</span>" +
        "<span>" + esc(i.s.detalle) + "</span>" +
        (cuando ? "<time>" + esc(fechaCorta(cuando)) + "</time>" : "") +
        (c.email_attempts > 1 ? "<span>· " + c.email_attempts + " intentos</span>" : "") +
        (m ? '<button class="chip" data-accion="desmarcar" data-id="' + c.legacy_id +
             '" style="padding:2px 9px;font-size:11px">quitar marca</button>' : "") +
      "</div>"
    );
  }

  function tarjeta(c) {
    var i = info(c);
    var cont = c.contact || {};
    var sel = !!state.seleccion[c.legacy_id];
    var detalles = [];
    if (cont.specialty) detalles.push("<b>Oficio:</b> " + esc(cont.specialty));
    if (cont.region_text || cont.address_text) {
      var zona = [cont.address_text, cont.region_text].filter(Boolean).join(", ");
      detalles.push("<b>Zona:</b> " + esc(zona));
    }
    detalles.push("<b>Servicios:</b> " + (c.services_count || 0));

    var acciones = c.wa_digits
      ? '<button class="btn btn-wa" data-accion="whatsapp" data-id="' + c.legacy_id + '">WhatsApp</button>'
      : "";
    acciones += '<button class="btn btn-mail" data-accion="correo" data-id="' + c.legacy_id + '">Correo</button>';
    acciones += '<button class="btn btn-outline" data-accion="enviar" data-id="' + c.legacy_id + '">Enviar</button>';

    return (
      '<article class="card ' + i.clave + (sel ? " seleccionada" : "") + '">' +
        '<div class="card-top">' +
          '<input class="card-pick" type="checkbox" data-accion="elegir" data-id="' + c.legacy_id + '"' +
            (sel ? " checked" : "") +
            ' aria-label="Seleccionar a ' + esc(c.brand) + ' para envío por correo" />' +
          "<h3>" + esc(c.brand) + "</h3>" +
        "</div>" +
        '<div class="meta">' + detalles.join(" · ") + "</div>" +
        '<div class="tags">' + tagsDe(c) + "</div>" +
        '<div class="meta plan">' +
          ((c.category_slugs || []).length
            ? "Se crean al confirmar su correo"
            : "Sin servicios en el legacy") +
        "</div>" +
        (cont.bio ? '<p class="bio">' + esc(cont.bio) + "</p>" : "") +
        '<div class="contact">' +
          (c.phone ? "<span>📱 " + esc(c.phone) + "</span>" : "") +
          "<span>✉️ <a href=\"mailto:" + esc(c.email) + '\">' + esc(c.email) + "</a></span>" +
        "</div>" +
        lineaEstado(c) +
        '<div class="actions">' + acciones + "</div>" +
      "</article>"
    );
  }

  /** Scrollers: el degradado solo aparece si de verdad hay más contenido. */
  function ajustarScrollers() {
    Array.prototype.forEach.call(document.querySelectorAll(".scroller"), function (s) {
      s.classList.toggle("overflow", s.scrollWidth > s.clientWidth + 1);
    });
  }

  function render() {
    var vis = visibles();

    var confirmados = 0, sinConfirmar = 0, fallidos = 0, pendientes = 0;
    state.contactos.forEach(function (c) {
      var k = situacion(c);
      if (k === "enviado") confirmados += 1;
      else if (k === "fallido") fallidos += 1;
      else if (k === "pendiente") pendientes += 1;
      else sinConfirmar += 1;
    });

    var total = state.contactos.length;
    var pct = total ? Math.round((confirmados / total) * 100) : 0;

    $("counterBadge").textContent = confirmados + " / " + total;
    $("progressBar").style.width = pct + "%";
    $("progressText").textContent =
      confirmados + " confirmados · " + sinConfirmar + " sin confirmar · " +
      fallidos + " fallidos · " + pendientes + " pendientes";

    // La nota solo aparece cuando hay algo que avisar. Si todo está confirmado
    // o nada se tocó, ocupa 50px de una pantalla de 844 para decir nada.
    var nota = $("progressNote");
    if (sinConfirmar + fallidos > 0) {
      nota.hidden = false;
      nota.textContent =
        "La barra solo cuenta los que Resend confirmó. Abrir un mailto: o un wa.me " +
        "no prueba que el mensaje saliera.";
    } else {
      nota.hidden = true;
      nota.textContent = "";
    }

    var nSel = Object.keys(state.seleccion).length;
    var btn = $("sendSelectedBtn");
    btn.disabled = nSel === 0;
    btn.textContent = nSel === 0
      ? "Enviar los seleccionados"
      : "Enviar a " + nSel + (nSel === 1 ? " seleccionado" : " seleccionados");

    var sel = $("selectAll");
    var visIds = vis.map(function (c) { return c.legacy_id; });
    var todosSel = visIds.length > 0 && visIds.every(function (id) { return state.seleccion[id]; });
    var algunosSel = visIds.some(function (id) { return state.seleccion[id]; });
    sel.checked = todosSel;
    sel.indeterminate = !todosSel && algunosSel;
    $("selectAllLabel").textContent = algunosSel
      ? "Quitar de la selección (" + visIds.filter(function (id) { return state.seleccion[id]; }).length + ")"
      : "Seleccionar los visibles (" + visIds.length + ")";

    $("grid").innerHTML = vis.map(tarjeta).join("");
    $("emptyMsg").hidden = vis.length > 0;
    ajustarScrollers();
  }

  /* ----------------------------------------------------------------- modal */

  function cerrarModal() {
    $("modalBg").hidden = true;
  }

  function abrirModal(legacyId) {
    var c = state.contactos.filter(function (x) { return x.legacy_id === legacyId; })[0];
    if (!c) return;

    $("modalTitle").textContent = c.brand;
    $("modalBody").innerHTML = '<p class="hint">Cargando el mensaje…</p>';
    $("modalFooter").innerHTML = "";
    $("modalBg").hidden = false;

    rpc(CFG.rpc.message, { p_token: state.token, p_legacy_id: legacyId })
      .then(function (m) {
        var credenciales =
          '<div class="credenciales">' +
            '<div class="cred"><span>Correo</span><b>' + esc(m.email) + "</b></div>" +
            '<div class="cred"><span>Contraseña</span><b>' + esc(m.password) + "</b></div>" +
            (m.phone ? '<div class="cred"><span>Teléfono</span><b>' + esc(m.phone) + "</b></div>" : "") +
          "</div>";

        var i = info(c);

        var texto =
          credenciales +
          '<div class="msg">' + esc(m.wa_message) + "</div>" +
          '<p class="hint">Este texto es el que se envía por WhatsApp. ' +
          "El correo lleva su propio asunto y cuerpo, con el mismo contenido." +
          (i.clave === "pendiente" ? "" :
            '<br/><br/><b>Estado actual:</b> ' + esc(i.s.etiqueta) + " — " + esc(i.s.detalle) + ".") +
          "</p>";

        var pie = "";
        if (m.wa_digits) {
          pie +=
            '<button class="btn btn-wa" data-accion="abrir-wa" data-id="' + legacyId + '">' +
            "Abrir WhatsApp</button>";
        }
        pie += '<button class="btn btn-mail" data-accion="abrir-mail" data-id="' + legacyId + '">' +
          "Abrir correo</button>";
        pie += '<button class="btn btn-primary" data-accion="enviar" data-id="' + legacyId + '">' +
          "Enviar por Resend</button>";
        pie += '<button class="btn btn-ghost" data-accion="copiar" data-id="' + legacyId + '">' +
          "Copiar texto</button>";

        $("modalBody").innerHTML = texto;
        $("modalFooter").innerHTML = pie;
      })
      .catch(function (err) {
        $("modalBody").innerHTML = '<div class="alert">No se pudo cargar: ' + esc(err.message) + "</div>";
      });
  }

  function mensajeDe(legacyId) {
    return rpc(CFG.rpc.message, { p_token: state.token, p_legacy_id: legacyId });
  }

  /**
   * Abrir wa.me / mailto: NO es un envío. Se marca como "abierto" y con eso
   * basta: la web deja de fingir que el mensaje salió.
   */
  function abrirWa(legacyId) {
    mensajeDe(legacyId).then(function (m) {
      var url = "https://wa.me/" + m.wa_digits + "?text=" + encodeURIComponent(m.wa_message);
      window.open(url, "_blank", "noopener");
      marcarManual(legacyId, "wa");
    }).catch(function (err) { alert("No se pudo abrir WhatsApp: " + err.message); });
  }

  function abrirMail(legacyId) {
    mensajeDe(legacyId).then(function (m) {
      var url = "mailto:" + m.email +
        "?subject=" + encodeURIComponent(m.email_subject) +
        "&body=" + encodeURIComponent(m.email_body);
      window.location.href = url;
      marcarManual(legacyId, "mail");
    }).catch(function (err) { alert("No se pudo abrir el correo: " + err.message); });
  }

  /**
   * Envío real por correo: la RPC encola la llamada a la Edge Function, que la
   * manda por Resend. Devuelve "queued" (es asíncrono), así que el estado real
   * no se sabe ahora: queda 'encolado' y web_migration_list() lo confirma (o lo
   * marca SIN_RESPUESTA) en la próxima carga.
   *
   * El estado NO se marca localmente. Antes ponía 'correo-enviado' en el
   * navegador, que era una suposición; ahora lo dice el servidor.
   */
  function enviarCorreo(legacyIds, opciones) {
    opciones = opciones || {};
    if (!state.token) { alert("La sesión caducó. Vuelve a entrar."); return; }

    if (legacyIds.length > 1 && !opciones.confirmado) {
      abrirConfirmacion(legacyIds);
      return;
    }

    var btn = $("sendSelectedBtn");
    var previo = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Enviando…";

    return rpc(CFG.rpc.sendEmail, {
      p_params: { p_token: state.token, p_legacy_ids: legacyIds, p_dry_run: false },
    })
      .then(function (res) {
        // Los que se mandaron salen de la selección: ya no son "pendientes de enviar".
        legacyIds.forEach(function (id) { delete state.seleccion[id]; });
        cerrarModal();
        alert(
          "Encolados: " + res.queued + " correo(s).\n\n" +
          "Resend los manda en segundo plano. Esto NO confirma que salieran:\n" +
          "recarga la lista en unos segundos para ver el estado real de cada uno."
        );
        return cargarLista();
      })
      .catch(function (err) {
        alert("No se pudo encolar el envío: " + err.message);
      })
      .finally(function () {
        btn.textContent = previo;
        btn.disabled = !Object.keys(state.seleccion).length;
      });
  }

  /* ------------------------------------------------- prueba previa / confirm */

  var MOTIVOS = {
    EMAIL_INVALIDO: "correo no válido",
    SIN_ASUNTO: "sin asunto",
    SIN_CUERPO: "sin cuerpo",
    DESACTIVADO: "desactivado",
  };

  /**
   * Antes de mandar a más de uno: valida en Supabase (que no llama a la Edge
   * Function) y muestra el HTML real del primer contacto. Nada sale hasta que
   * escribas el número de destinatarios.
   *
   * Y sobre todo: la lista de QUIÉN va a recibirlo. Pedir que escribas un
   * número no dice a quién se lo mandas.
   */
  function abrirConfirmacion(legacyIds) {
    $("modalTitle").textContent = "Enviar correos";
    $("modalBody").innerHTML = '<p class="hint">Comprobando ' + plural(legacyIds.length, "contacto", "contactos") + "…</p>";
    $("modalFooter").innerHTML = "";
    $("modalBg").hidden = false;

    rpc(CFG.rpc.preview, { p_params: { p_token: state.token, p_legacy_ids: legacyIds } })
      .then(function (r) {
        // Si la RPC no devuelve la forma esperada, NO se construye un pie de
        // modal con "undefined" dentro: es mejor fallar con un mensaje claro.
        if (!r || typeof r.listos !== "number") {
          $("modalBody").innerHTML =
            '<div class="alert">La comprobación no devolvió datos válidos. ' +
            "No se envió nada. Recarga la página e intentá de nuevo.</div>";
          $("modalFooter").innerHTML = "";
          return;
        }
        var faltan = r.faltan || [];
        var muestra = r.muestra;

        var porLegacyId = {};
        state.contactos.forEach(function (c) { porLegacyId[c.legacy_id] = c; });

        var lista = legacyIds.map(function (id) { return porLegacyId[id]; }).filter(Boolean);
        var LIMITE = 40;
        var items = lista.slice(0, LIMITE).map(function (c) {
          return "<li><b>" + esc(c.brand) + "</b><span>" + esc(c.email) + "</span></li>";
        }).join("");
        var resto = lista.length - LIMITE;

        var html =
          '<div class="check"><div class="check-ok"><b>' + r.listos + "</b> listos para enviar</div>" +
          (faltan.length
            ? '<div class="check-bad"><b>' + faltan.length + "</b> se quedan fuera:<ul>" +
              faltan.map(function (f) {
                return "<li>" + esc(f.brand || f.legacy_id) + " — " +
                  esc(MOTIVOS[f.reason] || f.reason) + "</li>";
              }).join("") +
              "</ul></div>"
            : "") +
          "</div>" +
          "<p class=\"hint\">Estos son los destinatarios exactos. Cada uno recibe su propia contraseña.</p>" +
          '<ul class="destinatarios">' + items +
          (resto > 0 ? '<li class="mas">… y ' + resto + " más</li>" : "") +
          "</ul>" +
          (muestra
            ? '<p class="hint">Así va a verse el correo (muestra de <b>' +
              esc(muestra.brand) + "</b>, no se envía nada todavía):</p>" +
              '<iframe class="preview" id="mailPreview" title="Muestra del correo"></iframe>'
            : '<p class="hint">No se pudo traer una muestra del correo, pero los destinatarios ' +
              "son los de arriba. Nada sale hasta que escribas el número.</p>");

        $("modalBody").innerHTML = html;

        // El HTML real lo compone la Edge Function en dry_run
        if (muestra) {
          rpc(CFG.rpc.sendEmail, {
            p_params: { p_token: state.token, p_legacy_ids: [muestra.legacy_id], p_dry_run: true },
          })
            .then(function () { return esperarMuestra(muestra.legacy_id); })
            .then(function (htmlCorreo) {
              var frame = $("mailPreview");
              if (frame && htmlCorreo) frame.srcdoc = htmlCorreo;
            })
            .catch(function () {
              var frame = $("mailPreview");
              if (frame) frame.srcdoc = "<p style='font-family:sans-serif'>No se pudo cargar la muestra.</p>";
            });
        }

        var pie =
          '<div class="confirm">' +
          '<label for="confirmInput">Escribe <b>' + legacyIds.length + "</b> para confirmar:</label>" +
          '<input class="field" id="confirmInput" inputmode="numeric" autocomplete="off" placeholder="' +
          legacyIds.length + '" />' +
          "</div>" +
          '<button class="btn btn-primary" id="confirmSend" disabled>Enviar ' +
          plural(r.listos, "correo", "correos") + "</button>";

        $("modalFooter").innerHTML = pie;

        var input = $("confirmInput");
        var botonOk = $("confirmSend");
        input.addEventListener("input", function () {
          botonOk.disabled = input.value.trim() !== String(legacyIds.length);
        });
        botonOk.addEventListener("click", function () {
          enviarCorreo(legacyIds, { confirmado: true });
        });
      })
      .catch(function (err) {
        $("modalBody").innerHTML = '<div class="alert">No se pudo comprobar: ' + esc(err.message) + "</div>";
      });
  }

  /** El envío es asíncrono: el HTML llega a net._http_response en unos segundos. */
  function esperarMuestra(legacyId) {
    var intentos = 0;
    return new Promise(function (resolve) {
      function consultar() {
        intentos += 1;
        rpc(CFG.rpc.emailLog, { p_token: state.token, p_limit: 5 })
          .then(function (res) {
            var mio = (res.sends || []).filter(function (s) { return s.legacy_id === legacyId && s.dry_run; })[0];
            var html = mio && mio.response && mio.response.results && mio.response.results[0]
              ? mio.response.results[0].html
              : null;
            if (html) return resolve(html);
            if (intentos >= 6) return resolve(null);
            setTimeout(consultar, 1200);
          })
          .catch(function () { resolve(null); });
      }
      consultar();
    });
  }

  function copiarTexto(legacyId) {
    mensajeDe(legacyId).then(function (m) {
      var completo = m.email + "\n" + m.password + "\n\n" + m.wa_message;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(completo).then(function () {
          alert("Copiado: correo, contraseña y mensaje.");
        });
      } else {
        alert(completo);
      }
    }).catch(function (err) { alert("No se pudo copiar: " + err.message); });
  }

  /* ------------------------------------------------------------------- csv */

  function descargarCsv() {
    var filas = [[
      "legacy_id", "brand", "email", "telefono",
      "situacion", "es_hecho", "origen",
      "servidor_email_status", "servidor_email_sent_at", "intentos",
      "manual_canal", "manual_at",
    ]];
    state.contactos.forEach(function (c) {
      var i = info(c);
      var m = state.manual[c.legacy_id];
      filas.push([
        c.legacy_id, c.brand, c.email, c.phone || "",
        i.s.etiqueta || "pendiente", i.s.hecho ? "si" : "no",
        i.clave.indexOf("abierto-") === 0 ? "manual" : "servidor",
        c.email_status || "", c.email_sent_at || "", c.email_attempts || 0,
        m ? m.canal : "", m ? m.at : "",
      ]);
    });

    var csv = filas.map(function (f) {
      return f.map(function (v) {
        v = String(v == null ? "" : v);
        return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(";");
    }).join("\n");

    var url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    var a = document.createElement("a");
    a.href = url;
    a.download = "progreso-migracion.csv";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---------------------------------------------------------------- selección */

  function alternar(legacyId, forzar) {
    var id = String(legacyId);
    var ahora = !state.seleccion[id];
    var queda = forzar === undefined ? ahora : !!forzar;
    if (queda) state.seleccion[id] = true;
    else delete state.seleccion[id];
    render();
  }

  function seleccionados() {
    return state.contactos.filter(function (c) { return !!state.seleccion[c.legacy_id]; });
  }

  /* ----------------------------------------------------------------- events */

  document.addEventListener("click", function (ev) {
    var boton = ev.target.closest("[data-accion]");
    if (!boton) return;

    var accion = boton.getAttribute("data-accion");
    var id = parseInt(boton.getAttribute("data-id"), 10);

    if (accion === "elegir") { alternar(id); return; }
    if (accion === "whatsapp") { abrirWa(id); return; }
    if (accion === "correo") { abrirMail(id); return; }
    if (accion === "enviar") { enviarCorreo([id]); return; }
    if (accion === "desmarcar") { borrarManual(id); return; }
    if (accion === "abrir-wa") { abrirWa(id); cerrarModal(); return; }
    if (accion === "abrir-mail") { abrirMail(id); cerrarModal(); return; }
    if (accion === "copiar") { copiarTexto(id); return; }

    if (accion === "enviar-seleccionados") {
      // Sin selección no hay envío. Nunca "todos los visibles": el envío en
      // masa es siempre lo que el usuario marcó uno por uno.
      var ids = seleccionados().map(function (c) { return c.legacy_id; });
      if (!ids.length) { alert("Selecciona al menos un contacto."); return; }
      enviarCorreo(ids);
      return;
    }
  });

  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    entrar($("passcodeInput").value.trim());
  });

  $("logoutBtn").addEventListener("click", salir);
  $("modalClose").addEventListener("click", cerrarModal);
  $("csvBtn").addEventListener("click", descargarCsv);

  $("modalBg").addEventListener("click", function (ev) {
    if (ev.target === $("modalBg")) cerrarModal();
  });

  $("searchInput").addEventListener("input", function (ev) {
    state.busqueda = ev.target.value.trim().toLowerCase();
    render();
  });

  $("selectAll").addEventListener("change", function (ev) {
    var marcar = ev.target.checked;
    visibles().forEach(function (c) { alternar(c.legacy_id, marcar); });
  });

  $("chips").addEventListener("click", function (ev) {
    var chip = ev.target.closest(".chip");
    if (!chip) return;
    Array.prototype.forEach.call($("chips").children, function (c) {
      c.classList.remove("active");
    });
    chip.classList.add("active");
    state.filtro = chip.getAttribute("data-filtro");
    render();
  });

  $("nextBtn").addEventListener("click", function () {
    var pendientes = visibles().filter(function (c) {
      return situacion(c) === "pendiente" && c.wa_digits;
    });
    if (!pendientes.length) {
      alert("No quedan contactos pendientes con teléfono en este filtro.");
      return;
    }
    abrirModal(pendientes[0].legacy_id);
  });

  /* ------------------------------------------------------------------- boot */

  leerManual();
  var token = cargar(CFG.storage.token, null);
  var expira = cargar(CFG.storage.tokenExpires, null);

  if (token && (!expira || new Date(expira) > new Date())) {
    state.token = token;
    rpc(CFG.rpc.ping, { p_token: token })
      .then(cargarLista)
      .catch(function () {
        store(CFG.storage.token, null);
        store(CFG.storage.tokenExpires, null);
        mostrarLogin();
      });
  } else {
    mostrarLogin();
  }
})();