// Reportes de ventas del POS: KPIs con IVA, productos, sedes, día/hora de Ecuador,
// CSV y Resultados (statsFor) alimentado por pedidos cobrados del POS.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { salesReport, salesReportCsv } from "../src/reports.js";
import { statsFor } from "../src/events.js";
import { dayOf } from "../src/contract.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const SLUG = "pizza";
const site = { slug: SLUG };
const DAY_MS = 86_400_000;

// 2026-11-05 12:00 en Ecuador (UTC-5) = 17:00Z.
const at = (day, hour = 12, minute = 0) => Date.UTC(2026, 10, day, hour + 5, minute);
const url = (path, query = "") => new URL(`https://pizza.example.test/panel/api/reports/${path}${query}`);
const request = (path, options = {}) => new Request(`https://pizza.example.test${path}`, options);
const jsonBody = (path, value, headers = {}) => request(path, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

async function insertOrder(env, {
  id, sede = "sede-norte", status = "paid", paidAt = null,
  subtotalCents = 0, totalCents = 0, paymentMethod = "cash",
}) {
  const now = paidAt ?? Date.now();
  await env.DB.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, status_at, " +
    "currency, subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, " +
    "idempotency_key, idempotency_hash, paid_at, payment_method) " +
    "VALUES (?, ?, ?, ?, ?, ?, 'web', ?, ?, 'USD', ?, ?, '[]', 'Cliente', '0999999999', 'pickup', ?, ?, ?, ?)",
  ).bind(id, SLUG, sede, now, now, 1, status, now, subtotalCents, totalCents,
    `k-${id}`, `h-${id}`, paidAt, paymentMethod).run();
}

async function insertLine(env, orderId, index, {
  category = "tradicional", productId = null, name = "Producto",
  qty = 1, unitCents = 0, createdAt = Date.now(),
}) {
  await env.DB.prepare(
    "INSERT INTO pos_order_lines (slug, order_id, line_index, report_category, product_id, variant_id, name, " +
    "qty, unit_cents, line_total_cents, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)",
  ).bind(SLUG, orderId, index, category, productId, name, qty, unitCents, qty * unitCents, createdAt).run();
}

// Catálogo vigente: categoría de carta = primer slug de `categorias`.
async function seedCatalog(env) {
  await env.MENUS.put(`${SLUG}:productos`, JSON.stringify([
    { id: "sushi-gyozas", nombre: "Gyozas (6 unidades)", precio: "10.00", categorias: ["sushi-entradas", "sushi"] },
    { id: "postre-flan", nombre: "Flan", precio: "5.00", categorias: ["postres-frios"] },
    { id: "fast-burger", nombre: "Hamburguesa", precio: "5.00", categorias: ["fastfood-burgers"] },
  ]));
  await env.MENUS.put(`${SLUG}:config`, JSON.stringify({
    categories: { "sushi-entradas": "Entradas", "postres-frios": "Postres", "fastfood-burgers": "Hamburguesas" },
    category_order: ["sushi-entradas", "postres-frios", "fastfood-burgers"],
  }));
}

