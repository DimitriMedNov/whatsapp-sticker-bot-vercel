import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSession, verifySession, safeSecretCompare, createUserActionToken, readUserActionToken, sessionCookie } from "../lib/admin-auth.mjs";
import { createAdminRepository, removePrivatePhone } from "../lib/admin-api.mjs";
import login from "../api/admin/login.mjs";
import session from "../api/admin/session.mjs";
import metrics from "../api/admin/metrics.mjs";
import userStatus from "../api/admin/user-status.mjs";
import webhook from "../api/webhook.mjs";

const secret = "test-admin-session-secret";
const password = "test-admin-password";
const now = Date.now();

// Supabase de mentira: la sesión nunca está revocada y cualquier otra RPC falla,
// para que la suite corra sin red y sin credenciales reales.
let supabaseUrl = "https://example.supabase.co";
let sessionCheckFails = false;
// RPC que deben responder algo concreto; el resto falla con 500 a propósito,
// que es lo que varios tests necesitan para comprobar el manejo de errores.
const rpcResponses = new Map();
const supabase = createServer((incoming, response) => {
  incoming.resume();
  const name = incoming.url.split("/rpc/")[1] || "";
  const checkingSession = name === "admin_is_session_revoked" && !sessionCheckFails;
  const canned = rpcResponses.get(name);

  if (checkingSession || canned !== undefined) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(checkingSession ? false : canned));
    return;
  }
  response.writeHead(500, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ message: "supabase no disponible" }));
});

before(async () => {
  await new Promise((resolve) => supabase.listen(0, "127.0.0.1", resolve));
  supabaseUrl = `http://127.0.0.1:${supabase.address().port}`;
});
after(() => new Promise((resolve) => supabase.close(resolve)));

function request(url, options = {}) { return new Request(`https://example.test${url}`, options); }
function withEnv(fn) {
  const old = { ...process.env };
  process.env.ADMIN_DASHBOARD_PASSWORD = password;
  process.env.ADMIN_SESSION_SECRET = secret;
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SECRET_KEY = "server-only-test-key";
  return Promise.resolve(fn()).finally(() => { for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key]; Object.assign(process.env, old); });
}

test("login válido crea cookie de sesión segura", async () => withEnv(async () => {
  const response = await login.fetch(request("/api/admin/login", { method: "POST", body: JSON.stringify({ password }), headers: { "Content-Type": "application/json" } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.match(response.headers.get("set-cookie"), /Secure/);
  assert.match(response.headers.get("set-cookie"), /SameSite=Strict/);
}));

test("login inválido no crea sesión", async () => withEnv(async () => {
  const response = await login.fetch(request("/api/admin/login", { method: "POST", body: JSON.stringify({ password: "wrong" }) }));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("set-cookie"), null);
}));

test("sesión válida, expirada y firma alterada", () => {
  const value = createSession(secret, now);
  assert.equal(verifySession(value, secret, now), true);
  assert.equal(verifySession(value, secret, now + 8 * 60 * 60 * 1000 + 1), false);
  assert.equal(verifySession(`${value}x`, secret, now), false);
});

test("comparación de contraseña exige longitud y valor exactos", () => {
  assert.equal(safeSecretCompare(password, password), true);
  assert.equal(safeSecretCompare(password, "test-admin-password-x"), false);
});

test("ruta administrativa sin autenticación responde 401", async () => withEnv(async () => {
  const response = await metrics.fetch(request("/api/admin/metrics"));
  assert.equal(response.status, 401);
}));

test("sesión válida responde autenticado", async () => withEnv(async () => {
  const cookie = sessionCookie(createSession(secret)).split(";")[0];
  const response = await session.fetch(request("/api/admin/session", { headers: { cookie } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, authenticated: true });
}));

test("identificador de usuario es opaco y expira", () => {
  const token = createUserActionToken("525512345678", secret, now);
  assert.equal(readUserActionToken(token, secret, now), "525512345678");
  assert.equal(readUserActionToken(token, secret, now + 25 * 60 * 60 * 1000), null);
  assert.equal(token.includes("525512345678"), false);
});

test("las respuestas públicas no contienen teléfonos completos", () => {
  const safe = removePrivatePhone({ phone: "********5678", phone_value: "525512345678", nested: { phone_value: "525512345678" } });
  assert.equal(JSON.stringify(safe).includes("525512345678"), false);
  assert.equal(safe.phone, "********5678");
});

test("métricas vacías y con datos pasan por el repositorio backend", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: name === "admin_dashboard_metrics" ? { cards: {}, daily: [], activity: [] } : { users: [], total: 0 }, error: null }; } };
  const repo = createAdminRepository({ supabaseUrl: "https://example.test", supabaseSecretKey: "secret" }, client);
  assert.deepEqual(await repo.getMetrics(), { cards: {}, daily: [], activity: [] });
  assert.equal(calls[0].name, "admin_dashboard_metrics");
  assert.equal(calls[0].args.p_period, "24h");
  assert.deepEqual(await repo.getUsers({ search: "0366" }), { users: [], total: 0 });
  assert.equal(calls[1].args.p_phone_suffix, "0366");
});

