# Sprint "Modo mesero + comandas (lite)": contrato

Vigentes: `panel/PLAN.md`, `panel/PLAN-CATALOGO.md`, `loyalty/PLAN-CAJA.md`. Donde choque, manda este.
Base: rama `feat/mesero` (desde `origin/master` 692daa3). Línea base verde: panel 77, loyalty 149, v1 33, worker 15.

## Idea y límite

El cliente arma el pedido desde el QR general del menú, elige "Mesa" y lo envía **al panel, sin WhatsApp**.
El mesero lo revisa en su celular (`/panel/mesero`), lo corrige si algo no cuadra y lo confirma. Desde la PC de la caja
se imprime la comanda con el diálogo normal del navegador. El mesero también puede crear pedidos a mano con botones de
productos. Cada ronda nueva es un pedido nuevo con la misma mesa, así no hay "cuenta abierta".

**Fuera de alcance:** cuenta abierta, cobro, división de cuenta, factura, caja, inventario, estaciones de cocina/bar,
ESC/POS, Bluetooth/RawBT, WebUSB, **impresión automática**, **polling o sondeo periódico** (cuesta requests de Workers
por negocio), Web Push, QR por mesa y modo sin conexión. Los pedidos de mesa y del mesero **no tocan el club**:
no crean ni liberan créditos (la visita se valida a mano en Modo caja, con escaneo o PIN). El delivery sigue igual.

Economía: cero trabajo en segundo plano. Solo hay requests cuando alguien toca un botón, carga la página o la pestaña
vuelve a estar visible (`visibilitychange`, un GET).

| ID | Worktree (rama) | Archivos |
|---|---|---|
| MS1 | `wt/mesa-k1` (`feat/mesa-k1`) | `panel/migrations/0005_mesas.sql`, `panel/src/orders.js`, `panel/src/api.js` (solo rutas `mesero/*` y `tables`), `panel/src/index.js` (solo rutas `/panel/o/mesa` y `/panel/mesero`), `panel/test/ms1*.test.mjs` |
| MS2 | `wt/mesa-k2` (`feat/mesa-k2`) | `panel/src/mesero.js` (reemplaza el stub), `shared/ticket.js` (nuevo), `panel/test/ms2*.test.mjs` |
| MS3 | `wt/mesa-k3` (`feat/mesa-k3`) | `panel/src/page.js`, `panel/test/ms3*.test.mjs` |
| MS4 | `wt/mesa-k4` (`feat/mesa-k4`) | `v1/catalog.js`, `v1/*.test.cjs` (nuevo `v1/mesa.test.cjs`) |
| ENS | `wt/mesa-int` (`feat/mesero`) | merge + QA + correcciones |

Nadie toca `loyalty/**`, `worker/**` ni `shared/qr.js`. `panel/src/caja.js` no se modifica: se importan sus exports
(`cajaSession`, `signCajaSession`, `OWNER_STAFF`).

## 1. Datos (MS1): `panel/migrations/0005_mesas.sql`

```sql
ALTER TABLE orders ADD COLUMN number      INTEGER;               -- número del día (se reinicia cada día, hora EC)
ALTER TABLE orders ADD COLUMN table_no    TEXT;                  -- ≤ 10 caracteres, opcional
ALTER TABLE orders ADD COLUMN source      TEXT NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'mesa', 'mesero'));
ALTER TABLE orders ADD COLUMN staff_id    TEXT;                  -- quien lo creó (mesero) o "owner"
ALTER TABLE orders ADD COLUMN note        TEXT;                  -- nota general ≤ 200
ALTER TABLE orders ADD COLUMN edited_at   INTEGER;
ALTER TABLE orders ADD COLUMN edited_by   TEXT;
ALTER TABLE orders ADD COLUMN print_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN printed_at  INTEGER;
CREATE TABLE order_seq (slug TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (slug, day));
CREATE TABLE panel_settings (
  slug TEXT PRIMARY KEY, tables_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tables_enabled IN (0, 1)), updated_at INTEGER NOT NULL
);
```

- **Número:** TODO pedido nuevo (web, mesa, mesero) recibe `number`. En el mismo `DB.batch`: upsert en `order_seq`
  (`day = dayOf(now)` de `contract.js`; `ON CONFLICT DO UPDATE SET n = n + 1`) y luego el `INSERT INTO orders` con
  `number = (SELECT n FROM order_seq WHERE slug = ? AND day = ?)`. El batch es una transacción, así que no hay números repetidos.
