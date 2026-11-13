// Datáfono (parte G · backend): cobro manual con el POS de Bendo registrado por
// la caja. Mismo batch que efectivo/transferencia (turno abierto, una comanda,
// snapshot de líneas y shift_id), pero el pago queda `bendo` con canal `datafono`
// y el pedido pasa a `bendo`. Sin red real: BENDO_MODE=mock para los links.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import panel from "../src/index.js";
import { makeEnv } from "./helpers.mjs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const migrationSql = file => readFileSync(new URL(file, MIGRATIONS), "utf8");
const migrationFiles = () => readdirSync(MIGRATIONS).filter(file => file.endsWith(".sql")).sort();

const host = "munch.example";
const origin = `https://${host}`;
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
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

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/munch/owner", { email: "dueno@munch.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

// Cajero local (PIN en D1) con sus sedes: la misma sesión que resuelve handlePosApi.
async function localCashier(env, { pin = "4321", sedes = ["centro"], name = "Ana" } = {}) {
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  const created = await panel.fetch(body("/panel/api/loyalty/staff", { name, pin, sedes }, { headers: { cookie: owner } }), env, {});
  assert.equal(created.status, 201);
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

async function closeShift(env, cookie, shiftId) {
  const response = await panel.fetch(body(`/panel/api/turnos/${shiftId}/cerrar`, {
    counted_cash_cents: 0, idempotency_key: "turno-cerrar-datafono",
  }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  return response.json();
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

const pay = (env, cookie, id, payload, route = "pay-datafono", headers = {}) =>
  panel.fetch(body(`/panel/api/orders/${id}/${route}`, payload, { headers: { ...(cookie ? { cookie } : {}), ...headers } }), env, {});

const orderRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const paymentRows = (env, orderId) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? ORDER BY rowid",
).all(orderId);
const paymentOf = (env, orderId, key) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? AND idempotency_key = ?",
).get(orderId, key);
const comandas = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?",
).get(orderId).n;
const lines = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_order_lines WHERE order_id = ?",
).get(orderId).n;

/* ── Pago correcto: comanda única, turno, método real, autorización y ****1234 ── */

test("pago con datáfono: una comanda, shift_id, método bendo, autorización y ****1234", async () => {
  const env = datafonoEnv();
  const owner = await ownerCookie(env);
  const shiftId = await openShift(env, owner);
  const order = await webOrder(env, "orden-datafono-0001");
  assert.equal(order.total_cents, 1700);

  let response = await pay(env, owner, order.id, {
    idempotency_key: "cobro-datafono-0001", authorization_code: "AUTH1234", card_last4: "1234",
  });
  assert.equal(response.status, 200);
  const paid = await response.json();
  assert.equal(paid.order.status, "paid");
  assert.equal(paid.order.payment_method, "bendo", "el método real del cobro es Bendo");
  assert.deepEqual(paid.payment.provider, "bendo");
  assert.equal(paid.payment.status, "paid");
  assert.equal(paid.payment.amount_cents, 1700);

  const row = orderRow(env, order.id);
  assert.equal(row.status, "paid");
  assert.equal(row.payment_method, "bendo");
  assert.ok(Number(row.paid_at) > 0);

  const payments = paymentRows(env, order.id);
  assert.equal(payments.length, 1, "un solo intento de pago");
  const payment = payments[0];
  assert.equal(payment.provider, "bendo");
  assert.equal(payment.channel, "datafono");
  assert.equal(payment.status, "paid");
  assert.equal(payment.authorization, "AUTH1234");
  assert.equal(payment.message, "tarjeta ****1234");
  assert.equal(payment.shift_id, shiftId, "queda asignado al turno abierto");
  assert.equal(Number(payment.amount_cents), 1700);
  assert.equal(payment.provider_ref, null, "el datáfono no crea link ni referencia externa");

  assert.equal(comandas(env, order.id), 1, "la comanda nace una sola vez");
  assert.equal(lines(env, order.id), 1, "se escribe el snapshot de líneas");
  const line = env.DB.raw.prepare("SELECT * FROM pos_order_lines WHERE order_id = ?").get(order.id);
  assert.equal(line.report_category, "tradicional");
  assert.equal(Number(line.line_total_cents), 1700);

  // Reintento con la misma clave: misma respuesta, sin duplicar nada.
  response = await pay(env, owner, order.id, {
    idempotency_key: "cobro-datafono-0001", authorization_code: "AUTH1234", card_last4: "1234",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), paid);
  assert.equal(paymentRows(env, order.id).length, 1);
  assert.equal(comandas(env, order.id), 1);

  // Otra clave sobre el pedido ya pagado: conflicto explícito.
  response = await pay(env, owner, order.id, { idempotency_key: "cobro-datafono-0002", authorization_code: "OTRA1234" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "orden_ya_pagada" });
});

