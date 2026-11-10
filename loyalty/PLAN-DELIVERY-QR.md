# Sprint "Delivery, modos de juego y 2 QR" — contrato

Base vigente: `loyalty/PLAN.md` + `loyalty/PLAN-SEGURIDAD.md` (ya integrados en `feat/panel`) y
`panel/PLAN-CATALOGO.md`. Donde choque, manda este archivo.

| ID | Agente | Worktree (rama) | Archivos |
|---|---|---|---|
| M1 | deepseek-flash | `wt/club-m1` (`feat/club-m1`) | `loyalty/migrations/0003_creditos.sql`, `loyalty/src/contract.js`, `loyalty/src/api.js`, `loyalty/test/*` |
| M2 | deepseek-flash | `wt/club-m2` (`feat/club-m2`) | `panel/migrations/0003_pedidos_estado.sql`, `panel/src/orders.js`, `panel/src/api.js`, `panel/src/page.js`, `panel/test/*` |
| M3 | deepseek-flash | `wt/club-m3` (`feat/club-m3`) | `loyalty/src/page.js`, `loyalty/test/page-*.test.mjs` |
| ENS | deepseek-flash | `wt/panel-int` | merge + QA |

`loyalty/src/wallet.js` no se toca.

## 1. Modo de juego (M1 backend, M2 panel, M3 página)

- `{slug}:loyalty.play_mode`: `"game"` (default: cada visita validada = 1 sello + 1 jugada de ruleta/raspadita)
  | `"stamps"` (cada visita validada = 1 sello, sin minijuego). `normalizeConfig` lo valida.
- En `"stamps"`: `POST /club/api/play {game:"stamp", pin?|lat,lng}` → misma validación de presencia, cooldown y
  registro que hoy, pero sin sorteo (`prize_id NULL`, `plays.game='stamp'`; la migración 0003 recrea el CHECK o
  usa una tabla nueva si SQLite no permite alterar el CHECK — elige lo más simple y documenta). El premio por
  completar la tarjeta (`stamps_reward`) funciona igual en ambos modos.
- `Me.program.play_mode`.

## 2. Créditos por pedido a domicilio (M1 backend)

Tabla `credits(id TEXT PK, slug, phone, order_id TEXT, source TEXT CHECK(source='delivery'),
status TEXT CHECK(status IN ('pending','granted','used','rejected')), created_at, granted_at, used_at,
granted_by TEXT)` + `UNIQUE(slug, order_id)` + índice `(slug, phone, status)`.

- Admin (Bearer, lo llama el panel):
  - `POST /admin/{slug}/credits {order_id, phone}` → crea `pending` (idempotente por order_id; teléfono con
    `normalizePhone`). Tope: si ya hay 1 crédito de ese teléfono creado en las últimas 24 h → `409 limite_diario`
    (el panel lo ignora en silencio).
  - `POST /admin/{slug}/credits/{order_id}/grant` → `pending` → `granted` (`granted_by='owner'`).
  - `POST /admin/{slug}/credits/{order_id}/reject` → `pending` → `rejected`.
  - `GET /admin/{slug}/credits?status=pending` → `{items:[…], total}`.
- Liberación por mesero: en `POST /play` con PIN válido, todos los `pending` de ese teléfono pasan a `granted`
  (`granted_by=staff_id`) en el mismo batch.
- Uso: un crédito `granted` = 1 sello + (en modo game) 1 jugada SIN validación de presencia, desde cualquier lugar.
  `POST /play {game, credit:true}` consume el `granted` más viejo (`used`). Sin créditos → `409 sin_creditos`.
  El cooldown NO aplica a jugadas con crédito (ya las limita el tope diario); sí se registra `plays.via='credit'`
  (mismo tratamiento del CHECK que en §1).
- Si el cliente aún no está en el club, los créditos esperan por teléfono y aparecen al unirse.
- `Me.credits = { granted: n, pending: n }`.

## 3. Panel — Pedidos (M2)

- Migración panel 0003: `orders.status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected'))`,
  `orders.status_at INTEGER`.
- `/panel/o` (ya existe): tras insertar, si `{slug}:loyalty` está activo, `ctx.waitUntil` →
  `LOYALTY POST /admin/{slug}/credits {order_id, phone: client_phone}` (errores silenciosos).
- `POST /panel/api/orders/{id}/confirm` y `/reject` → actualiza estado y llama grant/reject en LOYALTY.
- UI Pedidos: columna Estado (Pendiente / Confirmado / Rechazado como texto, sin pills), acciones
  "Confirmar entrega" / "Rechazar"; contador "N sin confirmar" junto a "Pedidos" en el menú lateral y aviso arriba
  de la tabla: "Confirma tus entregas: cada pedido confirmado le da un sello a tu cliente".

## 4. Panel — Fidelidad y QR (M2)

- Botón del club en el menú: `{slug}:config.club = {label}` lo lee el motor (`v1/catalog.js clubBanner`).
  En Fidelidad: interruptor "Mostrar botón del club en el menú" + "Texto del botón" (≤ 40, default
  "Únete al club"). Al guardar: club activo y botón visible → set `config.club`; si no → borrar la clave.
  Se hace en `PATCH /panel/api/loyalty` (mismo request) o un `PATCH /store` con campo `club` (elige uno y testéalo).
- Selector de modo (`play_mode`): "Sello + juego (recomendado)" / "Solo sellos".
- **Dos QR** (reusa el generador `qrMatrix` del panel): en Resultados y en Fidelidad, tarjeta "Tus códigos QR":
  - "QR del menú — para mesas y redes" → `https://{host}/`
  - "QR del club — para caja y mostrador" → `https://{host}/club`
  Cada uno con "Descargar PNG" (incluye el texto debajo del código).

## 5. Página del club (M3)

- Modo `"stamps"`: en vez de ruleta/raspadita, botón "Registrar visita" (pide PIN si `pin_required`) → `POST /play {game:"stamp"}`.
- Créditos: si `me.credits.granted > 0` → aviso destacado "Tienes N jugada(s) por tu pedido a domicilio" + botón que
  juega con `credit:true` (sin PIN ni ubicación). Si `me.credits.pending > 0` → "N sello(s) por confirmar de tus
  pedidos a domicilio. Se acreditan cuando el restaurante confirma la entrega o en tu próxima visita".
- Errores nuevos: `sin_creditos`. Tuteo neutro, sin innerHTML con datos del usuario.
