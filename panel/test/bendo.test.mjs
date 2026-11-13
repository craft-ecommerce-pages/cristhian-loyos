// Bendo: link de pagos hospedado. Pruebas sin red (fetch simulado) y sin nube:
// el modo mock resuelve el resultado por KV y `GET` del link es la verdad.
import test from "node:test";
import assert from "node:assert/strict";
import {
  bendoAvailable, bendoMode, bendoOutcome, handleBendoMock, handleBendoReturn, handleBendoWebhook,
  reconcileBendo, reconcilePendingBendo, startBendo, startPublicBendo,
} from "../src/bendo.js";
import { confirmPosOrder, createPosOrder, orderToken } from "../src/orders.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.example";
const site = { slug: "munch", host };
const origin = `https://${host}`;
const owner = { staff_id: "l_dueno00001", owner: true };
const request = (path, options = {}) => new Request(`${origin}${path}`, options);

const product = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

/* ── Entorno y pedidos ───────────────────────────────────────────────────── */

function bendoEnv(mode = "mock", extra = {}) {
  const env = makeEnv({
    "munch:config": { currency: "USD", location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] } },
  });
  env.CLIENT_SLUG = "munch";
  env.BENDO_MODE = mode;
  Object.assign(env, extra);
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return env;
}

// El pedido se crea con efectivo y aquí se fija el método `bendo` (ya válido por 0011).
function metodoBendo(env, orderId) {
  env.DB.raw.prepare("UPDATE pos_orders SET payment_method = 'bendo' WHERE id = ?").run(orderId);
}

async function webOrder(env, key = "web-bendo-0001") {
  const response = await createPosOrder(env, site, {
    sede_id: "centro", idempotency_key: key,
    items: [{ product_id: "margarita", qty: 2 }],
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
    },
    delivery_mode: "pickup",
  }, { source: "web" });
  assert.equal(response.status, 201);
  const order = await response.json();
  metodoBendo(env, order.id);
  return order;
}

async function cajaOrder(env, key = "caja-bendo-0001") {
  const response = await createPosOrder(env, site, {
    sede_id: "centro", idempotency_key: key, items: [{ product_id: "margarita", qty: 1 }],
  }, { source: "caja", session: owner });
  assert.equal(response.status, 201);
  const order = await response.json();
  metodoBendo(env, order.id);
  const confirmed = await confirmPosOrder(env, site, owner, encodeURIComponent(order.id));
  assert.equal(confirmed.status, 200);
  return order;
}

const paymentOf = (env, orderId, key) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? AND idempotency_key = ?",
).get(orderId, key);
const paymentByRef = (env, ref) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE provider_ref = ?",
).get(ref);
const paymentCount = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_payments WHERE order_id = ?",
).get(orderId).n;
const comandas = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?",
).get(orderId).n;
const orderRow = (env, orderId) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(orderId);

