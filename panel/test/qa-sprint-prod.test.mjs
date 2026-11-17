// QA de integración del sprint foodtruck: los recorridos de punta a punta que
// comparten menú web, caja POS, cocina (KDS), pagos e IVA. Un solo contador
// `print_count` por pedido; la comanda llega a cocina solo tras el cobro.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import panel from "../src/index.js";
import { invoiceDraftFromOrder } from "../src/invoices.js";
import { posOrderData } from "../src/orders.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const SLUG = "pizza";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});

// Config fiscal del titular: precios base sin IVA y tarifa del 15 %.
const TAX_CONFIG = {
  provider: "facturon",
  environment: "sandbox",
  companyId: 3,
  emissionPointId: 7,
  establishment: "001",
  emissionPoint: "001",
  currency: "USD",
  pricesIncludeTax: false,
  defaultTaxRateBp: 1500,
  allowFinalConsumer: true,
  finalConsumerMaxCents: 5000,
};

const CATEGORIES = {
  "sushi-rollos": "🍣 Sushi · Rollos",
  "fastfood-hamburguesas": "🍔 Fast food · Hamburguesas",
};
const CATALOG_CATEGORIES = Object.entries(CATEGORIES).map(([slug, name]) => ({ slug, name }));

const product = (id, name, price, categories) => ({
  id, name, type: "producto", price, promo_price: "", sku: "", description: "", stock: null,
  active: true, catalog_visible: true, images: [], categories, variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
});
const PRODUCTS = [
  product("tres", "Tres dólares", "3.00", ["sushi-rollos"]),
  product("c45", "Combo 45", "45.00", ["fastfood-hamburguesas"]),
];

function posEnv({ invoices = TAX_CONFIG, config = {} } = {}) {
  const kv = {
    [`${SLUG}:config`]: {
      currency: "USD", store_name: "Pizza",
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] },
      categories: CATEGORIES,
      ...config,
    },
  };
  if (invoices) kv[`${SLUG}:invoices`] = invoices;
  const env = makeEnv(kv);
  env.CLIENT_SLUG = SLUG;
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run(SLUG, JSON.stringify({
      categories: CATALOG_CATEGORIES, packagings: [], variant_groups: [], products: PRODUCTS,
    }), Date.now());
  return env;
}

let counter = 0;
const webOrder = (items, overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: `qa-sprint-${String(counter++).padStart(4, "0")}`,
  items,
  customer: { name: "Ana", phone: "0991234567" },
  delivery_mode: "pickup",
  payment_method: "transfer",
  ...overrides,
});