- Pedidos viejos quedan con `number = NULL` (la UI muestra los últimos 4 caracteres del id).

## 2. Forma de un pedido en las respuestas (MS1 la produce; MS2/MS3 la consumen)

```js
{ id, slug, created_at, total, currency, client_name, client_phone, delivery_mode, address,
  items: [{ nombre, qty, precio, variant? }], status: "pending"|"confirmed"|"rejected", status_at,
  number, table_no, source: "web"|"mesa"|"mesero", staff_id, note, edited_at, edited_by, print_count, printed_at }
```

`GET /panel/api/orders` (el del dueño, ya existe) devuelve también los campos nuevos.

## 3. API (MS1)

### Pública: `POST /panel/o/mesa` (sin sesión)
Body: `{ order_id?, items, total, currency, client_name, client_phone?, table_no?, note? }`. Mismo validador de ítems que
`/panel/o` (≤ 50 ítems, `nombre`, `qty` entero 1–999, `precio`, `variant?`), tamaño ≤ 16 KB, `client_phone` opcional
(≤ 40), `table_no` ≤ 10, `note` ≤ 200. `delivery_mode = "mesa"`, `source = "mesa"`, `status = "pending"`.
- `201 {id, number}`.
- Idempotencia: si llega un `order_id` que ya existe para ese slug → `200 {id, number}` del existente (sin duplicar).
- `403 {error:"mesas_apagadas"}` si `panel_settings.tables_enabled` no es 1 (sin fila = apagado).
- `400 {error:"pedido_invalido"}`, `413 {error:"pedido_muy_grande"}`, `429 {error:"demasiados_pedidos"}`
  (`LOGIN_LIMITER`, clave `om:{slug}:{ip}`; sin binding = sin límite, como hoy).
- Suma `events_daily.orders` igual que `/panel/o`. **No** llama al club.

`POST /panel/o` (ya existe) no cambia su respuesta (204 siempre); solo asigna `number`.

### Sesión de operación (mesero o dueño): `/panel/api/mesero/*`
Sesión = `cajaSession(request, env, site)` de `caja.js` (cookie `caja_s` o sesión del dueño → `staff_id = "owner"`).
Sin sesión → `401 {error:"sin_sesion"}`. **No** depende de `panel_features.loyalty` (nunca 402).

| Ruta | Respuesta |
|---|---|
| `POST mesero/login {pin}` | Rate limit `LOGIN_LIMITER` (`ml:{slug}:{ip}`) → `429 demasiados_intentos`. Proxy a LOYALTY `POST /admin/{slug}/staff/verify` (Bearer `LOYALTY_ADMIN_TOKEN`). OK → `200 {staff:{id,name}}` + `Set-Cookie` con `signCajaSession` (mismo nombre, atributos y TTL que `caja.js`). `403 pin_invalido`. Sin binding/token → `503 {error:"meseros_no_disponibles"}` |
| `POST mesero/logout` | `204` + cookie vencida |
| `GET mesero/me` | `{staff:{id,name}, owner:bool, store:{name, currency}, tables_enabled:bool}`. `name` del dueño = "Dueño"; para meseros se resuelve con LOYALTY `GET /admin/{slug}/staff` (si falla, `name = ""`). `store.name`/`currency` desde KV `{slug}:config` (`store_name`, `currency`, default `"$"`) |
| `GET mesero/catalog` | El mismo JSON que `GET /panel/api/catalog` (`load()` de `catalog.js`), solo lectura |
| `GET mesero/orders?status=pending\|confirmed\|rejected\|all&limit&offset` | `{orders, total, pending}`; `status` default `all`; `limit` ≤ 50 (default 30); orden `created_at DESC`; mismo `slug` |
| `POST mesero/orders {table_no?, note?, items}` | Pedido manual: `201 {order}` con `status="confirmed"`, `status_at=now`, `source="mesero"`, `staff_id` de la sesión, `delivery_mode="mesa"`, `client_name = table_no ? "Mesa {table_no}" : "Mostrador"`, `client_phone = ""`, `total = Σ qty·precio` (calculado en el servidor), `currency` del config. `400 pedido_invalido` |
| `PUT mesero/orders/{id} {items?, table_no?, note?}` | Solo si `status = "pending"` → si no, `409 estado_invalido`. Reemplaza lo enviado, recalcula `total = Σ qty·precio`, `edited_at=now`, `edited_by=staff_id` → `200 {order}`. `404 pedido_no_existe` |
| `POST mesero/orders/{id}/confirm` y `/reject` | Misma semántica que `setOrderStatus` (pending → terminal, idempotente, `409 estado_invalido`) → `200 {order}`. **Solo** si `source = "web"` se avisa al club (comportamiento actual) |
| `POST mesero/orders/{id}/print` | Solo `confirmed` (si no, `409 estado_invalido`). `print_count = print_count + 1`, `printed_at = now` (atómico, en un solo UPDATE) → `200 {order}` |

