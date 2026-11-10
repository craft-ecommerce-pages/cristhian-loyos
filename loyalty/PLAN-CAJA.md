# Sprint "Modo caja: el mesero escanea la tarjeta" — contrato

Vigentes: `loyalty/PLAN.md`, `PLAN-SEGURIDAD.md`, `PLAN-DELIVERY-QR.md`, `PLAN-CRECIMIENTO.md`, `panel/PLAN-CATALOGO.md`.
Donde choque, manda este. Se mantienen 3 Workers. El PIN del mesero sigue funcionando igual (respaldo).

Idea: el cliente muestra su tarjeta (Google Wallet o la página del club) con un QR único; el mesero lo escanea
desde el panel en su celular ("Modo caja", desbloqueado con su PIN) y valida la visita o canjea un premio.

| ID | Worktree (rama) | Archivos |
|---|---|---|
| CJ1 | `wt/caja-k1` (`feat/caja-k1`) | `loyalty/migrations/0005_caja.sql`, `loyalty/src/contract.js`, `loyalty/src/api.js`, `loyalty/src/wallet.js` (solo `loyaltyObject`), `loyalty/src/index.js` (solo la ruta `/club/t/`), `loyalty/test/*` (excepto `page-*`) |
| CJ2 | `wt/caja-k2` (`feat/caja-k2`) | `panel/src/caja.js` (nuevo), `panel/src/api.js` (solo rutas `caja/*`), `panel/src/index.js` (solo la ruta `/panel/caja`), `panel/src/page.js` (solo el acceso a Modo caja en Fidelidad), `panel/test/*` |
| CJ3 | `wt/caja-k3` (`feat/caja-k3`) | `loyalty/src/page.js`, `loyalty/test/page-*.test.mjs` |
| ENS | `wt/panel-int` | merge + QA |

`shared/qr.js` (encoder QR: `qrMatrix(text)` → matriz 0/1, autocontenida, se serializa al navegador con
`String(qrMatrix)`) ya existe en la base: impórtalo, no lo copies ni lo cambies.

## 1. Código de tarjeta (CJ1)

- Migración 0005: `customers.card_code TEXT` + `CREATE UNIQUE INDEX customers_card_code ON customers (slug, card_code)`.
  Recrear `credits` con `source IN ('delivery','scan')` y `plays` con `via IN ('geo','pin','nogeo','credit','scan')`,
  copiando filas, columnas e índices (mismo método que 0003/0004).
- `card_code`: 10 caracteres del alfabeto `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sin 0/O/1/I/L), aleatorio con
  `crypto.getRandomValues`, único por slug (reintenta ante choque). Se asigna en el login y, si falta, en `buildMe`.
- URL de la tarjeta: `cardUrl(slug, code)` = `https://{slug}.craft-systems.com/club/t/{code}` (exportar en contract.js
  junto con `parseCardCode(text)`: acepta el código suelto o cualquier URL que termine en `/club/t/{code}`; devuelve el
  código en mayúsculas o `null`).
- `Me.card = { code, url }`.
- Wallet (`loyaltyObject`): `barcode = { type: "QR_CODE", value: cardUrl(...), alternateText: code }`. El objeto
  completo ya se reenvía en cada `walletSync`, así los pases existentes se actualizan solos en su próxima sincronización.
- `GET /club/t/{code}` (index.js, público): HTML mínimo con la marca del menú: "Esta es tu tarjeta de {store}.
  Muéstrala en caja para sumar tu sello." + botón "Abrir mi club" → `/club`. No revela datos del cliente.

## 2. Admin del club para la caja (CJ1, Bearer como el resto)

Todas validan que el `staff_id` del body exista y esté activo en ese slug (`owner` también vale) → si no `403 mesero_inactivo`.
Datos del cliente: nombre, `phone_tail` (últimos 4 dígitos), nunca el teléfono completo.

- `POST /admin/{slug}/staff/verify {pin}` → `{staff:{id,name}}` | `403 pin_invalido`. Usa `validPin` (incluye el PIN
  general legacy → `{id:"legacy", name:"PIN general"}`).
- `GET /admin/{slug}/card/{code}` → `{card:{name, phone_tail, stamps, stamps_goal, visits, cards_completed,
  last_play_at, next_visit_at|null, credits:{granted, pending}, rewards:[{id,label,source,expires_at}]}, play_mode}`
  | `404 tarjeta_no_encontrada`. `next_visit_at` = última visita validada + `cooldown_hours` si aún no pasa.
