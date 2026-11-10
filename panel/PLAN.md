# Menú SaaS — panel edge + cobro por suscripción (plan de trabajo paralelo)

Decidido por el operador (2026-10-23): menú + tarjeta de fidelidad a **USD 15/mes o 120/año**, **cobro del
primer mes ANTES de construir** (garantía de devolución), piloto Ecuador (PayPhone). Los tenants nuevos
nacen con **panel en el edge**; los menús existentes siguen con el panel del CRM.

Frontera: **craft-crm decide quién paga** (venta, PayPhone, renovaciones, archivo); **el edge es el producto**
(menú, panel del restaurante, conteo, fidelidad). Al "Entregar", el catálogo del tenant pasa a ser propiedad del
edge (KV) y el CRM **deja de sincronizarlo** (`edge_owned_at`).

```
Bot vende → generar_link_pago → PayPhone (sale) → bot pide correo → Hermes construye (POST /catalog/onboard, igual que hoy)
→ operador revisa → botón "Entregar" → CRM: edge_owned_at, craft-panel /admin/{slug}/owner, tier mensual/anual,
  WhatsApp: link menú + link panel + usuario/contraseña + QR + tutorial
Mensualidad: CycleWorker (existente) → recordatorio con métricas (/admin/{slug}/stats) → vencido → ArchiveCatalog
```

## Workstreams (cada uno en su worktree/rama y SOLO toca sus archivos)

| Id | Agente | Repo / rama | Archivos |
|---|---|---|---|
| A1 | Codex gpt-5.6-terra | craft-catalog-engine `feat/panel-a1` | `panel/src/auth.js`, `panel/src/api.js`, `panel/src/admin.js`, `panel/test/a1.test.mjs` |
| A2 | DeepSeek flash | craft-catalog-engine `feat/panel-a2` | `panel/src/page.js`, `panel/test/a2.test.mjs` |
| B  | DeepSeek flash | craft-catalog-engine `feat/panel-b` | `panel/src/events.js`, `v1/catalog.js` (solo el beacon), `panel/test/b.test.mjs`, `v1/beacon.test.cjs` |
| C1 | Codex gpt-5.6-terra | craft-crm `feat/menu-saas-c1` | `internal/menusaas/*` (salvo `contract.go`), `internal/billing/*` (cobro de venta), `internal/catalogsync/service.go` + `internal/superadmin/catalog_archive.go` (guarda `edge_owned`), `migrations/000094_menu_saas.*` |
| C2 | DeepSeek flash | craft-crm `feat/menu-saas-c2` | `internal/bot/agency/*` (tools), `frontend/src/**` (botones) |
| ENS | Codex gpt-5.6-sol | ramas base | merge + integración + tests verdes + primera QA |

Contrato YA escrito (NO cambiar sin avisar al integrador): `panel/src/index.js`, `panel/src/contract.js`,
`panel/migrations/0001_init.sql`, `panel/test/helpers.mjs`, `panel/wrangler.toml`,
`worker/src/lib.js#panelBinding` y, en craft-crm, `internal/menusaas/contract.go`.
Tests: `node --test panel/test/` · `node --test worker/lib.test.mjs` · `cd craft-crm && go test ./internal/...`
(SOLO en craft-dev; NUNCA en worker ni VPS). Sin dependencias npm nuevas en el Worker.

---

## Edge — Worker `craft-panel` (A1, A2, B)

Llega por **service binding** desde `craft-menus` para `{slug}.craft-systems.com/panel*` (host original intacto, igual
que `/club` → `craft-loyalty`). `/admin/*` entra por workers.dev con `Bearer ADMIN_TOKEN` (lo llama craft-crm).
Tenant = `resolveSlug(host)`. Bindings: `MENUS` (KV, lectura/escritura), `DB` (D1 `craft-panel`), `MEDIA` (R2
bucket `craft-crm`, público en `https://media.craft-systems.com/`), `LOYALTY` (service), `LOGIN_LIMITER`.
Secrets: `SESSION_SECRET`, `ADMIN_TOKEN`, `LOYALTY_ADMIN_TOKEN`.

