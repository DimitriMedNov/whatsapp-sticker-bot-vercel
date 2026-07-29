import { createClient } from "@supabase/supabase-js";
import { BotError } from "./errors.mjs";

export function createSupabaseStore(config, client = null) {
  const supabase = client || createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  function requireData(result, fallbackCode = "SUPABASE_ERROR") {
    if (result.error) {
      throw new BotError(fallbackCode, "Supabase no está disponible.", { cause: result.error });
    }
    return result.data;
  }

  return {
    async touchUser(phone) {
      const result = await supabase.rpc("touch_bot_user", { p_phone: phone });
      return requireData(result, "SUPABASE_USER_ERROR");
    },

    async claimStickerRequest({ phone, messageId, inputBytes, processingType, batchId }) {
      const result = await supabase.rpc("claim_sticker_request", {
        p_phone: phone,
        p_message_id: messageId,
        p_input_bytes: inputBytes,
        p_processing_type: processingType,
        p_batch_id: batchId || null,
      });
      return requireData(result, "SUPABASE_CLAIM_ERROR");
    },

    async expireOpenBatch(phone) {
      const result = await supabase
        .from("batch_sessions")
        .update({ status: "expired", closed_at: new Date().toISOString() })
        .eq("phone", phone)
        .eq("status", "open")
        .lte("expires_at", new Date().toISOString())
        .select("*");
      requireData(result);
    },

    async getOpenBatch(phone) {
      const result = await supabase
        .from("batch_sessions")
        .select("*")
        .eq("phone", phone)
        .eq("status", "open")
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();
      return requireData(result);
    },

    async openBatch(phone) {
      const result = await supabase
        .from("batch_sessions")
        .insert({ phone, max_items: 10 })
        .select("*")
        .single();
      return requireData(result, "BATCH_OPEN_ERROR");
    },

    async closeBatch(batchId) {
      const result = await supabase
        .from("batch_sessions")
        .update({ status: "closed", closed_at: new Date().toISOString() })
        .eq("id", batchId)
        .eq("status", "open")
        .select("*")
        .maybeSingle();
      return requireData(result);
    },

    async getBatch(batchId) {
      const result = await supabase
        .from("batch_sessions")
        .select("*")
        .eq("id", batchId)
        .single();
      return requireData(result);
    },

    async markProcessing(eventId) {
      const result = await supabase.rpc("mark_sticker_processing", { p_event_id: eventId });
      return requireData(result);
    },

    async markSuccess(eventId, outputBytes, durationMs) {
      const result = await supabase.rpc("complete_sticker_request", {
        p_event_id: eventId,
        p_output_bytes: outputBytes,
        p_duration_ms: durationMs,
      });
      return requireData(result);
    },

    async markError(eventId, errorCode, errorMessage, durationMs) {
      const result = await supabase.rpc("fail_sticker_request", {
        p_event_id: eventId,
        p_error_code: errorCode,
        p_error_message: String(errorMessage).slice(0, 300),
        p_duration_ms: durationMs,
      });
      return requireData(result);
    },
  };
}