async function ownerCookie(env) {
  const owner = await panel.fetch(body(`/admin/${SLUG}/owner`, { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

async function createWeb(env, items, overrides = {}) {
  const response = await panel.fetch(body("/api/orders", webOrder(items, overrides)), env, makeCtx());
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload;
}

async function openShift(env, cookie, sede = "centro") {
  const response = await panel.fetch(body("/panel/api/turnos/abrir", {
    sede_id: sede, opening_float_cents: 0, idempotency_key: `turno-qa-${sede}`,
  }, { headers: { cookie } }), env, makeCtx());
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).shift;
}

async function pay(env, cookie, orderId, action, key) {
  return panel.fetch(body(`/panel/api/orders/${orderId}/${action}`, { idempotency_key: key }, {
    headers: { cookie },
  }), env, makeCtx());
}

const kitchenOf = async (env, cookie, sede = "centro") => (await (await panel.fetch(
  request(`/panel/api/kitchen/orders?sede_id=${sede}`, { headers: { cookie } }), env, makeCtx(),
)).json());

const rowOf = (env, id) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(id);
const countOf = (env, sql, ...args) => env.DB.raw.prepare(sql).get(...args).n;

/* a) Web + tarjeta (Bendo mock): pago aprobado → cocina → imprimir → acuse ── */

test("a) web + tarjeta Bendo mock: pagado, comanda pendiente y acuse con un solo contador", async () => {
  const env = posEnv();
  env.BENDO_MODE = "mock";
  const cookie = await ownerCookie(env);

  const created = await createWeb(env, [{ product_id: "tres", qty: 1 }], { payment_method: "bendo" });
  assert.equal(created.total_cents, 345);
  assert.equal(created.status, "pending");

  const started = await (await panel.fetch(body(`/api/orders/${created.id}/bendo`, {
    order_token: created.order_token, idempotency_key: `bendo-${created.id}`,
  }), env, makeCtx())).json();
  assert.ok(started.payment_url, "el link de pago se creó");
  const payment = env.DB.raw.prepare("SELECT provider_ref, amount_cents FROM pos_payments WHERE order_id = ?").get(created.id);
  assert.equal(payment.amount_cents, 345, "el link cobra el total con IVA");

  const mock = await panel.fetch(request(`/api/bendo/mock?p=${payment.provider_ref}&resultado=aprobado`), env, makeCtx());
  assert.equal(mock.status, 302);
  const returned = await panel.fetch(request(`/api/bendo/return?p=${payment.provider_ref}&format=json`), env, makeCtx());
  assert.equal(returned.status, 200);
  assert.equal((await returned.json()).status, "aprobado");

  const paid = rowOf(env, created.id);
  assert.equal(paid.status, "paid");

  // La comanda aparece en cocina con el contador en 0: pendiente de imprimir.
  const pending = await kitchenOf(env, cookie);
  const comanda = pending.orders.find(order => order.id === created.id);
  assert.ok(comanda, "el pedido pagado llega a cocina");
  assert.equal(comanda.print_count, 0);
  assert.equal(comanda.tax_cents, 45);

  const printed = await panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, {
    idempotency_key: `print-${created.id}`,
  }, { headers: { cookie } }), env, makeCtx());
  assert.equal(printed.status, 200);
  assert.equal((await printed.json()).print_count, 1);

  // Ya no vuelve a salir como pendiente de imprimir (print_count != 0).
  const after = await kitchenOf(env, cookie);
  const still = after.orders.find(order => order.id === created.id);
  assert.equal(still.print_count, 1);
  assert.deepEqual(
    after.orders.filter(order => order.print_count === 0).map(order => order.id),
    [],
    "nada pendiente de imprimir",
  );
});

/* b) Web + transferencia: pendiente en caja → pay-transfer → paid → cocina ─ */

test("b) web + transferencia: la caja lo ve, confirma el abono y llega a cocina", async () => {
  const env = posEnv();
  const cookie = await ownerCookie(env);
  await openShift(env, cookie);

  const created = await createWeb(env, [{ product_id: "tres", qty: 1 }], { payment_method: "transfer" });
  assert.equal(created.status, "pending");

  // El listado de la caja (pendientes de la sede) muestra el pedido web.
  const list = await (await panel.fetch(
    request("/panel/api/pos/orders?sede_id=centro&status=open", { headers: { cookie } }), env, makeCtx(),
  )).json();
  assert.ok(list.orders.some(order => order.id === created.id), "aparece en la caja");

  const confirmed = await pay(env, cookie, created.id, "pay-transfer", `transf-${created.id}`);
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  const paid = (await confirmed.json()).order;
  assert.equal(paid.status, "paid");
  assert.equal(paid.total_cents, 345);

  const kitchen = await kitchenOf(env, cookie);
  const comanda = kitchen.orders.find(order => order.id === created.id);
  assert.ok(comanda);
  assert.equal(comanda.print_count, 0);
});

/* c) Efectivo web: apagado por defecto, encendido por configuración ───────── */

test("c) efectivo web: 400 sin web_cash y 201 con web_cash:true", async () => {
  const off = posEnv();
  const rejected = await panel.fetch(body("/api/orders", webOrder([{ product_id: "tres", qty: 1 }], {
    payment_method: "cash",
  })), off, makeCtx());
  assert.equal(rejected.status, 400);
  assert.deepEqual(await rejected.json(), { error: "metodo_pago_invalido" });
  assert.equal(countOf(off, "SELECT COUNT(*) n FROM pos_orders"), 0);

  const on = posEnv({ config: { web_cash: true } });
  const accepted = await panel.fetch(body("/api/orders", webOrder([{ product_id: "tres", qty: 1 }], {
    payment_method: "cash",
  })), on, makeCtx());
  assert.equal(accepted.status, 201, await accepted.clone().text());
  assert.equal((await accepted.json()).payment_method, "cash");
});

/* d) Caja: turno abierto cobra y cierra el circuito; cerrada → 409 ────────── */

test("d) caja: turno abierto → pay-cash → paid y comanda; caja cerrada → 409", async () => {
  const env = posEnv();
  const cookie = await ownerCookie(env);

  const created = await (await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro",
    idempotency_key: "caja-qa-0001",
    payment_method: "cash",
    items: [{ product_id: "tres", qty: 1 }],
  }, { headers: { cookie } }), env, makeCtx())).json();
  assert.equal(created.total_cents, 345);

  // Caja cerrada: el cobro manual no se permite.
  const closed = await pay(env, cookie, created.id, "pay-cash", "caja-pago-0001");
  assert.equal(closed.status, 409);
  assert.equal((await closed.json()).error, "caja_cerrada");
  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_payments"), 0);

  // Abrir la caja y reintentar el mismo cobro idempotente.
  await openShift(env, cookie);
  const paidResponse = await pay(env, cookie, created.id, "pay-cash", "caja-pago-0001");
  assert.equal(paidResponse.status, 200, await paidResponse.clone().text());
  const paid = (await paidResponse.json()).order;
  assert.equal(paid.status, "paid");
  assert.equal(paid.total_cents, 345);
  assert.equal(paid.tax_cents, 45);

  const kitchen = await kitchenOf(env, cookie);
  const comanda = kitchen.orders.find(order => order.id === created.id);
  assert.ok(comanda, "la comanda sale en cocina tras el cobro");
  assert.equal(comanda.print_count, 0);
});