// Firma del webhook calculada de forma independiente al adaptador.
async function firma(ref, secret = "test-secret") {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`bendo-webhook:${ref}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Reemplaza globalThis.fetch y guarda cada llamada. Restaurar siempre en finally.
function conFetch(handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ url: href, method: String(init.method || "GET").toUpperCase(), body: init.body });
    return handler(href, init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const TOKEN_STAGING = "https://idp.stg.geopagos.io/auth/realms/stg_c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token";
const TOKEN_PRODUCTION = "https://idp.prd.geopagos.io/auth/realms/c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token";

/* ── Configuración y disponibilidad ──────────────────────────────────────── */

test("modos y disponibilidad: disabled por defecto, mock siempre, live con credenciales", () => {
  assert.equal(bendoMode({}), "disabled");
  assert.equal(bendoMode({ BENDO_MODE: "otro" }), "disabled");
  assert.equal(bendoMode({ BENDO_MODE: "mock" }), "mock");
  assert.equal(bendoMode({ BENDO_MODE: "live" }), "live");
  assert.equal(bendoAvailable({}), false);
  assert.equal(bendoAvailable({ BENDO_MODE: "mock" }), true);
  assert.equal(bendoAvailable({ BENDO_MODE: "live" }), false);
  assert.equal(bendoAvailable({ BENDO_MODE: "live", BENDO_CLIENT_ID: "id" }), false);
  assert.equal(bendoAvailable({ BENDO_MODE: "live", BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s" }), true);
});

/* ── Verificación ────────────────────────────────────────────────────────── */

test("bendoOutcome: aprobado, pendiente con DENIED, rechazado y mismatch por id/monto/moneda/REFUNDED", () => {
  const payment = { provider_id: "link-1", amount_cents: 1700 };
  const base = { id: "link-1", amount: 17, currency: "USD", status: "PENDING", payments: [] };

  assert.equal(bendoOutcome({ ...base, payments: [{ status: "DENIED" }] }, payment), "pending");
  assert.equal(bendoOutcome({ ...base, status: "IN_PROGRESS" }, payment), "pending");
  assert.equal(bendoOutcome({ ...base, payments: [{ status: "IN_PROGRESS" }] }, payment), "pending");
  assert.equal(bendoOutcome({
    ...base, status: "APPROVED", payments: [{ status: "APPROVED", authorization_code: "A1" }],
  }, payment), "approved");
  assert.equal(bendoOutcome({ ...base, status: "NOT_AVAILABLE", payments: [] }, payment), "rejected");
  assert.equal(bendoOutcome({ ...base, status: "NOT_AVAILABLE", payments: [{ status: "IN_PROGRESS" }] }, payment), "pending");

  assert.equal(bendoOutcome({ ...base, id: "link-2" }, payment), "mismatch");
  assert.equal(bendoOutcome({ ...base, amount: 17.01 }, payment), "mismatch");
  assert.equal(bendoOutcome({ ...base, currency: "PEN" }, payment), "mismatch");
  assert.equal(bendoOutcome({ ...base, payments: [{ status: "REFUNDED" }] }, payment), "mismatch");
  assert.equal(bendoOutcome({ ...base, currency: null }, payment), "pending");
  assert.equal(bendoOutcome(null, payment), "mismatch");
});

/* ── Payload del link y entornos ─────────────────────────────────────────── */

test("live staging: payload con point_of_sale, USD y unit_price del total, sin merchant_id", async () => {
  const env = bendoEnv("live", {
    BENDO_CLIENT_ID: "id-comercio", BENDO_CLIENT_SECRET: "secreto-comercio",
    BENDO_POINT_OF_SALE: "pos-123", BENDO_ENV: "staging",
  });
  const order = await cajaOrder(env);
  let payload;
  const fake = conFetch(async (href, init) => {
    if (href === TOKEN_STAGING) {
      assert.equal(init.method, "POST");
      assert.match(String(init.body), /grant_type=client_credentials/);
      assert.match(String(init.body), /scope=openid/);
      return Response.json({ access_token: "token-prueba" });
    }
    if (href === "https://api.stg.geopagos.io/api/v4/payments/links") {
      assert.equal(init.method, "POST");
      payload = JSON.parse(String(init.body));
      assert.equal(init.headers.authorization, "Bearer token-prueba");
      return Response.json(
        { id: "link-stg-1", transaction_data: { checkout_url: "https://checkout.bendo.ec/link-stg-1" } },
        { status: 201 },
      );
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const response = await startBendo(
      request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, { idempotency_key: "caja-pago-0001" },
    );
    assert.equal(response.status, 200);
    const started = await response.json();
    assert.equal(started.order_id, order.id);
    assert.match(started.payment_id, /^[A-Za-z0-9]{15}$/);
    assert.equal(started.payment_url, "https://checkout.bendo.ec/link-stg-1");
    assert.equal(started.status, "confirmed");
    assert.equal(started.total_cents, 850);

    // Un solo ítem, importe en dólares calculado en centavos y nada de merchant_id.
    assert.equal("merchant_id" in payload, false);
    assert.equal(payload.source, "ecommerce");
    assert.equal(payload.currency, "USD");
    assert.equal(payload.items.length, 1);
    assert.match(payload.items[0].description, /^Pedido Munch #\d+$/);
    assert.equal(payload.items[0].quantity, 1);
    assert.equal(payload.items[0].unit_price, 8.5);
    assert.equal(payload.items[0].external_reference, order.id);
    assert.equal(payload.point_of_sale, "pos-123");
    assert.equal(payload.expires_in_minutes, 30);
    assert.equal(payload.successful_payment_quantity_limit, 1);
    assert.equal(payload.webhook_version, "V4");

    const ref = started.payment_id;
    const signature = await firma(ref);
    assert.equal(payload.webhook_url, `${origin}/api/bendo/webhook?p=${ref}&s=${signature}`);
    assert.equal(payload.redirect_on_success, `${origin}/api/bendo/return?p=${ref}`);
    assert.equal(payload.redirect_on_failure, `${origin}/api/bendo/return?p=${ref}`);
    assert.deepEqual(JSON.parse(payload.external_data), { order_id: order.id, ref });

    const payment = paymentOf(env, order.id, "caja-pago-0001");
    assert.equal(payment.provider, "bendo");
    assert.equal(payment.status, "pending");
    assert.equal(payment.provider_id, "link-stg-1");
    assert.equal(payment.url, "https://checkout.bendo.ec/link-stg-1");
  } finally { fake.restore(); }
});

test("production usa las URLs de producción y cachea el punto de venta 24 h", async () => {
  const env = bendoEnv("live", { BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s", BENDO_ENV: "production" });
  let links = 0;
  const fake = conFetch(async href => {
    if (href === TOKEN_PRODUCTION) return Response.json({ access_token: "tk-prd" });
    if (href === "https://api.geopagos.io/api/v4/points-of-sale") return Response.json([{ uuid: "pos-prd-1" }, { uuid: "pos-prd-2" }]);
    if (href === "https://api.geopagos.io/api/v4/payments/links") {
      links++;
      return Response.json({ id: `link-prd-${links}`, transaction_data: { checkout_url: `https://checkout.bendo.ec/prd-${links}` } }, { status: 201 });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const first = await cajaOrder(env, "caja-prd-0001");
    let response = await startBendo(request(`/panel/api/orders/${first.id}/bendo`), env, site, owner, first.id, { idempotency_key: "pago-prd-0001" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).payment_url, "https://checkout.bendo.ec/prd-1");
    assert.equal(await env.MENUS.get("bendo:pos:production"), "pos-prd-1");

    const second = await cajaOrder(env, "caja-prd-0002");
    response = await startBendo(request(`/panel/api/orders/${second.id}/bendo`), env, site, owner, second.id, { idempotency_key: "pago-prd-0002" });
    assert.equal(response.status, 200);
    // El punto de venta viene de KV: una sola consulta a points-of-sale.
    assert.equal(fake.calls.filter(call => call.url.endsWith("/api/v4/points-of-sale")).length, 1);
    assert.equal(fake.calls.filter(call => call.url.includes("/api/v4/payments/links") && call.method === "POST").length, 2);
    assert.ok(fake.calls.every(call => !call.url.includes("stg.geopagos.io")));
  } finally { fake.restore(); }
});

