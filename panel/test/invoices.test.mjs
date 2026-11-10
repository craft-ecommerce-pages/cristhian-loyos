// Facturación electrónica: borrador desde snapshot pagado, idempotencia por pedido,
// estados, guardas de producción, adaptadores y webhooks firmados.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { makeEnv } from "./helpers.mjs";
import {
  INVOICE_SCHEMA, adapterFor, createEcuafactAdapter, createFactuplanAdapter, createMockAdapter,
  handleGetInvoice, handleInvoiceWebhook, handleRetryInvoice, invoiceDraftFromOrder, isPaidOrder,
  loadInvoiceConfig, normalizeInvoiceConfig, prepareInvoice, publicInvoice, refreshInvoice,
  retryInvoice, submitInvoice, verifyEcuafactSignature,
} from "../src/invoices.js";

const SLUG = "pizza";
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0); // 10-nov-2026 10:00 en Ecuador
const RUC = "0999999999001";
const ACCESS_KEY = "1".repeat(49);
const SESSION = { email: "dueno@pizza.ec" };

const config = (overrides = {}) => ({
  provider: "ecuafact",
  environment: "sandbox",
  emitEnabled: true,
  fiscalValidated: true,
  productionApproved: false,
  ruc: RUC,
  legalName: "NEGOCIO DE PRUEBAS",
  establishment: "001",
  emissionPoint: "001",
  currency: "USD",
  pricesIncludeTax: true,
  defaultTaxRateBp: 1500,
  allowFinalConsumer: true,
  finalConsumerMaxCents: 5000,
  paymentMethod: "01",
  origin: "craft-panel",
  ...overrides,
});

const posOrder = (overrides = {}) => ({
  id: "ord-1",
  status: "paid",
  paid_at: NOW,
  total_cents: 1150,
  currency: "USD",
  customer_name: "Ana",
  customer_phone: "0991234567",
  items: [
    { product_id: "p1", name: "Pizza", qty: 1, unit_cents: 1000, subtotal_cents: 1000 },
    { product_id: "p2", name: "Agua", qty: 1, unit_cents: 150, subtotal_cents: 150 },
  ],
  ...overrides,
});

const envWith = (cfg = config(), extra = {}) => {
  const env = makeEnv({ [`${SLUG}:invoices`]: cfg });
  env.ECUAFACT_API_KEY = "test-ecuafact-key";
  return Object.assign(env, extra);
};
const rowOf = (env, orderId) =>
  env.DB.raw.prepare("SELECT * FROM invoices WHERE slug = ? AND order_id = ?").get(SLUG, orderId);
