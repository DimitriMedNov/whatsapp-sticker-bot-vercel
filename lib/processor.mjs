import { BotError, PUBLIC_MESSAGES } from "./errors.mjs";
import { parseCommand } from "./commands.mjs";
import { isAllowedMimeType } from "./meta.mjs";
import { maskPhone } from "./phone.mjs";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const PROCESSING_TIMEOUT_MS = 45_000;

function logEvent(fields) {
  console.log(JSON.stringify(fields));
}

function errorCode(error) {
  return error?.code || (error?.name === "AbortError" ? "PROCESSING_TIMEOUT" : "PROCESSING_ERROR");
}

function safeErrorMessage(error) {
  return String(error?.message || "Error desconocido").slice(0, 300);
}

export function withProcessingTimeout(task, timeoutMs = PROCESSING_TIMEOUT_MS) {
  const controller = new AbortController();
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new BotError("PROCESSING_TIMEOUT", "El procesamiento excedió el tiempo límite.");
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([task(controller.signal), timeout]).finally(() => clearTimeout(timer));
}

async function sendSafely(meta, payload) {
  try {
    await meta.sendText(payload);
  } catch (error) {
    logEvent({ event: "notification_error", code: errorCode(error) });
  }
}

async function rejectClaim({ claim, phone, messageId, meta }) {
  if (claim.reason === "DUPLICATE") {
    logEvent({ event: "duplicate_ignored", message_id: messageId, phone: maskPhone(phone) });
    return;
  }

  const messages = {
    BLOCKED: PUBLIC_MESSAGES.BLOCKED,
    FILE_TOO_LARGE: PUBLIC_MESSAGES.TOO_LARGE,
    HOURLY_LIMIT: PUBLIC_MESSAGES.HOURLY_LIMIT,
    BATCH_LIMIT: PUBLIC_MESSAGES.BATCH_LIMIT,
  };
  await sendSafely(meta, {
    recipient: phone,
    originalMessageId: messageId,
    text: messages[claim.reason] || PUBLIC_MESSAGES.TEMPORARY,
  });
}

