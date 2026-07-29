export class BotError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "BotError";
    this.code = code;
    this.publicMessage = options.publicMessage;
  }
}

export const PUBLIC_MESSAGES = Object.freeze({
  BLOCKED: "Tu acceso al bot está bloqueado.",
  TOO_LARGE: "La imagen supera el límite de 5 MB.",
  HOURLY_LIMIT: "Alcanzaste el límite de 10 stickers por hora. Intenta nuevamente más tarde.",
  INVALID_FORMAT: "Envía una imagen JPG, PNG o WebP.",
  TEMPORARY: "El servicio está temporalmente ocupado. Intenta nuevamente en unos minutos.",
  TIMEOUT: "La imagen tardó demasiado en procesarse. Intenta con una imagen más pequeña.",
  BATCH_LIMIT: "Tu lote ya alcanzó el límite de 10 imágenes.",
});
