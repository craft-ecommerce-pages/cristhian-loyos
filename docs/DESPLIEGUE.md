# Despliegue — Cristhian Loyos (cuenta Cloudflare del cliente)

Este repositorio es una copia aislada del motor de catálogo. **No usa recursos ni IDs de la cuenta Craft** y no declara rutas wildcard. Los dos Workers, el KV, el D1 y el R2 viven en la cuenta Cloudflare del cliente; los identificadores se inyectan por variables/secrets y nunca se versionan.

## Componentes

| Pieza | Nombre (ejemplo) | Contenido |
|---|---|---|
| Worker menú | `MENU_WORKER_NAME` (`cl-menu`) | Render del catálogo, JSON desde KV y **assets del motor en `/v1/*` vía Workers Assets**. No depende de `craft-catalog-engine.pages.dev`. |
| Worker panel | `PANEL_WORKER_NAME` (`cl-panel`) | Administración, caja, mesero, cocina y API. D1 + R2 + KV propios; recibe `/panel*` por service binding `PANEL`. |
| KV | `KV_MENUS_ID` | Ambos Workers comparten `MENUS`: `{slug}:config`, `{slug}:productos`, `{slug}:theme`, `domain:{host}`. |
| D1 | `D1_DATABASE_ID` | Solo panel (`DB`). Migraciones en `panel/migrations` (0001–0011; se aplican en orden). |
| R2 | `R2_BUCKET_NAME` | Media del catálogo (`MEDIA`, bucket privado). |
| Rate limit | `RATELIMIT_NAMESPACE_ID` | ID numérico del namespace de la cuenta para `LOGIN_LIMITER`. |

Resolución de host en el Worker de menú (`worker/src/lib.js`):

1. `<worker>.<cuenta>.workers.dev` → `CLIENT_SLUG`.
2. Dominio propio → KV `domain:{host}`; si no hay mapping, `CLIENT_SLUG`.

El panel usa la misma resolución porque comparte `worker/src/lib.js` y recibe el host original por el service binding. En producción el slug sale de `CLIENT_SLUG` o del mapping KV; solo en desarrollo (sin `CLIENT_SLUG`) se usa el primer label de un host con subdominio.

## 1. Prerrequisitos (operador, una sola vez)

- Cuenta Cloudflare del cliente y un API token acotado a esa cuenta con permisos de **Workers Scripts: Edit**, **Workers KV Storage: Edit**, **D1: Edit**, **R2: Edit** y lectura de cuenta. No reutilizar tokens de Craft.
- `CLOUDFLARE_ACCOUNT_ID` de la cuenta del cliente.
- Wrangler 4 en local (`npx wrangler@4 --version`; probado con `4.160.0`).
- Node 22 o superior.

Crear los recursos en la cuenta del cliente (no los crea este repositorio):

```bash
npx wrangler@4 kv namespace create MENUS          # guarda el id (32 hex) → KV_MENUS_ID
npx wrangler@4 d1 create <D1_DATABASE_NAME>       # guarda database_id → D1_DATABASE_ID
npx wrangler@4 r2 bucket create <R2_BUCKET_NAME>
```

El namespace de rate limiting se crea en el dashboard (Workers & Pages → Rate limiting) o vía API de la cuenta; copiar su ID numérico a `RATELIMIT_NAMESPACE_ID`. **PENDIENTE DE VERIFICAR** la ruta exacta del dashboard según el plan contratado.

Opcional, tras el primer despliegue: dominio propio del menú (`menu.<dominio-del-cliente>`) como custom domain del Worker, y dominio público del bucket R2 (`media.<dominio-del-cliente>`) para las imágenes. Nunca un wildcard.

## 2. Secrets y variables de GitHub Actions

En **Settings → Secrets and variables → Actions** de este repositorio:

| Secret | Uso |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token de la cuenta del cliente. |
| `CLOUDFLARE_ACCOUNT_ID` | Cuenta del cliente. |
| `CLIENT_SLUG` | Slug del menú (`cristhian-loyos`); prefijo de las claves KV y `slug` del panel. |
| `MENU_WORKER_NAME` / `PANEL_WORKER_NAME` | Nombres de los dos Workers (distintos). |
| `KV_MENUS_ID` | ID del KV `MENUS`. |
| `D1_DATABASE_NAME` / `D1_DATABASE_ID` | Base D1 del panel. |
| `R2_BUCKET_NAME` | Bucket de media. |
| `RATELIMIT_NAMESPACE_ID` | Namespace del rate limit del login. |
| `SESSION_SECRET` | Firma de sesión del panel (obligatorio para operar). |
| `ADMIN_TOKEN` | API `/admin/*` del panel. |
| `BENDO_CLIENT_ID` | Credencial OAuth `client_credentials` de Bendo del comercio. |
| `BENDO_CLIENT_SECRET` | Secreto OAuth de Bendo. Nunca en Git ni en logs. |

