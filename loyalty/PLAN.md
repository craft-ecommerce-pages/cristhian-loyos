# craft-loyalty — club de fidelización de los menús (plan de trabajo paralelo)

Decisiones: `knowledge/04-Decisiones/ADR-005-Fidelizacion-menus-edge.md`. Rama base `feat/loyalty`.
Cada workstream trabaja en su worktree/rama `feat/loyalty-<letra>` y **solo toca sus archivos**.

## Producto (decidido por el operador)

- El cliente escanea el QR de la mesa → `https://{slug}.craft-systems.com/club` → entra con **nombre + WhatsApp**
  (sin OTP) → **juega** (ruleta o raspadita) → la jugada **es la visita**: suma 1 sello y puede ganar un premio.
- Una jugada cada `cooldown_hours` (12 h) por teléfono. Validación de presencia: **geolocalización** a ≤ `radius_m`
  de alguna sede del menú (`location.sedes[].lat/lng`). Sin permiso de ubicación → el **mesero escribe el PIN**
  y se juega igual (`via='pin'`). Menú sin sedes con coordenadas → se juega sin geo (`via='nogeo'`).
- Puede no ganar ("Sigue participando", peso `lose_weight`). El sello se suma igual.
- Al llegar a `stamps_goal` sellos → premio `source='stamps'` y la tarjeta vuelve a 0 (`cards_completed++`).
- Premios: se canjean en el momento o se guardan. **Canje = el mesero escribe el PIN de 4 dígitos** del
  restaurante en el teléfono del cliente. 5 PIN fallidos por premio → bloqueado.
- Reseña de Google: se ofrece DESPUÉS de mostrar el resultado, **nunca como condición** (política de Google).
- Google Wallet: tarjeta con sellos y premios activos; las campañas push van por `addMessage` (máx. 3/24 h por pase).
- El **premio lo decide el servidor**; el navegador solo anima hacia el resultado que recibe.

## Contrato (ya escrito, NO cambiar sin avisar al integrador)

- `loyalty/migrations/0001_init.sql` — D1: `customers`, `plays`, `rewards`, `campaigns`.
- `loyalty/src/contract.js` — `normalizeConfig` (formato de KV `{slug}:loyalty`), `segments`, `normalizePhone`,
  `distanceM`, `sedesWithCoords`, constantes (`STAMPS_PRIZE_ID`, `MAX_PIN_FAILS`, `SESSION_COOKIE`, `GAMES`).
- `loyalty/src/index.js` — router (ya cableado): `/admin/*` → `handleAdmin`; `/club/api/*` → `handleApi`; `/club` → `renderPage`.
- Firmas fijas de los stubs: `src/api.js` (A), `src/wallet.js` (B), `src/page.js` (C).
- `loyalty/test/helpers.mjs` — `makeD1()` (D1 sobre `node:sqlite` con las migraciones), `makeKV()`, `makeCtx()`.
- Tests: `node --test loyalty/test/` (Node 26, sin dependencias npm).

## API del cliente (`/club/api/*`, JSON, sesión por cookie)

Cookie `club_s` = `<phone>.<hmac>` con HMAC-SHA256(`${slug}:${phone}`, env.SESSION_SECRET) en hex.
`Path=/club; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`. Sesión inválida o de otro slug → 401.
Toda respuesta de error: `{ error: "<codigo>", ...extra }`.

- `POST /login {name, phone}` → normaliza (`cfg.phone_country`), upsert de customer (actualiza `name` si viene), set cookie → `200 Me`. Teléfono inválido → `400 telefono_invalido`; nombre vacío → `400 nombre_requerido` (máx. 60 caracteres, recortar).
- `POST /logout` → borra la cookie → `204`.
- `GET /me` → `200 Me`.
- `POST /play {game, lat?, lng?, pin?}` →
  1. `game` ∉ `cfg.games` → `400 juego_invalido`.
  2. cooldown: `now - last_play_at < cooldown_hours` → `429 {error:"cooldown", next_play_at}`.
  3. presencia: si el menú tiene sedes con coordenadas: `pin` válido → `via='pin'`; si no, `lat/lng` a ≤ `radius_m` de alguna sede → `via='geo'`; sin coords → `403 sin_ubicacion`; lejos → `403 fuera_de_rango`; PIN mal → `403 pin_invalido`. Sin sedes con coords → `via='nogeo'`.
  4. sorteo ponderado sobre `segments(cfg)`, excluyendo premios con `stock` agotado (COUNT de `rewards` por `prize_id`) — si todos los premios están agotados queda solo "Sigue participando"; si además `lose_weight=0`, no gana.
  5. en un `DB.batch`: insert `plays`; insert `rewards` (si ganó; `expires_at` según `expires_days`); `stamps+1`, `visits+1`, `last_play_at`; si `stamps` llega a `stamps_goal` → `stamps=0`, `cards_completed+1` e insert del reward `source='stamps'` (`prize_id=STAMPS_PRIZE_ID`).
  6. `ctx.waitUntil(walletSync(...))` si `wallet_saved=1`.
  → `200 {result: {segment_index, won, prize: {id,label}|null, reward_id|null, card_completed: bool, stamps_reward_id|null}, me: Me}`.
