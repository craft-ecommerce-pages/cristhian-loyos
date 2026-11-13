# Turnos y cierre de caja — arquitectura y contrato

Estado: diseño aprobado por Juan Carlos el 2026-11-13. Munch opera como POS: además de pedidos y comandas, cada sede maneja efectivo y debe cuadrarlo.

## Decisiones (confirmadas)

1. **Una caja por sede.** Como máximo un turno abierto por sede; varios cajeros cobran en el mismo turno.
2. **Arqueo ciego.** El cajero ingresa el efectivo contado sin ver el esperado; el sistema muestra esperado y diferencia recién después de cerrar.
3. **Sin turno abierto no hay cobro manual.** Efectivo y transferencia devuelven `409 caja_cerrada`. Los pagos con tarjeta (Bendo) se confirman siempre; si no hay turno, quedan sin turno y se asignan al próximo que se abra en esa sede.
4. **El cajero abre, registra movimientos y cierra; el dueño revisa** el historial y las diferencias de todas las sedes.

## Conceptos

- **Turno** (`pos_shifts`): apertura con fondo inicial (`opening_float_cents`), cierre con efectivo contado. Snapshot de totales al cerrar; un turno cerrado es inmutable.
- **Movimiento de efectivo** (`pos_cash_movements`): `in` (ingreso: cambio adicional, reposición) u `out` (retiro: depósito al banco, gasto menor, pago a proveedor). Monto entero positivo en centavos y motivo obligatorio (3–120 caracteres).
- **Efectivo esperado** = fondo inicial + cobros `cash` pagados del turno + movimientos `in` − movimientos `out`.
- **Diferencia** = contado − esperado (negativa = faltante, positiva = sobrante).
- **Ventas del turno por método:** `cash`, `transfer`, `bendo` (y `payphone` solo si hay filas históricas), con la cantidad de pagos y el total; el total general debe igualar la suma de los pagos `paid` del turno.

## Datos (migración `0012_caja_turnos.sql`, aditiva)

```sql
CREATE TABLE pos_shifts (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, sede_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by TEXT NOT NULL, opened_at INTEGER NOT NULL,
  opening_float_cents INTEGER NOT NULL CHECK (opening_float_cents >= 0),
  open_key TEXT NOT NULL,
  closed_by TEXT, closed_at INTEGER, close_key TEXT,
  counted_cash_cents INTEGER, expected_cash_cents INTEGER, difference_cents INTEGER,
  totals TEXT,               -- JSON snapshot del reporte al cerrar
  note TEXT,
  UNIQUE (slug, open_key)
);
CREATE UNIQUE INDEX pos_shifts_one_open ON pos_shifts (slug, sede_id) WHERE status = 'open';
CREATE INDEX pos_shifts_sede_opened ON pos_shifts (slug, sede_id, opened_at DESC);

CREATE TABLE pos_cash_movements (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL, shift_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('in','out')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL, staff_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (slug, idempotency_key)
);
CREATE INDEX pos_cash_movements_shift ON pos_cash_movements (slug, shift_id);

ALTER TABLE pos_payments ADD COLUMN shift_id TEXT;
CREATE INDEX pos_payments_shift ON pos_payments (slug, shift_id);
```

## Asignación de pagos a turnos

- `payManual` (efectivo/transferencia) en `orders.js`: antes de cobrar busca el turno abierto de `order.sede_id`; si no existe → `409 caja_cerrada`. El `INSERT` del pago guarda `shift_id`.
- `settlePaymentApproved` (tarjeta): en el mismo batch, `UPDATE pos_payments SET shift_id = (SELECT id FROM pos_shifts WHERE slug = ? AND sede_id = ? AND status = 'open') WHERE slug = ? AND id = ? AND shift_id IS NULL`.
- Al abrir un turno, en el mismo batch se asignan al nuevo turno los pagos `paid` sin turno de esa sede (`UPDATE … WHERE shift_id IS NULL AND status = 'paid' AND order_id IN (SELECT id FROM pos_orders WHERE slug = ? AND sede_id = ?)`).
- Un cierre con pagos en `pending/unknown` de esa sede se permite, pero el reporte los lista en `pending_payments` (cantidad y total) como aviso.

## API (módulo `panel/src/turnos.js`)

Sesión: dueño (`owner`) o cajero/mesero con cookie `caja_s`, con la misma resolución que `handlePosApi`. El cajero solo opera sedes autorizadas (`authorizedForSede`). Errores `{error}` como el resto del panel. Todas las mutaciones son JSON e idempotentes por `idempotency_key` (8–100 caracteres `[A-Za-z0-9_.:-]`).

