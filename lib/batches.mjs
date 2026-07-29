import { formatBatchStatus, formatBatchSummary } from "./commands.mjs";

export async function handleBatchCommand({ command, phone, store, sendText, messageId }) {
  await store.touchUser(phone);
  await store.expireOpenBatch(phone);
  const existing = await store.getOpenBatch(phone);

  if (command === "lote") {
    if (existing) {
      await sendText({
        recipient: phone,
        originalMessageId: messageId,
        text: `Ya tienes un lote activo: ${existing.processed_count} de ${existing.max_items} imágenes procesadas. Escribe “estado” o “fin”.`,
      });
      return existing;
    }

    let batch;
    try {
      batch = await store.openBatch(phone);
    } catch (error) {
      const concurrentBatch = await store.getOpenBatch(phone);
      if (!concurrentBatch) throw error;
      await sendText({
        recipient: phone,
        originalMessageId: messageId,
        text: `Ya tienes un lote activo: ${concurrentBatch.processed_count} de ${concurrentBatch.max_items} imágenes procesadas. Escribe “estado” o “fin”.`,
      });
      return concurrentBatch;
    }
    await sendText({
      recipient: phone,
      originalMessageId: messageId,
      text: "Modo lote activado. Envía hasta 10 imágenes durante los próximos 5 minutos. Escribe “fin” cuando termines.",
    });
    return batch;
  }

  if (command === "estado") {
    await sendText({
      recipient: phone,
      originalMessageId: messageId,
      text: existing
        ? formatBatchStatus(existing)
        : "No tienes un lote activo. Escribe “lote” para iniciar uno.",
    });
    return existing;
  }

  if (!existing) {
    await sendText({
      recipient: phone,
      originalMessageId: messageId,
      text: "No tienes un lote activo.",
    });
    return null;
  }

  const closed = await store.closeBatch(existing.id);
  await sendText({
    recipient: phone,
    originalMessageId: messageId,
    text: formatBatchSummary(closed || existing),
  });
  return closed || existing;
}
