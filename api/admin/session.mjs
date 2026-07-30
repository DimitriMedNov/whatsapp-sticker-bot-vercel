import { jsonResponse, readAdminConfig, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  return await requireAdmin(request, config)
    ? jsonResponse({ ok: true, authenticated: true })
    : jsonResponse({ ok: false, authenticated: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
} };
