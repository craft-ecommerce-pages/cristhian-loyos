-- Food truck: cómo se sirve el pedido y a qué hora lo retira el cliente (opcional).
-- service_mode: 'dine_in' (para servirse aquí) | 'takeaway' (para llevar) | NULL (caja/legacy).
-- pickup_at: epoch ms de la hora programada de retiro; NULL = lo antes posible.
ALTER TABLE pos_orders ADD COLUMN service_mode TEXT;
ALTER TABLE pos_orders ADD COLUMN pickup_at INTEGER;
