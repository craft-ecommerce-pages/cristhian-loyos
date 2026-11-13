-- Canal de cobro de Bendo (2026-11-13).
-- Aditiva: `channel` distingue el cobro por link (`link`) del registro manual con
-- datáfono (`datafono`). Los pagos Bendo anteriores a esta migración son cobros
-- por link y se marcan como tales; efectivo, transferencia y payphone quedan NULL.
-- No editar este archivo una vez aplicado en remoto.

ALTER TABLE pos_payments ADD COLUMN channel TEXT CHECK (channel IS NULL OR channel IN ('link', 'datafono'));
UPDATE pos_payments SET channel = 'link' WHERE provider = 'bendo' AND channel IS NULL;
