# Facturación electrónica — módulo del panel

Estado: **proveedor elegido: Facturón** (decisión de Juan Carlos, 13-nov-2026). Implementado y probado en local; **no habilitado para emisión real** hasta cargar credenciales y la configuración en KV. Tras cada cobro confirmado, `orders.js#afterPaid` prepara la factura y, si la configuración lo permite, la envía. Los adaptadores Ecuafact y Factuplan se retiraron (quedan en el historial de Git).

## 1. Alcance y límites

- Propiedad: `panel/src/invoices.js`, `panel/migrations/0007_invoices.sql`, `panel/test/invoices.test.mjs` y este documento.
- La factura es derivada: nunca revierte ni bloquea el cobro, la orden o la comanda.
- No guarda certificados, claves ni secretos en Git, D1 ni KV.
- No emite por defecto. Sin configuración explícita, la factura queda en `manual`.
- La emisión real exige, además de credenciales, `emitEnabled`, `fiscalValidated` y `productionApproved`; en `production` el adaptador `mock` está prohibido.

## 2. Verificación crítica (10-nov-2026)

Se contrastó la investigación `.ops/facturacion-investigacion.md` con documentación oficial y de proveedor. Resultado:

- El SRI **no certifica software**: valida cada comprobante. “Autorizado por el SRI” en el marketing de un proveedor no equivale a una habilitación formal del sistema.
- La obligación depende del **régimen real del RUC**, no del rubro. RIMPE Negocio Popular puede usar nota de venta; RIMPE Emprendedor debe emitir comprobantes electrónicos. El estado del RUC manda.
- La ficha técnica vigente consultada es la **v2.34** (esquema offline). La clave de acceso tiene 49 dígitos y la firma es XAdES-BES.
- Proveedores evaluados: Ecuafact y Factuplan (adaptadores retirados) y **Facturón** (elegido el 13-nov-2026: documenta idempotencia, estado SRI en vivo, webhooks HMAC y RIDE por API).
- La investigación inicial mencionaba seis sedes. **No está confirmado**: el RUC del titular indica un solo establecimiento. El módulo no asume seis sedes ni crea establecimientos; si la configuración declara más de uno, el borrador queda bloqueado hasta validación fiscal.
- No se pudo hacer un smoke real: no hay credenciales ni sandbox contratado. Todo lo que depende de la cuenta del cliente queda **PENDIENTE DE VERIFICAR**.

## 3. Contrato neutral `invoice-draft.v1`

`invoiceDraftFromOrder({ order, config, now })` recibe un pedido **ya pagado** y devuelve un borrador neutral, sin llamar a ningún proveedor. Nunca inventa datos fiscales.

| Campo | Contenido |
|---|---|
| `schema` | `invoice-draft.v1` |
| `orderId` | ID del pedido; clave de idempotencia lógica |
| `date` | Fecha fiscal `DD/MM/AAAA` en hora de Ecuador; usa `paid_at` si existe |
| `documentType` | `01` (factura) |
| `currency` | `USD`; otra moneda bloquea el borrador |
| `taxMode` | `inclusive`, `exclusive` o `unresolved` |
| `customer` | Tipo e identificación, nombre, correo, dirección y teléfono |
| `lines[]` | Código, descripción, cantidad, precio unitario, descuento, base, IVA, tarifa y código SRI |
| `totals` | `subtotalCents`, `taxCents`, `discountCents`, `totalCents` en centavos enteros |
| `taxes[]` | Agrupación por código/tarifa SRI con base y valor |
| `payment` | Método y monto en centavos |
| `establishment`, `emissionPoint` | Códigos de 3 dígitos, obligatorios |
| `additionalInfo[]` | Hasta 20 pares; incluye `Pedido` y, si se configura, `RUC proveedor sistema` |
| `blockedReasons[]` | Si hay alguno, `ready` es `false` y no se puede emitir |
| `warnings[]` | Avisos que no bloquean, p. ej. `fiscal_validation_pending` |

Reglas de cálculo:

- Todos los montos son centavos enteros. No se convierten dólares legacy salvo `legacyPricesAreCurrency: true`.
- `pricesIncludeTax` debe estar definido; si falta, se bloquea con `tax_mode_not_configured`.
- Las tasas son configurables. No hay IVA fijo en el código.
- En modo IVA incluido, el descuento del SRI se expresa sobre la base imponible; el descuento comercial se convierte a base antes de calcular el impuesto.
- Códigos SRI soportados: `0 % → 0`, `5 % → 5`, `8 % → 8`, `12 % → 2`, `13 % → 10`, `14 % → 3`, `15 % → 4`.
- Un total distinto al de las líneas se reporta como `total_mismatch`; no se corrige en silencio.
- Consumidor final (`07`) solo si está permitido y el total no supera `finalConsumerMaxCents` (USD 50 por defecto). Sobre el límite se bloquea con `final_consumer_over_limit`.

