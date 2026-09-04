import { readUserActionToken } from "../../lib/admin-auth.mjs";
import { adminError, jsonResponse, readAdminConfig, requireAdmin } from "../../lib/admin-api.mjs";

export default { async fetch(request) {
  const config = readAdminConfig();
  const access = await requireAdmin(request, config);
  if (!access.ok) return access.response;
  if (request.method !== "PATCH") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Solicitud inválida", code: "INVALID_JSON" }, 400); }
  const phone = readUserActionToken(body?.action_id, config.sessionSecret);
  if (!phone || typeof body?.blocked !== "boolean") return jsonResponse({ ok: false, error: "Solicitud inválida", code: "INVALID_PAYLOAD" }, 400);
  try {
    await access.repository.updateUserStatus(phone, body.blocked);
    console.log(JSON.stringify({ event: "admin_user_status_changed", blocked: body.blocked }));
    return jsonResponse({ ok: true, blocked: body.blocked });
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_user_status_error", code: error?.code || "SUPABASE_ERROR" }));
    return adminError("SUPABASE_ERROR");
  }
} };
