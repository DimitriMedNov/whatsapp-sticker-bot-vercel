import { BotError } from "./errors.mjs";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export function isAllowedMimeType(mimeType) {
  return ALLOWED_MIME_TYPES.has(String(mimeType ?? "").toLowerCase());
}

export function createMetaClient(config, fetchImpl = fetch) {
  const baseUrl = `https://graph.facebook.com/${config.graphApiVersion}`;

  async function request(path, options = {}) {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${config.whatsappToken}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new BotError("META_API_ERROR", `Meta API respondió ${response.status}.`);
    }

    return response;
  }

  return {
    async getImageInfo(mediaId, signal) {
      const response = await request(`/${encodeURIComponent(mediaId)}`, { signal });
      const information = await response.json();

      if (!information.url) {
        throw new BotError("META_MEDIA_URL_MISSING", "Meta no devolvió la URL de la imagen.");
      }

      return {
        url: information.url,
        mimeType: information.mime_type,
        fileSize: information.file_size != null && Number.isFinite(Number(information.file_size))
          ? Number(information.file_size)
          : null,
      };
    },

    async downloadImage(imageInfo, signal) {
      const response = await fetchImpl(imageInfo.url, {
        headers: { Authorization: `Bearer ${config.whatsappToken}` },
        signal,
      });

      if (!response.ok) {
        throw new BotError("META_DOWNLOAD_ERROR", `No se pudo descargar la imagen (${response.status}).`);
      }

      return Buffer.from(await response.arrayBuffer());
    },

    async uploadSticker(stickerBuffer, signal) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", "image/webp");
      form.append(
        "file",
        new Blob([stickerBuffer], { type: "image/webp" }),
        "sticker.webp",
      );

      const response = await request(`/${config.phoneNumberId}/media`, {
        method: "POST",
        body: form,
        signal,
      });
      const result = await response.json();

      if (!result.id) {
        throw new BotError("META_UPLOAD_ERROR", "Meta no devolvió el ID del sticker.");
      }

      return result.id;
    },

    async sendSticker({ recipient, stickerId, originalMessageId }, signal) {
      await request(`/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "sticker",
          sticker: { id: stickerId },
          context: originalMessageId ? { message_id: originalMessageId } : undefined,
        }),
        signal,
      });
    },

    async sendText({ recipient, text, originalMessageId }, signal) {
      await request(`/${config.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: recipient,
          type: "text",
          text: { body: text },
          context: originalMessageId ? { message_id: originalMessageId } : undefined,
        }),
        signal,
      });
    },
  };
}

export { ALLOWED_MIME_TYPES };
