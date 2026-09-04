# WhatsApp Sticker Bot para Vercel

Bot de WhatsApp que convierte imágenes recibidas en stickers y los devuelve al mismo chat. Corre como una función serverless de Vercel y usa la Cloud API de WhatsApp de Meta. Supabase conserva únicamente teléfonos, estados, contadores y metadatos técnicos; las imágenes nunca se guardan en Supabase ni en disco.

## Arquitectura

```text
Meta WhatsApp
     │ GET verificación / POST evento
     ▼
api/webhook.mjs
     │ responde 200 inmediatamente
     └── waitUntil()
          ├── lib/meta.mjs       API de medios y mensajes de Meta
          ├── lib/stickers.mjs   Sharp: WebP transparente 512 × 512
          ├── lib/supabase.mjs   Persistencia y RPCs con secret key
          ├── lib/processor.mjs  Validación, límites y procesamiento
          └── lib/batches.mjs    Sesiones lote y resúmenes
```

El endpoint mantiene las rutas existentes:

- `GET /` y `GET /webhook`: salud o verificación de Meta.
- `POST /webhook`: recibe eventos y responde `200 OK` antes del procesamiento.
- `/api/webhook`: función directa de Vercel.

La función conserva `maxDuration: 60` en `vercel.json` y no define `memory`.

## Flujo de una imagen

1. Se valida que el evento pertenezca al `PHONE_NUMBER_ID` configurado.
2. Se normaliza el teléfono mexicano `521XXXXXXXXXX` a `52XXXXXXXXXX`.
3. Se consulta el MIME y tamaño de la imagen en Meta.
4. Se aceptan sólo JPG, PNG y WebP, con un máximo de 5 MB.
5. Supabase reclama la solicitud mediante una RPC con bloqueo por teléfono. Esto aplica bloqueo, idempotencia y límite horario sin depender de la memoria de Vercel.
6. La imagen se descarga y se transforma con Sharp a WebP transparente de `512 × 512 px` y máximo `100 KB`.
7. Se sube el sticker a Meta y se envía al usuario.
8. El evento se completa como `success` o `error`, incluyendo tamaños, duración y error técnico controlado.

Cada imagen tiene un timeout global de 45 segundos. Las peticiones `fetch` usan `AbortController` para dejar margen antes del límite de 60 segundos de Vercel.

## Comandos

Los comandos ignoran mayúsculas y espacios externos.

| Comando | Acción |
| --- | --- |
| `lote` | Abre una sesión de 5 minutos para hasta 10 imágenes. Si ya existe una, informa su progreso. |
| `estado` | Muestra imágenes recibidas, procesadas, fallidas, máximo y minutos restantes. |
| `fin` | Cierra la sesión y muestra `X` stickers creados y `Y` errores. |

Las imágenes recibidas durante una sesión se registran como `batch_sticker` y se procesan inmediatamente. Las imágenes fuera de una sesión se registran como `sticker`. El lote se cierra automáticamente al aceptar la décima imagen y envía un resumen cuando termina su procesamiento.

## Límites

- 10 stickers por teléfono en una ventana móvil de una hora.
- 10 imágenes por lote.
- 5 minutos por lote.
- 5 MB por imagen de entrada.
- 100 KB por sticker WebP de salida.

Los mensajes duplicados se detectan con `message_id` único en Supabase. El `Set` local sólo es una optimización secundaria para instancias calientes.

## Variables de entorno

Copia `.env.example` como referencia. Usa valores reales sólo en Vercel o en un entorno local seguro; nunca subas `.env`.

| Variable | Uso |
| --- | --- |
| `WEBHOOK_VERIFY_TOKEN` | Token que Meta usa para verificar el webhook. |
| `WHATSAPP_TOKEN` | Token privado para la Cloud API de WhatsApp. |
| `META_APP_SECRET` | App Secret de la app de Meta. Verifica la firma `X-Hub-Signature-256` de cada webhook. |
| `PHONE_NUMBER_ID` | ID del número de WhatsApp Business. |
| `GRAPH_API_VERSION` | Versión de Graph API, por ejemplo `v25.0`. |
| `SUPABASE_URL` | URL del proyecto de Supabase. |
| `SUPABASE_SECRET_KEY` | Clave secreta exclusivamente de backend; nunca se envía al cliente ni se registra. |
| `ADMIN_DASHBOARD_PASSWORD` | Contraseña privada para `/admin`; sólo se configura en Vercel. |
| `ADMIN_SESSION_SECRET` | Secreto aleatorio para firmar sesiones y acciones administrativas. |

