# Arquitectura y contratos — Cristhian Loyos

Estado: implementación en curso. Base de código: instantánea de `origin/master` de `craft-catalog-engine` del 10-11-2026, aislada en este repositorio de cliente. El motor compartido y su `master` no se modifican. Fuente canónica de configuración y catálogo: KV y D1 de la cuenta Cloudflare del cliente; imágenes en su R2. Ninguna dependencia obligatoria de craft-crm ni de recursos de la cuenta Craft.

## Decisiones

- Dos Workers del cliente: `menu` sirve catálogo y assets locales; `panel` sirve administración, caja, mesero, cocina y API. Service binding `PANEL` desde menú; ambos comparten KV `MENUS`; panel usa D1 `DB` y R2 `MEDIA`. Sin wildcard de dominio.
- Seis sedes como IDs estables; QR por sede con `?sede=<id>`. La sede se propaga y congela en cada pedido. Geolocalización es ayuda opcional y no puede cambiar silenciosamente una sede elegida por QR. Si no hay sede validada se pide seleccionar antes de ordenar.
- Precios y montos en centavos enteros para cobro y facturación; precio se recalcula desde el catálogo vigente en servidor al crear pedido. No confiar en `precio` ni `total` del navegador. Snapshot de líneas y monto en D1.
- Una carta única para seis sedes, con categorías de reporte inmutables `sushi`, `fastfood`, `tradicional`, `postres` congeladas en cada línea de pedido. El reporte usa únicamente pedidos cobrados, sumas en centavos enteros de líneas, filtros sede/fecha y total conciliado con ventas; excluye rechazados y anulados.
- La comanda llega a cocina solo tras cobro confirmado. Una orden `pending` puede recibir cambios; pago en efectivo se confirma por operador autorizado; el pago con tarjeta (Bendo) se confirma contra su API usando monto, moneda, link y referencia. Retorno/reintentos idempotentes. La pantalla KDS filtra por sede y registra confirmación de impresión, con reimpresión explícita.
- Facturación es adaptador aparte del pago. Se prepara contrato y estado, sin declarar factura emitida hasta confirmación del proveedor/SRI. Esquema fiscal RIMPE, tarifas y establecimientos requieren validación con proveedor y titular antes de habilitar emisión real.
- El menú muestra pedidos en su propia UI. No fuerza WhatsApp ni Craft CRM para registrar orden. El panel puede editar catálogo y subir media a R2 de la cuenta cliente.

## Contratos de API (extensión aditiva)

Errores: `{error: string}` con HTTP 400 validación, 401 sesión, 403 permiso, 404 inexistente, 409 conflicto, 502 proveedor. JSON en mutaciones, sesión HttpOnly Secure SameSite; acceso público solo a creación/estado de pedido con token opaco por pedido. Consultas listadas con `limit` máximo 50.

- `GET /api/sedes` → `{sedes:[{id,nombre,direccion,universidad,activa}]}`.
- `POST /api/orders` `{sede_id, items:[{product_id,qty,variant_id?,note?}], customer?, idempotency_key}` → `201 {id,number,status,total_cents,currency,order_token}`. En reintento igual devuelve mismo resultado; misma clave con cuerpo distinto → 409. El servidor valida catálogo, disponibilidad y precios. Fuente `web`.
- `GET /api/orders/:id?token=...` → estado mínimo para comprador; nunca PII de otros pedidos.
- `POST /panel/api/mesero/orders` `{sede_id,items,...,idempotency_key}` → pedido `pending` fuente `caja`, misma validación de precios que el público. Operador solo puede operar sus sedes.
- `POST /panel/api/orders/:id/confirm` → confirma disponibilidad y monto; no libera comanda.
- `POST /panel/api/orders/:id/pay-cash` `{idempotency_key}` → `paid` y comanda una vez.
- `POST /panel/api/orders/:id/bendo` `{idempotency_key}` → `{payment_url,payment_id}`; se guarda el intento antes de llamar a Bendo. `GET /api/bendo/return` reconsulta el link en servidor y compara id, monto y moneda; no cobra por segunda vez ni publica comanda duplicada. Estado `unknown` exige conciliación, nunca asumir rechazo por timeout.
- `GET /panel/api/kitchen/orders?sede_id=...&since=...` → solo pagadas/no anuladas para esa sede, polling con cursor; `POST /panel/api/kitchen/orders/:id/print` `{idempotency_key}` registra acuse. UI `/panel/cocina?sede=<id>` muestra comanda e impresión en la tablet.
- `GET /panel/api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&sede_id=...` → `{groups:[{category,orders,quantity,total_cents}],total_cents,by_sede:[...]}` calculado desde snapshots de líneas de pedidos pagados. El total por grupos debe igualar el total cobrado de los pedidos incluidos.
- `GET /panel/api/invoices/:orderId` → `{status:'pending'|'issued'|'failed'|'manual',reference?,pdf_url?}`; `POST /panel/api/invoices/:orderId/retry` solo sesión autorizada. Adaptador `emit(invoiceDraft)` recibe snapshots enteros y devuelve referencia/estado verificados. Sin proveedor configurado queda pendiente/manual.

## Partes paralelas y propiedad de archivos

- Infra: `worker/*` (excepto catálogo), `.github/workflows/*`, scripts de deploy, `wrangler` del panel. No editar `panel/src/index.js`.
- POS/pago: `panel/src/orders.js`, `panel/src/api.js`, `panel/src/index.js`, `panel/src/bendo.js`, `panel/migrations/0006_*`, tests propios. La integración de Payphone quedó archivada en `integraciones/payphone/` (fuera de `panel/`, `worker/` y `v1/`). Integra rutas nuevas; conserva rutas existentes. No editar páginas UI.
- UI: `panel/src/mesero.js`, `panel/src/page.js`, `panel/src/kitchen.js` y CSS específico. Usa contratos API anteriores. No editar backend.
- Catálogo/media: `data/*`, `media/*`, herramientas de importación/QR, `v1/catalog.js` solo si el contrato público ya está disponible. Los archivos fuente de la media son referencia; no incluir RUC/documentos personales en Git. No publicar marcas hasta confirmación de alcance.
- Reportes: `panel/src/reports.js`, `panel/migrations/0008_*` y pruebas; el integrador une la ruta. No editar UI ni backend de pedidos.
- Facturación: `panel/src/invoices.js`, `panel/migrations/0007_*`, investigación/documentación. El integrador une rutas tras POS. No manejar certificados ni claves en Git.

Bloqueantes: confirmar carta/marca y seis sedes para cargar catálogo definitivo; cuenta Cloudflare y permisos/IDs para desplegar; credenciales de Bendo para el smoke de integración; proveedor y condiciones fiscales antes de emisión real. Integración y QA siguen después de las partes paralelas.