/* ── Validaciones de autorización y últimos 4 ────────────────────────────── */

test("validaciones: autorización 4–12 alfanumérica y últimos 4 dígitos", async () => {
  const env = datafonoEnv();
  const owner = await ownerCookie(env);
  await openShift(env, owner);
  const order = await webOrder(env, "orden-datafono-mala");

  const invalidAuth = [
    {},
    { authorization_code: "ABC" },
    { authorization_code: "A".repeat(13) },
    { authorization_code: "AUTH-1234" },
    { authorization_code: "AUTH 1234" },
    { authorization_code: "AUT_1234" },
    { authorization_code: 12345678 },
  ];
  for (const payload of invalidAuth) {
    const response = await pay(env, owner, order.id, { idempotency_key: "cobro-auth-mala", ...payload });
    assert.equal(response.status, 400, JSON.stringify(payload));
    assert.deepEqual(await response.json(), { error: "autorizacion_invalida" });
  }

  const invalidCard = ["123", "12345", "12a4", 1234, " 1234"];
  for (const card of invalidCard) {
    const response = await pay(env, owner, order.id, {
      idempotency_key: "cobro-tarjeta-mala", authorization_code: "AUTH1234", card_last4: card,
    });
    assert.equal(response.status, 400, JSON.stringify(card));
    assert.deepEqual(await response.json(), { error: "tarjeta_invalida" });
  }

  // Sin clave idempotente tampoco pasa; nada de esto dejó rastro.
  const noKey = await pay(env, owner, order.id, { authorization_code: "AUTH1234" });
  assert.equal(noKey.status, 400);
  assert.deepEqual(await noKey.json(), { error: "idempotency_key_requerida" });
  assert.equal(paymentRows(env, order.id).length, 0);
  assert.equal(comandas(env, order.id), 0);
  assert.equal(orderRow(env, order.id).status, "pending");

  // Los últimos 4 son opcionales: sin ellos el mensaje queda vacío.
  const ok = await pay(env, owner, order.id, { idempotency_key: "cobro-datafono-sin4", authorization_code: "A1B2C3" });
  assert.equal(ok.status, 200);
  const payment = paymentOf(env, order.id, "cobro-datafono-sin4");
  assert.equal(payment.authorization, "A1B2C3");
  assert.equal(payment.message, null);
});

/* ── Caja cerrada: no hay cobro manual sin turno ─────────────────────────── */

