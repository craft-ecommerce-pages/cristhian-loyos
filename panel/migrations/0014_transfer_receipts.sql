-- Comprobantes de transferencia (2026-11-17).
-- Aditiva: el cliente web sube una captura de su comprobante y la caja la revisa
-- antes de confirmar el pago. El archivo vive en R2 bajo `private/receipts/…` y
-- esta tabla solo guarda su referencia. Se permiten varias subidas por pedido:
-- la más reciente es la vigente. No editar este archivo una vez aplicado en remoto.

CREATE TABLE transfer_receipts (
  id           TEXT    PRIMARY KEY,
  slug         TEXT    NOT NULL,
  order_id     TEXT    NOT NULL,
  r2_key       TEXT    NOT NULL,
  content_type TEXT    NOT NULL,
  size_bytes   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX transfer_receipts_order ON transfer_receipts (slug, order_id, created_at);
