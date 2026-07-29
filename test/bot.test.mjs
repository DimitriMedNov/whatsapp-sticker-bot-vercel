import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRecipient, maskPhone } from "../lib/phone.mjs";
import { parseCommand } from "../lib/commands.mjs";
import { handleBatchCommand } from "../lib/batches.mjs";
import { createProcessor, withProcessingTimeout } from "../lib/processor.mjs";

const phone = "525512345678";

function makeMeta({ mimeType = "image/jpeg", fileSize = 100, bytes = 100, sends = [] } = {}) {
  return {
    sends,
    stickerSends: [],
    async getImageInfo() { return { url: "https://example.invalid/media", mimeType, fileSize }; },
    async downloadImage() { return Buffer.alloc(bytes); },
    async uploadSticker() { return "sticker-id"; },
    async sendSticker(payload) { this.stickerSends.push(payload); },
    async sendText(payload) { sends.push(payload); },
  };
}

function makeStore({ claim = { allowed: true, event_id: 1 }, batch = null, batchAfter = batch } = {}) {
  const calls = { success: [], errors: [], claims: [] };
  return {
    calls,
    async touchUser() {},
    async expireOpenBatch() {},
    async getOpenBatch() { return batch; },
    async openBatch() { return batch; },
    async closeBatch() { return batch; },
    async getBatch() { return batchAfter; },
    async claimStickerRequest(args) { calls.claims.push(args); return claim; },
    async markProcessing() {},
    async markSuccess(...args) { calls.success.push(args); },
    async markError(...args) { calls.errors.push(args); },
  };
}

test("normaliza números mexicanos 521 a 52", () => {
  assert.equal(normalizeRecipient("5215512345678"), "525512345678");
});

test("no modifica teléfonos que no cumplen el formato mexicano", () => {
  assert.equal(normalizeRecipient("525512345678"), "525512345678");
  assert.equal(normalizeRecipient("521551234567"), "521551234567");
  assert.equal(normalizeRecipient(""), "");
});

test("reconoce lote, estado y fin ignorando mayúsculas y espacios", () => {
  assert.equal(parseCommand("  LOTE "), "lote");
  assert.equal(parseCommand("ESTADO"), "estado");
  assert.equal(parseCommand(" Fin "), "fin");
  assert.equal(parseCommand("hola"), null);
});

test("abre un lote y no abre un segundo lote", async () => {
  const messages = [];
  const batch = { id: "batch-1", max_items: 10, received_count: 0, processed_count: 0, failed_count: 0, expires_at: new Date(Date.now() + 300000).toISOString() };
  let activeBatch = null;
  const store = makeStore();
  store.getOpenBatch = async () => activeBatch;
  store.openBatch = async () => { activeBatch = batch; return batch; };
  await handleBatchCommand({ command: "lote", phone, store, sendText: (m) => messages.push(m), messageId: "m1" });
  assert.match(messages.at(-1).text, /Modo lote activado/);
  messages.length = 0;
  await handleBatchCommand({ command: "lote", phone, store, sendText: (m) => messages.push(m), messageId: "m2" });
  assert.match(messages.at(-1).text, /Ya tienes un lote activo/);
});

test("estado sin lote y estado con lote", async () => {
  const messages = [];
  const store = makeStore();
  await handleBatchCommand({ command: "estado", phone, store, sendText: (m) => messages.push(m), messageId: "m1" });
  assert.match(messages.at(-1).text, /No tienes un lote activo/);
  const batch = { id: "batch-1", max_items: 10, received_count: 2, processed_count: 1, failed_count: 1, expires_at: new Date(Date.now() + 300000).toISOString() };
  const activeStore = makeStore({ batch });
  await handleBatchCommand({ command: "estado", phone, store: activeStore, sendText: (m) => messages.push(m), messageId: "m2" });
  assert.match(messages.at(-1).text, /2 recibidas, 1 procesadas, 1 fallidas/);
});

test("fin cierra manualmente el lote y muestra el resumen", async () => {
  const messages = [];
  const batch = { id: "batch-1", max_items: 10, received_count: 3, processed_count: 2, failed_count: 1, expires_at: new Date(Date.now() + 300000).toISOString() };
  const store = makeStore({ batch });
  await handleBatchCommand({ command: "fin", phone, store, sendText: (m) => messages.push(m), messageId: "m1" });
  assert.match(messages.at(-1).text, /2 stickers creados, 1 errores/);
});

test("expira lote al consultar comandos", async () => {
  const messages = [];
  let expired = false;
  const store = makeStore();
  store.expireOpenBatch = async () => { expired = true; };
  await handleBatchCommand({ command: "estado", phone, store, sendText: (m) => messages.push(m), messageId: "m1" });
  assert.equal(expired, true);
});

