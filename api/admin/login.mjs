import { createSession, safeSecretCompare, sessionCookie } from "../../lib/admin-auth.mjs";
import { jsonResponse, readAdminConfig } from "../../lib/admin-api.mjs";

const failedAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function clientKey(request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function isRateLimited(key, now = Date.now()) {
  const record = failedAttempts.get(key);
  if (!record || record.resetAt <= now) { failedAttempts.delete(key); return false; }
  return record.count >= MAX_FAILURES;
}

export default { async fetch(request) {
  if (request.method !== "POST") return jsonResponse({ ok: false, error: "Método no permitido", code: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" });
  const key = clientKey(request);
  if (isRateLimited(key)) return jsonResponse({ ok: false, error: "Demasiados intentos. Intenta nuevamente más tarde.", code: "RATE_LIMITED" }, 429, { "Retry-After": "900" });
  const config = readAdminConfig();
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: "Solicitud inválida", code: "INVALID_JSON" }, 400); }
  if (!config.password || !config.sessionSecret || !safeSecretCompare(body?.password, config.password)) {
    const current = failedAttempts.get(key);
    failedAttempts.set(key, { count: (current?.count || 0) + 1, resetAt: current?.resetAt || Date.now() + WINDOW_MS });
    console.warn(JSON.stringify({ event: "admin_login_failed", code: "INVALID_CREDENTIALS" }));
    return jsonResponse({ ok: false, error: "Credenciales inválidas", code: "INVALID_CREDENTIALS" }, 401);
  }
  failedAttempts.delete(key);
  console.log(JSON.stringify({ event: "admin_login_success" }));
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookie(createSession(config.sessionSecret)) });
} };
