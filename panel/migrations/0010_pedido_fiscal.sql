-- Pedido web: datos fiscales obligatorios, marca de "listo" y pago por
-- transferencia confirmado manualmente. Aditiva sobre `pos_orders` (solo agrega
-- columnas) y reconstruye `pos_payments` para ampliar su CHECK de `provider`
-- (SQLite no permite ALTER de un CHECK). Copia todas las filas existentes antes
-- de reemplazar la tabla: en producción, hacer backup/export de D1 primero.
--
-- PII fiscal (documento, correo y dirección) vive solo en `pos_orders` para el
-- adaptador de facturación. Nunca se publica en /api, logs, URLs ni analítica.

ALTER TABLE pos_orders ADD COLUMN billing_document_type TEXT;    -- cedula | ruc
ALTER TABLE pos_orders ADD COLUMN billing_document_number TEXT;  -- normalizado, solo dígitos
ALTER TABLE pos_orders ADD COLUMN billing_email TEXT;
ALTER TABLE pos_orders ADD COLUMN billing_address TEXT;
ALTER TABLE pos_orders ADD COLUMN ready_at INTEGER;              -- paid -> ready, marca de tiempo

CREATE INDEX pos_orders_slug_ready ON pos_orders (slug, ready_at);

CREATE TABLE pos_payments_next (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  provider        TEXT    NOT NULL CHECK (provider IN ('cash', 'transfer', 'payphone')),
  idempotency_key TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'paid', 'rejected', 'unknown', 'failed')),
  amount_cents    INTEGER NOT NULL,
  currency        TEXT    NOT NULL,
  provider_ref    TEXT,
  provider_id     TEXT,
  url             TEXT,
  authorization   TEXT,
  message         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  UNIQUE (slug, order_id, idempotency_key),
  UNIQUE (slug, provider_ref)
);

INSERT INTO pos_payments_next (
  id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, provider_ref,
  provider_id, url, authorization, message, attempts, created_at, updated_at, paid_at
)
SELECT
  id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, provider_ref,
  provider_id, url, authorization, message, attempts, created_at, updated_at, paid_at
FROM pos_payments;

DROP TABLE pos_payments;
ALTER TABLE pos_payments_next RENAME TO pos_payments;

CREATE INDEX pos_payments_ref ON pos_payments (slug, provider_ref);
CREATE INDEX pos_payments_order ON pos_payments (slug, order_id);
