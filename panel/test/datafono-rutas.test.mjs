// Datáfono manual de punta a punta por el handler del Worker (`panel.fetch`):
// el cajero entra con su PIN, abre el turno, cobra con datáfono y cierra la caja
// con la línea `datafono` fuera del efectivo esperado. También cubre la caja
// cerrada, el link de Bendo en curso y que la API pública del comprador nunca
// reciba el número de autorización del voucher. Sin red: Bendo va en mock y el
// resto es D1/KV en memoria de `panel/test/helpers.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { hashPassword, sha256hex } from "../src/auth.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.example";
const origin = `https://${host}`;
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie, options = {}) => request(path, {
  ...options, headers: { accept: "application/json", cookie, ...(options.headers || {}) },
});

const margarita = {
  id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "",
  stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
};
const bebida = { ...margarita, id: "bebida", name: "Cola", price: "2.50" };

/* ── Entorno, sesiones y utilidades ──────────────────────────────────────── */

function datafonoEnv() {
  const env = makeEnv({
    "munch:config": {
      currency: "USD", store_name: "Munch",
      location: {
        sedes: [
          { id: "centro", nombre: "Centro", direccion: "Calle 1" },
          { id: "norte", nombre: "Norte", direccion: "Calle 2" },
        ],
      },
    },
  });
  env.CLIENT_SLUG = "munch";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita, bebida] }), Date.now());
  return env;
}

// Cajero local con PIN real en D1: la sesión nace de /panel/api/mesero/login,
// exactamente la cookie `caja_s` que resuelve handlePosApi.
async function cashierCookie(env, { id = "l_cajero0001", sedes = ["centro"], pin = "2468" } = {}) {
  const now = Date.now();
  env.DB.raw.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('munch', ?, 'Ana', ?, ?, ?, 1, ?, ?)",
  ).run(id, await sha256hex(`munch:${pin}`), await hashPassword(pin), JSON.stringify(sedes), now, now);
  const login = await panel.fetch(body("/panel/api/mesero/login", { pin }), env, {});
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

async function openShift(env, cookie, { sede = "centro", fondo = 2000, key = "turno-abrir-datafono" } = {}) {
  const response = await panel.fetch(body("/panel/api/turnos/abrir", {
    sede_id: sede, opening_float_cents: fondo, idempotency_key: key,
  }, { headers: { cookie } }), env, {});
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text).shift.id;
}

async function webOrder(env, key, overrides = {}) {
  const response = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: key,
    items: [{ product_id: "margarita", qty: 2 }],
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
    },
    delivery_mode: "pickup",
    ...overrides,
  }), env, {});
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

async function cajaOrder(env, cookie, key, overrides = {}) {
  const response = await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro", idempotency_key: key,
    items: [{ product_id: "margarita", qty: 1 }],
    ...overrides,
  }, { headers: { cookie } }), env, {});
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const order = JSON.parse(text);
  const confirmed = await panel.fetch(body(`/panel/api/orders/${order.id}/confirm`, {}, { headers: { cookie } }), env, {});
  assert.equal(confirmed.status, 200);
  return order;
}

const pay = (env, cookie, id, payload, route = "pay-datafono") =>
  panel.fetch(body(`/panel/api/orders/${id}/${route}`, payload, { headers: { cookie } }), env, {});

const payDatafono = (env, cookie, id, key, authorization, cardLast4) =>
  pay(env, cookie, id, {
    idempotency_key: key, authorization_code: authorization, ...(cardLast4 ? { card_last4: cardLast4 } : {}),
  });

const posOrders = async (env, cookie) =>
  (await (await panel.fetch(withCookie("/panel/api/pos/orders?status=all", cookie), env, {})).json()).orders;

const closeShift = (env, cookie, shiftId, counted, key = "turno-cerrar-datafono") =>
  panel.fetch(body(`/panel/api/turnos/${shiftId}/cerrar`, {
    counted_cash_cents: counted, idempotency_key: key,
  }, { headers: { cookie } }), env, {});

const orderRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const paymentRows = (env, orderId) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? ORDER BY rowid",
).all(orderId);
const comandas = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?",
).get(orderId).n;

/* ── Extremo a extremo: PIN, turno, cobro con datáfono y cierre ──────────── */

