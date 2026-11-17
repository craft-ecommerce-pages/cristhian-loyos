// Bendo: moneda real del link y recuperación de pagos `bendo_alterado`.
// Producción devuelve `"currency": "840"` (ISO 4217 numérico de USD) en
// `GET /api/v4/payments/links/{id}`; exigir `"USD"` dejaba pagos aprobados en
// `unknown` / `bendo_alterado`. Estas pruebas fijan las dos formas aceptadas y
// que el cron vuelve a pagar un `unknown` con la respuesta real de Bendo.
import test from "node:test";
import assert from "node:assert/strict";
import { bendoOutcome, handleBendoReturn, reconcilePendingBendo, startBendo } from "../src/bendo.js";
import { confirmPosOrder, createPosOrder } from "../src/orders.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.example";
const site = { slug: "munch", host };
const origin = `https://${host}`;
const owner = { staff_id: "l_dueno00001", owner: true };
const request = (path, options = {}) => new Request(`${origin}${path}`, options);

const product = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

const TOKEN_STAGING = "https://idp.stg.geopagos.io/auth/realms/stg_c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token";
const LINKS_STAGING = "https://api.stg.geopagos.io/api/v4/payments/links";
const LINK_ID = "ef82a1b2-c3d4-5e6f-7a8b-9c0d1e2f3a4b";

// Respuesta real recortada del GET del link (montos en dólares, no en centavos).
const linkReal = (overrides = {}) => ({
  id: LINK_ID,
  status: "NOT_AVAILABLE",
  amount: 8.5,
  currency: "840",
  total_amount: 8.5,
  payments: [{ status: "APPROVED", authorization_code: "685799" }],
  ...overrides,
});

function bendoEnv() {
  const env = makeEnv({
    "munch:config": { currency: "USD", web_cash: true, location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }] } },
  });
  env.CLIENT_SLUG = "munch";
  env.BENDO_MODE = "live";
  env.BENDO_CLIENT_ID = "id";
  env.BENDO_CLIENT_SECRET = "s";
  env.BENDO_POINT_OF_SALE = "pos-1";
  env.BENDO_ENV = "staging";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("munch", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return env;
}

async function cajaOrder(env, key = "caja-moneda-0001") {
  const response = await createPosOrder(env, site, {
    sede_id: "centro", idempotency_key: key, items: [{ product_id: "margarita", qty: 1 }],
  }, { source: "caja", session: owner });
  assert.equal(response.status, 201);
  const order = await response.json();
  env.DB.raw.prepare("UPDATE pos_orders SET payment_method = 'bendo' WHERE id = ?").run(order.id);
  const confirmed = await confirmPosOrder(env, site, owner, encodeURIComponent(order.id));
  assert.equal(confirmed.status, 200);
  return order;
}

const paymentOf = (env, orderId, key) => env.DB.raw.prepare(
  "SELECT * FROM pos_payments WHERE order_id = ? AND idempotency_key = ?",
).get(orderId, key);
const orderRow = (env, orderId) => env.DB.raw.prepare("SELECT * FROM pos_orders WHERE id = ?").get(orderId);
const comandas = (env, orderId) => env.DB.raw.prepare(
  "SELECT COUNT(*) n FROM pos_comandas WHERE order_id = ?",
).get(orderId).n;

