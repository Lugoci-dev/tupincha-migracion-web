// =============================================================================
// Configuración del sitio de campaña.
// TODO lo que hay aquí es PÚBLICO por diseño: la URL del proyecto y la
// "publishable key" de Supabase viajan dentro de la app móvil y de cualquier
// cliente web. Lo que protege los datos es la SESIÓN DE ADMINISTRADOR: cada RPC
// comprueba en el servidor que quien llama está en public.admins.
// =============================================================================

window.TUPINCHA_WEB = {
  supabaseUrl: "https://bexwnqesbmsfazpabshm.supabase.co",
  supabaseAnonKey: "sb_publishable_TyRR2ceFgxTR67s7N2folg_S3sIGtWu",

  rpc: {
    bootstrap: "web_campaign_bootstrap",
    list: "web_campaign_list",
    message: "web_campaign_message",
    mark: "web_campaign_mark",
    sendEmail: "web_campaign_send_email",
    preview: "web_campaign_email_preview",
    sample: "web_campaign_email_sample",
    providerCheck: "web_campaign_provider_check",
    providerCreate: "web_campaign_provider_create",
    providerDelete: "web_campaign_provider_delete",
    agentSubmit: "web_campaign_agent_submit",
    agentJobs: "web_campaign_agent_jobs",
    agentUpdate: "web_campaign_agent_update",
  },

  storage: {
    session: "tupincha.campaign.session",
    filtro: "tupincha.campaign.filtro",
  },
};
