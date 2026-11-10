# Sprint "Club endurecido" — contrato

Base: `loyalty/PLAN.md` (contrato vigente del club). Esto lo amplía; donde choque, manda este archivo.
Arquitectura: se mantienen 3 Workers (`craft-menus` lee KV, `craft-panel` admin del dueño, `craft-loyalty` club).

## Workstreams

| ID | Agente | Worktree (rama) | Archivos |
|---|---|---|---|
| L1 | codex gpt-5.6-terra | `wt/club-l1` (`feat/club-l1`) | `loyalty/migrations/0002_seguridad.sql`, `loyalty/src/contract.js`, `loyalty/src/api.js`, `loyalty/src/index.js` (solo `scheduled`), `loyalty/wrangler.toml` (solo `[triggers]`), `loyalty/test/*` |
| L2 | codex gpt-5.6-terra | `wt/club-l2` (`feat/club-l2`) | `panel/src/api.js` (rutas loyalty), `panel/src/page.js` (Fidelidad), `panel/test/*` |
| L3 | deepseek-flash | `wt/club-l3` (`feat/club-l3`) | `loyalty/src/page.js` |
| ENS | codex gpt-5.6-sol | `wt/panel-int` | merge + QA |

`loyalty/src/wallet.js` NO se toca (lo trabaja otro agente): solo se usa `walletNotify` tal como está.

## 1. Cuenta atada al dispositivo (L1)

- Cookie de dispositivo `club_d` = 32 bytes aleatorios en b64url. `Path=/club; HttpOnly; Secure; SameSite=Lax;
  Max-Age=63072000`. Se emite en cualquier respuesta de `/club/api/*` si no viene. En D1 solo `sha256hex(token)`.
- Tabla `customer_devices(slug, phone, device_hash, staff_id, created_at, last_seen_at, PRIMARY KEY(slug, phone, device_hash))`
  + índice `(slug, device_hash)`.
- `POST /login {name, phone, pin?}`:
  1. El dispositivo ya está vinculado a ese teléfono → OK.
  2. Teléfono nuevo, o existente SIN valor (stamps=0, visits=0 y sin premios activos) → vincular y OK.
  3. Teléfono existente CON valor y dispositivo no vinculado → sin `pin`: `403 {error:"verificacion_requerida"}`;
     `pin` de mesero válido → vincular (guarda `staff_id`) y OK; PIN mal → `403 pin_invalido` (cuenta para el rate limit).
  4. Tope anti-granja: un dispositivo vinculado ya a `MAX_PHONES_PER_DEVICE = 3` teléfonos distintos no puede
     vincular otro → `429 {error:"limite_dispositivo"}`.
- Sesión: además del HMAC de `club_s`, `sessionPhone` exige que el `club_d` actual esté vinculado a ese teléfono;
  si no → 401 (`sin_sesion`). Actualiza `last_seen_at` como máximo una vez por hora.

## 2. PIN por mesero (L1 backend, L2 panel)

- Tabla `staff(id TEXT PK, slug, name, pin_hash, active INTEGER, created_at, rotated_at)` + índice `(slug, active)`.
  `pin_hash = sha256hex(`${slug}:${pin}`)` (igual que el PIN actual, así el PIN es único por local).
  PIN de 4 a 6 dígitos, único entre los meseros activos del slug (`409 pin_repetido`). Máx. 30 meseros activos.
- `validPin(...)` pasa a devolver `staff_id | null`: compara contra todos los activos del slug (tiempo constante por
  comparación) y, por compatibilidad, contra `cfg.staff_pin_hash` → `staff_id = "legacy"`.
- Se registra quién: `plays.staff_id`, `rewards.redeemed_staff_id`, `customer_devices.staff_id`.
- Admin (Bearer, como el resto): `GET /admin/{slug}/staff` → `{items:[{id,name,active,created_at,rotated_at}]}`
  (nunca `pin_hash`); `POST /admin/{slug}/staff {name, pin}` → 201; `PUT /admin/{slug}/staff/{id} {name?, pin?, active?}`
  (`pin` nuevo → `rotated_at`); `DELETE` = `active=0`. `GET /admin/{slug}/customers/{phone}` agrega `staff_name`
  en cada jugada y `redeemed_by` en cada premio.