Precios: los ítems los manda el navegador (igual que `/panel/o` hoy). En mesa los valida el mesero antes de confirmar;
en los manuales manda la sesión del mesero. `// ponytail:` con esa nota en el código.

### Dueño (sesión del panel): `/panel/api/tables`
`GET tables` → `{enabled}`; `PUT tables {enabled:bool}` → upsert en `panel_settings` → `{enabled}`. `400` si no es bool.

### Rutas en `index.js` (MS1)
`/panel/o/mesa` → `handleTableOrder` (orders.js). `GET /panel/mesero` → `renderMeseroPage(request, env, site)` de
`./mesero.js` (stub en la base, lo implementa MS2), mismos headers que `/panel/caja`.

## 4. Página `/panel/mesero` (MS2): `panel/src/mesero.js`

`export async function renderMeseroPage(request, env, site) → string HTML`. Mobile-first, mismo estilo visual que
`caja.js` (variables, tipografía, botones). Runtime del navegador serializado como en `caja.js`: **incluye el shim
`var __name=function(f){return f};`** (sin él la página se queda en "Cargando" en Workers). Sin dependencias, sin
`innerHTML` con datos de usuario, tuteo neutro.

- **Entrada:** `GET mesero/me`. `401` → pantalla de PIN (`POST mesero/login`). `503` → "Los meseros no están
  disponibles; entra con la cuenta del dueño". Botón "Salir" (`mesero/logout`).
- **Pedidos (pestaña por defecto):** filtros Pendientes / Confirmados / Todos. Tarjeta: `#{number}` grande (o los últimos
  4 caracteres del id), mesa, etiqueta de origen (Mesa / Mesero / Web), hora (EC), nombre, ítems con variante, nota,
  "Editado" si `edited_at`, "Impresa ×n". Acciones: pendiente → Editar, Confirmar, Rechazar (con confirmación);
  confirmado → Imprimir / Reimprimir. Botón **"Actualizar"** visible y un GET al volver a la pestaña
  (`visibilitychange`). **Nada de `setInterval` ni sondeo.**
- **Nuevo pedido:** campo "Mesa" (opcional), chips de categorías, botones grandes de productos desde `mesero/catalog`
  (solo los visibles/activos según el doc). Producto con grupos de variantes → hoja simple para elegir (respeta
  min/max del grupo) y nota por ítem. Resumen con +/−, quitar, total y "Enviar pedido" → `POST mesero/orders` → vuelve
  a Pedidos. Los ítems se mandan como `{nombre, qty, precio, variant}` (variant = etiquetas y nota unidas con " · ",
  igual que el motor).
- **Editar:** el mismo constructor precargado con los ítems del pedido (cantidades, quitar, agregar del catálogo, mesa y
  nota) → `PUT mesero/orders/{id}`.
- **Imprimir:** `POST mesero/orders/{id}/print` → con el pedido devuelto arma el ticket con `ticketLines` y lo imprime en
  un `<iframe>` oculto (`print()`), con `@page` a 58 u 80 mm según la preferencia "Ancho del papel" guardada en
  `localStorage` (try/catch; default 80). Tarjeta de ayuda plegable: "Para imprimir sin diálogo, abre el panel en la PC
  de la caja con Chrome y la opción `--kiosk-printing`" con los pasos para Windows.

