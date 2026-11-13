// Turnos y cierre de caja (0012): una caja por sede, arqueo ciego, movimientos
// de efectivo, esperado/diferencia y asignación de pagos al turno abierto.
// Las rutas se ejercitan llamando a handleTurnosApi directamente: el ensamblador
// las monta en api.js con la sesión de handlePosApi.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { handleTurnosApi } from "../src/turnos.js";
import { createPaymentAttempt, posOrderRow, settlePaymentApproved } from "../src/orders.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const OWNER = { staff_id: "owner", owner: true };

const margarita = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };
const bebida = { ...margarita, id: "bebida", name: "Cola", price: "2.50" };

function cajaEnv() {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }, { nombre: "Norte", direccion: "Calle 2" }] },
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita, bebida] }), Date.now());
  return env;
}

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

// Cajero local (PIN en D1): la sesión ya resuelta solo lleva staff_id y sedes.
function localStaff(env, id, sedes) {
  const now = Date.now();
  env.DB.raw.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('pizza', ?, 'Ana', ?, 'hash', ?, 1, ?, ?)",
  ).run(id, `lookup-${id}`, JSON.stringify(sedes), now, now);
  return { staff_id: id, owner: false };
}

// handleTurnosApi recibe el path relativo a /panel/api/ (sin query, como api.js).
function api(env, session, method, route, payload) {
  const [path] = route.split("?");
  const init = payload === undefined
    ? { method }
    : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
  return handleTurnosApi(new Request(`https://${host}/panel/api/${route}`, init), env, { slug: "pizza" }, session, path);
}