### Auth (A1)
- Contraseña: PBKDF2-SHA256 **100000 iteraciones** (máximo de workerd), salt 16 B, formato
  `pbkdf2$100000$<salt_b64>$<hash_b64>`. Comparación de tiempo constante.
- Cookie `panel_s` = `<b64url(email)>.<pwd_ver>.<hmac>` con HMAC-SHA256(`${slug}:${email}:${pwd_ver}`, SESSION_SECRET).
  `Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. Cambiar contraseña incrementa `pwd_ver`
  ⇒ invalida todas las sesiones. Sesión de otro slug ⇒ 401.
- CSRF: toda mutación exige `content-type: application/json` (upload: header `x-panel: 1`). SameSite=Strict.
- `LOGIN_LIMITER.limit({key: slug+":"+ip})` en login y reset ⇒ `429 demasiados_intentos`.
- Reset: token aleatorio 32 B (b64url) → se guarda SOLO su sha256 en `panel_resets`, 30 min, un uso.

### API del panel (`/panel/api/*`, JSON, sesión por cookie salvo login/reset). Errores: `{error:"<codigo>"}`
- `POST /login {email,password}` → `200 Me` + cookie · `401 credenciales_invalidas`
- `POST /logout` → `204` (borra cookie)
- `GET /me` → `200 Me`
- `POST /password {current,new}` → `204` + cookie nueva · `400 password_corta` (<8) · `401 credenciales_invalidas`
- `POST /reset {token,new}` → `200 Me` + cookie · `400 token_invalido` (vencido/usado/inexistente)
- `GET /products` → `{categories:[...config.categories], products:[productEntry]}`
- `POST /products {nombre,precio,precio_promo?,descripcion?,categorias?,imagenes?,disponible?}` → `201 productEntry`
- `PUT /products/:id {mismos campos}` → `200 productEntry` (**merge**: conserva `variantes`, `tipo`, `sku`, `costo_empaque`
  y cualquier campo desconocido) · `404 no_existe`
- `DELETE /products/:id` → `204`
- `GET /store` · `PATCH /store {whatsapp_number,hours,location,logo,hero_title,brand_sub}` → solo esos campos se
  mezclan en `{slug}:config`; cualquier otro ⇒ se ignora.
- `POST /upload` (cuerpo = bytes `image/webp|jpeg|png`, ≤ 2 MB, header `x-panel: 1`) → `{url}`; R2 key
  `panel/{slug}/{uuid}.{ext}`. El navegador ya manda webp ≤ 1200 px (A2 redimensiona con canvas).
- `GET /stats?days=30` → `Stats` (B implementa `statsFor`; A1 solo lo expone)
- `GET /loyalty` · `PATCH /loyalty` → administra todos los campos editables de
  `loyalty/src/contract.js#normalizeConfig` salvo `radius_m` y `phone_country`: `enabled`, `games`,
  `prizes` (incluye `stock` y `expires_days`), `lose_weight`, `stamps_goal`, `stamps_reward`
  (incluye `expires_days`), `cooldown_hours`, `review_url` HTTPS, `terms` (≤1000) y `pin`.
  `stamps_reward_label` sigue aceptado por compatibilidad. Cada campo debe sobrevivir igual a la
  normalización o responde `400 {error:"campo_invalido",campo}`. `pin` (4 dígitos) ⇒
  `staff_pin_hash = sha256hex(`${slug}:${pin}`)`; nunca devuelve el hash.
- Proxy de club (sesión obligatoria y slug de `site.slug`): `GET /loyalty/stats?days`,
  `GET /loyalty/customers?q&limit&offset`, `GET /loyalty/customers/:phone`, y
  `GET`/`POST /loyalty/campaigns`. Reenvía JSON/status de `craft-loyalty` con Bearer
  `LOYALTY_ADMIN_TOKEN`; sin binding o token responde `503 {error:"club_no_disponible"}`. El POST
  exige JSON y consulta primero el historial: una campaña en las últimas 24 h responde
  `429 {error:"campana_reciente",next_at}`.

`productEntry` = formato de `{slug}:productos` que hoy escribe craft-crm (`internal/catalogsync/service.go#productEntry`):
`{id, slug, nombre, tipo?, precio:"12.50", precio_promo:"", costo_empaque?, categorias:[], descripcion, stock:null|0|n,
imagenes:[url], variantes:[], sku}`. `disponible:false` ⇒ `stock:0`; `true` ⇒ `stock:null`. `precio` se guarda como
string con 2 decimales. `id` nuevo = `crypto.randomUUID()`, `slug` = nombre en kebab-case sin tildes (único en el menú).

```
Me = { email, must_change_password: bool,
       store: { slug, store_name, logo, theme_primary, menu_url: "https://{host}/" },
       loyalty_enabled: bool }
Stats = { days: [{ day: "YYYY-MM-DD", views, orders }], totals: { views, orders },
          loyalty: { customers, plays } | null }
```

### Admin (`/admin/{slug}/*`, Bearer ADMIN_TOKEN) — lo consume craft-crm (C1)
- `POST /admin/{slug}/owner {email}` → `200 {email, password}`: crea o reemplaza al dueño con una contraseña
  generada (10 chars legibles, sin 0/O/1/l), `must_change_password=1`, `pwd_ver+1`.
- `DELETE /admin/{slug}/owner` → `204` (revoca acceso).
- `POST /admin/{slug}/reset` → `200 {url, expires_at}`; `url = https://{slug}.craft-systems.com/panel/reset?t=<token>`
  (o el dominio propio si existe `domain:` → usar `body.host` si viene). `404 sin_dueno` si no hay dueño.
- `GET /admin/{slug}/stats?days=30` → `Stats`.

### Conteo (B)
- `POST /panel/e {t:"view"|"order"}` público, sin cookie → `204` siempre (body inválido también, sin revelar nada).
  Upsert en `events_daily (slug, day, views, orders)`, día en hora de Ecuador (UTC-5).
- Motor `v1/catalog.js`: SOLO si es menú edge (`window.__CONFIG__` presente) ⇒ `navigator.sendBeacon('/panel/e', …)`
  con `view` una vez por sesión de navegador (`sessionStorage`) y `order` en cada punto donde hoy se dispara
  `track('Purchase', …)`. Legacy (Pages) = cero requests nuevos. Falla del beacon = silenciosa.
- `statsFor(env, slug, days)` en `events.js` → `Stats` (loyalty vía `env.LOYALTY.fetch("https://loyalty/admin/{slug}/stats",
  Bearer LOYALTY_ADMIN_TOKEN)`, `null` si falla o no está habilitado).

### Página (A2) — `renderPage(host)` → HTML único, vanilla JS, mobile-first, español neutro (tuteo, cero voseo)
Pantallas: login · cambio obligatorio de contraseña (`must_change_password`) · reset (`/panel/reset?t=`) ·
**Productos** (lista por categoría con buscador, editar nombre/precio/precio promo/descripción/categoría/foto/disponible,
crear, borrar con confirmación) · **Mi negocio** (WhatsApp, horario, dirección, logo, título) · **Fidelidad**
(activar, sellos para premio, premio, PIN del mesero) · **Resultados** (visitas y pedidos últimos 30 días, totales,
clientes del club) · botón "Ver mi menú" y QR descargable del menú (QR generado en el navegador con un encoder
inline propio, sin CDN). Foto: `<input type=file accept=image/* capture>` → canvas → webp ≤1200 px → `POST /upload`.
Estilo: usa `theme_primary` de `Me.store`. Accesible (labels, foco, contraste).

---

## craft-crm (C1, C2) — contrato en `internal/menusaas/contract.go`

### Datos (C1, `migrations/000094_menu_saas.{up,down}.sql`)
- `menu_sales(id uuid pk, account_id, business_id /*negocio de Craft dueño del inbox*/, conversation_id, contact_id,
  plan text check in ('monthly','annual'), amount numeric, currency 'USD', status text check in
  ('pending','paid','delivered','refunded','cancelled') default 'pending', payphone_tx text unique, payphone_id text,
  email text, menu_business_id uuid null, slug text null, paid_at, delivered_at, created_at, updated_at)`.
- `business_catalog_configs.edge_owned_at timestamptz null` ⇒ `catalogsync.Run` devuelve `Result{Ok:true}` sin tocar KV,
  y `RestoreCatalog` recrea la route SIN re-sincronizar.
- Precios: monthly = 15.00, annual = 120.00 (IVA incluido, `splitIVA` existente).

### Cobro de la venta (C1)
- `GET /api/v1/billing/pay/sale/{sale_id}` (público, como `pay/{cycle_id}`): PayPhone Prepare con `clientTransactionId`
  nuevo guardado en `menu_sales.payphone_tx`; misma página intermedia por el Referer.
- `payphoneReturn` existente: si el `clientTransactionId` no está en `billing_payments`, buscarlo en `menu_sales`;
  Confirm → `status='paid'`, `paid_at` → **una sola vez**: aviso Telegram + mensaje WhatsApp al contacto en su
  conversación ("¡Pago recibido! ✅ …") + `bot_paused=false`, `bot_state='PAID'` para que el bot pida el correo y
  el material. Redirige a una página simple de "Pago recibido, vuelve a WhatsApp" (no a `/#/tiers`).

