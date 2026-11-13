// Bendo de extremo a extremo por el handler del Worker: rutas públicas y de panel,
// return, webhook (incluido el duplicado), conciliación por referencia y cron.
// Sin red real: el modo mock resuelve por KV y en live se simula `globalThis.fetch`.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.example";
const origin = `https://${host}`;
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const jsonAccept = { headers: { accept: "application/json" } };

const product = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

/* ── Entorno, sesión y utilidades ────────────────────────────────────────── */

function bendoEnv(mode = "mock", extra = {}) {
  const env = makeEnv({
    "munch:config": {
      currency: "USD",
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] },
    },
  });
  env.CLIENT_SLUG = "munch";
  env.BENDO_MODE = mode;
  env.PAYPHONE_MODE = "mock";
  Object.assign(env, extra);
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return env;
}

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/munch/owner", { email: "dueno@munch.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

// Pedido web con tarjeta: es el flujo del checkout (POST público + inicio del link).
async function webOrder(env, ctx, key = "web-bendo-0001", method = "bendo") {
  const response = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: key, payment_method: method,
    items: [{ product_id: "margarita", qty: 2 }],
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
    },
    delivery_mode: "pickup",
  }), env, ctx);
  assert.equal(response.status, 201);
  return response.json();
}

async function startWeb(env, ctx, order, key) {
  return panel.fetch(body(`/api/orders/${order.id}/bendo`, {
    order_token: order.order_token, idempotency_key: key,
  }), env, ctx);
}

