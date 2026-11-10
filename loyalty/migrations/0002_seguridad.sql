-- Endurecimiento del club: identidad por dispositivo y trazabilidad del personal.
CREATE TABLE customer_devices (
  slug         TEXT NOT NULL,
  phone        TEXT NOT NULL,
  device_hash  TEXT NOT NULL,
  staff_id     TEXT,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (slug, phone, device_hash)
);
CREATE INDEX customer_devices_slug_device ON customer_devices (slug, device_hash);

CREATE TABLE staff (
  id         TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  name       TEXT NOT NULL,
  pin_hash   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE INDEX staff_slug_active ON staff (slug, active);

-- Ventana móvil de 24 h para frenar fuerza bruta repartida entre teléfonos.
CREATE TABLE device_pin_fails (
  slug             TEXT NOT NULL,
  device_hash      TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  fails            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, device_hash)
);

ALTER TABLE plays ADD COLUMN staff_id TEXT;
ALTER TABLE plays ADD COLUMN device_hash TEXT;
CREATE INDEX plays_slug_device_at ON plays (slug, device_hash, created_at);
ALTER TABLE rewards ADD COLUMN redeemed_staff_id TEXT;
ALTER TABLE rewards ADD COLUMN reminded_at INTEGER;
CREATE INDEX rewards_reminder ON rewards (status, expires_at, reminded_at);
