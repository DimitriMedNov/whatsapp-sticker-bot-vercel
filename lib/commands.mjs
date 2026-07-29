export function parseCommand(value) {
  const command = String(value ?? "").trim().toLowerCase();

  if (["lote", "estado", "fin"].includes(command)) {
    return command;
  }

  return null;
}

export function formatBatchStatus(batch, now = Date.now()) {
  const remainingMs = Math.max(
    0,
    new Date(batch.expires_at).getTime() - now,
  );
  const minutes = Math.ceil(remainingMs / 60_000);

  return `Lote activo: ${batch.received_count} recibidas, ` +
    `${batch.processed_count} procesadas, ${batch.failed_count} fallidas. ` +
    `Máximo: ${batch.max_items}. Tiempo restante: ${minutes} min.`;
}

export function formatBatchSummary(batch) {
  return `Lote completado: ${batch.processed_count} stickers creados, ` +
    `${batch.failed_count} errores.`;
}
