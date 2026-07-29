import { waitUntil } from "@vercel/functions";
import sharp from "sharp";

const {
  WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  GRAPH_API_VERSION = "v25.0",
} = process.env;

/*
 * Esta memoria evita duplicados dentro de una misma instancia caliente
 * de Vercel. Meta no debería reintentar el webhook porque respondemos 200
 * inmediatamente y terminamos el trabajo con waitUntil().
 */
const processedMessageIds = new Set();

function validateEnvironment() {
  const requiredVariables = {
    WEBHOOK_VERIFY_TOKEN,
    WHATSAPP_TOKEN,
    PHONE_NUMBER_ID,
    GRAPH_API_VERSION,
  };

  const missingVariables = Object.entries(requiredVariables)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingVariables.length > 0) {
    throw new Error(
      `Faltan variables de entorno: ${missingVariables.join(", ")}`,
    );
  }
}

function markMessageAsProcessed(messageId) {
  processedMessageIds.add(messageId);

  if (processedMessageIds.size > 1000) {
    const oldestMessageId =
      processedMessageIds.values().next().value;

    processedMessageIds.delete(oldestMessageId);
  }
}

function normalizeRecipient(rawValue) {
  const rawRecipient = String(rawValue ?? "");

  /*
   * En México, el webhook puede entregar 521XXXXXXXXXX,
   * mientras que el destinatario de prueba está autorizado
   * como 52XXXXXXXXXX.
   */
  const recipient =
    rawRecipient.startsWith("521") &&
    rawRecipient.length === 13
      ? `52${rawRecipient.slice(3)}`
      : rawRecipient;

  console.log(
    `Destinatario normalizado: ${rawRecipient} → ${recipient}`,
  );

  return recipient;
}

