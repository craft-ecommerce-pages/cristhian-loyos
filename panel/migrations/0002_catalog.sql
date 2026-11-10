-- Catálogo nativo del panel y copia de pedidos web. Un documento por menú.
CREATE TABLE catalogs (
  slug       TEXT PRIMARY KEY,
  doc        TEXT NOT NULL,
  version    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  total         REAL NOT NULL,
  currency      TEXT NOT NULL,
  client_name   TEXT NOT NULL,
  client_phone  TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  address       TEXT,
  items         TEXT NOT NULL
);
CREATE INDEX orders_slug_created_at ON orders (slug, created_at DESC);