const eventsOf = (env, orderId) => {
  const row = rowOf(env, orderId);
  return row ? env.DB.raw.prepare("SELECT * FROM invoice_events WHERE invoice_id = ? ORDER BY id").all(row.id) : [];
};
const jsonRequest = (body, headers = {}) => new Request("https://pizza.craft-systems.com/panel/api/invoices/ord-1", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const sign = (body, secret, timestamp) => {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
};

/* ── Borrador neutral ─────────────────────────────────────────────────────── */

test("borrador: pedido pagado POS en centavos, IVA configurable y consumidor final", () => {
  const draft = invoiceDraftFromOrder({ order: posOrder(), config: config(), now: NOW });
  assert.equal(draft.ready, true, draft.blockedReasons.join(", "));
  assert.equal(draft.schema, INVOICE_SCHEMA);
  assert.equal(draft.orderId, "ord-1");
  assert.equal(draft.date, "10/11/2026");
  assert.equal(draft.taxMode, "inclusive");
  assert.equal(draft.currency, "USD");
  assert.equal(draft.origin, "craft-panel");
  assert.deepEqual(draft.customer, {
    identificationType: "07", identification: "9999999999999", name: "Ana",
    email: null, address: null, phone: "0991234567",
  });
  assert.deepEqual(draft.totals, { subtotalCents: 1000, taxCents: 150, discountCents: 0, totalCents: 1150 });
  assert.deepEqual(draft.lines.map(line => [line.code, line.baseCents, line.taxCents, line.grossCents]), [
    ["p1", 870, 130, 1000],
    ["p2", 130, 20, 150],
  ]);
  assert.deepEqual(draft.taxes, [{ code: "4", rateBp: 1500, baseCents: 1000, taxCents: 150 }]);
  assert.equal(draft.lines[0].netUnitAmount, 8.7);
  assert.deepEqual(draft.payment, { method: "01", amountCents: 1150 });
  assert.deepEqual(draft.additionalInfo, [{ name: "Pedido", value: "ord-1" }]);
  assert.equal(draft.lines[0].unitPriceCents, 1000, "conserva el precio cobrado");
});

test("borrador: precio sin impuesto y descuento se expresan en base imponible", () => {
  const exclusive = invoiceDraftFromOrder({
    order: posOrder({ total_cents: 1323 }),
    config: config({ pricesIncludeTax: false }),
    now: NOW,
  });
  assert.equal(exclusive.ready, true, exclusive.blockedReasons.join(", "));
  assert.deepEqual(exclusive.totals, { subtotalCents: 1150, taxCents: 173, discountCents: 0, totalCents: 1323 });
  assert.deepEqual(exclusive.lines.map(line => [line.baseCents, line.taxCents, line.netUnitAmount]), [
    [1000, 150, 10], [150, 23, 1.5],
  ]);

  const discounted = invoiceDraftFromOrder({
    order: posOrder({
      total_cents: 950,
      items: [{ product_id: "p1", name: "Pizza", qty: 1, unit_cents: 1000, discount_cents: 50 }],
    }),
    config: config(),
    now: NOW,
  });
  assert.equal(discounted.ready, true, discounted.blockedReasons.join(", "));
  assert.deepEqual(discounted.totals, { subtotalCents: 826, taxCents: 124, discountCents: 44, totalCents: 950 });
  assert.equal(discounted.lines[0].netUnitAmount, 8.7);
  // cantidad * precioUnitario - descuento = 8.70 - 0.44 = 8.26 (base sin impuesto)
  assert.equal(discounted.lines[0].baseCents, 826);
});

test("borrador: precios legacy en dólares solo se convierten si se autoriza explícitamente", () => {
  const legacy = {
    id: "legacy-1", status: "paid", paid_at: NOW, total: 8, client_name: "Ana",
    items: [{ nombre: "Pizza", qty: 2, precio: 4 }],
  };
  const converted = invoiceDraftFromOrder({
    order: legacy,
    config: config({ pricesIncludeTax: true, defaultTaxRateBp: 0, legacyPricesAreCurrency: true }),
    now: NOW,
  });
  assert.equal(converted.ready, true, converted.blockedReasons.join(", "));
  assert.deepEqual(converted.totals, { subtotalCents: 800, taxCents: 0, discountCents: 0, totalCents: 800 });
  assert.equal(converted.lines[0].unitPriceCents, 400);
  assert.equal(converted.lines[0].code, "ITEM-01");

  const raw = invoiceDraftFromOrder({ order: legacy, config: config(), now: NOW });
  assert.equal(raw.ready, false);
  assert.ok(raw.blockedReasons.includes("total_cents_missing"));
  assert.ok(raw.blockedReasons.includes("line_price_missing"));
});

test("borrador: bloqueos explícitos en lugar de inventar datos fiscales", () => {
  const blockedOf = (order, cfg) => invoiceDraftFromOrder({ order, config: cfg, now: NOW }).blockedReasons;

  assert.ok(blockedOf(posOrder({ status: "pending", paid_at: null }), config()).includes("order_not_paid"));
  assert.ok(blockedOf(posOrder(), config({ currency: "COP" })).includes("currency_not_supported"));
  assert.ok(blockedOf(posOrder(), config({ establishment: null, emissionPoint: null }))
    .includes("establishment_not_configured"));
  assert.ok(blockedOf(posOrder(), config({ establishments: ["001", "002"] }))
    .includes("multiple_establishments_require_fiscal_validation"));
  assert.ok(blockedOf(posOrder(), config({ pricesIncludeTax: null })).includes("tax_mode_not_configured"));
  assert.ok(blockedOf(posOrder(), config({ defaultTaxRateBp: null })).includes("tax_rate_not_configured"));
  assert.ok(blockedOf(posOrder(), config({ defaultTaxRateBp: 7000 })).includes("tax_rate_unsupported"));
  assert.ok(blockedOf(posOrder({ total_cents: 999 }), config()).includes("total_mismatch"));
  assert.ok(blockedOf(posOrder(), config({ allowFinalConsumer: false })).includes("customer_identification_missing"));

  const finalConsumer = invoiceDraftFromOrder({
    order: posOrder({
      total_cents: 6000, customer_name: "",
      items: [{ product_id: "p1", name: "Pizza", qty: 1, unit_cents: 6000 }],
    }),
    config: config(),
    now: NOW,
  });
  assert.equal(finalConsumer.ready, false);
  assert.ok(finalConsumer.blockedReasons.includes("final_consumer_over_limit"));

  const noLines = invoiceDraftFromOrder({ order: posOrder({ items: [], total_cents: 1000 }), config: config(), now: NOW });
  assert.ok(noLines.blockedReasons.includes("order_lines_missing"));

  const invalidQuantity = invoiceDraftFromOrder({
    order: posOrder({ total_cents: 1000, items: [{ product_id: "p1", name: "Pizza", qty: 0, unit_cents: 1000 }] }),
    config: config(),
    now: NOW,
  });
  assert.ok(invalidQuantity.blockedReasons.includes("line_quantity_invalid"));

  const byCategory = invoiceDraftFromOrder({
    order: posOrder({
      total_cents: 1000, items: [{ product_id: "b1", name: "Agua", qty: 1, unit_cents: 1000, category: "bebidas" }],
    }),
    config: config({ defaultTaxRateBp: null, taxRatesByCategory: { bebidas: 0 } }),
    now: NOW,
  });
  assert.equal(byCategory.ready, true, byCategory.blockedReasons.join(", "));
  assert.deepEqual(byCategory.taxes, [{ code: "0", rateBp: 0, baseCents: 1000, taxCents: 0 }]);

  const fiscalPending = invoiceDraftFromOrder({ order: posOrder(), config: config({ fiscalValidated: false }), now: NOW });
  assert.equal(fiscalPending.ready, true);
  assert.deepEqual(fiscalPending.warnings, ["fiscal_validation_pending"]);
});

test("configuración: normaliza establecimientos, moneda, tasas y rechaza valores ambiguos", () => {
  const cfg = normalizeInvoiceConfig({
    provider: "ECUAFACT", environment: "prod", emitEnabled: "true", fiscalValidated: 1,
    ruc: "123", establishment: "2", emissionPoint: "1", establishments: ["3", "x"],
    currency: "$", pricesIncludeTax: "yes", defaultTaxRateBp: 1500.5,
    taxRatesByCategory: { bebidas: 0, comida: 1500, roto: -1, texto: "15" },
    allowFinalConsumer: "true", finalConsumerMaxCents: -1,
    paymentMethod: "1", origin: "con espacios", additionalInfo: { Pedido: "A-1", Vacio: "" },
  });
  assert.equal(cfg.provider, null);
  assert.equal(cfg.environment, null);
  assert.equal(cfg.emitEnabled, false);
  assert.equal(cfg.fiscalValidated, false);
  assert.equal(cfg.ruc, null);
  assert.equal(cfg.establishment, "002");
  assert.equal(cfg.emissionPoint, "001");
  assert.deepEqual(cfg.establishments, ["003"]);
  assert.equal(cfg.currency, "USD");
  assert.equal(cfg.pricesIncludeTax, null);
  assert.equal(cfg.defaultTaxRateBp, null);
  assert.deepEqual(cfg.taxRatesByCategory, { bebidas: 0, comida: 1500 });
  assert.equal(cfg.allowFinalConsumer, false);
  assert.equal(cfg.finalConsumerMaxCents, 5000);
  assert.equal(cfg.paymentMethod, "01");
  assert.equal(cfg.origin, "craft-panel");
  assert.deepEqual(cfg.additionalInfo, [{ name: "Pedido", value: "A-1" }]);

  const valid = normalizeInvoiceConfig(config({ currency: "USD", establishment: "1", emissionPoint: "2" }));
  assert.equal(valid.establishment, "001");
  assert.equal(valid.emissionPoint, "002");
  assert.equal(valid.currency, "USD");
});

test("isPaidOrder y carga desde KV", async () => {
  assert.equal(isPaidOrder(posOrder()), true);
  assert.equal(isPaidOrder({ status: "paid" }), true);
  assert.equal(isPaidOrder({ paid: 1 }), true);
  assert.equal(isPaidOrder({ payment_status: "paid" }), true);
  assert.equal(isPaidOrder({ paid_at: NOW }), true);
  assert.equal(isPaidOrder({ status: "pending" }), false);
  assert.equal(isPaidOrder(null), false);

  const env = envWith(config({ establishment: "2" }));
  const loaded = await loadInvoiceConfig(env, SLUG);
  assert.equal(loaded.establishment, "002");
  const empty = await loadInvoiceConfig(makeEnv(), SLUG);
  assert.equal(empty.provider, null);
  assert.equal(empty.establishment, null);
});

/* ── Persistencia e idempotencia ─────────────────────────────────────────── */

test("prepareInvoice: una fila por pedido, hash estable y conflicto si cambia el snapshot", async () => {
  const env = envWith();
  const first = await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.invoice.status, "pending");
  assert.equal(first.invoice.reference, "ORD-ord-1");

  const row = rowOf(env, "ord-1");
  assert.equal(row.currency, "USD");
  assert.equal(row.total_cents, 1150);
  assert.equal(row.subtotal_cents, 1000);
  assert.equal(row.tax_cents, 150);
  assert.equal(row.idempotency_key, "invoice:pizza:ord-1:1");
  assert.equal(row.external_reference, "ORD-ord-1");
  assert.equal(row.attempt, 1);
  assert.match(row.draft_hash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(row.snapshot).schema, INVOICE_SCHEMA);
  assert.deepEqual(eventsOf(env, "ord-1").map(event => event.kind), ["prepared"]);

  const again = await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW + 60_000 });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.invoice.updated_at, first.invoice.updated_at, "generatedAt no altera la identidad");

  const changed = await prepareInvoice(env, {
    slug: SLUG, order: posOrder({ total_cents: 950 }), config: config(), now: NOW,
  });
  assert.equal(changed.ok, false);
  assert.equal(changed.code, "invoice_conflict");
  assert.equal(changed.status, 409);

  assert.deepEqual(await prepareInvoice(env, { slug: SLUG, order: posOrder({ status: "pending" }), config: config() }),
    { ok: false, code: "order_not_paid", status: 409 });
  assert.deepEqual(await prepareInvoice(env, { slug: SLUG, order: { status: "paid" }, config: config() }),
    { ok: false, code: "order_id_missing", status: 400 });
  assert.deepEqual(await prepareInvoice(env, { slug: "", order: posOrder() }),
    { ok: false, code: "slug_invalid", status: 400 });
  assert.deepEqual(await prepareInvoice({}, { slug: SLUG, order: posOrder() }),
    { ok: false, code: "db_not_configured", status: 503 });
});