Variables del repositorio (`vars`), todas opcionales; `scripts/deploy-client.sh` valida el formato y aplica el valor por defecto:

| Variable | Defecto | Valores / uso |
|---|---|---|
| `ENGINE_ORIGIN` | `/v1` | `/v1` o una URL `https://` del motor de assets. |
| `MENU_PUBLIC_URL` | vacío | Base pública del menú; habilita el smoke final y los retornos a `/gracias`. |
| `PANEL_PUBLIC_URL` | vacío | Base pública del panel para el smoke final. |
| `BENDO_MODE` | `disabled` | `disabled` · `mock` · `live` (validado con `^(disabled\|mock\|live)$`). |
| `BENDO_ENV` | `staging` | `staging` · `production` (validado con `^(staging\|production)$`); elige idp/API de Geopagos. |
| `BENDO_POINT_OF_SALE` | vacío | uuid del punto de venta. Vacío: el adaptador lo resuelve con `GET /api/v4/points-of-sale` y lo cachea 24 h en KV. |

Los secrets `SESSION_SECRET`, `ADMIN_TOKEN`, `BENDO_CLIENT_ID` y `BENDO_CLIENT_SECRET` se envían con `wrangler secret put` en cada despliegue solo si están definidos; si faltan, se conserva el valor existente en el Worker. En el primer despliegue el panel arranca sin sesión operativa hasta que se aplican los secrets (segundos después).

## 3. Pruebas y build en local (obligatorio antes de publicar)

```bash
# 1) Sincronizar la copia de assets que publica el Worker (v1/ es la fuente canónica).
worker/sync-v1-assets.sh

# 2) Tests
node --test worker/lib.test.mjs
node --test panel/test/*.test.mjs

# 3) Validar plantillas, bindings y empaquetado sin tocar la cuenta
CLIENT_SLUG=... MENU_WORKER_NAME=... PANEL_WORKER_NAME=... \
KV_MENUS_ID=... D1_DATABASE_NAME=... D1_DATABASE_ID=... \
R2_BUCKET_NAME=... RATELIMIT_NAMESPACE_ID=... \
./scripts/deploy-client.sh --dry-run
```

`worker/assets/v1/{catalog.js,catalog.css,geo.js}` es una copia fijada de `v1/`. El script de despliegue compara byte a byte y se detiene si están desincronizados; los tests también lo verifican. **Nunca editar `v1/` en este repositorio**: si el motor publica una versión nueva, se actualiza la copia con `worker/sync-v1-assets.sh` y se revisa el diff.

GitHub Actions **no ejecuta tests ni builds**: solo despliega. Un fallo de tests en local debe bloquear el push a `main`.

## 4. Despliegue

Automático al hacer push a `main`, o manual desde **Actions → Desplegar cliente en Cloudflare → Run workflow** (marcar `dry_run` para validar sin desplegar).

Orden del script (`scripts/deploy-client.sh`), replicable en local con las mismas variables/secrets:

1. Valida variables, formato de IDs y paridad de assets.
2. Renderiza `panel/wrangler.toml` y `worker/wrangler.toml` a `panel/.wrangler/client.toml` y `worker/.wrangler/client.toml` (ignorados por Git). Las plantillas versionadas llevan marcadores `${...}` y **no deben desplegarse directamente**.
3. Aplica migraciones D1 en remoto (`wrangler d1 migrations apply ... --remote`). Wrangler captura un backup automático antes de aplicar; en CI no pide confirmación. Omitir solo con `NO_MIGRATIONS=1` y backup manual previo. La migración `0011_bendo.sql` **reconstruye** `pos_payments` y `pos_orders` (SQLite no permite ampliar un `CHECK`): copia todas las filas con lista explícita de columnas y recrea los índices. Antes de aplicarla en producción, exportar D1 y conservar el punto de restauración que marca el workflow (`wrangler d1 time-travel info`).
4. Despliega **panel primero** (el menú declara el service binding `PANEL`, que debe existir).
5. Actualiza los secrets del panel si vienen en el entorno (después del primer deploy: `secret put` requiere que el Worker exista).
6. Despliega **menú** con sus assets `/v1` y ejecuta el smoke opcional (`MENU_PUBLIC_URL`/`PANEL_PUBLIC_URL`): `GET /` y `GET /v1/catalog.js` en el menú; `GET /panel` en el panel.

El workflow fija `wrangler@4.160.0` (Wrangler 4). Actualizar la versión es un cambio explícito en `.github/workflows/deploy-client.yml` y `scripts/deploy-client.sh`.

## 5. Datos iniciales (después del primer despliegue)

El Worker responde 404 si el KV no tiene datos para `CLIENT_SLUG`. La carga inicial es reproducible y **no destructiva**:

