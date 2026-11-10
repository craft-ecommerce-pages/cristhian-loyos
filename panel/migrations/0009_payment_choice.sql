-- Método elegido por el comprador; el cobro sigue separado y se concilia antes de cocina.
ALTER TABLE pos_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'
  CHECK (payment_method IN ('cash', 'transfer', 'payphone'));
