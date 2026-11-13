# Payphone — integración archivada

Estado: **retirada del código desplegado el 2026-11-13** por decisión de Juan Carlos.
Munch ya no usa Payphone: el cobro con tarjeta se hace con Bendo (link hospedado).
Este directorio conserva la implementación y su test para poder reutilizarla en
otros clientes o reintegrarla si algún día se vuelve a contratar Payphone.

Nada de `integraciones/` se importa desde `panel/`, `worker/` ni `v1/`. Los tests de
este directorio **no forman parte de la suite** (`node --test panel/test/*.test.mjs`).
Las rutas de importación se dejaron relativas a `panel/` para facilitar la
reintegración manual; el test archivado necesita que se restauren los enganches.

## Qué hacía

- Botón de pago **Prepare + V2/Confirm** de Payphone (`https://pay.payphonetodoesposible.com`).
- Guardaba el intento en D1 **antes** de llamar al proveedor (idempotente por clave).
- El comprador volvía a `/api/payphone/return`; el servidor ejecutaba V2/Confirm y
  comparaba `clientTransactionId`, `transactionId`, moneda USD y monto en centavos.
  Nunca marcaba pagado sin esa verificación.
- Un timeout o error de red dejaba el pago en `unknown` (nunca rechazo) para
  conciliación autenticada o por cron.
- Modo `mock` para pruebas locales sin red; `live` solo con token.

## Rutas que exponía

| Ruta | Auth | Comportamiento |
|---|---|---|
| `POST /api/orders/:id/payphone` `{order_token, idempotency_key}` | token del pedido | Solo pedidos web con `payment_method=payphone` y modo `live`. Devuelve `{order_id, payment_id, payment_url, status, total_cents}`. |
| `POST /panel/api/orders/:id/payphone` `{idempotency_key}` | sesión de caja/dueño | Cobro de un pedido de caja/mesero con el mismo flujo. |
| `GET /api/payphone/return?id=&clientTransactionId=` | pública | Ejecuta V2/Confirm, aplica el resultado y redirige a `/gracias` (web) o `/panel` (caja). `?format=json` devuelve JSON. |
| `GET /api/payphone/mock?p=<ref>&resultado=aprobado\|rechazado\|timeout\|importe` | solo `PAYPHONE_MODE=mock` | Simulador local del retorno. |
| `POST /panel/api/payments/:ref/reconcile` | sesión | Conciliación por referencia; dentro de la ventana de 5 min reintenta Confirm y fuera de ella deja el pago `unknown` para revisión manual. |
| Cron cada minuto | — | `reconcilePendingPayments`: concilia pagos `payphone` en `unknown` con `provider_id` dentro de la ventana de 5 min (máx. 50). |

## Variables y secrets

| Clave | Tipo | Uso |
|---|---|---|
| `PAYPHONE_MODE` | var | `disabled` (defecto) · `mock` · `live`. Sin modo, la pasarela no se anuncia ni se inicia. |
| `PAYPHONE_TOKEN` | secret | Token del botón de pago. Obligatorio en `live`. |
| `PAYPHONE_STORE_ID` | var opcional | `storeId` que se envía en Prepare si existe. |
| `PAYPHONE_BASE_URL` | var opcional | Base alternativa del API (por defecto `https://pay.payphonetodoesposible.com`). |

## Puntos de enganche retirados (para reintegrar)

Archivos y funciones que contenían la integración. Al reintegrar hay que volver a
añadir cada punto y actualizar los tests equivalentes.

- `panel/src/api.js`
  - `handlePublicApi`: import de `startPublicPayphone`, `handlePayphoneReturn`,
    `handlePayphoneMock`; propiedad `payphone` en `GET /api/payment-options`;
    ruta `POST /api/orders/:id/payphone`; `GET /api/payphone/return`;
    `GET /api/payphone/mock`.
  - `handleApi`: `payphone` en el regex de acciones POS.
  - `handlePosApi`: `payphone` en el regex de acciones, despacho a
    `startPayphone` y lista de rutas que responden `pedido_no_existe`.
  - `reconcilePayment`: despacho a `reconcilePayphone`.
  - `meData`: campo `payment_mode` (lo consumía el botón de `page.js`).
- `panel/src/index.js`
  - import de `reconcilePendingPayments` y su `ctx.waitUntil(...)` en `scheduled`.
- `panel/src/orders.js`
  - `PAYMENT_METHODS`: `payphone` como método aceptado en pedidos nuevos.
  - `createPosOrder`: bloque `503 payphone_no_disponible` para pedidos web.
  - `publicPaymentMessage`: textos específicos de Payphone.
  - `getPosOrderStatus`: `payphone` en la condición de `retryable`.
  - Los helpers de pago (`createPaymentAttempt`, `posPaymentByRef`,
    `settlePaymentApproved`, etc.) **permanecen** y los reutiliza Bendo.
- `panel/src/page.js`
  - `POS_PAYMENT`: etiqueta activa (ahora es `tarjeta Payphone (histórico)`).
  - `posOrderCard`: botón "Payphone" para pedidos de caja/mesero y el aviso
    "Esperando confirmación de Payphone" (ahora el aviso es genérico de tarjeta).
  - `payPosOrder`: rama de pasarela (`/payphone`, apertura de `payment_url` y
    textos de simulación).
- `v1/catalog.js`
  - `cardPaymentMethod`, `paymentStartPath` y `orderPaymentLabel`: ramas Payphone.
  - `EN`: textos en inglés de Payphone.
  - `orderErrorMessage`: `payphone_no_disponible`.
  - `updatePaymentHint`: pista del método.
  - `setupNativeCheckout`: habilitación de la opción `payphone`.
  - `orderRecord`, `statusSnapshot`, `methodLabel` y el bloque `thanks` de
    `/gracias`: etiquetas y estado de Payphone.
  - `retryThanksPayment`: mensaje de error específico.
  - `initThanks`: inferencia `payment_method='payphone'` desde el retorno.
- `worker/template.html`: `<option value="payphone" …>` del checkout.
- `worker/src/lib.js`: solo comentarios; `receiptRedirect` se conserva porque es
  genérico para cualquier retorno antiguo con `pedido`/`token`.
- `scripts/deploy-client.sh`: `PAYPHONE_MODE` (export y validación) y
  `put_secret PAYPHONE_TOKEN`.
- `panel/wrangler.toml`: var `PAYPHONE_MODE`, comentarios del cron y de secrets.
- `.github/workflows/deploy-client.yml`: `PAYPHONE_TOKEN` y `PAYPHONE_MODE`.
- Tests que dependían del flujo: `panel/test/pedido.test.mjs`,
  `panel/test/pos.test.mjs`, `panel/test/ui-page.test.mjs`,
  `panel/test/bendo-rutas.test.mjs`, `panel/test/bendo-datos.test.mjs`,
  `v1/catalog-orders.test.cjs`, `v1/bendo.test.cjs` y `worker/lib.test.mjs`.

## Qué NO se tocó

- Las migraciones `0006`, `0009`, `0010` y `0011` conservan `'payphone'` en sus
  `CHECK`: las filas históricas siguen siendo válidas en D1 y no se creó ninguna
  migración nueva.
- `docs/PAGOS-BENDO.md` y `docs/CIERRE-CAJA.md` mantienen las menciones históricas
  al proveedor como contexto del contrato de pagos y del arqueo.