Bloqueos frecuentes: `order_not_paid`, `order_lines_missing`, `line_price_missing`, `line_quantity_invalid`, `tax_rate_not_configured`, `tax_rate_unsupported`, `currency_not_supported`, `establishment_not_configured`, `multiple_establishments_require_fiscal_validation`, `customer_identification_missing`, `total_cents_missing`, `total_mismatch`.

## 4. Estados y transiciones

| Estado | Significado |
|---|---|
| `pending` | Borrador listo y configuración completa; pendiente de envío |
| `manual` | Falta proveedor, credenciales, configuración fiscal o aprobación; requiere acción humana |
| `submitted` | El proveedor recibió el comprobante; el SRI aún no confirma autorización |
| `issued` | Solo con evidencia de autorización del SRI: clave de acceso de 49 dígitos o número de autorización |
| `failed` | Rechazo final del proveedor o conflicto de idempotencia; exige corrección o conciliación |

Flujo normal: `pending → submitted → issued`. Un `200` del proveedor **no** equivale a `issued`: la confirmación se obtiene consultando la operación. Un timeout, 429 o 5xx deja el estado sin confirmar (`provider_uncertain`) y conserva la misma clave; nunca se marca `failed` por un timeout.

Un rechazo final pasa a `failed`. Un nuevo intento solo se permite con corrección explícita (`forceNewAttempt` o `confirm_new_attempt: true`); entonces se incrementa `attempt`, cambia la clave de idempotencia y la referencia externa (`ORD-<id>-R2`).

Un conflicto de idempotencia pasa a `failed` con `idempotency_conflict` y exige conciliación; no se reemite solo.

## 5. Idempotencia y concurrencia

- Una sola fila por `(slug, order_id)`: `UNIQUE (slug, order_id)` en D1.
- Clave de proveedor: `invoice:<slug>:<orderId>:<attempt>`.
- Referencia externa: `ORD-<orderId>` y `ORD-<orderId>-R<n>` desde el segundo intento.
- Hash estable del borrador (`draft_hash`) sin `generatedAt`: si el snapshot cambia para el mismo pedido, se devuelve `invoice_conflict` (409) en lugar de emitir dos veces.
- Candado de emisión en D1 (`provider_status = 'submitting'`, 5 minutos): evita llamadas simultáneas duplicadas al proveedor.
- Reintentar un timeout reutiliza la misma clave; es el proveedor quien deduplica.

## 6. Configuración

### 6.1 KV `${slug}:invoices` (sin secretos)

| Clave | Valor |
|---|---|
| `provider` | `facturon` (cualquier otro valor = sin proveedor) |
| `environment` | `sandbox` o `production`; debe coincidir con el ambiente SRI de la empresa en Facturón |
| `companyId` | `id` de la empresa emisora (`GET /companies`) |
| `emissionPointId` | `id` del punto de emisión (`GET /companies` → `branches[].emission_points[]`) |
| `emitEnabled` | `true` solo cuando se autoriza emisión |
| `fiscalValidated` | `true` solo tras validación fiscal del titular |
| `productionApproved` | `true` solo con aprobación explícita para producción |
| `ruc` | RUC de 13 dígitos del emisor (referencia; Facturón lo toma de la empresa) |
| `legalName` | Razón social |
| `establishment` | Código de establecimiento, 3 dígitos (debe coincidir con la serie de `emissionPointId`) |
| `emissionPoint` | Punto de emisión, 3 dígitos |
| `establishments` | Lista; más de uno bloquea hasta validación fiscal |
| `currency` | `USD` |
| `pricesIncludeTax` | `true` o `false`; obligatorio |
| `defaultTaxRateBp` | Tarifa por defecto en puntos base (ej. `1500` = 15 %) |
| `taxRatesByCategory` | Mapa categoría → puntos base |
| `allowFinalConsumer` | `true` para permitir consumidor final |
| `finalConsumerMaxCents` | Límite en centavos; por defecto `5000` |
| `paymentMethod` | Forma de pago SRI para métodos sin mapeo; por defecto `01`. Mapeo fijo: efectivo `01`, transferencia `20`, tarjeta (Bendo link o datáfono) `19` |
| `supplierRuc` | RUC del proveedor del sistema, si se exige en información adicional |
| `additionalInfo` | Objeto o lista de hasta 20 pares |
| `legacyPricesAreCurrency` | `true` solo para pedidos legacy con precios en dólares |
| `origin` | Origen interno; por defecto `craft-panel` |
| `refreshAfterMs` | Intervalo sugerido de reconsulta; por defecto 60 s |

