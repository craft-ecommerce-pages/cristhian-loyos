// QA final (Claude): regresiones de Bendo + cierre de caja encontradas en la
// revisión de las ramas de los picadores. Sin red: Bendo en mock o fetch simulado.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { setPaymentPending } from "../src/orders.js";
import { makeEnv } from "./helpers.mjs";

const origin = "https://munch.example";
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const body = (path, value, headers = {}) => request(path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value),
});
const product = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

function env() {
  const e = makeEnv({
    "munch:config": { currency: "USD", store_name: "Munch", location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] } },
  });
  e.CLIENT_SLUG = "munch";
  e.BENDO_MODE = "mock";
  e.MENU_PUBLIC_URL = "https://menu.munch.example";
  e.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return e;
}

async function ownerCookie(e) {
  const owner = await panel.fetch(body("/admin/munch/owner", { email: "dueno@munch.ec" }, { authorization: "Bearer admin-token" }), e, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), e, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

async function webOrder(e, key, method) {
  const r = await panel.fetch(body("/api/orders", {
    sede_id: "centro", idempotency_key: key, items: [{ product_id: "margarita", qty: 1 }], delivery_mode: "pickup", payment_method: method,
    customer: { name: "Ana", phone: "0991234567", billing: { document_type: "cedula", document_number: "1712345678", email: "a@b.ec", address: "Av 1" } },
  }), e, {});
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}

const legacyPayment = (e, orderId, provider, cents) => e.DB.raw.prepare(
  "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, created_at, updated_at, paid_at) " +
  "VALUES (?, 'munch', ?, ?, ?, 'paid', ?, 'USD', 1, 1, 1)",
).run(crypto.randomUUID(), orderId, provider, `legacy-${crypto.randomUUID()}`, cents);

test("abrir el primer turno no absorbe pagos históricos (anteriores a 0012); sí la tarjeta pendiente de turno", async () => {
  const e = env();
  const cookie = await ownerCookie(e);
  const historic = await webOrder(e, "historico-00001", "cash");
  legacyPayment(e, historic.id, "cash", 125000);      // efectivo de antes de los turnos
  legacyPayment(e, historic.id, "payphone", 4000);    // tarjeta archivada
  legacyPayment(e, historic.id, "bendo", 850);        // tarjeta conciliada con caja cerrada

  const opened = await panel.fetch(body("/panel/api/turnos/abrir", {
    sede_id: "centro", opening_float_cents: 2000, idempotency_key: "abrir-centro-01",
  }, { cookie }), e, {});
  assert.equal(opened.status, 201);
  const shiftId = (await opened.json()).shift.id;
  const assigned = e.DB.raw.prepare("SELECT provider FROM pos_payments WHERE shift_id = ? ORDER BY provider").all(shiftId);
  assert.deepEqual(assigned.map(row => row.provider), ["bendo"]);
  const current = await (await panel.fetch(request("/panel/api/turnos/actual?sede_id=centro", { headers: { cookie } }), e, {})).json();
  assert.equal(current.report.expected_cash_cents, 2000, "el esperado no incluye el efectivo histórico");
});

test("reintento con la misma clave tras un fallo deja el pago vigilado (pending con url)", async () => {
  const e = env();
  const order = await webOrder(e, "pedido-falla-001", "bendo");
  const id = crypto.randomUUID();
  e.DB.raw.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, provider_ref, message, created_at, updated_at) " +
    "VALUES (?, 'munch', ?, 'bendo', 'web-key-0001', 'failed', 850, 'USD', 'ABCDEFGHJKLMNPQ', 'link_fallido', 1, 1)",
  ).run(id, order.id);
  await setPaymentPending(e, "munch", id, "https://checkout.example/1");
  const row = e.DB.raw.prepare("SELECT status, url, message FROM pos_payments WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { status: "pending", url: "https://checkout.example/1", message: null });
});

test("cobro de caja con tarjeta: el pedido queda como bendo y el QR devuelve al recibo, no al panel", async () => {
  const e = env();
  const cookie = await ownerCookie(e);
  const order = await webOrder(e, "pedido-caja-0001", "cash");
  e.DB.raw.prepare("UPDATE pos_orders SET source = 'caja', status = 'confirmed' WHERE id = ?").run(order.id);
  const start = await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, { idempotency_key: "caja-bendo-0001" }, { cookie }), e, {});
  assert.equal(start.status, 200, await start.clone().text());
  const { payment_id: ref } = await start.json();
  await panel.fetch(request(`/api/bendo/mock?p=${ref}&resultado=aprobado`), e, {});
  const back = await panel.fetch(request(`/api/bendo/return?p=${ref}`), e, {});
  assert.equal(back.status, 302);
  assert.match(back.headers.get("location"), /^https:\/\/menu\.munch\.example\/gracias\?pago=aprobado&pedido=/);
  const row = e.DB.raw.prepare("SELECT status, payment_method FROM pos_orders WHERE id = ?").get(order.id);
  assert.deepEqual({ ...row }, { status: "paid", payment_method: "bendo" });
});

test("webhook sin SESSION_SECRET responde 200 sin trabajo (no provoca reintentos infinitos)", async () => {
  const e = env();
  delete e.SESSION_SECRET;
  const r = await panel.fetch(request(`/api/bendo/webhook?p=ABCDEFGHJKLMNPQ&s=${"a".repeat(32)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  }), e, {});
  assert.equal(r.status, 200);
});
