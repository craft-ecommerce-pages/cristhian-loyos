-- Fidelización: progreso de clientes finales por menú (slug). Un solo D1 compartido, tenant = slug.
-- Tiempos en epoch ms. Teléfono = solo dígitos con código de país (normalizePhone).

CREATE TABLE customers (
  slug            TEXT    NOT NULL,
  phone           TEXT    NOT NULL,
  name            TEXT    NOT NULL DEFAULT '',
  stamps          INTEGER NOT NULL DEFAULT 0,  -- sellos de la tarjeta actual (vuelve a 0 al completarla)
  visits          INTEGER NOT NULL DEFAULT 0,  -- jugadas válidas históricas (= visitas)
  cards_completed INTEGER NOT NULL DEFAULT 0,
  last_play_at    INTEGER,
  wallet_saved    INTEGER NOT NULL DEFAULT 0,  -- 1 = pidió el link de Google Wallet (best effort)
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (slug, phone)
);

CREATE TABLE plays (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL,
  phone      TEXT    NOT NULL,
  game       TEXT    NOT NULL CHECK (game IN ('wheel', 'scratch')),
  prize_id   TEXT,                -- NULL = "Sigue participando"
  reward_id  TEXT,
  via        TEXT    NOT NULL CHECK (via IN ('geo', 'pin', 'nogeo')),
  lat        REAL,
  lng        REAL,
  created_at INTEGER NOT NULL
);
CREATE INDEX plays_slug_at ON plays (slug, created_at);
CREATE INDEX plays_customer ON plays (slug, phone, created_at);

CREATE TABLE rewards (
  id          TEXT    PRIMARY KEY,  -- crypto.randomUUID()
  slug        TEXT    NOT NULL,
  phone       TEXT    NOT NULL,
  prize_id    TEXT    NOT NULL,     -- id del premio de la ruleta o STAMPS_PRIZE_ID
  label       TEXT    NOT NULL,     -- copia del label al momento de ganarlo
  source      TEXT    NOT NULL CHECK (source IN ('game', 'stamps')),
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'redeemed')),
  pin_fails   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,              -- NULL = no vence; "expired" se calcula al leer
  redeemed_at INTEGER
);
CREATE INDEX rewards_customer ON rewards (slug, phone, status);
CREATE INDEX rewards_prize ON rewards (slug, prize_id);

CREATE TABLE campaigns (
  id         INTEGER PRIMARY KEY,
  slug       TEXT    NOT NULL,
  title      TEXT    NOT NULL,
  body       TEXT    NOT NULL,
  sent       INTEGER NOT NULL DEFAULT 0,
  failed     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX campaigns_slug ON campaigns (slug, created_at);
