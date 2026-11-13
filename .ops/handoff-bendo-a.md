# Handoff — Bendo parte A (adaptador)

Rama: `agent/bendo-a-20261113`. Sin push, sin despliegue y sin llamadas reales a Bendo:
todas las pruebas usan `globalThis.fetch` simulado y los dobles de `panel/test/helpers.mjs`.

## Archivos

- `panel/src/bendo.js` (nuevo): adaptador completo del contrato de `docs/PAGOS-BENDO.md`.
- `panel/test/bendo.test.mjs` (nuevo): 15 pruebas, sin red.
- Nada más se tocó: ni `orders.js`, ni `api.js`, ni `index.js`, ni migraciones, ni UI.

## Exportes (tal cual el contrato)

```js
bendoMode(env)                                     // "disabled" | "mock" | "live"
bendoAvailable(env)                                // mock, o live con BENDO_CLIENT_ID + BENDO_CLIENT_SECRET
bendoOutcome(link, payment)                        // approved | rejected | pending | mismatch
startBendo(request, env, site, session, encodedId, body)
startPublicBendo(request, env, site, encodedId, body)
handleBendoReturn(request, env, site)              // GET, también con ?format=json
handleBendoWebhook(request, env, site)             // POST
handleBendoMock(request, env)                      // GET, solo BENDO_MODE=mock
reconcileBendo(env, site, session, payment)        // payment ya cargado por ref
reconcilePendingBendo(env, now = Date.now())       // cron → {checked, settled, pending}
```

Reutiliza de `orders.js` exactamente los helpers del contrato (`createPaymentAttempt`,
`setPaymentPending`, `attachProviderId`, `failPayment`, `markPaymentUnknown`,
`settlePaymentApproved`, `settlePaymentRejected`, `posOrderForAction`, `posOrderRow`,
`posPaymentByKey`, `posPaymentByRef`, `orderToken`), además de `json`/`error` de
`contract.js` y `timingEqual` de `auth.js`.

## Comportamiento relevante para el ensamblador

- **Token OAuth** `client_credentials` nuevo por flujo, nunca persistido; timeout de 10 s
  (`AbortSignal.timeout`) en todas las llamadas.
- **`point_of_sale`**: `env.BENDO_POINT_OF_SALE` si existe; si no, el primer `uuid` de
  `GET /api/v4/points-of-sale`, cacheado 24 h en KV `bendo:pos:<staging|production>`
  (`expirationTtl`). `BENDO_ENV=production` cambia auth y API; cualquier otro valor usa staging.
- **Link**: `POST /api/v4/payments/links` con una sola línea
  `{description:"Pedido Munch #<n>", quantity:1, unit_price: total_cents/100, external_reference}`,
  `currency:"USD"`, `point_of_sale`, `webhook_version:"V4"`, `expires_in_minutes:30`,
  `successful_payment_quantity_limit:1`, `webhook_url` con `p=<provider_ref>&s=<firma>`,
  `redirect_on_*` al return y `external_data` con `order_id`/`ref`. **Sin `merchant_id` ni `taxes`.**
  El `id` de la respuesta se guarda en `pos_payments.provider_id` y
  `transaction_data.checkout_url` (exige `https://`) en `pos_payments.url`.
- **Inicio**: el intento se crea en D1 **antes** de llamar a Bendo. Misma clave ⇒ mismo pago:
  si ya está `paid` responde `{...,payment_url:null,status:"paid",total_cents}`; si sigue
  `pending/unknown` con URL, la reutiliza; otra clave sobre la orden pagada ⇒
  `409 orden_ya_pagada`; clave de otro proveedor ⇒ `409 idempotencia_conflicto`. Respuesta
  `{order_id, payment_id, payment_url, status, total_cents}`.
  Caja (`startBendo`): solo pedidos `caja`/`mesero` en `confirmed` (un pedido `web` o en
  `pending` ⇒ `409 estado_invalido`). Web (`startPublicBendo`): `source=web`,
  `payment_method=bendo` y `order_token` válido (si no, `404 pedido_no_existe`).
  Ambas rutas exigen `bendoAvailable` (si no, `503 bendo_no_disponible`) y moneda `USD`.
- **Return**: idempotente; terminal `paid/rejected` redirige sin volver a consultar. Web con
  `MENU_PUBLIC_URL` válido ⇒ `.../gracias?pago=<estado>&pedido=&token=`; si no, y siempre en
  caja, `/panel?pago=...&pedido=...`. `Accept: application/json` o `?format=json` ⇒ JSON.
  `mismatch` ⇒ `422 pago_alterado` (igual que Payphone); link aún pendiente ⇒ 200
  `{status:"pendiente"}`; error de red/5xx ⇒ `502` y pago `unknown` (`bendo_timeout`).
- **Webhook**: firma propia `HMAC-SHA256(SESSION_SECRET, "bendo-webhook:"+ref)` en 32 hex
  (`crypto.subtle`, comparada con `timingEqual`). Firma inválida, sin firma, ref desconocida o
  pago sin `provider_id` ⇒ `200 {ok:true}` sin ninguna llamada a Bendo. Válida ⇒ reconsulta y
  aplica; `200 {ok:true}`. Error con Bendo ⇒ `503 {ok:false}` y el pago queda `unknown`.
  Cuerpo acotado a 16 KB y nunca registrado (tampoco se usa).
- **Mock** (`BENDO_MODE=mock`): la URL de cobro es
  `<origin>/api/bendo/mock?p=<ref>&resultado=aprobado`; `handleBendoMock` guarda
  `bendo:mock:<ref>` (`aprobado|rechazado|timeout`) y redirige al return. El mock nunca usa red.
