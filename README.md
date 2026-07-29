# WhatsApp Sticker Bot — Vercel

## Variables necesarias

Configura estas variables en Vercel:

- `WEBHOOK_VERIFY_TOKEN`
- `WHATSAPP_TOKEN`
- `PHONE_NUMBER_ID`
- `GRAPH_API_VERSION`

No subas tu archivo `.env`.

## Rutas

- Salud: `/`
- Webhook: `/webhook`
- Función directa: `/api/webhook`

## Comprobación local de sintaxis

```bash
npm install
npm run check
```