test("caja cerrada: 409 sin turno, cobra con turno y vuelve a 409 tras cerrar", async () => {
  const env = datafonoEnv();
  const owner = await ownerCookie(env);
  const first = await webOrder(env, "orden-datafono-sin-turno");

  let response = await pay(env, owner, first.id, { idempotency_key: "cobro-datafono-cerrada", authorization_code: "AUTH0001" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(paymentRows(env, first.id).length, 0);
  assert.equal(comandas(env, first.id), 0);
  assert.equal(orderRow(env, first.id).status, "pending");

  const shiftId = await openShift(env, owner);
  response = await pay(env, owner, first.id, { idempotency_key: "cobro-datafono-cerrada", authorization_code: "AUTH0001" });
  assert.equal(response.status, 200);
  assert.equal(paymentOf(env, first.id, "cobro-datafono-cerrada").shift_id, shiftId);

  await closeShift(env, owner, shiftId);
  const second = await webOrder(env, "orden-datafono-otra-vez");
  response = await pay(env, owner, second.id, { idempotency_key: "cobro-datafono-cerrada-2", authorization_code: "AUTH0002" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(orderRow(env, second.id).status, "pending");
});

/* ── Sin doble cobro: link pendiente o desconocido bloquea el datáfono ───── */

test("pago_en_curso: un link pendiente o unknown bloquea el datáfono", async () => {
  const env = datafonoEnv();
  env.BENDO_MODE = "mock";
  const owner = await ownerCookie(env);
  await openShift(env, owner);
  const order = await cajaOrder(env, owner, "orden-datafono-link", { payment_method: "bendo" });

  const started = await panel.fetch(body(`/panel/api/orders/${order.id}/bendo`, {
    idempotency_key: "link-datafono-0001",
  }, { headers: { cookie: owner } }), env, {});
  const text = await started.text();
  assert.equal(started.status, 200, text);
  const link = JSON.parse(text);
  assert.equal(paymentOf(env, order.id, "link-datafono-0001").channel, "link");

  for (const status of ["pending", "unknown"]) {
    env.DB.raw.prepare("UPDATE pos_payments SET status = ? WHERE order_id = ? AND idempotency_key = ?")
      .run(status, order.id, "link-datafono-0001");
    const response = await pay(env, owner, order.id, {
      idempotency_key: `cobro-datafono-${status}`, authorization_code: "AUTH7777",
    });
    assert.equal(response.status, 409, status);
    assert.deepEqual(await response.json(), { error: "pago_en_curso" });
    assert.equal(paymentOf(env, order.id, `cobro-datafono-${status}`), undefined);
    assert.equal(orderRow(env, order.id).status, "confirmed");
  }

  // Filas Bendo previas a 0013 (sin canal) también cuentan como link en curso.
  env.DB.raw.prepare("UPDATE pos_payments SET channel = NULL, status = 'unknown' WHERE order_id = ? AND idempotency_key = ?")
    .run(order.id, "link-datafono-0001");
  let response = await pay(env, owner, order.id, { idempotency_key: "cobro-datafono-sin-canal", authorization_code: "AUTH7777" });
  assert.deepEqual(await response.json(), { error: "pago_en_curso" });

  // Resuelto el link (rechazado), el datáfono sí cobra: una sola comanda.
  env.DB.raw.prepare("UPDATE pos_payments SET status = 'rejected' WHERE order_id = ? AND idempotency_key = ?")
    .run(order.id, "link-datafono-0001");
  response = await pay(env, owner, order.id, { idempotency_key: "cobro-datafono-0003", authorization_code: "AUTH7777" });
  assert.equal(response.status, 200);
  assert.equal(orderRow(env, order.id).payment_method, "bendo");
  assert.equal(paymentOf(env, order.id, "cobro-datafono-0003").channel, "datafono");
  assert.equal(comandas(env, order.id), 1);
  assert.equal(paymentOf(env, order.id, "link-datafono-0001").status, "rejected");
  assert.equal(link.order_id, order.id);
});

/* ── Idempotencia y conflicto entre proveedores/canales ──────────────────── */

test("idempotencia: misma clave misma respuesta; otra clave o canal, conflicto", async () => {
  const env = datafonoEnv();
  env.BENDO_MODE = "mock";
  const owner = await ownerCookie(env);
  await openShift(env, owner);

  // Datáfono: repetir la clave no duplica pago ni comanda.
  const card = await webOrder(env, "orden-datafono-idem");
  const payload = { idempotency_key: "cobro-datafono-idem", authorization_code: "IDEM1234" };
  const first = await pay(env, owner, card.id, payload);
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const again = await pay(env, owner, card.id, payload);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), firstBody);
  assert.equal(paymentRows(env, card.id).length, 1);
  assert.equal(comandas(env, card.id), 1);

  // Misma clave usada por efectivo en el mismo pedido: conflicto de canal.
  const cash = await webOrder(env, "orden-datafono-idem-cash");
  assert.equal((await pay(env, owner, cash.id, { idempotency_key: "cobro-cash-idem" }, "pay-cash")).status, 200);
  let response = await pay(env, owner, cash.id, { idempotency_key: "cobro-cash-idem", authorization_code: "IDEM1234" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "idempotencia_conflicto" });

  // La misma clave de un link de Bendo (canal `link`) tampoco se reutiliza.
  const linkOrder = await cajaOrder(env, owner, "orden-datafono-idem-link", { payment_method: "bendo" });
  assert.equal((await panel.fetch(body(`/panel/api/orders/${linkOrder.id}/bendo`, {
    idempotency_key: "link-idem-0001",
  }, { headers: { cookie: owner } }), env, {})).status, 200);
  response = await pay(env, owner, linkOrder.id, { idempotency_key: "link-idem-0001", authorization_code: "IDEM1234" });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "idempotencia_conflicto" });
  // El conflicto no cobró ni creó comanda para ese pedido.
  assert.equal(orderRow(env, linkOrder.id).status, "confirmed");
  assert.equal(comandas(env, linkOrder.id), 0);
});