test("rechaza MIME no permitido", async () => {
  const meta = makeMeta({ mimeType: "image/gif" });
  const store = makeStore();
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "mime-1", type: "image", image: { id: "media-1" } }, phone);
  assert.match(meta.sends.at(-1).text, /JPG, PNG o WebP/);
  assert.equal(store.calls.claims.length, 0);
});

test("rechaza imagen mayor de 5 MB según metadatos", async () => {
  const meta = makeMeta({ fileSize: 5 * 1024 * 1024 + 1 });
  const store = makeStore();
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "size-1", type: "image", image: { id: "media-1" } }, phone);
  assert.match(meta.sends.at(-1).text, /5 MB/);
  assert.equal(store.calls.claims.length, 0);
});

test("rechaza imagen mayor de 5 MB después de descargarla", async () => {
  const meta = makeMeta({ fileSize: null, bytes: 5 * 1024 * 1024 + 1 });
  const store = makeStore();
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "size-2", type: "image", image: { id: "media-1" } }, phone);
  assert.match(meta.sends.at(-1).text, /5 MB/);
});

for (const [reason, expected] of [["BLOCKED", "bloqueado"], ["FILE_TOO_LARGE", "5 MB"], ["HOURLY_LIMIT", "10 stickers por hora"]]) {
  test(`responde rechazo de uso: ${reason}`, async () => {
    const meta = makeMeta();
    const store = makeStore({ claim: { allowed: false, reason } });
    await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: `reject-${reason}`, type: "image", image: { id: "media-1" } }, phone);
    assert.match(meta.sends.at(-1).text, new RegExp(expected));
  });
}

test("ignora mensaje duplicado sin segunda respuesta", async () => {
  const meta = makeMeta();
  const store = makeStore({ claim: { allowed: false, reason: "DUPLICATE" } });
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "duplicate-1", type: "image", image: { id: "media-1" } }, phone);
  assert.equal(meta.sends.length, 0);
});

test("registra success para una imagen normal", async () => {
  const meta = makeMeta();
  const store = makeStore();
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "success-1", type: "image", image: { id: "media-1" } }, phone);
  assert.equal(store.calls.success.length, 1);
  assert.equal(meta.stickerSends.length, 1);
});

test("registra error y notifica fallo técnico", async () => {
  const meta = makeMeta();
  const store = makeStore();
  const error = new Error("fallo de sharp");
  error.code = "SHARP_ERROR";
  await createProcessor({ store, meta, createSticker: async () => { throw error; } }).processMessage({ id: "error-1", type: "image", image: { id: "media-1" } }, phone);
  assert.equal(store.calls.errors.length, 1);
  assert.match(meta.sends.at(-1).text, /temporalmente ocupado/);
});

test("procesa imágenes de lote y envía cierre automático al llegar a diez", async () => {
  const meta = makeMeta();
  const batch = { id: "batch-1", max_items: 10, received_count: 10, processed_count: 10, failed_count: 0, status: "closed" };
  const store = makeStore({ batch });
  await createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") }).processMessage({ id: "batch-10", type: "image", image: { id: "media-1" } }, phone);
  assert.match(meta.sends.at(-1).text, /Lote completado/);
  assert.equal(store.calls.claims[0].processingType, "batch_sticker");
});

test("envía el resumen automático sólo cuando termina el último procesamiento", async () => {
  const meta = makeMeta();
  const batch = { id: "batch-1", max_items: 2, received_count: 2, processed_count: 1, failed_count: 0, status: "closed" };
  const store = makeStore({ batch });
  const processor = createProcessor({ store, meta, createSticker: async () => Buffer.from("sticker") });
  await processor.processMessage({ id: "batch-first", type: "image", image: { id: "media-1" } }, phone);
  assert.equal(meta.sends.filter(({ text }) => text.startsWith("Lote completado")).length, 0);
  batch.processed_count = 2;
  await processor.processMessage({ id: "batch-last", type: "image", image: { id: "media-2" } }, phone);
  await processor.processMessage({ id: "batch-extra", type: "image", image: { id: "media-3" } }, phone);
  assert.equal(meta.sends.filter(({ text }) => text.startsWith("Lote completado")).length, 1);
});

test("aplica timeout global y registra PROCESSING_TIMEOUT", async () => {
  await assert.rejects(withProcessingTimeout(() => new Promise(() => {}), 5), (error) => error.code === "PROCESSING_TIMEOUT");
});

test("enmascara teléfonos dejando visibles sólo cuatro dígitos", () => {
  assert.equal(maskPhone("525512345678"), "***5678");
  assert.equal(maskPhone("123"), "****");
});
