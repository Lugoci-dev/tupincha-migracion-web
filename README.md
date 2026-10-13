# TuPincha · Campaña de proveedores

Sitio **temporal** de administración para dar acceso a los proveedores: los 114
migrados desde la plataforma anterior y los que se den de alta nuevos. Es
estático (GitHub Pages, sin build ni framework) y todo lo que sabe lo pide a
Supabase.

## Qué hace

| Sección | Para qué |
|---|---|
| **Contactos** | Lista de proveedores, a quién se le avisó y por qué vía, y quién ya activó su cuenta. Envío por WhatsApp (`wa.me`), por tu cliente de correo (`mailto:`) o por Resend, de uno en uno o por selección. |
| **Nuevo proveedor** | Alta manual con un formulario. |
| **Agente** | Pegas texto plano (un mensaje, una lista) y devuelve propuestas de proveedor para revisar. |

### Qué crea un alta

Lo mismo que el import de los migrados, en una sola transacción:

1. `auth.users` con el correo **sin confirmar** y una contraseña nueva `TP-XXXX-XXXX`.
2. `auth.identities`, para que pueda entrar con correo y contraseña.
3. `legacy_provider_staging` con su perfil y servicios, en `PENDING`.
4. La fila de campaña, con su aviso de WhatsApp y de correo ya escritos.

Cuando el proveedor entra en la app y confirma su correo, el trigger
`trg_legacy_materialize_provider` crea su perfil de proveedor, sus servicios y
su ubicación. Un alta sin servicios crea solo la cuenta y el perfil.

### Catálogo

Una subcategoría que no exista en `public.subcategories` no entra nunca:

- en el formulario se elige de un desplegable cargado con el catálogo vivo;
- la categoría no se acepta del cliente: se deduce de la subcategoría;
- lo que proponga el agente fuera del catálogo se descarta en el runner **y**
  otra vez en la base de datos, y la propuesta lo avisa.

### Estados

**Aviso** (por contacto, lo comparten todos los administradores):

| Estado | Significa |
|---|---|
| Correo enviado | Resend aceptó el correo. Es un hecho comprobado. |
| Avisado | Un administrador marcó que lo mandó por WhatsApp o por su correo. |
| Correo falló | Resend o la función fallaron. Se puede reintentar. |
| En cola / Sin respuesta | Se pidió el envío y aún no hay (o ya no hay) respuesta. |
| WhatsApp / Correo abierto | Se abrió el enlace. No prueba que el mensaje saliera. |
| Por avisar | Nadie hizo nada todavía. |

**Cuenta**: *activada* cuando el proveedor confirmó su correo.

**Análisis del agente**: en cola → analizando → listo (o falló, reintentable).
Cada propuesta queda pendiente, creada o descartada.

## Acceso

Se entra con el correo y la contraseña de un **administrador de TuPincha**
(Supabase Auth). Iniciar sesión no basta: cada RPC comprueba en el servidor que
el usuario está en `public.admins`.

## Este repositorio es público

Aquí no hay ningún dato de proveedores, ni contraseñas, ni claves privadas.

- `config.js` lleva la URL del proyecto y la *publishable key* de Supabase, que
  son públicas por diseño (también viajan dentro de la app móvil).
- Los **logs de GitHub Actions también son públicos**. Por eso al workflow del
  agente solo le llega un `job_id`; el texto pegado se lee de Supabase en tiempo
  de ejecución y `agent/run.py` no imprime ni el texto ni la salida del modelo.
- El runner no usa la *service role*. Su secreto, `CAMPAIGN_AGENT_KEY`, solo
  abre las dos RPC del agente, y lo que escribe son propuestas que un
  administrador revisa.
- El texto que se pega en **Agente** se envía a un modelo gratuito de un tercero
  (OpenCode Zen). No pegues nada que no deba salir de TuPincha.

## Backend

Vive en el repo de la app (`supabase/migrations/`):

| Migración | Qué trae |
|---|---|
| `20261013100000_web_campaign_admin.sql` | RPC `web_campaign_*`, alta de proveedores, agente |
| `20261013110000_web_campaign_drop_passcode.sql` | Borra el acceso antiguo por passcode. **Aplicar solo después de publicar esta versión del sitio.** |

RPC de administrador (rol `authenticated` + estar en `admins`):
`web_campaign_bootstrap`, `_list`, `_message`, `_mark`, `_send_email`,
`_email_preview`, `_email_sample`, `_provider_check`, `_provider_create`,
`_provider_delete`, `_agent_submit`, `_agent_jobs`, `_agent_update`.

RPC del runner (rol `anon` + `CAMPAIGN_AGENT_KEY`):
`web_campaign_agent_claim`, `web_campaign_agent_finish`.

## Agente

```
web  ──►  web_campaign_agent_submit      guarda el texto y dispara el workflow
               │  (pg_net → GitHub API, solo viaja el job_id)
               ▼
      .github/workflows/provider-agent.yml
               │  agent/run.py
               ├─ web_campaign_agent_claim    texto + catálogo vivo
               ├─ OpenCode (modelos free)     texto → JSON
               └─ web_campaign_agent_finish   la BD valida y guarda propuestas
               ▼
web  ──►  revisar → web_campaign_provider_create
```

Secretos:

| Dónde | Nombre | Para qué |
|---|---|---|
| GitHub Secrets y Supabase Vault | `CAMPAIGN_AGENT_KEY` | Clave del runner. El mismo valor en los dos sitios. |
| Supabase Vault | `CAMPAIGN_GH_TOKEN` | PAT *fine-grained* sobre **este repo** con permiso *Actions: Read and write*. Lo usa la base de datos para lanzar el workflow. |
| Variable de GitHub (opcional) | `AGENT_MODELS` | Modelos a probar primero, separados por comas. |

Para poner el token de despacho (SQL Editor de Supabase):

```sql
select vault.create_secret('github_pat_…', 'CAMPAIGN_GH_TOKEN');
```

Sin ese token los análisis se guardan igual, pero hay que lanzarlos a mano:
**Actions → provider-agent → Run workflow** (sin `job_id` procesa los que estén
en cola).

## Desarrollo

```bash
python3 -m http.server 8080     # abrir http://localhost:8080
```

No hay dependencias ni `npm install`. El código es JavaScript en módulos ES:

```
index.html · styles.css · config.js
js/app.js            arranque, sesión y pestañas
js/api.js            login de Supabase Auth y llamadas RPC
js/contacts.js       lista, estados y envíos
js/provider-form.js  alta manual y revisión de propuestas
js/agent.js          análisis y propuestas
js/ui.js · js/store.js
agent/run.py · agent/prompt.md      el runner del agente
```

## Apagar la campaña

1. Desactivar Pages (o borrar el repo) y quitar el secreto `CAMPAIGN_AGENT_KEY`.
2. Revocar el PAT de despacho en GitHub.
3. En Supabase, ejecutar `scripts/drop-web-migration.sql` del repo de la app.

Los proveedores dados de alta no se borran: son cuentas reales de la plataforma.