function graphBaseUrl() {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}`;
}

async function metaRequest(path, options = {}) {
  const response = await fetch(`${graphBaseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Meta API respondió ${response.status}: ${body}`,
    );
  }

  return response;
}

async function downloadImage(mediaId) {
  const informationResponse = await metaRequest(`/${mediaId}`);
  const information = await informationResponse.json();

  if (!information.url) {
    throw new Error("Meta no devolvió la URL de la imagen.");
  }

  const imageResponse = await fetch(information.url, {
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    },
  });

  if (!imageResponse.ok) {
    const body = await imageResponse.text();

    throw new Error(
      `No se pudo descargar la imagen: ` +
        `${imageResponse.status} ${body}`,
    );
  }

  const arrayBuffer = await imageResponse.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

async function createSticker(imageBuffer) {
  const qualities = [
    82,
    76,
    70,
    64,
    58,
    52,
    46,
    40,
    34,
    28,
  ];

  for (const quality of qualities) {
    const result = await sharp(imageBuffer, {
      failOn: "warning",
      limitInputPixels: 40_000_000,
    })
      .rotate()
      .resize(512, 512, {
        fit: "contain",
        position: "center",
        background: {
          r: 0,
          g: 0,
          b: 0,
          alpha: 0,
        },
      })
      .webp({
        quality,
        alphaQuality: 80,
        effort: 6,
      })
      .toBuffer();

    if (result.length <= 100 * 1024) {
      console.log(
        `Sticker generado: ` +
          `${Math.round(result.length / 1024)} KB, ` +
          `calidad ${quality}`,
      );

      return result;
    }
  }

  throw new Error(
    "No se pudo comprimir la imagen por debajo de 100 KB.",
  );
}

async function uploadSticker(stickerBuffer) {
  const form = new FormData();

  form.append("messaging_product", "whatsapp");
  form.append("type", "image/webp");
  form.append(
    "file",
    new Blob([stickerBuffer], {
      type: "image/webp",
    }),
    "sticker.webp",
  );

  const response = await metaRequest(
    `/${PHONE_NUMBER_ID}/media`,
    {
      method: "POST",
      body: form,
    },
  );

  const result = await response.json();

  if (!result.id) {
    throw new Error(
      "Meta no devolvió el ID del sticker subido.",
    );
  }

  return result.id;
}

async function sendSticker({
  recipient,
  stickerId,
  originalMessageId,
}) {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "sticker",
    sticker: {
      id: stickerId,
    },
  };

  if (originalMessageId) {
    body.context = {
      message_id: originalMessageId,
    };
  }

  await metaRequest(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function sendText({
  recipient,
  text,
  originalMessageId,
}) {
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: recipient,
    type: "text",
    text: {
      body: text,
    },
  };

  if (originalMessageId) {
    body.context = {
      message_id: originalMessageId,
    };
  }

  await metaRequest(`/${PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function processMessage(message) {
  if (!message?.id || !message?.from) {
    console.log(
      "Mensaje ignorado porque no contiene id o remitente.",
    );

    return;
  }

  if (processedMessageIds.has(message.id)) {
    console.log(
      `Mensaje duplicado ignorado: ${message.id}`,
    );

    return;
  }

  markMessageAsProcessed(message.id);

  const recipient = normalizeRecipient(message.from);

  if (
    message.type !== "image" ||
    !message.image?.id
  ) {
    await sendText({
      recipient,
      originalMessageId: message.id,
      text:
        "Envíame una foto como imagen y te la devolveré como sticker.",
    });

    return;
  }

  console.log(
    `Procesando imagen enviada por ${recipient}...`,
  );

  try {
    const imageBuffer = await downloadImage(
      message.image.id,
    );

    const stickerBuffer = await createSticker(
      imageBuffer,
    );

    const stickerId = await uploadSticker(
      stickerBuffer,
    );

    await sendSticker({
      recipient,
      stickerId,
      originalMessageId: message.id,
    });

    console.log(
      `Sticker enviado correctamente a ${recipient}.`,
    );
  } catch (error) {
    console.error("Error procesando la imagen:", error);

    try {
      await sendText({
        recipient,
        originalMessageId: message.id,
        text:
          "No pude convertir esa imagen. " +
          "Prueba enviando otra foto JPG o PNG.",
      });
    } catch (notificationError) {
      console.error(
        "Tampoco se pudo enviar el mensaje de error:",
        notificationError,
      );
    }
  }
}

async function processWebhookPayload(payload) {
  validateEnvironment();

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") {
        continue;
      }

      const value = change?.value;

      const eventPhoneNumberId = String(
        value?.metadata?.phone_number_id ?? "",
      );

      if (
        eventPhoneNumberId !== String(PHONE_NUMBER_ID)
      ) {
        console.log(
          "Evento de prueba ignorado. " +
            `Phone Number ID recibido: ` +
            `${eventPhoneNumberId || "vacío"}`,
        );

        continue;
      }

      for (const message of value?.messages ?? []) {
        try {
          await processMessage(message);
        } catch (error) {
          console.error(
            "Error no controlado procesando mensaje:",
            error,
          );
        }
      }
    }
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token =
        url.searchParams.get("hub.verify_token");
      const challenge =
        url.searchParams.get("hub.challenge");

      /*
       * Una visita normal a / o /webhook funciona como
       * comprobación de salud.
       */
      if (!mode && !token && !challenge) {
        return jsonResponse({
          ok: true,
          service: "WhatsApp Sticker Bot",
          runtime: "Vercel Functions",
        });
      }

      if (
        mode === "subscribe" &&
        token === WEBHOOK_VERIFY_TOKEN
      ) {
        console.log(
          "Webhook verificado correctamente por Meta.",
        );

        return new Response(challenge ?? "", {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain; charset=utf-8",
          },
        });
      }

      console.warn(
        "Intento de verificación rechazado.",
      );

      return new Response("Forbidden", {
        status: 403,
      });
    }

    if (request.method === "POST") {
      let payload;

      try {
        payload = await request.json();
      } catch {
        return jsonResponse(
          {
            ok: false,
            error: "JSON inválido",
          },
          400,
        );
      }

      console.log(
        "Webhook recibido:",
        JSON.stringify(payload, null, 2),
      );

      /*
       * Meta recibe el 200 inmediatamente. Vercel mantiene
       * viva la función hasta terminar la conversión y el envío.
       */
      waitUntil(
        processWebhookPayload(payload).catch((error) => {
          console.error(
            "Error procesando el webhook:",
            error,
          );
        }),
      );

      return new Response("OK", {
        status: 200,
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",
        },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: {
        Allow: "GET, POST",
      },
    });
  },
};
