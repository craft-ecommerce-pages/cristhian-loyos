// Bendo (parte B · datos e infraestructura): la migración 0011 reconstruye
// `pos_payments` y `pos_orders` sin perder filas, columnas ni índices, y acepta
// `bendo` en ambos CHECK. El pedido web con `payment_method=bendo` responde 503
// cuando el proveedor no está disponible y 201 en `BENDO_MODE=mock`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import panel from "../src/index.js";
import { createPaymentAttempt, failPayment, markPaymentUnknown, posOrderRow, settlePaymentRejected } from "../src/orders.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const migrationFiles = () => readdirSync(MIGRATIONS).filter(file => file.endsWith(".sql")).sort();
const migrationSql = file => readFileSync(new URL(file, MIGRATIONS), "utf8");

const POS_ORDER_COLUMNS = [
  "id", "slug", "sede_id", "created_at", "updated_at", "number", "source", "status", "status_at", "currency",
  "subtotal_cents", "total_cents", "items", "customer_name", "customer_phone", "delivery_mode", "address",
  "table_no", "note", "staff_id", "idempotency_key", "idempotency_hash", "paid_at", "payment_method",
  "billing_document_type", "billing_document_number", "billing_email", "billing_address", "ready_at",
];
const POS_PAYMENT_COLUMNS = [
  "id", "slug", "order_id", "provider", "idempotency_key", "status", "amount_cents", "currency", "provider_ref",
  "provider_id", "url", "authorization", "message", "attempts", "created_at", "updated_at", "paid_at",
];

const orderRow = {
  id: "orden-prev-1", slug: "pizza", sede_id: "centro", created_at: 1_760_000_000_000, updated_at: 1_760_000_001_000,
  number: 7, source: "web", status: "paid", status_at: 1_760_000_002_000, currency: "USD",
  subtotal_cents: 1_700, total_cents: 1_700, items: JSON.stringify([{ product_id: "margarita", name: "Margarita", qty: 2, unit_cents: 850, subtotal_cents: 1_700, report_category: "tradicional" }]),
  customer_name: "Ana", customer_phone: "0991234567", delivery_mode: "pickup", address: null, table_no: "3",
  note: "sin cebolla", staff_id: "l_ABC1234567", idempotency_key: "pedido-prev-0001", idempotency_hash: "hash-prev-1",
  paid_at: 1_760_000_002_000, payment_method: "cash", billing_document_type: "cedula",
  billing_document_number: "1712345678", billing_email: "ana@example.com", billing_address: "Av. 1", ready_at: 1_760_000_003_000,
};
const paymentRow = {
  id: "pago-prev-1", slug: "pizza", order_id: "orden-prev-1", provider: "cash", idempotency_key: "pago-prev-0001",
  status: "paid", amount_cents: 1_700, currency: "USD", provider_ref: "ABCDEFGHJKLMNPQ", provider_id: null,
  url: null, authorization: null, message: null, attempts: 2,
  created_at: 1_760_000_000_500, updated_at: 1_760_000_002_000, paid_at: 1_760_000_002_000,
};

// 0001..0010 + filas de ejemplo: el estado real de producción antes de 0011.
function databaseBefore0011() {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles().filter(file => file < "0011")) db.exec(migrationSql(file));
  db.prepare(
    `INSERT INTO pos_orders (${POS_ORDER_COLUMNS.join(", ")}) VALUES (${POS_ORDER_COLUMNS.map(() => "?").join(", ")})`,
  ).run(...POS_ORDER_COLUMNS.map(column => orderRow[column]));
  db.prepare(
    `INSERT INTO pos_payments (${POS_PAYMENT_COLUMNS.join(", ")}) VALUES (${POS_PAYMENT_COLUMNS.map(() => "?").join(", ")})`,
  ).run(...POS_PAYMENT_COLUMNS.map(column => paymentRow[column]));
  return db;
}

