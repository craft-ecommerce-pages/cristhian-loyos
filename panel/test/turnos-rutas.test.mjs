// Turnos y cierre de caja de extremo a extremo por el handler del Worker
// (`panel.fetch`): sesión de cajero por PIN y del dueño, cobro con caja cerrada,
// pago con tarjeta sin turno asignado al abrir, movimientos, cierre ciego y
// reporte que cuadra con la suma de pagos del turno. Sin red: Bendo va en mock.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { hashPassword, sha256hex } from "../src/auth.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "munch.example";
const origin = `https://${host}`;
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie, options = {}) => request(path, { ...options, headers: { cookie, ...(options.headers || {}) } });
const jsonAccept = { headers: { accept: "application/json" } };

const margarita = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };
const bebida = { ...margarita, id: "bebida", name: "Cola", price: "2.50" };

/* ── Entorno, sesiones y utilidades ──────────────────────────────────────── */

function cajaEnv() {
  const env = makeEnv({
    "munch:config": {
      currency: "USD", store_name: "Munch",
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }, { id: "norte", nombre: "Norte", direccion: "Calle 2" }] },
    },
  });
  env.CLIENT_SLUG = "munch";
  env.BENDO_MODE = "mock";
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

// Cajero local con PIN real en D1: la sesión se crea por /panel/api/mesero/login.
async function cashierCookie(env, id, sedes, pin = "2468") {
  const now = Date.now();
  env.DB.raw.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('munch', ?, 'Ana', ?, ?, ?, 1, ?, ?)",
  ).run(id, await sha256hex(`munch:${pin}`), await hashPassword(pin), JSON.stringify(sedes), now, now);
  const login = await panel.fetch(body("/panel/api/mesero/login", { pin }), env, {});
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

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

const pay = (env, cookie, id, route, key) =>
  panel.fetch(body(`/panel/api/orders/${id}/${route}`, { idempotency_key: key }, { headers: { cookie } }), env, {});

// Rutas turnos/* por el handler del Worker: GET sin cuerpo, POST con JSON.
const turno = (env, path, cookie, value) => value === undefined
  ? panel.fetch(withCookie(`/panel/api/${path}`, cookie, jsonAccept), env, {})
  : panel.fetch(body(`/panel/api/${path}`, value, { headers: { cookie } }), env, {});

const shiftRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_shifts WHERE id = ?").get(id);
const paymentRow = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_payments WHERE order_id = ? ORDER BY created_at DESC, rowid DESC").get(id);
const paidTotal = (env, shiftId) => env.DB.raw.prepare(
  "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM pos_payments WHERE shift_id = ? AND status = 'paid'",
).get(shiftId).total;

/* ── Apertura: PIN de cajero y sesión del dueño ──────────────────────────── */