test("prepareInvoice: sin proveedor, sin credenciales o sin configuración fiscal queda manual", async () => {
  const noProvider = envWith();
  const manualProvider = await prepareInvoice(noProvider, {
    slug: SLUG, order: posOrder(), config: config({ provider: null }), now: NOW,
  });
  assert.equal(manualProvider.ok, true);
  assert.equal(manualProvider.invoice.status, "manual");
  assert.equal(rowOf(noProvider, "ord-1").failure_code, "provider_not_configured");
  assert.equal(manualProvider.invoice.requires_action, true);

  const noKeys = envWith(config(), { ECUAFACT_API_KEY: undefined });
  const manualKeys = await prepareInvoice(noKeys, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  assert.equal(manualKeys.invoice.status, "manual");
  assert.equal(rowOf(noKeys, "ord-1").failure_code, "provider_credentials_missing");

  const disabled = envWith();
  const manualDisabled = await prepareInvoice(disabled, {
    slug: SLUG, order: posOrder(), config: config({ emitEnabled: false }), now: NOW,
  });
  assert.equal(manualDisabled.invoice.status, "manual");
  assert.equal(rowOf(disabled, "ord-1").failure_code, "emission_disabled");

  const pending = envWith();
  const fiscal = await prepareInvoice(pending, {
    slug: SLUG, order: posOrder(), config: config({ environment: "production", productionApproved: true, fiscalValidated: false }), now: NOW,
  });
  assert.equal(fiscal.invoice.status, "manual");
  assert.equal(rowOf(pending, "ord-1").failure_code, "fiscal_validation_required");

  const blocked = envWith();
  const setup = await prepareInvoice(blocked, {
    slug: SLUG, order: posOrder(), config: config({ pricesIncludeTax: null }), now: NOW,
  });
  assert.equal(setup.invoice.status, "manual");
  assert.equal(rowOf(blocked, "ord-1").failure_code, "fiscal_setup_pending");
  assert.equal(rowOf(blocked, "ord-1").tax_cents, null);
  assert.equal(rowOf(blocked, "ord-1").total_cents, null, "la migración admite total desconocido");
});

/* ── Envío, confirmación y reintentos ───────────────────────────────────── */

test("submitInvoice: processing → submitted y confirmación SRI → issued sin reemitir", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const mock = createMockAdapter({
    statuses: [
      { state: "processing", documentNumber: "001-001-000000001" },
      { state: "authorized", accessKey: ACCESS_KEY, authorizationNumber: ACCESS_KEY, documentNumber: "001-001-000000001" },
    ],
  });

  const sent = await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW });
  assert.equal(sent.ok, true);
  assert.equal(sent.invoice.status, "submitted");
  assert.equal(rowOf(env, "ord-1").provider_status, "processing");

  const confirmed = await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW + 2_000 });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.unchanged, true);
  assert.equal(confirmed.invoice.status, "issued");
  assert.equal(confirmed.invoice.access_key, ACCESS_KEY);
  assert.equal(confirmed.invoice.issued_at, NOW + 2_000);
  assert.equal(confirmed.invoice.pdf_url, null);
  assert.equal(mock.calls().emitCalls, 1, "un pedido pagado nunca se emite dos veces");
  assert.equal(mock.calls().statusCalls, 2);
  assert.deepEqual(eventsOf(env, "ord-1").map(event => event.to_status), ["pending", "submitted", "submitted", "issued"]);

  const alreadyIssued = await refreshInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW + 3_000 });
  assert.equal(alreadyIssued.ok, true);
  assert.equal(alreadyIssued.invoice.status, "issued");
  assert.equal(mock.calls().statusCalls, 2, "issued no vuelve a consultar");
});

