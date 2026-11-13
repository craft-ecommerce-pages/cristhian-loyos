// QA 1 del datáfono manual (revisión, no desarrollo):
//   1. la migración 0013 es aditiva sobre datos reales (0001..0012 + filas),
//      conserva turnos/pagos/comandas y marca los Bendo previos como `link`;
//   2. dos cobros simultáneos del mismo pedido (datáfono/datáfono o
//      datáfono/efectivo) dejan UN solo pago `paid`, una sola comanda y una
//      sola venta en el turno, aunque ambos relojes caigan en el mismo ms;
//   3. la carrera con el cierre de turno responde 409 caja_cerrada y no pierde
//      ni duplica dinero;
//   4. el ticket Z de 32 y 48 columnas rotula el datáfono sin desbordar.
//
// Sin red real: D1/KV en memoria de `helpers.mjs` y Bendo en mock.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import panel from "../src/index.js";
import { shiftTicketLines } from "../../shared/ticket.js";
import { makeEnv } from "./helpers.mjs";

const DIR = new URL("../migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter(file => file.endsWith(".sql")).sort();
const sqlOf = name => readFileSync(new URL(name, DIR), "utf8");
const numberOf = name => Number(name.slice(0, 4));

function dbThrough(last) {
  const db = new DatabaseSync(":memory:");
  for (const file of FILES.filter(file => numberOf(file) <= last)) db.exec(sqlOf(file));
  return db;
}

const NOW = Date.UTC(2026, 10, 13, 15, 0);
const ORDER_ITEMS = JSON.stringify([{ product_id: "margarita", qty: 2, unit_cents: 850, name: "Margarita" }]);

// Datos previos a 0013: sedes, pedidos, pagos de todos los proveedores (Bendo
// pagado y pendiente incluidos), turno cerrado con su movimiento, comandas y
// personal. 0013 no debe tocar nada salvo `pos_payments.channel`.
function seed(db) {
  db.exec("BEGIN");
  const sede = db.prepare(
    "INSERT INTO pos_sedes (slug, id, nombre, direccion, universidad, activa, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  sede.run("munch", "sede-01", "Centro", "Calle 1", "", 1, NOW);
  sede.run("munch", "sede-02", "Norte", "Calle 2", "U", 1, NOW);

  const order = db.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, status_at, currency, " +
    "subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, staff_id, idempotency_key, " +
    "idempotency_hash, paid_at, payment_method) VALUES (?, 'munch', ?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, 'pickup', ?, ?, ?, ?, ?)",
  );
  order.run("o-cash", "sede-01", NOW, NOW, 1, "caja", "paid", NOW, 1700, 1700, ORDER_ITEMS, "Ana", "099", "l_ana", "o-cash-key", "h1", NOW, "cash");
  order.run("o-bendo", "sede-02", NOW, NOW, 2, "web", "paid", NOW, 850, 850, ORDER_ITEMS, "Eva", "097", null, "o-bendo-key", "h2", NOW, "bendo");
  order.run("o-bendo-pending", "sede-02", NOW, NOW, 3, "web", "confirmed", NOW, 1200, 1200, ORDER_ITEMS, "Iván", "096", null, "o-bendo-pend-key", "h3", null, "bendo");
  order.run("o-transfer", "sede-01", NOW, NOW, 4, "caja", "paid", NOW, 2500, 2500, ORDER_ITEMS, "Luis", "098", "l_ana", "o-transfer-key", "h4", NOW, "transfer");
  order.run("o-payphone", "sede-02", NOW, NOW, 5, "web", "paid", NOW, 1200, 1200, ORDER_ITEMS, "Rosa", "095", null, "o-payphone-key", "h5", NOW, "payphone");

  // Turno ya cerrado antes de 0013: su snapshot y los pagos asignados no cambian.
  db.prepare(
    "INSERT INTO pos_shifts (id, slug, sede_id, status, opened_by, opened_at, opening_float_cents, open_key, " +
    "closed_by, closed_at, close_key, counted_cash_cents, expected_cash_cents, difference_cents, totals, note) " +
    "VALUES ('turno-1', 'munch', 'sede-01', 'closed', 'l_ana', ?, 2000, 'turno-1-open', 'l_ana', ?, 'turno-1-close', " +
    "3700, 3700, 0, '{\"sales\":[]}', 'cierre previo')",
  ).run(NOW - 1000, NOW);
  db.prepare(
    "INSERT INTO pos_cash_movements (id, slug, shift_id, kind, amount_cents, reason, staff_id, idempotency_key, created_at) " +
    "VALUES ('mov-1', 'munch', 'turno-1', 'out', 500, 'Depósito banco', 'l_ana', 'mov-1-key', ?)",
  ).run(NOW);

  const payment = db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, provider_id, url, authorization, message, attempts, created_at, updated_at, paid_at, shift_id) " +
    "VALUES (?, 'munch', ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  payment.run("p-cash", "o-cash", "cash", "pay-cash", "paid", 1700, null, null, null, null, null, 0, NOW, NOW, NOW, "turno-1");
  payment.run("p-bendo", "o-bendo", "bendo", "pay-bendo", "paid", 850, "REFBENDO0000001", "uuid-link", "https://checkout.bendo/a", "AUTH9", null, 1, NOW, NOW, NOW, null);
  payment.run("p-bendo-pending", "o-bendo-pending", "bendo", "pay-bendo-pending", "pending", 1200, "REFBENDO0000002", "uuid-link-2", "https://checkout.bendo/b", null, null, 1, NOW, NOW, null, null);
  payment.run("p-transfer", "o-transfer", "transfer", "pay-transfer", "paid", 2500, "REFTRANSFER00001", null, null, null, null, 0, NOW, NOW, NOW, null);
  payment.run("p-payphone", "o-payphone", "payphone", "pay-payphone", "paid", 1200, "REFPHONE0000001", "tx-1", "https://pay.payphone/x", "AUTH1", null, 2, NOW, NOW, NOW, null);

  db.prepare(
    "INSERT INTO pos_order_lines (slug, order_id, line_index, report_category, product_id, variant_id, name, qty, unit_cents, line_total_cents, created_at) " +
    "VALUES ('munch', ?, 0, 'tradicional', 'margarita', NULL, 'Margarita', 2, 850, 1700, ?)",
  ).run("o-cash", NOW);
  db.prepare("INSERT INTO pos_comandas (slug, order_id, created_at, printed_at, print_count) VALUES ('munch', 'o-cash', ?, ?, 1)")
    .run(NOW, NOW);
  db.prepare("INSERT INTO pos_comanda_prints (slug, order_id, idempotency_key, printed_at) VALUES ('munch', 'o-cash', 'pr-1', ?)").run(NOW);
  db.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('munch', 'l_ana', 'Ana', 'lookup-ana', 'hash', '[\"sede-01\"]', 1, ?, ?)",
  ).run(NOW, NOW);
  db.exec("COMMIT");
}

