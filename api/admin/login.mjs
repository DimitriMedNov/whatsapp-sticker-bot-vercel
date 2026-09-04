import { createSession, safeSecretCompare, sessionCookie } from "../../lib/admin-auth.mjs";
import { createAdminRepository, jsonResponse, readAdminConfig } from "../../lib/admin-api.mjs";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

/*
 * Respaldo en memoria. El contador que manda es el de Supabase, compartido por
 * todas las instancias; éste sólo cubre el caso de que la base no responda.
 */
const failedAttempts = new Map();

function clientKey(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isLocallyLimited(key, now = Date.now()) {
  const record = failedAttempts.get(key);
  if (!record || record.resetAt <= now) { failedAttempts.delete(key); return false; }
  return record.count >= MAX_FAILURES;
}

function recordLocalFailure(key) {
  const current = failedAttempts.get(key);
  failedAttempts.set(key, { count: (current?.count || 0) + 1, resetAt: current?.resetAt || Date.now() + WINDOW_MS });
}

function rateLimited(retryAfterSeconds = 900) {
  return jsonResponse(
    { ok: false, error: "Demasiados intentos. Intenta nuevamente más tarde.", code: "RATE_LIMITED" },
    429,
    { "Retry-After": String(Math.max(retryAfterSeconds, 1)) },
  );
}

export default { async fetch(request) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });

  const key = clientKey(request);
  if (isLocallyLimited(key)) return rateLimited();

  const config = readAdminConfig();
  const repository = config.supabaseUrl && config.supabaseSecretKey ? createAdminRepository(config) : null;

  if (repository) {
    try {
      const guard = await repository.loginGuard(key);
      if (guard?.limited) return rateLimited(guard.retry_after_seconds);
    } catch (error) {
      console.error(JSON.stringify({ event: "admin_login_guard_error", code: error?.code || "SUPABASE_ERROR" }));
    }
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Solicitud inválida", code: "INVALID_JSON" }, 400); }

  const valid = Boolean(config.password) && Boolean(config.sessionSecret) && safeSecretCompare(body?.password, config.password);

  if (repository) {
    try {
      await repository.recordLogin(key, valid);
    } catch (error) {
      console.error(JSON.stringify({ event: "admin_login_record_error", code: error?.code || "SUPABASE_ERROR" }));
    }
  }

  if (!valid) {
    recordLocalFailure(key);
    console.warn(JSON.stringify({ event: "admin_login_failed", code: "INVALID_CREDENTIALS" }));
    return jsonResponse({ ok: false, error: "Credenciales inválidas", code: "INVALID_CREDENTIALS" }, 401);
  }

  failedAttempts.delete(key);
  console.log(JSON.stringify({ event: "admin_login_success" }));
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookie(createSession(config.sessionSecret)) });
} };
