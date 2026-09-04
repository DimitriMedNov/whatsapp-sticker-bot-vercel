import { createClient } from "@supabase/supabase-js";
import { safeSecretCompare } from "../../lib/admin-auth.mjs";
import { readConfig } from "../../lib/config.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/*
 * Vercel firma las invocaciones de cron con CRON_SECRET.
 * Sin ese encabezado la ruta queda cerrada al público.
 */
function isVercelCron(request, secret) {
  const header = String(request.headers.get("authorization") ?? "");
  return Boolean(secret) && safeSecretCompare(header, `Bearer ${secret}`);
}

export default { async fetch(request) {
  if (!isVercelCron(request, process.env.CRON_SECRET)) {
    return jsonResponse({ ok: false, error: "No autorizado", code: "UNAUTHORIZED" }, 401);
  }

  const config = readConfig();
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    return jsonResponse({ ok: false, error: "Supabase no está configurado.", code: "MISSING_SUPABASE_CONFIG" }, 500);
  }

  const supabase = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  /*
   * Una lectura real basta para reiniciar el contador de
   * inactividad que pausa los proyectos del plan gratuito.
   */
  const result = await supabase
    .from("bot_users")
    .select("phone", { head: true, count: "exact" });

  if (result.error) {
    console.error(JSON.stringify({ event: "keepalive_error", code: result.error.code || "SUPABASE_ERROR" }));
    return jsonResponse({ ok: false, error: "Supabase no está disponible.", code: "SUPABASE_ERROR" }, 503);
  }

  console.log(JSON.stringify({ event: "keepalive", users: result.count ?? 0 }));
  return jsonResponse({ ok: true, users: result.count ?? 0 });
} };