- **Conciliación**: `reconcileBendo` reconsulta sin ventana temporal; `approved/rejected`
  responden `{status, order_id, order_status}`, `mismatch` ⇒ `422`, red ⇒ `502 pago_pendiente`.
  `reconcilePendingBendo` toma `provider='bendo'`, `status IN ('pending','unknown')`,
  `provider_id` presente, `created_at` de las últimas 2 h y pedidos `pending/confirmed`,
  máximo 20 por pasada.
- **Aplicación del resultado**: aprobado ⇒ `settlePaymentApproved` (una sola comanda),
  rechazado ⇒ `settlePaymentRejected("El pago con tarjeta no fue aprobado.")`,
  `mismatch` ⇒ `markPaymentUnknown(...,"bendo_alterado")`.

## Rutas que debe montar el ensamblador (no las toqué)

| Método y ruta | Handler |
|---|---|
| `GET /api/payment-options` (añadir `bendo: bendoAvailable(env)`) | `api.js` |
| `POST /api/orders/:id/bendo` | `startPublicBendo` |
| `POST /panel/api/orders/:id/bendo` | `startBendo` (mismo `handlePosApi`, sesión de caja/panel) |
| `GET /api/bendo/return` | `handleBendoReturn` |
| `POST /api/bendo/webhook` | `handleBendoWebhook` |
| `GET /api/bendo/mock` | `handleBendoMock` |
| `POST /panel/api/payments/:ref/reconcile` | despachar por `payment.provider`: `bendo` → `reconcileBendo(env, site, session, payment)` |
| cron | `reconcilePendingBendo(env)` junto a `reconcilePendingPayments(env)` |

`startBendo`/`startPublicBendo` ya validan modo, cuerpo (`idempotency_key`), token del pedido
y estado; el ensamblador solo debe leer el JSON y pasar `site`, `session` y el `encodedId`.
La parte B debe añadir `bendo` a `PAYMENT_METHODS` y usar `bendoAvailable`; el ciclo de imports
`orders.js ↔ bendo.js` es seguro porque solo se invocan funciones en tiempo de petición.

## Pruebas

`node --test panel/test/bendo.test.mjs` → 15/15 en verde. Suite completa
`node --test v1/*.test.cjs worker/lib.test.mjs panel/test/*.test.mjs` → **284/284**, sin fallos.

Cubren: aprobado con return y webhook (una sola comanda), rechazo por `NOT_AVAILABLE`,
`DENIED` con link `PENDING`, mismatch por id/monto/`REFUNDED`, timeout ⇒ `unknown`,
idempotencia del inicio, firma inválida ⇒ 200 sin *fetch*, error de Bendo en webhook ⇒ 503,
payload sin `merchant_id` con `point_of_sale`/USD/`unit_price`, staging vs production y caché
del punto de venta, mock sin red, conciliación manual y cron de 2 h.

`panel/test/bendo.test.mjs` incluye `habilitarBendoEnD1()` con el comentario
**“eliminar cuando exista 0011 (parte B)”**: reconstruye `pos_orders` y `pos_payments` con
`bendo` en sus `CHECK`. Cuando la migración 0011 exista, el ensamblador debe borrar esa
función y su llamada en `bendoEnv()`.

## Pendientes y notas

- **Migración 0011 (parte B)**: sin ella `pos_payments.provider='bendo'` y
  `pos_orders.payment_method='bendo'` fallan por CHECK; las pruebas lo rodean solo en memoria.
- **Doble link en un fallo entre POST y `setPaymentPending`**: si el proceso muere tras crear
  el link y antes de guardar la URL, el reintento con la misma clave crea otro link y
  `attachProviderId` falla (ids distintos) ⇒ `502 pago_proveedor`; nunca se cobra dos veces
  ni se marca pagado, pero el link huérfano queda en Bendo y el pago en `unknown` para el cron.
- **Pago `failed` reintentado con la misma clave**: `setPaymentPending` solo acepta
  `created/pending`, así que el intento conserva `failed` aunque el link se cree; el return y
  el webhook lo concilian igual (el `provider_id` sí queda guardado).
- **`startPublicBendo` también opera en mock** (no solo `live`), porque
  `GET /api/payment-options` anuncia `bendo` en mock y el checkout web debe poder abrir el
  simulador; el guard duro es `bendoAvailable`.
- Este repo no tiene `graphify-out/`, así que no ejecuté `graphify update`. Si se quiere el
  grafo, hace falta inicializarlo (`/graphify .`) con autorización.

## Desviaciones del contrato (con motivo)

1. **`REFUNDED` se evalúa antes que `APPROVED`**. Los viñetas del contrato listan primero
   `approved` y después el `mismatch` por `REFUNDED`; con un pago `REFUNDED` y otro
   `APPROVED` en el mismo link, seguir el orden literal marcaría pagado un importe
   reembolsado. Se antepone el reembolso (revisión manual) por seguridad del dinero; el resto
   del orden (id/monto/moneda → aprobado → `NOT_AVAILABLE`) es literal.
2. **Mock `rechazado` ⇒ `link.status = "NOT_AVAILABLE"`**. `resultado=rechazado` debe producir
   `rejected`, y la única condición de rechazo del contrato es ese estado del link; un
   `DENIED` real con link `PENDING` sigue simulándose en las pruebas con fetch falso, porque
   el mock no expone un resultado `pendiente` (el contrato solo define tres resultados).
3. **Cuerpo de webhook mayor de 16 KB ⇒ `413 cuerpo_muy_grande`**. El contrato fija el límite
   pero no el código; solo ocurre con firma válida (antes, cualquier firma inválida responde
   200 sin trabajo).
4. **Caja solo para pedidos no web** (`source` `caja`/`mesero`). El contrato dice “Pedido de
   caja/mesero `confirmed`”; un pedido web se cobra por su propia ruta pública, no desde caja.
