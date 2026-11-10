// Ensamblaje de punta a punta con mocks: pedido web → cobro en efectivo → comanda/KDS
// → reporte por cuatro categorías → factura en estado manual. Sin red ni credenciales.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeCtx, makeEnv } from "./helpers.mjs";
import { dayOf } from "../src/contract.js";

const host = "cliente.example.test";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie) => request(path, { headers: { cookie } });

const sushi = { id: "roll", name: "Roll", type: "producto", price: "10.00", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0, report_category: "sushi" };
const postre = { ...sushi, id: "torta", name: "Torta", price: "5.50", categories: [], report_category: "postres" };

function envWithCatalog() {
  const env = makeEnv({
    "cliente:config": {
      currency: "USD", store_name: "Cliente",
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }] },
    },
  });
  env.CLIENT_SLUG = "cliente";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("cliente", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [sushi, postre] }), Date.now());
  return env;
}
async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/cliente/owner", { email: "dueno@cliente.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

test("flujo completo: web → efectivo → KDS → reporte → factura manual", async () => {
  const env = envWithCatalog(), ctx = makeCtx(), cookie = await ownerCookie(env);

  // 1) Pedido web: el servidor ignora el total del navegador y recalcula en centavos.
  const created = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: "assembly-order-0001",
    items: [{ product_id: "roll", qty: 2 }, { product_id: "torta", qty: 1 }],
    customer: { name: "Ana", phone: "0991234567" }, delivery_mode: "pickup",
    total: 1, total_cents: 1,
  }), env, ctx);
  assert.equal(created.status, 201);
  const order = await created.json();
  assert.equal(order.status, "pending");
  assert.equal(order.total_cents, 2550);

  // 2) Cobro en efectivo: comanda y snapshot de líneas con categoría congelada.
  const paid = await panel.fetch(body(`/panel/api/orders/${order.id}/pay-cash`, { idempotency_key: "cash-0001" }, { headers: { cookie } }), env, ctx);
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).order.status, "paid");
  const lines = env.DB.raw.prepare("SELECT report_category, qty, line_total_cents FROM pos_order_lines WHERE order_id = ? ORDER BY line_index").all(order.id)
    .map(row => ({ ...row }));
  assert.deepEqual(lines, [
    { report_category: "sushi", qty: 2, line_total_cents: 2000 },
    { report_category: "postres", qty: 1, line_total_cents: 550 },
  ]);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(order.id).n, 1);

  // 3) KDS: solo pagadas, con acuse idempotente.
  const kitchen = await panel.fetch(withCookie("/panel/api/kitchen/orders?sede_id=centro", cookie), env, ctx);
  assert.equal(kitchen.status, 200);
  const queue = await kitchen.json();
  assert.equal(queue.orders.length, 1);
  assert.equal(queue.orders[0].id, order.id);
  const print = (key) => panel.fetch(body(`/panel/api/kitchen/orders/${order.id}/print`, { idempotency_key: key }, { headers: { cookie } }), env, ctx);
  assert.equal((await (await print("print-0001")).json()).print_count, 1);
  assert.equal((await (await print("print-0001")).json()).print_count, 1, "la misma clave no duplica el acuse");

  // 4) Reporte: cuatro grupos exactos y conciliación cero.
  const today = dayOf(Date.now()), yesterday = dayOf(Date.now() - 86400000);
  const report = await panel.fetch(withCookie(`/panel/api/reports/sales?from=${yesterday}&to=${today}`, cookie), env, ctx);
  assert.equal(report.status, 200);
  const data = await report.json();
  assert.deepEqual(data.groups, [
    { category: "sushi", orders: 1, quantity: 2, total_cents: 2000 },
    { category: "fastfood", orders: 0, quantity: 0, total_cents: 0 },
    { category: "tradicional", orders: 0, quantity: 0, total_cents: 0 },
    { category: "postres", orders: 1, quantity: 1, total_cents: 550 },
  ]);
  assert.equal(data.total_cents, 2550);
  assert.equal(data.unreconciled_cents, 0);
  assert.deepEqual(data.by_sede, [{ sede_id: "centro", orders: 1, quantity: 3, total_cents: 2550 }]);

  // 5) Factura derivada: sin proveedor configurado queda manual, nunca "issued".
  const invoice = await panel.fetch(withCookie(`/panel/api/invoices/${order.id}`, cookie), env, ctx);
  assert.equal(invoice.status, 200);
  const fact = await invoice.json();
  assert.equal(fact.status, "manual");
  assert.equal(fact.pdf_url, null);
  assert.equal("snapshot" in fact, false, "la respuesta pública no filtra el snapshot");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "paid", "un fallo de facturación no pierde el pedido");
});

test("seguridad: reportes, facturas, cocina y conciliación exigen sesión", async () => {
  const env = envWithCatalog(), ctx = makeCtx();
  const today = dayOf(Date.now());
  const routes = [
    ["GET", `/panel/api/reports/sales?from=${today}&to=${today}`],
    ["GET", "/panel/api/invoices/abc"],
    ["POST", "/panel/api/invoices/abc/retry"],
    ["GET", "/panel/api/kitchen/orders?sede_id=centro"],
    ["POST", "/panel/api/payments/AAAAAAAAAAAAAAA/reconcile"],
  ];
  for (const [method, path] of routes) {
    const response = await panel.fetch(request(path, { method, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined }), env, ctx);
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.deepEqual(await response.json(), { error: "sin_sesion" });
  }
});

test("idempotencia: repetir el cobro no duplica comanda ni líneas", async () => {
  const env = envWithCatalog(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: "assembly-order-0002",
    items: [{ product_id: "roll", qty: 1 }], customer: { name: "Luis", phone: "099" }, delivery_mode: "pickup",
  }), env, ctx)).json();
  const pay = () => panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-0002" }, { headers: { cookie } }), env, ctx);
  assert.equal((await pay()).status, 200);
  assert.equal((await pay()).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(created.id).n, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_order_lines WHERE order_id = ?").get(created.id).n, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM invoices WHERE order_id = ?").get(created.id).n, 1);
});
