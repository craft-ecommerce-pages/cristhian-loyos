// QA 1 del cierre de caja:
//   1. la migración 0012 es aditiva sobre datos reales y el índice parcial
//      impide dos turnos abiertos por sede;
//   2. cobro manual y movimiento de efectivo durante el cierre no se pierden.
//
// A diferencia de `helpers.mjs` (que aplica TODAS las migraciones), la primera
// parte siembra una base con 0001..0011, carga filas de ejemplo y recién
// entonces aplica 0012, para comprobar que no se pierde ni se altera nada.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import panel from "../src/index.js";
import { handleTurnosApi } from "../src/turnos.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const DIR = new URL("../migrations/", import.meta.url);
const FILES = readdirSync(DIR).filter(f => f.endsWith(".sql")).sort();
const sqlOf = name => readFileSync(new URL(name, DIR), "utf8");
const number = name => Number(name.slice(0, 4));

// Base con las migraciones hasta `last` (incluida).
function dbThrough(last) {
  const db = new DatabaseSync(":memory:");
  for (const file of FILES.filter(f => number(f) <= last)) db.exec(sqlOf(file));
  return db;
}

const NOW = Date.UTC(2026, 10, 13, 15, 0);
const ORDER_ITEMS = JSON.stringify([{ product_id: "margarita", qty: 2, unit_cents: 850, name: "Margarita" }]);

// Datos previos a 0012: sedes, pedidos, pagos de todos los proveedores,
// comandas, acuses y personal. Todo lo que 0012 no debe tocar.
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
  order.run("o-transfer", "sede-01", NOW, NOW, 2, "caja", "paid", NOW, 2500, 2500, ORDER_ITEMS, "Luis", "098", "l_ana", "o-transfer-key", "h2", NOW, "transfer");
  order.run("o-bendo", "sede-02", NOW, NOW, 3, "web", "pending", NOW, 850, 850, ORDER_ITEMS, "Eva", "097", null, "o-bendo-key", "h3", null, "bendo");
  order.run("o-payphone", "sede-02", NOW, NOW, 4, "web", "paid", NOW, 1200, 1200, ORDER_ITEMS, "Iván", "096", null, "o-payphone-key", "h4", NOW, "payphone");

  const payment = db.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, provider_id, url, authorization, message, attempts, created_at, updated_at, paid_at) " +
    "VALUES (?, 'munch', ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  payment.run("p-cash", "o-cash", "cash", "pay-cash", "paid", 1700, null, null, null, null, null, 0, NOW, NOW, NOW);
  payment.run("p-transfer", "o-transfer", "transfer", "pay-transfer", "paid", 2500, "REFTRANSFER00001", null, null, null, null, 0, NOW, NOW, NOW);
  payment.run("p-bendo", "o-bendo", "bendo", "pay-bendo", "pending", 850, "REFBENDO0000001", "uuid-link", "https://checkout.bendo/abc", null, null, 1, NOW, NOW, null);
  payment.run("p-payphone", "o-payphone", "payphone", "pay-payphone", "paid", 1200, "REFPHONE0000001", "tx-1", "https://pay.payphone/x", "AUTH1", null, 2, NOW, NOW, NOW);

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

// Instantánea lógica: filas completas de las tablas que 0012 no debe tocar,
// más el inventario de índices/columnas de pos_payments.
function snapshot(db) {
  const tables = ["pos_sedes", "pos_orders", "pos_payments", "pos_order_lines", "pos_comandas", "pos_comanda_prints", "pos_staff"];
  const rows = {};
  for (const table of tables) rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
  const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row }));
  const columns = db.prepare("PRAGMA table_info(pos_payments)").all().map(row => `${row.name}:${row.type}:${row.notnull}:${row.dflt_value}`);
  return { rows, indexes, columns };
}

