import { getAdminSession } from "../../lib/admin-auth.mjs";
import { jsonResponse, readAdminConfig } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  return getAdminSession(request, config.sessionSecret)
    ? jsonResponse({ ok: true, authenticated: true })
    : jsonResponse({ ok: false, authenticated: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
} };