## Instalación y pruebas

Requiere Node.js `24.x`.

```bash
npm install
npm run check
npm test
```

`npm test` usa `node:test` y mocks. No llama a Meta ni a Supabase: los tests
administrativos levantan un servidor HTTP local que hace de Supabase, así que la suite
corre sin red y sin credenciales reales. Si tu equipo local usa Node.js `26.x`, npm puede mostrar `EBADENGINE`; el runtime desplegado debe permanecer en `24.x`.

## Migraciones de Supabase

Las migraciones son idempotentes y no destruyen información. No se ejecutan automáticamente desde este repositorio.

Ejecuta manualmente, **en orden numérico y sin saltarte ninguna**, desde el SQL Editor de Supabase o desde tu flujo controlado de migraciones:

1. `001_sticker_bot_schema.sql` — tablas, índices y RLS.
2. `002_claim_sticker_request.sql` — RPC de reclamo y transiciones de evento.
3. `003_admin_dashboard_rpc.sql` — RPC administrativas base.
4. `004_admin_sessions_audit.sql` — revocación de sesiones y auditoría de acciones.
5. `005_admin_queue_metrics.sql` — cola de procesamiento.
6. `006_admin_trends_metrics.sql` — tendencias y horas pico.
7. `007_admin_error_groups.sql` — agrupación de errores.
8. `008_admin_alerts.sql` — alertas operativas.
9. `009_admin_activity_feed.sql` — registro de actividad.
10. `010_admin_conversion.sql` — embudo de conversión.
11. `011_admin_daily_chart_window.sql` — corrige la gráfica diaria de siete días.
12. `012_stale_events_and_index.sql` — cierra eventos colgados, índice por fecha y purga opcional.
13. `013_admin_queue_window.sql` — acota la cola del panel a 24 horas.
14. `014_admin_login_attempts.sql` — límite de intentos de login compartido.

Varias migraciones redefinen funciones creadas por migraciones anteriores con
`create or replace`. Por eso el orden importa y **no debes reejecutar una migración
antigua después de una más reciente**: volver a aplicar `003` sobre `004`, por ejemplo,
restauraría `admin_set_user_blocked` sin su registro de auditoría. Si necesitas
reconstruir el esquema, ejecuta la secuencia completa de principio a fin.

La primera crea `bot_users`, `batch_sessions`, `processing_events`, índices y RLS sin políticas públicas. La segunda crea la RPC `claim_sticker_request` y las RPC auxiliares de transición de eventos. El acceso de ejecución queda revocado para `public`, `anon` y `authenticated`, y se concede al rol backend `service_role`.

No almacenes imágenes, URLs firmadas, nombres de perfil ni payloads completos en Supabase. Sólo se conservan teléfono, `message_id`, tipo, estado, tamaños, duración, errores técnicos y contadores de lote.

## Panel administrativo

Configura `ADMIN_DASHBOARD_PASSWORD` y `ADMIN_SESSION_SECRET` en Vercel como variables privadas de Production (y Preview/Development si corresponde). Usa una contraseña larga y un secreto aleatorio de al menos 32 bytes. Entra en `https://tu-proyecto.vercel.app/admin`; el login se envía por POST y la sesión queda en una cookie `HttpOnly`, `Secure`, `SameSite=Strict` con máximo de ocho horas. El botón **Cerrar sesión** revoca la cookie localmente.

El panel muestra volumen de stickers, usuarios activos, lotes, errores, tasa de éxito, duración y tamaño promedio, una gráfica diaria de siete días, actividad reciente, usuarios y lotes paginados. Los teléfonos se enmascaran como `********0366`; el navegador nunca recibe el número completo. Bloquear o desbloquear requiere confirmación visual y utiliza un identificador de acción cifrado que sólo puede resolver el backend.

Si una métrica falla, el panel muestra `No se pudieron cargar las métricas. Intenta nuevamente.` y permite reintentar con **Actualizar**. La actualización automática ocurre cada 30 segundos mientras la pestaña está visible y se detiene al ocultarla.

## Configuración en Vercel

En el proyecto `whatsapp-sticker-bot-vercel`, abre `Settings → Environment Variables` y añade las nueve variables del apartado anterior. Configúralas en los entornos que realmente uses (`Production`, `Preview` y/o `Development`). `SUPABASE_SECRET_KEY`, `ADMIN_DASHBOARD_PASSWORD` y `ADMIN_SESSION_SECRET` deben ser variables privadas de servidor.

Tras aplicar las migraciones y guardar las variables, realiza un redeploy desde `Deployments → ... → Redeploy` o mediante el flujo de despliegue habitual del proyecto. Este cambio local no hace deploy automáticamente.

