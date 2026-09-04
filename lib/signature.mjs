import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

export function signPayload(rawBody, appSecret) {
  return SIGNATURE_PREFIX + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return "UNCONFIGURED";

  const received = String(signatureHeader ?? "");
  if (!received.startsWith(SIGNATURE_PREFIX)) return "INVALID";

  const expected = Buffer.from(signPayload(rawBody, appSecret));
  const actual = Buffer.from(received);
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? "VALID" : "INVALID";
}

export { SIGNATURE_HEADER };
