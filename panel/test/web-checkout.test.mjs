// Autopedido web rápido: consumidor final por defecto (billing opcional, solo
// obligatorio por encima de USD 50.00, límite del SRI) y efectivo apagado salvo
// `web_cash: true` en la configuración del menú. La caja no cambia.
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

const product = (id, name, price) => ({
  id, name, type: "producto", price, promo_price: "", sku: "", description: "", stock: null,
  active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
});
const margarita = product("margarita", "Margarita", "8.50"); // USD 8.50
const limite = product("limite", "Combo límite", "50.00");    // USD 50.00: borde del consumidor final
const combo = product("combo", "Combo familiar", "60.00");    // USD 60.00: exige datos fiscales

function webEnv(config = {}) {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] },
      ...config,
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({
      categories: [], packagings: [], variant_groups: [], products: [margarita, limite, combo],
    }), Date.now());
  return env;
}

// Pedido web sin datos fiscales, pagado por transferencia (el método por defecto del menú).
const webOrder = (overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: "web-0001-abcd",
  items: [{ product_id: "margarita", qty: 1 }],
  customer: { name: "Ana", phone: "0991234567" },
  delivery_mode: "pickup",
  payment_method: "transfer",
  ...overrides,
});

const factura = (overrides = {}) => ({
  document_type: "cedula", document_number: "1712345678",
  email: "ana@example.com", address: "Av. Siempre Viva 123", ...overrides,
});

const orderRows = env => env.DB.raw.prepare("SELECT * FROM pos_orders ORDER BY created_at, id").all();
const rowOf = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const openShift = (env, sede = "centro") => env.DB.raw.prepare(
  "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
  "VALUES (?, ?, ?, 'test', ?, 0, ?)",
).run(`turno-${sede}`, "pizza", sede, Date.now(), `turno-${sede}`);

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

const optionsOf = async env => (await panel.fetch(request("/api/payment-options"), env, {})).json();

/* ── Consumidor final sin datos fiscales ─────────────────────────────────── */

test("web sin billing hasta USD 50: consumidor final, columnas fiscales en NULL", async () => {
  const env = webEnv(), ctx = makeCtx();
  const response = await panel.fetch(body("/api/orders", webOrder({
    items: [{ product_id: "margarita", qty: 2 }], // USD 17.00
  })), env, ctx);
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json();
  assert.equal(created.total_cents, 1700, "el total es el del catálogo, no el del navegador");
  const row = rowOf(env, created.id);
  for (const column of ["billing_document_type", "billing_document_number", "billing_email", "billing_address"]) {
    assert.equal(row[column], null, `${column} debe quedar en NULL`);
  }
  assert.equal(row.customer_name, "Ana");
  assert.equal(row.customer_phone, "0991234567");
  assert.equal(JSON.stringify(created).includes("billing"), false, "la respuesta no publica datos fiscales");
});

test("web sin billing (o billing:null) en el límite exacto de USD 50 se acepta", async () => {
  const env = webEnv(), ctx = makeCtx();
  const atLimit = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-limite-01", items: [{ product_id: "limite", qty: 1 }],
  })), env, ctx);
  assert.equal(atLimit.status, 201, await atLimit.clone().text());

  const nullBilling = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-null-01", customer: { name: "Ana", phone: "0991234567", billing: null },
  })), env, ctx);
  assert.equal(nullBilling.status, 201, await nullBilling.clone().text());

  const topLevelNull = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-null-02", billing: null,
  })), env, ctx);
  assert.equal(topLevelNull.status, 201, await topLevelNull.clone().text());

  for (const row of orderRows(env)) assert.equal(row.billing_document_number, null);
});

test("web sin billing por encima de USD 50: 400 datos_fiscales_requeridos con el total del servidor", async () => {
  const env = webEnv(), ctx = makeCtx();
  // El navegador miente con un total pequeño: manda el que calcula el servidor (USD 60.00).
  const response = await panel.fetch(body("/api/orders", webOrder({
    items: [{ product_id: "combo", qty: 1 }], total: 1, total_cents: 1, totalCents: 1,
  })), env, ctx);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "datos_fiscales_requeridos", campo: "billing" });
  assert.equal(orderRows(env).length, 0, "no se crea el pedido sin datos fiscales");

  // Con datos fiscales el mismo monto sí se acepta.
  const withBilling = await panel.fetch(body("/api/orders", webOrder({
    items: [{ product_id: "combo", qty: 1 }],
    customer: { name: "Ana", phone: "0991234567", billing: factura() },
  })), env, ctx);
  assert.equal(withBilling.status, 201, await withBilling.clone().text());
});

