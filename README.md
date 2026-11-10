# Cristhian Loyos — carta digital, caja y cocina

Copia aislada por cliente del motor de catálogo. **No usa recursos, dominios ni secretos de la cuenta Craft.**
Todo vive en la cuenta Cloudflare del cliente: dos Workers (`menu` y `panel`), KV `MENUS`, D1 `DB` y R2 `MEDIA`.

> Estado: implementación y QA local. Sin despliegue ni datos productivos. Los nombres comerciales y las seis sedes son **provisionales** hasta que el titular los confirme.

## Arquitectura

| Pieza | Qué hace |
|---|---|
| `worker/` | Worker de menú: render SSR desde KV, assets `/v1/*` locales y reenvío de `/api/*`, `/media/*`, `/panel/*` al panel por service binding `PANEL`. |
| `panel/` | Worker de administración: panel del dueño, caja, mesero, cocina (KDS), pedidos POS, reportes, facturación y API pública. D1 + R2 + KV. |
| `v1/` | Motor de catálogo/checkout (fuente canónica). `worker/assets/v1/` es una copia fijada que se sincroniza con `worker/sync-v1-assets.sh`. |
| `data/` | Carta unificada (112 productos), configuración, seis sedes y proyección KV. Generado por `scripts/catalog-*.mjs`. |
| `media/` | Fotos de producto y marca. `media/generated/` lo produce el agente de imágenes. |
| `loyalty/` | Código del club (no se despliega en esta cuenta; sin binding `LOYALTY`). |

Documentación de contratos y decisiones: `docs/ARQUITECTURA-CLIENTE.md`, `docs/DESPLIEGUE.md`, `docs/FACTURACION.md`.

## Rutas principales

- Público: `/` (carta), `/?sede=sede-01`…`sede-06`, `GET /api/sedes`, `POST /api/orders`, `GET /api/orders/:id?token=…`, `GET /api/payphone/return`.
- Panel: `/panel` (dueño), `/panel/caja`, `/panel/mesero`, `/panel/cocina?sede=<id>`.
- API autenticada: `/panel/api/pos/orders`, `/panel/api/kitchen/orders`, `/panel/api/reports/sales`, `/panel/api/invoices/:orderId`, `/panel/api/payments/:ref/reconcile`.
- Media: `/media/<key>` desde el binding R2 del panel.

## Puesta en marcha local

```bash
worker/sync-v1-assets.sh                 # copia v1/ → worker/assets/v1/
node --test v1/*.test.cjs
node --test worker/lib.test.mjs
node --test panel/test/*.test.mjs
node scripts/catalog-build.mjs            # regenera la carta base (112 productos, 6 sedes)
node scripts/catalog-media.mjs            # enlaza fotos reales y generadas a data/catalog.json
node scripts/catalog-import.mjs           # valida la carta y regenera data/kv/*
node scripts/seed-client.mjs --dry-run   # plan de carga inicial (no escribe)
```

Despliegue y migraciones: `docs/DESPLIEGUE.md`. Nunca compilar ni desplegar desde `worker`/`craft-vps-core`; todo build en `craft-dev`.

## Configuración y secretos (por nombre, nunca en Git)

- Secrets de GitHub Actions: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CLIENT_SLUG`, `MENU_WORKER_NAME`, `PANEL_WORKER_NAME`, `KV_MENUS_ID`, `D1_DATABASE_NAME`, `D1_DATABASE_ID`, `R2_BUCKET_NAME`, `RATELIMIT_NAMESPACE_ID`, `SESSION_SECRET`, `ADMIN_TOKEN`.
- Secrets del Worker del panel: `SESSION_SECRET`, `ADMIN_TOKEN`; Payphone solo si se activa `PAYPHONE_MODE=live` (`PAYPHONE_TOKEN`), y facturación solo con proveedor validado (`ECUAFACT_*`/`FACTUPLAN_*`).
- `MEDIA_ORIGIN` es opcional: vacío publica rutas relativas `/media/...` servidas por el Worker.

## Límites conocidos

- Sin emisión fiscal real hasta validar RIMPE, establecimiento y proveedor con el titular.
- Payphone en modo `mock` por defecto; el token de pruebas no se versiona.
- Precios estudiantiles de las cartas originales: pendiente de confirmación comercial; no se alteraron importes.
- El nombre comercial es Munch; las seis sedes y direcciones siguen provisionales.