/* ── Permisos por sede y sesión ──────────────────────────────────────────── */

test("permisos: cajero solo sus sedes; el dueño cobra en cualquier sede", async () => {
  const env = datafonoEnv();
  const cashier = await localCashier(env, { sedes: ["centro"] });
  const owner = await ownerCookie(env);
  await openShift(env, owner, { sede: "norte", key: "turno-norte-datafono" });
  await openShift(env, owner, { sede: "centro", key: "turno-centro-datafono" });

  const north = await webOrder(env, "orden-datafono-norte", { sede_id: "norte" });
  let response = await pay(env, cashier, north.id, { idempotency_key: "cobro-datafono-norte", authorization_code: "AUTHN001" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });
  assert.equal(paymentRows(env, north.id).length, 0);

  // Sin sesión tampoco; el dueño sí puede cobrar la sede ajena.
  response = await pay(env, null, north.id, { idempotency_key: "cobro-datafono-norte", authorization_code: "AUTHN001" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "sin_sesion" });
  response = await pay(env, owner, north.id, { idempotency_key: "cobro-datafono-norte", authorization_code: "AUTHN001" });
  assert.equal(response.status, 200);

  // El cajero sí cobra en la sede que tiene autorizada.
  const centro = await webOrder(env, "orden-datafono-centro");
  response = await pay(env, cashier, centro.id, { idempotency_key: "cobro-datafono-centro", authorization_code: "AUTHC001" });
  assert.equal(response.status, 200);
  assert.equal(paymentOf(env, centro.id, "cobro-datafono-centro").channel, "datafono");
});

/* ── Reporte del turno: `datafono` separado de `bendo`, sin sumar efectivo ─ */

