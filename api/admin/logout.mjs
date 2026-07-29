import { expiredSessionCookie, getAdminSession } from "../../lib/admin-auth.mjs";
import { jsonResponse, readAdminConfig } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  const config = readAdminConfig();
  if (!getAdminSession(request, config.sessionSecret)) return jsonResponse({ ok: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": expiredSessionCookie() });
} };
