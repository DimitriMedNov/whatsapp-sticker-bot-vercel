import { addActionTokens, adminError, jsonResponse, readAdminConfig, removePrivatePhone, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access) return jsonResponse({ ok: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const page = Math.max(1, Number(url.searchParams.get("page") || 1));
      const data = await access.repository.getUsers({ page, pageSize: 25, search: (url.searchParams.get("search") || "").replace(/\D/g, "").slice(-4) });
      return jsonResponse({ ok: true, data: removePrivatePhone({ ...data, users: addActionTokens(data.users, config.sessionSecret) }) });
    }
    return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405);
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_users_error", code: error?.code || "SUPABASE_ERROR" }));
    return adminError("SUPABASE_ERROR");
  }
} };
