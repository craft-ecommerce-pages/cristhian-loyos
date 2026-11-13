// Pedido Munch: datos fiscales obligatorios sin PII pública, transferencia
// confirmada en caja, transición paid→ready y retiro de la pasarela antigua
// (los métodos de tarjeta nuevos solo se aceptan vía Bendo).
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
const withCookie = (path, cookie, options = {}) => request(path, { ...options, headers: { cookie, ...(options.headers || {}) } });

const margarita = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

function pedidoEnv() {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }, { nombre: "Norte", direccion: "Calle 2" }] },
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita] }), Date.now());
  return env;
}
async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
async function staffCookie(env, owner, sedes, pin = "1234") {
  await panel.fetch(body("/panel/api/loyalty/staff", { name: "Ana", pin, sedes }, { headers: { cookie: owner } }), env, makeCtx());
  const login = await panel.fetch(body("/panel/api/mesero/login", { pin }), env, makeCtx());
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const billing = (overrides = {}) => ({
  document_type: "cedula", document_number: "1712345678",
  email: "ana@example.com", address: "Av. Siempre Viva 123", ...overrides,
});
const webOrder = (overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: "pedido-0001-abcd",
  items: [{ product_id: "margarita", qty: 1 }],
  customer: { name: "Ana", phone: "0991234567", billing: billing() },
  delivery_mode: "pickup",
  ...overrides,
});
const rowOf = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const comandas = (env, id) => env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?").get(id).n;
// Desde 0012, efectivo y transferencia exigen un turno abierto en la sede.
const openShift = (env, sede = "centro") => env.DB.raw.prepare(
  "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
  "VALUES (?, ?, ?, 'test', ?, 0, ?)",
).run(`turno-${sede}`, "pizza", sede, Date.now(), `turno-${sede}`);

test("pedido web exige datos fiscales completos, válidos y normalizados", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  const cases = [
    [{ customer: { name: "Ana", phone: "0991234567" } }, "billing"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ document_type: undefined }) } }, "billing.document_type"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ document_type: "pasaporte" }) } }, "billing.document_type"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ document_number: "123" }) } }, "billing.document_number"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ document_type: "ruc", document_number: "1712345678" }) } }, "billing.document_number"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ email: "no-es-correo" }) } }, "billing.email"],
    [{ customer: { name: "Ana", phone: "0991234567", billing: billing({ address: "" }) } }, "billing.address"],
    [{ customer: { name: "Ana", phone: "099" } }, "customer.phone"],
    [{ customer: { name: "  ", phone: "0991234567", billing: billing() } }, "customer.name"],
  ];
  let key = 0;
  for (const [overrides, campo] of cases) {
    const response = await panel.fetch(body("/api/orders", webOrder({
      ...overrides, idempotency_key: `fiscal-${String(key++).padStart(4, "0")}`,
    })), env, ctx);
    assert.equal(response.status, 400, `caso ${campo}`);
    const payload = await response.json();
    assert.equal(payload.campo, campo);
    assert.ok(payload.error === "datos_fiscales_requeridos" || payload.error === "datos_fiscales_invalidos" ||
      payload.error === "cliente_requerido" || payload.error === "telefono_invalido", JSON.stringify(payload));
  }
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_orders").get().n, 0);

  // RUC con 13 dígitos y correo con mayúsculas: válidos y normalizados en D1.
  const ok = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "fiscal-ok-0001",
    customer: {
      name: " Luis ", phone: "0991234567",
      billing: billing({ document_type: "RUC", document_number: "1790012345001", email: " LUIS@Example.COM " }),
    },
  })), env, ctx);
  assert.equal(ok.status, 201);
  const created = await ok.json();
  const row = rowOf(env, created.id);
  assert.equal(row.billing_document_type, "ruc");
  assert.equal(row.billing_document_number, "1790012345001");
  assert.equal(row.billing_email, "luis@example.com");
  assert.equal(row.billing_address, "Av. Siempre Viva 123");
  // La creación tampoco devuelve PII fiscal.
  const serialized = JSON.stringify(created);
  for (const secret of ["1790012345001", "luis@example.com", "Siempre Viva", "0991234567"]) {
    assert.equal(serialized.includes(secret), false, `no debe devolver ${secret}`);
  }
  // La captura fiscal no emite factura por sí sola.
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM invoices").get().n, 0);
});

test("misma clave con datos fiscales distintos es conflicto, no sobrescritura", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  const first = await panel.fetch(body("/api/orders", webOrder()), env, ctx);
  assert.equal(first.status, 201);
  const changed = await panel.fetch(body("/api/orders", webOrder({
    customer: { name: "Ana", phone: "0991234567", billing: billing({ document_number: "1790012345001", document_type: "ruc" }) },
  })), env, ctx);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "idempotencia_conflicto" });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_orders").get().n, 1);
});

