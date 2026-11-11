# Informe de QA integral — integrador Munch

Fecha: 2026-11-11 · Worktree: `munch-wt-integrador` · Rama: `agent/munch-integrador-20261110`
Alcance: integración local de las siete ramas, sincronización de assets, migración `0010`, QA de flujos web/caja y revisión de media.
**No se desplegó nada ni se escribió en Cloudflare (KV, R2, D1 o Workers).** El segundo QA y la publicación quedan a cargo del arquitecto con autorización de Juan Carlos.

## Semáforo ejecutivo

| Área / requisito | Estado | Evidencia |
|---|---|---|
| Cherry-pick de las siete ramas | 🟢 | 8 commits integrados sin conflictos (7 ramas, pendiente-b con 2 commits) |
| Assets `/v1` sincronizados con la fuente | 🟢 | `worker/sync-v1-assets.sh`; worker 21/21 incluye prueba de sincronía |
| Suite completa worker + v1 + panel | 🟢 | 269/269 pruebas (21 + 61 + 187) |
| Contrato backend/frontend (`billing`, errores, estado de pago) | 🟢 | Pruebas `pedido`, `catalog-orders`, `ui-page`, `ui-mesero` |
| Efectivo: pendiente en caja y recibo verdadero | 🟢 | Flujo Playwright local + API; `/gracias` recargable |
| Transferencia sin config oficial | 🟢 | Deshabilitada en UI y API; no se inventan cuentas |
| Transferencia con config simulada | 🟢 | Flujo local con cuenta/WhatsApp de QA; caja confirma y recibo cambia a pagado |
| Payphone aprobado / rechazado / `unknown` | 🟢 | E2E local con proveedor simulado; sin doble comanda |
| `ready` como `paid + ready_at` | 🟢 | API devuelve `ready`; D1 conserva `paid` + `ready_at`; filtro/KDS/reimpresión probados |
| Caja/mesero sin fallback a efectivo | 🟢 | `ui-page` y `ui-mesero`: error honesto ante 404/405 de `pay-transfer` |
| Select de sede a 390 px | 🟢 | Captura local `03-checkout-390.png` y `07-checkout-transferencia-390.png` |
| WhatsApp manual de comprobantes | 🟡 | Funciona con config simulada; en producción falta número oficial |
| Comanda 58/80 mm | 🟡 | Columnas 32/48 y CSS `@page` probados; **no hay prueba física de impresora** |
| Migración `0010` | 🟢 local | Copia con datos, conteos, CHECK de `transfer` y rollback restaurado |
| Media: 26 IDs aplicados | 🟡 | 26/26 aplicados y verificados; **2 IDs bloqueados** por descripción ambigua |
| Graphify | ⚪ | No existe `graphify-out/` en este worktree; no se generó grafo |

## 1. Integración y commits

| Commit integrado | Origen | Contenido |
|---|---|---|
| `3e14478` | `3127e83` | Media sushi |
| `9f2e280` | `fa81d6a` | Media resto |
| `dfd25df` | `5baa0f2` | Media pendiente A |
| `c57d7e8` | `af20625` | Media pendiente B |
| `7d01247` | `37e63bb` | Handoff media B |
| `3a61537` | `c8ec54c` | Checkout web + datos fiscales |
| `bdc5e4b` | `06e564b` | Pedido web + transferencia + listo |
| `04b03ab` | `34d37c0` | Caja: cobro, listo, WhatsApp e impresión |

Cambios propios de integración (sin commit al cierre de este informe):

- `panel/src/orders.js`: `payment_status`, `payment_message`, `retryable`, `items`, `payment_method` en `GET /api/orders/:id`; `transferInfo` exige cuenta **y** WhatsApp oficiales.
- `v1/catalog.js`: consume `transfer_details`; re-normaliza transferencia; mapea `datos_fiscales_requeridos`/`datos_fiscales_invalidos` con `campo`; estados reales en `/gracias`.
- `panel/src/page.js` y `panel/src/mesero.js`: eliminado el fallback silencioso `/pay-transfer` → `/pay-cash`.
- `panel/test/*` y `v1/catalog-orders.test.cjs`: pruebas nuevas/actualizadas.
- `data/catalog.json`, `data/kv/productos.json`, `data/media-map.json`, `media/generated/manifest.json` y `media/products/*.webp` regenerados.
- `worker/assets/v1/{catalog.js,catalog.css,geo.js}` sincronizados.

## 2. Pruebas automáticas

Comando y resultado final (log en `.ops/evidencia-tests.log`):

| Suite | Comando | Resultado |
|---|---|---|
| Worker | `cd worker && node --test *.test.mjs` | 21/21 |
| Motor v1 | `cd v1 && node --test *.test.cjs` | 61/61 |
| Panel | `cd panel && node --test test/*.test.mjs` | 187/187 |
| **Total** | | **269/269** |

Pruebas específicas relevantes:

