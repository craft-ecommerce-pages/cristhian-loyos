// Payphone: Prepare + V2/Confirm con mock local (sin red), retorno idempotente y
// conciliación ante timeout. Nunca se llama al proveedor real sin PAYPHONE_MODE=live + token.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { preparePayphone } from "../src/payphone.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const jsonAccept = { headers: { accept: "application/json" } };

const product = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

function payEnv(currency = "USD") {
  const env = makeEnv({
    "pizza:config": { currency, location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }] } },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return env;
}
async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
async function newOrder(env, ctx, key = "web-pay-0001") {
  const response = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: key,
    items: [{ product_id: "margarita", qty: 2 }],
    customer: { name: "Ana", phone: "099" }, delivery_mode: "pickup",
  }), env, ctx);
  assert.equal(response.status, 201);
  return response.json();
}
async function start(env, ctx, orderId, key, cookie) {
  return panel.fetch(body(`/panel/api/orders/${orderId}/payphone`, { idempotency_key: key }, { headers: { cookie } }), env, ctx);
}
const paymentOf = (env, orderId, key) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? AND idempotency_key = ?",
).get(orderId, key);
const comandas = (env, orderId) => env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(orderId).n;

test("Prepare live envía un importe sin IVA coherente con el contrato de Payphone", async () => {
  const original = globalThis.fetch;
  let payload;
  globalThis.fetch = async (_url, init) => {
    payload = JSON.parse(init.body);
    return Response.json({ payWithCard: "https://pay.payphonetodoesposible.com/test" });
  };
  try {
    const payment = { amount_cents: 1700, provider_ref: "CL1234567890123" };
    const url = await preparePayphone({ PAYPHONE_MODE: "live", PAYPHONE_TOKEN: "test-only" },
      "https://cliente.example", { id: "order-1", number: 1 }, payment);
    assert.match(url, /^https:\/\//);
    assert.equal(payload.amount, 1700);
    assert.equal(payload.amountWithoutTax, 1700);
    assert.equal(payload.amountWithTax, 0);
    assert.equal(payload.tax, 0);
    assert.equal(payload.responseUrl, "https://cliente.example/api/payphone/return");
    assert.equal(payload.cancellationUrl, "https://cliente.example/panel?pago=cancelado");
  } finally { globalThis.fetch = original; }
});

test("Prepare en mock: no toca la red, guarda el intento antes y es idempotente por clave", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no debe llamar a la red"); };
  try {
    let response = await start(env, ctx, order.id, "pay-0001", cookie);
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.match(first.payment_id, /^[A-Za-z0-9]{15}$/);
    assert.equal(first.payment_url,
      `https://${host}/api/payphone/mock?p=${first.payment_id}&resultado=aprobado`);
    assert.equal(first.total_cents, 1700);

    response = await start(env, ctx, order.id, "pay-0001", cookie);
    const again = await response.json();
    assert.deepEqual(again, first, "misma clave ⇒ mismo payment_id y URL");
    assert.equal(calls, 0, "el modo mock nunca llama a Payphone");
    assert.equal(paymentOf(env, order.id, "pay-0001").status, "pending");

    // La URL de retorno simulada redirige al retorno real con el id del mock.
    response = await panel.fetch(request(`/api/payphone/mock?p=${first.payment_id}&resultado=rechazado`), env, ctx);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"),
      `https://${host}/api/payphone/return?id=rejected&clientTransactionId=${first.payment_id}`);
  } finally { globalThis.fetch = original; }
});

test("retorno aprobado: orden pagada, pago conciliado y una sola comanda", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const started = await (await start(env, ctx, order.id, "pay-0002", cookie)).json();
  const id = `m${started.payment_id.slice(0, 12)}`;
  let response = await panel.fetch(request(
    `/api/payphone/return?id=${id}&clientTransactionId=${started.payment_id}&format=json`, jsonAccept), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });

  const row = env.DB.raw.prepare("SELECT status, paid_at FROM pos_orders WHERE id = ?").get(order.id);
  assert.equal(row.status, "paid");
  assert.ok(Number(row.paid_at) > 0);
  const payment = paymentOf(env, order.id, "pay-0002");
  assert.equal(payment.status, "paid");
  assert.equal(payment.provider_id, id);
  assert.equal(payment.authorization, `MOCK${started.payment_id.slice(0, 8)}`);
  assert.equal(comandas(env, order.id), 1);

  // Doble retorno (recarga): no duplica comanda ni pago.
  response = await panel.fetch(request(`/api/payphone/return?id=${id}&clientTransactionId=${started.payment_id}&format=json`, jsonAccept), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(comandas(env, order.id), 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_payments WHERE order_id = ?").get(order.id).n, 1);

  // El operador vuelve al panel con el estado en la URL.
  response = await panel.fetch(request(`/api/payphone/return?id=${id}&clientTransactionId=${started.payment_id}`), env, ctx);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `https://${host}/panel?pago=aprobado&pedido=${order.id}`);

  // Repetir Prepare después de pagar devuelve el estado pagado sin nueva URL.
  response = await start(env, ctx, order.id, "pay-0002", cookie);
  assert.deepEqual(await response.json(), {
    order_id: order.id, payment_id: started.payment_id, payment_url: null, status: "paid",
  });
  // Otra clave sobre la orden pagada es conflicto.
  response = await start(env, ctx, order.id, "pay-0003", cookie);
  assert.deepEqual(await response.json(), { error: "orden_ya_pagada" });
});

