/* =============================================================================
   TuPincha · Campaña de migración
   Lógica del sitio. Sin framework ni build: se publica tal cual en GitHub Pages.

   El estado de "quién ya recibió su mensaje" vive SOLO en el navegador
   (localStorage). No se envía nada al servidor: por eso cada persona que use
   la web lleva su propio progreso y puede descargarlo en CSV.
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
    /** { [legacy_id]: { canal: "whatsapp"|"correo", at: ISO } } */
    estado: {},
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

  /* ---------------------------------------------------------------- estado */

  function leerEstado() {
    try { state.estado = JSON.parse(cargar(CFG.storage.estado, "{}")) || {}; }
    catch (e) { state.estado = {}; }
  }

  function marcar(legacyId, canal) {
    state.estado[legacyId] = { canal: canal, at: new Date().toISOString() };
    store(CFG.storage.estado, JSON.stringify(state.estado));
    render();
  }

  function desmarcar(legacyId) {
    delete state.estado[legacyId];
    store(CFG.storage.estado, JSON.stringify(state.estado));
    render();
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
    ].join(" ").toLowerCase();
    return todo.indexOf(q) !== -1;
  }

  function pasaFiltro(c) {
    var est = state.estado[c.legacy_id];
    switch (state.filtro) {
      case "pendientes": return !est;
      case "whatsapp": return !!est && est.canal === "whatsapp";
      case "correo": return !!est && est.canal === "correo";
      case "sin-categoria": return !(c.category_slugs || []).length;
      default: return true;
    }
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

  function tarjeta(c) {
    var est = state.estado[c.legacy_id];
    var cont = c.contact || {};
    var detalles = [];
    if (cont.specialty) detalles.push("<b>Oficio:</b> " + esc(cont.specialty));
    if (cont.region_text || cont.address_text) {
      // municipality primero, provincia después (region_text = estado)
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
      '<article class="card' + (est ? " enviado" : "") + '">' +
        "<h3>" + esc(c.brand) + "</h3>" +
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
          "<span>✉️ <a href=\"mailto:" + esc(c.email) + '">' + esc(c.email) + "</a></span>" +
        "</div>" +
        (est
          ? '<div class="status-line">✓ Enviado por ' +
            (est.canal === "whatsapp" ? "WhatsApp" : "correo") +
            " · " + esc(fechaCorta(est.at)) +
            ' <button class="chip" data-accion="desmarcar" data-id="' + c.legacy_id +
            '" style="padding:2px 9px;font-size:11px">quitar</button></div>"'
          : "") +
        '<div class="actions">' + acciones + "</div>" +
      "</article>"
    );
  }

  function render() {
    var visibles = state.contactos.filter(function (c) {
      return pasaFiltro(c) && coincideBusqueda(c);
    });

    var enviados = state.contactos.filter(function (c) { return !!state.estado[c.legacy_id]; }).length;
    var total = state.contactos.length;
    var pct = total ? Math.round((enviados / total) * 100) : 0;

    $("counterBadge").textContent = enviados + " / " + total;
    $("progressBar").style.width = pct + "%";
    $("progressText").textContent =
      enviados + " de " + total + " contactados (" + pct + "%) · " +
      "te faltan " + (total - enviados);

    $("grid").innerHTML = visibles.map(tarjeta).join("");
    $("emptyMsg").hidden = visibles.length > 0;
  }

  /* ----------------------------------------------------------------- modal */

  var modalActual = null;

  function cerrarModal() {
    $("modalBg").hidden = true;
    modalActual = null;
  }

  function abrirModal(legacyId) {
    var c = state.contactos.filter(function (x) { return x.legacy_id === legacyId; })[0];
    if (!c) return;

    modalActual = c;
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

        var texto =
          credenciales +
          '<div class="msg">' + esc(m.wa_message) + "</div>" +
          '<p class="hint">Este texto es el que se envía por WhatsApp. ' +
          "El correo lleva su propio asunto y cuerpo, con el mismo contenido.</p>";

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

  function abrirWa(legacyId) {
    mensajeDe(legacyId).then(function (m) {
      var url = "https://wa.me/" + m.wa_digits + "?text=" + encodeURIComponent(m.wa_message);
      window.open(url, "_blank", "noopener");
      marcar(legacyId, "whatsapp");
    }).catch(function (err) { alert("No se pudo abrir WhatsApp: " + err.message); });
  }

  function abrirMail(legacyId) {
    mensajeDe(legacyId).then(function (m) {
      var url = "mailto:" + m.email +
        "?subject=" + encodeURIComponent(m.email_subject) +
        "&body=" + encodeURIComponent(m.email_body);
      window.location.href = url;
      marcar(legacyId, "correo");
    }).catch(function (err) { alert("No se pudo abrir el correo: " + err.message); });
  }

  /**
   * Envío real por correo: la RPC encola la llamada a la Edge Function, que
   * la manda por Resend. Devuelve "queued" (es asíncrono), así que el estado
   * real se consulta luego con web_migration_email_log.
   *
   * `legacyIds` con más de un contacto pasa SIEMPRE por la prueba previa:
   * validación en Supabase + muestra del correo + escribir el número a mano.
   */
  function enviarCorreo(legacyIds, opciones) {
    opciones = opciones || {};
    if (!state.token) { alert("La sesión caducó. Vuelve a entrar."); return; }

    var varios = legacyIds && legacyIds.length > 1;
    if (varios && !opciones.confirmado) {
      abrirConfirmacion(legacyIds);
      return;
    }

    var boton = document.querySelector('[data-accion="enviar-visibles"]');
    if (boton) { boton.disabled = true; boton.textContent = "Enviando…"; }

    return rpc(CFG.rpc.sendEmail, {
      p_params: { p_token: state.token, p_legacy_ids: legacyIds, p_dry_run: false },
    })
      .then(function (res) {
        (legacyIds || []).forEach(function (id) { marcar(id, "correo-enviado"); });
        cerrarModal();
        alert(
          "Encolados: " + res.queued + " correo(s).\n\n" +
          "Resend los manda en segundo plano. El estado real de cada uno está en\n" +
          "web_migration_email_log."
        );
      })
      .catch(function (err) {
        alert("No se pudo encolar el envío: " + err.message);
      })
      .finally(function () {
        if (boton) { boton.disabled = false; boton.textContent = "Enviar los visibles"; }
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
   * Function) y muestra el HTML real del primer contacto, Composite lo pide
   * con p_dry_run. Nada sale hasta que escribas el número de destinatarios.
   */
  function abrirConfirmacion(legacyIds) {
    modalActual = null;
    $("modalTitle").textContent = "Enviar correos";
    $("modalBody").innerHTML = '<p class="hint">Comprobando los ' + legacyIds.length + " contactos…</p>";
    $("modalFooter").innerHTML = "";
    $("modalBg").hidden = false;

    rpc(CFG.rpc.preview, { p_params: { p_token: state.token, p_legacy_ids: legacyIds } })
      .then(function (r) {
        var faltan = r.faltan || [];
        var muestra = r.muestra;

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
          '<p class="hint">Así va a verse el correo (muestra de <b>' +
          esc(muestra ? muestra.brand : "") + "</b>, no se envía nada todavía):</p>" +
          '<iframe class="preview" id="mailPreview" title="Muestra del correo"></iframe>';

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
          r.listos + " correo(s)</button>";

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
    var filas = [["legacy_id", "brand", "email", "telefono", "canal", "enviado_el", "estado"]];
    state.contactos.forEach(function (c) {
      var est = state.estado[c.legacy_id];
      filas.push([
        c.legacy_id, c.brand, c.email, c.phone || "",
        est ? est.canal : "", est ? est.at : "",
        est ? "enviado" : "pendiente",
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

  /* ----------------------------------------------------------------- events */

  document.addEventListener("click", function (ev) {
    var boton = ev.target.closest("[data-accion]");
    if (!boton) return;

    var accion = boton.getAttribute("data-accion");
    var id = parseInt(boton.getAttribute("data-id"), 10);

    if (accion === "whatsapp") { abrirWa(id); return; }
    if (accion === "correo") { abrirMail(id); return; }
    if (accion === "enviar") { enviarCorreo([id]); return; }
    if (accion === "enviar-visibles") {
      var ids = state.contactos
        .filter(function (c) { return pasaFiltro(c) && coincideBusqueda(c); })
        .map(function (c) { return c.legacy_id; });
      if (!ids.length) { alert("No hay contactos visibles con el filtro actual."); return; }
      enviarCorreo(ids);
      return;
    }
    if (accion === "desmarcar") { desmarcar(id); return; }
    if (accion === "abrir-wa") { abrirWa(id); cerrarModal(); return; }
    if (accion === "abrir-mail") { abrirMail(id); cerrarModal(); return; }
    if (accion === "copiar") { copiarTexto(id); return; }
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
    var pendientes = state.contactos.filter(function (c) {
      return !state.estado[c.legacy_id] && c.wa_digits;
    });
    if (!pendientes.length) {
      alert("No quedan contactos pendientes con teléfono.");
      return;
    }
    abrirModal(pendientes[0].legacy_id);
  });

  /* ------------------------------------------------------------------- boot */

  leerEstado();
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