- Rate limit: el `PIN_LIMITER` existente (slug+IP) se aplica también a login con PIN; además
  `MAX_PIN_FAILS_DEVICE = 10` fallos por dispositivo en 24 h → `423 bloqueado` (contar en D1).

## 3. Ninguna jugada sin visita validada (L1)

- Config nueva en `{slug}:loyalty`: `require_pin: bool` (default `false`) — normalizeConfig la acepta y valida.
- `POST /play`: presencia válida =
  - `require_pin` → solo PIN de mesero (`via='pin'`).
  - Si no: sedes con coordenadas → PIN o geo (como hoy).
  - **Sin sedes con coordenadas → PIN obligatorio** (se elimina el camino `nogeo` para jugadas nuevas;
    el CHECK de la tabla se conserva por las filas viejas). Sin PIN → `403 {error:"pin_requerido"}`.
- Cooldown también por dispositivo: si ese `club_d` jugó (con cualquier teléfono) dentro de `cooldown_hours` →
  `429 {error:"cooldown", next_play_at}`. `plays.device_hash` se guarda.
- `Me.program.pin_required: bool` = `require_pin || sin sedes con coordenadas` (la UI pide el PIN antes de jugar).

## 4. Vencimiento y recordatorio (L1 backend, L2 panel)

- Sin cambio de semántica en configs existentes (`expires_days: null` = no vence).
- Panel (L2): premios nuevos y premio de tarjeta nueva nacen con **90 días**; texto de ayuda
  "Recomendado: 90 días. Te avisamos al cliente 5 días antes".
- Cron diario (`[triggers] crons = ["0 14 * * *"]` = 09:00 Ecuador) → `scheduled()`: premios `active` con
  `expires_at` entre ahora y ahora + 5 días, `reminded_at IS NULL`, cliente con `wallet_saved=1` →
  `walletNotify(env, slug, phone, {title:"Tu premio vence pronto", body:"“{label}” vence el {dd/mm}. Pásalo a canjear en {store}."})`
  y `reminded_at = now`. Tope 500 por corrida; errores no detienen el lote. Columna nueva `rewards.reminded_at`.
  Mira la firma real de `walletNotify` en wallet.js y úsala tal cual.

## 5. Panel — Fidelidad (L2)

- Subpestaña nueva **Meseros**: tabla (nombre, estado, creado, último cambio de PIN) + crear (nombre + PIN),
  cambiar PIN, desactivar/activar. El PIN se muestra solo al escribirlo.
- Configuración: interruptor "Exigir PIN del mesero para jugar" (`require_pin`) con ayuda; si el menú no tiene sedes
  con coordenadas, aviso fijo: "Tu menú no tiene sedes con ubicación: cada jugada pedirá el PIN del mesero".
  El PIN único actual (`pin`) sigue funcionando pero se rotula "PIN general (anterior)" con sugerencia de pasar a
  meseros.
- Clientes → detalle: columna "Sellado por" en jugadas y "Canjeado por" en premios.
- Proxies en `panel/src/api.js` (mismo patrón que las rutas loyalty existentes, con `LOYALTY_ADMIN_TOKEN`):
  `GET/POST /panel/api/loyalty/staff`, `PUT/DELETE /panel/api/loyalty/staff/{id}`. `PATCH /panel/api/loyalty`
  acepta `require_pin`.

## 6. Página del club (L3)

- Login: ante `verificacion_requerida` muestra "Este número ya tiene sellos o premios. Pide al mesero que escriba
  su PIN para vincular este celular" + campo PIN y reintenta `POST /login` con `pin`. `limite_dispositivo`:
  "Este celular ya tiene el máximo de cuentas". `bloqueado`: "Demasiados intentos. Prueba mañana o pide ayuda al personal".
- Jugar: si `me.program.pin_required`, antes de girar/raspar pide el PIN del mesero (mismo campo que hoy se usa sin
  ubicación) y lo manda en `POST /play`. `pin_requerido` → muestra el campo.
- Premios: "Vence en N días" / "Vence hoy" si `expires_at`; vencidos en gris.
- Sin innerHTML con datos del usuario, tuteo neutro, sin dependencias.