test("abrir turno: cajero por PIN y dueño, arqueo ciego y una caja por sede", async () => {
  const env = cajaEnv();
  const cashier = await cashierCookie(env, "l_cajero0001", ["centro"]);

  // Sin sesión, las rutas de turnos no existen para el público.
  assert.equal((await panel.fetch(request("/panel/api/turnos/actual?sede_id=centro"), env, {})).status, 401);
  assert.equal((await panel.fetch(request("/panel/api/turnos"), env, {})).status, 401);

  // Caja cerrada: el cajero ve {shift:null} y nada más.
  let response = await turno(env, "turnos/actual?sede_id=centro", cashier);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { shift: null });

  // Abre el cajero con fondo en centavos enteros.
  response = await turno(env, "turnos/abrir", cashier, {
    sede_id: "centro", opening_float_cents: 2000, idempotency_key: "turno-abrir-0001",
  });
  assert.equal(response.status, 201);
  const opened = await response.json();
  assert.deepEqual(Object.keys(opened.shift).sort(),
    ["id", "movements", "opened_at", "opened_by", "opening_float_cents", "sede_id"]);
  assert.equal(opened.shift.sede_id, "centro");
  assert.equal(opened.shift.opened_by, "l_cajero0001");
  assert.equal(opened.shift.opening_float_cents, 2000);
  assert.deepEqual(opened.shift.movements, []);
  const shiftId = opened.shift.id;
  assert.equal(shiftRow(env, shiftId).status, "open");

  // Misma clave: mismo turno (idempotente). Otra clave: 409 caja_ya_abierta.
  response = await turno(env, "turnos/abrir", cashier, {
    sede_id: "centro", opening_float_cents: 2000, idempotency_key: "turno-abrir-0001",
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).shift.id, shiftId);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_shifts").get().n, 1);
  response = await turno(env, "turnos/abrir", cashier, {
    sede_id: "centro", opening_float_cents: 5000, idempotency_key: "turno-abrir-0002",
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_ya_abierta" });

  // El cajero no puede abrir en una sede que no tiene autorizada.
  response = await turno(env, "turnos/abrir", cashier, {
    sede_id: "norte", opening_float_cents: 1000, idempotency_key: "turno-abrir-0003",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });

  // El dueño sí abre la caja de otra sede y ve el reporte parcial en vivo.
  const owner = await ownerCookie(env);
  response = await turno(env, "turnos/abrir", owner, {
    sede_id: "norte", opening_float_cents: 1000, idempotency_key: "turno-abrir-0004",
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).shift.sede_id, "norte");

  response = await turno(env, "turnos/actual?sede_id=centro", owner);
  const live = await response.json();
  assert.equal(live.shift.id, shiftId);
  assert.equal(live.report.status, "open");
  assert.equal(live.report.expected_cash_cents, 2000);

  // El cajero sigue ciego: ni el reporte ni los totales viajan en su respuesta.
  const blind = JSON.stringify(await (await turno(env, "turnos/actual?sede_id=centro", cashier)).json());
  for (const hidden of ["report", "sales", "sales_total_cents", "expected_cash_cents", "difference_cents"]) {
    assert.equal(blind.includes(`"${hidden}"`), false, `el cajero no debe ver ${hidden}`);
  }
});

/* ── Cobro manual: caja cerrada no cobra ─────────────────────────────────── */

test("cobro manual: sin turno 409 caja_cerrada; con turno el pago queda en el turno", async () => {
  const env = cajaEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);
  const cashOrder = await newOrder(env, ctx, "orden-caja-cash");

  let response = await pay(env, owner, cashOrder.id, "pay-cash", "cobro-cash-0001");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_payments").get().n, 0, "no se guarda intento");

  const shiftId = (await (await turno(env, "turnos/abrir", owner, {
    sede_id: "centro", opening_float_cents: 0, idempotency_key: "turno-abrir-0005",
  })).json()).shift.id;

  response = await pay(env, owner, cashOrder.id, "pay-cash", "cobro-cash-0001");
  assert.equal(response.status, 200);
  assert.equal(paymentRow(env, cashOrder.id).shift_id, shiftId);
  assert.equal(Number(paymentRow(env, cashOrder.id).amount_cents), 1950);

  // Transferencia igual: exige turno abierto y se contabiliza sin sumar al efectivo.
  const transferOrder = await newOrder(env, ctx, "orden-caja-transfer", {
    payment_method: "transfer", items: [{ product_id: "bebida", qty: 1 }],
  });
  response = await pay(env, owner, transferOrder.id, "pay-transfer", "cobro-trans-0001");
  assert.equal(response.status, 200);
  assert.equal(paymentRow(env, transferOrder.id).shift_id, shiftId);
});

/* ── Tarjeta (Bendo) sin turno ───────────────────────────────────────────── */

test("pago Bendo sin turno queda sin turno y se asigna al abrir la caja", async () => {
  const env = cajaEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);

  // Pedido web con tarjeta en la sede sin caja abierta.
  const order = await newOrder(env, ctx, "orden-bendo-sin-turno", {
    sede_id: "norte", payment_method: "bendo", items: [{ product_id: "margarita", qty: 1 }],
  });
  assert.equal(order.payment_method, "bendo");
  const link = await (await panel.fetch(body(`/api/orders/${order.id}/bendo`, {
    order_token: order.order_token, idempotency_key: "bendo-pago-0001",
  }), env, ctx)).json();
  assert.match(link.payment_url, /^https:\/\/munch\.example\/api\/bendo\/mock\?p=/);

  // El simulador de Bendo aprueba y el return verifica contra el link.
  const mock = await panel.fetch(request(`/api/bendo/mock?p=${link.payment_id}&resultado=aprobado`), env, {});
  assert.equal(mock.status, 302);
  const returned = await panel.fetch(request(`/api/bendo/return?p=${link.payment_id}`, jsonAccept), env, {});
  assert.equal(returned.status, 200);
  assert.deepEqual(await returned.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });

  // Se cobró la tarjeta aunque la caja esté cerrada, pero queda sin turno.
  const payment = paymentRow(env, order.id);
  assert.equal(payment.status, "paid");
  assert.equal(payment.provider, "bendo");
  assert.equal(payment.shift_id, null);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_shifts").get().n, 0);

  // Al abrir la caja de la sede, el pago sin turno entra en el nuevo turno.
  const shiftId = (await (await turno(env, "turnos/abrir", owner, {
    sede_id: "norte", opening_float_cents: 1000, idempotency_key: "turno-abrir-0006",
  })).json()).shift.id;
  assert.equal(paymentRow(env, order.id).shift_id, shiftId);

  // El reporte del turno lo lista como venta con tarjeta y el total cuadra.
  const report = (await (await turno(env, "turnos/actual?sede_id=norte", owner)).json()).report;
  assert.deepEqual(report.sales, [{ method: "bendo", count: 1, total_cents: 850 }]);
  assert.equal(report.sales_total_cents, paidTotal(env, shiftId));
  assert.equal(report.expected_cash_cents, 1000, "la tarjeta no infla el efectivo esperado");
});