// Pedido de caja ya confirmado: es el que puede cobrarse desde el panel.
async function cajaOrder(env, ctx, cookie, key = "caja-bendo-0001") {
  let response = await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro", idempotency_key: key, payment_method: "bendo",
    items: [{ product_id: "margarita", qty: 1 }],
  }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 201);
  const order = await response.json();
  response = await panel.fetch(body(`/panel/api/orders/${order.id}/confirm`, {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
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

// Firma del webhook calculada fuera del adaptador (mismo HMAC del contrato).
async function firma(ref, secret = "test-secret") {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`bendo-webhook:${ref}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

const webhook = (ref, signature, options = {}) => request(
  `/api/bendo/webhook?p=${ref}&s=${signature === undefined ? "" : signature}`,
  { method: "POST", headers: { "content-type": "application/json", ...(options.headers || {}) }, body: options.body ?? "{}" },
);

// Reemplaza globalThis.fetch y guarda cada llamada; restaurar siempre en finally.
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
const API_STAGING = "https://api.stg.geopagos.io";

/* ── GET /api/payment-options ────────────────────────────────────────────── */

test("payment-options anuncia bendo solo con el adaptador disponible (público)", async () => {
  const response = await panel.fetch(request("/api/payment-options"), bendoEnv("mock"), {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).bendo, true);

  const off = await panel.fetch(request("/api/payment-options"), bendoEnv("disabled"), {});
  assert.equal((await off.json()).bendo, false);

  // live sin credenciales no se anuncia; con ambas sí.
  let env = bendoEnv("live");
  assert.equal((await (await panel.fetch(request("/api/payment-options"), env, {})).json()).bendo, false);
  env = bendoEnv("live", { BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s" });
  assert.equal((await (await panel.fetch(request("/api/payment-options"), env, {})).json()).bendo, true);
});

/* ── Web: crear, iniciar, return aprobado y comanda única ────────────────── */

test("web bendo (mock): crear pedido, iniciar link, return aprobado ⇒ pagado y una comanda", async () => {
  const env = bendoEnv("mock");
  const order = await webOrder(env, {});
  assert.equal(order.payment_method, "bendo");

  const started = await startWeb(env, {}, order, "web-pago-0001");
  assert.equal(started.status, 200);
  const link = await started.json();
  assert.match(link.payment_id, /^[A-Za-z0-9]{15}$/);
  assert.equal(link.order_id, order.id);
  assert.equal(link.total_cents, 1700);
  assert.equal(link.status, "pending");
  assert.equal(link.payment_url, `${origin}/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`);
  assert.equal(paymentOf(env, order.id, "web-pago-0001").status, "pending");

  // El simulador guarda el resultado y redirige al return real.
  const mock = await panel.fetch(request(`/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`), env, {});
  assert.equal(mock.status, 302);
  assert.equal(mock.headers.get("location"), `${origin}/api/bendo/return?p=${link.payment_id}`);

  const returned = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`, jsonAccept), env, {});
  assert.equal(returned.status, 200);
  assert.deepEqual(await returned.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });

  const payment = paymentOf(env, order.id, "web-pago-0001");
  assert.equal(payment.provider, "bendo");
  assert.equal(payment.status, "paid");
  assert.equal(payment.authorization, `MOCK${link.payment_id.slice(0, 8)}`);
  assert.equal(orderRow(env, order.id).status, "paid");
  assert.equal(comandas(env, order.id), 1);

  // El comprador ve el pago confirmado en el estado público.
  const status = await panel.fetch(request(`/api/orders/${order.id}?token=${encodeURIComponent(order.order_token)}`), env, {});
  assert.equal(status.status, 200);
  const state = await status.json();
  assert.equal(state.payment_status, "paid");
  assert.equal(state.status, "paid");

  // Return repetido (recarga del navegador): idempotente, sin segunda comanda.
  const again = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`, jsonAccept), env, {});
  assert.deepEqual(await again.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);
  assert.equal(paymentCount(env, order.id), 1);
});

test("webhook y return repetidos no crean una segunda comanda", async () => {
  const env = bendoEnv("mock");
  const order = await webOrder(env, {}, "web-bendo-0002");
  const link = await (await startWeb(env, {}, order, "web-pago-0002")).json();
  const signature = await firma(link.payment_id);

  await panel.fetch(request(`/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`), env, {});
  let response = await panel.fetch(webhook(link.payment_id, signature), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(comandas(env, order.id), 1);

  // Duplicado del webhook y el return del navegador después: nada se duplica.
  response = await panel.fetch(webhook(link.payment_id, signature), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  response = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`), env, {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/panel?pago=aprobado&pedido=${encodeURIComponent(order.id)}`);
  assert.equal(comandas(env, order.id), 1);
  assert.equal(paymentCount(env, order.id), 1);

  // Firma inválida y ref desconocida: 200 sin trabajo (Geopagos no reintenta en bucle).
  assert.equal((await panel.fetch(webhook(link.payment_id, "0".repeat(32)), env, {})).status, 200);
  const unknown = "AAAAAAAAAAAAAAA";
  assert.equal((await panel.fetch(webhook(unknown, await firma(unknown)), env, {})).status, 200);
  assert.equal(comandas(env, order.id), 1);
});

/* ── Caja: cobro con link, QR y conciliación ─────────────────────────────── */

test("caja: cobrar con tarjeta por el panel y conciliar la referencia", async () => {
  const env = bendoEnv("mock");
  const cookie = await ownerCookie(env);
  const order = await cajaOrder(env, {}, cookie);

  // `me` expone el cobro con tarjeta para que la caja muestre el botón.
  const me = await (await panel.fetch(request("/panel/api/me", { headers: { cookie } }), env, {})).json();
  assert.equal(me.bendo, true);

  const started = await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, { idempotency_key: "caja-pago-0001" }, { headers: { cookie } }), env, {});
  assert.equal(started.status, 200);
  const link = await started.json();
  assert.equal(link.order_id, order.id);
  assert.equal(link.total_cents, 850);
  assert.equal(link.status, "confirmed");

  // Reintento con la misma clave: mismo enlace, un solo intento.
  const again = await (await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, { idempotency_key: "caja-pago-0001" }, { headers: { cookie } }), env, {})).json();
  assert.deepEqual(again, link);
  assert.equal(paymentCount(env, order.id), 1);

  // El operador pulsa "Verificar pago": reconsulta el link sin recobrar.
  await panel.fetch(request(`/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`), env, {});
  let response = await panel.fetch(body(`/panel/api/payments/${link.payment_id}/reconcile`, {}, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);

  // Repetir la conciliación de un pago ya cobrado es idempotente.
  response = await panel.fetch(body(`/panel/api/payments/${link.payment_id}/reconcile`, {}, { headers: { cookie } }), env, {});
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(comandas(env, order.id), 1);
});

test("la misma ruta de conciliación sigue despachando Payphone por referencia", async () => {
  const env = bendoEnv("mock");
  const cookie = await ownerCookie(env);
  const order = await cajaOrder(env, {}, cookie, "caja-payphone-0001");
  const started = await (await panel.fetch(body(`/panel/api/orders/${order.id}/payphone`, {
    idempotency_key: "pay-pago-0001",
  }, { headers: { cookie } }), env, {})).json();
  // Payphone adjunta el id en el retorno; aquí se deja `unknown` con id para conciliar.
  const id = `m${started.payment_id.slice(0, 12)}`;
  env.DB.raw.prepare(
    "UPDATE pos_payments SET status = 'unknown', provider_id = ?, updated_at = ? WHERE order_id = ? AND idempotency_key = ?",
  ).run(id, Date.now(), order.id, "pay-pago-0001");

  const response = await panel.fetch(body(`/panel/api/payments/${started.payment_id}/reconcile`, {}, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });
  assert.equal(paymentOf(env, order.id, "pay-pago-0001").status, "paid");
  assert.equal(comandas(env, order.id), 1);
});

/* ── Live: link real simulado con fetch falso ───────────────────────────── */

test("live: link de Bendo, webhook sin JSON y return al menú con el estado conciliado", async () => {
  const env = bendoEnv("live", {
    BENDO_CLIENT_ID: "id-comercio", BENDO_CLIENT_SECRET: "secreto-comercio",
    BENDO_POINT_OF_SALE: "pos-123", BENDO_ENV: "staging", MENU_PUBLIC_URL: "https://menu.munch.ec",
  });
  const fake = conFetch(async (href, init) => {
    if (href === TOKEN_STAGING) {
      assert.equal(init.method, "POST");
      assert.match(String(init.body), /grant_type=client_credentials/);
      return Response.json({ access_token: "token-prueba" });
    }
    if (href === `${API_STAGING}/api/v4/payments/links` && init.method === "POST") {
      const sent = JSON.parse(String(init.body));
      assert.equal("merchant_id" in sent, false);
      assert.equal(sent.currency, "USD");
      assert.equal(sent.point_of_sale, "pos-123");
      assert.equal(sent.items[0].unit_price, 17);
      assert.match(sent.webhook_url, new RegExp(`^${origin}/api/bendo/webhook\\?p=[A-Za-z0-9]{15}&s=[0-9a-f]{32}$`));
      return Response.json({
        id: "link-live-1", transaction_data: { checkout_url: "https://checkout.bendo.ec/link-live-1" },
      }, { status: 201 });
    }
    if (href === `${API_STAGING}/api/v4/payments/links/link-live-1`) {
      return Response.json({
        id: "link-live-1", amount: 17, currency: "USD", status: "APPROVED",
        payments: [{ status: "APPROVED", authorization_code: "AUTH-LIVE-1" }],
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    assert.equal((await (await panel.fetch(request("/api/payment-options"), env, {})).json()).bendo, true);
    const order = await webOrder(env, {}, "web-bendo-live1");
    const link = await (await startWeb(env, {}, order, "web-pago-live1")).json();
    assert.equal(link.payment_url, "https://checkout.bendo.ec/link-live-1");
    assert.equal(paymentOf(env, order.id, "web-pago-live1").provider_id, "link-live-1");

    // Geopagos envía texto plano: la ruta no exige content-type JSON ni falla por él.
    let response = await panel.fetch(webhook(link.payment_id, await firma(link.payment_id), {
      headers: { "content-type": "text/plain" }, body: "evento=approved",
    }), env, {});
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    const payment = paymentOf(env, order.id, "web-pago-live1");
    assert.equal(payment.status, "paid");
    assert.equal(payment.authorization, "AUTH-LIVE-1");
    assert.equal(comandas(env, order.id), 1);

    // El comprador vuelve al menú con el estado ya conciliado en servidor.
    response = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`), env, {});
    assert.equal(response.status, 302);
    assert.match(response.headers.get("location"),
      new RegExp(`^https://menu\\.munch\\.ec/gracias\\?pago=aprobado&pedido=${order.id}&token=`));

    // Webhook duplicado con el pago ya cobrado: 200 y sin segunda comanda.
    response = await panel.fetch(webhook(link.payment_id, await firma(link.payment_id)), env, {});
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(comandas(env, order.id), 1);
  } finally { fake.restore(); }
});