/* ── Mock ────────────────────────────────────────────────────────────────── */

test("mock: URL local, resultado por KV y ninguna llamada a la red", async () => {
  const env = bendoEnv("mock");
  const order = await webOrder(env);
  const fake = conFetch(() => { throw new Error("el mock no debe usar la red"); });
  try {
    const response = await startPublicBendo(request(`/api/orders/${order.id}/bendo`), env, site, order.id, {
      order_token: order.order_token, idempotency_key: "web-pago-0001",
    });
    assert.equal(response.status, 200);
    const started = await response.json();
    const ref = started.payment_id;
    assert.equal(started.payment_url, `${origin}/api/bendo/mock?p=${ref}&resultado=aprobado`);
    assert.equal(started.status, "pending");
    assert.equal(started.total_cents, 1700);
    assert.equal(fake.calls.length, 0);
    assert.equal(paymentOf(env, order.id, "web-pago-0001").provider_id, `mock-${ref}`);

    const mock = await handleBendoMock(request(`/api/bendo/mock?p=${ref}&resultado=rechazado`), env);
    assert.equal(mock.status, 302);
    assert.equal(mock.headers.get("location"), `${origin}/api/bendo/return?p=${ref}`);
    assert.equal(await env.MENUS.get(`bendo:mock:${ref}`), "rechazado");
  } finally { fake.restore(); }

  // Sin modo explícito no existe el simulador ni se abre un cobro.
  const off = bendoEnv("disabled");
  assert.equal(bendoAvailable(off), false);
  assert.equal((await handleBendoMock(request("/api/bendo/mock?p=AAAAAAAAAAAAAAA"), off)).status, 404);
  const order2 = await webOrder(off, "web-bendo-0002");
  const blocked = await startPublicBendo(request(`/api/orders/${order2.id}/bendo`), off, site, order2.id, {
    order_token: order2.order_token, idempotency_key: "web-pago-0002",
  });
  assert.equal(blocked.status, 503);
  assert.deepEqual(await blocked.json(), { error: "bendo_no_disponible" });
});

/* ── Aprobado: return y webhook llegan ambos ─────────────────────────────── */