function rawPost(env, session, route, text) {
  return handleTurnosApi(new Request(`https://${host}/panel/api/${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: text,
  }), env, { slug: "pizza" }, session, route);
}

const open = (env, session, sede = "centro", key = "turno-abrir-0001", fondo = 2000) =>
  api(env, session, "POST", "turnos/abrir", { sede_id: sede, opening_float_cents: fondo, idempotency_key: key });
const close = (env, session, id, counted, key = "turno-cerrar-0001", note) =>
  api(env, session, "POST", `turnos/${id}/cerrar`, { counted_cash_cents: counted, ...(note == null ? {} : { note }), idempotency_key: key });
const move = (env, session, id, value) => api(env, session, "POST", `turnos/${id}/movimientos`, value);
const current = (env, session, sede = "centro") => api(env, session, "GET", `turnos/actual?sede_id=${sede}`);

const orderBody = (key, overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: key,
  items: [{ product_id: "margarita", qty: 2 }, { product_id: "bebida", qty: 1 }],
  customer: {
    name: "Ana", phone: "0991234567",
    billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
  },
  delivery_mode: "pickup",
  ...overrides,
});

async function newOrder(env, ctx, key, overrides = {}) {
  const response = await panel.fetch(body("/api/orders", orderBody(key, overrides)), env, ctx);
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

const payOrder = (env, ctx, cookie, id, route, key) =>
  panel.fetch(body(`/panel/api/orders/${id}/${route}`, { idempotency_key: key }, { headers: { cookie } }), env, ctx);

const shiftRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_shifts WHERE id = ?").get(id);
const paymentRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_payments WHERE order_id = ?").get(id);

/* ── Abrir/cerrar, arqueo ciego y conciliación de ventas ─────────────────── */

test("abrir y cerrar: movimientos, ventas por método, esperado y diferencia", async () => {
  const env = cajaEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const cashier = localStaff(env, "l_cajero0001", ["centro"]);

  assert.deepEqual(await (await current(env, cashier)).json(), { shift: null });

  let response = await open(env, cashier);
  assert.equal(response.status, 201);
  const opened = await response.json();
  assert.deepEqual(Object.keys(opened.shift).sort(),
    ["id", "movements", "opened_at", "opened_by", "opening_float_cents", "sede_id"]);
  assert.equal(opened.shift.sede_id, "centro");
  assert.equal(opened.shift.opened_by, "l_cajero0001");
  assert.equal(opened.shift.opening_float_cents, 2000);
  assert.deepEqual(opened.shift.movements, []);
  const shiftId = opened.shift.id;

  // Reintento con la misma clave: mismo turno, no se duplica.
  response = await open(env, cashier);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).shift.id, shiftId);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_shifts").get().n, 1);

  // Movimientos de efectivo: ingreso y retiro con motivo obligatorio.
  response = await move(env, cashier, shiftId, {
    kind: "in", amount_cents: 500, reason: "Reposición de cambio", idempotency_key: "mov-in-0001",
  });
  assert.equal(response.status, 201);
  const entry = (await response.json()).movement;
  assert.equal(entry.kind, "in");
  assert.equal(entry.amount_cents, 500);
  assert.equal(entry.shift_id, shiftId);
  assert.equal(entry.staff_id, "l_cajero0001");

  response = await move(env, cashier, shiftId, {
    kind: "out", amount_cents: 300, reason: "Gasto menor: hielo", idempotency_key: "mov-out-0001",
  });
  assert.equal(response.status, 201);

  // Ventas del turno: efectivo 1950 y transferencia 250 (la tarjeta no suma al efectivo).
  const cashOrder = await newOrder(env, ctx, "orden-turno-cash");
  assert.equal((await payOrder(env, ctx, cookie, cashOrder.id, "pay-cash", "cobro-cash-0001")).status, 200);
  const transferOrder = await newOrder(env, ctx, "orden-turno-transfer", {
    payment_method: "transfer", items: [{ product_id: "bebida", qty: 1 }],
  });
  assert.equal((await payOrder(env, ctx, cookie, transferOrder.id, "pay-transfer", "cobro-trans-0001")).status, 200);

  // Arqueo ciego: el cajero ve sus movimientos, nunca ventas/esperado/diferencia.
  response = await current(env, cashier);
  assert.equal(response.status, 200);
  const blind = await response.json();
  assert.deepEqual(Object.keys(blind.shift).sort(),
    ["id", "movements", "opened_at", "opened_by", "opening_float_cents", "sede_id"]);
  assert.equal(blind.shift.movements.length, 2);
  assert.equal("report" in blind, false);
  const serialized = JSON.stringify(blind);
  for (const hidden of ["sales", "sales_total_cents", "expected_cash_cents", "counted_cash_cents", "difference_cents"]) {
    assert.equal(serialized.includes(`"${hidden}"`), false, `el cajero no debe ver ${hidden}`);
  }

  // El dueño sí ve el reporte parcial en vivo.
  response = await current(env, OWNER);
  const live = await response.json();
  assert.equal(live.report.status, "open");
  assert.equal(live.report.expected_cash_cents, 2000 + 1950 + 500 - 300);
  assert.equal(live.report.counted_cash_cents, null);
  assert.equal(live.report.difference_cents, null);
  assert.deepEqual(live.report.sales, [
    { method: "cash", count: 1, total_cents: 1950 },
    { method: "transfer", count: 1, total_cents: 250 },
  ]);
  assert.equal(live.report.sales_total_cents, 2200);
  // El total general iguala la suma de pagos `paid` del turno en D1.
  const dbTotal = env.DB.raw.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM pos_payments WHERE shift_id = ? AND status = 'paid'",
  ).get(shiftId).total;
  assert.equal(live.report.sales_total_cents, dbTotal);
  assert.deepEqual(live.report.movements, {
    in_cents: 500, out_cents: 300,
    items: [
      { kind: "in", amount_cents: 500, reason: "Reposición de cambio", staff_id: "l_cajero0001", created_at: entry.created_at },
      { kind: "out", amount_cents: 300, reason: "Gasto menor: hielo", staff_id: "l_cajero0001", created_at: live.report.movements.items[1].created_at },
    ],
  });
  assert.deepEqual(live.report.orders, { paid: 2, rejected: 0 });
  assert.deepEqual(live.report.pending_payments, { count: 0, total_cents: 0 });

  // Cierre: snapshot, esperado y diferencia en centavos enteros.
  response = await close(env, cashier, shiftId, 4100, "turno-cerrar-0001", "Cierre del día");
  assert.equal(response.status, 200);
  const report = (await response.json()).report;
  assert.equal(report.shift_id, shiftId);
  assert.equal(report.status, "closed");
  assert.equal(report.expected_cash_cents, 4150);
  assert.equal(report.counted_cash_cents, 4100);
  assert.equal(report.difference_cents, -50);
  assert.equal(report.closed_by, "l_cajero0001");
  assert.equal(report.note, "Cierre del día");
  assert.equal(report.sales_total_cents, 2200);
  assert.ok(report.closed_at > 0);

  const row = shiftRow(env, shiftId);
  assert.equal(row.status, "closed");
  assert.equal(Number(row.expected_cash_cents), 4150);
  assert.equal(Number(row.counted_cash_cents), 4100);
  assert.equal(Number(row.difference_cents), -50);
  assert.equal(JSON.parse(row.totals).sales_total_cents, 2200);

  // Reintento con la misma clave devuelve el mismo reporte.
  assert.deepEqual((await (await close(env, cashier, shiftId, 4100, "turno-cerrar-0001", "Cierre del día")).json()).report, report);

  // El cajero puede reimprimir el Z de su sede; el detalle coincide con el cierre.
  response = await api(env, cashier, "GET", `turnos/${shiftId}`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).report, report);

  assert.deepEqual(await (await current(env, cashier)).json(), { shift: null });
});

/* ── Una caja por sede ───────────────────────────────────────────────────── */

test("una caja por sede: índice parcial y reintento idempotente", async () => {
  const env = cajaEnv();
  const first = await open(env, OWNER, "centro", "turno-centro-0001");
  assert.equal(first.status, 201);
  const shiftId = (await first.json()).shift.id;

  const retry = await open(env, OWNER, "centro", "turno-centro-0001");
  assert.equal(retry.status, 201, "la misma clave devuelve el mismo turno");
  assert.equal((await retry.json()).shift.id, shiftId);

  const second = await open(env, OWNER, "centro", "turno-centro-0002");
  assert.equal(second.status, 409);
  assert.deepEqual(await second.json(), { error: "caja_ya_abierta" });

  // El índice parcial también frena un INSERT directo concurrente.
  assert.throws(() => env.DB.raw.prepare(
    "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
    "VALUES ('turno-duplicado', 'pizza', 'centro', 'owner', ?, 0, 'turno-duplicado')",
  ).run(Date.now()), /UNIQUE constraint failed/i);

  // Otra sede sí puede abrir su propia caja.
  assert.equal((await open(env, OWNER, "norte", "turno-norte-0001")).status, 201);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_shifts WHERE status = 'open'").get().n, 2);
});

/* ── Movimientos: validaciones e idempotencia ────────────────────────────── */

test("movimientos: validaciones, idempotencia y turno cerrado", async () => {
  const env = cajaEnv();
  const cashier = localStaff(env, "l_cajero0002", ["centro"]);
  const other = localStaff(env, "l_cajero0003", ["norte"]);
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;

  const invalid = [
    [{ kind: "otro", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-malo-0001" }, "movimiento_invalido", 400],
    [{ kind: "in", amount_cents: 0, reason: "Motivo", idempotency_key: "mov-malo-0002" }, "monto_invalido", 400],
    [{ kind: "in", amount_cents: 12.5, reason: "Motivo", idempotency_key: "mov-malo-0003" }, "monto_invalido", 400],
    [{ kind: "in", amount_cents: "500", reason: "Motivo", idempotency_key: "mov-malo-0004" }, "monto_invalido", 400],
    [{ kind: "in", amount_cents: 100, reason: "ab", idempotency_key: "mov-malo-0005" }, "motivo_invalido", 400],
    [{ kind: "in", amount_cents: 100, reason: "x".repeat(121), idempotency_key: "mov-malo-0006" }, "motivo_invalido", 400],
    [{ kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "corta" }, "idempotency_key_requerida", 400],
  ];
  for (const [payload, code, status] of invalid) {
    const response = await move(env, cashier, shiftId, payload);
    assert.equal(response.status, status, JSON.stringify(payload));
    assert.deepEqual(await response.json(), { error: code });
  }
  assert.equal((await rawPost(env, cashier, `turnos/${shiftId}/movimientos`, "no-json")).status, 400);
  assert.deepEqual(await (await move(env, cashier, shiftId, {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-otro-turno",
  })).status, 201);
  assert.deepEqual(await (await move(env, other, shiftId, {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-sin-permiso",
  })).json(), { error: "sin_permiso" });
  assert.deepEqual(await (await move(env, cashier, "turno-inexistente", {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-inexistente",
  })).json(), { error: "turno_no_existe" });

  // Un retiro mayor al esperado se permite: el arqueo lo delata.
  const big = await move(env, cashier, shiftId, {
    kind: "out", amount_cents: 99999, reason: "Depósito banco", idempotency_key: "mov-out-grande",
  });
  assert.equal(big.status, 201);
  const bigId = (await big.json()).movement.id;

  const retry = await move(env, cashier, shiftId, {
    kind: "out", amount_cents: 99999, reason: "Depósito banco", idempotency_key: "mov-out-grande",
  });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json()).movement.id, bigId);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_cash_movements").get().n, 2);
  const conflict = await move(env, cashier, shiftId, {
    kind: "out", amount_cents: 1, reason: "Depósito banco", idempotency_key: "mov-out-grande",
  });
  assert.deepEqual(await conflict.json(), { error: "idempotencia_conflicto" });

  // Cerrado: no admite movimientos nuevos.
  assert.equal((await close(env, OWNER, shiftId, 0)).status, 200);
  assert.deepEqual(await (await move(env, cashier, shiftId, {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-cerrado-0001",
  })).json(), { error: "turno_cerrado" });
});

/* ── Permisos por sede y sesión ──────────────────────────────────────────── */

test("permisos: cajero solo sus sedes, listado solo el dueño", async () => {
  const env = cajaEnv();
  const cashier = localStaff(env, "l_cajero0004", ["centro"]);
  const north = localStaff(env, "l_cajero0005", ["norte"]);
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;

  assert.deepEqual(await (await current(env, cashier, "norte")).json(), { error: "sin_permiso" });
  assert.deepEqual(await (await open(env, cashier, "norte", "turno-centro-9999")).json(), { error: "sin_permiso" });
  assert.deepEqual(await (await api(env, cashier, "GET", "turnos")).json(), { error: "sin_permiso" });

  // Un turno abierto solo lo ve el dueño (el cajero lo reimprime al cerrar).
  assert.deepEqual(await (await api(env, cashier, "GET", `turnos/${shiftId}`)).json(), { error: "sin_permiso" });
  assert.equal((await api(env, OWNER, "GET", `turnos/${shiftId}`)).status, 200);

  const closed = await close(env, OWNER, shiftId, 2000);
  assert.equal(closed.status, 200);
  assert.equal((await api(env, cashier, "GET", `turnos/${shiftId}`)).status, 200);
  assert.deepEqual(await (await api(env, north, "GET", `turnos/${shiftId}`)).json(), { error: "sin_permiso" });

  const list = await api(env, OWNER, "GET", "turnos");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).shifts.length, 1);
  assert.deepEqual(await (await api(env, OWNER, "GET", "turnos/turno-inexistente")).json(), { error: "turno_no_existe" });
});

/* ── Cobro manual: exige turno abierto ───────────────────────────────────── */

test("cobro en efectivo sin turno → 409; con turno guarda shift_id", async () => {
  const env = cajaEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx, "orden-sin-turno");

  let response = await payOrder(env, ctx, cookie, order.id, "pay-cash", "cobro-sin-turno");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_payments").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(order.id).status, "pending");

  const shiftId = (await (await open(env, OWNER)).json()).shift.id;
  response = await payOrder(env, ctx, cookie, order.id, "pay-cash", "cobro-sin-turno");
  assert.equal(response.status, 200);
  assert.equal(paymentRow(env, order.id).shift_id, shiftId);

  // Reintento tras cerrar: mismo cobro, sin exigir un turno nuevo.
  assert.equal((await close(env, OWNER, shiftId, 2000)).status, 200);
  response = await payOrder(env, ctx, cookie, order.id, "pay-cash", "cobro-sin-turno");
  assert.equal(response.status, 200);

  // La transferencia sigue la misma regla.
  const transfer = await newOrder(env, ctx, "orden-transfer-norte", {
    sede_id: "norte", payment_method: "transfer",
  });
  response = await payOrder(env, ctx, cookie, transfer.id, "pay-transfer", "cobro-trans-norte");
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  const northShift = (await (await open(env, OWNER, "norte", "turno-norte-0002")).json()).shift.id;
  response = await payOrder(env, ctx, cookie, transfer.id, "pay-transfer", "cobro-trans-norte");
  assert.equal(response.status, 200);
  assert.equal(paymentRow(env, transfer.id).shift_id, northShift);
});

/* ── Tarjeta: se confirma sin turno y se asigna al abrir ─────────────────── */

test("pago tarjeta sin turno queda null y se asigna al abrir", async () => {
  const env = cajaEnv(), ctx = makeCtx();
  env.BENDO_MODE = "mock";
  const created = await newOrder(env, ctx, "orden-bendo-turno", { payment_method: "bendo" });

  let order = await posOrderRow(env, "pizza", created.id);
  let payment = await createPaymentAttempt(env, "pizza", order, "bendo-pago-0001", "bendo");
  await settlePaymentApproved(env, "pizza", order, payment);
  assert.equal(paymentRow(env, created.id).shift_id, null, "sin turno abierto el pago no se asigna");

  const shiftId = (await (await open(env, OWNER)).json()).shift.id;
  assert.equal(paymentRow(env, created.id).shift_id, shiftId, "abrir el turno asigna los pagos paid sin turno");

  // Con turno abierto, settle asigna en el mismo batch.
  const second = await newOrder(env, ctx, "orden-bendo-turno-2", { payment_method: "bendo" });
  order = await posOrderRow(env, "pizza", second.id);
  payment = await createPaymentAttempt(env, "pizza", order, "bendo-pago-0002", "bendo");
  await settlePaymentApproved(env, "pizza", order, payment);
  assert.equal(paymentRow(env, second.id).shift_id, shiftId);

  // El reporte suma la tarjeta pero no la cuenta como efectivo esperado.
  const report = (await (await api(env, OWNER, "GET", "turnos/actual?sede_id=centro")).json()).report;
  assert.deepEqual(report.sales.map(sale => sale.method), ["bendo"]);
  assert.equal(report.sales_total_cents, 1950 + 1950);
  assert.equal(report.expected_cash_cents, 2000);
});

/* ── Turno cerrado inmutable ─────────────────────────────────────────────── */

test("turno cerrado: reporte congelado, sin movimientos ni recálculos", async () => {
  const env = cajaEnv(), ctx = makeCtx(), cookie = await ownerCookie(env);
  const order = await newOrder(env, ctx, "orden-inmutable");
  const shiftId = (await (await open(env, OWNER)).json()).shift.id;
  await payOrder(env, ctx, cookie, order.id, "pay-cash", "cobro-inmutable");
  const report = (await (await close(env, OWNER, shiftId, 2000, "cierre-inmutable")).json()).report;
  assert.equal(report.expected_cash_cents, 2000 + 1950);
  assert.equal(report.difference_cents, 2000 - 3950);

  // Se alteran las tablas por fuera de la API: el Z reimpreso no cambia.
  const now = Date.now();
  env.DB.raw.prepare(
    "INSERT INTO pos_cash_movements (id, slug, shift_id, kind, amount_cents, reason, staff_id, idempotency_key, created_at) " +
    "VALUES ('mov-post', 'pizza', ?, 'out', 9999, 'Ajuste posterior', 'owner', 'mov-post-0001', ?)",
  ).run(shiftId, now);
  env.DB.raw.prepare(
    "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, created_at, updated_at, paid_at, shift_id) " +
    "VALUES ('pago-post', 'pizza', ?, 'cash', 'pago-post-0001', 'paid', 9999, 'USD', NULL, ?, ?, ?, ?)",
  ).run(order.id, now, now, now, shiftId);

  const again = await api(env, OWNER, "GET", `turnos/${shiftId}`);
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).report, report);

  // Otra clave de cierre o un movimiento nuevo: conflicto.
  assert.deepEqual(await (await close(env, OWNER, shiftId, 0, "cierre-distinto")).json(), { error: "turno_cerrado" });
  assert.deepEqual((await (await close(env, OWNER, shiftId, 2000, "cierre-inmutable")).json()).report, report);
  assert.deepEqual(await (await move(env, OWNER, shiftId, {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-post-cierre",
  })).json(), { error: "turno_cerrado" });

  // La sede puede volver a abrir; los pagos del turno cerrado no se reasignan.
  const next = (await (await open(env, OWNER, "centro", "turno-siguiente-0001")).json()).shift;
  assert.notEqual(next.id, shiftId);
  const original = env.DB.raw.prepare(
    "SELECT shift_id FROM pos_payments WHERE order_id = ? AND idempotency_key = 'cobro-inmutable'",
  ).get(order.id);
  assert.equal(original.shift_id, shiftId);
});

/* ── Listado: dueño, rango de fechas de Ecuador y límite ─────────────────── */

test("listado: solo dueño, fechas de Ecuador, límite y totales", async () => {
  const env = cajaEnv();
  const cashier = localStaff(env, "l_cajero0006", ["centro"]);
  const insert = ({ id, sede, status, openedAt, closedAt = null, expected = null, counted = null, difference = null, totals = null }) =>
    env.DB.raw.prepare(
      "INSERT INTO pos_shifts (id, slug, sede_id, status, opened_by, opened_at, opening_float_cents, open_key, " +
      "closed_by, closed_at, close_key, counted_cash_cents, expected_cash_cents, difference_cents, totals, note) " +
      "VALUES (?, 'pizza', ?, ?, 'owner', ?, 1000, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).run(
      id, sede, status, openedAt, `key-${id}`, status === "closed" ? "owner" : null, closedAt,
      status === "closed" ? `close-${id}` : null, counted, expected, difference,
      totals ? JSON.stringify(totals) : null,
    );
  // 2026-11-11 02:00 UTC = 2026-11-10 21:00 en America/Guayaquil.
  insert({
    id: "turno-a", sede: "centro", status: "closed", openedAt: Date.UTC(2026, 10, 11, 2, 0),
    closedAt: Date.UTC(2026, 10, 11, 3, 0), expected: 900, counted: 950, difference: 50,
    totals: { sales: [], movements: { in_cents: 0, out_cents: 0, items: [] }, sales_total_cents: 1234 },
  });
  insert({
    id: "turno-b", sede: "centro", status: "closed", openedAt: Date.UTC(2026, 10, 11, 15, 0),
    closedAt: Date.UTC(2026, 10, 11, 16, 0), expected: 1000, counted: 900, difference: -100,
    totals: { sales: [], movements: { in_cents: 0, out_cents: 0, items: [] }, sales_total_cents: 500 },
  });
  insert({ id: "turno-c", sede: "norte", status: "open", openedAt: Date.UTC(2026, 10, 12, 15, 0) });

  assert.deepEqual(await (await api(env, cashier, "GET", "turnos")).json(), { error: "sin_permiso" });

  // 2026-11-10 incluye el turno abierto a las 21:00 locales (UTC ya es día 11).
  let list = await (await api(env, OWNER, "GET", "turnos?from=2026-11-10&to=2026-11-10")).json();
  assert.deepEqual(list.shifts.map(shift => shift.id), ["turno-a"]);
  assert.deepEqual(Object.keys(list.shifts[0]).sort(), [
    "closed_at", "closed_by", "counted_cash_cents", "difference_cents", "expected_cash_cents", "id",
    "opened_at", "opened_by", "opening_float_cents", "sede_id", "status", "total_cents",
  ]);
  assert.equal(list.shifts[0].total_cents, 1234, "el cerrado usa el snapshot del cierre");
  assert.equal(list.shifts[0].difference_cents, 50);

  // El día anterior no tiene turnos: la apertura UTC del 11 es del 10 local.
  assert.deepEqual((await (await api(env, OWNER, "GET", "turnos?from=2026-11-09&to=2026-11-09")).json()).shifts, []);

  list = await (await api(env, OWNER, "GET", "turnos?from=2026-11-11&to=2026-11-12&limit=50")).json();
  assert.deepEqual(list.shifts.map(shift => shift.id), ["turno-c", "turno-b"]);
  assert.equal(list.shifts[0].total_cents, 0, "el abierto suma sus pagos (ninguno)");
  assert.equal(list.shifts[0].expected_cash_cents, null);

  list = await (await api(env, OWNER, "GET", "turnos?sede_id=norte&from=2026-11-11&to=2026-11-12")).json();
  assert.deepEqual(list.shifts.map(shift => shift.id), ["turno-c"]);
  list = await (await api(env, OWNER, "GET", "turnos?limit=1")).json();
  assert.equal(list.shifts.length, 1);
  assert.equal(list.shifts[0].id, "turno-c");

  for (const query of ["limit=51", "limit=0", "limit=abc", "from=2026-11-10", "from=2026-02-30&to=2026-03-01"]) {
    const response = await api(env, OWNER, "GET", `turnos?${query}`);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, query.startsWith("limit") ? "paginacion_invalida" : "fechas_invalidas");
  }
});