- `panel/test/pedido.test.mjs`: datos fiscales, conflicto de idempotencia, transferencia con sede autorizada, `paid → ready`, Payphone aprobado/rechazado/`unknown` y `/gracias`.
- `panel/test/payphone.test.mjs`: Prepare sin IVA, mock sin red, retorno idempotente, importe alterado, timeout `unknown`, conciliación y ausencia de mock sin modo explícito.
- `panel/test/ui-page.test.mjs`: caja sin fallback, transferencia confirmada, listo, `wa.me` manual y comanda antes del acuse.
- `panel/test/ui-mesero.test.mjs`: mesero sin fallback y error honesto.
- `panel/test/caja-ticket.test.mjs`: comanda 58/80 mm (32/48 columnas) y sin PII fiscal.
- `v1/catalog-orders.test.cjs`: checkout nativo, errores fiscales por campo, transferencia con/sin config y recibo por token.

## 3. QA local de flujos (servidor Node + Playwright)

Se levantó un servidor local que combina el Worker de menú, el panel y los assets reales en `http://127.0.0.1:8765` (sin Cloudflare) y una variante con transferencia simulada en `8766`. Capturas en `/tmp/opencode/munch-qa/`.

| Flujo | Resultado observado |
|---|---|
| Menú a 390 px | 112 tarjetas, sin errores de consola |
| Checkout a 390 px | Select de food truck, datos fiscales, métodos de pago; `03-checkout-390.png` |
| Efectivo | Pedido `pending`, recibo “Pago pendiente en caja”; recarga conserva estado y no queda en “Verificando” |
| Transferencia sin config | Opción “Transferencia (no disponible)”; API `transfer:false`; sin cuentas inventadas |
| Transferencia con config QA | Cuenta y WhatsApp visibles, `wa.me` con pedido/sede/total; caja confirma y recibo pasa a “Transferencia verificada” |
| Payphone aprobado | Retorno 302 a `/gracias?pago=aprobado`; `paid`; 1 comanda |
| Payphone rechazado | Retorno 302 a `pago=rechazado`; `rejected`; 0 comandas |
| Payphone timeout | Retorno 302 a `pago=pendiente`; `payment_status=unknown`; `retryable=false`; 0 comandas |
| `ready` | API `status=ready`, `payment_status=paid`, `ready_at` con valor; recibo “¡Tu pedido está listo!” |
| Caja sin `pay-transfer` | Error honesto, sin llamada a `pay-cash` (prueba UI) |

Log Payphone local: `/tmp/opencode/munch-qa/payphone-e2e.log`.

```
[approved] prepare=ok retorno=302 destino=aprobado order=paid payment_status=paid retryable=false comandas=1
[rejected] prepare=ok retorno=302 destino=rechazado order=rejected payment_status=rejected retryable=false comandas=0
[timeout]  prepare=ok retorno=302 destino=pendiente order=pending payment_status=unknown retryable=false comandas=0
```

Capturas locales (no versionadas):

- `01-menu-390.png`, `02-carrito-390.png`
- `03-checkout-390.png`, `04-checkout-lleno-390.png`
- `05-gracias-efectivo-390.png`, `06-gracias-recarga-390.png`
- `07-checkout-transferencia-390.png`, `08-gracias-transferencia-390.png`
- `09-gracias-transferencia-pagada-390.png`, `10-gracias-listo-390.png`
- `contact-sheet.jpg` (hoja de contacto de los 26 IDs de media)

## 4. Contrato backend ↔ frontend verificado

- `GET /api/orders/:id?token=...` devuelve `status`, `payment_method`, `payment_status`, `payment_message`, `retryable`, `items`, `sede`, `total_cents`, `paid_at`, `ready_at`, sin PII fiscal ni de contacto.
- `payment_status` se deriva del estado real del pedido y del último `pos_payments`; `unknown` **nunca** se degrada a rechazo; `retryable` solo con intento `failed`.
- Errores fiscales reales: `datos_fiscales_requeridos` y `datos_fiscales_invalidos` con `campo`. El frontend los pinta junto al campo y conserva compatibilidad con códigos legacy (`cliente_requerido`, `telefono_invalido`, etc.).
- `GET /api/payment-options` devuelve `{cash, transfer, transfer_details, payphone}`. Transferencia solo con `bank_transfer` completo **y** WhatsApp oficial (`location.telefono_principal` o `whatsapp_number`).
- `ready` se expone solo en API; en D1 se conserva `status='paid'` + `ready_at`. Filtros, KDS y reimpresión usan `ready_at`.
- Payphone público exige `PAYPHONE_MODE=live` + token; el mock solo existe con modo explícito. No hay cobro real en QA.

## 5. Migración `0010`

Prueba local en copia SQLite (`node:sqlite`) con migraciones `0001`–`0009` y filas existentes de `pos_orders`/`pos_payments` (incluido un pago `payphone` en `unknown`). Log: `.ops/evidencia-migracion-0010.log`.

- Antes: 2 pedidos, 2 pagos.
- Después: 2 pedidos, 2 pagos; filas y estados preservados.
- Columnas nuevas: `billing_document_type`, `billing_document_number`, `billing_email`, `billing_address`, `ready_at`.
- CHECK de `pos_payments` acepta `transfer`; se recrearon índices `pos_payments_ref`, `pos_payments_order` y `pos_orders_slug_ready`.
- Rollback probado restaurando el export en una base `0001`–`0009`: 2/2 filas.
- **No se aplicó en D1 remota.**