### Entrega (C1) — `POST /api/v1/superadmin/menu-saas/sales/{sale_id}/deliver {slug}`
Valida `status='paid'`, `slug` existe en `business_catalog_configs` y hay `email` ⇒ `edge_owned_at=NOW()` ⇒
`craft-panel POST /admin/{slug}/owner` ⇒ tier del negocio del menú (15/mes o 120/año, `current_cycle_end` =
`paid_at` + 1 o 12 meses; si `business_tiers` no soporta anual, agregar `period_months`) ⇒ WhatsApp en la
conversación de la venta: link del menú, `https://{slug}.craft-systems.com/panel`, usuario y contraseña, **QR PNG
del menú** (`github.com/skip2/go-qrcode`, subido como media) y `MENU_TUTORIAL_URL` (env) ⇒ `status='delivered'`.
Idempotente: re-entregar no duplica tier ni regenera contraseña salvo `?regenerar=1`.

### Renovación y archivo (C1)
- `CycleWorker` existente cobra el ciclo con `pay/{cycle_id}`. Para negocios `edge_owned` el recordatorio agrega:
  "En los últimos 30 días tu menú tuvo {views} visitas y {orders} pedidos" (`/admin/{slug}/stats`, si falla se omite).
- Tier `suspended` + `edge_owned` ⇒ `ArchiveCatalog` (borra route) + `DELETE /admin/{slug}/owner` NO (el dueño
  conserva su usuario); al pagar ⇒ `RestoreCatalog` (sin sync). Una vez por transición.

### Bot (C2) — `internal/bot/agency`
- Tool `generar_link_pago {plan:"monthly"|"annual"}` → `menusaas.CreateSale` → devuelve la URL al LLM para que la envíe.
  Reemplaza a `confirmar_pedido` SOLO para el menú digital (tiendas/páginas siguen igual). Requiere nombre + cédula/RUC.
- Con `bot_state='PAID'` el bot pide correo (registrar_datos → `email`) + logo + carta y luego pausa (handoff al humano).
  `menusaas.SetSaleEmail` guarda el correo en la venta.
- Tool `restablecer_acceso_panel` → `menusaas.ResetPanelAccess(contactID)`: solo si el teléfono del contacto es el de una
  venta `delivered`; devuelve la URL de un solo uso. Si no coincide ⇒ `[[HANDOFF]]`.
- Frontend: en el panel del contacto de la conversación, si hay venta `paid` ⇒ botón **Entregar menú** (input slug
  prellenado con `form_data.repo_slug` si existe) → endpoint deliver; si `delivered` ⇒ **Restablecer acceso**.
