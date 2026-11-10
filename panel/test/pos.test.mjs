// POS: pedidos web + caja, sede obligatoria, centavos recalculados, idempotencia,
// estados pending/confirmed/paid/rejected y comanda solo al pagar.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie) => request(path, { headers: { cookie } });

const margarita = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };
const grande = { ...margarita, id: "familiar", name: "Familiar", price: "12.00", variants: [{ name: "Tamaño", type: "price_select", options: [{ name: "Grande", price: 15.5 }] }] };
const bebida = { ...margarita, id: "bebida", name: "Cola", price: "2.50" };

function seedCatalog(env, products) {
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products }), Date.now());
}
function posEnv(products = [margarita, grande, bebida]) {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }, { nombre: "Norte", direccion: "Calle 2" }] },
    },
  });
  // El Worker del cliente resuelve el slug por CLIENT_SLUG (infra, ver handoff).
  env.CLIENT_SLUG = "pizza";
  seedCatalog(env, products);
  return env;
}
async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const webOrder = (overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: "11111111-1111-4111-8111-111111111111",
  items: [{ product_id: "margarita", qty: 2, note: "sin cebolla" }, { product_id: "bebida", qty: 1 }],
  customer: { name: "Ana", phone: "0991234567" },
  delivery_mode: "pickup",
  // El navegador puede mentir: el servidor debe ignorarlo.
  total: 1, total_cents: 1,
  ...overrides,
});
const rowOf = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);

test("pedido web: sede obligatoria, precios del catálogo en centavos y token opaco", async () => {
  const env = posEnv();
  let response = await panel.fetch(body("/api/orders", webOrder({ sede_id: undefined })), env, makeCtx());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "sede_requerida" });

  response = await panel.fetch(body("/api/orders", webOrder({ sede_id: "otra" })), env, makeCtx());
  assert.deepEqual(await response.json(), { error: "sede_invalida" });

  response = await panel.fetch(body("/api/orders", webOrder()), env, makeCtx());
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.deepEqual(Object.keys(created).sort(), ["currency", "id", "number", "order_token", "payment_method", "status", "total_cents"]);
  assert.equal(created.status, "pending");
  assert.equal(created.currency, "USD");
  assert.equal(created.total_cents, 2 * 850 + 250, "ignora total del navegador y recalcula");
  assert.ok(created.number >= 1);
  assert.match(created.order_token, /^[a-f0-9]{64}$/);

  const row = rowOf(env, created.id);
  assert.equal(row.sede_id, "centro");
  assert.equal(row.source, "web");
  assert.equal(Number(row.total_cents), 1950);
  const items = JSON.parse(row.items);
  assert.deepEqual(items.map(item => [item.product_id, item.qty, item.unit_cents]), [
    ["margarita", 2, 850], ["bebida", 1, 250],
  ]);

  // Variante: precio de la opción del catálogo, no el que envíe el cliente.
  response = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "22222222-2222-4222-8222-222222222222",
    items: [{ product_id: "familiar", qty: 1, variant_id: "Grande" }],
  })), env, makeCtx());
  const variant = await response.json();
  assert.equal(variant.total_cents, 1550);

  response = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "33333333-3333-4333-8333-333333333333",
    items: [{ product_id: "familiar", qty: 1, variant_id: "Enorme" }],
  })), env, makeCtx());
  assert.deepEqual(await response.json(), { error: "variante_no_existe", product_id: "familiar" });
});

test("catálogo: producto apagado, sin stock o inactivo en sede", async () => {
  const env = posEnv([{ ...margarita, stock: 1 }, { ...margarita, id: "apagado", active: false }]);
  let response = await panel.fetch(body("/api/orders", webOrder({ items: [{ product_id: "margarita", qty: 2 }] })), env, makeCtx());
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "sin_stock", product_id: "margarita" });

  response = await panel.fetch(body("/api/orders", webOrder({ items: [{ product_id: "apagado", qty: 1 }] })), env, makeCtx());
  assert.deepEqual(await response.json(), { error: "producto_no_disponible", product_id: "apagado" });

  env.DB.raw.prepare("UPDATE pos_sedes SET activa = 0 WHERE slug = 'pizza' AND id = 'centro'").run();
  response = await panel.fetch(body("/api/orders", webOrder()), env, makeCtx());
  assert.deepEqual(await response.json(), { error: "sede_invalida" });

  const sedes = await (await panel.fetch(request("/api/sedes"), env, makeCtx())).json();
  assert.deepEqual(sedes.sedes.map(sede => [sede.id, sede.activa]), [["centro", false], ["norte", true]]);
});