test("aprobado: return y webhook concilian una sola vez y emiten una sola comanda", async () => {
  const env = bendoEnv("mock");
  const order = await webOrder(env);
  const started = await (await startPublicBendo(request(`/api/orders/${order.id}/bendo`), env, site, order.id, {
    order_token: order.order_token, idempotency_key: "web-pago-0003",
  })).json();
  const ref = started.payment_id;

  const mock = await handleBendoMock(request(`/api/bendo/mock?p=${ref}&resultado=aprobado`), env);
  assert.equal(mock.status, 302);

  // El webhook llega primero y concilia; el return repetido no duplica nada.
  const webhook = await handleBendoWebhook(request(`/api/bendo/webhook?p=${ref}&s=${await firma(ref)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "evt-1", status: "APPROVED" }),
  }), env, site);
  assert.equal(webhook.status, 200);
  assert.deepEqual(await webhook.json(), { ok: true });

  const payment = paymentOf(env, order.id, "web-pago-0003");
  assert.equal(payment.status, "paid");
  assert.equal(payment.authorization, `MOCK${ref.slice(0, 8)}`);
  assert.equal(orderRow(env, order.id).status, "paid");
  assert.equal(comandas(env, order.id), 1);

  let response = await handleBendoReturn(request(`/api/bendo/return?p=${ref}&format=json`), env, site);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);
  assert.equal(paymentCount(env, order.id), 1);

  // Segundo webhook: idempotente.
  assert.equal((await handleBendoWebhook(request(`/api/bendo/webhook?p=${ref}&s=${await firma(ref)}`, { method: "POST", body: "{}" }), env, site)).status, 200);
  assert.equal(comandas(env, order.id), 1);

  // Navegador: redirección al panel (sin MENU_PUBLIC_URL) con el estado ya resuelto.
  response = await handleBendoReturn(request(`/api/bendo/return?p=${ref}`), env, site);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/panel?pago=aprobado&pedido=${encodeURIComponent(order.id)}`);

  // Con menú configurado el comprador vuelve a /gracias con el token del pedido.
  env.MENU_PUBLIC_URL = "https://menu.munch.ec";
  response = await handleBendoReturn(request(`/api/bendo/return?p=${ref}`), env, site);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"),
    `https://menu.munch.ec/gracias?pago=aprobado&pedido=${encodeURIComponent(order.id)}` +
    `&token=${encodeURIComponent(await orderToken(env, "munch", order.id))}`);

  // Misma clave ⇒ estado pagado sin nueva URL; otra clave sobre la orden pagada ⇒ 409.
  response = await startPublicBendo(request(`/api/orders/${order.id}/bendo`), env, site, order.id, {
    order_token: order.order_token, idempotency_key: "web-pago-0003",
  });
  assert.deepEqual(await response.json(), {
    order_id: order.id, payment_id: ref, payment_url: null, status: "paid", total_cents: 1700,
  });
  response = await startPublicBendo(request(`/api/orders/${order.id}/bendo`), env, site, order.id, {
    order_token: order.order_token, idempotency_key: "web-pago-0004",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "orden_ya_pagada" });
});

/* ── Rechazo, pendiente y timeout ────────────────────────────────────────── */

test("rechazado por NOT_AVAILABLE: pago y orden rechazados, sin comanda", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0002",
  })).json();
  await handleBendoMock(request(`/api/bendo/mock?p=${started.payment_id}&resultado=rechazado`), env);

  const response = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}&format=json`), env, site);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "rechazado", order_id: order.id, order_status: "rejected" });
  const payment = paymentOf(env, order.id, "caja-pago-0002");
  assert.equal(payment.status, "rejected");
  assert.equal(payment.message, "El pago con tarjeta no fue aprobado.");
  assert.equal(orderRow(env, order.id).status, "rejected");
  assert.equal(comandas(env, order.id), 0);
});

test("DENIED con link PENDING: sigue pendiente y permite reintentar en Bendo", async () => {
  const env = bendoEnv("live", {
    BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s", BENDO_POINT_OF_SALE: "pos-1", BENDO_ENV: "staging",
  });
  const order = await cajaOrder(env);
  const fake = conFetch(async (href, init) => {
    if (href === TOKEN_STAGING) return Response.json({ access_token: "tk" });
    if (href === "https://api.stg.geopagos.io/api/v4/payments/links" && init.method === "POST") {
      return Response.json({ id: "link-pend-1", transaction_data: { checkout_url: "https://checkout.bendo.ec/pend" } }, { status: 201 });
    }
    if (href === "https://api.stg.geopagos.io/api/v4/payments/links/link-pend-1") {
      return Response.json({
        id: "link-pend-1", amount: 8.5, currency: "USD", status: "PENDING", payments: [{ status: "DENIED" }],
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
      idempotency_key: "caja-pago-0003",
    })).json();
    const response = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}&format=json`), env, site);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "pendiente", order_id: order.id, order_status: "confirmed" });
    const payment = paymentOf(env, order.id, "caja-pago-0003");
    assert.equal(payment.status, "pending");
    assert.equal(orderRow(env, order.id).status, "confirmed");
    assert.equal(comandas(env, order.id), 0);
  } finally { fake.restore(); }
});

