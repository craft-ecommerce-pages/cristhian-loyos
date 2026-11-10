-- Reportes de ventas: snapshot congelado de las líneas cobradas del POS (0006).
-- Aditiva: no toca `orders` (legacy) ni duplica columnas de `pos_orders`.
-- POS escribe estas filas en el mismo batch D1 que marca la orden como `paid`;
-- el reporte solo lee. Montos siempre en centavos enteros (INTEGER).
--
-- `report_category` es la categoría comercial congelada al cobrar. Son cuatro:
-- sushi, fastfood, tradicional y postres. La vista pública muestra las tres
-- primeras por separado; postres se conserva para conciliación exacta.

CREATE TABLE pos_order_lines (
  slug             TEXT    NOT NULL,
  order_id         TEXT    NOT NULL,              -- pos_orders.id
  line_index       INTEGER NOT NULL CHECK (line_index >= 0),
  report_category  TEXT    NOT NULL
    CHECK (report_category IN ('sushi', 'fastfood', 'tradicional', 'postres')),
  product_id       TEXT,
  variant_id       TEXT,
  name             TEXT,                          -- nombre congelado para auditoría
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_cents       INTEGER NOT NULL CHECK (unit_cents >= 0),
  line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0),
  created_at       INTEGER NOT NULL,
  -- Clave natural idempotente: un reintento de cobro nunca duplica la línea.
  PRIMARY KEY (slug, order_id, line_index)
);

CREATE INDEX pos_order_lines_slug_category ON pos_order_lines (slug, report_category);
CREATE INDEX pos_order_lines_order ON pos_order_lines (slug, order_id);