test("de punta a punta: cajero por PIN abre turno, cobra con datáfono y cierra con línea datafono", async () => {
  const env = datafonoEnv();
  const cashier = await cashierCookie(env);
  const shiftId = await openShift(env, cashier, { fondo: 2000 });

  // Pedido web (sin método elegido) cobrado en el datáfono de la sede.
  const card = await webOrder(env, "orden-e2e-datafono");
  assert.equal(card.total_cents, 1700);
  let response = await payDatafono(env, cashier, card.id, "cobro-e2e-datafono", "A7K2", "4242");
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const paid = JSON.parse(text);
  assert.equal(paid.order.status, "paid");
  assert.equal(paid.order.payment_method, "bendo", "el método real del cobro es Bendo");
  assert.equal(paid.order.payment_channel, "datafono");
  assert.equal(paid.order.payment_authorization, "A7K2");
  assert.equal(paid.payment.amount_cents, 1700);
  assert.equal(paymentRows(env, card.id)[0].shift_id, shiftId);
  assert.equal(comandas(env, card.id), 1);

  // Un cobro en efectivo del mismo turno, para que el arqueo no sea trivial.
  const cash = await webOrder(env, "orden-e2e-cash", { items: [{ product_id: "bebida", qty: 1 }] });
  response = await pay(env, cashier, cash.id, { idempotency_key: "cobro-e2e-cash" }, "pay-cash");
  assert.equal(response.status, 200);

  // El listado POS (solo panel/caja) trae lo necesario para "Pago: datáfono · aut. XXXX".
  const listed = await posOrders(env, cashier);
  const listedCard = listed.find(order => order.id === card.id);
  assert.equal(listedCard.payment_method, "bendo");
  assert.equal(listedCard.payment_channel, "datafono");
  assert.equal(listedCard.payment_authorization, "A7K2");
  const listedCash = listed.find(order => order.id === cash.id);
  assert.equal("payment_channel" in listedCash, false, "el efectivo no inventa canal");
  assert.equal("payment_authorization" in listedCash, false);

  // Cierre ciego: el cajero solo envía lo contado; el servidor calcula.
  response = await closeShift(env, cashier, shiftId, 2000 + 250);
  const closedText = await response.text();
  assert.equal(response.status, 200, closedText);
  const report = JSON.parse(closedText).report;
  assert.deepEqual(report.sales, [
    { method: "cash", count: 1, total_cents: 250 },
    { method: "datafono", count: 1, total_cents: 1700 },
  ]);
  assert.equal(report.sales_total_cents, 1950);
  // El datáfono no suma al efectivo esperado: fondo 2000 + solo el cobro en efectivo.
  assert.equal(report.expected_cash_cents, 2250);
  assert.equal(report.counted_cash_cents, 2250);
  assert.equal(report.difference_cents, 0);
  assert.deepEqual(report.pending_payments, { count: 0, total_cents: 0 });
});

/* ── Caja cerrada y link en curso ────────────────────────────────────────── */

test("sin turno el cobro con datáfono responde 409 caja_cerrada", async () => {
  const env = datafonoEnv();
  const cashier = await cashierCookie(env);
  const order = await webOrder(env, "orden-datafono-sin-turno");

  const response = await payDatafono(env, cashier, order.id, "cobro-datafono-sin-turno", "A7K2");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(paymentRows(env, order.id).length, 0, "no se guarda intento");
  assert.equal(comandas(env, order.id), 0);
  assert.equal(orderRow(env, order.id).status, "pending");
});

test("un link de Bendo pendiente bloquea el datáfono con 409 pago_en_curso", async () => {
  const env = datafonoEnv();
  env.BENDO_MODE = "mock";
  const cashier = await cashierCookie(env);
  await openShift(env, cashier);

  const order = await cajaOrder(env, cashier, "orden-datafono-link", { payment_method: "bendo" });
  const started = await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, {
    idempotency_key: "link-datafono-e2e",
  }, { headers: { cookie: cashier } }), env, {});
  const startedText = await started.text();
  assert.equal(started.status, 200, startedText);
  const link = JSON.parse(startedText);
  assert.match(link.payment_url, /^https:\/\/munch\.example\/api\/bendo\/mock\?p=/);

  const response = await payDatafono(env, cashier, order.id, "cobro-datafono-link", "A7K2");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "pago_en_curso" });
  assert.equal(orderRow(env, order.id).status, "confirmed", "el pedido no se cobra");
  assert.equal(paymentRows(env, order.id).length, 1, "solo el intento del link");
  assert.equal(paymentRows(env, order.id)[0].channel, "link");
  assert.equal(comandas(env, order.id), 0);
});

/* ── La API pública nunca expone la autorización del voucher ─────────────── */

test("GET /api/orders/:id del comprador no expone la autorización ni el canal", async () => {
  const env = datafonoEnv();
  const cashier = await cashierCookie(env);
  await openShift(env, cashier);

  const order = await webOrder(env, "orden-publica-datafono");
  const paid = await payDatafono(env, cashier, order.id, "cobro-publica-datafono", "Z9Y8");
  assert.equal(paid.status, 200);

  // Con el token correcto el comprador ve su pedido pagado, sin datos del voucher.
  const response = await panel.fetch(request(`/api/orders/${order.id}?token=${order.order_token}`), env, {});
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const publicOrder = JSON.parse(text);
  assert.equal(publicOrder.status, "paid");
  assert.equal(publicOrder.payment_method, "bendo");
  assert.equal(publicOrder.payment_status, "paid");
  for (const hidden of ["authorization", "payment_authorization", "payment_channel", "channel"]) {
    assert.equal(hidden in publicOrder, false, `la API pública no debe exponer ${hidden}`);
  }
  assert.equal(text.includes("Z9Y8"), false, "la autorización del voucher no viaja al comprador");

  // El panel sí la recibe: es un dato interno de caja.
  const listed = await posOrders(env, cashier);
  assert.equal(listed.find(item => item.id === order.id).payment_authorization, "Z9Y8");

  // Sin token el pedido del comprador sigue siendo invisible.
  const denied = await panel.fetch(request(`/api/orders/${order.id}`), env, {});
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), { error: "pedido_no_existe" });
});