// Instantánea lógica de todo lo que 0013 no debe alterar, más el inventario de
// columnas e índices de pos_payments.
function snapshot(db) {
  const tables = ["pos_sedes", "pos_orders", "pos_payments", "pos_order_lines", "pos_comandas",
    "pos_comanda_prints", "pos_staff", "pos_shifts", "pos_cash_movements"];
  const rows = {};
  for (const table of tables) rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(row => row.name);
  const columns = db.prepare("PRAGMA table_info(pos_payments)").all().map(row => `${row.name}:${row.type}:${row.notnull}`);
  return { rows, indexes, columns };
}

test("0013 conserva las filas de 0001..0012 y marca los Bendo previos como link", () => {
  const db = dbThrough(12);
  seed(db);
  const before = snapshot(db);
  assert.deepEqual(before.columns.map(text => text.split(":")[0]), [
    "id", "slug", "order_id", "provider", "idempotency_key", "status", "amount_cents", "currency",
    "provider_ref", "provider_id", "url", "authorization", "message", "attempts", "created_at", "updated_at",
    "paid_at", "shift_id",
  ]);

  db.exec(sqlOf("0013_pago_canal.sql"));
  const after = snapshot(db);

  // Ninguna fila se pierde ni se altera, salvo el `channel` nuevo.
  for (const table of Object.keys(before.rows)) {
    const columns = Object.keys(before.rows[table][0] || {});
    const keep = row => Object.fromEntries(columns.map(column => [column, row[column]]));
    assert.equal(after.rows[table].length, before.rows[table].length, `${table}: todas las filas`);
    assert.deepEqual(after.rows[table].map(keep), before.rows[table], `${table}: filas idénticas tras 0013`);
  }
  // Los Bendo anteriores (pagados y pendientes) son cobros por link; el resto
  // de proveedores conserva `channel` NULL.
  const channel = id => db.prepare("SELECT channel FROM pos_payments WHERE id = ?").get(id).channel;
  assert.equal(channel("p-bendo"), "link", "un Bendo pagado previo es un link");
  assert.equal(channel("p-bendo-pending"), "link", "un Bendo pendiente previo es un link");
  for (const id of ["p-cash", "p-transfer", "p-payphone"]) assert.equal(channel(id), null, `${id} no inventa canal`);
  // El turno asignado y el snapshot del cierre siguen intactos.
  assert.equal(db.prepare("SELECT shift_id FROM pos_payments WHERE id = 'p-cash'").get().shift_id, "turno-1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_shifts WHERE id = 'turno-1' AND status = 'closed'").get().n, 1);
  // Solo se añade una columna al final y ningún índice heredado desaparece.
  assert.deepEqual(after.columns.map(text => text.split(":")[0]), [...before.columns.map(text => text.split(":")[0]), "channel"]);
  for (const name of before.indexes) assert.ok(after.indexes.includes(name), `índice heredado ${name}`);

  // El CHECK admite `datafono` y rechaza cualquier otro canal.
  const insert = channelValue => db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, channel, created_at, updated_at) " +
    "VALUES (?, 'munch', 'o-bendo', 'bendo', ?, 'paid', 850, 'USD', ?, 1, 1)",
  ).run(`nuevo-${channelValue || "null"}`, `clave-${channelValue || "null"}`, channelValue);
  insert("datafono");
  assert.throws(() => insert("otro"), /CHECK constraint failed: channel/);
  db.exec("PRAGMA foreign_key_check");
});