test("transferencia: la caja confirma manualmente, con sede autorizada e idempotencia", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "transfer-0001", payment_method: "transfer",
  })), env, ctx)).json();
  const transfer = () => panel.fetch(body(`/panel/api/orders/${created.id}/pay-transfer`, { idempotency_key: "tr-00001" }, { headers: { cookie: owner } }), env, ctx);

  const before = await (await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx)).json();
  assert.equal(before.payment_status, "pending", "transferencia sin confirmar no se muestra pagada");

  openShift(env);
  let response = await transfer();
  assert.equal(response.status, 200);
  const paid = await response.json();
  assert.equal(paid.order.status, "paid");
  assert.equal(paid.order.payment_method, "transfer");
  assert.equal(paid.payment.provider, "transfer");
  assert.ok(Number(paid.order.paid_at) > 0);
  assert.equal(comandas(env, created.id), 1);
  assert.equal(env.DB.raw.prepare("SELECT provider FROM pos_payments WHERE order_id = ?").get(created.id).provider, "transfer");

  // Repetir la clave no duplica pago, comanda ni líneas.
  response = await transfer();
  assert.equal(response.status, 200);
  assert.equal(comandas(env, created.id), 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_payments WHERE order_id = ?").get(created.id).n, 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM pos_order_lines WHERE order_id = ?").get(created.id).n, 1);

  // El estado público confirma método y estado reales, sin PII.
  const status = await (await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx)).json();
  assert.equal(status.payment_method, "transfer");
  assert.equal(status.status, "paid");
  assert.equal(status.payment_status, "paid");
  assert.equal(status.retryable, false);
  assert.deepEqual(status.items, [{ name: "Margarita", qty: 1, unit_cents: 850, subtotal_cents: 850 }]);

  // Un pedido de efectivo no se puede liquidar como transferencia (ni al revés).
  const cashOrder = await (await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "transfer-0002" })), env, ctx)).json();
  response = await panel.fetch(body(`/panel/api/orders/${cashOrder.id}/pay-transfer`, { idempotency_key: "tr-00002" }, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "metodo_pago_invalido" });
  response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "tr-00003" }, { headers: { cookie: owner } }), env, ctx);
  assert.equal(response.status, 409);
});

test("estado público del pedido: efectivo pendiente y pagado, sin PII", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  const created = await (await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "estado-efectivo" })), env, ctx)).json();
  const read = async () => (await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx)).json();
  let status = await read();
  assert.equal(status.status, "pending");
  assert.equal(status.payment_method, "cash");
  assert.equal(status.payment_status, "pending");
  assert.equal(status.retryable, false);
  assert.equal(status.items.length, 1);
  for (const secret of ["1712345678", "ana@example.com", "Siempre Viva", "0991234567", "Ana"]) {
    assert.equal(JSON.stringify(status).includes(secret), false, `no expone ${secret}`);
  }
  const owner = await ownerCookie(env);
  openShift(env);
  await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "estado-cash" }, { headers: { cookie: owner } }), env, ctx);
  status = await read();
  assert.equal(status.status, "paid");
  assert.equal(status.payment_status, "paid");
});

test("transferencia: un operador de otra sede no puede confirmarla", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  const cookie = await staffCookie(env, owner, ["centro"]);
  const north = await (await panel.fetch(body("/api/orders", webOrder({
    sede_id: "norte", idempotency_key: "transfer-norte-01", payment_method: "transfer",
  })), env, ctx)).json();
  const response = await panel.fetch(body(`/panel/api/orders/${north.id}/pay-transfer`, { idempotency_key: "tr-norte" }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });
  assert.equal(comandas(env, north.id), 0);
});