### 6.2 Secretos del Worker (solo `env`)

| Secreto | Uso |
|---|---|
| `FACTURON_API_KEY` | `Authorization: Bearer fec_…`. Alcances mínimos: `documents:read`, `documents:write`, `customers:read`, `customers:write` |
| `FACTURON_WEBHOOK_SECRET` | Secreto `whsec_…` del webhook (se muestra una sola vez en Facturón) |

Se cargan como secrets de GitHub (`deploy-client.yml` → `put_secret`) o con `wrangler secret put`; nunca en KV, D1, `.env` versionado, logs ni capturas. Si la API key expira (30/90/365 días), Facturón responde `expired_api_key` y la factura queda `manual` con `provider_configuration`.

## 7. Adaptador Facturón

Referencia: <https://facturon.ec/docs/api> y `openapi.yaml` 1.0.0. Base `https://facturon.ec/api/v1/ext`.

- **Un solo host para pruebas y producción.** El ambiente SRI lo fija la empresa emisora en Facturón (Configuración → Datos del emisor: `1` pruebas, `2` producción). Cada documento devuelto trae `environment`; si no coincide con `environment` de la configuración, la factura pasa a `failed` con `environment_mismatch`, conserva el id del documento y exige conciliación. **La misma API key emite en producción si la empresa está en producción**: durante las pruebas, la empresa debe estar en ambiente de pruebas.
- **Cliente:** `customer_id` es obligatorio. Se busca con `GET /customers/lookup?identification=` y, si da 404, se crea con `POST /customers` (si la creación choca con otra simultánea, se vuelve a buscar). Consumidor final: tipo `07`, identificación `9999999999999`, hasta USD 50.
- **Emisión:** `POST /documents` con `Idempotency-Key` = `invoice:<slug>:<pedido>:<intento>` y `external_reference` = `ORD-<pedido>` (máx. 64). Facturón no recalcula: se envían `subtotal_<tarifa>`, `total_tax`, `total_discount`, `total`, `payment_methods` e ítems con `tax_code` `2`, `tax_percentage_code`, `tax_base` y `tax_value` ya calculados en centavos. La tarifa 14 % no tiene campo de subtotal en Facturón: el borrador se bloquea antes de llamar.
- **Respuestas:** `201` → `submitted` (o `authorized`); `422 validation_error` → `failed` con el mensaje del SRI; `409 idempotency_key_reused` → conflicto (conciliar); `409 idempotency_in_progress`, `429`, `5xx` o red → incierto, se reintenta con la misma clave; `409 send_failed`, `401`, `403` (incluye `plan_limit_reached`) → `manual`.
- **Estado:** `GET /documents/{id}/status`. `authorized` + `authorization_number` → `issued`; `draft/processing/signed/sent` (incluida contingencia) → `submitted`; `rejected/failed` → `failed` con `sri_messages`; `voided` → anulada.
- **RIDE:** `GET /panel/api/invoices/:pedido/ride` (con sesión) redirige a la URL temporal de 30 min que da `GET /documents/{id}/ride?url=1`. La API key nunca llega al navegador.
- Límite de 60 peticiones/minuto en plan Negocio: una factura usa 2–4 llamadas (búsqueda, alta del cliente si es nuevo, emisión, estado).

### 7.1 Mock

`createMockAdapter` existe solo para pruebas locales. No se selecciona por configuración y está prohibido en producción.

## 8. Webhooks y conciliación

`POST /panel/webhooks/invoices` (registrar en Facturón → Configuración → Webhooks, eventos `document.*`). Límite de 64 KB. Exige:

- `X-Webhook-Signature` = `hex(HMAC-SHA256(FACTURON_WEBHOOK_SECRET, "{X-Webhook-Timestamp}.{cuerpo crudo}"))`, comparada en tiempo constante, y `X-Webhook-Timestamp` a menos de 5 minutos.
- `webhook.test` responde `{received:true, test:true}` sin tocar nada.

El payload solo localiza la factura por `data.document_id` o `data.external_reference`; el estado final siempre sale de `GET /documents/{id}/status`. Reintentos de Facturón con el mismo `X-Webhook-Id` son inocuos porque solo disparan una reconsulta.

El cron del panel (cada minuto) reconsulta hasta 10 facturas `submitted` de los últimos 7 días y reintenta, con la misma clave, las `pending` inciertas de las últimas 23 h (la idempotencia de Facturón dura 24 h). Así el estado se resuelve aunque el webhook no llegue.

## 9. Rutas y migración

Rutas montadas:

