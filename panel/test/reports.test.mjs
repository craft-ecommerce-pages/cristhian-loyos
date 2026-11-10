// Reportes de ventas: cuatro categorías exactas (sushi, fastfood, tradicional, postres),
// dos sedes, exclusiones (rechazado/no pagado) y conciliación cero con lo cobrado.
// Fuente: pos_orders pagadas + snapshot congelado pos_order_lines (0008).
import test from "node:test";
import assert from "node:assert/strict";
import { salesRange, salesReport } from "../src/reports.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza" };
const SLUG = "pizza";

// 2026-11-05 12:00 en Ecuador (UTC-5) = 17:00Z.
const at = (day, hour = 12) => Date.UTC(2026, 10, day, hour + 5, 0);
const url = (query = "") => new URL(`https://pizza.example.test/panel/api/reports/sales${query}`);

async function insertOrder(env, { id, sede, paidAt = null, status = "paid", totalCents = 0 }) {
  const now = paidAt ?? Date.now();
  await env.DB.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, status_at, " +
    "currency, subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, " +
    "idempotency_key, idempotency_hash, paid_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'web', ?, ?, 'USD', ?, ?, '[]', 'Cliente', '0999999999', 'pickup', ?, ?, ?)",
  ).bind(id, SLUG, sede, now, now, 1, status, now, totalCents, totalCents, `k-${id}`, `h-${id}`, paidAt).run();
}
async function insertLine(env, orderId, index, category, qty, unitCents) {
  await env.DB.prepare(
    "INSERT INTO pos_order_lines (slug, order_id, line_index, report_category, product_id, variant_id, name, " +
    "qty, unit_cents, line_total_cents, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
  ).bind(SLUG, orderId, index, category, `p-${orderId}-${index}`, "Producto", qty, unitCents, qty * unitCents, Date.now()).run();
}

// Dos sedes con las cuatro categorías; más un rechazado y un pendiente que no deben sumar.
async function seed(env) {
  await insertOrder(env, { id: "o1", sede: "sede-norte", paidAt: at(5), totalCents: 3700 });
  await insertLine(env, "o1", 0, "sushi", 2, 1250);      // 2500
  await insertLine(env, "o1", 1, "fastfood", 1, 700);    // 700
  await insertLine(env, "o1", 2, "postres", 1, 500);     // 500

  await insertOrder(env, { id: "o2", sede: "sede-sur", paidAt: at(4), totalCents: 1999 });
  await insertLine(env, "o2", 0, "tradicional", 3, 333); // 999
  await insertLine(env, "o2", 1, "sushi", 1, 1000);      // 1000

  // Rechazado: aunque tenga marca de pago, su estado lo anula.
  await insertOrder(env, { id: "o3", sede: "sede-norte", paidAt: at(3), status: "rejected", totalCents: 4995 });
  await insertLine(env, "o3", 0, "sushi", 5, 999);
  // Pendiente sin cobro: nunca entra al reporte.
  await insertOrder(env, { id: "o4", sede: "sede-sur", status: "pending", totalCents: 100 });
  await insertLine(env, "o4", 0, "fastfood", 1, 100);
  // Pagado fuera del rango consultado.
  await insertOrder(env, { id: "o5", sede: "sede-norte", paidAt: Date.UTC(2026, 9, 31, 17), totalCents: 500 });
  await insertLine(env, "o5", 0, "fastfood", 1, 500);
  return env;
}

test("agrupa las cuatro categorías de dos sedes y concilia con lo cobrado", async () => {
  const env = await seed(makeEnv());
  const response = await salesReport(new Request(url("?from=2026-11-01&to=2026-11-05")), env, site);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.groups, [
    { category: "sushi", orders: 2, quantity: 3, total_cents: 3500 },
    { category: "fastfood", orders: 1, quantity: 1, total_cents: 700 },
    { category: "tradicional", orders: 1, quantity: 3, total_cents: 999 },
    { category: "postres", orders: 1, quantity: 1, total_cents: 500 },
  ]);
  assert.equal(body.total_cents, 5699);
  assert.equal(body.orders, 2);
  assert.equal(body.unreconciled_cents, 0);

  // by_sede suma lo mismo que los grupos.
  assert.deepEqual(body.by_sede, [
    { sede_id: "sede-norte", orders: 1, quantity: 4, total_cents: 3700 },
    { sede_id: "sede-sur", orders: 1, quantity: 4, total_cents: 1999 },
  ]);
  assert.equal(body.by_sede.reduce((sum, row) => sum + row.total_cents, 0), body.total_cents);
  assert.equal(body.groups.reduce((sum, group) => sum + group.total_cents, 0), body.total_cents);
});

