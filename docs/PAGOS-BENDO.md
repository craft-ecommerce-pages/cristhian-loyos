# Pagos con tarjeta vía Bendo (Geopagos) — arquitectura y contrato

Estado: diseño aprobado para implementación (2026-11-13). Fuentes: *Bendo E-commerce Payments API v1.2* (sept. 2026), *Guía de paso a producción – API Link de Pagos Bendo* y la referencia pública `docs.geopagos.io/llms-full.txt` (esquemas de `POST/GET /api/v4/payments/links`). Ante contradicción manda la guía v1.2.

## Decisiones

1. **Caso A: API Link de Pagos (no PCI).** Munch no captura datos de tarjeta: crea un link y redirige al checkout hospedado por Bendo. Solo se usan `POST /api/v4/payments/links`, `GET /api/v4/payments/links/{id}` y `GET /api/v4/points-of-sale`. Los endpoints 3–9 (tokenización, 3DS, OTP) los resuelve el checkout de Bendo.
2. **Bendo convive con Payphone**, no lo reemplaza. Nuevo método de pago `bendo` (pedido web) y botón de caja para cobrar con link/QR. Cada proveedor se activa por su propio modo.
3. **La fuente de verdad es `GET /links/{id}` desde el servidor.** Ni el redirect del navegador ni el webhook marcan pagos: ambos solo disparan una reconsulta. La guía de producción menciona `X-Geopagos-Signature` sin algoritmo documentado; no se usa para autorizar nada. El webhook lleva además una firma propia (HMAC) en la query para descartar ruido sin llamar a Bendo.
4. **Dinero:** el pedido sigue en centavos enteros. A Bendo se envía **una sola línea** `{description:"Pedido Munch #<n>", quantity:1, unit_price: total_cents/100}` con `currency:"USD"` y sin `taxes` (igual que Payphone, hasta tener configuración fiscal validada). Al verificar: `Math.round(link.amount*100) === payment.amount_cents`.
5. **Sin `merchant_id`** (la guía v1.2 lo prohíbe). `point_of_sale` obligatorio: `env.BENDO_POINT_OF_SALE` si existe; si no, primer `uuid` de `GET /api/v4/points-of-sale`, cacheado en KV `bendo:pos:<entorno>` 24 h.
6. **Token OAuth** `client_credentials` nuevo por flujo (vida 15 min), nunca persistido.

## Entornos y configuración

| Clave | Tipo | Valores |
|---|---|---|
| `BENDO_MODE` | var | `disabled` (defecto) · `mock` · `live` |
| `BENDO_ENV` | var | `staging` (defecto) · `production` |
| `BENDO_POINT_OF_SALE` | var opcional | uuid |
| `BENDO_CLIENT_ID`, `BENDO_CLIENT_SECRET` | secrets | por comercio, nunca en Git |

| | staging | production |
|---|---|---|
| Auth | `https://idp.stg.geopagos.io/auth/realms/stg_c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token` | `https://idp.prd.geopagos.io/auth/realms/c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token` |
| API | `https://api.stg.geopagos.io` | `https://api.geopagos.io` |

Token: `POST` `application/x-www-form-urlencoded` con `grant_type=client_credentials&scope=openid&client_id=…&client_secret=…` → `access_token`. Todas las llamadas: `Authorization: Bearer <token>`, timeout 10 s (`AbortSignal.timeout`).

## Crear link

`POST {API}/api/v4/payments/links`:

```json
{ "source": "ecommerce", "currency": "USD",
  "items": [{ "description": "Pedido Munch #42", "quantity": 1, "unit_price": 12.5, "external_reference": "<order_id>" }],
  "expires_in_minutes": 30, "successful_payment_quantity_limit": 1,
  "point_of_sale": "<uuid>",
  "webhook_url": "<origin>/api/bendo/webhook?p=<ref>&s=<firma>", "webhook_version": "V4",
  "redirect_on_success": "<origin>/api/bendo/return?p=<ref>",
  "redirect_on_failure": "<origin>/api/bendo/return?p=<ref>",
  "external_data": "{\"order_id\":\"…\",\"ref\":\"…\"}" }
```

