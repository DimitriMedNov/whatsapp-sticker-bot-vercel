import { jsonResponse, readAdminConfig, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access.ok) return access.response;
  return jsonResponse({ ok: true, authenticated: true });
} };