test("submitInvoice: autorización sin clave de acceso no se declara emitida", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const mock = createMockAdapter({
    statuses: [{ state: "authorized", accessKey: null, authorizationNumber: null }],
  });
  const result = await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, "authorization_unconfirmed");
  assert.equal(result.invoice.status, "submitted");
  assert.equal(rowOf(env, "ord-1").failure_code, "authorization_unconfirmed");
  assert.equal(rowOf(env, "ord-1").access_key, null);
});

test("submitInvoice: rechazo final, corrección explícita y nueva clave de intento", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const mock = createMockAdapter({
    emissions: [
      { accepted: false, kind: "rejected", code: 3001, message: "CLAVE ACCESO REGISTRADA" },
      { accepted: true, kind: "processing", operationId: "mock-retry" },
    ],
    statuses: [{ state: "processing" }],
  });

  const rejected = await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, "provider_rejected");
  assert.equal(rejected.invoice.status, "failed");
  assert.equal(rowOf(env, "ord-1").failure_code, "provider_rejected");

  const blockedRetry = await retryInvoice(env, {
    slug: SLUG, orderId: "ord-1", session: SESSION, config: config(), adapter: mock, now: NOW + 1,
  });
  assert.equal(blockedRetry.ok, false);
  assert.equal(blockedRetry.code, "invoice_requires_correction");
  assert.equal(mock.calls().emitCalls, 1, "un rechazo no se reintenta sin corrección");

  const forced = await retryInvoice(env, {
    slug: SLUG, orderId: "ord-1", session: SESSION, config: config(), adapter: mock,
    now: NOW + 2, forceNewAttempt: true,
  });
  assert.equal(forced.ok, true);
  assert.equal(forced.invoice.status, "submitted");
  const row = rowOf(env, "ord-1");
  assert.equal(row.attempt, 2);
  assert.equal(row.idempotency_key, "invoice:pizza:ord-1:2");
  assert.equal(row.external_reference, "ORD-ord-1-R2");
  assert.equal(mock.calls().emitCalls, 2);
});