export function createProcessor({ store, meta, createSticker, now = () => Date.now() }) {
  const summarizedBatchIds = new Set();

  async function sendBatchCompletionIfReady(batch, phone) {
    if (
      !batch ||
      batch.status !== "closed" ||
      batch.received_count < batch.max_items ||
      batch.processed_count + batch.failed_count < batch.received_count ||
      summarizedBatchIds.has(batch.id)
    ) {
      return;
    }

    summarizedBatchIds.add(batch.id);
    await sendSafely(meta, {
      recipient: phone,
      text: `Lote completado: ${batch.processed_count} stickers creados, ${batch.failed_count} errores.`,
    });
  }

  async function processImage(message, phone, batch) {
    const messageId = message.id;
    const startedAt = now();
    let eventId;
    let processingType = batch ? "batch_sticker" : "sticker";

    try {
      const imageInfo = await withProcessingTimeout(
        (signal) => meta.getImageInfo(message.image.id, signal),
      );

      if (!isAllowedMimeType(imageInfo.mimeType)) {
        await sendSafely(meta, {
          recipient: phone,
          originalMessageId: messageId,
          text: PUBLIC_MESSAGES.INVALID_FORMAT,
        });
        return;
      }

      let inputBytes = imageInfo.fileSize;
      if (inputBytes !== null && inputBytes > MAX_INPUT_BYTES) {
        await sendSafely(meta, {
          recipient: phone,
          originalMessageId: messageId,
          text: PUBLIC_MESSAGES.TOO_LARGE,
        });
        return;
      }

      /*
       * Reclamamos antes de descargar: si el usuario está bloqueado, pasado de
       * cuota o el mensaje es un reintento de Meta, no gastamos el ancho de
       * banda de bajarse hasta 5 MB para tirarlos a la basura.
       */
      const claim = await store.claimStickerRequest({
        phone,
        messageId,
        inputBytes,
        processingType,
        batchId: batch?.id,
      });

      if (!claim.allowed) {
        await rejectClaim({ claim, phone, messageId, meta });
        return;
      }

      eventId = claim.event_id;
      await store.markProcessing(eventId);

      const inputBuffer = await withProcessingTimeout(
        (signal) => meta.downloadImage(imageInfo, signal),
      );
      inputBytes = inputBuffer.length;
      if (inputBytes > MAX_INPUT_BYTES) {
        throw new BotError("FILE_TOO_LARGE", "La imagen supera el límite de 5 MB.", {
          publicMessage: PUBLIC_MESSAGES.TOO_LARGE,
        });
      }

      const stickerBuffer = await withProcessingTimeout(
        async () => createSticker(inputBuffer),
      );
      const stickerId = await withProcessingTimeout(
        (signal) => meta.uploadSticker(stickerBuffer, signal),
      );
      await withProcessingTimeout(
        (signal) => meta.sendSticker({
          recipient: phone,
          stickerId,
          originalMessageId: messageId,
        }, signal),
      );

      const durationMs = now() - startedAt;
      await store.markSuccess(eventId, stickerBuffer.length, durationMs);
      logEvent({
        event: "sticker_processed",
        message_id: messageId,
        phone: maskPhone(phone),
        processing_type: processingType,
        status: "success",
        duration_ms: durationMs,
        input_bytes: inputBytes,
        output_bytes: stickerBuffer.length,
      });

      if (batch) {
        const updatedBatch = await store.getBatch(batch.id);
        await sendBatchCompletionIfReady(updatedBatch, phone);
      }
    } catch (error) {
      const code = errorCode(error);
      const durationMs = now() - startedAt;
      if (eventId) {
        try {
          await store.markError(eventId, code, safeErrorMessage(error), durationMs);
        } catch (storeError) {
          logEvent({ event: "supabase_error", code: errorCode(storeError) });
        }
      }

      logEvent({
        event: "sticker_processed",
        message_id: messageId,
        phone: maskPhone(phone),
        processing_type: processingType,
        status: "error",
        error_code: code,
        duration_ms: durationMs,
      });

      await sendSafely(meta, {
        recipient: phone,
        originalMessageId: messageId,
        text: error?.publicMessage
          || (code === "PROCESSING_TIMEOUT" ? PUBLIC_MESSAGES.TIMEOUT : PUBLIC_MESSAGES.TEMPORARY),
      });

      if (batch && eventId) {
        try {
          const updatedBatch = await store.getBatch(batch.id);
          await sendBatchCompletionIfReady(updatedBatch, phone);
        } catch (storeError) {
          logEvent({ event: "supabase_error", code: errorCode(storeError) });
        }
      }
    }
  }

  async function processMessage(message, phone) {
    if (!message?.id || !phone) return;

    if (message.type === "text") {
      const command = parseCommand(message.text?.body);
      if (command) {
        const batch = await store.getOpenBatch(phone).catch((error) => {
          logEvent({ event: "supabase_error", code: errorCode(error) });
          return null;
        });
        if (batch || command === "lote" || command === "estado" || command === "fin") {
          const { handleBatchCommand } = await import("./batches.mjs");
          try {
            await handleBatchCommand({
              command,
              phone,
              store,
              messageId: message.id,
              sendText: (payload) => meta.sendText(payload),
            });
          } catch (error) {
            logEvent({ event: "command_error", code: errorCode(error), phone: maskPhone(phone) });
            await sendSafely(meta, { recipient: phone, originalMessageId: message.id, text: PUBLIC_MESSAGES.TEMPORARY });
          }
        }
        return;
      }
      await sendSafely(meta, {
        recipient: phone,
        originalMessageId: message.id,
        text: "Envíame una foto como imagen y te la devolveré como sticker.",
      });
      return;
    }

    if (message.type !== "image" || !message.image?.id) {
      await sendSafely(meta, {
        recipient: phone,
        originalMessageId: message.id,
        text: "Envíame una foto como imagen y te la devolveré como sticker.",
      });
      return;
    }

    let batch;
    try {
      await store.expireOpenBatch(phone);
      batch = await store.getOpenBatch(phone);
      await processImage(message, phone, batch);
    } catch (error) {
      logEvent({ event: "image_setup_error", code: errorCode(error), phone: maskPhone(phone) });
      await sendSafely(meta, {
        recipient: phone,
        originalMessageId: message.id,
        text: PUBLIC_MESSAGES.TEMPORARY,
      });
    }
  }

  return { processMessage };
}

export { MAX_INPUT_BYTES, PROCESSING_TIMEOUT_MS };
