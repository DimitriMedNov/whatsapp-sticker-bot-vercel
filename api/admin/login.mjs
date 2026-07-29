import { createSession, safeSecretCompare, sessionCookie } from "../../lib/admin-auth.mjs";
import { jsonResponse, readAdminConfig } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  const config = readAdminConfig();
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Solicitud inválida", code: "INVALID_JSON" }, 400); }
  if (!config.password || !config.sessionSecret || !safeSecretCompare(body?.password, config.password)) {
    console.warn(JSON.stringify({ event: "admin_login_failed", code: "INVALID_CREDENTIALS" }));
    return jsonResponse({ ok: false, error: "Credenciales inválidas", code: "INVALID_CREDENTIALS" }, 401);
  }
  console.log(JSON.stringify({ event: "admin_login_success" }));
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookie(createSession(config.sessionSecret)) });
} };