test("submitInvoice: timeout conserva la misma clave; conflicto y configuración no se reintentan solos", async () => {
  const uncertainEnv = envWith();
  await prepareInvoice(uncertainEnv, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const uncertain = createMockAdapter({ emissions: [
    { accepted: false, kind: "uncertain", code: 500, message: "timeout" },
    { accepted: false, kind: "uncertain", code: 500, message: "timeout" },
  ] });
  const timeout = await submitInvoice(uncertainEnv, {
    slug: SLUG, orderId: "ord-1", config: config(), adapter: uncertain, now: NOW,
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, "provider_uncertain");
  assert.equal(timeout.invoice.status, "pending");
  assert.equal(rowOf(uncertainEnv, "ord-1").idempotency_key, "invoice:pizza:ord-1:1");
  assert.equal(rowOf(uncertainEnv, "ord-1").failure_code, "provider_uncertain");
  const retrySame = await submitInvoice(uncertainEnv, {
    slug: SLUG, orderId: "ord-1", config: config(), adapter: uncertain, now: NOW + 1,
  });
  assert.equal(retrySame.ok, false);
  assert.equal(uncertain.calls().emitCalls, 2);
  assert.equal(rowOf(uncertainEnv, "ord-1").attempt, 1, "un timeout no crea un intento nuevo");

  const conflictEnv = envWith("pizza");
  await prepareInvoice(conflictEnv, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const conflict = createMockAdapter({ emissions: [{ accepted: false, kind: "conflict", code: 3005, message: "conflicto" }] });
  const conflictResult = await submitInvoice(conflictEnv, {
    slug: SLUG, orderId: "ord-1", config: config(), adapter: conflict, now: NOW,
  });
  assert.equal(conflictResult.code, "idempotency_conflict");
  const reconciliation = await retryInvoice(conflictEnv, {
    slug: SLUG, orderId: "ord-1", session: SESSION, config: config(), adapter: conflict, now: NOW + 1,
  });
  assert.equal(reconciliation.code, "invoice_requires_reconciliation");

  const configEnv = envWith();
  await prepareInvoice(configEnv, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const broken = createMockAdapter({ emissions: [{ accepted: false, kind: "configuration", code: 4002, message: "firma inválida" }] });
  const configResult = await submitInvoice(configEnv, {
    slug: SLUG, orderId: "ord-1", config: config(), adapter: broken, now: NOW,
  });
  assert.equal(configResult.code, "provider_configuration");
  assert.equal(configResult.invoice.status, "manual");
});

test("guardas de producción: mock prohibido, validación fiscal y aprobación explícita", async () => {
  const env = envWith();
  await prepareInvoice(env, {
    slug: SLUG, order: posOrder(),
    config: config({ environment: "production", fiscalValidated: true, productionApproved: true }), now: NOW,
  });
  const productionMock = createMockAdapter({ environment: "production" });
  const mockResult = await submitInvoice(env, {
    slug: SLUG, orderId: "ord-1", config: config({ environment: "production", fiscalValidated: true, productionApproved: true }),
    adapter: productionMock, now: NOW,
  });
  assert.equal(mockResult.code, "mock_not_allowed_in_production");
  assert.equal(productionMock.calls().emitCalls, 0);

  const fake = {
    name: "ecuafact", environment: "production", emitted: 0,
    async emit() { this.emitted++; return { accepted: true, kind: "processing", operationId: "prod-op" }; },
    async fetchStatus() { return { state: "processing" }; },
  };
  const noFiscal = await submitInvoice(env, {
    slug: SLUG, orderId: "ord-1",
    config: config({ environment: "production", fiscalValidated: false, productionApproved: false }),
    adapter: fake, now: NOW,
  });
  assert.equal(noFiscal.code, "fiscal_validation_required");

  const noApproval = await submitInvoice(env, {
    slug: SLUG, orderId: "ord-1",
    config: config({ environment: "production", fiscalValidated: true, productionApproved: false }),
    adapter: fake, now: NOW,
  });
  assert.equal(noApproval.code, "production_not_approved");

  const approved = await submitInvoice(env, {
    slug: SLUG, orderId: "ord-1",
    config: config({ environment: "production", fiscalValidated: true, productionApproved: true }),
    adapter: fake, now: NOW,
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.invoice.status, "submitted");
  assert.equal(fake.emitted, 1);

  const sandboxAdapter = createMockAdapter({ environment: "sandbox" });
  const mismatch = await submitInvoice(env, {
    slug: SLUG, orderId: "ord-1",
    config: config({ environment: "production", fiscalValidated: true, productionApproved: true }),
    adapter: sandboxAdapter, now: NOW + 10,
  });
  assert.equal(mismatch.code, "environment_mismatch");
});

/* ── Adaptadores ──────────────────────────────────────────────────────────── */

test("Ecuafact: payload oficial, ambiente sandbox y consulta de operación", async () => {
  const draft = invoiceDraftFromOrder({ order: posOrder(), config: config(), now: NOW });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      estado: "recibido", codEstado: 1001, idOperacion: "3f1c8c1e-6f2a-4b7e-9c3d-2a1b0c9d8e7f",
      numeroDocumento: "001-001-000000123", claveAcceso: null,
    }), { status: 202, headers: { "content-type": "application/json" } });
  };
  const adapter = createEcuafactAdapter({ apiKey: "api-key-secreta", ruc: RUC, environment: "sandbox", fetchImpl });
  const result = await adapter.emit(draft, { idempotencyKey: "invoice:pizza:ord-1:1", externalReference: "ORD-ord-1" });
  assert.equal(result.accepted, true);
  assert.equal(result.kind, "processing");
  assert.equal(result.operationId, "3f1c8c1e-6f2a-4b7e-9c3d-2a1b0c9d8e7f");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://staging-api.mynexusapi.com/v1/contribuyentes/${RUC}/facturas`);
  assert.equal(calls[0].init.headers["X-Api-Key"], "api-key-secreta");
  assert.equal(calls[0].init.headers["Idempotency-Key"], "invoice:pizza:ord-1:1");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.origenReferencia, "craft-panel");
  assert.equal(body.referenciaExterna, "ORD-ord-1");
  assert.equal(body.infoTributaria.ruc, RUC);
  assert.equal(body.infoTributaria.estab, "001");
  assert.equal(body.infoTributaria.ptoEmi, "001");
  assert.equal(body.infoTributaria.tipoDocumento, undefined);
  assert.equal(body.info.totalSinImpuestos, 10);
  assert.equal(body.info.totalDescuento, 0);
  assert.equal(body.info.importeTotal, 11.5);
  assert.equal(body.info.moneda, "DOLAR");
  assert.deepEqual(body.info.pagos, [{ formaPago: "01", total: 11.5 }]);
  assert.deepEqual(body.info.totalConImpuestos, [{ codigo: "2", codigoPorcentaje: "4", tarifa: 15, baseImponible: 10, valor: 1.5 }]);
  assert.equal(body.detalles[0].codigoPrincipal, "p1");
  assert.equal(body.detalles[0].precioUnitario, 8.7);
  assert.equal(body.detalles[0].precioTotalSinImpuesto, 8.7);
  assert.deepEqual(body.detalles[0].impuestos, [{ codigo: "2", codigoPorcentaje: "4", tarifa: 15, baseImponible: 8.7, valor: 1.3 }]);

  const statusCalls = [];
  const statusFetch = async (url, init) => {
    statusCalls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      estado: "autorizado", codEstado: 2001, claveAcceso: ACCESS_KEY,
      numeroDocumento: "001-001-000000123",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const statusAdapter = createEcuafactAdapter({ apiKey: "api-key-secreta", ruc: RUC, environment: "sandbox", fetchImpl: statusFetch });
  const status = await statusAdapter.fetchStatus({ operationId: "3f1c8c1e-6f2a-4b7e-9c3d-2a1b0c9d8e7f" });
  assert.equal(status.state, "authorized");
  assert.equal(status.accessKey, ACCESS_KEY);
  assert.equal(status.authorizationNumber, ACCESS_KEY);
  assert.equal(statusCalls[0].url, "https://staging-api.mynexusapi.com/v1/operaciones/3f1c8c1e-6f2a-4b7e-9c3d-2a1b0c9d8e7f");

  const invalid = await statusAdapter.fetchStatus({ operationId: "no-es-uuid" });
  assert.equal(invalid.state, "unknown");
  assert.equal(statusCalls.length, 1);

  assert.throws(() => createEcuafactAdapter({ apiKey: "k", ruc: "123", environment: "sandbox" }), /RUC/);
  assert.throws(() => createEcuafactAdapter({ apiKey: "k", ruc: RUC, environment: "otro" }), /ambiente/);
});

test("Ecuafact: 5007 y 5001 no confirman ni rechazan; se conserva submitted", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const mock = createMockAdapter({
    emissions: [{ accepted: true, kind: "processing", operationId: "mock-op-5007" }],
    statuses: [{ state: "unknown", code: 5007, message: "resultado no confirmado" }],
  });
  const result = await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: mock, now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.code, "resultado_no_confirmado");
  assert.equal(result.invoice.status, "submitted");
  assert.equal(rowOf(env, "ord-1").sri_status, "unknown");
  assert.equal(rowOf(env, "ord-1").failure_code, "resultado_no_confirmado");
  assert.equal(mock.calls().emitCalls, 1);
});

