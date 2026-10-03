# TuPincha · Sitio de campaña de migración

Sitio **temporal** para dar acceso a los proveedores migrados desde la plataforma
legacy. Es estático: se publica en GitHub Pages y no tiene build, ni framework,
ni backend propio.

## Qué hace

1. Pide un **código de campaña** (passcode).
2. Muestra la lista de contactos migrados: nombre, correo, teléfono, oficio,
   zona, y las **categorías y subcategorías** que se crearán al activar su cuenta.
3. Da dos vías de envío por contacto:
   - **WhatsApp** → abre `https://wa.me/<numero>?text=<mensaje>` con el texto ya escrito.
   - **Correo** → abre `mailto:` con asunto y cuerpo ya escritos.
4. Lleva el estado de a quién se le ya envió el mensaje.

## Qué NO hay aquí

- **Ni contraseñas, ni correos, ni teléfonos.** Este repositorio no contiene
  ningún dato de los proveedores.
- **Ni el passcode.** No está en el código, ni en el historial, ni en ninguna
  variable.
- Ni claves privadas de nada.

Lo único público es la URL del proyecto y la *publishable key* de Supabase, que
son públicos por diseño en cualquier cliente Supabase (también viajan dentro de
la app móvil). Lo que protege los datos es el passcode, que se valida en
`web_migration_login` y se cambia por un token de sesión con caducidad.

## De dónde salen los datos

De cinco RPC de Supabase (`web_migration_*`), que son **temporales también**:

| RPC | Para qué |
|---|---|
| `web_migration_login` | passcode → token de sesión (30 días) |
| `web_migration_ping` | ¿sigue vivo el token? |
| `web_migration_list` | lista de contactos **sin contraseñas** |
| `web_migration_message` | los textos de **un** contacto (aquí sí va la contraseña) |
| `web_migration_logout` | caduca el token |

Las etiquetas legibles de categoría/subcategoría se resuelven en la RPC contra
el catálogo vivo, así que si el catálogo cambia la web lo refleja sola.

La contraseña de un proveedor solo se pide al abrir su mensaje, justo antes de
enviarlo.

## Estado de envío

Se guarda **en el navegador** (`localStorage`), no en el servidor. Cada persona
que use la web lleva su propio progreso; el botón **Descargar progreso** saca un
CSV con el detalle.

## Desarrollo

```bash
python3 -m http.server 8080     # abrir http://localhost:8080
```

No hay dependencias ni `npm install`.

## Apagar la campaña

1. Borrar el repo de GitHub (o desactivar Pages).
2. En Supabase, ejecutar `scripts/drop-web-migration.sql` del repo de la app:
   elimina las tablas `web_migration_*`, sus RPC y la función de sesión.

Sin este segundo paso los RPC siguen vivos (pero sin passcode útil si también se
borra `web_migration_config`).