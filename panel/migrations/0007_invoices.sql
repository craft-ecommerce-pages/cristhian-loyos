-- Facturación electrónica: una fila por pedido pagado (idempotencia por pedido).
-- No guarda secretos, certificados ni claves de proveedor. Montos siempre en centavos enteros.
-- Estados: pending (lista para enviar), manual (falta configuración/proveedor),
-- submitted (proveedor recibió, SRI aún no confirma), issued (SRI autorizó) y failed.

CREATE TABLE invoices (
  id                    TEXT    PRIMARY KEY,
  slug                  TEXT    NOT NULL,
  order_id              TEXT    NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('pending', 'manual', 'submitted', 'issued', 'failed')),
  provider              TEXT,                         -- ecuafact | factuplan | NULL
  environment           TEXT    CHECK (environment IN ('sandbox', 'production')),
  attempt               INTEGER NOT NULL DEFAULT 1,   -- 1 = emisión original; +1 solo tras rechazo final corregido
  idempotency_key       TEXT    NOT NULL,
  external_reference    TEXT    NOT NULL,
  draft_hash            TEXT    NOT NULL,             -- detecta un snapshot distinto para el mismo pedido
  snapshot              TEXT    NOT NULL,             -- invoice-draft.v1 (incluye identificación del comprador)
  currency              TEXT,                         -- NULL si el borrador está bloqueado por moneda no configurada
  subtotal_cents        INTEGER,                      -- NULL solo en borradores bloqueados sin líneas válidas
  tax_cents             INTEGER,                      -- NULL si la tasa/IVA no está configurado
  total_cents           INTEGER,                      -- NULL si el pedido no trae total en centavos
  provider_operation_id TEXT,                         -- idOperacion (Ecuafact) o receipt id (Factuplan)
  document_number       TEXT,                         -- estab-ptoEmi-secuencial
  access_key            TEXT,                         -- clave de acceso SRI (49 dígitos)
  authorization_number  TEXT,                         -- número de autorización si el proveedor lo distingue
  provider_status       TEXT,                         -- último estado normalizado del proveedor
  sri_status            TEXT,                         -- authorized | rejected | unknown | ...
  failure_code          TEXT,                         -- código propio, sin datos personales
  failure_message       TEXT,                         -- mensaje saneado y truncado
  pdf_url               TEXT,                         -- solo URL pública/firmada; nunca la API key
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  submitted_at          INTEGER,
  issued_at             INTEGER,
  UNIQUE (slug, order_id)
);

CREATE INDEX invoices_slug_status ON invoices (slug, status);
CREATE INDEX invoices_provider_operation ON invoices (provider_operation_id);
CREATE INDEX invoices_external_reference ON invoices (slug, external_reference);

-- Bitácora de transiciones. No copia snapshots ni identificación del comprador.
CREATE TABLE invoice_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  TEXT    NOT NULL,
  slug        TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT
);

CREATE INDEX invoice_events_invoice ON invoice_events (invoice_id, at);
