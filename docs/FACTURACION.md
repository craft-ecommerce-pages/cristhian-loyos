# Facturación electrónica — módulo del panel

Estado: **implementado y probado en local; no habilitado para emisión real**. El módulo vive aislado en `panel/src/invoices.js` y no se activa solo: el integrador debe llamarlo después de un pago confirmado y aplicar la migración `0007`.

## 1. Alcance y límites

- Propiedad: `panel/src/invoices.js`, `panel/migrations/0007_invoices.sql`, `panel/test/invoices.test.mjs` y este documento.
- No modifica pagos, pedidos, UI, `api.js` ni `index.js`. Las rutas y el webhook se conectan en el handoff (`.ops/invoices-handoff.md`).
- No guarda certificados, claves ni secretos en Git, D1 ni KV.
- No emite por defecto. Sin configuración explícita, la factura queda en `manual`.
- La emisión real exige, además de credenciales, `emitEnabled`, `fiscalValidated` y `productionApproved`; en `production` el adaptador `mock` está prohibido.

## 2. Verificación crítica (10-nov-2026)

Se contrastó la investigación `.ops/facturacion-investigacion.md` con documentación oficial y de proveedor. Resultado:

- El SRI **no certifica software**: valida cada comprobante. “Autorizado por el SRI” en el marketing de un proveedor no equivale a una habilitación formal del sistema.
- La obligación depende del **régimen real del RUC**, no del rubro. RIMPE Negocio Popular puede usar nota de venta; RIMPE Emprendedor debe emitir comprobantes electrónicos. El estado del RUC manda.
- La ficha técnica vigente consultada es la **v2.34** (esquema offline). La clave de acceso tiene 49 dígitos y la firma es XAdES-BES.
- **Ecuafact** documenta sandbox y producción, emisión, consulta de operación y webhooks firmados. Es el adaptador preferente.
- **Factuplan** documenta emisión, consulta de estado e idempotencia por `devReference`; **no documenta firma HMAC** para webhooks. Se implementó como alternativa con token propio y reconsulta obligatoria.
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
| `provider` | `ecuafact` o `factuplan`; en minúsculas |
| `environment` | `sandbox` o `production` |
| `emitEnabled` | `true` solo cuando se autoriza emisión |
| `fiscalValidated` | `true` solo tras validación fiscal del titular |
| `productionApproved` | `true` solo con aprobación explícita para producción |
| `ruc` | RUC de 13 dígitos del emisor |
| `legalName` | Razón social |
| `establishment` | Código de establecimiento, 3 dígitos |
| `emissionPoint` | Punto de emisión, 3 dígitos |
| `establishments` | Lista; más de uno bloquea hasta validación fiscal |
| `currency` | `USD` |
| `pricesIncludeTax` | `true` o `false`; obligatorio |
| `defaultTaxRateBp` | Tarifa por defecto en puntos base (ej. `1500` = 15 %) |
| `taxRatesByCategory` | Mapa categoría → puntos base |
| `allowFinalConsumer` | `true` para permitir consumidor final |
| `finalConsumerMaxCents` | Límite en centavos; por defecto `5000` |
| `paymentMethod` | Dos dígitos; por defecto `01` |
| `supplierRuc` | RUC del proveedor del sistema, si se exige en información adicional |
| `additionalInfo` | Objeto o lista de hasta 20 pares |
| `legacyPricesAreCurrency` | `true` solo para pedidos legacy con precios en dólares |
| `origin` | Origen interno; por defecto `craft-panel` |
| `refreshAfterMs` | Intervalo sugerido de reconsulta; por defecto 60 s |

### 6.2 Secretos del Worker (solo `env`)

| Secreto | Uso |
|---|---|
| `ECUAFACT_API_KEY` | Cabecera `X-Api-Key` de Ecuafact |
| `ECUAFACT_WEBHOOK_SECRET` | Firma HMAC `Ecuafact-Signature` |
| `FACTUPLAN_API_KEY` | Cabecera `X-API-Key` de Factuplan |
| `INVOICE_WEBHOOK_TOKEN` | Token propio para webhooks de Factuplan |

Configurar con `wrangler secret put`; nunca en KV, D1, `.env` versionado, logs ni capturas.

## 7. Adaptadores

### 7.1 Ecuafact (preferente)

