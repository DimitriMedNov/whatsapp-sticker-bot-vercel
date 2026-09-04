import test from "node:test";
import assert from "node:assert/strict";
import { signPayload, verifyWebhookSignature } from "../lib/signature.mjs";

const appSecret = "test-meta-app-secret";
const body = JSON.stringify({ entry: [] });

process.env.WEBHOOK_VERIFY_TOKEN = "verify-token";
process.env.WHATSAPP_TOKEN = "whatsapp-token";
process.env.PHONE_NUMBER_ID = "1234567890";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SECRET_KEY = "server-only-test-key";
process.env.META_APP_SECRET = appSecret;

const { default: webhook } = await import("../api/webhook.mjs");

function post(rawBody, signature) {
  const headers = { "Content-Type": "application/json" };
  if (signature !== undefined) headers["X-Hub-Signature-256"] = signature;
  return webhook.fetch(new Request("https://example.test/webhook", { method: "POST", body: rawBody, headers }));
}

test("acepta un payload firmado correctamente", async () => {
  const response = await post(body, signPayload(body, appSecret));
  assert.equal(response.status, 200);
});

test("rechaza un payload con firma inválida", async () => {
  const response = await post(body, signPayload(body, "otro-secreto"));
  assert.equal(response.status, 403);
});

test("rechaza un payload sin cabecera de firma", async () => {
  assert.equal((await post(body)).status, 403);
  assert.equal((await post(body, "")).status, 403);
  assert.equal((await post(body, "sha1=abc")).status, 403);
});

test("rechaza el payload si el cuerpo cambia después de firmarse", async () => {
  const signature = signPayload(body, appSecret);
  const response = await post(JSON.stringify({ entry: [{ id: "inyectado" }] }), signature);
  assert.equal(response.status, 403);
});

test("verifyWebhookSignature distingue sin configurar, válida e inválida", () => {
  assert.equal(verifyWebhookSignature(body, signPayload(body, appSecret), appSecret), "VALID");
  assert.equal(verifyWebhookSignature(body, "sha256=00", appSecret), "INVALID");
  assert.equal(verifyWebhookSignature(body, undefined, ""), "UNCONFIGURED");
});