/* e) Consumidor final: el límite de USD 50 se mide con IVA ────────────────── */

test("e) web sin billing > USD 50: 400 datos_fiscales_requeridos", async () => {
  const env = posEnv();
  const response = await panel.fetch(body("/api/orders", webOrder([{ product_id: "c45", qty: 1 }])), env, makeCtx());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "datos_fiscales_requeridos", campo: "billing" });
  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_orders"), 0);

  const withBilling = await panel.fetch(body("/api/orders", webOrder([{ product_id: "c45", qty: 1 }], {
    customer: {
      name: "Ana", phone: "0991234567",
      billing: {
        document_type: "cedula", document_number: "1712345678",
        email: "ana@example.com", address: "Calle 1",
      },
    },
  })), env, makeCtx());
  assert.equal(withBilling.status, 201, await withBilling.clone().text());
  assert.equal((await withBilling.json()).total_cents, 5175, "45,00 + IVA = 51,75");
});

/* f) Idempotencia del cobro: ni pago ni comanda duplicados ────────────────── */

test("f) el mismo pay-cash repetido no duplica el pago ni la comanda", async () => {
  const env = posEnv();
  const cookie = await ownerCookie(env);
  await openShift(env, cookie);

  // El cobro en efectivo web exige web_cash; se prueba por la caja, que sí cobra.
  const caja = await (await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro",
    idempotency_key: "caja-idem-0001",
    payment_method: "cash",
    items: [{ product_id: "tres", qty: 2 }],
  }, { headers: { cookie } }), env, makeCtx())).json();

  const first = await pay(env, cookie, caja.id, "pay-cash", "idem-pago-0001");
  assert.equal(first.status, 200, await first.clone().text());
  const second = await pay(env, cookie, caja.id, "pay-cash", "idem-pago-0001");
  assert.equal(second.status, 200, await second.clone().text());
  const repeated = await second.json();
  assert.equal(repeated.order.status, "paid");
  assert.equal(repeated.payment.amount_cents, 690);

  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_payments WHERE order_id = ?", caja.id), 1);
  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?", caja.id), 1);
  assert.equal((await kitchenOf(env, cookie)).orders.filter(order => order.id === caja.id).length, 1);

  // Otra clave sobre un pedido ya pagado tampoco duplica nada.
  const other = await pay(env, cookie, caja.id, "pay-cash", "idem-pago-0002");
  assert.equal(other.status, 409);
  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_payments WHERE order_id = ?", caja.id), 1);
  assert.equal(countOf(env, "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?", caja.id), 1);
});

/* g) Catálogo de la caja coherente con la configuración real ─────────────── */