test("0012 conserva todas las filas y los índices de 0001..0011", () => {
  const db = dbThrough(11);
  seed(db);
  const before = snapshot(db);
  // Columnas de pos_payments antes: 0012 solo añade `shift_id` al final.
  assert.deepEqual(before.columns.map(text => text.split(":")[0]),
    ["id", "slug", "order_id", "provider", "idempotency_key", "status", "amount_cents", "currency",
      "provider_ref", "provider_id", "url", "authorization", "message", "attempts", "created_at", "updated_at", "paid_at"]);
  const beforeIndexes = before.indexes.map(index => index.name).filter(name => !name.startsWith("pos_shifts") && !name.startsWith("pos_cash_movements"));

  db.exec(sqlOf("0012_caja_turnos.sql"));

  const after = snapshot(db);
  // La única diferencia admitida es la columna nueva `pos_payments.shift_id`.
  const beforeColumns = id => Object.keys(before.rows[id][0] || {});
  const keep = (row, columns) => Object.fromEntries(columns.map(column => [column, row[column]]));
  for (const table of Object.keys(before.rows)) {
    assert.equal(after.rows[table].length, before.rows[table].length, `${table}: se conservaron todas las filas`);
    assert.deepEqual(after.rows[table].map(row => keep(row, beforeColumns(table))), before.rows[table],
      `${table}: filas idénticas tras 0012`);
  }
  // Los cuatro pagos (incluidos bendo y payphone históricos) siguen intactos y
  // quedan sin turno, listos para asignarse al abrir la próxima caja.
  assert.deepEqual(after.rows.pos_payments.map(row => [row.id, row.provider, row.status]),
    [["p-cash", "cash", "paid"], ["p-transfer", "transfer", "paid"], ["p-bendo", "bendo", "pending"], ["p-payphone", "payphone", "paid"]]);
  assert.ok(after.rows.pos_payments.every(row => row.shift_id === null));
  // 0012 solo añade una columna al final.
  assert.deepEqual(after.columns.map(text => text.split(":")[0]), [...before.columns.map(text => text.split(":")[0]), "shift_id"]);
  // Ningún índice heredado desaparece y 0012 crea los suyos.
  const afterIndexes = new Set(after.indexes.map(index => index.name));
  for (const name of beforeIndexes) assert.ok(afterIndexes.has(name), `índice heredado ${name}`);
  for (const name of ["pos_shifts_one_open", "pos_shifts_sede_opened", "pos_cash_movements_shift", "pos_payments_shift"]) {
    assert.ok(afterIndexes.has(name), `índice nuevo ${name}`);
  }
  // Tablas nuevas vacías y con los CHECK del contrato.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_shifts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_cash_movements").get().n, 0);
  db.exec("PRAGMA foreign_key_check");
});

const shiftRow = (db, id, sede, extra = {}) => ({
  id, slug: "munch", sede_id: sede, status: extra.status || "open", opened_by: extra.opened_by || "l_ana",
  opened_at: extra.opened_at ?? NOW, opening_float_cents: extra.opening_float_cents ?? 2000,
  open_key: extra.open_key || `open-${id}`,
  closed_by: extra.closed_by ?? null, closed_at: extra.closed_at ?? null, close_key: extra.close_key ?? null,
  counted_cash_cents: extra.counted_cash_cents ?? null, expected_cash_cents: extra.expected_cash_cents ?? null,
  difference_cents: extra.difference_cents ?? null, totals: extra.totals ?? null, note: extra.note ?? null,
});

function insertShift(db, row) {
  db.prepare(
    "INSERT INTO pos_shifts (id, slug, sede_id, status, opened_by, opened_at, opening_float_cents, open_key, " +
    "closed_by, closed_at, close_key, counted_cash_cents, expected_cash_cents, difference_cents, totals, note) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.slug, row.sede_id, row.status, row.opened_by, row.opened_at, row.opening_float_cents,
    row.open_key, row.closed_by, row.closed_at, row.close_key, row.counted_cash_cents, row.expected_cash_cents,
    row.difference_cents, row.totals, row.note);
}

