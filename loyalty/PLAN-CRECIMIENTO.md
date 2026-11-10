# Sprint "Crecimiento + migración legacy" — contrato

Vigentes: `loyalty/PLAN.md`, `PLAN-SEGURIDAD.md`, `PLAN-DELIVERY-QR.md`, `panel/PLAN-CATALOGO.md`. Donde choque, manda este.
`loyalty/src/wallet.js` NO se toca (otro agente). Pizza Planet NO se migra.

| ID | Repo / worktree (rama) | Archivos |
|---|---|---|
| G1 | catalog-engine `wt/gro-g1` (`feat/gro-g1`) | `loyalty/migrations/0004_crecimiento.sql`, `loyalty/src/contract.js`, `loyalty/src/api.js`, `loyalty/src/index.js` (scheduled), `loyalty/test/*` |
| G2 | catalog-engine `wt/gro-g2` (`feat/gro-g2`) | `panel/migrations/0004_features.sql`, `panel/src/api.js`, `panel/src/admin.js`, `panel/src/page.js`, `panel/src/contract.js`, `panel/wrangler.toml` (solo `[vars]`), `panel/test/*` |
| G3 | catalog-engine `wt/gro-g3` (`feat/gro-g3`) | `loyalty/src/page.js`, `loyalty/test/page-*.test.mjs` |
| G4 | craft-crm `wt/crm-gro-g4` (`feat/gro-g4`) | `internal/menusaas/legacy.go` (+test), `internal/menusaas/routes.go` (solo rutas nuevas), `internal/menusaas/panel.go` (solo función nueva `PanelSetFeatures`) |
| G5 | craft-crm `wt/crm-gro-g5` (`feat/gro-g5`) | `migrations/000095_loyalty_addon.{up,down}.sql`, `internal/billing/addon.go` (+test), `internal/billing/handler.go` (solo registrar rutas/worker), `internal/billing/payphone.go` (solo la rama de retorno para addons) |
| ENS | ambos (`wt/panel-int`, `wt/crm-menu-saas`) | merge + QA |

Todos los agentes: deepseek-flash. Código legible (líneas ≤ 140), tests verdes, sin dependencias nuevas.

## 1. Cumpleaños (G1 + G3 + G2)

- `customers.birthday TEXT` `MM-DD` (sin año), opcional. `POST /club/api/login {…, birthday?}` y
  `POST /club/api/profile {birthday}` (con sesión; solo si aún está vacío — no se puede cambiar para evitar abuso).
- Config `{slug}:loyalty.birthday = {enabled, label, expires_days}` (default `{enabled:false, label:"Regalo de cumpleaños", expires_days:14}`).
- Cron diario (el `scheduled` existente, mismo tope por corrida): clientes con cumpleaños dentro de 7 días, sin
  premio `source='birthday'` emitido este año → crea reward `source='birthday'` + `walletNotify` "🎂 Se acerca tu
  cumpleaños: te regalamos {label}. Válido hasta {dd/mm}" (si `wallet_saved=1`).
- `rewards.source` acepta `'birthday'` y `'winback'` (recrear tabla como hizo 0003 con `plays`, copiando filas e índices).

## 2. Recuperar inactivos (G1 + G2)

- Config `winback = {enabled, days (≥14, default 30), label, expires_days (default 14)}`.
- Cron: clientes con `last_play_at` < ahora − days, con `visits ≥ 1`, sin reward `winback` desde su última visita →
  reward `source='winback'` + `walletNotify` "Te extrañamos 👋 Vuelve y te regalamos {label}". Una vez por período de inactividad.

## 3. Exportar clientes (G1 + G2)

- Admin `GET /admin/{slug}/customers.csv` → `text/csv; charset=utf-8` con BOM: nombre, whatsapp, cumpleaños,
  visitas, sellos, tarjetas completadas, última visita (fecha EC), guardó Wallet (sí/no), premios activos.
  Escapar comillas y neutralizar fórmulas (`=`, `+`, `-`, `@` al inicio → anteponer `'`).
- Panel: `GET /panel/api/loyalty/customers.csv` (proxy, descarga) + botón "Exportar clientes (CSV)" en Clientes.

## 4. Opinión privada (G1 + G3 + G2)

- Tabla `feedback(id INTEGER PK, slug, phone, rating INTEGER 1-5, comment TEXT ≤ 500, play_id, created_at)`.
- `POST /club/api/feedback {rating, comment?}` (sesión; máx. 1 por jugada/visita: ligada a la última play del cliente
  sin feedback, si no hay → `409 sin_visita`).
- Página (G3): tras el resultado de una jugada/visita: "¿Cómo estuvo tu visita?" 1–5. Si 4–5: gracias + botón de
  reseña de Google (si `review_url`). Si 1–3: campo "Cuéntanos qué pasó (solo lo ve el restaurante)" y gracias; el
  botón de reseña se muestra igual, más abajo y discreto (NUNCA se oculta la reseña según la nota: política de Google).
- Admin `GET /admin/{slug}/feedback?limit&offset` → `{items:[{rating, comment, name, phone, created_at}], total, avg}`.
  Panel: subpestaña "Opiniones" en Fidelidad (tabla + promedio).

## 5. Imprimible del QR del club (G2)

- En Fidelidad y Resultados, "Descargar cartel para la caja": PNG 1240×1748 (A6 a 300 dpi) dibujado en canvas:
  logo (si carga por CORS; si no, nombre), título "Únete a nuestro club", "Junta {stamps_goal} sellos y llévate
  {stamps_reward_label}", QR grande a `https://{host}/club`, pie "Escanea con la cámara de tu celular".
  Colores: `theme_primary` del menú. También versión "mesa" con QR del menú ("Pide desde tu celular").

