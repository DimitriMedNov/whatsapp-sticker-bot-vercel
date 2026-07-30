import { jsonResponse, adminError, readAdminConfig, removePrivatePhone, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access) return jsonResponse({ ok: false, error: "No autenticado", code: "UNAUTHORIZED" }, 401);
  try {
    const url = new URL(request.url);
    const [data, errorGroups, alerts] = await Promise.all([
      access.repository.getMetrics({ status: url.searchParams.get("status"), processingType: url.searchParams.get("type"), phoneSuffix: url.searchParams.get("phone"), period: url.searchParams.get("period") }),
      access.repository.getErrorGroups(),
      access.repository.getAlerts(),
    ]);
    return jsonResponse({ ok: true, data: removePrivatePhone({ ...data, error_groups: errorGroups, alerts, system: { ...data.system, supabase_connected: true, meta_configured: config.metaConfigured, version: config.version, refreshed_at: new Date().toISOString() } }) });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_metrics_error", code: error?.code || "SUPABASE_ERROR" }));
    return adminError("SUPABASE_ERROR");
  }
} };
