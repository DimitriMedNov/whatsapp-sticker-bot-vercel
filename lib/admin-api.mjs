import { createClient } from "@supabase/supabase-js";
import { createUserActionToken, getAdminSession, sessionHash } from "./admin-auth.mjs";

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function adminError(code = "ADMIN_ERROR", status = 500) {
  return jsonResponse({ ok: false, error: "No se pudieron cargar las métricas. Intenta nuevamente.", code }, status);
}

export function readAdminConfig(env = process.env) {
  return {
    password: env.ADMIN_DASHBOARD_PASSWORD,
    sessionSecret: env.ADMIN_SESSION_SECRET,
    supabaseUrl: env.SUPABASE_URL,
    supabaseSecretKey: env.SUPABASE_SECRET_KEY,
    metaConfigured: Boolean(env.WHATSAPP_TOKEN && env.PHONE_NUMBER_ID),
    version: "1.0.0",
    runtime: {
      environment: env.VERCEL_ENV || env.NODE_ENV || "production",
      commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || "local",
      batchLimit: 10,
      batchWindowMinutes: 5,
      eventRetention: "Sin eliminación automática",
      revokedSessionRetention: "8 horas",
    },
  };
}

export function createAdminRepository(config, client = null) {
  const supabase = client || createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const rpc = async (name, args) => {
    const result = await supabase.rpc(name, args);
    if (result.error) throw result.error;
    return result.data;
  };

  return {
    async getMetrics(filters = {}) { return rpc("admin_dashboard_metrics", {
      p_status: filters.status || null,
      p_processing_type: filters.processingType || null,
      p_phone_suffix: filters.phoneSuffix || null,
      p_period: filters.period || "24h",
    }); },
    async getErrorGroups() { return rpc("admin_dashboard_error_groups", {}); },
    async getAlerts() { return rpc("admin_dashboard_alerts", {}); },
    async getActivityFeed() { return rpc("admin_dashboard_activity_feed", {}); },
    async getUsers({ page = 1, pageSize = 25, search = "" } = {}) {
      return rpc("admin_dashboard_users", { p_page: page, p_page_size: pageSize, p_phone_suffix: search || null });
    },
    async getBatches({ page = 1, pageSize = 25 } = {}) {
      return rpc("admin_dashboard_batches", { p_page: page, p_page_size: pageSize });
    },
    async updateUserStatus(phone, blocked) {
      return rpc("admin_set_user_blocked", { p_phone: phone, p_blocked: blocked });
    },
    async revokeSession(token) {
      return rpc("admin_revoke_session", { p_token_hash: sessionHash(token) });
    },
    async isSessionRevoked(token) {
      return rpc("admin_is_session_revoked", { p_token_hash: sessionHash(token) });
    },
    async health() {
      const result = await supabase.from("processing_events").select("id").limit(1);
      if (result.error) throw result.error;
      return true;
    },
  };
}

export async function requireAdmin(request, config, repository = createAdminRepository(config)) {
  const session = getAdminSession(request, config.sessionSecret);
  if (!session || await repository.isSessionRevoked(session)) return null;
  return { session, repository };
}

export function addActionTokens(users, secret) {
  return (users || []).map((user) => ({ ...user, action_id: createUserActionToken(user.phone_value, secret) }));
}

export function removePrivatePhone(data) {
  if (Array.isArray(data)) return data.map(removePrivatePhone);
  if (!data || typeof data !== "object") return data;
  const result = { ...data };
  delete result.phone_value;
  delete result.message_id;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, removePrivatePhone(value)]));
}