test("el repositorio administrativo bloquea y desbloquea sin exponer el teléfono", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { data: true, error: null }; } };
  const repo = createAdminRepository({ supabaseUrl: "https://example.test", supabaseSecretKey: "secret" }, client);
  await repo.updateUserStatus("525512345678", true);
  await repo.updateUserStatus("525512345678", false);
  assert.deepEqual(calls.map((call) => call.args.p_blocked), [true, false]);
  assert.equal(JSON.stringify(calls).includes("525512345678"), true);
});

test("error de Supabase se propaga sin detalles al endpoint", async () => withEnv(async () => {
  const response = await metrics.fetch(request("/api/admin/metrics", { headers: { cookie: `${sessionCookie(createSession(secret)).split(";")[0]}` } }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { ok: false, error: "No se pudieron cargar las métricas. Intenta nuevamente.", code: "SUPABASE_ERROR" });
}));

test("bloquear y desbloquear usan booleano y payload inválido se rechaza", async () => withEnv(async () => {
  const token = createUserActionToken("525512345678", secret);
  const cookie = sessionCookie(createSession(secret)).split(";")[0];
  const invalid = await userStatus.fetch(request("/api/admin/users/x/status", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ action_id: token, blocked: "yes" }) }));
  assert.equal(invalid.status, 400);
  const valid = await userStatus.fetch(request("/api/admin/users/x/status", { method: "PATCH", headers: { cookie }, body: JSON.stringify({ action_id: token, blocked: true }) }));
  assert.equal(valid.status, 500);
}));

test("si falla la comprobación de sesión responde 503 controlado", async () => withEnv(async () => {
  sessionCheckFails = true;
  try {
    const cookie = sessionCookie(createSession(secret)).split(";")[0];
    const response = await session.fetch(request("/api/admin/session", { headers: { cookie } }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "SUPABASE_ERROR");
  } finally {
    sessionCheckFails = false;
  }
}));

test("el límite de intentos compartido bloquea el login con 429", async () => withEnv(async () => {
  rpcResponses.set("admin_login_guard", { limited: true, failures: 5, retry_after_seconds: 640 });
  try {
    const response = await login.fetch(request("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }));
    assert.equal(response.status, 429);
    assert.equal((await response.json()).code, "RATE_LIMITED");
    assert.equal(response.headers.get("retry-after"), "640");
  } finally {
    rpcResponses.delete("admin_login_guard");
  }
}));

test("si el límite compartido no responde, el login sigue funcionando", async () => withEnv(async () => {
  const response = await login.fetch(request("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
}));

test("el webhook público sigue respondiendo y no exige sesión administrativa", async () => {
  const response = await webhook.fetch(request("/webhook", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});
