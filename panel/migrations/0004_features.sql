-- Función "tarjeta" habilitada por plan (sprint crecimiento + migración legacy).
-- Sin fila = habilitado: los clubs existentes y los menús SaaS siguen igual.
-- La apaga el CRM al migrar un menú legacy (source='legacy') y el cobro del addon (source='addon').
CREATE TABLE panel_features (
  slug       TEXT    PRIMARY KEY,           -- un estado por menú
  loyalty    INTEGER NOT NULL CHECK (loyalty IN (0, 1)),
  source     TEXT,                          -- saas | addon | legacy (lo decide quien escribe)
  updated_at INTEGER NOT NULL
);