test("timeout de Bendo: nunca rechazo; el pago queda unknown para conciliar", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0004",
  })).json();
  await handleBendoMock(request(`/api/bendo/mock?p=${started.payment_id}&resultado=timeout`), env);

  const response = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}&format=json`), env, site);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { status: "pendiente", order_id: order.id, order_status: "confirmed" });
  const payment = paymentOf(env, order.id, "caja-pago-0004");
  assert.equal(payment.status, "unknown");
  assert.equal(payment.message, "bendo_timeout");
  assert.equal(orderRow(env, order.id).status, "confirmed");
  assert.equal(comandas(env, order.id), 0);

  const browser = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}`), env, site);
  assert.equal(browser.status, 302);
  assert.equal(browser.headers.get("location"), `${origin}/panel?pago=pendiente&pedido=${encodeURIComponent(order.id)}`);
});

/* ── Integridad del link verificado ──────────────────────────────────────── */

test("monto alterado en el GET: 422 pago_alterado, pago unknown y sin comanda", async () => {
  const env = bendoEnv("live", {
    BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s", BENDO_POINT_OF_SALE: "pos-1", BENDO_ENV: "staging",
  });
  const order = await cajaOrder(env);
  const fake = conFetch(async (href, init) => {
    if (href === TOKEN_STAGING) return Response.json({ access_token: "tk" });
    if (href === "https://api.stg.geopagos.io/api/v4/payments/links" && init.method === "POST") {
      return Response.json({ id: "link-bad-1", transaction_data: { checkout_url: "https://checkout.bendo.ec/bad" } }, { status: 201 });
    }
    if (href.endsWith("/api/v4/payments/links/link-bad-1")) {
      return Response.json({
        id: "link-bad-1", amount: 8.51, currency: "USD", status: "APPROVED",
        payments: [{ status: "APPROVED", authorization_code: "X" }],
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
      idempotency_key: "caja-pago-0005",
    })).json();
    const response = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}&format=json`), env, site);
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "pago_alterado" });
    assert.equal(paymentOf(env, order.id, "caja-pago-0005").status, "unknown");
    assert.equal(orderRow(env, order.id).status, "confirmed");
    assert.equal(comandas(env, order.id), 0);
  } finally { fake.restore(); }
});

/* ── Idempotencia del inicio ─────────────────────────────────────────────── */

test("inicio idempotente: misma clave reutiliza el link pendiente y no duplica intentos", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const first = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0006",
  })).json();
  const again = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0006",
  })).json();
  assert.deepEqual(again, first);
  assert.equal(paymentCount(env, order.id), 1);

  // Un pedido de caja todavía en `pending` no se cobra con Bendo.
  const pending = await createPosOrder(env, site, {
    sede_id: "centro", idempotency_key: "caja-bendo-0009", items: [{ product_id: "margarita", qty: 1 }],
  }, { source: "caja", session: owner });
  const pendingOrder = await pending.json();
  const rejected = await startBendo(request(`/panel/api/orders/${pendingOrder.id}/bendo`), env, site, owner, pendingOrder.id, {
    idempotency_key: "caja-pago-0007",
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: "estado_invalido" });
  assert.equal(paymentCount(env, pendingOrder.id), 0);

  // Sin clave o con moneda distinta de USD no se abre un cobro.
  const noKey = await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {});
  assert.equal(noKey.status, 400);
  assert.deepEqual(await noKey.json(), { error: "idempotency_key_requerida" });
});

/* ── Webhook: firma, ref desconocida y error de Bendo ────────────────────── */

test("webhook con firma inválida o ref desconocida: 200 sin llamar a Bendo", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0008",
  })).json();
  env.BENDO_MODE = "live";
  env.BENDO_CLIENT_ID = "id";
  env.BENDO_CLIENT_SECRET = "s";
  env.BENDO_POINT_OF_SALE = "pos-1";

  const fake = conFetch(() => { throw new Error("no debe llamarse a Bendo"); });
  try {
    // Firma alterada: 200 y cero trabajo.
    let response = await handleBendoWebhook(request(`/api/bendo/webhook?p=${started.payment_id}&s=${"0".repeat(32)}`, {
      method: "POST", body: "{}",
    }), env, site);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    // Sin firma.
    response = await handleBendoWebhook(request(`/api/bendo/webhook?p=${started.payment_id}`, { method: "POST", body: "{}" }), env, site);
    assert.equal(response.status, 200);

    // Ref desconocida con firma válida.
    const unknownRef = "AAAAAAAAAAAAAAA";
    response = await handleBendoWebhook(request(`/api/bendo/webhook?p=${unknownRef}&s=${await firma(unknownRef)}`, {
      method: "POST", body: "{}",
    }), env, site);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    assert.equal(fake.calls.length, 0);
    assert.equal(paymentOf(env, order.id, "caja-pago-0008").status, "pending");
    assert.equal(comandas(env, order.id), 0);
  } finally { fake.restore(); }
});

test("webhook con error de Bendo: 503 para que Geopagos reintente y pago unknown", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0009",
  })).json();
  env.BENDO_MODE = "live";
  env.BENDO_CLIENT_ID = "id";
  env.BENDO_CLIENT_SECRET = "s";
  env.BENDO_POINT_OF_SALE = "pos-1";

  const fake = conFetch(async href => {
    if (href === TOKEN_STAGING) return Response.json({ access_token: "tk" });
    if (href.includes("/api/v4/payments/links/")) return new Response("falla", { status: 500 });
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const response = await handleBendoWebhook(request(`/api/bendo/webhook?p=${started.payment_id}&s=${await firma(started.payment_id)}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "evt-2" }),
    }), env, site);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false });
    const payment = paymentOf(env, order.id, "caja-pago-0009");
    assert.equal(payment.status, "unknown");
    assert.equal(payment.message, "bendo_timeout");
    assert.equal(orderRow(env, order.id).status, "confirmed");
    assert.equal(comandas(env, order.id), 0);
  } finally { fake.restore(); }
});