| Ruta | Quién | Resultado |
|---|---|---|
| `GET /panel/api/turnos/actual?sede_id=` | cajero/dueño | `{shift: null}` o `{shift:{id, sede_id, opened_at, opened_by, opening_float_cents, movements:[…]}}`. **Al cajero no se le devuelven** ventas, esperado ni diferencia (arqueo ciego). El dueño recibe además `report` parcial en vivo. |
| `POST /panel/api/turnos/abrir` `{sede_id, opening_float_cents, idempotency_key}` | cajero/dueño | `201 {shift}`. Si ya hay uno abierto en la sede → `409 caja_ya_abierta` (con la misma clave → devuelve el mismo turno). |
| `POST /panel/api/turnos/:id/movimientos` `{kind, amount_cents, reason, idempotency_key}` | cajero/dueño | `201 {movement}`. Turno cerrado → `409 turno_cerrado`. Un `out` mayor al efectivo esperado se permite (el arqueo lo delata). |
| `POST /panel/api/turnos/:id/cerrar` `{counted_cash_cents, note?, idempotency_key}` | cajero/dueño | `200 {report}`. Calcula, guarda snapshot y cierra en un batch condicionado a `status='open'`. Reintento con la misma clave devuelve el mismo reporte; otra clave sobre turno cerrado → `409 turno_cerrado`. |
| `GET /panel/api/turnos/:id` | dueño; cajero solo si el turno está cerrado y es de su sede | `{report}` (para reimprimir el Z). |
| `GET /panel/api/turnos?sede_id=&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=` | solo dueño | `{shifts:[{id, sede_id, status, opened_at, closed_at, opened_by, closed_by, opening_float_cents, expected_cash_cents, counted_cash_cents, difference_cents, total_cents}]}`, `limit` máx. 50, fechas en America/Guayaquil. |

`report`:

```json
{ "shift_id": "…", "sede_id": "sede-01", "status": "closed",
  "opened_at": 0, "closed_at": 0, "opened_by": "…", "closed_by": "…",
  "opening_float_cents": 2000,
  "sales": [{ "method": "cash", "count": 12, "total_cents": 18450 }, { "method": "bendo", "count": 3, "total_cents": 4100 }],
  "sales_total_cents": 22550,
  "movements": { "in_cents": 0, "out_cents": 5000, "items": [{ "kind": "out", "amount_cents": 5000, "reason": "Depósito banco", "staff_id": "…", "created_at": 0 }] },
  "expected_cash_cents": 15450, "counted_cash_cents": 15400, "difference_cents": -50,
  "pending_payments": { "count": 0, "total_cents": 0 },
  "orders": { "paid": 15, "rejected": 1 },
  "note": "" }
```

## Interfaz

- **Modo mesero/cajero (`panel/src/mesero.js`)**: barra de estado de caja de la sede activa. Cerrada → botón "Abrir caja" (fondo inicial). Abierta → "Caja abierta desde HH:MM", botones "Ingreso/Retiro de efectivo" y "Cerrar caja". El cierre pide solo el efectivo contado (con ayuda opcional de conteo por denominaciones USD: 20, 10, 5, 1 billetes; 1, 0.50, 0.25, 0.10, 0.05, 0.01 monedas) y la nota; tras cerrar muestra el reporte y "Imprimir cierre". Al intentar cobrar con la caja cerrada, el `409 caja_cerrada` muestra "Abre la caja de esta sede para cobrar".
- **Panel del dueño (`panel/src/page.js`)**: misma barra en la sección de pedidos POS, y una sección "Cierres de caja" con filtro por sede y fechas, tabla de turnos (diferencia en rojo si es faltante) y detalle con el reporte y reimpresión.
- **Ticket Z (`shared/ticket.js`)**: `shiftTicketLines(report, {store, width, sedeName})` en 32/48 columnas (58/80 mm), reutilizando el estilo de la comanda.

## Partes en paralelo

| Parte | Archivos |
|---|---|
| D · backend | `panel/migrations/0012_caja_turnos.sql`, `panel/src/turnos.js`, `panel/src/orders.js` (solo `payManual`, `settlePaymentApproved` y helpers del turno), `panel/test/turnos.test.mjs` |
| E · interfaz cajero | `panel/src/mesero.js`, `shared/ticket.js` (solo `shiftTicketLines`), `panel/test/ui-turnos-mesero.test.mjs` |
| F · interfaz dueño | `panel/src/page.js`, `panel/test/ui-turnos-panel.test.mjs` |
| Ensamblador | `panel/src/api.js` (rutas `turnos/*` con la sesión de `handlePosApi`), integración y QA |