test("paid → ready: auth por sede, marca de tiempo e idempotencia", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  delete env.LOYALTY;
  delete env.LOYALTY_ADMIN_TOKEN;
  const owner = await ownerCookie(env);
  const cookie = await staffCookie(env, owner, ["centro"]);
  const created = await (await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "ready-0001" })), env, ctx)).json();

  let response = await panel.fetch(body(`/panel/api/orders/${created.id}/ready`, {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 409, "no se marca listo antes del cobro");

  openShift(env);
  await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "ready-cash" }, { headers: { cookie: owner } }), env, ctx);
  response = await panel.fetch(body(`/panel/api/orders/${created.id}/ready`, {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  const ready = (await response.json()).order;
  assert.equal(ready.status, "ready");
  assert.ok(Number(ready.ready_at) > 0);
  assert.equal(ready.paid_at <= ready.ready_at, true);

  // Repetir conserva la misma marca.
  response = await panel.fetch(body(`/panel/api/orders/${created.id}/ready`, {}, { headers: { cookie } }), env, ctx);
  assert.equal((await response.json()).order.ready_at, ready.ready_at);
  // La comanda sigue siendo una y va ligada al cobro.
  assert.equal(comandas(env, created.id), 1);

  const status = await (await panel.fetch(request(`/api/orders/${created.id}?token=${created.order_token}`), env, ctx)).json();
  assert.equal(status.status, "ready");
  assert.equal(status.ready_at, ready.ready_at);
  assert.equal(status.payment_status, "paid");

  // `ready` en D1 sigue siendo `paid` + ready_at: filtros, KDS y reimpresión intactos.
  const row = rowOf(env, created.id);
  assert.equal(row.status, "paid");
  assert.equal(row.ready_at, ready.ready_at);
  const readyList = await (await panel.fetch(withCookie("/panel/api/pos/orders?status=ready&sede_id=centro", cookie), env, ctx)).json();
  assert.ok(readyList.orders.some(order => order.id === created.id && order.status === "ready"));
  const paidList = await (await panel.fetch(withCookie("/panel/api/pos/orders?status=paid&sede_id=centro", cookie), env, ctx)).json();
  assert.ok(paidList.orders.some(order => order.id === created.id), "pagados incluye los listos");
  const kitchen = await (await panel.fetch(withCookie("/panel/api/kitchen/orders?sede_id=centro&since=0", cookie), env, ctx)).json();
  assert.ok(kitchen.orders.some(order => order.id === created.id), "el KDS conserva la comanda pagada");
  const reprint = await panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, { idempotency_key: "ready-reprint" }, { headers: { cookie } }), env, ctx);
  assert.equal(reprint.status, 200, "la reimpresión de una orden lista cuenta el acuse");
  assert.equal((await reprint.json()).print_count, 1);

  // Operador de otra sede no puede marcar listo.
  const north = await (await panel.fetch(body("/api/orders", webOrder({ sede_id: "norte", idempotency_key: "ready-0002" })), env, ctx)).json();
  openShift(env, "norte");
  await panel.fetch(body(`/panel/api/orders/${north.id}/pay-cash`, { idempotency_key: "ready-cash-2" }, { headers: { cookie: owner } }), env, ctx);
  response = await panel.fetch(body(`/panel/api/orders/${north.id}/ready`, {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 403);
});

test("Payphone retirado: no se acepta en pedidos nuevos y su retorno ya no existe", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  const created = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "payphone-retirado", payment_method: "payphone",
  })), env, ctx);
  assert.equal(created.status, 400);
  assert.deepEqual(await created.json(), { error: "metodo_pago_invalido" });

  const returned = await panel.fetch(
    request("/api/payphone/return?id=9001&clientTransactionId=ABCDEFGHJKLMNPQ"), env, ctx,
  );
  assert.equal(returned.status, 404);
  assert.deepEqual(await returned.json(), { error: "ruta_no_encontrada" });
});

test("opciones de pago: transferencia solo con cuenta y WhatsApp oficiales", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  let options = await (await panel.fetch(request("/api/payment-options"), env, ctx)).json();
  assert.equal(options.transfer, false, "sin config no se habilita ni se inventan cuentas");
  assert.equal(options.transfer_details, null);

  const config = await env.MENUS.get("pizza:config", "json");
  config.location = { ...(config.location || {}), telefono_principal: "0991234567" };
  config.bank_transfer = {
    bank: "Banco Pichincha", account_type: "Ahorros", account_number: "2200123456",
    holder: "Munch S.A.S.", note: "Cuenta oficial del local",
    holder_document: "1790012345001", // nunca debe publicarse
  };
  await env.MENUS.put("pizza:config", JSON.stringify(config));
  options = await (await panel.fetch(request("/api/payment-options"), env, ctx)).json();
  assert.equal(options.transfer, true);
  assert.deepEqual(options.transfer_details, {
    bank: "Banco Pichincha", account_type: "Ahorros", account_number: "2200123456",
    holder: "Munch S.A.S.", note: "Cuenta oficial del local",
  });
  assert.equal(JSON.stringify(options).includes("1790012345001"), false, "no expone el RUC del titular");

  // Sin WhatsApp oficial de comprobantes no se habilita la transferencia.
  delete config.location.telefono_principal;
  delete config.whatsapp_number;
  await env.MENUS.put("pizza:config", JSON.stringify(config));
  options = await (await panel.fetch(request("/api/payment-options"), env, ctx)).json();
  assert.equal(options.transfer, false, "sin WhatsApp de comprobantes se deshabilita");

  // Configuración incompleta: se deshabilita en vez de mostrar una cuenta a medias.
  config.location.telefono_principal = "0991234567";
  config.bank_transfer = { bank: "Banco Pichincha" };
  await env.MENUS.put("pizza:config", JSON.stringify(config));
  options = await (await panel.fetch(request("/api/payment-options"), env, ctx)).json();
  assert.equal(options.transfer, false);
  assert.equal(options.transfer_details, null);
});

test("la creación web no escribe analítica con PII fiscal", async () => {
  const env = pedidoEnv(), ctx = makeCtx();
  await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "analytics-0001" })), env, ctx);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM events_daily").get().n, 0);
  const row = env.DB.raw.prepare("SELECT * FROM pos_orders").get();
  assert.equal(row.billing_document_number, "1712345678", "el dato fiscal queda solo en D1");
});
