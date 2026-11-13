# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Responder y documentar en español. Leer también `AGENTS.md` (reglas de backup en `.ops/backups/`, handoffs en `.ops/`) y `docs/ARQUITECTURA-CLIENTE.md` antes de editar.

## Qué es

Munch (cliente Cristhian Loyos): carta digital, caja, mesero, cocina (KDS), reportes y facturación para seis sedes. Copia **aislada** de `craft-catalog-engine` en la cuenta Cloudflare del cliente: nunca usar recursos, IDs, dominios ni secretos de Craft, ni editar el motor compartido. Sin dependencias npm: JS plano, Node 22+ y Wrangler 4 (`4.160.0` fijado en CI y en `scripts/deploy-client.sh`).

## ⚠️ Push a `main` despliega a producción

`.github/workflows/deploy-client.yml` se dispara con **cada push a `main`**: migraciones D1 remotas, deploy de ambos Workers y seed (no destructivo). CI **no ejecuta tests**: correrlos en local antes de cualquier push. No pushear a `main` sin autorización explícita de Juan Carlos.

## Comandos

```bash
node --test v1/*.test.cjs worker/lib.test.mjs panel/test/*.test.mjs   # suite completa
node --test panel/test/caja.test.mjs                                   # un archivo
node --test --test-name-pattern="<texto>" panel/test/pos.test.mjs     # un test
worker/sync-v1-assets.sh            # obligatorio tras tocar v1/catalog.js|catalog.css|geo.js
./scripts/deploy-client.sh --dry-run   # valida plantillas/bindings (requiere variables del cliente)
node scripts/catalog-build.mjs && node scripts/catalog-media.mjs && node scripts/catalog-import.mjs  # regenerar data/
node scripts/seed-client.mjs --dry-run
```

`loyalty/` tiene tests propios (`node --test loyalty/test/*.test.mjs`), pero no se despliega en esta cuenta.

## Arquitectura

- **Dos Workers**: `worker/` (menú: SSR de `template.html` desde KV, sirve `/v1/*` con Workers Assets) reenvía `/api/*`, `/media/*` y `/panel/*` por service binding `PANEL` a `panel/` (dueño, caja, mesero, cocina, POS, reportes, facturación, pago con tarjeta Bendo; usa D1 `DB` y R2 `MEDIA`). Ambos comparten el KV `MENUS` (`{slug}:config`, `{slug}:productos`, `{slug}:theme`, `domain:{host}`). El panel se despliega antes que el menú.
- **Resolución de host** (`worker/src/lib.js`, también usada por el panel): workers.dev → `CLIENT_SLUG`; dominio propio → KV `domain:{host}`.
- **`wrangler.toml` son plantillas** con `${...}`; `deploy-client.sh` las renderiza en `*/.wrangler/client.toml`. Nunca desplegar las plantillas directamente ni añadir `routes`/wildcards.
- **`v1/` → `worker/assets/v1/`**: `v1/` es la fuente; la copia debe coincidir byte a byte (lo verifican el deploy y los tests). `docs/DESPLIEGUE.md` dice no editar `v1/`, aunque el historial ya tiene cambios propios del cliente (checkout fiscal, tarjeta Bendo); si se edita, sincronizar siempre.
- **Rutas del panel**: el enrutado vive en `panel/src/index.js`; cada módulo (`orders.js`, `caja.js`, `kitchen.js`, `invoices.js`, `reports.js`, `bendo.js`…) expone handlers. Errores JSON `{error}` con 400/401/403/404/409/502.
- **Migraciones D1**: `panel/migrations/NNNN_*.sql`, se aplican en orden y en remoto en cada deploy. Solo aditivas; añadir la siguiente numeración, nunca editar una ya aplicada.
- **Tests**: `panel/test/helpers.mjs` emula D1 con `node:sqlite` (aplica todas las migraciones) y KV en memoria; los tests de UI importan las páginas como strings.

## Invariantes de dominio

- Dinero en **centavos enteros**; el servidor recalcula precios desde el catálogo vigente y guarda un snapshot de las líneas en D1. Nunca confiar en `precio`/`total` del navegador.
- La sede (`sede-01`…`sede-06`) se congela en cada pedido; la geolocalización nunca cambia una sede elegida por QR.
- La comanda llega a cocina **solo tras cobro confirmado**. Pagos y creación de pedidos son idempotentes (`idempotency_key`; misma clave con otro cuerpo → 409). Un pago con tarjeta en estado `unknown` exige conciliación; nunca asumirlo rechazado.
- Las categorías de reporte (`sushi`, `fastfood`, `tradicional`, `postres`) se congelan por línea; los reportes suman solo pedidos cobrados.
- Facturación: `issued` solo con autorización confirmada del proveedor/SRI. La emisión real está desactivada. Plan de emisión directa al SRI: `docs/FACTURACION-SRI-DIRECTO.md`; la firma/P12 solo como secreto del Worker del cliente.
- Pago con tarjeta por Bendo: la fuente de verdad es `GET /links/{id}`; el retorno del navegador y el webhook solo disparan la verificación. Payphone quedó archivado en `integraciones/payphone/` (no se despliega) y `payphone` solo sigue válido en BD para filas históricas.

## Datos y media

`data/catalog.json` es la carta unificada (112 productos); `data/kv/*` es su proyección a KV, generada por `scripts/catalog-*.mjs` (no editarla a mano). La corrección de fotos ya publicadas va por `data/media-sync.json` + `scripts/sync-media.mjs` (workflow manual `sync_media`, con respaldo en `.backup/`).
