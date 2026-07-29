export function normalizeRecipient(rawValue) {
  const rawRecipient = String(rawValue ?? "");

  return rawRecipient.startsWith("521") && rawRecipient.length === 13
    ? `52${rawRecipient.slice(3)}`
    : rawRecipient;
}

export function maskPhone(phone) {
  const value = String(phone ?? "");
  return value.length <= 4 ? "****" : `***${value.slice(-4)}`;
}
