-- Modo caja: la tarjeta del cliente identifica su club en el local.
-- 1) customers.card_code: 10 caracteres, único por slug (secreto frente a otros locales, no un id global).
-- 2) credits.source acepta 'scan' (crédito que crea el mesero al validar la visita en modo juego).
-- 3) plays.via acepta 'scan' (visita validada desde la caja).
-- SQLite no permite alterar un CHECK: se recrean `credits` y `plays` como en 0003/0004, copiando
-- filas, columnas e índices.

ALTER TABLE customers ADD COLUMN card_code TEXT;
CREATE UNIQUE INDEX customers_card_code ON customers (slug, card_code);

CREATE TABLE credits_v5 (
  id         TEXT    PRIMARY KEY,           -- crypto.randomUUID()
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  order_id   TEXT    NOT NULL,              -- pedido del panel o 'scan:{uuid}' desde la caja
  source     TEXT    NOT NULL CHECK (source IN ('delivery', 'scan')),
  status     TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'used', 'rejected')),
  created_at INTEGER NOT NULL,
  granted_at INTEGER,
  used_at    INTEGER,
  granted_by TEXT,                          -- 'owner' (panel) o staff_id del mesero
  UNIQUE (slug, order_id)
);

INSERT INTO credits_v5 (id, slug, phone, order_id, source, status, created_at, granted_at, used_at, granted_by)
  SELECT id, slug, phone, order_id, source, status, created_at, granted_at, used_at, granted_by FROM credits;

DROP TABLE credits;
ALTER TABLE credits_v5 RENAME TO credits;
CREATE INDEX credits_customer ON credits (slug, phone, status);

CREATE TABLE plays_v5 (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  game       TEXT    NOT NULL CHECK (game IN ('wheel', 'scratch', 'stamp')),
  prize_id   TEXT,
  reward_id  TEXT,
  via        TEXT    NOT NULL CHECK (via IN ('geo', 'pin', 'nogeo', 'credit', 'scan')),
  lat        REAL,
  lng        REAL,
  staff_id   TEXT,
  device_hash TEXT,
  created_at INTEGER NOT NULL
);

INSERT INTO plays_v5 (id, slug, phone, game, prize_id, reward_id, via, lat, lng, staff_id, device_hash, created_at)
  SELECT id, slug, phone, game, prize_id, reward_id, via, lat, lng, staff_id, device_hash, created_at FROM plays;

DROP TABLE plays;
ALTER TABLE plays_v5 RENAME TO plays;
CREATE INDEX plays_slug_at ON plays (slug, created_at);
CREATE INDEX plays_customer ON plays (slug, phone, created_at);
CREATE INDEX plays_slug_device_at ON plays (slug, device_hash, created_at);