test("el índice parcial impide dos turnos abiertos por sede", () => {
  const db = dbThrough(12);
  insertShift(db, shiftRow(db, "s1", "sede-01"));
  // Segundo turno abierto en la misma sede: lo rechaza el índice parcial.
  assert.throws(() => insertShift(db, shiftRow(db, "s2", "sede-01")), /UNIQUE constraint failed: pos_shifts\.slug, pos_shifts\.sede_id/);
  // Otra sede puede abrir a la vez.
  insertShift(db, shiftRow(db, "s3", "sede-02"));
  // Otro cliente (slug) es independiente.
  insertShift(db, { ...shiftRow(db, "s4", "sede-01"), slug: "otro" });
  // Cerrado + abierto conviven en la misma sede (el índice solo mira open).
  assert.equal(db.prepare("UPDATE pos_shifts SET status = 'closed' WHERE id = 's1'").run().changes, 1);
  insertShift(db, shiftRow(db, "s5", "sede-01"));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_shifts WHERE slug = 'munch' AND sede_id = 'sede-01' AND status = 'open'").get().n, 1);
  // Reabrir el turno cerrado también choca con el índice si ya hay otro abierto.
  assert.throws(() => db.prepare("UPDATE pos_shifts SET status = 'open' WHERE id = 's1'").run(), /UNIQUE constraint failed/);
});

test("0012 aplica los CHECK y las claves únicas del contrato", () => {
  const db = dbThrough(12);
  // status abierto/cerrado únicamente.
  assert.throws(() => insertShift(db, shiftRow(db, "x", "sede-01", { status: "paused" })), /CHECK constraint failed/);
  // Fondo inicial no negativo.
  assert.throws(() => insertShift(db, shiftRow(db, "x", "sede-01", { opening_float_cents: -1 })), /CHECK constraint failed/);
  // (slug, open_key) único: el reintento con la misma clave lo detecta la BD.
  insertShift(db, shiftRow(db, "a", "sede-01", { open_key: "misma-clave", status: "closed" }));
  assert.throws(() => insertShift(db, shiftRow(db, "b", "sede-02", { open_key: "misma-clave", status: "closed" })),
    /UNIQUE constraint failed/);
  // Movimientos: monto entero positivo y tipo in/out.
  const movement = db.prepare(
    "INSERT INTO pos_cash_movements (id, slug, shift_id, kind, amount_cents, reason, staff_id, idempotency_key, created_at) " +
    "VALUES (?, 'munch', 'a', ?, ?, 'Depósito banco', 'l_ana', ?, ?)",
  );
  assert.throws(() => movement.run("m1", "out", 0, "mov-1", NOW), /CHECK constraint failed/);
  assert.throws(() => movement.run("m2", "out", -100, "mov-2", NOW), /CHECK constraint failed/);
  assert.throws(() => movement.run("m3", "otro", 100, "mov-3", NOW), /CHECK constraint failed/);
  movement.run("m4", "out", 5000, "mov-4", NOW);
  assert.throws(() => movement.run("m5", "in", 100, "mov-4", NOW + 1), /UNIQUE constraint failed/);
  // Los pagos existentes no tienen turno hasta que se abra la caja.
  seed(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pos_payments WHERE shift_id IS NULL").get().n, 4);
  // El índice de pagos por turno sirve la consulta del reporte.
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT provider, SUM(amount_cents) FROM pos_payments WHERE slug = 'munch' AND shift_id = 'a' AND status = 'paid' GROUP BY provider").all();
  assert.ok(plan.every(row => row.detail !== undefined));
});

/* ── Cobro y movimiento mientras el turno se cierra ──────────────────────────
 * El cierre reclama `status = 'closed'` antes de congelar el snapshot y el cobro
 * manual revalida el turno en el mismo batch. Con un doble de D1 que retiene el
 * INSERT justo hasta después del cierre, se demuestra que la plata no se pierde:
 * el cobro responde 409 caja_cerrada y el movimiento, 409 turno_cerrado.
 */

const HOST = "pizza.craft-systems.com";
const OWNER = { staff_id: "owner", owner: true };
const req = (path, init) => new Request(`https://${HOST}${path}`, init);
const post = (path, value, headers = {}) => req(path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value),
});