test("live: un 5xx al verificar deja el pago unknown (nunca rechazo) y el cron lo resuelve", async () => {
  const env = bendoEnv("live", {
    BENDO_CLIENT_ID: "id", BENDO_CLIENT_SECRET: "s",
    BENDO_POINT_OF_SALE: "pos-1", BENDO_ENV: "staging",
  });
  const cookie = await ownerCookie(env);
  const order = await cajaOrder(env, {}, cookie, "caja-bendo-live1");
  let falla = true;
  const fake = conFetch(async href => {
    if (href === TOKEN_STAGING) return Response.json({ access_token: "tk" });
    if (href === `${API_STAGING}/api/v4/payments/links` ) {
      return Response.json({ id: "link-live-2", transaction_data: { checkout_url: "https://checkout.bendo.ec/2" } }, { status: 201 });
    }
    if (href === `${API_STAGING}/api/v4/payments/links/link-live-2`) {
      if (falla) return new Response("falla", { status: 500 });
      return Response.json({
        id: "link-live-2", amount: 8.5, currency: "USD", status: "APPROVED",
        payments: [{ status: "APPROVED", authorization_code: "AUTH-2" }],
      });
    }
    throw new Error(`fetch inesperado: ${href}`);
  });
  try {
    const link = await (await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, {
      idempotency_key: "caja-pago-live1",
    }, { headers: { cookie } }), env, {})).json();

    // El return con Bendo caído: pendiente para el comprador y pago `unknown`.
    let response = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`, jsonAccept), env, {});
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { status: "pendiente", order_id: order.id, order_status: "confirmed" });
    assert.equal(paymentOf(env, order.id, "caja-pago-live1").status, "unknown");
    assert.equal(comandas(env, order.id), 0);

    // Cron: ambos proveedores se concilian en paralelo con ctx.waitUntil.
    falla = false;
    const pending = [];
    panel.scheduled({ cron: "* * * * *" }, env, { waitUntil: promise => pending.push(promise) });
    assert.equal(pending.length, 2, "Payphone y Bendo no se bloquean entre sí");
    await Promise.all(pending);

    assert.equal(paymentOf(env, order.id, "caja-pago-live1").status, "paid");
    assert.equal(orderRow(env, order.id).status, "paid");
    assert.equal(comandas(env, order.id), 1);
  } finally { fake.restore(); }
});

/* ── Cron en mock: ventana de 2 h y sin doble comanda ───────────────────── */

test("cron mock: concilia el pendiente reciente y deja el viejo para revisión", async () => {
  const env = bendoEnv("mock");
  const cookie = await ownerCookie(env);
  const fresh = await cajaOrder(env, {}, cookie, "caja-cron-0001");
  const freshLink = await (await panel.fetch(body(`/panel/api/orders/${fresh.id}/bendo`, {
    idempotency_key: "caja-cron-pago-1",
  }, { headers: { cookie } }), env, {})).json();
  await panel.fetch(request(`/api/bendo/mock?p=${freshLink.payment_id}&resultado=aprobado`), env, {});

  const old = await cajaOrder(env, {}, cookie, "caja-cron-0002");
  const oldLink = await (await panel.fetch(body(`/panel/api/orders/${old.id}/bendo`, {
    idempotency_key: "caja-cron-pago-2",
  }, { headers: { cookie } }), env, {})).json();
  await panel.fetch(request(`/api/bendo/mock?p=${oldLink.payment_id}&resultado=aprobado`), env, {});
  env.DB.raw.prepare("UPDATE pos_payments SET created_at = ? WHERE order_id = ? AND idempotency_key = ?")
    .run(Date.now() - 3 * 60 * 60 * 1000, old.id, "caja-cron-pago-2");

  const pending = [];
  panel.scheduled({}, env, { waitUntil: promise => pending.push(promise) });
  await Promise.all(pending);

  assert.equal(paymentOf(env, fresh.id, "caja-cron-pago-1").status, "paid");
  assert.equal(orderRow(env, fresh.id).status, "paid");
  assert.equal(comandas(env, fresh.id), 1);
  assert.equal(paymentOf(env, old.id, "caja-cron-pago-2").status, "pending");
  assert.equal(orderRow(env, old.id).status, "confirmed");
  assert.equal(comandas(env, old.id), 0);

  // Una segunda pasada no duplica la comanda ya emitida.
  const second = [];
  panel.scheduled({}, env, { waitUntil: promise => second.push(promise) });
  assert.equal(second.length, 2);
  await Promise.all(second);
  assert.equal(comandas(env, fresh.id), 1);
  assert.equal(comandas(env, old.id), 0);
  assert.ok(paymentByRef(env, freshLink.payment_id));
});

/* ── Límites de las rutas ────────────────────────────────────────────────── */

test("rutas bendo: el simulador no existe fuera de mock y el webhook tolera firma vacía", async () => {
  const env = bendoEnv("disabled");
  assert.equal((await panel.fetch(request("/api/bendo/mock?p=AAAAAAAAAAAAAAA"), env, {})).status, 404);
  assert.equal((await panel.fetch(webhook("AAAAAAAAAAAAAAA", ""), env, {})).status, 200);
  // Una ref con formato inválido tampoco entra al flujo.
  assert.equal((await panel.fetch(request("/api/bendo/return?p=corta", jsonAccept), env, {})).status, 422);

  // Pedido web con tarjeta sin Bendo disponible: 503 y sin persistir el pedido.
  const response = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: "web-bendo-nope", payment_method: "bendo",
    items: [{ product_id: "margarita", qty: 1 }],
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
    },
    delivery_mode: "pickup",
  }), env, {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "bendo_no_disponible" });
});