- `POST /redeem {reward_id, pin}` → reward del mismo slug y teléfono. Ya canjeado → `409 ya_canjeado`; vencido → `409 vencido`; `pin_fails >= MAX_PIN_FAILS` → `423 bloqueado`; PIN mal → `pin_fails+1`, `403 {error:"pin_invalido", attempts_left}`; sin `staff_pin_hash` configurado → `409 sin_pin`. OK → `status='redeemed'`, `redeemed_at` → `200 {reward, me}`.
- `GET /wallet` → `walletEnabled(env)` falso → `404 wallet_no_disponible`; si no, marca `wallet_saved=1` y `302` a `walletSaveUrl(...)`.

PIN: `sha256hex(`${slug}:${pin}`) === cfg.staff_pin_hash` (WebCrypto), comparación de tiempo constante.

```
Me = {
  customer: { name, phone, stamps, visits, cards_completed },
  program:  { store_name, logo, theme_primary, theme_accent,      // del menuCfg
              games, segments: [{id,label}], stamps_goal, stamps_reward_label, cooldown_hours,
              review_url, terms, geo_required: bool },            // geo_required = hay sedes con coords
  can_play: bool, next_play_at: ms|null,
  rewards:  [{ id, label, source, status: "active"|"redeemed"|"expired", created_at, expires_at, redeemed_at }],  // activos primero, máx. 50
  wallet_url: "/club/api/wallet" | null
}
```
Sin sesión, `GET /me` → `401 {error:"sin_sesion", program}` (la página igual pinta marca y juegos en el login).

## API admin (`/admin/{slug}/*`, `Authorization: Bearer env.ADMIN_TOKEN`, comparación de tiempo constante)

- `GET /admin/{slug}/stats?days=30` → `{customers, new_customers, plays, returning_customers (visits>=2), rewards_issued, rewards_redeemed, cards_completed, by_day: [{day:"YYYY-MM-DD", plays, new_customers}]}` (días en UTC-5).
- `GET /admin/{slug}/customers?q=&limit=50&offset=0` → `{items: [{phone, name, stamps, visits, cards_completed, last_play_at, active_rewards, wallet_saved}], total}` (q busca en nombre o teléfono; orden `last_play_at DESC`).
- `GET /admin/{slug}/customers/{phone}` → `{customer, rewards, plays (últimas 50)}` o `404`.
- `POST /admin/{slug}/campaigns {title, body}` → (title ≤ 60, body ≤ 500) clientes con `wallet_saved=1` → `walletNotify` → insert `campaigns` → `{sent, failed}`. Tope 900 destinatarios por llamada (límite de subrequests); más → `413 demasiados_destinatarios` (cola de envío = fase 2).
- `GET /admin/{slug}/campaigns` → últimas 20.
- Token ausente/incorrecto → `401`. Slug con formato inválido (`^[a-z0-9-]{1,63}$`) → `400`.

## Workstreams

### A — API del cliente + admin (Codex)
Archivos: `loyalty/src/api.js`, `loyalty/test/api.test.mjs`. Todo lo de las dos secciones de API de arriba.
Usa `wallet.js` solo por sus firmas (stub). Tests exhaustivos con `makeD1/makeKV/makeCtx` llamando a
`handleApi`/`handleAdmin` con `new Request(...)`: login, cookie forjada/de otro slug, cooldown, geo dentro/fuera,
PIN en play, sorteo con `Math.random` inyectable (exportar `pickSegment(segs, rand)` puro), stock agotado,
tarjeta completa (premio stamps + reinicio), redeem (PIN mal, bloqueo, doble canje, vencido, premio de otro
teléfono), admin (auth, stats, búsqueda, campañas con walletNotify simulado). Sin dependencias npm.

### B — Google Wallet (Codex)
Archivos: `loyalty/src/wallet.js`, `loyalty/test/wallet.test.mjs`. Solo WebCrypto + fetch (sin npm).
- `env.GW_SA_JSON` = JSON de la service account. JWT RS256 con `crypto.subtle.importKey("pkcs8")`.
- Token OAuth (`scope wallet_object.issuer`) cacheado en memoria del isolate hasta 5 min antes de expirar.
- Clase por slug: id `${issuer}.${slug}` (los `-` son válidos). `issuerName`/`programName` = `store_name`,
  `programLogo` = `menuCfg.logo` (si no es https o es .svg/.webp → logo de Craft `https://media.craft-systems.com/brand/craft-logo.jpeg`; Google no acepta svg/webp),
  `hexBackgroundColor` = `theme_primary` válido o `#1a1a1a`, `reviewStatus: "UNDER_REVIEW"`.
  Asegurarla con GET→POST (o PUT si cambió la marca); recordar en KV `{slug}:wallet_class` = hash de lo enviado para no repetir.