## 6. Campañas con fechas sugeridas (G2)

- En Campañas: lista de fechas próximas (Día de la Madre EC 2.º domingo de mayo, Día del Padre 3.º domingo de junio,
  San Valentín 14/02, Día de la Pizza 9/02, Día de la Hamburguesa 28/05, Navidad, Fin de año, Halloween, Día del
  Café 1/10) con título y texto de ejemplo que se cargan al formulario con un clic.

## 7. Aviso por cercanía — NO en este sprint

Las coordenadas de sedes al pase de Google Wallet (`locations`) se encargan al agente de Wallet (toca wallet.js).
Google decide si muestra el aviso; no se promete.

## 8. Función "tarjeta" habilitada por plan (G2 panel + G5 CRM)

- Panel D1 `panel_features(slug PK, loyalty INTEGER NOT NULL, source TEXT, updated_at)`. Sin fila = habilitado
  (compatibilidad con clubs existentes y Menú SaaS).
- Admin `PUT /admin/{slug}/features {loyalty: bool, source?: "saas"|"addon"|"legacy"}`; si `loyalty=false` además pone
  `{slug}:loyalty.enabled=false` y borra `{slug}:config.club`. `GET /admin/{slug}/features`.
- `Me.features = {loyalty: bool}` y `Me.loyalty_pay_url` = `{CRM_PAY_URL}/api/v1/billing/pay/loyalty/{slug}`
  (`CRM_PAY_URL` var de wrangler, default `https://crm.craftmarketing.agency`).
- `PATCH /panel/api/loyalty` con `enabled:true` sin feature → `402 {error:"plan_requerido"}`.
- UI: con feature apagada, Fidelidad muestra solo una tarjeta: "Activa tu tarjeta de fidelidad por USD 5 al mes" +
  beneficios (3 viñetas) + botón "Activar ahora" → `loyalty_pay_url` (nueva pestaña).

## 9. Migración legacy (G4, craft-crm)

- `GET /api/v1/superadmin/menu-saas/legacy` → candidatos: `business_catalog_configs` con `catalog_kind='menu'`,
  `edge_owned_at IS NULL`, slug sin `demo`, distinto de `pizza-planet`, negocio no borrado; por cada uno: slug,
  negocio, email del usuario dueño de la cuenta (`users` rol owner/admin de `account_id`), dominio propio si existe
  en KV `domain:*` (opcional; si no se puede leer, omitir), nº productos.
- `POST /api/v1/superadmin/menu-saas/legacy/{slug}/migrate {email?, dry_run?: bool}` (auth superadmin existente):
  1. `ExportCatalog` → `PUT {PANEL_ADMIN_URL}/admin/{slug}/catalog`.
  2. `PUT /admin/{slug}/features {loyalty:false, source:"legacy"}` (via `PanelSetFeatures`, que implementa G4).
  3. `panelOwnerCreate(slug, email)` (email del body o el del dueño).
  4. `edge_owned_at = NOW()`.
  5. Responde `{slug, email, password, panel_url, menu_url, message}` donde `message` es el texto listo para
     enviar al cliente (usted): link del panel (dominio propio si lo tiene, si no `https://{slug}.craft-systems.com/panel`),
     usuario, contraseña temporal, "su menú sigue siendo vitalicio", y la oferta de tarjeta por USD 5/mes.
  `dry_run` no escribe nada y devuelve qué haría. Idempotente: si ya tiene `edge_owned_at` → `409 ya_migrado`.
  Si un paso falla, no marca `edge_owned_at` (reintentable). NO envía WhatsApp/correo: el operador decide.

## 10. Cobro de la tarjeta legacy USD 5/mes (G5, craft-crm)

- Migración 000095: `addon_subscriptions(id uuid PK, business_id, kind TEXT CHECK(kind='loyalty'), status TEXT
  CHECK(status IN ('pending','active','suspended','cancelled')), amount NUMERIC, current_period_end TIMESTAMPTZ,
  created_at, updated_at, UNIQUE(business_id, kind))` y `addon_payments(id uuid PK, subscription_id, client_tx_id
  UNIQUE, payphone_id, amount, status, paid_at, created_at)`.
- `GET /api/v1/billing/pay/loyalty/{slug}` (público): resuelve el negocio por slug; crea/reutiliza la suscripción;
  arma PayPhone (reusa la preparación de `payphone.go`, monto 5.00 con IVA 15 % como el resto, referencia
  "Tarjeta de fidelidad - {negocio}") y muestra la misma página de pago con título "Tarjeta de fidelidad".
- Retorno PayPhone (rama nueva en el handler de retorno por `client_tx_id` de `addon_payments`): confirma (V2/Confirm),
  marca pagado, `status=active`, `current_period_end = max(now, period_end) + 1 mes`, llama
  `PanelSetFeatures(slug, true, "addon")`, aviso Telegram como en `notifyMenuSale`, página "Pago recibido ✅".
- Job diario (en el CycleWorker o un ticker propio en el mismo proceso): `active` con `current_period_end` < ahora − 3 días
  → `suspended` + `PanelSetFeatures(slug, false, "addon")`. Pagar de nuevo reactiva.
- `menusaas.PanelSetFeatures(ctx, slug, loyalty bool, source string) error` lo implementa G4 en `internal/menusaas/panel.go`
  (mismo cliente HTTP que `panelOwnerCreate`). G5 lo llama por esa firma exacta; si tu rama no lo tiene aún, declara en
  `addon.go` `var panelSetFeatures = menusaas.PanelSetFeatures` y, para compilar en tu rama, crea un stub temporal en un
  archivo `internal/menusaas/panel_features_stub.go` que el ensamblador borra al integrar. En `Deliver` no hace falta: sin fila = habilitado.
