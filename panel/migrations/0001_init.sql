-- Panel del restaurante (Menú SaaS). Un solo D1, tenant = slug. Tiempos en epoch ms.

CREATE TABLE panel_users (
  slug                 TEXT    NOT NULL,
  email                TEXT    NOT NULL,            -- minúsculas, recortado
  password_hash        TEXT    NOT NULL,            -- pbkdf2$100000$<salt_b64>$<hash_b64>
  pwd_ver              INTEGER NOT NULL DEFAULT 1,  -- +1 al cambiar/regenerar ⇒ invalida sesiones
  must_change_password INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (slug)                                -- un dueño por menú
);

CREATE TABLE panel_resets (
  token_hash TEXT    PRIMARY KEY,  -- sha256hex del token (el token nunca se guarda)
  slug       TEXT    NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE events_daily (
  slug   TEXT    NOT NULL,
  day    TEXT    NOT NULL,           -- YYYY-MM-DD hora Ecuador (UTC-5)
  views  INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);