### `shared/ticket.js` (MS2)
`export function ticketLines(order, { store = "", width = 32, now } = {}) → string[]` (32 columnas para 58 mm,
48 para 80 mm). Autocontenida (se serializa al navegador con `String(ticketLines)`, igual que `qrMatrix`). Contenido:
nombre del negocio centrado, `COMANDA #023` (o el id corto), `Mesa 4` (`delivery_mode` mesa) / `Para llevar` (pickup) / `Domicilio` (delivery), fecha y hora EC
(UTC-5), `COPIA n` si `print_count > 1`, línea separadora, ítems `2 x Lomo saltado` con variantes/notas sangradas,
nota general y el nombre del cliente. **Sin precios** (es para la cocina). Corta las palabras al ancho y nunca devuelve
una línea más larga que `width`.

## 5. Panel del dueño (MS3): `panel/src/page.js`

- **Pedidos:** columna/etiqueta con `#number`, mesa y origen; "Impresa ×n". Botón "Abrir modo mesero" → `/panel/mesero`
  (pestaña nueva). Lo existente (confirmar/rechazar, paginación) se mantiene.
- **Nueva sección "Meseros y mesas"** en el menú lateral (grupo Ventas, debajo de Pedidos), **sin depender** de la función
  tarjeta (`features.loyalty`): alta/edición/baja de meseros con PIN (las mismas rutas `loyalty/staff` y los mismos
  componentes que hoy usa Fidelidad → Meseros; reutilízalos, no los dupliques). Interruptor "Recibir pedidos de mesa en
  el panel" (`GET/PUT /panel/api/tables`) con el texto "Tus clientes eligen Mesa en el menú y el pedido llega aquí, sin
  WhatsApp". Tarjeta con el QR de `https://{host}/panel/mesero` (`shared/qr.js`, como `cajaCard`): "Ábrelo en el celular
  del mesero; entra con su PIN".
- Fidelidad → Meseros puede quedar como acceso a la misma pantalla. Los tests existentes de page.js siguen verdes.

## 6. Motor (MS4): `v1/catalog.js`

Solo en menús **edge** (`window.__CONFIG__` presente). En legacy (`fetch config.json`) todo queda byte-idéntico.

- Con el modo `mesa` activo, se agrega dinámicamente (en JS, como `checkout_fields`; **no** se toca `worker/template.html`)
  un campo "Número de mesa (opcional)" (`id="fieldTable"`, ≤ 10 caracteres) y el teléfono deja de ser obligatorio
  (el nombre sí). Al cambiar a domicilio/retiro el campo se oculta y el teléfono vuelve a ser obligatorio.
- Enviar en modo mesa → `fetch('/panel/o/mesa', POST JSON)` con `{order_id, items, total, currency, client_name,
  client_phone?, table_no?}` (`items` = mismo formato `notifyItems` del checkout, con fees de mesa si los hubiera).
  `order_id` = `crypto.randomUUID()` reutilizado mientras el carrito no cambie (reintentos sin duplicar). Timeout 15 s.
  - `201/200` → vista de confirmación en el carrito: "Pedido #{number} enviado" + "Avísale a tu mesero que ya hiciste
    tu pedido", botón "Listo" que cierra. `track('Purchase', {contents, value, order_id: id})`, `clearCart()`.
    **No** abre WhatsApp ni registra en craft-crm.
  - `403 mesas_apagadas` → sigue el flujo actual (craft-crm / WhatsApp). Si falta el teléfono, pide completarlo.
  - Otro error o red → toast "No se pudo enviar tu pedido. Intenta de nuevo o avísale a tu mesero" (sin WhatsApp).
- Textos nuevos con `t()` y su par en el diccionario `EN`.

## 7. Integración (ENS)

Merge MS1 → MS2 → MS3 → MS4 en `feat/mesero`. Las 4 suites en verde (panel, loyalty, v1, worker). E2E local con
`wrangler dev` (D1 local con migraciones; craft-loyalty local para el PIN o mock del binding): pedido de mesa desde el
motor → aparece pendiente en `/panel/mesero` → editar → confirmar → imprimir (a PDF) → `print_count`; pedido manual;
interruptor apagado → `403` y cae a WhatsApp; delivery intacto (sigue creando crédito). Revisión de legibilidad
(nada de líneas > 140 caracteres en código nuevo). `HANDOFF-ENS-MESERO.md` con merges, desajustes, bugs y riesgos.

## 8. Deploy (Claude, con aprobación del operador; fuera de este sprint)

Backup de la D1 `craft-panel` → aplicar `0005_mesas.sql` a mano → push a `master` (Workers Builds despliega
`craft-panel`; Pages despliega `v1/`).