test("rechazo del banco: orden rechazada sin comanda; estado visible en el retorno", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const started = await (await start(env, ctx, order.id, "pay-0004", cookie)).json();
  const response = await panel.fetch(request(
    `/api/payphone/return?id=rejected&clientTransactionId=${started.payment_id}&format=json`, jsonAccept), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "rechazado", order_id: order.id, order_status: "rejected" });
  assert.equal(paymentOf(env, order.id, "pay-0004").status, "rejected");
  assert.match(paymentOf(env, order.id, "pay-0004").message, /Fondos insuficientes/);
  assert.equal(comandas(env, order.id), 0);
});

test("importe alterado: no se acepta, pago unknown y la orden sigue pendiente (conciliación)", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const started = await (await start(env, ctx, order.id, "pay-0005", cookie)).json();
  const response = await panel.fetch(request(
    `/api/payphone/return?id=amountbad&clientTransactionId=${started.payment_id}&format=json`, jsonAccept), env, ctx);
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "pago_alterado" });
  assert.equal(paymentOf(env, order.id, "pay-0005").status, "unknown");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "pending");
  assert.equal(comandas(env, order.id), 0);
});

test("timeout de confirmación: nunca se asume rechazo; queda unknown para conciliar", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const started = await (await start(env, ctx, order.id, "pay-0006", cookie)).json();
  const response = await panel.fetch(request(
    `/api/payphone/return?id=timeout&clientTransactionId=${started.payment_id}&format=json`, jsonAccept), env, ctx);
  assert.equal(response.status, 502);
  assert.equal(paymentOf(env, order.id, "pay-0006").status, "unknown");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "pending");
  assert.equal(comandas(env, order.id), 0);

  // El navegador ve "pendiente", no "rechazado".
  const browser = await panel.fetch(request(`/api/payphone/return?id=timeout&clientTransactionId=${started.payment_id}`), env, ctx);
  assert.equal(browser.headers.get("location"), `https://${host}/panel?pago=pendiente&pedido=${order.id}`);
});

test("referencia desconocida y moneda no soportada", async () => {
  const env = payEnv("EUR"), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx);
  const response = await start(env, ctx, order.id, "pay-0007", cookie);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "moneda_no_soportada" });

  const unknown = await panel.fetch(request("/api/payphone/return?id=abc&clientTransactionId=AAAAAAAAAAAAAAA&format=json", jsonAccept), env, ctx);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "pago_no_existe" });
});

test("live sin token: 503 y sin llamada al proveedor; el mock deja de existir", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  env.PAYPHONE_MODE = "live";
  delete env.PAYPHONE_TOKEN;
  const order = await newOrder(env, ctx);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("sin red en pruebas"); };
  try {
    const response = await start(env, ctx, order.id, "pay-0008", cookie);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "pago_proveedor" });
    assert.equal(calls, 0);
    assert.equal(paymentOf(env, order.id, "pay-0008").status, "failed");
    const mock = await panel.fetch(request("/api/payphone/mock?p=AAAAAAAAAAAAAAA"), env, ctx);
    assert.equal(mock.status, 404);
  } finally { globalThis.fetch = original; }
});

test("job programado: concilia unknown dentro de 5 min y no toca los vencidos", async () => {
  const { reconcilePendingPayments } = await import("../src/payphone.js");
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx, "web-pay-job1");
  const started = await (await start(env, ctx, order.id, "pay-0009", cookie)).json();
  const id = `m${started.payment_id.slice(0, 12)}`;
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', provider_id = ?, updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(id, Date.now(), order.id, "pay-0009");

  let result = await reconcilePendingPayments(env);
  assert.deepEqual(result, { checked: 1, settled: 1, pending: 0 });
  assert.equal(paymentOf(env, order.id, "pay-0009").status, "paid");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "paid");
  assert.equal(comandas(env, order.id), 1);

  // Fuera de la ventana de 5 minutos no se reconsulta: queda unknown para revisión manual.
  const old = await newOrder(env, ctx, "web-pay-job2");
  const oldStart = await (await start(env, ctx, old.id, "pay-0010", cookie)).json();
  const oldId = `m${oldStart.payment_id.slice(0, 12)}`;
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', provider_id = ?, updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(oldId, Date.now() - 6 * 60 * 1000, old.id, "pay-0010");
  result = await reconcilePendingPayments(env);
  assert.deepEqual(result, { checked: 0, settled: 0, pending: 0 });
  assert.equal(paymentOf(env, old.id, "pay-0010").status, "unknown");
  assert.equal(comandas(env, old.id), 0);
});

test("ruta autenticada de conciliación: reconsulta sin recobrar y respeta la ventana", async () => {
  const env = payEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx, "web-pay-rec1");
  const started = await (await start(env, ctx, order.id, "pay-0011", cookie)).json();
  const id = `m${started.payment_id.slice(0, 12)}`;
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', provider_id = ?, updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(id, Date.now(), order.id, "pay-0011");

  const path = `/panel/api/payments/${started.payment_id}/reconcile`;
  let response = await panel.fetch(request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);

  // Vencida: no se reconsulta y se informa el estado para revisión manual.
  const old = await newOrder(env, ctx, "web-pay-rec2");
  const oldStart = await (await start(env, ctx, old.id, "pay-0012", cookie)).json();
  const oldId = `m${oldStart.payment_id.slice(0, 12)}`;
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', provider_id = ?, updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(oldId, Date.now() - 6 * 60 * 1000, old.id, "pay-0012");
  response = await panel.fetch(request(`/panel/api/payments/${oldStart.payment_id}/reconcile`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" }), env, ctx);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "conciliacion_vencida", payment_status: "unknown" });
  assert.equal(comandas(env, old.id), 0);
});