- Sandbox: `https://staging-api.mynexusapi.com`.
- Producción: `https://api.mynexusapi.com`.
- Emisión: `POST /v1/contribuyentes/{ruc}/facturas` con `X-Api-Key` e `Idempotency-Key`.
- Seguimiento: `GET /v1/operaciones/{idOperacion}`.
- `issued` solo si el estado es autorizado, `codEstado` 2001 y hay `claveAcceso`.
- `5007` y `5001` se tratan como resultado no confirmado: no se declara `issued` ni `failed`, y no se reemite.
- Webhook: `Ecuafact-Signature` con HMAC-SHA256 sobre `<timestamp>.<cuerpo_crudo>`, tolerancia de 300 s; el evento solo identifica la operación, nunca cambia el estado por sí solo.
- El RIDE requiere `X-Api-Key`; por eso `pdf_url` queda `null` hasta que exista un proxy autenticado.

### 7.2 Factuplan (alternativa)

- Base: `https://api-rest.factuplan.com.ec`.
- Emisión: `POST /v1/developer/invoices` con `X-API-Key` y `x-taxpayer-ruc`.
- Idempotencia: solo por `devReference`; no se envía cabecera de idempotencia.
- Seguimiento: `GET /v1/developer/receipts/{id}/status`.
- API keys: `ak_test_*` en sandbox y `ak_live_*` en producción; el adaptador exige el prefijo correcto.
- `issued` solo con `AUTHORIZED` o `COMPLETED`.
- No hay firma HMAC documentada: el webhook exige `x-webhook-token` y **siempre** reconsulta el comprobante.

### 7.3 Mock

`createMockAdapter` existe solo para pruebas locales. No se selecciona por configuración y está prohibido en producción.

## 8. Webhooks

`handleInvoiceWebhook` recibe `POST`, limita el cuerpo a 8 KB y exige:

- Ecuafact: firma HMAC válida, comparación en tiempo constante y tolerancia temporal.
- Factuplan: token propio válido; aun así, reconsulta obligatoria.

El payload solo se usa para localizar la factura por `idOperacion`/`resourceId` o por referencia externa. El estado final siempre sale de `refreshInvoice`. Un evento no reconocido responde `{received:true, matched:false}` sin cambiar nada.

## 9. Rutas y migración

Rutas que debe montar el integrador:

- `GET /panel/api/invoices/:orderId` → requiere sesión; devuelve solo datos públicos.
- `POST /panel/api/invoices/:orderId/retry` → requiere sesión; acepta `{confirm_new_attempt:true}`.
- `POST /panel/webhooks/invoices` → sin sesión, protegido por firma o token.

La creación y el envío no tienen ruta propia: el POS debe llamar `prepareInvoice()` tras confirmar el pago y, si corresponde, `submitInvoice()`. El detalle exacto está en `.ops/invoices-handoff.md`.

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

Cobertura: borrador neutral, bloqueos fiscales, normalización de configuración, idempotencia y conflicto de snapshot, estados, guardas de producción, payloads de Ecuafact/Factuplan, firma HMAC, webhooks, rutas y datos públicos.

## 12. Activación (checklist)

1. Confirmar con el titular y el contador: régimen RIMPE, obligación de facturar, tarifas, comprador final y establecimiento/punto de emisión. El RUC solo confirma un establecimiento; no asumir seis.
2. Verificar que el proveedor elegido figure en el listado del SRI y que su API permita el RUC del proveedor en información adicional.
3. Contratar sandbox y obtener credenciales; cargarlas con `wrangler secret put`.
4. Aplicar `0007_invoices.sql` en D1 con backup previo.
5. Configurar KV `${slug}:invoices` en `sandbox`, primero con `emitEnabled:false`, y validar un pedido de punta a punta.
6. Probar aceptación, rechazo, timeout, reconsulta y RIDE en sandbox.
7. Solo con aprobación explícita: `environment:"production"`, `fiscalValidated:true`, `productionApproved:true` y `emitEnabled:true`.

## 13. Pendientes verificables

- Régimen y estado del RUC del titular, y si la factura electrónica es obligatoria u opcional.
- Establecimientos y puntos de emisión reales; la investigación inicial no los confirma.
- Credenciales sandbox y smoke real de Ecuafact o Factuplan.
- RIDE: definir proxy autenticado antes de exponer `pdf_url`.
- Contingencia si el SRI o el proveedor caen: quién emite nota de venta y cómo se concilia.
- Decidir si el POS prepara la factura automáticamente al cobrar o solo a pedido del cliente.

## 14. Referencias

- SRI — facturación electrónica: <https://www.sri.gob.ec/facturacion-electronica>
- SRI — RIMPE: <https://www.sri.gob.ec/rimpe>
- SRI — resoluciones: <https://www.sri.gob.ec/doc-gaceta-tributaria?biblioteca=Resoluciones>
- Ecuafact: <https://docsapi.ecuafact.com/>
- Factuplan: <https://factuplan.com.ec/docs/api>
- Investigación base: `.ops/facturacion-investigacion.md` (contrastada; corregida en este documento donde afirmaba seis sedes sin verificación).
