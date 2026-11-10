-- POS: pedidos del cliente web y de caja con sede obligatoria, importes en centavos,
-- idempotencia de órdenes/pagos y comanda emitida solo al quedar pagada.
-- Aditiva: no toca `orders` ni sus estados legacy. El número diario sigue en `order_seq`.

CREATE TABLE pos_sedes (
  slug       TEXT    NOT NULL,
  id         TEXT    NOT NULL,           -- estable: se deriva del nombre la primera vez
  nombre     TEXT    NOT NULL,
  direccion  TEXT    NOT NULL DEFAULT '',
  universidad TEXT   NOT NULL DEFAULT '',
  activa     INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, id)
);

CREATE TABLE pos_orders (
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
  UNIQUE (slug, idempotency_key)
);
CREATE INDEX pos_orders_slug_sede_created ON pos_orders (slug, sede_id, created_at DESC);
CREATE INDEX pos_orders_slug_status ON pos_orders (slug, status);

CREATE TABLE pos_payments (
  id              TEXT    PRIMARY KEY,
  slug            TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  provider        TEXT    NOT NULL CHECK (provider IN ('cash', 'payphone')),
  idempotency_key TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'pending', 'paid', 'rejected', 'unknown', 'failed')),
  amount_cents    INTEGER NOT NULL,
  currency        TEXT    NOT NULL,
  provider_ref    TEXT,                  -- clientTransactionId de Payphone (15 alfanuméricos)
  provider_id     TEXT,                  -- id de transacción devuelto por Payphone
  url             TEXT,                  -- payment_url de Prepare
  authorization   TEXT,
  message         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  UNIQUE (slug, order_id, idempotency_key),
  UNIQUE (slug, provider_ref)
);
CREATE INDEX pos_payments_ref ON pos_payments (slug, provider_ref);
CREATE INDEX pos_payments_order ON pos_payments (slug, order_id);

-- Comanda: una fila por pedido pagado. Se crea al confirmar el pago (INSERT OR IGNORE),
-- así un retorno repetido o un reintento nunca liberan dos comandas.
CREATE TABLE pos_comandas (
  slug        TEXT    NOT NULL,
  order_id    TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  printed_at  INTEGER,
  print_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, order_id)
);

-- Acuse de impresión idempotente por clave (varias tablets pueden reimprimir).
CREATE TABLE pos_comanda_prints (
  slug            TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  printed_at      INTEGER NOT NULL,
  PRIMARY KEY (slug, order_id, idempotency_key)
);

-- PIN local del mesero para operar caja sin craft-loyalty (fallback del login).
CREATE TABLE pos_staff (
  slug       TEXT    NOT NULL,
  id         TEXT    NOT NULL,           -- sesión: "l_" + 10 alfanuméricos
  name       TEXT    NOT NULL,
  pin_lookup TEXT    NOT NULL,           -- sha256(slug:pin): búsqueda, nunca el PIN
  pin_hash   TEXT    NOT NULL,           -- pbkdf2 (auth.js)
  sedes      TEXT    NOT NULL DEFAULT '[]',  -- sedes autorizadas (JSON array de ids)
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (slug, id)
);
CREATE UNIQUE INDEX pos_staff_pin ON pos_staff (slug, pin_lookup);