// Stub de fetch: token, creación del link y GET con la respuesta real.
function conBendo(link) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    const method = String(init.method || "GET").toUpperCase();
    calls.push({ url: href, method });
    if (href === TOKEN_STAGING) return Response.json({ access_token: "tk" });
    if (href === LINKS_STAGING && method === "POST") {
      return Response.json(
        { id: LINK_ID, transaction_data: { checkout_url: "https://checkout.bendo.ec/link-real" } },
        { status: 201 },
      );
    }
    if (href === `${LINKS_STAGING}/${LINK_ID}` && method === "GET") return Response.json(link);
    throw new Error(`fetch inesperado: ${method} ${href}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/* ── Verificación de moneda ──────────────────────────────────────────────── */

test("bendoOutcome acepta USD, 840 y 840 numérico; cualquier otra moneda es mismatch", () => {
  const payment = { provider_id: LINK_ID, amount_cents: 850 };

  // Respuesta real de producción: "840" con un pago APPROVED.
  assert.equal(bendoOutcome(linkReal(), payment), "approved");
  assert.equal(bendoOutcome(linkReal({ currency: 840 }), payment), "approved");
  assert.equal(bendoOutcome(linkReal({ currency: "USD" }), payment), "approved");
  assert.equal(bendoOutcome(linkReal({ currency: "840 " }), payment), "approved");

  // Otra moneda (032 = ARS, 986 = BRL, PEN) sigue siendo mismatch.
  assert.equal(bendoOutcome(linkReal({ currency: "032" }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ currency: 32 }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ currency: "986" }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ currency: "PEN" }), payment), "mismatch");

  // Sin moneda se conserva el comportamiento previo; el resto del contrato no cambia.
  assert.equal(bendoOutcome(linkReal({ currency: undefined, status: "PENDING", payments: [] }), payment), "pending");
  assert.equal(bendoOutcome(linkReal({ amount: 8.51 }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ id: "otro-link" }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ payments: [{ status: "REFUNDED" }] }), payment), "mismatch");
  assert.equal(bendoOutcome(linkReal({ status: "NOT_AVAILABLE", payments: [] }), payment), "rejected");
});

/* ── Retorno del comprador con la respuesta real ─────────────────────────── */

test("return con currency 840: pago aprobado y una sola comanda", async () => {
  const env = bendoEnv();
  const order = await cajaOrder(env);
  const fake = conBendo(linkReal());
  try {
    const started = await (await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
      idempotency_key: "caja-moneda-0002",
    })).json();
    assert.equal(started.payment_url, "https://checkout.bendo.ec/link-real");

    const response = await handleBendoReturn(request(`/api/bendo/return?p=${started.payment_id}&format=json`), env, site);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "aprobado", order_id: order.id, order_status: "paid" });

    const payment = paymentOf(env, order.id, "caja-moneda-0002");
    assert.equal(payment.status, "paid");
    assert.equal(payment.message, null);
    assert.equal(payment.authorization, "685799");
    assert.equal(orderRow(env, order.id).status, "paid");
    assert.equal(comandas(env, order.id), 1);
  } finally { fake.restore(); }
});

/* ── Cron: un unknown/bendo_alterado vuelve a pagarse ────────────────────── */

test("cron: un pago unknown/bendo_alterado se reconsulta y queda paid con comanda", async () => {
  const env = bendoEnv();
  const order = await cajaOrder(env, "caja-moneda-0003");
  const fake = conBendo(linkReal());
  try {
    await startBendo(request(`/panel/api/orders/${order.id}/bendo`), env, site, owner, order.id, {
      idempotency_key: "caja-moneda-0004",
    });

    // Estado que dejaba el bug en producción: aprobado en Bendo, unknown local.
    env.DB.raw.prepare("UPDATE pos_payments SET status = 'unknown', message = 'bendo_alterado' WHERE order_id = ? AND idempotency_key = ?")
      .run(order.id, "caja-moneda-0004");
    assert.equal(paymentOf(env, order.id, "caja-moneda-0004").status, "unknown");
    assert.equal(orderRow(env, order.id).status, "confirmed");
    assert.equal(comandas(env, order.id), 0);

    const result = await reconcilePendingBendo(env);
    assert.deepEqual(result, { checked: 1, settled: 1, pending: 0 });

    const payment = paymentOf(env, order.id, "caja-moneda-0004");
    assert.equal(payment.status, "paid");
    assert.equal(payment.message, null);
    assert.equal(payment.authorization, "685799");
    assert.equal(orderRow(env, order.id).status, "paid");
    assert.equal(comandas(env, order.id), 1);

    // Reconciliación repetida: idempotente, no duplica comanda.
    assert.deepEqual(await reconcilePendingBendo(env), { checked: 0, settled: 0, pending: 0 });
    assert.equal(comandas(env, order.id), 1);
  } finally { fake.restore(); }
});
