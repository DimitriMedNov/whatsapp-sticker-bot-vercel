export function readConfig(env = process.env) {
  return {
    webhookVerifyToken: env.WEBHOOK_VERIFY_TOKEN,
    whatsappToken: env.WHATSAPP_TOKEN,
    metaAppSecret: env.META_APP_SECRET,
    phoneNumberId: env.PHONE_NUMBER_ID,
    graphApiVersion: env.GRAPH_API_VERSION || "v25.0",
    supabaseUrl: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
  };
}

export function validateConfig(config) {
  const required = {
    WEBHOOK_VERIFY_TOKEN: config.webhookVerifyToken,
    WHATSAPP_TOKEN: config.whatsappToken,
    PHONE_NUMBER_ID: config.phoneNumberId,
    GRAPH_API_VERSION: config.graphApiVersion,
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SECRET_KEY: config.supabaseSecretKey,
  };

  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}
