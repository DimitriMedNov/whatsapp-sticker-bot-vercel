import { waitUntil } from "@vercel/functions";
import { createMetaClient } from "../lib/meta.mjs";
import { createSupabaseStore } from "../lib/supabase.mjs";
import { createSticker } from "../lib/stickers.mjs";
import { createProcessor } from "../lib/processor.mjs";
import { normalizeRecipient } from "../lib/phone.mjs";
import { readConfig, validateConfig } from "../lib/config.mjs";

const config = readConfig();
const processedMessageIds = new Set();

function markMessageSeen(messageId) {
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > 1000) {
    processedMessageIds.delete(processedMessageIds.values().next().value);
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

function createRuntime() {
  validateConfig(config);
  const meta = createMetaClient(config);
  const store = createSupabaseStore(config);
  const processor = createProcessor({
    store,
    meta,
    createSticker,
  });
  return processor;
}

async function processWebhookPayload(payload) {
  const processor = createRuntime();

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "messages") continue;

      const value = change.value;
      const eventPhoneNumberId = String(value?.metadata?.phone_number_id ?? "");
      if (eventPhoneNumberId !== String(config.phoneNumberId)) {
        console.log(JSON.stringify({ event: "ignored_phone_number_id" }));
        continue;
      }

      for (const message of value?.messages ?? []) {
        if (!message?.id || !message?.from) continue;
        if (processedMessageIds.has(message.id)) continue;
        markMessageSeen(message.id);

        const phone = normalizeRecipient(message.from);
        try {
          await processor.processMessage(message, phone);
        } catch (error) {
          console.error(JSON.stringify({ event: "message_error", code: error?.code || "PROCESSING_ERROR" }));
        }
      }
    }
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (!mode && !token && !challenge) {
        return jsonResponse({ ok: true, service: "WhatsApp Sticker Bot", runtime: "Vercel Functions" });
      }

      if (mode === "subscribe" && token === config.webhookVerifyToken) {
        return new Response(challenge ?? "", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: "JSON inválido" }, 400);
      }

      waitUntil(processWebhookPayload(payload).catch((error) => {
        console.error(JSON.stringify({ event: "webhook_error", code: error?.code || "PROCESSING_ERROR" }));
      }));

      return new Response("OK", {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, POST" },
    });
  },
};

export { processWebhookPayload };