test("excluye rechazadas y no pagadas", async () => {
  const env = await seed(makeEnv());
  const body = await (await salesReport(new Request(url("?from=2026-11-01&to=2026-11-05")), env, site)).json();
  const sushi = body.groups.find(group => group.category === "sushi");
  // Solo o1 (2 u.) y o2 (1 u.); el rechazado o3 aportaría 5 u. y 4995 centavos.
  assert.equal(sushi.quantity, 3);
  assert.equal(sushi.total_cents, 3500);
  assert.equal(body.orders, 2);
  assert.equal(body.total_cents, 5699);
});

test("filtra por sede y deja el resto en cero", async () => {
  const env = await seed(makeEnv());
  const body = await (await salesReport(new Request(url("?from=2026-11-01&to=2026-11-05&sede_id=sede-norte")), env, site)).json();
  assert.equal(body.total_cents, 3700);
  assert.deepEqual(body.by_sede, [{ sede_id: "sede-norte", orders: 1, quantity: 4, total_cents: 3700 }]);
  assert.deepEqual(body.groups, [
    { category: "sushi", orders: 1, quantity: 2, total_cents: 2500 },
    { category: "fastfood", orders: 1, quantity: 1, total_cents: 700 },
    { category: "tradicional", orders: 0, quantity: 0, total_cents: 0 },
    { category: "postres", orders: 1, quantity: 1, total_cents: 500 },
  ]);
});

test("las fechas son días de Ecuador, con to inclusivo", async () => {
  assert.deepEqual(salesRange("2026-11-01", "2026-11-02"), {
    start: Date.UTC(2026, 10, 1, 5), end: Date.UTC(2026, 10, 3, 5),
  });
  const env = makeEnv();
  // 23:59 del 31-oct local (04:59Z del 1-nov) queda fuera; 00:00 del 1-nov local entra.
  await insertOrder(env, { id: "antes", sede: "sede-norte", paidAt: Date.UTC(2026, 10, 1, 4, 59), totalCents: 100 });
  await insertLine(env, "antes", 0, "sushi", 1, 100);
  await insertOrder(env, { id: "inicio", sede: "sede-norte", paidAt: Date.UTC(2026, 10, 1, 5), totalCents: 200 });
  await insertLine(env, "inicio", 0, "sushi", 1, 200);
  // 23:59 del 5-nov local entra; 00:00 del 6-nov local sale.
  await insertOrder(env, { id: "fin", sede: "sede-norte", paidAt: Date.UTC(2026, 10, 6, 4, 59), totalCents: 300 });
  await insertLine(env, "fin", 0, "sushi", 1, 300);
  await insertOrder(env, { id: "despues", sede: "sede-norte", paidAt: Date.UTC(2026, 10, 6, 5), totalCents: 400 });
  await insertLine(env, "despues", 0, "sushi", 1, 400);

  const body = await (await salesReport(new Request(url("?from=2026-11-01&to=2026-11-05")), env, site)).json();
  assert.equal(body.total_cents, 500);
  assert.equal(body.unreconciled_cents, 0);
});

test("valida fechas, rango y sede", async () => {
  const env = makeEnv();
  const cases = [
    "?from=2026-11-01",                     // falta to
    "?from=2026-02-30&to=2026-03-01",       // fecha irreal
    "?from=2026-11-05&to=2026-11-01",       // to anterior
    "?from=2026-01-01&to=2027-01-02",       // más de 366 días
    "?from=2026-11-01&to=2026-11-02&sede_id=../x",
    "?from=2026-11-01&to=2026-11-05&sede_id=sede%20norte",
  ];
  for (const query of cases) {
    const response = await salesReport(new Request(url(query)), env, site);
    assert.equal(response.status, 400, query);
    assert.ok((await response.json()).error, query);
  }
});

test("un cobro sin líneas se expone como no conciliado, nunca se inventa categoría", async () => {
  const env = makeEnv();
  await insertOrder(env, { id: "sin-lineas", sede: "sede-norte", paidAt: at(5), totalCents: 750 });
  const body = await (await salesReport(new Request(url("?from=2026-11-01&to=2026-11-05")), env, site)).json();
  assert.equal(body.total_cents, 750);
  assert.equal(body.groups.reduce((sum, group) => sum + group.total_cents, 0), 0);
  assert.equal(body.unreconciled_cents, 750);
});