/* ── Entorno HTTP: D1/KV en memoria, Bendo en mock ───────────────────────── */

const HOST = "munch.example";
const origin = `https://${HOST}`;
const request = (path, init) => new Request(`${origin}${path}`, init);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie) => request(path, { headers: { accept: "application/json", cookie } });

const margarita = {
  id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "",
  stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
};

function qaEnv() {
  const env = makeEnv({
    "munch:config": {
      currency: "USD", store_name: "Munch",
      location: { sedes: [
        { id: "centro", nombre: "Centro", direccion: "Calle 1" },
        { id: "norte", nombre: "Norte", direccion: "Calle 2" },
      ] },
    },
  });
  env.CLIENT_SLUG = "munch";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita] }), Date.now());
  return env;
}

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/munch/owner", { email: "dueno@munch.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

async function openShift(env, cookie) {
  const response = await panel.fetch(body("/panel/api/turnos/abrir", {
    sede_id: "centro", opening_float_cents: 2000, idempotency_key: "qa-turno-abrir",
  }, { headers: { cookie } }), env, {});
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text).shift.id;
}

async function openShiftAt(env, cookie, sede, key) {
  const response = await panel.fetch(body("/panel/api/turnos/abrir", {
    sede_id: sede, opening_float_cents: 1000, idempotency_key: key,
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

const pay = (env, cookie, id, payload, route) =>
  panel.fetch(body(`/panel/api/orders/${id}/${route}`, payload, { headers: { cookie } }), env, {});

const datáfono = (env, cookie, id, key, auth = "A7K2") =>
  pay(env, cookie, id, { idempotency_key: key, authorization_code: auth }, "pay-datafono");
const cash = (env, cookie, id, key) => pay(env, cookie, id, { idempotency_key: key }, "pay-cash");

const paymentRows = (env, orderId) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? ORDER BY rowid",
).all(orderId);
const paidPayments = (env, orderId) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? AND status = 'paid' ORDER BY rowid",
).all(orderId);
const comandas = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) AS n FROM pos_comandas WHERE order_id = ?",
).get(orderId).n;
const lineRows = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) AS n FROM pos_order_lines WHERE order_id = ?",
).get(orderId).n;
const orderRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);