No cambies el dominio ni la URL configurada en Meta. El callback sigue siendo:

```text
https://tu-proyecto.vercel.app/webhook
```

## Seguridad y privacidad

### Límite de intentos en el login

El contador de intentos fallidos vive en `admin_login_attempts` (Supabase), no en
memoria: cinco fallos por IP bloquean quince minutos, y el tope es el mismo aunque
Vercel levante varias instancias. Si Supabase no responde, el endpoint recurre a un
contador local por instancia para no dejar el login abierto de par en par.

### Retención de datos

`processing_events` no se purga sola. La migración `012` deja lista
`purge_old_processing_events(p_older_than_days)`, que borra eventos ya terminados y los
lotes sin eventos asociados, pero **nadie la llama**: actívala tú cuando decidas una
política de retención, añadiendo la llamada al cron de `api/cron/keepalive.mjs`.

`reap_stale_processing_events(p_older_than_minutes)` sí se ejecuta a diario desde ese
cron. Cierra como `PROCESSING_ABANDONED` los eventos que llevan más de quince minutos
sin terminar, que de otro modo inflarían la cola del panel para siempre y consumirían
la cuota horaria del usuario.

### Firma del webhook

Meta firma cada `POST` con `X-Hub-Signature-256`, un HMAC-SHA256 del cuerpo crudo
usando el App Secret. `api/webhook.mjs` lo verifica antes de procesar nada y responde
`403` si la firma no coincide o falta. Sin esta comprobación, cualquiera que conozca la
URL podría inyectar eventos falsos y hacer que el bot envíe mensajes a números
arbitrarios con tu cuota de WhatsApp.

Copia el App Secret desde `Meta for Developers → tu app → Configuración → Básica` y
guárdalo como `META_APP_SECRET` en Vercel.

**Si `META_APP_SECRET` no está configurado, el webhook acepta el evento y registra
`webhook_signature_unverified` en los logs**, para que un despliegue sin la variable no
deje el bot caído. Es un modo de transición, no un estado deseable: configura la
variable en cuanto despliegues y confirma que ese aviso desaparece de los logs. Para
exigir la firma siempre, trata `UNCONFIGURED` como `INVALID` en `api/webhook.mjs`.

- No se imprimen tokens, claves, imágenes, URLs firmadas completas ni payloads innecesarios.
- Los logs estructurados muestran sólo IDs de mensaje, tipo, estado, tamaños, duración y el teléfono enmascarado como `***5678`.
- RLS está activado en las tres tablas y no existen políticas públicas.
- La clave de Supabase se usa únicamente desde `lib/supabase.mjs` en el backend.
- `.gitignore` excluye `.env`, `.env.*` y `.vercel/`, salvo `.env.example`.

## Solución de problemas

**La migración RPC falla**

- Ejecuta las dos migraciones en orden.
- Verifica que el proyecto tenga disponibles `pgcrypto`, RLS y el rol backend esperado.
- No copies claves ni tokens en tickets o logs.

**El bot responde que el servicio está ocupado**

- Revisa los logs breves de Vercel por `supabase_error`, `META_API_ERROR` o `PROCESSING_TIMEOUT`.
- Confirma que `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `WHATSAPP_TOKEN` y `PHONE_NUMBER_ID` estén configuradas en el entorno desplegado.

**El webhook no verifica**

- Mantén `GET /webhook` y el mismo `WEBHOOK_VERIFY_TOKEN` en Meta y Vercel.
- No cambies el dominio ni las rewrites de `vercel.json`.

## Rollback

Si el despliegue nuevo presenta problemas:

1. En Vercel abre `Deployments`.
2. Selecciona el último despliegue conocido como estable.
3. Usa `... → Promote to Production`.
4. Conserva las migraciones aplicadas: son aditivas y no destruyen tablas ni datos.
5. Si se necesita revertir el código, restaura el commit anterior mediante el flujo normal del repositorio y redeploya sólo después de revisar compatibilidad con las tablas nuevas.

No borres las tablas ni ejecutes SQL destructivo como parte de un rollback de aplicación.

Para revertir únicamente el panel, promueve el despliegue estable anterior en Vercel. La migración `003` es aditiva, por lo que puede permanecer aplicada mientras se revierte el código. Si se requiere retirar sus funciones, hazlo sólo con una migración SQL revisada y después de confirmar que ningún despliegue las utiliza. No reviertas ni modifiques las migraciones `001` o `002`, ni cambies las rutas de Meta.
