// IVA del cobro: los precios del catálogo son base sin IVA y el 15 % se suma al
// cobrar (web, caja, Bendo, datáfono, transferencia y efectivo), con el MISMO
// redondeo por línea que el borrador de factura. Sin configuración fiscal, el
// total no cambia (compatibilidad) y un pedido anterior al IVA conserva su total.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { invoiceDraftFromOrder } from "../src/invoices.js";
import { posOrderData } from "../src/orders.js";
import { clientTicketLines } from "../../shared/ticket.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const SLUG = "pizza";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});

// Config fiscal mínima del titular: precios sin IVA y tarifa del 15 %.
const TAX_CONFIG = {
  provider: "facturon",
  environment: "sandbox",
  companyId: 3,
  emissionPointId: 7,
  establishment: "001",
  emissionPoint: "001",
  currency: "USD",
  pricesIncludeTax: false,
  defaultTaxRateBp: 1500,
  allowFinalConsumer: true,
  finalConsumerMaxCents: 5000,
};

const product = (id, name, price) => ({
  id, name, type: "producto", price, promo_price: "", sku: "", description: "", stock: null,
  active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
});
const PRODUCTS = [
  product("tres", "Tres dólares", "3.00"),
  product("noventa", "Postre 0,99", "0.99"),
  product("dos49", "Bebida 2,49", "2.49"),
  product("c45", "Combo 45", "45.00"),
  product("margarita", "Margarita", "8.50"),
];

function posEnv({ invoices = TAX_CONFIG, config = {} } = {}) {
  const kv = {
    [`${SLUG}:config`]: {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] },
      ...config,
    },
  };
  if (invoices) kv[`${SLUG}:invoices`] = invoices;
  const env = makeEnv(kv);
  env.CLIENT_SLUG = SLUG;
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run(SLUG, JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: PRODUCTS }), Date.now());
  return env;
}

let counter = 0;
const webOrder = (items, overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: `iva-${String(counter++).padStart(4, "0")}-web`,
  items,
  customer: { name: "Ana", phone: "0991234567" },
  delivery_mode: "pickup",
  payment_method: "transfer",
  ...overrides,
});

