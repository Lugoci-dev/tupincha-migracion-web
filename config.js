// =============================================================================
// Configuración del sitio de campaña.
// TODO lo que hay aquí es PÚBLICO por diseño: la URL del proyecto y la
// "publishable key" de Supabase viajan dentro de la app móvil y de cualquier
// cliente web. Lo único que protege los datos es el PASSCODE, que no está en
// este repositorio: se cambia por un token de sesión contra las RPC.
// =============================================================================

window.TUPINCHA_WEB = {
  supabaseUrl: "https://bexwnqesbmsfazpabshm.supabase.co",
  supabaseAnonKey: "sb_publishable_TyRR2ceFgxTR67s7N2folg_S3sIGtWu",

  rpc: {
    login: "web_migration_login",
    ping: "web_migration_ping",
    list: "web_migration_list",
    message: "web_migration_message",
    logout: "web_migration_logout",
  },

  // Clave del token y del estado local
  storage: {
    token: "tupincha.campaign.token",
    tokenExpires: "tupincha.campaign.tokenExpires",
    estado: "tupincha.campaign.estado",
  },
};