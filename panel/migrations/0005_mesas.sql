-- Modo mesero + comandas. Los pedidos existentes conservan number=NULL.
ALTER TABLE orders ADD COLUMN number INTEGER;
ALTER TABLE orders ADD COLUMN table_no TEXT;
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'web'
  CHECK (source IN ('web', 'mesa', 'mesero'));
ALTER TABLE orders ADD COLUMN staff_id TEXT;
ALTER TABLE orders ADD COLUMN note TEXT;
ALTER TABLE orders ADD COLUMN edited_at INTEGER;
ALTER TABLE orders ADD COLUMN edited_by TEXT;
ALTER TABLE orders ADD COLUMN print_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN printed_at INTEGER;

CREATE TABLE order_seq (
  slug TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (slug, day)
);

CREATE TABLE panel_settings (
  slug TEXT PRIMARY KEY,
  tables_enabled INTEGER NOT NULL DEFAULT 0 CHECK (tables_enabled IN (0, 1)),
  updated_at INTEGER NOT NULL
);