// Doble de D1 que retiene el PRIMER batch cuya SQL coincida hasta que el test lo
// libere. Reproduce la ventana real entre "leí el pedido" y "escribí el cobro".
function gateFirstBatch(env) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const originalBatch = env.DB.batch.bind(env.DB);
  const decorate = (sql, statement) => new Proxy(statement, {
    get(target, prop) {
      if (prop === "sql") return sql;
      if (prop === "bind") return (...args) => decorate(sql, target.bind(...args));
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  env.DB.prepare = sql => decorate(sql, originalPrepare(sql));
  const holds = [];
  env.DB.batch = async statements => {
    const index = holds.findIndex(hold => statements.some(statement => hold.predicate(statement.sql || "")));
    if (index >= 0) {
      const [hold] = holds.splice(index, 1);
      hold.hit();
      await hold.gate;
    }
    return originalBatch(statements);
  };
  return {
    armed(predicate) {
      let hit, release;
      const reached = new Promise(resolve => { hit = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      holds.push({ predicate, hit, gate });
      return { reached, release };
    },
  };
}

// Los dos cobros se resuelven con el mismo `Date.now()`: es el peor caso real
// (dos cajas en el mismo milisegundo) y el único que el guard de `paid_at`
// dejaba pasar.
async function frozenClock(run) {
  const real = Date.now;
  const frozen = real();
  Date.now = () => frozen;
  try { return await run(); } finally { Date.now = real; }
}

/* ── Turno obligatorio y asignación por sede ─────────────────────────────── */

test("el datáfono exige el turno de la sede del pedido y se asigna a ese turno", async () => {
  const env = qaEnv(), cookie = await ownerCookie(env);
  const centroShift = await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-sede-norte", { sede_id: "norte" });

  // Hay caja abierta en otra sede: no habilita el cobro de este pedido.
  let response = await datáfono(env, cookie, order.id, "qa-sede-norte-1");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(paymentRows(env, order.id).length, 0);

  const norteShift = await openShiftAt(env, cookie, "norte", "qa-turno-abrir-norte");
  response = await datáfono(env, cookie, order.id, "qa-sede-norte-2");
  assert.equal(response.status, 200, await response.clone().text());
  const payment = paymentRows(env, order.id)[0];
  assert.equal(payment.shift_id, norteShift, "se asigna al turno de su sede");
  assert.notEqual(payment.shift_id, centroShift);

  // El turno de la otra sede no recibe la venta ni el efectivo.
  const report = (await (await panel.fetch(withCookie("/panel/api/turnos/actual?sede_id=centro", cookie), env, {})).json()).report;
  assert.deepEqual(report.sales, []);
  assert.equal(report.expected_cash_cents, 2000);
});

/* ── Dos cobros simultáneos del mismo pedido: un solo pago y una sola venta ── */

test("dos datáfonos a la vez: 200 + 409 orden_ya_pagada, un solo pago y una comanda", async () => {
  const env = qaEnv(), cookie = await ownerCookie(env), shiftId = await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-race-datafono");
  const gate = gateFirstBatch(env);

  await frozenClock(async () => {
    const armed = gate.armed(sql => sql.includes("INSERT INTO pos_payments") && sql.includes("channel"));
    const first = datáfono(env, cookie, order.id, "qa-cobro-datafono-a");
    await armed.reached;
    const second = await datáfono(env, cookie, order.id, "qa-cobro-datafono-b");
    assert.equal(second.status, 200, await second.clone().text());
    armed.release();
    const lost = await first;
    assert.equal(lost.status, 409);
    assert.deepEqual(await lost.json(), { error: "orden_ya_pagada" });
  });

  const paid = paidPayments(env, order.id);
  assert.equal(paid.length, 1, "un solo pago pagado para el pedido");
  assert.equal(paid[0].channel, "datafono");
  assert.equal(paid[0].shift_id, shiftId);
  assert.equal(paid[0].idempotency_key, "qa-cobro-datafono-b");
  assert.equal(paymentRows(env, order.id).length, 1, "el intento perdedor no deja fila");
  assert.equal(comandas(env, order.id), 1);
  assert.equal(orderRow(env, order.id).payment_method, "bendo");

  const report = (await (await panel.fetch(withCookie("/panel/api/turnos/actual?sede_id=centro", cookie), env, {})).json()).report;
  assert.deepEqual(report.sales, [{ method: "datafono", count: 1, total_cents: 1700 }]);
  assert.equal(report.sales_total_cents, 1700, "la venta no se duplica");
  assert.equal(report.expected_cash_cents, 2000, "el datáfono no entra al efectivo");
});

test("datáfono y efectivo a la vez: gana uno, el otro recibe 409 y no hay doble cobro", async () => {
  // Datáfono retenido; el efectivo termina primero.
  const env = qaEnv(), cookie = await ownerCookie(env);
  await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-race-mixta");
  const gate = gateFirstBatch(env);

  await frozenClock(async () => {
    const armed = gate.armed(sql => sql.includes("INSERT INTO pos_payments") && sql.includes("channel"));
    const card = datáfono(env, cookie, order.id, "qa-mixta-datafono");
    await armed.reached;
    const money = await cash(env, cookie, order.id, "qa-mixta-cash");
    assert.equal(money.status, 200, await money.clone().text());
    armed.release();
    const lost = await card;
    assert.equal(lost.status, 409);
    assert.deepEqual(await lost.json(), { error: "orden_ya_pagada" });
  });

  const paid = paidPayments(env, order.id);
  assert.equal(paid.length, 1, "solo se cobró una vez");
  assert.equal(paid[0].provider, "cash");
  assert.equal(orderRow(env, order.id).payment_method, "cash");
  assert.equal(comandas(env, order.id), 1);
  const report = (await (await panel.fetch(withCookie("/panel/api/turnos/actual?sede_id=centro", cookie), env, {})).json()).report;
  assert.deepEqual(report.sales, [{ method: "cash", count: 1, total_cents: 1700 }]);
  assert.equal(report.expected_cash_cents, 2000 + 1700);
});

test("efectivo retenido y datáfono primero: tampoco se duplica el cobro", async () => {
  const env = qaEnv(), cookie = await ownerCookie(env);
  await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-race-inversa");
  const gate = gateFirstBatch(env);

  await frozenClock(async () => {
    // Se retiene el batch del efectivo (no incluye `channel`); el datáfono pasa.
    const armedCash = gate.armed(sql => sql.includes("INSERT INTO pos_payments") && !sql.includes("channel"));
    const money = cash(env, cookie, order.id, "qa-inversa-cash");
    await armedCash.reached;
    const card = await datáfono(env, cookie, order.id, "qa-inversa-datafono");
    assert.equal(card.status, 200, await card.clone().text());
    armedCash.release();
    const lost = await money;
    assert.equal(lost.status, 409);
    assert.deepEqual(await lost.json(), { error: "orden_ya_pagada" });
  });

  const paid = paidPayments(env, order.id);
  assert.equal(paid.length, 1, "solo el datáfono cobró");
  assert.equal(paid[0].channel, "datafono");
  assert.equal(orderRow(env, order.id).payment_method, "bendo");
  assert.equal(comandas(env, order.id), 1);
});

/* ── Carrera con el cierre de turno ──────────────────────────────────────── */

test("cierre de turno mientras se cobra con datáfono: 409 caja_cerrada y nada huérfano", async () => {
  const env = qaEnv(), cookie = await ownerCookie(env);
  const shiftId = await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-cierre-datafono");
  const gate = gateFirstBatch(env);

  const armed = gate.armed(sql => sql.includes("INSERT INTO pos_payments") && sql.includes("channel"));
  const charging = datáfono(env, cookie, order.id, "qa-cierre-datafono");
  await armed.reached;

  const closed = await panel.fetch(body(`/panel/api/turnos/${shiftId}/cerrar`, {
    counted_cash_cents: 2000, idempotency_key: "qa-turno-cerrar",
  }, { headers: { cookie } }), env, {});
  const closedText = await closed.text();
  assert.equal(closed.status, 200, closedText);
  armed.release();

  const response = await charging;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(paymentRows(env, order.id).length, 0, "no queda pago sin turno");
  assert.equal(comandas(env, order.id), 0, "no sale comanda de un cobro que perdió la carrera");
  assert.equal(lineRows(env, order.id), 0, "tampoco se escriben líneas de venta");
  assert.equal(orderRow(env, order.id).status, "pending", "sigue cobrable al abrir la próxima caja");
  const report = JSON.parse(closedText).report;
  assert.deepEqual(report.sales, []);
  assert.equal(report.expected_cash_cents, 2000);
  assert.equal(report.sales_total_cents, 0);
});

test("link de Bendo creado entre la lectura y el batch: 409 pago_en_curso sin comanda fantasma", async () => {
  const env = qaEnv(), cookie = await ownerCookie(env);
  await openShift(env, cookie);
  const order = await webOrder(env, "qa-orden-link-concurrente");
  const gate = gateFirstBatch(env);

  const armed = gate.armed(sql => sql.includes("INSERT INTO pos_payments") && sql.includes("channel"));
  const charging = datáfono(env, cookie, order.id, "qa-link-concurrente-datafono");
  await armed.reached;

  // Otra caja crea el link mientras este datáfono ya leyó el pedido.
  env.DB.raw.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, channel, created_at, updated_at) " +
    "VALUES ('qa-link-1', 'munch', ?, 'bendo', 'qa-link-concurrente', 'pending', 1700, 'USD', 'QA-LINK-REF-0001', 'link', ?, ?)",
  ).run(order.id, Date.now(), Date.now());
  armed.release();

  const response = await charging;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "pago_en_curso" });
  assert.equal(paymentRows(env, order.id).length, 1, "solo el intento del link");
  assert.equal(paymentRows(env, order.id)[0].channel, "link");
  assert.equal(comandas(env, order.id), 0, "el datáfono no manda nada a cocina");
  assert.equal(lineRows(env, order.id), 0);
  assert.equal(orderRow(env, order.id).status, "pending");
});