/* ── Conciliación manual y cron ──────────────────────────────────────────── */

test("reconcileBendo: reconsulta sin ventana de tiempo desde la caja", async () => {
  const env = bendoEnv("mock");
  const order = await cajaOrder(env);
  const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
    idempotency_key: "caja-pago-0010",
  })).json();
  // Muy antiguo: Bendo no revierte a los 5 minutos, así que no hay ventana.
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(Date.now() - 60 * 60 * 1000, order.id, "caja-pago-0010");
  await handleBendoMock(request(`/api/bendo/mock?p=${started.payment_id}&resultado=aprobado`), env);

  const response = await reconcileBendo(env, site, owner, paymentByRef(env, started.payment_id));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);
});

test("cron: concilia bendo pending/unknown de las últimas 2 h y no toca los viejos", async () => {
  const env = bendoEnv("mock");
  const fresh = await cajaOrder(env, "caja-cron-0001");
  const started = await (await startBendo(request(`/panel/api/orders/${fresh.id}/bendo`), env, site, owner, fresh.id, {
    idempotency_key: "caja-pago-0011",
  })).json();
  await handleBendoMock(request(`/api/bendo/mock?p=${started.payment_id}&resultado=aprobado`), env);

  const old = await cajaOrder(env, "caja-cron-0002");
  const oldStarted = await (await startBendo(request(`/panel/api/orders/${old.id}/bendo`), env, site, owner, old.id, {
    idempotency_key: "caja-pago-0012",
  })).json();
  await handleBendoMock(request(`/api/bendo/mock?p=${oldStarted.payment_id}&resultado=aprobado`), env);
  env.DB.raw.prepare("UPDATE pos_payments SET created_at = ? WHERE order_id = ? AND idempotency_key = ?")
    .run(Date.now() - 3 * 60 * 60 * 1000, old.id, "caja-pago-0012");

  const result = await reconcilePendingBendo(env);
  assert.deepEqual(result, { checked: 1, settled: 1, pending: 0 });
  assert.equal(paymentOf(env, fresh.id, "caja-pago-0011").status, "paid");
  assert.equal(orderRow(env, fresh.id).status, "paid");
  assert.equal(comandas(env, fresh.id), 1);
  assert.equal(paymentOf(env, old.id, "caja-pago-0012").status, "pending");
  assert.equal(orderRow(env, old.id).status, "confirmed");
  assert.equal(comandas(env, old.id), 0);
});