test("Factuplan: devReference, sin header de idempotencia y tarifas soportadas", async () => {
  const draft = invoiceDraftFromOrder({ order: posOrder(), config: config(), now: NOW });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      data: { id: "receipt-1", status: "DRAFT", sequential: "000000001", accessKey: null },
      meta: { requestId: "req-1" },
    }), { status: 201, headers: { "content-type": "application/json" } });
  };
  const adapter = createFactuplanAdapter({
    apiKey: "ak_test_factuplan", ruc: RUC, environment: "sandbox", fetchImpl,
  });
  const result = await adapter.emit(draft, { idempotencyKey: "ignorada", externalReference: "ORD-ord-1" });
  assert.equal(result.accepted, true);
  assert.equal(result.kind, "processing");
  assert.equal(result.operationId, "receipt-1");
  assert.equal(calls[0].url, "https://api-rest.factuplan.com.ec/v1/developer/invoices");
  assert.equal(calls[0].init.headers["X-API-Key"], "ak_test_factuplan");
  assert.equal(calls[0].init.headers["x-taxpayer-ruc"], RUC);
  assert.equal(calls[0].init.headers["X-Idempotency-Key"], undefined, "Factuplan ignora cabeceras de idempotencia");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.devReference, "ORD-ord-1");
  assert.equal(body.customer.identificationType, "FINAL_CONSUMER");
  assert.equal(body.customer.phone, undefined, "no envía teléfonos fuera de E.164");
  assert.equal(body.items[0].taxType, "IVA_RATE");
  assert.equal(body.items[0].tax, 15);
  assert.equal(body.__environmentPrefix, undefined);

  const statusFetch = async () => new Response(JSON.stringify({
    data: { status: "AUTHORIZED", authorizationNumber: ACCESS_KEY, sequential: "000000001" },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const statusAdapter = createFactuplanAdapter({ apiKey: "ak_test_x", ruc: RUC, environment: "sandbox", fetchImpl: statusFetch });
  const status = await statusAdapter.fetchStatus({ operationId: "receipt-1" });
  assert.equal(status.state, "authorized");
  assert.equal(status.authorizationNumber, ACCESS_KEY);

  const thirteen = normalizeInvoiceConfig(config({ defaultTaxRateBp: 1300 }));
  const draft13 = invoiceDraftFromOrder({ order: posOrder(), config: thirteen, now: NOW });
  assert.equal(draft13.ready, true);
  const unsupported = await adapter.emit(draft13, { externalReference: "ORD-13" });
  assert.equal(unsupported.accepted, false);
  assert.equal(unsupported.kind, "configuration");
  assert.equal(unsupported.code, "payload_invalid");

  assert.throws(() => createFactuplanAdapter({ apiKey: "ak_live_x", ruc: RUC, environment: "sandbox" }), /ak_test_/);
  assert.throws(() => createFactuplanAdapter({ apiKey: "ak_test_x", ruc: "123", environment: "sandbox" }), /RUC/);
  assert.throws(() => createFactuplanAdapter({ apiKey: "ak_test_x", ruc: RUC, environment: "otro" }), /ambiente/);
});

test("adaptador mock y selección por configuración", async () => {
  const mock = createMockAdapter({ emissions: [{ accepted: true, kind: "processing", operationId: "op-1" }] });
  const emitted = await mock.emit({}, { idempotencyKey: "k" });
  assert.equal(emitted.operationId, "op-1");
  assert.deepEqual(mock.calls(), { emitCalls: 1, statusCalls: 0 });
  assert.deepEqual(mock.buildPayload({ orderId: "ord-1" }), { mock: true, orderId: "ord-1" });

  const env = envWith();
  assert.equal(adapterFor(env, config()).name, "ecuafact");
  assert.equal(adapterFor(env, config({ emitEnabled: false })).name, "ecuafact", "consulta no depende de emitir");
  assert.equal(adapterFor(env, config({ environment: null })), null);
  assert.equal(adapterFor(env, config({ provider: "factuplan" })), null, "falta FACTUPLAN_API_KEY");
  env.FACTUPLAN_API_KEY = "ak_test_x";
  assert.equal(adapterFor(env, config({ provider: "factuplan" })).name, "factuplan");
  delete env.ECUAFACT_API_KEY;
  assert.equal(adapterFor(env, config()), null);
});

/* ── Webhooks firmados ────────────────────────────────────────────────────── */

test("webhook Ecuafact: firma HMAC sobre cuerpo crudo, tolerancia y reconsulta", async () => {
  const env = envWith(config(), { ECUAFACT_WEBHOOK_SECRET: "secreto-webhook" });
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const submitMock = createMockAdapter({ statuses: [{ state: "processing" }] });
  await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: submitMock, now: NOW });
  assert.equal(rowOf(env, "ord-1").provider_operation_id, "mock-op-1");

  const body = JSON.stringify({
    eventType: "document.authorized", resourceId: "mock-op-1", idOperacion: "mock-op-1",
    estado: "autorizado", codEstado: 2001, claveAcceso: ACCESS_KEY, errores: [],
  });
  const timestamp = Math.floor(NOW / 1000);
  const signature = sign(body, "secreto-webhook", timestamp);
  const refreshMock = createMockAdapter({
    statuses: [{ state: "authorized", accessKey: ACCESS_KEY, authorizationNumber: ACCESS_KEY }],
  });

  const valid = await handleInvoiceWebhook(
    jsonRequest(body, { "Ecuafact-Signature": signature }), env, { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { received: true, matched: true, status: "issued" });
  assert.equal(rowOf(env, "ord-1").status, "issued");

  const invalid = await handleInvoiceWebhook(
    jsonRequest(body, { "Ecuafact-Signature": signature.replace(/.$/, "0") }), env, { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: "firma_invalida" });

  const stale = await handleInvoiceWebhook(
    jsonRequest(body, { "Ecuafact-Signature": signature }), env, { slug: SLUG }, { adapter: refreshMock, now: NOW + 301_000 },
  );
  assert.equal(stale.status, 401);

  const missing = await handleInvoiceWebhook(jsonRequest(body), env, { slug: SLUG }, { adapter: refreshMock, now: NOW });
  assert.equal(missing.status, 401);

  const unknownBody = JSON.stringify({ eventType: "document.authorized", resourceId: "otro", idOperacion: "otro" });
  const unknown = await handleInvoiceWebhook(
    jsonRequest(unknownBody, { "Ecuafact-Signature": sign(unknownBody, "secreto-webhook", timestamp) }),
    env, { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(unknown.status, 200);
  assert.deepEqual(await unknown.json(), { received: true, matched: false });

  const badJson = "{no es json";
  const bad = await handleInvoiceWebhook(
    jsonRequest(badJson, { "Ecuafact-Signature": sign(badJson, "secreto-webhook", timestamp) }),
    env, { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(bad.status, 400);

  const getResponse = await handleInvoiceWebhook(
    new Request("https://pizza.craft-systems.com/panel/webhooks/invoices"), env, { slug: SLUG },
  );
  assert.equal(getResponse.status, 405);

  const huge = "x".repeat(9000);
  const hugeResponse = await handleInvoiceWebhook(
    jsonRequest(huge, { "Ecuafact-Signature": sign(huge, "secreto-webhook", timestamp) }), env, { slug: SLUG },
  );
  assert.equal(hugeResponse.status, 413);
});

test("webhook Factuplan: token propio y reconsulta obligatoria", async () => {
  const cfg = config({ provider: "factuplan" });
  const env = envWith(cfg, { INVOICE_WEBHOOK_TOKEN: "token-interno", FACTUPLAN_API_KEY: "ak_test_x" });
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: cfg, now: NOW });
  env.DB.raw.prepare("UPDATE invoices SET provider_operation_id = ? WHERE slug = ? AND order_id = ?")
    .run("factuplan-op-1", SLUG, "ord-1");

  const body = JSON.stringify({ eventType: "invoice.authorized", devReference: "ORD-ord-1" });
  const refreshMock = createMockAdapter({
    statuses: [{ state: "authorized", accessKey: ACCESS_KEY, authorizationNumber: ACCESS_KEY }],
  });
  const missingToken = await handleInvoiceWebhook(jsonRequest(body), env, { slug: SLUG }, { adapter: refreshMock, now: NOW });
  assert.equal(missingToken.status, 401);

  const valid = await handleInvoiceWebhook(
    jsonRequest(body, { "x-webhook-token": "token-interno" }), env, { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { received: true, matched: true, status: "issued" });

  const unconfigured = await handleInvoiceWebhook(
    jsonRequest(body, { "x-webhook-token": "token-interno" }), makeEnv(), { slug: SLUG }, { adapter: refreshMock, now: NOW },
  );
  assert.equal(unconfigured.status, 503);
});

test("verifyEcuafactSignature: vector propio, firma alterada y tiempo fuera de tolerancia", async () => {
  const secret = "s3cr3t";
  const body = JSON.stringify({ hola: "mundo" });
  const timestamp = 1_700_000_000;
  const header = sign(body, secret, timestamp);
  assert.equal(await verifyEcuafactSignature({ secret, header, body, now: timestamp }), true);
  assert.equal(await verifyEcuafactSignature({ secret, header, body, now: timestamp + 300 }), true);
  assert.equal(await verifyEcuafactSignature({ secret, header, body, now: timestamp + 301 }), false);
  assert.equal(await verifyEcuafactSignature({ secret: "otro", header, body, now: timestamp }), false);
  assert.equal(await verifyEcuafactSignature({ secret, header, body: body + " ", now: timestamp }), false);
  assert.equal(await verifyEcuafactSignature({ secret, header: "t=abc,v1=123", body, now: timestamp }), false);
  assert.equal(await verifyEcuafactSignature({ secret: "", header, body, now: timestamp }), false);
  assert.equal(await verifyEcuafactSignature({ secret, header: "", body, now: timestamp }), false);
});

/* ── Rutas para el integrador ─────────────────────────────────────────────── */

test("handleGetInvoice exige sesión y devuelve solo datos públicos de la factura", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const request = new Request("https://pizza.craft-systems.com/panel/api/invoices/ord-1");

  const noSession = await handleGetInvoice(request, env, { slug: SLUG }, null, "ord-1");
  assert.equal(noSession.status, 401);
  assert.deepEqual(await noSession.json(), { error: "sin_sesion" });

  const found = await handleGetInvoice(request, env, { slug: SLUG }, SESSION, "ord-1");
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), {
    status: "pending", reference: "ORD-ord-1", pdf_url: null, document_number: null,
    access_key: null, issued_at: null, updated_at: NOW, requires_action: false, message: null,
  });

  const missing = await handleGetInvoice(request, env, { slug: SLUG }, SESSION, "no-existe");
  assert.equal(missing.status, 404);
  const badEncoding = await handleGetInvoice(request, env, { slug: SLUG }, SESSION, "%E0%A4%A");
  assert.equal(badEncoding.status, 404);

  const post = new Request("https://pizza.craft-systems.com/panel/api/invoices/ord-1", { method: "POST" });
  assert.equal((await handleGetInvoice(post, env, { slug: SLUG }, SESSION, "ord-1")).status, 405);
});