```bash
# Requiere las variables del cliente y panel/.wrangler/client.toml ya renderizado.
CLIENT_SLUG=cristhian-loyos KV_MENUS_ID=... D1_DATABASE_NAME=... R2_BUCKET_NAME=... \
  node scripts/seed-client.mjs

# Validar sin escribir nada:
node scripts/seed-client.mjs --dry-run
```

El script:

1. Valida `data/catalog.json` con el contrato del panel y comprueba seis sedes.
2. Consulta `<slug>:config` y `<slug>:productos` en KV. Un fallo de API detiene la carga; una clave existente nunca se sobrescribe. Si ambas existen, termina sin escribir.
3. Inserta el documento nativo en D1 (`catalogs`) sólo si no hay fila para el slug.
4. Sube `media/products/*` y `media/brand/*` a R2 con prefijo `panel/<slug>/` cuando ambas claves KV están vacías.
5. Publica las claves KV ausentes **al final**, después de preparar D1 y R2. Un reintento completa una clave faltante sin alterar la existente.

El workflow lo ejecuta tras el despliegue salvo que se marque `dry_run` o se desactive `seed_if_empty`.

Para un dominio propio, sembrar el mapping del host:

```bash
npx wrangler@4 kv key put --binding MENUS --remote --config worker/.wrangler/client.toml \
  "domain:menu.<dominio-del-cliente>" "cristhian-loyos"
```

La creación del usuario administrador del panel corresponde al flujo de provisión del panel (D1 `panel_users`), fuera de este documento.

## 6. Verificación

```bash
curl -I https://<menu>.<cuenta>.workers.dev/          # 200 text/html (requiere KV cargado)
curl -I https://<menu>.<cuenta>.workers.dev/v1/catalog.js  # 200 application/javascript (Workers Assets)
curl -I https://<panel>.<cuenta>.workers.dev/panel    # 200/302 según sesión
```

En el HTML del menú, `catalog.css` y `catalog.js` deben apuntar a `/v1/...` del mismo host; no debe aparecer `craft-catalog-engine.pages.dev`.

## 7. Rollback

- **Worker**: `npx wrangler@4 rollback <version-id> --config panel/.wrangler/client.toml` (o `worker/.wrangler/client.toml`). El `--config` se genera con `scripts/deploy-client.sh --dry-run`.
- **D1**: Wrangler guarda backup por migración. Restaurar con Time Travel (`wrangler d1 time-travel info/restore`) **solo con autorización** y tras exportar el estado actual. Tras `0011_bendo.sql`, verificar que `pos_payments`/`pos_orders` conservan todas las filas e índices antes de desplegar el panel.
- Las migraciones son aditivas (`0003`, `0009` y `0010` usan `ALTER TABLE`; `0010` y `0011` reconstruyen tablas copiando filas); no ejecutar `DROP`/`DELETE` manual sin backup.

## 8. Límites y pendientes conocidos

- La media pública se sirve como `/media/<key>` desde el Worker del panel con el binding R2 (`panel/src/media.js`). El Worker de menú reenvía `/api/*` y `/media/*` al panel vía service binding `PANEL`; no se usa `media.craft-systems.com` para media nueva. `MEDIA_ORIGIN` sigue siendo opcional si se configura un dominio de media dedicado.
- El panel concilia pagos con tarjeta (Bendo) `pending/unknown` con la ruta autenticada `POST /panel/api/payments/:ref/reconcile` y con un cron cada minuto (`[triggers]` en `panel/wrangler.toml`) limitado a los links de las últimas 2 h. Nunca recobra.
- Bendo (tarjeta, link hospedado de Geopagos) se activa con `BENDO_MODE` y sus secrets. Sin `BENDO_MODE=mock` ni `BENDO_MODE=live` con ambas credenciales, el pedido web con `payment_method=bendo` responde `503 bendo_no_disponible` y `GET /api/payment-options` no anuncia `bendo`. Con `${{ vars.BENDO_POINT_OF_SALE }}` vacío el punto de venta se resuelve por API y se cachea en KV; el valor vacío nunca se envía como `point_of_sale`. La integración de Payphone está archivada en `integraciones/payphone/` y no se despliega.
- El panel no declara binding `LOYALTY`: las rutas de club responden 503/omitidas hasta que exista ese Worker en la cuenta del cliente.
- Sin `CLIENT_SLUG` correcto o sin claves KV, el sitio responde 404; no hay fallback silencioso a recursos de Craft.
- Este repositorio no crea recursos ni dominios: los IDs llegan por secrets y los custom domains se autorizan en la cuenta del cliente.
- R2 está habilitado en la cuenta del cliente; el bucket inicial es `cristhian-loyos-media`. No reutilizar el R2 de Craft.