async function ownerCookie(env) {
  const owner = await panel.fetch(body(`/admin/${SLUG}/owner`, { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

const rowOf = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const itemsOf = (env, id) => JSON.parse(rowOf(env, id).items);
const openShift = (env, sede = "centro") => env.DB.raw.prepare(
  "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
  "VALUES (?, ?, ?, 'test', ?, 0, ?)",
).run(`turno-${sede}`, SLUG, sede, Date.now(), `turno-${sede}`);

async function pay(env, cookie, orderId, action = "pay-transfer") {
  return panel.fetch(body(`/panel/api/orders/${orderId}/${action}`, { idempotency_key: `pago-${orderId}` }, {
    headers: { cookie },
  }), env, makeCtx());
}

async function createWeb(env, items, overrides = {}) {
  const response = await panel.fetch(body("/api/orders", webOrder(items, overrides)), env, makeCtx());
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

const day = (ms = Date.now()) => new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10);
const etiqueta = linea => linea.replace(/\s{2,}/g, " · ").trim();

/* ── Cobro con IVA ───────────────────────────────────────────────────────── */

test("3,00 de base cobra 3,45: base, tasa e IVA congelados en el snapshot", async () => {
  const env = posEnv();
  const created = await createWeb(env, [{ product_id: "tres", qty: 1 }]);
  assert.equal(created.total_cents, 345, "el total cobrado incluye el 15 %");

  const row = rowOf(env, created.id);
  assert.equal(row.subtotal_cents, 300);
  assert.equal(row.total_cents, 345);
  const [line] = itemsOf(env, created.id);
  assert.deepEqual(
    { base_cents: line.base_cents, tax_rate_bp: line.tax_rate_bp, tax_cents: line.tax_cents, subtotal_cents: line.subtotal_cents },
    { base_cents: 300, tax_rate_bp: 1500, tax_cents: 45, subtotal_cents: 300 },
  );

  // Estado público: los tres importes, siempre en centavos enteros.
  const status = await (await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, makeCtx())).json();
  assert.equal(status.subtotal_cents, 300);
  assert.equal(status.tax_cents, 45);
  assert.equal(status.total_cents, 345);

  // Cobro manual por transferencia: el pago registra el total con IVA.
  const cookie = await ownerCookie(env);
  openShift(env);
  const paid = await (await pay(env, cookie, created.id)).json();
  assert.equal(paid.order.total_cents, 345);
  assert.equal(paid.order.subtotal_cents, 300);
  assert.equal(paid.order.tax_cents, 45);
  assert.equal(paid.payment.amount_cents, 345);

  // Datáfono: el cobro manual también registra el total con IVA.
  const second = await createWeb(env, [{ product_id: "tres", qty: 1 }]);
  const datafono = await (await panel.fetch(body(`/panel/api/orders/${second.id}/pay-datafono`, {
    idempotency_key: "datafono-iva-001", authorization_code: "A123456",
  }, { headers: { cookie } }), env, makeCtx())).json();
  assert.equal(datafono.order.total_cents, 345);
  assert.equal(datafono.payment.amount_cents, 345);
});

test("redondeo por línea: 0,99 × 3 y 2,49 × 7 no divergen de la factura", async () => {
  const env = posEnv();
  const created = await createWeb(env, [{ product_id: "noventa", qty: 3 }, { product_id: "dos49", qty: 7 }]);
  // 297 + 1743 = 2040 de base; IVA por línea 45 (44,55) + 261 (261,45) = 306.
  assert.equal(created.total_cents, 2346);
  const row = rowOf(env, created.id);
  assert.equal(row.subtotal_cents, 2040);
  assert.deepEqual(itemsOf(env, created.id).map(line => [line.qty, line.base_cents, line.tax_rate_bp, line.tax_cents]), [
    [3, 297, 1500, 45],
    [7, 1743, 1500, 261],
  ]);
});

test("el total del pedido es el total del borrador de factura, sin total_mismatch", async () => {
  const env = posEnv();
  const created = await createWeb(env, [{ product_id: "noventa", qty: 3 }, { product_id: "dos49", qty: 7 }]);
  const cookie = await ownerCookie(env);
  openShift(env);
  assert.equal((await pay(env, cookie, created.id)).status, 200);

  const row = rowOf(env, created.id);
  const order = posOrderData(row);
  const draft = invoiceDraftFromOrder({ order, config: TAX_CONFIG, now: Date.now() });
  assert.deepEqual(draft.blockedReasons, [], "el borrador queda listo");
  assert.equal(draft.ready, true);
  assert.equal(draft.taxMode, "exclusive");
  assert.equal(draft.totals.subtotalCents, 2040);
  assert.equal(draft.totals.taxCents, 306);
  assert.equal(draft.totals.totalCents, 2346);
  assert.equal(draft.totals.totalCents, order.total_cents, "mismo total cobrado y facturado");
  assert.deepEqual(draft.taxes, [{ code: "4", rateBp: 1500, baseCents: 2040, taxCents: 306 }]);

  // La factura preparada en el cobro guarda el mismo desglose.
  const invoice = env.DB.raw.prepare("SELECT status, snapshot FROM invoices WHERE order_id = ?").get(created.id);
  const prepared = JSON.parse(invoice.snapshot);
  assert.equal(prepared.blockedReasons.includes("total_mismatch"), false, invoice.status);
  assert.deepEqual(prepared.totals, draft.totals);
});

test("consumidor final: el límite de USD 50 se mide con IVA (45,00 → 51,75 exige datos fiscales)", async () => {
  const env = posEnv();
  const response = await panel.fetch(body("/api/orders", webOrder([{ product_id: "c45", qty: 1 }])), env, makeCtx());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "datos_fiscales_requeridos", campo: "billing" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_orders").get().n, 0);

  // 45,00 + IVA = 51,75: por encima del límite, con datos fiscales sí se acepta.
  const withBilling = await panel.fetch(body("/api/orders", webOrder([{ product_id: "c45", qty: 1 }], {
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Calle 1" },
    },
  })), env, makeCtx());
  assert.equal(withBilling.status, 201, await withBilling.clone().text());
  assert.equal((await withBilling.json()).total_cents, 5175);
});

test("sin configuración de facturas no se añade IVA (compatibilidad)", async () => {
  const env = posEnv({ invoices: null });
  const created = await createWeb(env, [{ product_id: "tres", qty: 1 }]);
  assert.equal(created.total_cents, 300);
  const row = rowOf(env, created.id);
  assert.equal(row.subtotal_cents, 300);
  const [line] = itemsOf(env, created.id);
  assert.equal(line.tax_cents, 0);
  assert.equal(line.tax_rate_bp, null, "sin tasa configurada no se inventa una");
});

test("un pedido pending anterior al IVA conserva su total al cobrar", async () => {
  const env = posEnv();
  const now = Date.now();
  // Fila creada antes del despliegue: sin campos de IVA en las líneas.
  env.DB.raw.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, currency, " +
    "subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, idempotency_key, " +
    "idempotency_hash, payment_method) " +
    "VALUES ('viejo', ?, 'centro', ?, ?, 1, 'web', 'pending', 'USD', 300, 300, ?, 'Ana', '0991234567', 'pickup', " +
    "'viejo-0001', 'hash-viejo', 'transfer')",
  ).run(SLUG, now, now, JSON.stringify([{
    product_id: "tres", name: "Tres dólares", qty: 1, unit_cents: 300, subtotal_cents: 300, report_category: "tradicional",
  }]));

  const cookie = await ownerCookie(env);
  openShift(env);
  const paid = await (await pay(env, cookie, "viejo")).json();
  assert.equal(paid.order.total_cents, 300, "no se recalcula al cobrar");
  assert.equal(paid.order.tax_cents, 0);
  assert.equal(paid.payment.amount_cents, 300);
  assert.equal(rowOf(env, "viejo").total_cents, 300);

  // La factura no puede inventar un IVA que no se cobró: queda bloqueada y visible.
  const invoice = env.DB.raw.prepare("SELECT status, snapshot FROM invoices WHERE order_id = 'viejo'").get();
  assert.equal(invoice.status, "manual");
  assert.ok(JSON.parse(invoice.snapshot).blockedReasons.includes("total_mismatch"));
});

/* ── Bendo y opciones de pago ────────────────────────────────────────────── */

test("Bendo: el monto del link y su verificación usan el total con IVA", async () => {
  const env = posEnv();
  env.BENDO_MODE = "mock";
  const created = await createWeb(env, [{ product_id: "tres", qty: 1 }], { payment_method: "bendo" });

  const started = await (await panel.fetch(body(`/api/orders/${created.id}/bendo`, {
    order_token: created.order_token, idempotency_key: "bendo-iva-0001",
  }), env, makeCtx())).json();
  assert.equal(started.total_cents, 345);
  const payment = env.DB.raw.prepare("SELECT amount_cents, provider_ref FROM pos_payments WHERE order_id = ?").get(created.id);
  assert.equal(payment.amount_cents, 345, "el link se crea por el total cobrado");

  // Aprobación simulada: la verificación compara el monto del link con 3,45.
  await env.MENUS.put(`bendo:mock:${payment.provider_ref}`, "aprobado");
  const returned = await panel.fetch(request(`/api/bendo/return?p=${payment.provider_ref}`), env, makeCtx());
  assert.equal(returned.status, 302);
  const row = rowOf(env, created.id);
  assert.equal(row.status, "paid");
  assert.equal(row.total_cents, 345);
});

test("payment-options y meseroMe publican la tasa efectiva del IVA", async () => {
  const env = posEnv();
  const options = await (await panel.fetch(request("/api/payment-options"), env, makeCtx())).json();
  assert.deepEqual(options.tax, { rate_bp: 1500, prices_include_tax: false });

  const cookie = await ownerCookie(env);
  const me = await (await panel.fetch(request("/panel/api/mesero/me", { headers: { cookie } }), env, makeCtx())).json();
  assert.deepEqual(me.store.tax, { rate_bp: 1500, prices_include_tax: false });

  // Sin configuración fiscal: tasa 0 publicada, nada se suma.
  const sinConfig = posEnv({ invoices: null });
  assert.deepEqual(
    (await (await panel.fetch(request("/api/payment-options"), sinConfig, makeCtx())).json()).tax,
    { rate_bp: 0, prices_include_tax: false },
  );
  // Con precios que ya incluyen IVA tampoco se suma nada encima.
  const incluido = posEnv({ invoices: { ...TAX_CONFIG, pricesIncludeTax: true } });
  assert.deepEqual(
    (await (await panel.fetch(request("/api/payment-options"), incluido, makeCtx())).json()).tax,
    { rate_bp: 0, prices_include_tax: true },
  );
});

/* ── Reportes y cierre de caja ───────────────────────────────────────────── */

test("reportes: categorías en base, tax_cents aparte y charged_cents conciliado", async () => {
  const env = posEnv();
  const cookie = await ownerCookie(env);
  openShift(env);
  const first = await createWeb(env, [{ product_id: "tres", qty: 1 }]);
  const second = await createWeb(env, [{ product_id: "noventa", qty: 3 }, { product_id: "dos49", qty: 7 }]);
  for (const order of [first, second]) assert.equal((await pay(env, cookie, order.id)).status, 200);

  const today = day();
  const report = await (await panel.fetch(
    request(`/panel/api/reports/sales?from=${today}&to=${today}`, { headers: { cookie } }), env, makeCtx(),
  )).json();

  const base = report.groups.reduce((sum, group) => sum + group.total_cents, 0);
  assert.equal(base, 2340, "las categorías suman la base sin IVA");
  assert.equal(report.tax_cents, 351);
  assert.equal(report.charged_cents, 2691);
  assert.equal(report.total_cents, 2691);
  assert.equal(base + report.tax_cents, report.charged_cents, "invariante base + IVA = cobrado");
  assert.equal(report.unreconciled_cents, 0);
  assert.equal(report.orders, 2);
});

test("cierre de caja: las ventas del turno cuadran con el total con IVA", async () => {
  const env = posEnv();
  const cookie = await ownerCookie(env);
  openShift(env);

  // Dos cobros en efectivo de la caja: el cierre suma amount_cents de los pagos.
  const totals = [];
  for (const [index, qty] of [[0, 1], [1, 3]]) {
    const created = await (await panel.fetch(body("/panel/api/mesero/orders", {
      sede_id: "centro",
      idempotency_key: `caja-iva-000${index}`,
      payment_method: "cash",
      items: [{ product_id: "tres", qty }],
    }, { headers: { cookie } }), env, makeCtx())).json();
    const paid = await (await pay(env, cookie, created.id, "pay-cash")).json();
    assert.equal(paid.payment.amount_cents, paid.order.total_cents);
    totals.push(paid.order.total_cents);
  }
  assert.deepEqual(totals, [345, 1035], "3,45 por unidad: 1 × 3,45 y 3 × 3,45");

  const report = await (await panel.fetch(
    request("/panel/api/turnos/turno-centro", { headers: { cookie } }), env, makeCtx(),
  )).json();
  assert.equal(report.report.sales_total_cents, 1380);
  assert.deepEqual(report.report.sales, [{ method: "cash", count: 2, total_cents: 1380 }]);
  assert.equal(report.report.expected_cash_cents, 1380, "el efectivo esperado incluye el IVA");
  assert.equal(report.report.orders.paid, 2);
});

/* ── Ticket del cliente ──────────────────────────────────────────────────── */

test("el ticket del cliente muestra Subtotal, IVA 15% y Total; la comanda no lleva dinero", () => {
  const lines = clientTicketLines({
    id: "abc-345", number: 7, created_at: Date.UTC(2026, 10, 17, 15, 30),
    delivery_mode: "pickup", sede_nombre: "Centro",
    subtotal_cents: 297, tax_cents: 45, total_cents: 342,
    items: [{ name: "Postre 0,99", qty: 3, unit_cents: 99, base_cents: 297, tax_rate_bp: 1500, tax_cents: 45 }],
  }, { store: "Munch", width: 32 });

  assert.ok(lines.every(line => Array.from(line).length <= 32), "respeta el ancho de 32 columnas");
  const joined = lines.join("\n");
  assert.match(joined, /RECIBO #007/);
  assert.match(joined, /3 x Postre 0,99/);
  for (const aside of ["Subtotal", "IVA 15%", "TOTAL"]) assert.ok(joined.includes(aside), aside);
  assert.match(joined, /Subtotal\s+\$2\.97/);
  assert.match(joined, /IVA 15%\s+\$0\.45/);
  assert.match(joined, /TOTAL\s+\$3\.42/);
  assert.equal(lines.filter(line => /FALTANTE|Sobrante/.test(line)).length, 0);
  // El rótulo del ticket es legible: etiqueta y monto en la misma fila.
  assert.ok(lines.some(line => etiqueta(line) === "TOTAL · $3.42"));
});
