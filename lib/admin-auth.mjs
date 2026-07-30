import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_SESSION_MAX_AGE = 8 * 60 * 60;
const ACTION_TTL_SECONDS = 24 * 60 * 60;

function keyFromSecret(secret, label) {
  return createHash("sha256").update(`${label}:${secret}`).digest();
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function decode(value) {
  return Buffer.from(value, "base64url");
}

export function safeSecretCompare(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ""));
  const expectedBuffer = Buffer.from(String(expected ?? ""));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createSession(secret, now = Date.now()) {
  const expiresAt = Math.floor(now / 1000) + ADMIN_SESSION_MAX_AGE;
  const body = `admin.${expiresAt}.${randomBytes(16).toString("hex")}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${encode(body)}.${signature}`;
}

export function verifySession(value, secret, now = Date.now()) {
  if (!value || !secret) return false;
  const [encodedBody, signature] = String(value).split(".");
  if (!encodedBody || !signature) return false;

  const body = decode(encodedBody).toString("utf8");
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const validSignature = signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  const parts = body.split(".");
  const expiresAt = Number(parts[1]);
  return validSignature && parts[0] === "admin" && Number.isSafeInteger(expiresAt) && expiresAt > Math.floor(now / 1000);
}

export function sessionHash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function parseCookies(cookieHeader = "") {
  return Object.fromEntries(String(cookieHeader).split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return ["", ""];
    const key = part.slice(0, index).trim();
    try {
      return [key, decodeURIComponent(part.slice(index + 1).trim())];
    } catch {
      return [key, ""];
    }
  }).filter(([key]) => key));
}

export function isAdminRequest(request, secret) {
  return verifySession(parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE], secret);
}

export function getAdminSession(request, secret) {
  const cookie = parseCookies(request.headers.get("cookie"))[ADMIN_COOKIE];
  return cookie && verifySession(cookie, secret) ? cookie : null;
}

export function sessionCookie(value) {
  return `${ADMIN_COOKIE}=${encodeURIComponent(value)}; Max-Age=${ADMIN_SESSION_MAX_AGE}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function expiredSessionCookie() {
  return `${ADMIN_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function createUserActionToken(phone, secret, now = Date.now()) {
  const key = keyFromSecret(secret, "admin-user-action");
  const iv = randomBytes(12);
  const expiresAt = Math.floor(now / 1000) + ACTION_TTL_SECONDS;
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(`${expiresAt}.${phone}`, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function readUserActionToken(token, secret, now = Date.now()) {
  try {
    const [ivValue, tagValue, ciphertextValue] = String(token).split(".");
    const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret, "admin-user-action"), decode(ivValue));
    decipher.setAuthTag(decode(tagValue));
    const [expiresAt, phone] = Buffer.concat([decipher.update(decode(ciphertextValue)), decipher.final()]).toString("utf8").split(".");
    if (!phone || Number(expiresAt) < Math.floor(now / 1000)) return null;
    return phone;
  } catch {
    return null;
  }
}