- Objeto: id `${issuer}.${slug}_${phone}`, `accountId`=phone, `accountName`=name, `loyaltyPoints {label:"Sellos", balance:{string:"3/8"}}`,
  `secondaryLoyaltyPoints {label:"Premios", balance:{int: activos}}`, `barcode QR` con value = `https://{slug}.craft-systems.com/club`,
  `linksModuleData` con "Ver menú" y "Mi club", `textModulesData` con los premios activos (máx. 5).
- `walletSaveUrl`: asegura clase, JWT `savetowallet` con el objeto completo en `payload.loyaltyObjects`, `origins: []`.
- `walletSync`: PUT del objeto; 404 → no-op. Nunca lanza (loguea).
- `walletNotify`: por teléfono `POST loyaltyObject/{id}/addMessage` con `message {header:title, body, messageType:"TEXT_AND_NOTIFY", id único}`; respuesta de cuota (429 o `QuotaExceeded`) → reintento con `"TEXT"` y cuenta como enviado; 404 → failed. Concurrencia máx. 6.
- Tests con `fetch` simulado (sin red): firma JWT verificable con la clave pública de un par generado en el test, caché de token, payloads, 404/quota.

### C — Página /club + banner en el menú (DeepSeek)
Archivos: `loyalty/src/page.js`, `loyalty/test/page.test.mjs`, y en el motor: `v1/catalog.js` (banner) + `v1/catalog.css` si hace falta.
- `renderPage(menuCfg, cfg)` → HTML completo, CSS+JS inline, **sin librerías**. Mobile first. Colores/logo/fuente del menú
  (`theme_primary`, `theme_accent`, `logo`, `store_name`, `fonts`). Escapar todo texto del cliente.
- Pantallas: login (nombre + WhatsApp) → inicio (tarjeta de sellos N/goal visual, botón Jugar o cuenta regresiva,
  premios activos/usados, botón "Guardar en Google Wallet" si `wallet_url`, enlace "Ver menú" → `/`) →
  elegir juego (si hay 2) → **ruleta** (canvas, segmentos de `program.segments`, gira y frena en `segment_index`)
  o **raspadita** (canvas que se raspa con el dedo; al 50 % revela) → resultado (confeti CSS si ganó; "Canjear ahora"
  / "Guardar para después"; luego, aparte, "¿Te gustó? Déjanos tu reseña" si `review_url`).
- Flujo de jugar: pedir `navigator.geolocation` solo si `program.geo_required`; luego `POST /play` y animar al resultado.
  `403 sin_ubicacion` o permiso negado → pantalla "Pídele al mesero el PIN para validar tu visita" + input → reintenta con `pin`.
  `fuera_de_rango` → mensaje claro. `cooldown` → cuenta regresiva.
- Canje: modal "Muestra esta pantalla al mesero" + PIN → `POST /redeem`; mostrar intentos restantes.
- Copy en **español neutro con tuteo** (nada de voseo: "jugá", "tenés", "acá" prohibidos).
- Banner en el menú (`v1/catalog.js`): si `config.club` es objeto `{label?}`, botón flotante "🎁 ${label || 'Juega y gana'}" → `/club`.
  Sin la clave = menú byte-idéntico. No rompe tiendas (`cart.js` no se toca).
- Tests: `renderPage` escapa HTML inyectado, contiene los marcadores clave, y funciones puras exportadas
  (`wheelStopAngle(index, total)`, etc.); test del banner en `v1/` con el patrón de los `*.test.cjs` existentes.

### G — Integrador + QA (gpt-6-sol)
Fusiona A, B, C en `feat/loyalty`; service binding en `worker/` (craft-menus): `/club` y `/club/*` → `env.LOYALTY.fetch(request)`
(`[[services]] binding="LOYALTY" service="craft-loyalty"` en `worker/wrangler.toml`, con test en `worker/lib.test.mjs`
o equivalente, sin romper menús/tiendas). QA de punta a punta con `npx wrangler dev --local` + D1 local
(`wrangler d1 migrations apply craft-loyalty --local`) y KV local con un menú de prueba: login → play → canje → admin.
Revisión implacable de lógica y seguridad. `node --test loyalty/test/` y los tests existentes del repo en verde.

## Reglas para todos

- Solo en tu worktree. Sin deploy (`wrangler deploy` prohibido), sin `wrangler d1 create`, sin `git push`,
  sin ssh, sin llamar a Google/Cloudflare reales (todo simulado). No tocar `/home/jcadmin/proyectos/dev/craft-catalog-engine`.
- No cambiar el contrato; si algo no cierra, documentarlo en el handoff y seguir con la mejor interpretación.
- Código denso y legible como el resto del repo, español en comentarios. Nada sin test.
- Commit en tu rama: `feat(loyalty-<letra>): …` terminado en la línea `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  y `loyalty/handoff-<letra>.md` (qué hiciste, decisiones, cómo probar, riesgos).