test("idempotencia de orden: misma clave mismo resultado, cuerpo distinto 409", async () => {
  const env = posEnv(), ctx = makeCtx();
  const first = await (await panel.fetch(body("/api/orders", webOrder()), env, ctx)).json();
  const retry = await panel.fetch(body("/api/orders", webOrder()), env, ctx);
  assert.equal(retry.status, 201);
  const again = await retry.json();
  assert.deepEqual(again, first);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_orders").get().n, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM order_seq").get().n, 1);

  const changed = await panel.fetch(body("/api/orders", webOrder({ items: [{ product_id: "bebida", qty: 1 }] })), env, ctx);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "idempotencia_conflicto" });
});

test("estado público mínimo: exige token y no filtra PII", async () => {
  const env = posEnv(), ctx = makeCtx();
  const created = await (await panel.fetch(body("/api/orders", webOrder()), env, ctx)).json();
  let response = await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.deepEqual(Object.keys(status).sort(), ["created_at", "currency", "id", "number", "sede_id", "status", "total_cents"]);
  assert.equal(status.status, "pending");
  assert.equal(status.total_cents, 1950);

  response = await panel.fetch(request(`/api/orders/${created.id}`), env, ctx);
  assert.equal(response.status, 404);
  response = await panel.fetch(request(`/api/orders/${created.id}?token=malo`), env, ctx);
  assert.equal(response.status, 404);
  response = await panel.fetch(request(`/api/orders/${created.id}?token=${"a".repeat(64)}`), env, ctx);
  assert.equal(response.status, 404);
});

test("flujo caja sin LOYALTY: PIN local, pending, confirmar y cobrar en efectivo emite una comanda", async () => {
  const env = posEnv(), ctx = makeCtx();
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  let response = await panel.fetch(body("/panel/api/loyalty/staff", { name: "Ana", pin: "1234", sedes: ["centro"] }, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 201);
  const staff = await response.json();
  assert.match(staff.id, /^l_[a-z0-9]{10}$/);
  assert.deepEqual(staff.sedes, ["centro"]);
  assert.ok(!JSON.stringify(staff).includes("pin"));

  response = await panel.fetch(body("/panel/api/mesero/login", { pin: "9999" }), env, ctx);
  assert.deepEqual(await response.json(), { error: "pin_invalido" });
  response = await panel.fetch(body("/panel/api/mesero/login", { pin: "1234" }), env, ctx);
  assert.equal(response.status, 200);
  const login = await response.json();
  assert.equal(login.staff.id, staff.id);
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];

  const me = await (await panel.fetch(withCookie("/panel/api/mesero/me", cookie), env, ctx)).json();
  assert.deepEqual(me.sedes, [{ id: "centro", nombre: "Centro" }], "el mesero solo ve su sede");

  response = await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro",
    idempotency_key: "caja-0001-abcd",
    items: [{ product_id: "margarita", qty: 1 }, { product_id: "bebida", qty: 2 }],
    table_no: "7",
    note: "Para compartir",
  }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.status, "pending");
  assert.equal(created.total_cents, 850 + 500);
  assert.equal(rowOf(env, created.id).source, "caja");
  assert.equal(rowOf(env, created.id).staff_id, staff.id);

  // La cocina no ve nada hasta que esté pagado.
  let kitchen = await (await panel.fetch(request("/panel/api/kitchen/orders?sede_id=centro", { headers: { cookie } }), env, ctx)).json();
  assert.deepEqual(kitchen.orders, []);
  response = await panel.fetch(body("/panel/api/kitchen/orders/" + created.id + "/print", { idempotency_key: "print-0001" }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 409, "no se imprime una comanda sin pagar");

  response = await panel.fetch(body(`/panel/api/orders/${created.id}/confirm`, {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.status, "confirmed");
  kitchen = await (await panel.fetch(request("/panel/api/kitchen/orders?sede_id=centro", { headers: { cookie } }), env, ctx)).json();
  assert.deepEqual(kitchen.orders, [], "confirmar no libera comanda");

  response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-0001" }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  const paid = await response.json();
  assert.equal(paid.order.status, "paid");
  assert.equal(paid.payment.provider, "cash");
  assert.ok(Number(paid.order.paid_at) > 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(created.id).n, 1);

  kitchen = await (await panel.fetch(request("/panel/api/kitchen/orders?sede_id=centro&since=0", { headers: { cookie } }), env, ctx)).json();
  assert.equal(kitchen.orders.length, 1);
  assert.equal(kitchen.orders[0].id, created.id);
  assert.equal(kitchen.orders[0].status, "paid");
  assert.ok(kitchen.next >= kitchen.orders[0].comanda_at);

  // Reintento con la misma clave: no duplica pago ni comanda.
  response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-0001" }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(created.id).n, 1);
  // Otra clave sobre una orden ya pagada es conflicto.
  response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-0002" }, { headers: { cookie } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "orden_ya_pagada" });

  // Impresión idempotente por clave y reimpresión explícita con otra clave.
  response = await panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, { idempotency_key: "print-0002" }, { headers: { cookie } }), env, ctx);
  assert.equal((await response.json()).print_count, 1);
  response = await panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, { idempotency_key: "print-0002" }, { headers: { cookie } }), env, ctx);
  assert.equal((await response.json()).print_count, 1);
  response = await panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, { idempotency_key: "print-0003" }, { headers: { cookie } }), env, ctx);
  assert.equal((await response.json()).print_count, 2);
});

