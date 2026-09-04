import { expiredSessionCookie, getAdminSession } from "../../lib/admin-auth.mjs";
import { jsonResponse, readAdminConfig, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access.ok) return access.response;
  await access.repository.revokeSession(access.session);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": expiredSessionCookie() });
} };
