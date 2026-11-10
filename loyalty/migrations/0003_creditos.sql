-- Créditos por pedido a domicilio y nuevos modos de juego (sello sin sorteo, jugada con crédito).
-- SQLite no permite alterar un CHECK: se recrea `plays` con el CHECK ampliado.
-- Ninguna fila cambia de valor; solo se agregan 'stamp' a game y 'credit' a via.

CREATE TABLE plays_v3 (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  game       TEXT    NOT NULL CHECK (game IN ('wheel', 'scratch', 'stamp')),
  prize_id   TEXT,
  reward_id  TEXT,
  via        TEXT    NOT NULL CHECK (via IN ('geo', 'pin', 'nogeo', 'credit')),
  lat        REAL,
  lng        REAL,
  staff_id   TEXT,
  device_hash TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO plays_v3 (id, slug, phone, game, prize_id, reward_id, via, lat, lng, staff_id, device_hash, created_at)
  SELECT id, slug, phone, game, prize_id, reward_id, via, lat, lng, staff_id, device_hash, created_at FROM plays;

DROP TABLE plays;
ALTER TABLE plays_v3 RENAME TO plays;
CREATE INDEX plays_slug_at ON plays (slug, created_at);
CREATE INDEX plays_customer ON plays (slug, phone, created_at);
CREATE INDEX plays_slug_device_at ON plays (slug, device_hash, created_at);

-- Un crédito = una jugada pagada con un pedido a domicilio. Nace `pending` y el local lo libera
-- (grant/reject del panel o PIN del mesero en /play). `order_id` es el id del pedido en el panel.
CREATE TABLE credits (
  id         TEXT    PRIMARY KEY,           -- crypto.randomUUID()
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,              -- normalizePhone; puede no existir aún en customers
  order_id   TEXT    NOT NULL,
  source     TEXT    NOT NULL CHECK (source = 'delivery'),
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'used', 'rejected')),
  created_at INTEGER NOT NULL,
  granted_at INTEGER,
  used_at    INTEGER,
  granted_by TEXT,                          -- 'owner' (panel) o staff_id del mesero
  UNIQUE (slug, order_id)
);
CREATE INDEX credits_customer ON credits (slug, phone, status);