/* ── Ticket Z: etiqueta del datáfono en 32 y 48 columnas ─────────────────── */

test("el ticket Z rotula Datáfono en 32 y 48 columnas sin desbordar", () => {
  const report = {
    status: "closed", sede_id: "sede-01",
    opened_at: Date.UTC(2026, 10, 13, 13, 0), closed_at: Date.UTC(2026, 10, 13, 18, 0),
    opening_float_cents: 2000,
    sales: [
      { method: "cash", count: 1, total_cents: 1000 },
      { method: "transfer", count: 1, total_cents: 250 },
      { method: "datafono", count: 2, total_cents: 4100 },
      { method: "bendo", count: 1, total_cents: 950 },
      { method: "payphone", count: 0, total_cents: 0 },
    ],
    sales_total_cents: 6300,
    expected_cash_cents: 3000, counted_cash_cents: 3000, difference_cents: 0,
  };
  for (const width of [32, 48]) {
    const lines = shiftTicketLines(report, { store: "Munch", width, sedeName: "Centro" });
    assert.ok(lines.every(line => [...line].length <= width), `ninguna línea supera ${width} columnas`);
    const joined = lines.join("\n");
    for (const label of ["Efectivo (1)", "Transferencia (1)", "Datáfono (2)", "Tarjeta (link) (1)", "Payphone (histórico) (0)"]) {
      assert.ok(joined.includes(label), `${width}: ${label}`);
    }
  }
});