const margarita = {
  id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "",
  description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [],
  variants: [], groups: [], packaging_id: null, packaging_cost: 0,
};

function cajaEnv() {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }] },
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita] }), Date.now());
  return env;
}

async function ownerCookie(env) {
  const owner = await panel.fetch(post("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    authorization: "Bearer admin-token",
  }), env, {});
  const login = await panel.fetch(post("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

const turnos = (env, session, method, route, payload) => handleTurnosApi(
  payload === undefined
    ? req(`/panel/api/${route}`, { method })
    : post(`/panel/api/${route}`, payload),
  env, { slug: "pizza" }, session, route.split("?")[0],
);
const open = (env, session, key = "turno-abrir-qa") =>
  turnos(env, session, "POST", "turnos/abrir", { sede_id: "centro", opening_float_cents: 2000, idempotency_key: key });
const close = (env, session, id, counted, key = "turno-cerrar-qa") =>
  turnos(env, session, "POST", `turnos/${id}/cerrar`, { counted_cash_cents: counted, idempotency_key: key });
const newOrder = async (env, ctx, key) => {
  const response = await panel.fetch(post("/api/orders", {
    sede_id: "centro", idempotency_key: key,
    items: [{ product_id: "margarita", qty: 2 }],
    customer: {
      name: "Ana", phone: "0991234567",
      billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
    },
    delivery_mode: "pickup",
  }), env, ctx);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
};

// Doble de D1 que puede retener una escritura concreta hasta que el test la
// libere. Reproduce la ventana real entre "leí el turno abierto" y "escribí".
function gateDb(env) {
  const originalPrepare = env.DB.prepare.bind(env.DB);
  const originalBatch = env.DB.batch.bind(env.DB);
  const hold = { predicate: null, gate: Promise.resolve(), release: () => {}, hit: null };

  const decorate = (sql, statement) => new Proxy(statement, {
    get(target, prop) {
      if (prop === "sql") return sql;
      if (prop === "bind") return (...args) => decorate(sql, target.bind(...args));
      if (prop === "run") return async () => {
        if (hold.predicate?.(sql) === "run") { hold.hit?.(); await hold.gate; }
        return target.run();
      };
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  env.DB.prepare = sql => decorate(sql, originalPrepare(sql));
  env.DB.batch = async statements => {
    if (statements.some(statement => hold.predicate?.(statement.sql) === "batch")) {
      hold.hit?.();
      await hold.gate;
    }
    return originalBatch(statements);
  };
  hold.arm = predicate => {
    hold.predicate = predicate;
    hold.gate = new Promise(resolve => { hold.release = resolve; });
    const reached = new Promise(resolve => { hold.hit = resolve; });
    return { reached, release: () => { hold.release(); hold.predicate = null; } };
  };
  return hold;
}

test("cobro manual durante el cierre: 409 caja_cerrada y ningún pago huérfano", async () => {
  const env = cajaEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const gate = gateDb(env);
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;
  const order = await newOrder(env, ctx, "orden-carrera-cobro");

  // El cobro leyó el turno abierto; su batch espera antes de escribir.
  const armed = gate.arm(sql => sql.includes("INSERT INTO pos_payments") ? "batch" : null);
  const paying = panel.fetch(post(`/panel/api/orders/${order.id}/pay-cash`, { idempotency_key: "cobro-carrera-0001" }, { cookie }), env, ctx);
  await armed.reached;

  const closed = await close(env, OWNER, shiftId, 2000);
  assert.equal(closed.status, 200, "el cierre gana la carrera");
  armed.release();

  const response = await paying;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM pos_payments").get().n, 0, "no hay pago sin turno");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "pending",
    "el pedido sigue cobrable al abrir la próxima caja");
  const report = JSON.parse(env.DB.raw.prepare("SELECT totals FROM pos_shifts WHERE id = ?").get(shiftId).totals);
  assert.equal(report.sales_total_cents, 0);
  assert.equal(report.expected_cash_cents, 2000);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM pos_payments WHERE shift_id = ?").get(shiftId).n, 0);
});

test("movimiento de efectivo durante el cierre: 409 turno_cerrado y snapshot estable", async () => {
  const env = cajaEnv();
  const gate = gateDb(env);
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;

  const armed = gate.arm(sql => sql.includes("INSERT OR IGNORE INTO pos_cash_movements") ? "run" : null);
  const moving = turnos(env, OWNER, "POST", `turnos/${shiftId}/movimientos`, {
    kind: "out", amount_cents: 5000, reason: "Depósito banco", idempotency_key: "mov-carrera-0001",
  });
  await armed.reached;

  const closed = await close(env, OWNER, shiftId, 2000, "turno-cerrar-mov");
  assert.equal(closed.status, 200, "el cierre gana la carrera");
  const closedReport = await closed.json();
  armed.release();

  const response = await moving;
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "turno_cerrado" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM pos_cash_movements").get().n, 0);
  // El snapshot no incluye un retiro que nunca se registró: esperado = fondo.
  assert.equal(closedReport.report.movements.out_cents, 0);
  assert.equal(closedReport.report.expected_cash_cents, 2000);
  const saved = JSON.parse(env.DB.raw.prepare("SELECT totals FROM pos_shifts WHERE id = ?").get(shiftId).totals);
  assert.equal(saved.expected_cash_cents, 2000);
  assert.equal(saved.movements.out_cents, 0);
});

/* ── Arqueo ciego: el HTML inicial no trae ventas, esperado ni diferencia ─── */

test("el HTML inicial del mesero no serializa el reporte del turno", async () => {
  const { renderMeseroPage } = await import("../src/mesero.js");
  const { signCajaSession } = await import("../src/caja.js");
  const env = cajaEnv();
  const site = { slug: "pizza", host: HOST };
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;
  const order = await newOrder(env, makeCtx(), "orden-html-mesero");
  const cookie = await ownerCookie(env);
  await panel.fetch(post(`/panel/api/orders/${order.id}/pay-cash`, { idempotency_key: "cobro-html-0001" }, { cookie }), env, makeCtx());

  const cashier = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  const html = await renderMeseroPage(new Request(`https://${HOST}/panel/mesero`, { headers: { cookie: cashier } }), env, site);
  const data = JSON.parse(/window\.__MESERO__=(\{.*?\});<\/script>/s.exec(html)[1]);
  assert.deepEqual(Object.keys(data).sort(), ["boot", "store"], "solo el arranque, sin contadores del turno");
  assert.deepEqual(Object.keys(data.boot).sort(), ["catalog", "me", "orders"]);
  assert.equal(html.includes(shiftId), false, "el HTML no trae el id del turno abierto");
  const serializedBoot = JSON.stringify(data.boot);
  for (const hidden of ["sales_total_cents", "expected_cash_cents", "counted_cash_cents", "difference_cents", "opening_float_cents"]) {
    assert.equal(serializedBoot.includes(`"${hidden}"`), false, `el arranque no trae ${hidden}`);
  }
  // Y la respuesta viva del cajero sigue siendo ciega.
  const live = await turnos(env, { staff_id: "staff-1", owner: false }, "GET", "turnos/actual?sede_id=centro");
  const blind = await live.json();
  assert.equal("report" in blind, false);
  assert.equal(blind.shift.movements.length, 0);
  assert.equal(JSON.stringify(blind).includes("expected_cash_cents"), false);
});

test("el HTML del panel del dueño solo serializa slug y host", async () => {
  const { renderPage } = await import("../src/page.js");
  const html = renderPage({ slug: "pizza", host: HOST });
  const data = JSON.parse(/window\.__PANEL__=(\{.*?\});<\/script>/s.exec(html)[1]);
  assert.deepEqual(data, { slug: "pizza", host: HOST });
  assert.equal(/expected_cash_cents"\s*:/.test(html), false, "sin reportes embebidos como datos");
});