/* ── Movimiento, cierre ciego y reporte conciliado ───────────────────────── */

test("movimiento y cierre: arqueo ciego, diferencia y reporte que cuadra con los pagos", async () => {
  const env = cajaEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);
  const cashier = await cashierCookie(env, "l_cajero0002", ["centro"]);

  const shiftId = (await (await turno(env, "turnos/abrir", cashier, {
    sede_id: "centro", opening_float_cents: 2000, idempotency_key: "turno-abrir-0007",
  })).json()).shift.id;

  // Movimientos de efectivo con motivo; el cajero registra ambos.
  let response = await turno(env, `turnos/${shiftId}/movimientos`, cashier, {
    kind: "in", amount_cents: 500, reason: "Reposición de cambio", idempotency_key: "mov-in-0001",
  });
  assert.equal(response.status, 201);
  const entry = (await response.json()).movement;
  assert.deepEqual(Object.keys(entry).sort(),
    ["amount_cents", "created_at", "id", "kind", "reason", "shift_id", "staff_id"]);
  assert.equal(entry.kind, "in");
  assert.equal(entry.amount_cents, 500);
  assert.equal(entry.shift_id, shiftId);
  assert.equal(entry.staff_id, "l_cajero0002");

  response = await turno(env, `turnos/${shiftId}/movimientos`, cashier, {
    kind: "out", amount_cents: 300, reason: "Gasto menor: hielo", idempotency_key: "mov-out-0001",
  });
  assert.equal(response.status, 201);

  // Reintento de la misma mutación: no duplica.
  response = await turno(env, `turnos/${shiftId}/movimientos`, cashier, {
    kind: "out", amount_cents: 300, reason: "Gasto menor: hielo", idempotency_key: "mov-out-0001",
  });
  assert.equal(response.status, 201);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_cash_movements").get().n, 2);

  // Cobros del turno: efectivo 1950 y transferencia 250.
  const cashOrder = await newOrder(env, ctx, "orden-cierre-cash");
  assert.equal((await pay(env, owner, cashOrder.id, "pay-cash", "cobro-cash-0002")).status, 200);
  const transferOrder = await newOrder(env, ctx, "orden-cierre-transfer", {
    payment_method: "transfer", items: [{ product_id: "bebida", qty: 1 }],
  });
  assert.equal((await pay(env, owner, transferOrder.id, "pay-transfer", "cobro-trans-0002")).status, 200);

  // El dueño ve el parcial; el cajero no ve esperado ni diferencia.
  const live = (await (await turno(env, "turnos/actual?sede_id=centro", owner)).json()).report;
  assert.equal(live.expected_cash_cents, 2000 + 1950 + 500 - 300);
  const blind = await (await turno(env, "turnos/actual?sede_id=centro", cashier)).json();
  assert.equal(blind.shift.movements.length, 2);
  assert.equal("report" in blind, false);
  for (const hidden of ["sales", "sales_total_cents", "expected_cash_cents", "counted_cash_cents", "difference_cents"]) {
    assert.equal(JSON.stringify(blind).includes(`"${hidden}"`), false, `el cajero no debe ver ${hidden}`);
  }

  // Cierre: el cajero solo envía lo contado; el servidor calcula la diferencia.
  response = await turno(env, `turnos/${shiftId}/cerrar`, cashier, {
    counted_cash_cents: 4100, note: "Cierre del día", idempotency_key: "turno-cerrar-0001",
  });
  assert.equal(response.status, 200);
  const report = (await response.json()).report;
  assert.deepEqual(Object.keys(report).sort(), [
    "closed_at", "closed_by", "counted_cash_cents", "difference_cents", "expected_cash_cents",
    "movements", "note", "opened_at", "opened_by", "opening_float_cents", "orders",
    "pending_payments", "sales", "sales_total_cents", "sede_id", "shift_id", "status",
  ]);
  assert.equal(report.status, "closed");
  assert.equal(report.shift_id, shiftId);
  assert.equal(report.expected_cash_cents, 4150);
  assert.equal(report.counted_cash_cents, 4100);
  assert.equal(report.difference_cents, -50);
  assert.equal(report.closed_by, "l_cajero0002");
  assert.equal(report.note, "Cierre del día");

  // El reporte cuadra con la suma de pagos `paid` del turno en D1.
  assert.equal(report.sales_total_cents, paidTotal(env, shiftId));
  assert.equal(report.sales_total_cents, report.sales.reduce((sum, sale) => sum + sale.total_cents, 0));
  assert.deepEqual(report.sales, [
    { method: "cash", count: 1, total_cents: 1950 },
    { method: "transfer", count: 1, total_cents: 250 },
  ]);
  assert.deepEqual(report.movements, {
    in_cents: 500, out_cents: 300,
    items: [
      { kind: "in", amount_cents: 500, reason: "Reposición de cambio", staff_id: "l_cajero0002", created_at: entry.created_at },
      { kind: "out", amount_cents: 300, reason: "Gasto menor: hielo", staff_id: "l_cajero0002", created_at: report.movements.items[1].created_at },
    ],
  });

  // El turno cerrado es inmutable y la caja deja de cobrar.
  assert.equal(shiftRow(env, shiftId).status, "closed");
  assert.equal(JSON.parse(shiftRow(env, shiftId).totals).sales_total_cents, 2200);
  response = await pay(env, owner, (await newOrder(env, ctx, "orden-post-cierre")).id, "pay-cash", "cobro-cash-0003");
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "caja_cerrada" });
  assert.deepEqual(await (await turno(env, `turnos/${shiftId}/movimientos`, cashier, {
    kind: "in", amount_cents: 100, reason: "Motivo", idempotency_key: "mov-cerrado-0001",
  })).json(), { error: "turno_cerrado" });
  assert.deepEqual(await (await turno(env, `turnos/${shiftId}/cerrar`, cashier, {
    counted_cash_cents: 4100, idempotency_key: "turno-cerrar-0001",
  })).json(), { report }, "misma clave: mismo reporte");

  // El cajero reimprime el Z de su sede; el detalle coincide con el cierre.
  assert.deepEqual((await (await turno(env, `turnos/${shiftId}`, cashier)).json()).report, report);
  assert.deepEqual(await (await turno(env, "turnos/actual?sede_id=centro", cashier)).json(), { shift: null });
});

