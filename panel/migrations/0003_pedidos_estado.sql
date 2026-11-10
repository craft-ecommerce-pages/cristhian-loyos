-- Estado de entrega de los pedidos del menú (sprint delivery/QR).
-- pending = recién llegado; confirmed = entregado (da 1 sello al cliente); rejected = rechazado.
ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'confirmed', 'rejected'));
ALTER TABLE orders ADD COLUMN status_at INTEGER;
CREATE INDEX orders_slug_status ON orders (slug, status);
