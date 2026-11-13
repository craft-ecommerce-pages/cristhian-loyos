-- Turnos y cierre de caja (2026-11-13).
-- Aditiva: una caja por sede, arqueo ciego, movimientos de efectivo y snapshot
-- del reporte al cerrar. Los pagos existentes quedan sin turno (`shift_id` NULL)
-- y se asignan al abrir el próximo turno de su sede.
--
-- El índice parcial `pos_shifts_one_open` es la garantía de "máximo un turno
-- abierto por sede" incluso con dos cajas cobrando a la vez: D1 rechaza el
-- segundo INSERT. No editar este archivo una vez aplicado en remoto.

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