## 6. Media

Detalle completo en `.ops/informe-integracion-media.md`.

- 28 IDs evaluados; **26 aplicados** en `catalog.json`, `productos.json` y `media/products/`.
- Hashes de origen y publicado documentados; difieren por el reencode de `catalog-media.mjs` (WebP 1200 px, calidad 82).
- Hoja de contacto revisada visualmente: combos de sushi y platos tradicionales coinciden con nombre/descripción.
- **Bloqueos:** `tradicional-tortillas-mixta` (conserva `tortillas.webp`) y `tradicional-papa-mixta` (conserva `papa-rellena.webp`). No se inventó composición ni foto. No se declara QA visual completo.

## 7. Riesgos

1. **Migración destructiva controlada:** `0010` recrea `pos_payments` (`DROP` + `RENAME`). Exige export/backup previo y verificación de conteos; si falla a mitad, restaurar el export.
2. **Transferencia deshabilitada en producción:** la config actual no tiene `bank_transfer` ni WhatsApp oficial. Es el comportamiento correcto; habilitarla sin datos oficiales sería un riesgo financiero.
3. **Payphone de producción:** `PAYPHONE_MODE` y `PAYPHONE_TOKEN` no están configurados en este worktree. Verificar en el entorno real antes de publicar.
4. **Impresión física:** solo se validaron CSS `@page` y columnas 32/48. No se probó hardware ni ancho real de papel.
5. **Consumidores externos de `ready`:** en D1 el estado sigue siendo `paid`; cualquier reporte externo debe leer `ready_at`, no `status='ready'`.
6. **Media bloqueada:** dos IDs mantienen fotos compartidas anteriores; pueden verse repetidas junto a sus variantes.
7. **Assets duplicados:** `v1/` es la fuente y `worker/assets/v1/` la copia publicada; hay que ejecutar `sync-v1-assets.sh` en cada cambio o la prueba del Worker falla.

## 8. Bloqueos para Juan Carlos

1. **Cuenta bancaria oficial + WhatsApp de comprobantes.** Sin ambos, transferencia queda deshabilitada. Config esperada:
   ```json
   {
     "bank_transfer": {
       "bank": "…", "account_type": "…", "account_number": "…",
       "holder": "…", "note": "opcional"
     },
     "whatsapp_number": "593…"
   }
   ```
   También se acepta `location.telefono_principal`.
2. **Composición real de `tradicional-tortillas-mixta` y `tradicional-papa-mixta`.** Confirmar rellenos para generar/publicar foto propia.
3. **Impresoras reales 58/80 mm.** Validar en hardware antes de afirmar impresión física.
4. **Credenciales/modo Payphone de producción.** Confirmar `PAYPHONE_MODE=live` y token antes de habilitar tarjeta.
5. **Autorización de migración D1 y despliegue.** Solo Juan Carlos autoriza `master` y producción.

## 9. Plan de publicación (no ejecutado)

Orden propuesto desde `craft-dev`, con autorización explícita:

1. **Congelar** el worktree y confirmar el segundo QA del arquitecto.
2. **Backup D1:** export completo antes de migrar; guardar conteos de `pos_orders`, `pos_payments`, `pos_comandas` y `order_seq`.
3. **Aplicar `0010`** en D1 remota; verificar columnas, CHECK de `transfer`, índices y conteos. Si falla, restaurar el export.
4. **Backup KV:** exportar `cristhian-loyos:config`, `:productos` y `:theme`; guardar copia local.
5. **Publicar media:** subir los 26 `media/products/*.webp` al prefijo `/media/panel/cristhian-loyos/products/` en R2, con hash y `Cache-Control` inmutable; verificar 200 y tipo `image/webp`.
6. **Actualizar KV:** `:productos` con `data/kv/productos.json`; `:config` solo con la cuenta/WhatsApp oficiales si Juan Carlos los entrega; `:theme` si cambió.
7. **Desplegar panel** (incluye `MENU_PUBLIC_URL` y migración ya aplicada) y después el **Worker de menú** con el service binding `PANEL`; publicar assets `/v1`.
8. **Smoke tests:** `payment-options`, pedido efectivo, transferencia deshabilitada o habilitada según config, Payphone aprobado/rechazado/unknown, recarga `/gracias`, caja, listo, comanda 58/80.
9. **Rollback:** versión anterior de ambos Workers, restauración del export D1 y de las claves KV; R2 conserva las imágenes anteriores hasta confirmar.

## 10. Conclusión

La integración local está **funcionalmente verde** en código, contrato, pruebas y flujos simulados. No se declara QA completo por tres razones explícitas: los dos IDs de media bloqueados, la transferencia sin datos oficiales y la ausencia de prueba física de impresión. La migración `0010` está validada en copia local con rollback, pero **no aplicada** en D1 remota. No se realizó ningún despliegue ni escritura remota.