test("autorización por sede: el mesero local no opera otra sede", async () => {
  const env = posEnv(), ctx = makeCtx();
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  await panel.fetch(body("/panel/api/loyalty/staff", { name: "Ana", pin: "1234", sedes: ["centro"] }, { headers: { cookie: owner } }), env, ctx);
  const login = await panel.fetch(body("/panel/api/mesero/login", { pin: "1234" }), env, ctx);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];

  let response = await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "norte", idempotency_key: "caja-0002-abcd", items: [{ product_id: "margarita", qty: 1 }],
  }, { headers: { cookie } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });

  const north = await (await panel.fetch(body("/api/orders", webOrder({ sede_id: "norte", idempotency_key: "norte-0001-abcd" })), env, ctx)).json();
  response = await panel.fetch(body(`/panel/api/orders/${north.id}/confirm`, {}, { headers: { cookie } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });
  response = await panel.fetch(body(`/panel/api/orders/${north.id}/pay-cash`, { idempotency_key: "cash-norte" }, { headers: { cookie } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });

  // El dueño sí puede.
  response = await panel.fetch(body(`/panel/api/orders/${north.id}/confirm`, {}, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 200);
});

test("rechazo: deja la orden rechazada, sin comanda; no se puede cobrar", async () => {
  const env = posEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", webOrder()), env, ctx)).json();
  let response = await panel.fetch(body(`/panel/api/orders/${created.id}/reject`, {}, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.status, "rejected");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas").get().n, 0);

  response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-r1-abcd" }, { headers: { cookie: owner } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "estado_invalido" });
  assert.equal((await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx).then(r => r.json())).status, "rejected");
});

test("pedido pendiente editable por caja: recalcula y no toca los pagados", async () => {
  const env = posEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", webOrder()), env, ctx)).json();
  let response = await panel.fetch(request(`/panel/api/pos/orders?status=pending`, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).orders[0].id, created.id);

  response = await panel.fetch(body(`/panel/api/mesero/orders/${created.id}`, {
    items: [{ product_id: "bebida", qty: 3 }], note: "Sin hielo",
  }, { method: "PUT", headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 200);
  const edited = (await response.json()).order;
  assert.equal(edited.total_cents, 750);
  assert.equal(edited.note, "Sin hielo");

  await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-edit" }, { headers: { cookie: owner } }), env, ctx);
  response = await panel.fetch(body(`/panel/api/mesero/orders/${created.id}`, {
    items: [{ product_id: "bebida", qty: 1 }],
  }, { method: "PUT", headers: { cookie: owner } }), env, ctx);
  assert.deepEqual(await response.json(), { error: "estado_invalido" });
});

test("Munch: retiro obligatorio y método de pago persistido", async () => {
  const env = posEnv(), ctx = makeCtx();
  const delivery = await panel.fetch(body("/api/orders", webOrder({ delivery_mode: "delivery", address: "Calle 9" })), env, ctx);
  assert.equal(delivery.status, 400);
  assert.equal((await delivery.json()).error, "solo_retiro");
  const transfer = await panel.fetch(body("/api/orders", webOrder({ payment_method: "transfer" })), env, ctx);
  assert.equal(transfer.status, 201);
  const created = await transfer.json();
  assert.equal(created.payment_method, "transfer");
  assert.equal(rowOf(env, created.id).payment_method, "transfer");
  const card = await panel.fetch(body("/api/orders", webOrder({ payment_method: "payphone", idempotency_key: "card-11111111" })), env, ctx);
  assert.equal(card.status, 503);
  assert.equal((await card.json()).error, "payphone_no_disponible");
});
