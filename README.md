# WhatsApp Sticker Bot para Vercel

Bot de WhatsApp que convierte imágenes recibidas en stickers y los devuelve automáticamente al mismo chat. Está implementado como una función serverless de Vercel y utiliza la Cloud API de WhatsApp de Meta.

## Cómo funciona

1. Meta envía el evento al webhook mediante `POST /webhook`.
2. La función responde `200 OK` inmediatamente y continúa el procesamiento con `waitUntil()`.
3. El bot valida el `Phone Number ID` del evento para ignorar mensajes de otros números.
4. Descarga la imagen desde la API de Meta.
5. `sharp` la rota según sus metadatos EXIF, la adapta a un lienzo transparente de `512 × 512 px` y la comprime como WebP hasta quedar por debajo de `100 KB`.
6. Sube el WebP a Meta y envía el sticker al remitente, relacionándolo con el mensaje original.

Si el usuario envía texto, audio, video u otro tipo de mensaje, recibe una indicación para enviar una imagen. Si una conversión falla, el bot envía un mensaje de error y registra el detalle en los logs de Vercel.

## Requisitos

- Node.js `22.x`.
- Una cuenta de Vercel.
- Una aplicación en [Meta for Developers](https://developers.facebook.com/) con WhatsApp Cloud API configurada.
- Un número de WhatsApp Business y un token con permisos para leer medios, subir archivos y enviar mensajes.

## Variables de entorno

Copia `.env.example` como referencia y configura estos valores en Vercel. No subas un archivo `.env` al repositorio.

| Variable | Descripción |
| --- | --- |
| `WEBHOOK_VERIFY_TOKEN` | Token secreto que eliges y que debe coincidir con el token usado al configurar el webhook en Meta. |
| `WHATSAPP_TOKEN` | Token de acceso de Meta para la WhatsApp Cloud API. Debe mantenerse como secreto. |
| `PHONE_NUMBER_ID` | ID del número de teléfono de WhatsApp Business que recibirá y enviará mensajes. |
| `GRAPH_API_VERSION` | Versión de Graph API, por ejemplo `v25.0`. Si se omite, el código usa `v25.0`. |

## Instalación y comprobación local

```bash
npm install
npm run check
```

`npm run check` comprueba la sintaxis de `api/webhook.mjs`. La función depende de las credenciales de Meta, por lo que una prueba local completa requiere exponer el endpoint públicamente y configurar un webhook de prueba en Meta; una URL local no es accesible directamente desde sus servidores.

## Despliegue en Vercel

La forma más sencilla es importar este repositorio desde el panel de Vercel:

1. Importa el repositorio en Vercel.
2. Añade las cuatro variables de entorno para los entornos que quieras usar (`Production`, `Preview` y/o `Development`).
3. Despliega el proyecto.
4. Conserva la URL pública de Vercel, por ejemplo `https://tu-proyecto.vercel.app`.

También puedes desplegar desde la CLI de Vercel:

```bash
npx vercel
npx vercel --prod
```

## Configuración del webhook en Meta

En la configuración de WhatsApp de tu aplicación de Meta:

- **Callback URL:** `https://tu-proyecto.vercel.app/webhook`
- **Verify token:** el mismo valor de `WEBHOOK_VERIFY_TOKEN`
- Suscribe el campo **messages**.

Meta primero hace una petición `GET` de verificación. El bot devuelve el `hub.challenge` cuando el token coincide y responde `403` si la verificación es incorrecta.

Después, los mensajes llegan mediante `POST`. La ruta raíz (`/`) y `/webhook` están reescritas hacia `/api/webhook` por `vercel.json`.

## Rutas y respuestas

| Método | Ruta | Uso |
| --- | --- | --- |
| `GET` | `/` | Comprobación de salud. Devuelve JSON con `ok: true`. |
| `GET` | `/webhook` | Verificación de Meta o comprobación de salud. |
| `POST` | `/webhook` | Recepción de eventos de WhatsApp. Devuelve `OK` inmediatamente. |
| `GET/POST` | `/api/webhook` | Función directa de Vercel. |

Los demás métodos reciben `405 Method Not Allowed` y el encabezado `Allow: GET, POST`. Un `POST` con JSON inválido recibe `400`.

## Estructura

```text
.
├── api/
│   └── webhook.mjs    # Función HTTP y lógica del bot
├── .env.example       # Plantilla de variables de entorno
├── package.json       # Dependencias y scripts
├── vercel.json        # Rewrites y recursos de la función
└── README.md
```

## Detalles importantes

- La función se configura con hasta `60` segundos y `1024 MB` de memoria en `vercel.json`.
- La deduplicación usa un `Set` en memoria y conserva como máximo 1000 IDs. Evita reintentos duplicados mientras la instancia de Vercel permanezca caliente, pero no sustituye una base de datos de idempotencia entre instancias.
- Para números mexicanos, el código normaliza un remitente de 13 dígitos con prefijo `521` al formato `52...` antes de responder.
- `sharp` preserva la orientación EXIF y agrega transparencia alrededor de imágenes que no son cuadradas.
- El token de WhatsApp se envía como encabezado `Authorization` únicamente en las peticiones a Meta. No lo registres en logs ni lo incluyas en el cliente.

## Solución de problemas

**Meta no verifica el webhook**

- Comprueba que la URL sea pública y termine en `/webhook`.
- Verifica que `WEBHOOK_VERIFY_TOKEN` coincida exactamente con el token introducido en Meta.
- Revisa los logs de la función en Vercel.

**El bot no responde**

- Confirma `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` y `GRAPH_API_VERSION`.
- Comprueba que el número de Meta sea el mismo que aparece en `PHONE_NUMBER_ID`.
- Revisa que el campo `messages` esté suscrito y que el token tenga permisos suficientes.

**La imagen no se convierte**

- Envía una imagen JPG o PNG válida.
- Revisa los logs para identificar errores de descarga, permisos de Meta o compresión.
- El resultado debe poder comprimirse por debajo de `100 KB`; imágenes muy grandes o complejas pueden no cumplir ese límite.

## Seguridad

- Usa tokens largos y aleatorios para `WEBHOOK_VERIFY_TOKEN`.
- Configura los secretos en Vercel y rótalos si se exponen.
- Mantén `.env` fuera de Git; el `.gitignore` ya excluye los archivos de entorno salvo `.env.example`.