/* ── Datos fiscales cuando se envían ─────────────────────────────────────── */

test("web con billing válido: 201 y normalizado en D1, sin PII en la respuesta", async () => {
  const env = webEnv(), ctx = makeCtx();
  const response = await panel.fetch(body("/api/orders", webOrder({
    items: [{ product_id: "combo", qty: 1 }], // por encima del límite: exige factura
    customer: {
      name: " Ana ", phone: "0991234567",
      billing: factura({ document_type: "RUC", document_number: "1790012345001", email: " ANA@Example.COM " }),
    },
  })), env, ctx);
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json();
  const row = rowOf(env, created.id);
  assert.equal(row.billing_document_type, "ruc");
  assert.equal(row.billing_document_number, "1790012345001");
  assert.equal(row.billing_email, "ana@example.com");
  assert.equal(row.billing_address, "Av. Siempre Viva 123");
  const serialized = JSON.stringify(created);
  for (const secret of ["1790012345001", "ana@example.com", "Siempre Viva", "0991234567"]) {
    assert.equal(serialized.includes(secret), false, `no debe devolver ${secret}`);
  }
});

test("web con billing inválido: 400 como antes (formato y campos requeridos)", async () => {
  const env = webEnv(), ctx = makeCtx();
  const cases = [
    [factura({ document_number: "171234567" }), "datos_fiscales_invalidos", "billing.document_number"],
    [factura({ document_type: "ruc", document_number: "1712345678" }), "datos_fiscales_invalidos", "billing.document_number"],
    [factura({ email: "no-es-correo" }), "datos_fiscales_invalidos", "billing.email"],
    [factura({ address: "   " }), "datos_fiscales_requeridos", "billing.address"],
    [{ document_number: "1712345678" }, "datos_fiscales_requeridos", "billing.document_type"],
    ["1712345678", "datos_fiscales_invalidos", "billing"],
  ];
  let key = 0;
  for (const [billing, error, campo] of cases) {
    const response = await panel.fetch(body("/api/orders", webOrder({
      idempotency_key: `web-fiscal-${String(key++).padStart(4, "0")}`,
      customer: { name: "Ana", phone: "0991234567", billing },
    })), env, ctx);
    assert.equal(response.status, 400, `caso ${campo}`);
    assert.deepEqual(await response.json(), { error, campo });
  }
  assert.equal(orderRows(env).length, 0);
});

test("nombre y teléfono siguen siendo obligatorios en la web, con o sin billing", async () => {
  const env = webEnv(), ctx = makeCtx();
  const noName = await panel.fetch(body("/api/orders", webOrder({
    customer: { name: "  ", phone: "0991234567" },
  })), env, ctx);
  assert.equal(noName.status, 400);
  assert.deepEqual(await noName.json(), { error: "cliente_requerido", campo: "customer.name" });

  const badPhone = await panel.fetch(body("/api/orders", webOrder({
    customer: { name: "Ana", phone: "099" },
  })), env, ctx);
  assert.equal(badPhone.status, 400);
  assert.deepEqual(await badPhone.json(), { error: "telefono_invalido", campo: "customer.phone" });
  assert.equal(orderRows(env).length, 0);
});

test("idempotencia: la misma clave con y sin billing es un conflicto 409", async () => {
  const env = webEnv(), ctx = makeCtx();
  const first = await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "web-idem-01" })), env, ctx);
  assert.equal(first.status, 201);
  const retry = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-idem-01", customer: { name: "Ana", phone: "0991234567", billing: factura() },
  })), env, ctx);
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), { error: "idempotencia_conflicto" });

  const same = await panel.fetch(body("/api/orders", webOrder({ idempotency_key: "web-idem-01" })), env, ctx);
  assert.equal(same.status, 201, "reintentar con el mismo cuerpo devuelve el mismo pedido");
  assert.equal(orderRows(env).length, 1);
});

/* ── Opciones de pago y efectivo ─────────────────────────────────────────── */