/* ── Historial: solo el dueño ────────────────────────────────────────────── */

test("listado de turnos: solo el dueño, con totales del snapshot y filtros", async () => {
  const env = cajaEnv(), ctx = makeCtx();
  const owner = await ownerCookie(env);
  const cashier = await cashierCookie(env, "l_cajero0003", ["centro"]);

  const shiftId = (await (await turno(env, "turnos/abrir", cashier, {
    sede_id: "centro", opening_float_cents: 1000, idempotency_key: "turno-abrir-0008",
  })).json()).shift.id;
  assert.equal((await pay(env, owner, (await newOrder(env, ctx, "orden-historial")).id, "pay-cash", "cobro-cash-0004")).status, 200);
  assert.equal((await turno(env, `turnos/${shiftId}/cerrar`, cashier, {
    counted_cash_cents: 2950, idempotency_key: "turno-cerrar-0002",
  })).status, 200);

  // El cajero no lista turnos, en ninguna variante.
  let response = await turno(env, "turnos", cashier);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });

  response = await turno(env, "turnos", owner);
  assert.equal(response.status, 200);
  const { shifts } = await response.json();
  assert.equal(shifts.length, 1);
  const row = shifts[0];
  assert.equal(row.id, shiftId);
  assert.equal(row.status, "closed");
  assert.equal(row.opening_float_cents, 1000);
  assert.equal(row.expected_cash_cents, 2950);
  assert.equal(row.counted_cash_cents, 2950);
  assert.equal(row.difference_cents, 0);
  assert.equal(row.total_cents, 1950);

  // Filtro por sede y fechas de Ecuador: la otra sede no aparece.
  response = await turno(env, "turnos?sede_id=norte", owner);
  assert.deepEqual(await response.json(), { shifts: [] });
  const today = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  response = await turno(env, `turnos?from=${today}&to=${today}&limit=50`, owner);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).shifts.map(shift => shift.id), [shiftId]);

  // Rango inválido y límite fuera de 1–50 se rechazan.
  assert.equal((await panel.fetch(withCookie("/panel/api/turnos?from=2026-13-01&to=2026-13-02", owner, jsonAccept), env, {})).status, 400);
  assert.equal((await panel.fetch(withCookie("/panel/api/turnos?limit=51", owner, jsonAccept), env, {})).status, 400);
});