Respuesta 201: `id` (uuid del link) → `pos_payments.provider_id`; `transaction_data.checkout_url` → `pos_payments.url` (debe empezar con `https://`). `<ref>` es `pos_payments.provider_ref` (15 alfanuméricos, ya existente). `<firma>` = primeros 32 hex de `HMAC-SHA256(SESSION_SECRET, "bendo-webhook:" + ref)`.

## Verificación (`bendoOutcome(link, payment)` → `approved | rejected | pending | mismatch`)

- `mismatch` si `link.id !== payment.provider_id`, si el monto no coincide o si `link.currency` existe y no es `USD`.
- `approved` si algún `payments[].status === "APPROVED"` (guardar `authorization_code`).
- `mismatch` si algún pago está `REFUNDED` (revisión manual; nunca se marca pagado ni rechazado solo).
- `rejected` si `link.status === "NOT_AVAILABLE"`, sin `APPROVED` ni `IN_PROGRESS` (link vencido o agotado).
- `pending` en cualquier otro caso (`DENIED`/`ERROR` con link aún `PENDING` permiten reintentar en el checkout de Bendo).

Aplicación: `approved` → `settlePaymentApproved` (comanda una sola vez); `rejected` → `settlePaymentRejected` con "El pago con tarjeta no fue aprobado."; `mismatch` → `markPaymentUnknown(…,"bendo_alterado")`; error de red/5xx → `markPaymentUnknown(…,"bendo_timeout")`, nunca rechazo.

## Rutas

| Ruta | Auth | Comportamiento |
|---|---|---|
| `GET /api/payment-options` | pública | añade `bendo: true` solo con `BENDO_MODE=live` y credenciales, o `mock`. |
| `POST /api/orders/:id/bendo` `{order_token, idempotency_key}` | token del pedido | Solo `source=web` y `payment_method=bendo`. Igual que Payphone: intento en D1 antes de llamar, idempotente por clave, reutiliza `url` si el pago está `pending/unknown`. → `{order_id, payment_id, payment_url, status, total_cents}`. |
| `POST /panel/api/orders/:id/bendo` `{idempotency_key}` | sesión de caja | Pedido de caja/mesero `confirmed`. Misma respuesta; la caja muestra el link como QR (`shared/qr.js`) y como enlace copiable. |
| `GET /api/bendo/return?p=<ref>` | pública | Reconsulta el link, aplica el resultado y redirige como Payphone: web → `MENU_PUBLIC_URL/gracias?pago=<aprobado|rechazado|pendiente>&pedido=…&token=…`; caja → `/panel?pago=…&pedido=…`. Idempotente. `?format=json` devuelve JSON. |
| `POST /api/bendo/webhook?p=<ref>&s=<firma>` | firma propia | Firma inválida o ref desconocida → `200 {ok:true}` sin trabajo (no provocar reintentos infinitos). Válida → reconsulta y aplica; `200` tras aplicar. Error con Bendo → `503` para que Geopagos reintente. Cuerpo máx. 16 KB; nunca se registra el cuerpo completo. |
| `GET /api/bendo/mock?p=<ref>&resultado=aprobado|rechazado|timeout` | solo `BENDO_MODE=mock` | Guarda el resultado en KV `bendo:mock:<ref>` y redirige al return. |
| `POST /panel/api/payments/:ref/reconcile` | sesión | Despacha por `payment.provider`: `bendo` → reconsulta sin ventana de 5 min. |
| Cron (cada minuto) | — | Además de Payphone: pagos `bendo` en `pending/unknown` con `provider_id` y `created_at` de las últimas 2 h, máx. 20 por pasada. |

## Datos (migración `0011_bendo.sql`)

Reconstruye las tablas para ampliar los `CHECK` (SQLite no permite alterarlos), copiando todas las filas y recreando índices:
- `pos_payments.provider IN ('cash','transfer','payphone','bendo')`.
- `pos_orders.payment_method IN ('cash','transfer','payphone','bendo')`, conservando columnas, orden, defaults, CHECKs e índices de 0006/0009/0010.