test("payment-options: cash apagado por defecto y encendido solo con web_cash", async () => {
  const env = webEnv({
    bank_transfer: { bank: "Banco Pichincha", account_type: "Ahorros", account_number: "2200123456", holder: "Pizza S.A.S." },
    location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }], telefono_principal: "0991234567" },
  });
  env.BENDO_MODE = "mock";
  let options = await optionsOf(env);
  assert.equal(options.cash, false, "sin web_cash el efectivo no se ofrece en la web");
  assert.equal(options.transfer, true, "la transferencia no cambia");
  assert.equal(options.bendo, true, "la tarjeta no cambia");

  // Un valor distinto de `true` no enciende el efectivo.
  for (const value of ["true", 1, "sí", false, null]) {
    const config = await env.MENUS.get("pizza:config", "json");
    await env.MENUS.put("pizza:config", JSON.stringify({ ...config, web_cash: value }));
    assert.equal((await optionsOf(env)).cash, false, `web_cash=${JSON.stringify(value)} no enciende el efectivo`);
  }

  const config = await env.MENUS.get("pizza:config", "json");
  await env.MENUS.put("pizza:config", JSON.stringify({ ...config, web_cash: true }));
  options = await optionsOf(env);
  assert.equal(options.cash, true);
  assert.equal(options.transfer, true);
  assert.equal(options.bendo, true);
});

test("web con efectivo sin web_cash: 400 metodo_pago_invalido (explícito o por omisión)", async () => {
  const env = webEnv(), ctx = makeCtx();
  const explicit = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-cash-01", payment_method: "cash",
  })), env, ctx);
  assert.equal(explicit.status, 400);
  assert.deepEqual(await explicit.json(), { error: "metodo_pago_invalido" });

  const { payment_method: _omitted, ...sinMetodo } = webOrder({ idempotency_key: "web-cash-02" });
  const byDefault = await panel.fetch(body("/api/orders", sinMetodo), env, ctx);
  assert.equal(byDefault.status, 400, "sin método explícito el pedido web no cae en efectivo");
  assert.deepEqual(await byDefault.json(), { error: "metodo_pago_invalido" });
  assert.equal(orderRows(env).length, 0);
});

test("web con efectivo y web_cash activado: 201 y método cash", async () => {
  const env = webEnv({ web_cash: true }), ctx = makeCtx();
  const response = await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-cash-03", payment_method: "cash",
  })), env, ctx);
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).payment_method, "cash");
});

test("la caja sigue cobrando en efectivo aunque la web no lo ofrezca", async () => {
  const env = webEnv(), ctx = makeCtx();
  const cookie = await ownerCookie(env);
  const created = await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro", idempotency_key: "caja-cash-01", payment_method: "cash",
    items: [{ product_id: "margarita", qty: 1 }],
  }, { headers: { cookie } }), env, ctx);
  assert.equal(created.status, 201, await created.clone().text());
  const order = await created.json();
  assert.equal(order.payment_method, "cash");

  openShift(env);
  const paid = await panel.fetch(body(`/panel/api/orders/${order.id}/pay-cash`, { idempotency_key: "caja-pago-01" }, {
    headers: { cookie },
  }), env, ctx);
  assert.equal(paid.status, 200, await paid.clone().text());
  const settled = await paid.json();
  assert.equal(settled.order.status, "paid");
  assert.equal(settled.payment.provider, "cash");
});

/* ── La factura del consumidor final ─────────────────────────────────────── */

test("un pedido sin billing se factura como consumidor final (07)", async () => {
  const env = webEnv(), ctx = makeCtx();
  // Config fiscal mínima: el consumidor final solo se admite si está habilitado.
  await env.MENUS.put("pizza:invoices", JSON.stringify({ allowFinalConsumer: true }));
  const cookie = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", webOrder({
    idempotency_key: "web-final-01", items: [{ product_id: "margarita", qty: 2 }],
  })), env, ctx)).json();
  openShift(env);
  const paid = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-transfer`, {
    idempotency_key: "web-final-pago",
  }, { headers: { cookie } }), env, ctx);
  assert.equal(paid.status, 200, await paid.clone().text());

  const invoice = env.DB.raw.prepare("SELECT status, snapshot FROM invoices WHERE order_id = ?").get(created.id);
  assert.ok(invoice, "el cobro prepara el borrador de factura");
  const draft = JSON.parse(invoice.snapshot);
  assert.equal(draft.customer.identificationType, "07");
  assert.equal(draft.customer.identification, "9999999999999");
  assert.equal(draft.customer.name, "Ana", "el nombre del cliente completa el comprobante de consumidor final");
});