test("handleRetryInvoice exige sesión y respeta la corrección explícita", async () => {
  const env = envWith();
  await prepareInvoice(env, { slug: SLUG, order: posOrder(), config: config(), now: NOW });
  const rejected = createMockAdapter({ emissions: [{ accepted: false, kind: "rejected", code: 3001, message: "rechazo" }] });
  await submitInvoice(env, { slug: SLUG, orderId: "ord-1", config: config(), adapter: rejected, now: NOW });

  const noSession = await handleRetryInvoice(jsonRequest({}), env, { slug: SLUG }, null, "ord-1");
  assert.equal(noSession.status, 401);

  const blocked = await handleRetryInvoice(jsonRequest({}), env, { slug: SLUG }, SESSION, "ord-1");
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json();
  assert.equal(blockedBody.error, "invoice_requires_correction");
  assert.equal(blockedBody.invoice.status, "failed");

  const accepted = createMockAdapter({ emissions: [{ accepted: true, kind: "processing", operationId: "op-retry" }], statuses: [{ state: "processing" }] });
  const forced = await handleRetryInvoice(
    jsonRequest({ confirm_new_attempt: true }), env, { slug: SLUG }, SESSION, "ord-1", { adapter: accepted, now: NOW + 1 },
  );
  assert.equal(forced.status, 200);
  assert.equal((await forced.json()).status, "submitted");
  assert.equal(rowOf(env, "ord-1").attempt, 2);
});

test("publicInvoice no expone snapshot, cliente ni secretos", () => {
  assert.equal(publicInvoice(null), null);
  const row = {
    status: "issued", access_key: ACCESS_KEY, authorization_number: null, document_number: "001-001-000000001",
    external_reference: "ORD-1", pdf_url: null, issued_at: NOW, updated_at: NOW + 1,
    failure_message: null, snapshot: "{\"customer\":{\"identification\":\"9999999999999\"}}",
    idempotency_key: "invoice:pizza:ord-1:1",
  };
  assert.deepEqual(publicInvoice(row), {
    status: "issued", reference: ACCESS_KEY, pdf_url: null, document_number: "001-001-000000001",
    access_key: ACCESS_KEY, issued_at: NOW, updated_at: NOW + 1, requires_action: false, message: null,
  });
});