- `GET /panel/api/invoices/:orderId` → requiere sesión; devuelve solo datos públicos.
- `POST /panel/api/invoices/:orderId/retry` → requiere sesión; acepta `{confirm_new_attempt:true}`.
- `GET /panel/api/invoices/:orderId/ride` → requiere sesión; redirige al PDF del RIDE de una factura `issued`.
- `POST /panel/webhooks/invoices` → sin sesión, protegido por firma HMAC.

La creación y el envío no tienen ruta propia: `orders.js#afterPaid` llama `prepareInvoice()` tras confirmar el pago y, si corresponde, `submitInvoice()`.

Migración `panel/migrations/0007_invoices.sql`:

- `invoices`: una fila por pedido, snapshot, hash, estados, campos del proveedor/SRI y montos nullable para borradores bloqueados.
- `invoice_events`: bitácora de transiciones; no copia snapshots ni identificaciones.
- No guarda secretos ni certificados.

## 10. Seguridad y privacidad

- Los secretos solo viven en `env`; no se escriben en D1, KV, logs ni Git.
- El snapshot contiene la identificación del comprador y no se expone en `publicInvoice`.
- No imprimir RUC, cédulas, claves de acceso ni cabeceras de autenticación en logs.
- Comparaciones de firma/token en tiempo constante.
- Webhook con límite de tamaño y validación de firma antes de parsear.
- Idempotencia y candado de emisión para no duplicar comprobantes ni consumir cupo.
- `issued` exige evidencia de autorización; nunca se infiere de un `200` del proveedor.

## 11. Pruebas

```bash
node --test panel/test/invoices.test.mjs
```

Cobertura: borrador neutral, bloqueos fiscales, normalización de configuración, idempotencia y conflicto de snapshot, estados, guardas de producción, payload y respuestas de Facturón (cliente, montos, errores, ambiente), cron de conciliación, firma HMAC, webhooks, RIDE, rutas y datos públicos.

## 12. Activación (checklist)

1. Confirmar con el titular y el contador: régimen RIMPE, obligación de facturar, tarifa de IVA (`defaultTaxRateBp`, `pricesIncludeTax`), formas de pago y establecimiento/punto de emisión. El RUC solo confirma un establecimiento; no asumir seis.
2. Contratar en Facturón un plan con API y webhooks (Negocio o superior). Cargar la firma electrónica (P12) de la empresa **en Facturón**, con la empresa en **ambiente de pruebas**.
3. Crear una API key con los cuatro alcances de 6.2 y registrar el webhook `https://<dominio>/panel/webhooks/invoices`. Guardar `FACTURON_API_KEY` y `FACTURON_WEBHOOK_SECRET` como secrets de GitHub.
4. Obtener `companyId` y `emissionPointId` con `GET /companies`.
5. Configurar KV `${slug}:invoices` con `provider:"facturon"`, `environment:"sandbox"`, ids, tarifas y `emitEnabled:true`. Probar: consumidor final, cédula, RUC, pedido con tarjeta, rechazo (p. ej. identificación inválida), webhook de prueba y RIDE.
6. Solo con aprobación explícita: cambiar la empresa a producción en Facturón **y a la vez** `environment:"production"`, `fiscalValidated:true`, `productionApproved:true` en KV. Si solo se cambia uno de los dos, las facturas quedan en conciliación (`environment_mismatch`) o bloqueadas.

## 13. Pendientes verificables

- Régimen y estado del RUC del titular, y si la factura electrónica es obligatoria u opcional.
- Establecimientos y puntos de emisión reales; la investigación inicial no los confirma.
- La caja y el modo mesero no capturan datos fiscales: los pedidos de mostrador salen a consumidor final (≤ USD 50) o quedan `manual` si superan el límite. La web sí los captura en el checkout.
- No hay vista de facturas en el panel: el estado se consulta por API (`GET /panel/api/invoices/:pedido`) o en Facturón.
- Anulación: Facturón no anula ante el SRI por API; se anula en el portal del SRI o con nota de crédito.
- Contingencia si Facturón cae más de 23 h: las facturas inciertas quedan `pending` y se reintentan a mano con `retry`.

## 14. Referencias

- SRI — facturación electrónica: <https://www.sri.gob.ec/facturacion-electronica>
- SRI — RIMPE: <https://www.sri.gob.ec/rimpe>
- SRI — resoluciones: <https://www.sri.gob.ec/doc-gaceta-tributaria?biblioteca=Resoluciones>
- Facturón API: <https://facturon.ec/docs/api> (OpenAPI: <https://facturon.ec/docs/openapi.yaml>)
- Investigación base: `.ops/facturacion-investigacion.md` (contrastada; corregida en este documento donde afirmaba seis sedes sin verificación).