test("g) el catálogo de la caja publica category_groups coherente con la config", async () => {
  const realConfig = JSON.parse(readFileSync(new URL("../../data/kv/config.json", import.meta.url), "utf8"));
  const realCategories = Object.entries(realConfig.categories).map(([slug, name]) => ({ slug, name }));
  const env = posEnv({ config: { category_groups: realConfig.category_groups, categories: realConfig.categories } });
  env.DB.raw.prepare("UPDATE catalogs SET doc = ? WHERE slug = ?").run(JSON.stringify({
    categories: realCategories, packagings: [], variant_groups: [], products: PRODUCTS,
  }), SLUG);

  const cookie = await ownerCookie(env);
  const response = await panel.fetch(
    request("/panel/api/mesero/catalog", { headers: { cookie } }), env, makeCtx(),
  );
  assert.equal(response.status, 200);
  const catalog = await response.json();
  const known = new Set(realCategories.map(category => category.slug));

  assert.ok(catalog.category_groups, "publica la jerarquía del menú");
  assert.deepEqual(catalog.category_groups.items.map(group => group.slug), ["sushi", "fastfood", "tradicional"]);
  for (const group of catalog.category_groups.items) {
    assert.ok(group.name, "cada grupo tiene nombre");
    for (const slug of group.categories) assert.ok(known.has(slug), "categoría existente: " + slug);
  }
  // La config real no deja categorías fuera de los grupos ni productos huérfanos.
  const grouped = new Set(catalog.category_groups.items.flatMap(group => group.categories));
  assert.deepEqual([...known].filter(slug => !grouped.has(slug)), []);

  // Un slug inventado y un grupo repetido se descartan en el saneo.
  const dirty = {
    ...realConfig.category_groups,
    items: [
      { ...realConfig.category_groups.items[0], categories: [...realConfig.category_groups.items[0].categories, "no-existe"] },
      realConfig.category_groups.items[1],
      { ...realConfig.category_groups.items[1], name: "Repetido" },
    ],
  };
  const dirtyEnv = posEnv({ config: { category_groups: dirty, categories: realConfig.categories } });
  dirtyEnv.DB.raw.prepare("UPDATE catalogs SET doc = ? WHERE slug = ?").run(JSON.stringify({
    categories: realCategories, packagings: [], variant_groups: [], products: PRODUCTS,
  }), SLUG);
  const dirtyCookie = await ownerCookie(dirtyEnv);
  const sanitized = await (await panel.fetch(
    request("/panel/api/mesero/catalog", { headers: { cookie: dirtyCookie } }), dirtyEnv, makeCtx(),
  )).json();
  assert.equal(sanitized.category_groups.items.length, 2, "sin duplicados");
  assert.equal(sanitized.category_groups.items[0].categories.includes("no-existe"), false);
});

/* h) IVA 15 %: 3,00 base se cobra 3,45 en caja y web; factura sin mismatch ─ */

test("h) 3,00 base → 3,45 en caja y web con Bendo; el borrador no tiene total_mismatch", async () => {
  const env = posEnv();
  env.BENDO_MODE = "mock";
  const cookie = await ownerCookie(env);
  await openShift(env, cookie);

  // Caja: pedido de 3,00 → cobro en efectivo por 3,45.
  const caja = await (await panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro",
    idempotency_key: "iva-caja-0001",
    payment_method: "cash",
    items: [{ product_id: "tres", qty: 1 }],
  }, { headers: { cookie } }), env, makeCtx())).json();
  assert.equal(caja.total_cents, 345);
  const paidCaja = await pay(env, cookie, caja.id, "pay-cash", "iva-pago-0001");
  assert.equal(paidCaja.status, 200, await paidCaja.clone().text());
  assert.equal((await paidCaja.json()).payment.amount_cents, 345);

  const cajaDraft = invoiceDraftFromOrder({ order: posOrderData(rowOf(env, caja.id)), config: TAX_CONFIG });
  assert.equal(cajaDraft.blockedReasons.includes("total_mismatch"), false);
  assert.equal(cajaDraft.totals.subtotalCents, 300);
  assert.equal(cajaDraft.totals.taxCents, 45);
  assert.equal(cajaDraft.totals.totalCents, 345);

  // Web con Bendo mock: mismo producto, mismo total con IVA.
  const web = await createWeb(env, [{ product_id: "tres", qty: 1 }], { payment_method: "bendo" });
  assert.equal(web.total_cents, 345);
  const started = await (await panel.fetch(body(`/api/orders/${web.id}/bendo`, {
    order_token: web.order_token, idempotency_key: `iva-bendo-${web.id}`,
  }), env, makeCtx())).json();
  const ref = env.DB.raw.prepare("SELECT provider_ref FROM pos_payments WHERE order_id = ?").get(web.id).provider_ref;
  assert.equal(started.total_cents, 345);
  await env.MENUS.put(`bendo:mock:${ref}`, "aprobado");
  const returned = await panel.fetch(request(`/api/bendo/return?p=${ref}&format=json`), env, makeCtx());
  assert.equal((await returned.json()).status, "aprobado");
  assert.equal(rowOf(env, web.id).total_cents, 345);

  const webDraft = invoiceDraftFromOrder({ order: posOrderData(rowOf(env, web.id)), config: TAX_CONFIG });
  assert.equal(webDraft.blockedReasons.includes("total_mismatch"), false);
  assert.equal(webDraft.totals.totalCents, 345);

  // La factura preparada durante el cobro guardó el mismo desglose sin mismatch.
  for (const id of [caja.id, web.id]) {
    const invoice = env.DB.raw.prepare("SELECT status, snapshot FROM invoices WHERE order_id = ?").get(id);
    assert.ok(invoice, "se preparó el borrador de factura");
    const snapshot = JSON.parse(invoice.snapshot);
    assert.equal(snapshot.blockedReasons.includes("total_mismatch"), false, invoice.status);
    assert.equal(snapshot.totals.totalCents, 345);
  }
});