// Forma observable del esquema: columnas (orden, tipo, default, NOT NULL, PK) e
// índices (UNIQUE y columnas). Es lo que 0011 debe conservar byte a byte.
function schemaOf(db, table) {
  return {
    columns: db.prepare(`PRAGMA table_info(${table})`).all()
      .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk })),
    indexes: db.prepare(`PRAGMA index_list(${table})`).all()
      .map(index => ({ unique: index.unique, origin: index.origin,
        columns: db.prepare(`PRAGMA index_info(${index.name})`).all().map(column => column.name) }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
const rowsOf = (db, table) => db.prepare(`SELECT * FROM ${table}`).all().map(row => ({ ...row }));
const indexNames = (db, table) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
).all(table).map(row => row.name);

test("0011: migra sobre datos previos sin perder filas, columnas, defaults ni índices", () => {
  const db = databaseBefore0011();
  const beforeOrders = rowsOf(db, "pos_orders"), beforePayments = rowsOf(db, "pos_payments");
  const beforeShape = { orders: schemaOf(db, "pos_orders"), payments: schemaOf(db, "pos_payments") };
  const beforeIndexes = { orders: indexNames(db, "pos_orders"), payments: indexNames(db, "pos_payments") };

  db.exec(migrationSql("0011_bendo.sql"));

  assert.deepEqual(rowsOf(db, "pos_orders"), beforeOrders, "las filas de pos_orders sobreviven intactas");
  assert.deepEqual(rowsOf(db, "pos_payments"), beforePayments, "las filas de pos_payments sobreviven intactas");
  assert.deepEqual(schemaOf(db, "pos_orders"), beforeShape.orders, "columnas, orden, tipos, defaults y PK intactos");
  assert.deepEqual(schemaOf(db, "pos_payments"), beforeShape.payments, "columnas, orden, tipos, defaults y PK intactos");
  assert.deepEqual(indexNames(db, "pos_orders"), beforeIndexes.orders);
  assert.deepEqual(indexNames(db, "pos_payments"), beforeIndexes.payments);
  assert.deepEqual(beforeIndexes, {
    orders: ["pos_orders_slug_ready", "pos_orders_slug_sede_created", "pos_orders_slug_status"],
    payments: ["pos_payments_order", "pos_payments_ref"],
  });
  // La tabla temporal del copiado no queda en el esquema.
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_next'").all(),
    [],
  );
});

test("0011: acepta 'bendo' en pos_payments y pos_orders y rechaza valores fuera del CHECK", () => {
  const db = databaseBefore0011();
  db.exec(migrationSql("0011_bendo.sql"));

  db.prepare(
    `INSERT INTO pos_payments (${POS_PAYMENT_COLUMNS.join(", ")}) VALUES (${POS_PAYMENT_COLUMNS.map(() => "?").join(", ")})`,
  ).run(...POS_PAYMENT_COLUMNS.map(column => column === "id" ? "pago-bendo-1"
    : column === "provider" ? "bendo"
      : column === "idempotency_key" ? "pago-bendo-0001"
        : column === "provider_ref" ? "BENDO123456789A"
          : paymentRow[column]));

  db.prepare(
    `INSERT INTO pos_orders (${POS_ORDER_COLUMNS.join(", ")}) VALUES (${POS_ORDER_COLUMNS.map(() => "?").join(", ")})`,
  ).run(...POS_ORDER_COLUMNS.map(column => column === "id" ? "orden-bendo-1"
    : column === "idempotency_key" ? "pedido-bendo-0001"
      : column === "payment_method" ? "bendo"
        : orderRow[column]));

  assert.equal(db.prepare("SELECT provider FROM pos_payments WHERE id = 'pago-bendo-1'").get().provider, "bendo");
  assert.equal(db.prepare("SELECT payment_method FROM pos_orders WHERE id = 'orden-bendo-1'").get().payment_method, "bendo");

  // Valores fuera del CHECK siguen rechazándose en ambas tablas.
  assert.throws(() => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, created_at, updated_at) " +
    "VALUES ('pago-malo', 'pizza', 'orden-prev-1', 'bitcoin', 'pago-malo-0001', 'created', 100, 'USD', 1, 1)",
  ).run(), /CHECK constraint failed: provider/);
  assert.throws(() => db.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, source, currency, subtotal_cents, total_cents, items, " +
    "idempotency_key, idempotency_hash, payment_method) " +
    "VALUES ('orden-mala', 'pizza', 'centro', 1, 1, 'web', 'USD', 100, 100, '[]', 'pedido-malo-0001', 'hash-malo', 'bitcoin')",
  ).run(), /CHECK constraint failed: payment_method/);

  // Los UNIQUE de 0006/0010 se recrearon: misma clave y misma referencia chocan.
  assert.throws(() => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, created_at, updated_at) " +
    "VALUES ('pago-dup', 'pizza', 'orden-prev-1', 'cash', 'pago-prev-0001', 'created', 100, 'USD', 1, 1)",
  ).run(), /UNIQUE constraint failed/);
  assert.throws(() => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, provider_ref, created_at, updated_at) " +
    "VALUES ('pago-dup-ref', 'pizza', 'orden-prev-1', 'cash', 'pago-ref-0001', 'created', 100, 'USD', 'ABCDEFGHJKLMNPQ', 1, 1)",
  ).run(), /UNIQUE constraint failed/);
});

