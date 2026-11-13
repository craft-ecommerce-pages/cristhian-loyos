-- Bendo (Geopagos): método de pago `bendo` con link hospedado.
--
-- SQLite no permite ampliar un CHECK existente, así que se reconstruyen
-- `pos_payments` y `pos_orders` copiando TODAS las filas con lista explícita de
-- columnas y recreando sus índices. Aditiva: conserva columnas, orden, tipos,
-- defaults, NOT NULL, CHECKs y UNIQUE de 0006/0009/0010; solo se añade `bendo`
-- a los dos CHECK de proveedor/método de pago.
--
-- ANTES de aplicar en remoto: backup/export de D1. En producción el workflow
-- `.github/workflows/deploy-client.yml` ya marca un punto de restauración
-- (`wrangler d1 time-travel info`) antes de migrar. Nunca ejecutar este archivo
-- a mano sobre datos sin respaldo: el DROP intermedio es real.

CREATE TABLE pos_payments_next (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  provider        TEXT    NOT NULL CHECK (provider IN ('cash', 'transfer', 'payphone', 'bendo')),
  idempotency_key TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'paid', 'rejected', 'unknown', 'failed')),
  amount_cents    INTEGER NOT NULL,
  currency        TEXT    NOT NULL,
  provider_ref    TEXT,                  -- ref propia (15 alfanuméricos): clientTransactionId / p= de Bendo
  provider_id     TEXT,                  -- id de transacción (Payphone) o uuid del link (Bendo)
  url             TEXT,                  -- payment_url de Payphone o checkout_url de Bendo
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

CREATE TABLE pos_orders_next (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL,
  sede_id         TEXT    NOT NULL,      -- congelada al crear: nunca cambia
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  number          INTEGER,               -- consecutivo diario compartido con order_seq
  source          TEXT    NOT NULL CHECK (source IN ('web', 'caja', 'mesero')),
  status          TEXT    NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'paid', 'rejected')),
  status_at       INTEGER,
  currency        TEXT    NOT NULL,      -- ISO 4217 (USD)
  subtotal_cents  INTEGER NOT NULL,
  total_cents     INTEGER NOT NULL,      -- recalculado en servidor desde el catálogo
  items           TEXT    NOT NULL,      -- snapshot JSON de líneas con unit_cents
  customer_name   TEXT    NOT NULL DEFAULT '',
  customer_phone  TEXT    NOT NULL DEFAULT '',
  delivery_mode   TEXT    NOT NULL DEFAULT 'pickup',
  address         TEXT,
  table_no        TEXT,
  note            TEXT,
  staff_id        TEXT,
  idempotency_key TEXT    NOT NULL,
  idempotency_hash TEXT   NOT NULL,      -- huella del cuerpo normalizado
  paid_at         INTEGER,
  payment_method  TEXT    NOT NULL DEFAULT 'cash'
    CHECK (payment_method IN ('cash', 'transfer', 'payphone', 'bendo')),
  billing_document_type   TEXT,          -- cedula | ruc
  billing_document_number TEXT,          -- normalizado, solo dígitos
  billing_email           TEXT,
  billing_address         TEXT,
  ready_at        INTEGER,               -- paid -> ready, marca de tiempo
  UNIQUE (slug, idempotency_key)
);

INSERT INTO pos_orders_next (
  id, slug, sede_id, created_at, updated_at, number, source, status, status_at, currency,
  subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, address,
  table_no, note, staff_id, idempotency_key, idempotency_hash, paid_at, payment_method,
  billing_document_type, billing_document_number, billing_email, billing_address, ready_at
)
SELECT
  id, slug, sede_id, created_at, updated_at, number, source, status, status_at, currency,
  subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, address,
  table_no, note, staff_id, idempotency_key, idempotency_hash, paid_at, payment_method,
  billing_document_type, billing_document_number, billing_email, billing_address, ready_at
FROM pos_orders;

DROP TABLE pos_orders;
ALTER TABLE pos_orders_next RENAME TO pos_orders;

CREATE INDEX pos_orders_slug_sede_created ON pos_orders (slug, sede_id, created_at DESC);
CREATE INDEX pos_orders_slug_status ON pos_orders (slug, status);
CREATE INDEX pos_orders_slug_ready ON pos_orders (slug, ready_at);
