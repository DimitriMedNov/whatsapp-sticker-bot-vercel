import { adminError, jsonResponse, readAdminConfig, removePrivatePhone, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access) return jsonResponse({ ok: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
  try {
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page") || 1));
    const data = await access.repository.getBatches({ page, pageSize: 25 });
    return jsonResponse({ ok: true, data: removePrivatePhone(data) });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_batches_error", code: error?.code || "SUPABASE_ERROR" }));
    return adminError("SUPABASE_ERROR");
  }
} };