En producción el workflow ya marca un punto Time Travel de D1 antes de migrar.

## Módulos y propiedad (trabajo en paralelo)

| Parte | Archivos | No tocar |
|---|---|---|
| A · adaptador | `panel/src/bendo.js`, `panel/test/bendo.test.mjs` | todo lo demás |
| B · datos e infraestructura | `panel/migrations/0011_bendo.sql`, `panel/src/orders.js`, `panel/test/bendo-datos.test.mjs`, `scripts/deploy-client.sh`, `panel/wrangler.toml`, `.github/workflows/deploy-client.yml`, `docs/DESPLIEGUE.md` | `api.js`, `index.js`, UI |
| C · interfaz | `v1/catalog.js`, `v1/*.test.cjs` nuevos, `worker/assets/v1/*` (solo vía `worker/sync-v1-assets.sh`), `panel/src/page.js` | backend |
| Ensamblador | `panel/src/api.js`, `panel/src/index.js`, integración y conflictos | — |

### Contrato de `panel/src/bendo.js` (lo consume el ensamblador)

```js
export function bendoMode(env)                       // "disabled" | "mock" | "live"
export function bendoAvailable(env)                  // mock, o live con BENDO_CLIENT_ID y BENDO_CLIENT_SECRET
export function bendoOutcome(link, payment)          // ver Verificación
export async function startBendo(request, env, site, session, encodedId, body)   // caja
export async function startPublicBendo(request, env, site, encodedId, body)      // web
export async function handleBendoReturn(request, env, site)
export async function handleBendoWebhook(request, env, site)
export function handleBendoMock(request, env)
export async function reconcileBendo(env, site, session, payment)                // payment ya cargado por ref
export async function reconcilePendingBendo(env, now = Date.now())
```

Reutiliza de `orders.js`: `createPaymentAttempt(env, slug, order, key, "bendo")`, `setPaymentPending`, `attachProviderId`, `failPayment`, `markPaymentUnknown`, `settlePaymentApproved`, `settlePaymentRejected`, `posOrderForAction`, `posOrderRow`, `posPaymentByKey`, `posPaymentByRef`, `orderToken`; de `contract.js`: `json`, `error`; de `auth.js`: `timingEqual`.

### Cambios de `orders.js` (parte B)

- `PAYMENT_METHODS` incluye `bendo`. Pedido web con `payment_method=bendo` y Bendo no disponible → `503 bendo_no_disponible` (misma regla que Payphone, usando `bendoAvailable` importado de `./bendo.js`; si la parte A aún no existe, la parte B define la condición en línea con la misma semántica).
- `publicPaymentMessage` y `retryable` contemplan `bendo` con textos neutrales ("Estamos verificando el pago con tarjeta. No vuelvas a pagar.", "No se completó el pago con tarjeta.", "El pago con tarjeta no fue aprobado.").

### Interfaz (parte C)

- Checkout: opción "Tarjeta de crédito o débito" (`bendo`) habilitada solo si `payment-options.bendo`; al crear el pedido llama `POST /api/orders/:id/bendo` y redirige a `payment_url`. `/gracias` muestra pendiente/aprobado/rechazado y permite reintento si `retryable`, igual que Payphone.
- Caja (`page.js`): etiqueta `bendo: "tarjeta (Bendo)"`; en órdenes `confirmed` de caja/mesero, botón "Cobrar con tarjeta" que llama la ruta del panel y muestra QR + enlace + botón "Verificar pago" (reconcile). Órdenes web `bendo` muestran "Esperando confirmación de la tarjeta".

## Paso a producción (requiere autorización de Juan Carlos)

1. Staging: credenciales del dashboard preprod, `BENDO_MODE=live`, `BENDO_ENV=staging`; pago aprobado y declinado de punta a punta con la tarjeta de prueba (Mastercard 5200 0000 0000 1096, 01/28, CVV 123, OTP 1234) y webhook recibido en ambos.
2. Enviar a Bendo los `payment_link_id` de las pruebas para certificación.
3. Producción: credenciales de `merchant.bendo.ec`, `BENDO_ENV=production`, pago real de bajo monto.