- `POST /admin/{slug}/card/{code}/visit {staff_id}`:
  1. Cooldown: si `next_visit_at` no pasó → `429 {error:"cooldown", next_play_at}`. Si ya hay un crédito `scan`
     `granted` sin usar → `409 visita_pendiente`.
  2. Libera los créditos `pending` de delivery de ese teléfono (`granted_by=staff_id`), igual que el PIN.
  3. `play_mode="stamps"`: registra la visita YA (sello, `plays.game='stamp'`, `via='scan'`, `staff_id`) con la misma
     lógica de `play()` (incluye completar la tarjeta y su premio). Refactoriza el núcleo de `play()` a una función
     interna compartida; el comportamiento de `/club/api/play` NO cambia (todos los tests existentes siguen verdes).
     → `{result:{card_completed, stamps_reward_id}, card}`.
  4. `play_mode="game"`: crea un crédito `source='scan'`, `status='granted'`, `granted_by=staff_id`, `order_id` =
     `scan:{uuid}` → el cliente juega desde su celular con `credit:true` (flujo existente). Actualiza `last_play_at`
     no: el cooldown de la caja se mide con el `granted_at` del último crédito `scan` o la última visita.
     → `{credit_id, card}`.
  5. Wallet sync si `wallet_saved` (mismo `sync` de hoy).
- `POST /admin/{slug}/rewards/{id}/redeem {staff_id}` → canjea un premio `active` no vencido de ese slug
  (`redeemed_staff_id=staff_id`) → `{reward}` | `404` | `409 ya_canjeado|vencido`. Wallet sync.

## 3. Panel — Modo caja (CJ2)

- Página `GET /panel/caja` (mobile-first, mismo estilo del panel, sin pills). Se abre en el celular del mesero.
- Acceso: dueño con sesión del panel → entra directo (`staff_id="owner"`). Si no: pantalla de PIN →
  `POST /panel/api/caja/login {pin}` → proxy a `staff/verify` → cookie `caja_s` = `{staff_id}.{exp}.{hmac}`
  (HMAC-SHA256 con `SESSION_SECRET` sobre `caja:{slug}:{staff_id}:{exp}`), `Path=/panel; HttpOnly; Secure;
  SameSite=Lax`, 12 h. Rate limit con `LOGIN_LIMITER` (slug + IP) como el login del panel. `POST /panel/api/caja/logout`.
- API (cookie `caja_s` o sesión del dueño; si no → 401): `GET /panel/api/caja/card/{code}`,
  `POST /panel/api/caja/card/{code}/visit`, `POST /panel/api/caja/rewards/{id}/redeem` → proxy a LOYALTY con
  `LOYALTY_ADMIN_TOKEN`, añadiendo `staff_id` de la sesión (el navegador nunca lo envía). Si la función tarjeta está
  apagada (`panel_features`) → `402 plan_requerido`.
- Escáner: `<video>` con `getUserMedia({video:{facingMode:"environment"}})` y `BarcodeDetector({formats:["qr_code"]})`
  cuando exista; si no, carga perezosa de `https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js` y decodifica
  frames de un canvas. Siempre hay campo "Escribir código" (10 caracteres) como respaldo. `parseCardCode` (cópialo
  como función pura en caja.js o impórtalo de `loyalty/src/contract.js` si el bundle lo permite sin arrastrar más).
- Tras leer un código: ficha con nombre, ••••{phone_tail}, sellos `x/goal` (puntos), créditos pendientes,
  premios activos con botón "Canjear", y botón principal "Validar visita". Mensajes:
  stamps → "Sello sumado (x/goal)" o "¡Tarjeta completa! Premio: …"; game → "Visita validada: el cliente ya puede
  jugar desde su celular"; `cooldown` → "Ya validaste esta visita. Próxima desde {hora}"; `visita_pendiente` →
  "El cliente aún no usa su jugada". Botón "Escanear otro" vuelve a la cámara. Vibración corta al leer (si existe).
- En Fidelidad → Meseros: tarjeta "Modo caja" con el QR de `https://{host}/panel/caja` (usa `shared/qr.js`) y el texto
  "Ábrelo en el celular del mesero. Entra con su PIN y escanea la tarjeta del cliente".

## 4. Página del club (CJ3)

- Botón destacado "Mostrar mi tarjeta" en la tarjeta de sellos → vista a pantalla completa con el QR grande de
  `me.card.url` (usa `shared/qr.js`, canvas, alto contraste blanco/negro, margen de silencio 4 módulos), el código en
  texto debajo (`ABCD 2345 EF`), el nombre del cliente y "Muéstrala al mesero para sumar tu sello". Fondo blanco (el brillo no se puede subir desde la web).
- Mientras está abierta: consulta `/club/api/me` cada 3 s (máx. 5 min). Si suben `stamps`, `cards_completed` o
  `credits.granted` → cierra y muestra el resultado: sello sumado / pantalla de tarjeta completa existente
  (`cardCompleteView`) / "¡Visita validada! Toca para jugar" que lanza el juego con `credit:true`.
- El flujo con PIN queda igual como alternativa ("¿Sin escáner? Usa el PIN del mesero").
- Tuteo neutro, sin innerHTML con datos del usuario, sin dependencias.

## 5. Deploy (ENS/Claude)

Workers Builds: los triggers de `craft-panel` y `craft-loyalty` deben incluir `shared/**` en `path_includes`.
Migración 0005 se aplica a mano antes del deploy de craft-loyalty (backup D1 primero).