/* ── Pedido web con `payment_method=bendo` ────────────────────────────────── */

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value) => request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
});
const margarita = {
  id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "",
  stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
};

function bendoEnv(mode) {
  const env = makeEnv({
    "pizza:config": { currency: "USD", location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }] } },
  });
  env.CLIENT_SLUG = "pizza";
  if (mode === undefined) delete env.BENDO_MODE; else env.BENDO_MODE = mode;
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita] }), Date.now());
  return env;
}
const webOrder = (overrides = {}) => ({
  sede_id: "centro", idempotency_key: "bendo-web-0001",
  items: [{ product_id: "margarita", qty: 2 }],
  customer: {
    name: "Ana", phone: "0991234567",
    billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
  },
  delivery_mode: "pickup", payment_method: "bendo",
  ...overrides,
});
const postOrder = (env, overrides) => panel.fetch(body("/api/orders", webOrder(overrides)), env, makeCtx());
const ordersCount = env => env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_orders").get().n;

test("pedido web bendo sin proveedor disponible: 503 y no se crea la orden", async () => {
  for (const mode of [undefined, "disabled", "live"]) {
    const env = bendoEnv(mode);
    if (mode === "live") {
      env.BENDO_CLIENT_ID = "cliente-bendo";
      delete env.BENDO_CLIENT_SECRET; // live exige ambas credenciales
    }
    const response = await postOrder(env);
    assert.equal(response.status, 503, `BENDO_MODE=${mode}`);
    assert.deepEqual(await response.json(), { error: "bendo_no_disponible" });
    assert.equal(ordersCount(env), 0, "un pedido no pagable no debe persistirse");
  }
});

test("pedido web bendo en mock: 201, método congelado y textos neutrales de tarjeta", async () => {
  const env = bendoEnv("mock");
  const response = await postOrder(env);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.payment_method, "bendo");
  assert.equal(created.status, "pending");
  assert.equal(created.total_cents, 1_700);
  const row = await posOrderRow(env, "pizza", created.id);
  assert.equal(row.payment_method, "bendo");

  // live con ambas credenciales también habilita el pedido (sin llamar a la red).
  const live = bendoEnv("live");
  live.BENDO_CLIENT_ID = "cliente-bendo";
  live.BENDO_CLIENT_SECRET = "secreto-bendo";
  const liveResponse = await postOrder(live);
  assert.equal(liveResponse.status, 201);
  assert.equal((await liveResponse.json()).payment_method, "bendo");

  // Un método fuera del contrato sigue siendo 400.
  const invalid = await postOrder(env, { payment_method: "bitcoin", idempotency_key: "bendo-web-malo" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "metodo_pago_invalido" });
});

test("estado público de un pago bendo: mensajes de tarjeta y reintento solo tras fallo", async () => {
  const env = bendoEnv("mock");
  const created = await (await postOrder(env)).json();
  const path = `/api/orders/${created.id}?token=${created.order_token}`;
  let order = await posOrderRow(env, "pizza", created.id);
  const payment = await createPaymentAttempt(env, "pizza", order, "bendo-pago-0001", "bendo");
  assert.equal(payment.provider, "bendo");

  await failPayment(env, "pizza", payment.id, "prepare_fallido");
  let status = await (await panel.fetch(request(path), env, makeCtx())).json();
  assert.equal(status.payment_status, "failed");
  assert.equal(status.payment_message, "No se completó el pago con tarjeta.");
  assert.equal(status.retryable, true, "un intento fallido antes de cobrar permite reintentar");

  await markPaymentUnknown(env, "pizza", payment.id, "bendo_timeout");
  status = await (await panel.fetch(request(path), env, makeCtx())).json();
  assert.equal(status.payment_status, "unknown");
  assert.equal(status.payment_message, "Estamos verificando el pago con tarjeta. No vuelvas a pagar.");
  assert.equal(status.retryable, false, "unknown exige reconciliación, nunca reintento ciego");

  order = await posOrderRow(env, "pizza", created.id);
  await settlePaymentRejected(env, "pizza", order, payment, "El pago con tarjeta no fue aprobado.");
  status = await (await panel.fetch(request(path), env, makeCtx())).json();
  assert.equal(status.status, "rejected");
  assert.equal(status.payment_status, "rejected");
  assert.equal(status.payment_message, "El pago con tarjeta no fue aprobado.");
  assert.equal(status.retryable, false);
});