// Tres cobros en dos días/sedes, con IVA congelado y un producto retirado del catálogo.
async function seedSales(env) {
  await seedCatalog(env);

  // o1: 30,00 base + 4,50 IVA = 34,50 (transferencia), dos líneas del mismo producto.
  await insertOrder(env, { id: "o1", sede: "sede-norte", paidAt: at(5, 12), subtotalCents: 3000, totalCents: 3450, paymentMethod: "transfer" });
  await insertLine(env, "o1", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas (6)", qty: 2, unitCents: 1000, createdAt: at(5, 12) });
  await insertLine(env, "o1", 1, { category: "postres", productId: "postre-flan", name: "Flan", qty: 2, unitCents: 500, createdAt: at(5, 12) });

  // o2: 15,00 base + 2,25 IVA = 17,25 (efectivo); nombre más reciente del mismo producto.
  await insertOrder(env, { id: "o2", sede: "sede-sur", paidAt: at(5, 13, 30), subtotalCents: 1500, totalCents: 1725, paymentMethod: "cash" });
  await insertLine(env, "o2", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas (6 unidades)", qty: 1, unitCents: 1000, createdAt: at(5, 13, 30) });
  await insertLine(env, "o2", 1, { category: "fastfood", productId: "fast-burger", name: "Hamburguesa", qty: 1, unitCents: 500, createdAt: at(5, 13, 30) });

  // o3: 23:30 del 4-nov en Ecuador (04:30Z del 5-nov): 10,00 + 1,50 = 11,50 (Bendo).
  // Lleva un producto que ya no existe en el catálogo (menu_category null).
  await insertOrder(env, { id: "o3", sede: "sede-norte", paidAt: at(4, 23, 30), subtotalCents: 1000, totalCents: 1150, paymentMethod: "bendo" });
  await insertLine(env, "o3", 0, { category: "tradicional", productId: "p-retirado", name: "Plato retirado", qty: 1, unitCents: 1000, createdAt: at(4, 23, 30) });
}

async function report(env, query = "?from=2026-11-01&to=2026-11-05") {
  const response = await salesReport(new Request(url("sales", query)), env, site);
  assert.equal(response.status, 200);
  return response.json();
}

test("summary: ventas cobradas con IVA, base y ticket promedio redondeado", async () => {
  const env = makeEnv();
  await seedSales(env);
  const body = await report(env);

  assert.deepEqual(body.summary, {
    orders: 3,
    charged_cents: 6325,
    base_cents: 5500,
    tax_cents: 825,
    avg_ticket_cents: 2108,       // 6325 / 3 = 2108.33… → entero redondeado
  });
  assert.equal(body.orders, 3);
  assert.equal(body.total_cents, 6325);
  // Invariante del contrato: Σ base de categorías + IVA == cobrado.
  const base = body.groups.reduce((sum, group) => sum + group.total_cents, 0);
  assert.equal(base, body.summary.base_cents);
  assert.equal(base + body.summary.tax_cents, body.summary.charged_cents);
  assert.equal(body.unreconciled_cents, 0);
});

test("productos: agrupa por product_id, nombre más reciente y orden qty/base", async () => {
  const env = makeEnv();
  await seedSales(env);
  const body = await report(env);

  assert.deepEqual(body.products.map(product => [product.product_id, product.name, product.report_category, product.menu_category, product.qty, product.base_cents, product.orders]), [
    ["sushi-gyozas", "Gyozas (6 unidades)", "sushi", "sushi-entradas", 3, 3000, 2],
    ["postre-flan", "Flan", "postres", "postres-frios", 2, 1000, 1],
    ["p-retirado", "Plato retirado", "tradicional", null, 1, 1000, 1],
    ["fast-burger", "Hamburguesa", "fastfood", "fastfood-burgers", 1, 500, 1],
  ]);
  // Lo vendido por producto concilia con la base de las categorías.
  assert.equal(body.products.reduce((sum, product) => sum + product.base_cents, 0), body.summary.base_cents);
});

test("día y hora de Ecuador: un cobro a las 23:30 cae en ese día, no en el siguiente", async () => {
  const env = makeEnv();
  await insertOrder(env, { id: "tarde", sede: "sede-norte", paidAt: at(5, 23, 30), subtotalCents: 1000, totalCents: 1150 });
  await insertLine(env, "tarde", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas", qty: 1, unitCents: 1000, createdAt: at(5, 23, 30) });

  const sameDay = await report(env, "?from=2026-11-05&to=2026-11-05");
  assert.equal(sameDay.summary.orders, 1);
  assert.deepEqual(sameDay.by_day, [{ day: "2026-11-05", orders: 1, charged_cents: 1150 }]);
  assert.equal(sameDay.by_hour.length, 24);
  assert.deepEqual(sameDay.by_hour[23], { hour: 23, orders: 1, charged_cents: 1150 });
  assert.equal(sameDay.by_hour.filter(row => row.orders > 0).length, 1);

  const nextDay = await report(env, "?from=2026-11-06&to=2026-11-06");
  assert.equal(nextDay.summary.orders, 0);
  assert.deepEqual(nextDay.by_day, []);
});

test("filtra por sede y conserva el ranking solo de esa sede", async () => {
  const env = makeEnv();
  await seedSales(env);
  const body = await report(env, "?from=2026-11-01&to=2026-11-05&sede_id=sede-norte");

  assert.equal(body.summary.orders, 2);
  assert.equal(body.summary.charged_cents, 4600);          // 3450 + 1150
  assert.deepEqual(body.by_sede, [{ sede_id: "sede-norte", orders: 2, quantity: 5, total_cents: 4000 }]);
  assert.deepEqual(body.products.map(product => product.product_id), ["sushi-gyozas", "postre-flan", "p-retirado"]);
  assert.equal(body.by_payment_method.length, 2);
});

test("excluye pending, rejected, pagados sin marca y fuera del rango", async () => {
  const env = makeEnv();
  await insertOrder(env, { id: "ok", sede: "sede-norte", paidAt: at(5), subtotalCents: 1000, totalCents: 1150 });
  await insertLine(env, "ok", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas", qty: 1, unitCents: 1000 });
  await insertOrder(env, { id: "pending", sede: "sede-norte", status: "pending", subtotalCents: 900, totalCents: 900 });
  await insertLine(env, "pending", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas", qty: 1, unitCents: 900 });
  await insertOrder(env, { id: "rejected", sede: "sede-norte", status: "rejected", paidAt: at(5), subtotalCents: 500, totalCents: 500 });
  await insertLine(env, "rejected", 0, { category: "fastfood", productId: "fast-burger", name: "Hamburguesa", qty: 1, unitCents: 500 });
  await insertOrder(env, { id: "sin-pago", sede: "sede-norte", status: "paid", paidAt: null, subtotalCents: 700, totalCents: 700 });
  await insertLine(env, "sin-pago", 0, { category: "tradicional", productId: null, name: "Sin pago", qty: 1, unitCents: 700 });
  await insertOrder(env, { id: "fuera", sede: "sede-norte", paidAt: Date.UTC(2026, 9, 31, 17), subtotalCents: 800, totalCents: 800 });
  await insertLine(env, "fuera", 0, { category: "postres", productId: null, name: "Viejo", qty: 1, unitCents: 800 });

  const body = await report(env);
  assert.equal(body.summary.orders, 1);
  assert.equal(body.summary.charged_cents, 1150);
  assert.deepEqual(body.by_payment_method, [{ method: "cash", orders: 1, charged_cents: 1150 }]);
  assert.deepEqual(body.by_day, [{ day: "2026-11-05", orders: 1, charged_cents: 1150 }]);
});

test("by_payment_method y by_day suman lo mismo que summary", async () => {
  const env = makeEnv();
  await seedSales(env);
  const body = await report(env);

  assert.deepEqual(body.by_payment_method, [
    { method: "transfer", orders: 1, charged_cents: 3450 },
    { method: "bendo", orders: 1, charged_cents: 1150 },
    { method: "cash", orders: 1, charged_cents: 1725 },
  ].sort((a, b) => b.charged_cents - a.charged_cents || a.method.localeCompare(b.method)));
  assert.deepEqual(body.by_day, [
    { day: "2026-11-04", orders: 1, charged_cents: 1150 },
    { day: "2026-11-05", orders: 2, charged_cents: 5175 },
  ]);
  for (const rows of [body.by_payment_method, body.by_day]) {
    assert.equal(rows.reduce((sum, row) => sum + row.charged_cents, 0), body.summary.charged_cents);
  }
});

test("CSV: BOM UTF-8, separador ';', una fila por producto y totales al final", async () => {
  const env = makeEnv();
  await seedSales(env);
  const response = await salesReportCsv(new Request(url("sales.csv", "?from=2026-11-01&to=2026-11-05")), env, site);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/csv/);
  assert.match(response.headers.get("content-disposition"), /ventas-2026-11-01-2026-11-05\.csv/);

  // Response.text() descarta el BOM al decodificar: se comprueban los bytes crudos.
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF], "empieza con BOM UTF-8");
  const lines = new TextDecoder().decode(bytes).trimEnd().split("\r\n");
  assert.equal(lines[0], "Producto;Categoría;Cantidad;Ventas sin IVA");
  assert.equal(lines[1], "Gyozas (6 unidades);Sushi;3;30.00");
  assert.equal(lines[2], "Flan;Postres;2;10.00");
  assert.equal(lines[3], "Plato retirado;Tradicional;1;10.00");
  assert.equal(lines[4], "Hamburguesa;Fast food;1;5.00");
  assert.deepEqual(lines.slice(-3), [
    "Subtotal;;;55.00",
    "IVA;;;8.25",
    "Total cobrado;;;63.25",
  ]);
});

test("CSV vacío: solo cabecera y totales en cero", async () => {
  const env = makeEnv();
  const response = await salesReportCsv(new Request(url("sales.csv", "?from=2026-11-01&to=2026-11-05")), env, site);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  assert.deepEqual(new TextDecoder().decode(bytes).trimEnd().split("\r\n"), [
    "Producto;Categoría;Cantidad;Ventas sin IVA",
    "Subtotal;;;0.00",
    "IVA;;;0.00",
    "Total cobrado;;;0.00",
  ]);
});

test("Resultados: pedidos y ventas por día salen del POS; visitas siguen en events_daily", async () => {  const env = makeEnv();
  const today = dayOf(Date.now()), yesterday = dayOf(Date.now() - DAY_MS);
  env.DB.raw.prepare("INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, ?, ?)")
    .run(SLUG, today, 12, 9);   // el contador legacy `orders` ya no se usa

  await insertOrder(env, { id: "hoy", sede: "sede-norte", paidAt: Date.now(), subtotalCents: 2000, totalCents: 2300 });
  await insertLine(env, "hoy", 0, { category: "sushi", productId: "sushi-gyozas", name: "Gyozas", qty: 1, unitCents: 2000 });
  await insertOrder(env, { id: "ayer", sede: "sede-norte", paidAt: Date.now() - DAY_MS, subtotalCents: 1000, totalCents: 1150 });
  await insertLine(env, "ayer", 0, { category: "postres", productId: "postre-flan", name: "Flan", qty: 1, unitCents: 1000 });
  await insertOrder(env, { id: "rechazado", sede: "sede-norte", status: "rejected", paidAt: Date.now(), subtotalCents: 999, totalCents: 999 });
  await insertLine(env, "rechazado", 0, { category: "fastfood", productId: "fast-burger", name: "Hamburguesa", qty: 1, unitCents: 999 });

  const stats = await statsFor(env, SLUG, 3);
  assert.deepEqual(stats.days.map(d => d.day), [dayOf(Date.now() - 2 * DAY_MS), yesterday, today]);
  assert.deepEqual(stats.days.map(d => [d.views, d.orders, d.sales_cents]), [
    [0, 0, 0],
    [0, 1, 1150],
    [12, 1, 2300],
  ]);
  assert.deepEqual(stats.totals, { views: 12, orders: 2, sales_cents: 3450 });
});

test("ruta /panel/api/reports/sales.csv: exige sesión y descarga el archivo", async () => {
  const env = makeEnv(), ctx = makeCtx();
  env.CLIENT_SLUG = SLUG;
  await seedSales(env);

  const query = "?from=2026-11-01&to=2026-11-05";
  const anonymous = await panel.fetch(request("/panel/api/reports/sales.csv" + query), env, ctx);
  assert.equal(anonymous.status, 401);

  const owner = await panel.fetch(jsonBody(`/admin/${SLUG}/owner`, { email: "dueno@pizza.ec" }, {
    authorization: "Bearer admin-token",
  }), env, ctx);
  const login = await panel.fetch(jsonBody("/panel/api/login", await owner.json()), env, ctx);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const response = await panel.fetch(request("/panel/api/reports/sales.csv" + query, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/csv/);
  assert.match(await response.text(), /Total cobrado;;;63\.25/);
});