test("reporte del turno: línea datafono separada de bendo y fuera del efectivo esperado", async () => {
  const env = datafonoEnv();
  env.BENDO_MODE = "mock";
  const owner = await ownerCookie(env);
  const shiftId = await openShift(env, owner, { fondo: 2000 });

  // Efectivo 1950.
  const cash = await webOrder(env, "orden-reporte-cash", {
    items: [{ product_id: "margarita", qty: 2 }, { product_id: "bebida", qty: 1 }],
  });
  assert.equal((await pay(env, owner, cash.id, { idempotency_key: "cobro-reporte-cash" }, "pay-cash")).status, 200);

  // Datáfono 850.
  const card = await webOrder(env, "orden-reporte-datafono", { items: [{ product_id: "margarita", qty: 1 }] });
  assert.equal((await pay(env, owner, card.id, {
    idempotency_key: "cobro-reporte-datafono", authorization_code: "REPO1234", card_last4: "9876",
  })).status, 200);

  // Link de Bendo 850, conciliado por el retorno del checkout simulado.
  const linkOrder = await cajaOrder(env, owner, "orden-reporte-link", { payment_method: "bendo" });
  const started = await panel.fetch(body(`/panel/api/orders/${linkOrder.id}/bendo`, {
    idempotency_key: "cobro-reporte-link",
  }, { headers: { cookie: owner } }), env, {});
  const link = await started.json();
  await panel.fetch(request(`/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`), env, {});
  const returned = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`, {
    headers: { accept: "application/json" },
  }), env, {});
  assert.equal(returned.status, 200);
  assert.equal((await returned.json()).order_status, "paid");

  const report = (await (await panel.fetch(request("/panel/api/turnos/actual?sede_id=centro", {
    headers: { cookie: owner },
  }), env, {})).json()).report;
  assert.equal(report.shift_id, shiftId);
  assert.deepEqual(report.sales, [
    { method: "cash", count: 1, total_cents: 1950 },
    { method: "datafono", count: 1, total_cents: 850 },
    { method: "bendo", count: 1, total_cents: 850 },
  ]);
  assert.equal(report.sales_total_cents, 1950 + 850 + 850);
  // Solo el efectivo entra al arqueo: ni el datáfono ni el link suman.
  assert.equal(report.expected_cash_cents, 2000 + 1950);
  assert.deepEqual(report.pending_payments, { count: 0, total_cents: 0 });
  assert.deepEqual(report.orders, { paid: 3, rejected: 0 });

  const dbTotal = env.DB.raw.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM pos_payments WHERE shift_id = ? AND status = 'paid'",
  ).get(shiftId).total;
  assert.equal(report.sales_total_cents, dbTotal);
});

/* ── Migración 0013 sobre datos previos ──────────────────────────────────── */

test("0013: agrega channel, marca los Bendo previos como link y valida el CHECK", () => {
  const db = new DatabaseSync(":memory:");
  for (const file of migrationFiles().filter(file => file < "0013")) db.exec(migrationSql(file));

  const insert = (id, provider, key) => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, created_at, updated_at) VALUES (?, 'munch', 'orden-previo', ?, ?, 'paid', 850, 'USD', NULL, 1, 1)",
  ).run(id, provider, key);
  insert("pago-bendo-previo", "bendo", "pago-bendo-previo");
  insert("pago-cash-previo", "cash", "pago-cash-previo");
  insert("pago-transfer-previo", "transfer", "pago-transfer-previo");

  db.exec(migrationSql("0013_pago_canal.sql"));

  const channelOf = id => db.prepare("SELECT channel FROM pos_payments WHERE id = ?").get(id).channel;
  assert.equal(channelOf("pago-bendo-previo"), "link", "un Bendo anterior es un cobro por link");
  assert.equal(channelOf("pago-cash-previo"), null);
  assert.equal(channelOf("pago-transfer-previo"), null);
  assert.equal(
    db.prepare("PRAGMA table_info(pos_payments)").all().some(column => column.name === "channel"), true,
  );

  // El CHECK acepta `datafono` y rechaza cualquier otro canal.
  db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, channel, created_at, updated_at) " +
    "VALUES ('pago-datafono-1', 'munch', 'orden-previo', 'bendo', 'pago-datafono-1', 'paid', 850, 'USD', 'datafono', 1, 1)",
  ).run();
  assert.equal(channelOf("pago-datafono-1"), "datafono");
  assert.throws(() => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, channel, created_at, updated_at) " +
    "VALUES ('pago-canal-malo', 'munch', 'orden-previo', 'bendo', 'pago-canal-malo', 'paid', 850, 'USD', 'otro', 1, 1)",
  ).run(), /CHECK constraint failed: channel/);
});

/* ── Un cobro por link nuevo guarda channel='link' ───────────────────────── */

test("cobro por link nuevo: el intento nace con channel='link'", async () => {
  const env = datafonoEnv();
  env.BENDO_MODE = "mock";
  const owner = await ownerCookie(env);

  const caja = await cajaOrder(env, owner, "orden-link-canal-caja", { payment_method: "bendo" });
  let response = await panel.fetch(body(`/panel/api/orders/${caja.id}/bendo`, {
    idempotency_key: "link-canal-caja-0001",
  }, { headers: { cookie: owner } }), env, {});
  assert.equal(response.status, 200);
  assert.equal(paymentOf(env, caja.id, "link-canal-caja-0001").channel, "link");

  const web = await webOrder(env, "orden-link-canal-web", {
    payment_method: "bendo", items: [{ product_id: "margarita", qty: 1 }],
  });
  response = await panel.fetch(body(`/api/orders/${web.id}/bendo`, {
    order_token: web.order_token, idempotency_key: "link-canal-web-0001",
  }), env, {});
  assert.equal(response.status, 200);
  assert.equal(paymentOf(env, web.id, "link-canal-web-0001").channel, "link");
});
