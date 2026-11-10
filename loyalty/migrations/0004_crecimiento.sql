-- Crecimiento: cumpleaños, recuperación de inactivos y opiniones del cliente.
-- 1) customers.birthday (MM-DD, sin año), opcional.
-- 2) rewards.source acepta 'birthday' y 'winback'. SQLite no permite alterar un CHECK: se recrea
--    la tabla como hizo 0003 con `plays`, copiando filas e índices y todas las columnas de 0002.
-- 3) feedback: una opinión privada (1-5) por jugada/visita.

ALTER TABLE customers ADD COLUMN birthday TEXT;
-- Índice del cron: busca por día/mes dentro de un tenant.
CREATE INDEX customers_birthday ON customers (slug, birthday);

CREATE TABLE rewards_v4 (
  id                TEXT    PRIMARY KEY,  -- crypto.randomUUID()
  slug              TEXT    NOT NULL,
  phone             TEXT    NOT NULL,
  prize_id          TEXT    NOT NULL,     -- id del premio, STAMPS_PRIZE_ID, __birthday o __winback
  label             TEXT    NOT NULL,
  source            TEXT    NOT NULL CHECK (source IN ('game', 'stamps', 'birthday', 'winback')),
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed')),
  pin_fails         INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER,
  redeemed_at       INTEGER,
  redeemed_staff_id TEXT,
  reminded_at       INTEGER
);

INSERT INTO rewards_v4
  (id, slug, phone, prize_id, label, source, status, pin_fails, created_at, expires_at,
   redeemed_at, redeemed_staff_id, reminded_at)
  SELECT id, slug, phone, prize_id, label, source, status, pin_fails, created_at, expires_at,
         redeemed_at, redeemed_staff_id, reminded_at
  FROM rewards;

DROP TABLE rewards;
ALTER TABLE rewards_v4 RENAME TO rewards;
CREATE INDEX rewards_customer ON rewards (slug, phone, status);
CREATE INDEX rewards_prize ON rewards (slug, prize_id);
CREATE INDEX rewards_reminder ON rewards (status, expires_at, reminded_at);
-- Cron de cumpleaños/winback: ¿este cliente ya recibió ese regalo en el período?
CREATE INDEX rewards_source ON rewards (slug, phone, source, created_at);

CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  rating     INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    TEXT    NOT NULL DEFAULT '' CHECK (length(comment) <= 500),
  play_id    INTEGER NOT NULL,           -- jugada/visita que se está opinando
  created_at INTEGER NOT NULL
);
CREATE INDEX feedback_slug_at ON feedback (slug, created_at);
-- Una sola opinión por jugada (y por tenant).
CREATE UNIQUE INDEX feedback_play ON feedback (slug, play_id);
