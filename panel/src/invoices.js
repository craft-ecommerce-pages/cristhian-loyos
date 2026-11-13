// Facturación electrónica (Ecuador) — adaptador aislado del pago.
//
// Contrato:
//  - invoiceDraftFromOrder({order, config, now}) recibe un snapshot YA PAGADO y devuelve un
//    borrador neutral con centavos enteros y tasas configurables (nunca un IVA fijo).
//  - prepareInvoice() crea una sola fila por (slug, order_id): la idempotencia es el pedido.
//  - submitInvoice() habla con el proveedor solo si la configuración lo habilita de forma
//    explícita. Sin proveedor queda `manual`; nunca se emite en producción por defecto.
//  - refreshInvoice() confirma el estado en el proveedor/SRI antes de pasar a `issued`.
//  - handleInvoiceWebhook() solo acepta firmas HMAC verificadas y SIEMPRE reconsulta;
//    el payload nunca cambia el estado por sí solo.
//
// Proveedor: Facturón (https://facturon.ec/docs/api). Secretos solo desde env
// (`FACTURON_API_KEY`, `FACTURON_WEBHOOK_SECRET`). Nunca se escriben en D1, KV, logs ni Git.
import { error, json } from "./contract.js";

export const INVOICE_SCHEMA = "invoice-draft.v1";
export const INVOICE_STATUSES = Object.freeze(["pending", "manual", "submitted", "issued", "failed"]);

const ENCODER = new TextEncoder();
const MAX_WEBHOOK_BYTES = 64 * 1024;
const SUBMIT_LOCK_MS = 5 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const ECON_FINAL_CONSUMER_MAX_CENTS = 5000; // USD 50.00, límite del SRI para consumidor final
const SRI_IVA_CODE_BY_RATE_BP = new Map([
  [0, "0"], [500, "5"], [800, "8"], [1200, "2"], [1300, "10"], [1400, "3"], [1500, "4"],
]);
// Forma de pago SRI según cómo se cobró el pedido (01 sin sistema financiero,
// 19 tarjeta de crédito, 20 otros con sistema financiero). `paymentMethod` cubre el resto.
const SRI_PAYMENT_BY_ORDER_METHOD = Object.freeze({ cash: "01", transfer: "20", bendo: "19", payphone: "19" });
const IDENTIFICATION_TYPES = new Map([
  ["RUC", "04"], ["CEDULA", "05"], ["CÉDULA", "05"], ["PASSPORT", "06"], ["PASAPORTE", "06"],
  ["FINAL_CONSUMER", "07"], ["CONSUMIDOR_FINAL", "07"], ["EXTERIOR", "08"],
]);
const PATCH_COLUMNS = new Set([
  "status", "provider", "environment", "attempt", "idempotency_key", "external_reference",
  "provider_operation_id", "document_number", "access_key", "authorization_number",
  "provider_status", "sri_status", "failure_code", "failure_message", "pdf_url",
  "updated_at", "submitted_at", "issued_at",
]);

const isPlainObject = value => value != null && typeof value === "object" && !Array.isArray(value);
const isNonNegativeInt = value => Number.isSafeInteger(value) && value >= 0;
const isPositiveInt = value => Number.isSafeInteger(value) && value > 0;
const clampText = (value, max = 300) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const pad3 = value => {
  const text = String(value ?? "").trim();
  return /^\d{1,3}$/.test(text) ? text.padStart(3, "0") : null;
};
const amount = cents => Number((Number(cents || 0) / 100).toFixed(2));
const round6 = value => Number(Number(value).toFixed(6));
const decodeId = value => { try { return decodeURIComponent(value); } catch { return null; } };

function timingEqual(left, right) {
  const a = left instanceof Uint8Array ? left : ENCODER.encode(String(left ?? ""));
  const b = right instanceof Uint8Array ? right : ENCODER.encode(String(right ?? ""));
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}

async function sha256hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

// JSON estable: el hash del borrador no depende del orden de las claves.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function isPaidOrder(order) {
  if (!isPlainObject(order)) return false;
  if (order.paid === true || Number(order.paid) === 1) return true;
  if (order.payment_status === "paid" || order.paymentStatus === "paid") return true;
  const status = String(order.status ?? "").trim().toLowerCase();
  if (status === "paid" || status === "pagado") return true;
  // Un estado explícito distinto de pagado manda sobre un paid_at residual:
  // un pedido pending/confirmed nunca debe facturarse.
  if (status) return false;
  return isPositiveInt(order.paid_at) || isPositiveInt(order.paidAt);
}

// ── Configuración fiscal (KV `${slug}:invoices`; nunca secretos) ─────────────

export function normalizeInvoiceConfig(input) {
  const raw = isPlainObject(input) ? input : {};
  const establishments = Array.isArray(raw.establishments)
    ? raw.establishments.map(pad3).filter(Boolean)
    : null;
  const firstEstablishment = pad3(raw.establishment) || establishments?.[0] || null;
  const categories = {};
  if (isPlainObject(raw.taxRatesByCategory)) {
    for (const [key, value] of Object.entries(raw.taxRatesByCategory)) {
      if (Number.isSafeInteger(value) && value >= 0 && value <= 10000) categories[clampText(key, 60)] = value;
    }
  }
  const provider = raw.provider === "facturon" ? "facturon" : null;
  const environment = ["sandbox", "production"].includes(raw.environment) ? raw.environment : null;
  return {
    provider,
    environment,
    companyId: isPositiveInt(raw.companyId) ? raw.companyId : null,
    emissionPointId: isPositiveInt(raw.emissionPointId) ? raw.emissionPointId : null,
    emitEnabled: raw.emitEnabled === true,
    fiscalValidated: raw.fiscalValidated === true,
    productionApproved: raw.productionApproved === true,
    ruc: /^\d{13}$/.test(String(raw.ruc ?? "")) ? String(raw.ruc) : null,
    legalName: clampText(raw.legalName, 300) || null,
    establishment: firstEstablishment,
    establishments: establishments || (firstEstablishment ? [firstEstablishment] : []),
    emissionPoint: pad3(raw.emissionPoint) || null,
    origin: /^[A-Za-z0-9._:/-]{1,64}$/.test(String(raw.origin ?? "")) ? String(raw.origin) : "craft-panel",
    currency: normalizeCurrency(raw.currency),
    pricesIncludeTax: raw.pricesIncludeTax === true ? true : raw.pricesIncludeTax === false ? false : null,
    defaultTaxRateBp: Number.isSafeInteger(raw.defaultTaxRateBp) && raw.defaultTaxRateBp >= 0 && raw.defaultTaxRateBp <= 10000
      ? raw.defaultTaxRateBp : null,
    taxRatesByCategory: categories,
    allowFinalConsumer: raw.allowFinalConsumer === true,
    finalConsumerMaxCents: isNonNegativeInt(raw.finalConsumerMaxCents)
      ? raw.finalConsumerMaxCents : ECON_FINAL_CONSUMER_MAX_CENTS,
    paymentMethod: /^\d{2}$/.test(String(raw.paymentMethod ?? "")) ? String(raw.paymentMethod) : "01",
    supplierRuc: /^\d{13}$/.test(String(raw.supplierRuc ?? "")) ? String(raw.supplierRuc) : null,
    additionalInfo: normalizeAdditionalInfo(raw.additionalInfo),
    legacyPricesAreCurrency: raw.legacyPricesAreCurrency === true,
    refreshAfterMs: isNonNegativeInt(raw.refreshAfterMs) ? raw.refreshAfterMs : 60 * 1000,
  };
}

function normalizeCurrency(value) {
  const text = String(value ?? "").trim().toUpperCase();
  if (text === "$" || text === "USD" || text === "DOLAR" || text === "DÓLAR") return "USD";
  return null;
}

function normalizeAdditionalInfo(value) {
  const entries = Array.isArray(value)
    ? value.map(item => [item?.nombre ?? item?.name, item?.valor ?? item?.value])
    : isPlainObject(value) ? Object.entries(value) : [];
  const out = [];
  for (const [name, text] of entries) {
    const label = clampText(name, 300), body = clampText(text, 300);
    if (label && body) out.push({ name: label, value: body });
    if (out.length >= 20) break;
  }
  return out;
}

export async function loadInvoiceConfig(env, slug) {
  const raw = await env?.MENUS?.get(`${slug}:invoices`, "json").catch(() => null);
  return normalizeInvoiceConfig(raw);
}

// ── Borrador neutral (centavos enteros, tasas configurables) ─────────────────

export function invoiceDraftFromOrder({ order, config, now = Date.now() } = {}) {
  const cfg = normalizeInvoiceConfig(config);
  const blocked = [];
  const warnings = [];
  if (!isPlainObject(order) || !order.id) blocked.push("order_id_missing");
  if (!isPaidOrder(order)) blocked.push("order_not_paid");
  if (!cfg.currency) blocked.push("currency_not_supported");
  if (!cfg.establishment || !cfg.emissionPoint) blocked.push("establishment_not_configured");
  if (Array.isArray(cfg.establishments) && cfg.establishments.length > 1) {
    blocked.push("multiple_establishments_require_fiscal_validation");
  }
  if (cfg.fiscalValidated !== true) warnings.push("fiscal_validation_pending");

  const totalCents = paidTotalCents(order, cfg, blocked);
  if (totalCents != null && totalCents <= 0) blocked.push("total_zero");
  const customer = invoiceCustomer(order, cfg, totalCents, blocked);

  const rawLines = orderLines(order);
  if (!rawLines.length) blocked.push("order_lines_missing");
  const lines = [];
  const groups = new Map();
  let subtotalCents = 0, taxCents = 0, discountCents = 0;
  let taxesResolved = true;

  rawLines.forEach((item, index) => {
    const line = invoiceLine(item, index, cfg, blocked);
    lines.push(line);
    discountCents += line.discountCents;
    subtotalCents += line.baseCents;
    if (line.taxCents == null) {
      taxesResolved = false;
    } else {
      taxCents += line.taxCents;
      const groupKey = `${line.taxCode}:${line.taxRateBp}`;
      const group = groups.get(groupKey) || {
        code: line.taxCode, rateBp: line.taxRateBp, baseCents: 0, taxCents: 0,
      };
      group.baseCents += line.baseCents;
      group.taxCents += line.taxCents;
      groups.set(groupKey, group);
    }
  });

  if (!taxesResolved) blocked.push("tax_rate_not_configured");
  if (cfg.pricesIncludeTax == null) blocked.push("tax_mode_not_configured");

  const computedTotal = taxesResolved ? subtotalCents + taxCents : null;
  if (totalCents != null && computedTotal != null && computedTotal !== totalCents) {
    blocked.push("total_mismatch");
  }

  const uniqueBlocked = [...new Set(blocked)];
  const additionalInfo = [...cfg.additionalInfo];
  if (order.id && !additionalInfo.some(item => item.name.toLowerCase() === "pedido")) {
    additionalInfo.push({ name: "Pedido", value: clampText(order.id, 300) });
  }
  if (cfg.supplierRuc && !additionalInfo.some(item => item.name.toLowerCase().includes("ruc proveedor"))) {
    additionalInfo.push({ name: "RUC proveedor sistema", value: cfg.supplierRuc });
  }

  const stamp = Number.isFinite(now) ? now : Date.now();
  const fiscalStamp = isPositiveInt(order?.paid_at) ? order.paid_at
    : isPositiveInt(order?.paidAt) ? order.paidAt : stamp;
  return {
    schema: INVOICE_SCHEMA,
    orderId: order?.id ? String(order.id) : null,
    generatedAt: new Date(stamp).toISOString(),
    date: ecuadorFiscalDate(fiscalStamp),
    documentType: "01",
    currency: cfg.currency,
    origin: cfg.origin,
    taxMode: cfg.pricesIncludeTax === true ? "inclusive" : cfg.pricesIncludeTax === false ? "exclusive" : "unresolved",
    customer,
    lines,
    totals: {
      subtotalCents,
      taxCents: taxesResolved ? taxCents : null,
      discountCents,
      totalCents: computedTotal,
    },
    taxes: [...groups.values()],
    payment: { method: SRI_PAYMENT_BY_ORDER_METHOD[order?.payment_method] || cfg.paymentMethod, amountCents: computedTotal },
    establishment: cfg.establishment,
    emissionPoint: cfg.emissionPoint,
    additionalInfo: additionalInfo.slice(0, 20),
    blockedReasons: uniqueBlocked,
    warnings,
    ready: uniqueBlocked.length === 0,
  };
}

function ecuadorFiscalDate(ms) {
  const local = new Date(ms - 5 * 3600 * 1000);
  const [year, month, day] = local.toISOString().slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
}

function paidTotalCents(order, cfg, blocked) {
  if (isNonNegativeInt(order?.total_cents)) return order.total_cents;
  if (isNonNegativeInt(order?.totalCents)) return order.totalCents;
  if (cfg.legacyPricesAreCurrency && typeof order?.total === "number" && Number.isFinite(order.total) && order.total >= 0) {
    return Math.round(order.total * 100);
  }
  blocked.push("total_cents_missing");
  return null;
}

function orderLines(order) {
  const value = Array.isArray(order?.lines) ? order.lines
    : Array.isArray(order?.items) ? order.items
      : parseJson(order?.lines) || parseJson(order?.items) || [];
  return Array.isArray(value) ? value : [];
}

function invoiceLine(item, index, cfg, blocked) {
  const raw = isPlainObject(item) ? item : {};
  const quantity = Number(raw.qty ?? raw.quantity ?? raw.cantidad ?? 0);
  const unitCents = lineUnitCents(raw, cfg);
  const grossDiscountCents = lineDiscountCents(raw, cfg);
  let grossBeforeCents = 0, grossCents = 0;
  if (!(quantity > 0) || quantity > 1_000_000) {
    blocked.push("line_quantity_invalid");
  } else if (unitCents == null) {
    blocked.push("line_price_missing");
  } else {
    const exact = quantity * unitCents;
    if (Math.abs(exact - Math.round(exact)) > 1e-6) blocked.push("line_amount_not_integer");
    grossBeforeCents = Math.round(exact);
    grossCents = grossBeforeCents - grossDiscountCents;
    if (grossCents < 0) {
      blocked.push("line_discount_invalid");
      grossCents = 0;
      grossBeforeCents = 0;
    }
  }

  const taxRateBp = lineTaxRateBp(raw, cfg);
  const taxCode = lineTaxCode(raw, taxRateBp);
  if (taxRateBp == null) blocked.push("tax_rate_not_configured");
  if (taxRateBp != null && !taxCode) blocked.push("tax_rate_unsupported");

  // `discountCents` se expresa sin impuesto cuando el precio de venta los incluye:
  // es lo que el SRI compara en `precioTotalSinImpuesto = cantidad * precioUnitario - descuento`.
  let baseCents = grossCents, lineTaxCents = 0, discountCents = grossDiscountCents;
  let netUnitCents = quantity > 0 ? grossBeforeCents / quantity : 0;
  if (taxRateBp != null && taxCode) {
    if (cfg.pricesIncludeTax === true) {
      const baseBefore = Math.round(grossBeforeCents * 10000 / (10000 + taxRateBp));
      baseCents = Math.round(grossCents * 10000 / (10000 + taxRateBp));
      lineTaxCents = grossCents - baseCents;
      discountCents = Math.max(0, baseBefore - baseCents);
      netUnitCents = quantity > 0 ? baseBefore / quantity : 0;
    } else if (cfg.pricesIncludeTax === false) {
      lineTaxCents = Math.round(grossCents * taxRateBp / 10000);
    } else {
      lineTaxCents = null;
    }
  } else {
    lineTaxCents = null;
  }

  const description = clampText(raw.description ?? raw.descripcion ?? raw.nombre ?? raw.name, 300);
  if (!description) blocked.push("line_description_missing");
  const code = clampText(raw.code ?? raw.sku ?? raw.product_id ?? raw.id, 25)
    .replace(/[^\w.:/-]/g, "") || `ITEM-${String(index + 1).padStart(2, "0")}`;

  return {
    code,
    description: description || `ITEM ${index + 1}`,
    quantity,
    unitPriceCents: unitCents,
    discountCents,
    grossCents,
    baseCents,
    taxCents: lineTaxCents,
    taxRateBp,
    taxCode: taxCode || null,
    netUnitAmount: round6(netUnitCents / 100),
  };
}

function lineUnitCents(line, cfg) {
  for (const key of ["unit_cents", "unit_price_cents", "precio_cents", "price_cents", "unitPriceCents"]) {
    if (isNonNegativeInt(line[key])) return line[key];
  }
  if (cfg.legacyPricesAreCurrency) {
    for (const key of ["unit_price", "precio", "price", "unitPrice"]) {
      if (typeof line[key] === "number" && Number.isFinite(line[key]) && line[key] >= 0) {
        return Math.round(line[key] * 100);
      }
    }
  }
  return null;
}

function lineDiscountCents(line, cfg) {
  for (const key of ["discount_cents", "descuento_cents"]) {
    if (isNonNegativeInt(line[key])) return line[key];
  }
  if (cfg.legacyPricesAreCurrency) {
    for (const key of ["discount", "descuento"]) {
      if (typeof line[key] === "number" && Number.isFinite(line[key]) && line[key] >= 0) {
        return Math.round(line[key] * 100);
      }
    }
  }
  return 0;
}

function lineTaxRateBp(line, cfg) {
  if (Number.isSafeInteger(line.tax_rate_bp) && line.tax_rate_bp >= 0 && line.tax_rate_bp <= 10000) {
    return line.tax_rate_bp;
  }
  const category = clampText(line.category ?? line.categoria, 60);
  if (category && Number.isSafeInteger(cfg.taxRatesByCategory[category])) return cfg.taxRatesByCategory[category];
  return cfg.defaultTaxRateBp;
}

function lineTaxCode(line, rateBp) {
  const explicit = String(line.tax_code ?? line.codigo_porcentaje ?? "");
  if (/^\d{1,4}$/.test(explicit)) return explicit;
  return rateBp == null ? null : SRI_IVA_CODE_BY_RATE_BP.get(rateBp) || null;
}

function invoiceCustomer(order, cfg, totalCents, blocked) {
  const raw = isPlainObject(order?.invoice_customer) ? order.invoice_customer
    : isPlainObject(order?.customer) ? order.customer
      : isPlainObject(order?.fiscal_customer) ? order.fiscal_customer
        : {};
  const rawId = clampText(raw.identification ?? raw.identificacion, 20).replace(/\s+/g, "");
  const rawType = String(raw.identification_type ?? raw.tipo_identificacion ?? raw.type ?? "").trim().toUpperCase();
  let type = IDENTIFICATION_TYPES.get(rawType) || (/^\d{2}$/.test(rawType) ? rawType : null);
  if (!type && /^\d{13}$/.test(rawId)) type = "04";
  if (!type && /^\d{10}$/.test(rawId)) type = "05";

  if (!rawId && !type) {
    if (cfg.allowFinalConsumer && totalCents != null && totalCents <= cfg.finalConsumerMaxCents) {
      type = "07";
    } else if (cfg.allowFinalConsumer && totalCents != null) {
      blocked.push("final_consumer_over_limit");
    } else {
      blocked.push("customer_identification_missing");
    }
  }
  const identification = rawId || (type === "07" ? "9999999999999" : "");
  if (type && !validIdentification(type, identification)) blocked.push("customer_identification_invalid");
  if (type === "07" && totalCents != null && totalCents > cfg.finalConsumerMaxCents) {
    blocked.push("final_consumer_over_limit");
  }

  const name = clampText(raw.legal_name ?? raw.razon_social ?? raw.name ?? raw.nombre
    ?? order?.client_name ?? order?.customer_name, 300)
    || (type === "07" ? "CONSUMIDOR FINAL" : "");
  if (!name) blocked.push("customer_name_missing");

  const email = clampText(raw.email ?? raw.correo, 500);
  return type ? {
    identificationType: type,
    identification,
    name,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null,
    address: clampText(raw.address ?? raw.direccion, 300) || null,
    phone: clampText(raw.phone ?? raw.telefono ?? order?.client_phone ?? order?.customer_phone, 40) || null,
  } : null;
}

function validIdentification(type, value) {
  if (type === "04") return /^\d{13}$/.test(value);
  if (type === "05") return /^\d{10}$/.test(value);
  if (type === "07") return value === "9999999999999";
  if (type === "06" || type === "08") return /^[A-Za-z0-9-]{1,20}$/.test(value);
  return false;
}

// ── Persistencia e idempotencia por pedido ───────────────────────────────────

const rowById = (env, id, slug) =>
  env.DB.prepare("SELECT * FROM invoices WHERE id = ? AND slug = ?").bind(id, slug).first();

const rowByOrder = (env, slug, orderId) =>
  env.DB.prepare("SELECT * FROM invoices WHERE slug = ? AND order_id = ?").bind(slug, orderId).first();

const idempotencyKey = (slug, orderId, attempt) =>
  clampText(`invoice:${slug}:${orderId}:${attempt}`, 128).replace(/[^A-Za-z0-9._:/-]/g, "-");

const externalReference = (orderId, attempt) =>
  clampText(`ORD-${orderId}${attempt > 1 ? `-R${attempt}` : ""}`, 100).replace(/[^A-Za-z0-9._:/-]/g, "-");

function manualReason(env, cfg, draft) {
  if (!draft.ready) return { code: "fiscal_setup_pending", message: draft.blockedReasons.join(", ") };
  if (!cfg.provider) return { code: "provider_not_configured", message: "Sin proveedor de facturación configurado" };
  if (!cfg.emitEnabled) return { code: "emission_disabled", message: "La emisión está deshabilitada" };
  if (!cfg.environment) return { code: "environment_not_configured", message: "Falta ambiente sandbox o production" };
  if (!providerCredentials(env, cfg)) return { code: "provider_credentials_missing", message: "Faltan credenciales del proveedor" };
  if (cfg.environment === "production" && cfg.fiscalValidated !== true) {
    return { code: "fiscal_validation_required", message: "Falta validación fiscal antes de producción" };
  }
  if (cfg.environment === "production" && cfg.productionApproved !== true) {
    return { code: "production_not_approved", message: "Producción no está autorizada" };
  }
  return { code: "manual", message: "Factura pendiente de revisión" };
}

function providerCredentials(env, cfg) {
  return cfg.provider === "facturon" && typeof env?.FACTURON_API_KEY === "string" && env.FACTURON_API_KEY.length > 0;
}

export async function prepareInvoice(env, { slug, order, config, now = Date.now() } = {}) {
  if (!env?.DB) return { ok: false, code: "db_not_configured", status: 503 };
  if (!slug || typeof slug !== "string") return { ok: false, code: "slug_invalid", status: 400 };
  if (!isPaidOrder(order)) return { ok: false, code: "order_not_paid", status: 409 };
  if (!order?.id) return { ok: false, code: "order_id_missing", status: 400 };

  const cfg = normalizeInvoiceConfig(config ?? await loadInvoiceConfig(env, slug));
  const draft = invoiceDraftFromOrder({ order, config: cfg, now });
  // La marca de generación no forma parte de la identidad del pedido; el resto sí.
  const { generatedAt: _generatedAt, ...stableDraft } = draft;
  const draftHash = await sha256hex(canonicalJson(stableDraft));
  const orderId = String(order.id);

  const existing = await rowByOrder(env, slug, orderId);
  if (existing) {
    if (existing.draft_hash !== draftHash) {
      return { ok: false, code: "invoice_conflict", status: 409, invoice: publicInvoice(existing) };
    }
    return { ok: true, created: false, invoice: publicInvoice(existing) };
  }

  const reason = manualReason(env, cfg, draft);
  const canSubmit = draft.ready && !reason.code.match(/^(provider_not_configured|emission_disabled|environment_not_configured|provider_credentials_missing|fiscal_validation_required|production_not_approved)$/);
  const status = canSubmit ? "pending" : "manual";
  const id = crypto.randomUUID();

  try {
    await env.DB.prepare(
      "INSERT INTO invoices (id, slug, order_id, status, provider, environment, attempt, idempotency_key, " +
      "external_reference, draft_hash, snapshot, currency, subtotal_cents, tax_cents, total_cents, " +
      "provider_operation_id, document_number, access_key, authorization_number, provider_status, sri_status, " +
      "failure_code, failure_message, pdf_url, created_at, updated_at, submitted_at, issued_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, NULL, NULL)",
    ).bind(
      id, slug, orderId, status, cfg.provider, cfg.environment, idempotencyKey(slug, orderId, 1),
      externalReference(orderId, 1), draftHash, JSON.stringify(draft), draft.currency || null,
      Number.isSafeInteger(draft.totals.subtotalCents) ? draft.totals.subtotalCents : null,
      Number.isSafeInteger(draft.totals.taxCents) ? draft.totals.taxCents : null,
      Number.isSafeInteger(draft.totals.totalCents) ? draft.totals.totalCents : null,
      status === "manual" ? reason.code : null, status === "manual" ? clampText(reason.message, 300) : null,
      now, now,
    ).run();
  } catch {
    // Carrera con otra petición del mismo pedido: devuelve la fila ya creada.
    const raced = await rowByOrder(env, slug, orderId);
    if (!raced) return { ok: false, code: "invoice_write_failed", status: 503 };
    if (raced.draft_hash !== draftHash) {
      return { ok: false, code: "invoice_conflict", status: 409, invoice: publicInvoice(raced) };
    }
    return { ok: true, created: false, invoice: publicInvoice(raced) };
  }

  const created = await rowById(env, id, slug);
  await appendEvent(env, created, "prepared", null, status, null, now);
  return { ok: true, created: true, invoice: publicInvoice(created) };
}

async function appendEvent(env, row, kind, fromStatus, toStatus, detail, now) {
  await env.DB.prepare(
    "INSERT INTO invoice_events (invoice_id, slug, at, kind, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.slug, now, kind, fromStatus ?? null, toStatus ?? null, clampText(detail, 300) || null).run();
}

async function patchInvoice(env, row, patch, now, event = null) {
  const keys = Object.keys(patch).filter(key => PATCH_COLUMNS.has(key));
  if (!keys.length) return row;
  if (!keys.includes("updated_at")) {
    keys.push("updated_at");
    patch.updated_at = now;
  }
  await env.DB.prepare(
    `UPDATE invoices SET ${keys.map(key => `${key} = ?`).join(", ")} WHERE id = ? AND slug = ?`,
  ).bind(...keys.map(key => patch[key]), row.id, row.slug).run();
  if (event) await appendEvent(env, row, event.kind, row.status, patch.status ?? row.status, event.detail, now);
  return rowById(env, row.id, row.slug);
}

export function publicInvoice(row) {
  if (!row) return null;
  return {
    status: row.status,
    reference: row.access_key || row.authorization_number || row.document_number || row.external_reference || null,
    pdf_url: row.pdf_url || null,
    document_number: row.document_number || null,
    access_key: row.access_key || null,
    issued_at: row.issued_at || null,
    updated_at: row.updated_at,
    requires_action: row.status === "manual" || row.status === "failed",
    message: row.failure_message || null,
  };
}

// ── Emisión y confirmación ───────────────────────────────────────────────────

export function adapterFor(env, cfg) {
  const config = normalizeInvoiceConfig(cfg);
  // La construcción no autoriza emisión: `emissionGuard` sigue exigiendo emitEnabled.
  // Así una consulta de estado o un webhook pueden confirmar aunque la emisión esté apagada.
  if (!config.environment) return null;
  if (config.provider === "facturon" && providerCredentials(env, config)) {
    try {
      return createFacturonAdapter({
        apiKey: env.FACTURON_API_KEY, companyId: config.companyId,
        emissionPointId: config.emissionPointId, environment: config.environment,
      });
    } catch { return null; }
  }
  return null;
}

function emissionGuard(cfg, adapter) {
  if (!adapter) return { ok: false, code: "provider_not_configured" };
  if (cfg.emitEnabled !== true) return { ok: false, code: "emission_disabled" };
  if (!cfg.environment) return { ok: false, code: "environment_not_configured" };
  if (adapter.environment !== cfg.environment) return { ok: false, code: "environment_mismatch" };
  if (cfg.environment === "production") {
    if (adapter.name === "mock") return { ok: false, code: "mock_not_allowed_in_production" };
    if (cfg.fiscalValidated !== true) return { ok: false, code: "fiscal_validation_required" };
    if (cfg.productionApproved !== true) return { ok: false, code: "production_not_approved" };
  }
  return { ok: true };
}

export async function submitInvoice(env, {
  slug, orderId, config, adapter = null, now = Date.now(), forceNewAttempt = false,
} = {}) {
  if (!env?.DB) return { ok: false, code: "db_not_configured", status: 503 };
  const cfg = normalizeInvoiceConfig(config ?? await loadInvoiceConfig(env, slug));
  let row = await rowByOrder(env, slug, orderId);
  if (!row) return { ok: false, code: "invoice_not_found", status: 404 };
  if (row.status === "issued") return { ok: true, unchanged: true, invoice: publicInvoice(row) };

  const chosen = adapter || adapterFor(env, cfg);
  if (chosen && cfg.environment && chosen.environment !== cfg.environment) {
    return { ok: false, code: "environment_mismatch", status: 409, invoice: publicInvoice(row) };
  }
  if (row.status === "submitted") {
    const refreshed = await refreshInvoice(env, { slug, orderId, config: cfg, adapter: chosen, now });
    return refreshed.ok
      ? { ok: true, unchanged: true, invoice: refreshed.invoice }
      : { ok: false, code: refreshed.code, status: 502, invoice: refreshed.invoice };
  }
  if (row.status === "failed" && row.failure_code === "provider_rejected" && !forceNewAttempt) {
    return { ok: false, code: "invoice_requires_correction", status: 409, invoice: publicInvoice(row) };
  }
  if (row.status === "failed" && row.failure_code === "idempotency_conflict" && !forceNewAttempt) {
    return { ok: false, code: "invoice_requires_reconciliation", status: 409, invoice: publicInvoice(row) };
  }

  const draft = parseJson(row.snapshot);
  if (!draft || !draft.ready) {
    const message = draft?.blockedReasons?.join(", ") || "snapshot_invalido";
    row = await patchInvoice(env, row, {
      status: "manual", failure_code: "fiscal_setup_pending", failure_message: message,
    }, now, { kind: "guard", detail: "fiscal_setup_pending" });
    return { ok: false, code: "invoice_setup_pending", status: 409, invoice: publicInvoice(row) };
  }

  const guard = emissionGuard(cfg, chosen);
  if (!guard.ok) {
    row = await patchInvoice(env, row, {
      status: "manual", failure_code: guard.code, failure_message: guard.code, provider_status: null,
    }, now, { kind: "guard", detail: guard.code });
    return { ok: false, code: guard.code, status: 409, invoice: publicInvoice(row) };
  }

  const needsNewAttempt = forceNewAttempt || row.failure_code === "provider_cancelled";
  if (needsNewAttempt) {
    const attempt = Number(row.attempt || 1) + 1;
    row = await patchInvoice(env, row, {
      attempt, idempotency_key: idempotencyKey(slug, orderId, attempt),
      external_reference: externalReference(orderId, attempt), provider_operation_id: null,
      document_number: null, access_key: null, authorization_number: null,
    }, now, { kind: "new_attempt", detail: `attempt=${attempt}` });
  }

  // Candado de emisión: evita que dos peticiones simultáneas llamen dos veces al proveedor.
  const claimed = await env.DB.prepare(
    "UPDATE invoices SET provider_status = 'submitting', updated_at = ? " +
    "WHERE id = ? AND slug = ? AND status IN ('pending', 'failed', 'manual') " +
    "AND (provider_status IS NULL OR provider_status <> 'submitting' OR updated_at < ?)",
  ).bind(now, row.id, slug, now - SUBMIT_LOCK_MS).run();
  if (!claimed?.meta?.changes) {
    const current = await rowById(env, row.id, slug);
    return { ok: true, unchanged: true, invoice: publicInvoice(current) };
  }

  let result;
  try {
    result = await chosen.emit(draft, {
      idempotencyKey: row.idempotency_key, externalReference: row.external_reference,
    });
  } catch {
    result = { accepted: false, kind: "uncertain", code: "network", message: "Sin respuesta del proveedor" };
  }

  if (result.accepted) {
    row = await patchInvoice(env, row, {
      status: "submitted",
      provider: chosen.name,
      environment: chosen.environment,
      provider_operation_id: result.operationId || null,
      document_number: result.documentNumber || null,
      access_key: result.accessKey || null,
      authorization_number: result.authorizationNumber || null,
      provider_status: result.kind || "processing",
      sri_status: result.accessKey ? "authorized_unconfirmed" : "processing",
      failure_code: result.operationId ? null : "authorization_unconfirmed",
      failure_message: result.operationId ? null : "El proveedor no devolvió el id del documento",
      submitted_at: now,
    }, now, { kind: "submitted", detail: result.kind || "processing" });

    if (!result.operationId) {
      return { ok: false, code: "authorization_unconfirmed", status: 502, invoice: publicInvoice(row) };
    }
    const refreshed = await refreshInvoice(env, {
      slug, orderId, config: cfg, adapter: chosen, now,
    });
    return refreshed.ok
      ? { ok: true, invoice: refreshed.invoice }
      : { ok: false, code: refreshed.code, status: 502, invoice: refreshed.invoice };
  }

  const message = clampText(result.message, 300) || "Error del proveedor";
  if (result.kind === "rejected") {
    row = await patchInvoice(env, row, {
      status: "failed", provider: chosen.name, environment: chosen.environment,
      provider_operation_id: result.operationId || null, document_number: result.documentNumber || null,
      provider_status: result.code ? String(result.code) : "rejected", sri_status: "rejected",
      failure_code: "provider_rejected", failure_message: message,
    }, now, { kind: "rejected", detail: String(result.code || "rejected") });
    return { ok: false, code: "provider_rejected", status: 502, invoice: publicInvoice(row) };
  }
  if (result.kind === "configuration") {
    row = await patchInvoice(env, row, {
      status: "manual", provider: chosen.name, environment: chosen.environment,
      provider_status: result.code ? String(result.code) : "configuration",
      failure_code: "provider_configuration", failure_message: message,
    }, now, { kind: "configuration", detail: String(result.code || "configuration") });
    return { ok: false, code: "provider_configuration", status: 502, invoice: publicInvoice(row) };
  }
  if (result.kind === "conflict") {
    row = await patchInvoice(env, row, {
      status: "failed", provider: chosen.name, environment: chosen.environment,
      provider_operation_id: result.operationId || row.provider_operation_id || null,
      document_number: result.documentNumber || row.document_number || null,
      access_key: result.accessKey || row.access_key || null,
      provider_status: result.code ? String(result.code) : "idempotency_conflict",
      failure_code: "idempotency_conflict", failure_message: message,
    }, now, { kind: "conflict", detail: String(result.code || "conflict") });
    return { ok: false, code: "idempotency_conflict", status: 409, invoice: publicInvoice(row) };
  }

  // Timeout, 429 o 5xx: no sabemos si el proveedor recibió. Se conserva la misma clave.
  row = await patchInvoice(env, row, {
    status: "pending", provider: chosen.name, environment: chosen.environment,
    provider_status: result.code ? String(result.code) : "uncertain",
    failure_code: "provider_uncertain", failure_message: message,
  }, now, { kind: "uncertain", detail: String(result.code || "uncertain") });
  return { ok: false, code: "provider_uncertain", status: 502, invoice: publicInvoice(row) };
}

export async function refreshInvoice(env, {
  slug, orderId, config, adapter = null, now = Date.now(),
} = {}) {
  if (!env?.DB) return { ok: false, code: "db_not_configured", invoice: null };
  const cfg = normalizeInvoiceConfig(config ?? await loadInvoiceConfig(env, slug));
  const row = await rowByOrder(env, slug, orderId);
  if (!row) return { ok: false, code: "invoice_not_found", invoice: null };
  if (row.status === "issued") return { ok: true, invoice: publicInvoice(row) };
  if (!row.provider_operation_id) {
    return { ok: false, code: "operation_missing", invoice: publicInvoice(row) };
  }

  const chosen = adapter || adapterFor(env, cfg);
  if (!chosen) return { ok: false, code: "provider_not_configured", invoice: publicInvoice(row) };

  let result;
  try {
    result = await chosen.fetchStatus({ operationId: row.provider_operation_id });
  } catch {
    return { ok: false, code: "provider_uncertain", invoice: publicInvoice(row) };
  }

  const evidence = evidenceOf(result);
  if (result.state === "authorized") {
    if (!evidence) {
      const current = await patchInvoice(env, row, {
        provider_status: "authorized_unconfirmed", sri_status: "authorized_unconfirmed",
        failure_code: "authorization_unconfirmed",
        failure_message: "El proveedor informa autorización sin clave de acceso ni número de autorización",
      }, now, { kind: "authorization_unconfirmed" });
      return { ok: false, code: "authorization_unconfirmed", invoice: publicInvoice(current) };
    }
    const current = await patchInvoice(env, row, {
      status: "issued", access_key: result.accessKey || evidence,
      authorization_number: result.authorizationNumber || result.accessKey || evidence,
      document_number: result.documentNumber || row.document_number,
      provider_status: "authorized", sri_status: "authorized",
      failure_code: null, failure_message: null, issued_at: now,
    }, now, { kind: "issued", detail: "sri_authorized" });
    return { ok: true, invoice: publicInvoice(current) };
  }
  if (result.state === "processing") {
    const current = await patchInvoice(env, row, {
      status: "submitted", provider_status: "processing", sri_status: "processing",
      failure_code: null, failure_message: null,
      document_number: result.documentNumber || row.document_number,
      access_key: result.accessKey || row.access_key,
    }, now, { kind: "processing" });
    return { ok: true, invoice: publicInvoice(current) };
  }
  if (result.state === "rejected") {
    const current = await patchInvoice(env, row, {
      status: "failed", provider_status: result.code ? String(result.code) : "rejected",
      sri_status: "rejected", failure_code: "provider_rejected",
      failure_message: clampText(result.message, 300) || "Comprobante rechazado",
    }, now, { kind: "rejected", detail: String(result.code || "rejected") });
    return { ok: false, code: "provider_rejected", invoice: publicInvoice(current) };
  }
  if (result.state === "configuration") {
    const current = await patchInvoice(env, row, {
      status: "manual", provider_status: result.code ? String(result.code) : "configuration",
      failure_code: "provider_configuration",
      failure_message: clampText(result.message, 300) || "Configuración del emisor incompleta",
    }, now, { kind: "configuration", detail: String(result.code || "configuration") });
    return { ok: false, code: "provider_configuration", invoice: publicInvoice(current) };
  }
  if (result.state === "cancelled") {
    const current = await patchInvoice(env, row, {
      status: "failed", provider_status: result.code ? String(result.code) : "cancelled",
      sri_status: "cancelled", failure_code: "provider_cancelled",
      failure_message: clampText(result.message, 300) || "Operación cancelada por el proveedor",
    }, now, { kind: "cancelled", detail: String(result.code || "cancelled") });
    return { ok: false, code: "provider_cancelled", invoice: publicInvoice(current) };
  }

  // 5007 / 5001 / respuesta ambigua: no se reemite ni se marca issued/failed.
  const current = await patchInvoice(env, row, {
    status: "submitted", provider_status: result.code ? String(result.code) : "unknown",
    sri_status: "unknown", failure_code: "resultado_no_confirmado",
    failure_message: "El proveedor no confirmó el resultado; requiere conciliación",
  }, now, { kind: "unknown", detail: String(result.code || "unknown") });
  return { ok: false, code: "resultado_no_confirmado", invoice: publicInvoice(current) };
}

function evidenceOf(result) {
  const key = String(result?.accessKey ?? "");
  const authorization = String(result?.authorizationNumber ?? "");
  if (/^\d{49}$/.test(key)) return key;
  if (authorization.length > 0 && authorization.length <= 60) return authorization;
  return null;
}

export async function retryInvoice(env, {
  slug, orderId, session, config, adapter = null, now = Date.now(), forceNewAttempt = false,
} = {}) {
  if (!session || typeof session.email !== "string") return { ok: false, code: "sin_sesion", status: 401 };
  const cfg = normalizeInvoiceConfig(config ?? await loadInvoiceConfig(env, slug));
  const row = await rowByOrder(env, slug, orderId);
  if (!row) return { ok: false, code: "invoice_not_found", status: 404 };
  if (row.status === "issued") return { ok: true, unchanged: true, invoice: publicInvoice(row) };
  if (row.status === "submitted") {
    const refreshed = await refreshInvoice(env, { slug, orderId, config: cfg, adapter, now });
    return refreshed.ok
      ? { ok: true, unchanged: true, invoice: refreshed.invoice }
      : { ok: false, code: refreshed.code, status: 502, invoice: refreshed.invoice };
  }
  if (row.failure_code === "provider_rejected" && !forceNewAttempt) {
    return { ok: false, code: "invoice_requires_correction", status: 409, invoice: publicInvoice(row) };
  }
  if (row.failure_code === "idempotency_conflict" && !forceNewAttempt) {
    return { ok: false, code: "invoice_requires_reconciliation", status: 409, invoice: publicInvoice(row) };
  }
  return submitInvoice(env, { slug, orderId, config: cfg, adapter, now, forceNewAttempt });
}

// ── Adaptador Facturón (https://facturon.ec/docs/api, OpenAPI 1.0.0) ─────────
// Un solo host para pruebas y producción: el ambiente SRI lo fija la empresa emisora
// en Facturón (Configuración → Datos del emisor). Por eso cada documento devuelto se
// compara con el ambiente configurado aquí; si no coincide, se exige conciliación.

const FACTURON_API = "https://facturon.ec/api/v1/ext";
const FACTURON_SRI_ENV = Object.freeze({ sandbox: "1", production: "2" });
const FACTURON_SUBTOTAL_FIELD = new Map([
  [0, "subtotal_0"], [500, "subtotal_5"], [800, "subtotal_8"], [1200, "subtotal_12"],
  [1300, "subtotal_13"], [1500, "subtotal_15"],
]);

export function createFacturonAdapter({
  apiKey, companyId, emissionPointId, environment = "sandbox", fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("FACTURON_API_KEY ausente");
  if (!isPositiveInt(companyId) || !isPositiveInt(emissionPointId)) throw new Error("companyId y emissionPointId requeridos");
  if (!FACTURON_SRI_ENV[environment]) throw new Error("ambiente Facturón inválido");
  if (typeof fetchImpl !== "function") throw new Error("fetch no disponible");

  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetchImpl(`${FACTURON_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`, Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}), ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { http: Number(response?.status) || 0, data: await safeJson(response) };
  };

  // customer_id es obligatorio: se busca por identificación y se crea si no existe.
  async function customerId(customer) {
    const lookup = () => call(`/customers/lookup?identification=${encodeURIComponent(customer.identification)}`);
    const found = res => (res.http === 200 || res.http === 201) && isPositiveInt(res.data?.data?.customer?.id)
      ? res.data.data.customer.id : null;
    let res = await lookup();
    if (found(res)) return { id: found(res) };
    if (res.http !== 404) return { error: res };
    res = await call("/customers", { method: "POST", body: facturonCustomer(customer) });
    if (found(res)) return { id: found(res) };
    if (res.http === 422) {
      // Otra petición pudo crearlo a la vez (identificación única por cuenta).
      const again = await lookup();
      if (found(again)) return { id: found(again) };
    }
    return { error: res };
  }

  return {
    name: "facturon",
    environment,
    buildPayload: (draft, reference, customer = 0) =>
      facturonPayload(draft, { companyId, emissionPointId, customerId: customer, reference }),
    async emit(draft, { idempotencyKey: key, externalReference: reference } = {}) {
      if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(String(key ?? ""))) {
        return { accepted: false, kind: "configuration", code: "idempotency_key_invalid", message: "Clave de idempotencia inválida" };
      }
      let body;
      try {
        body = facturonPayload(draft, { companyId, emissionPointId, customerId: 1, reference });
      } catch (err) {
        return { accepted: false, kind: "configuration", code: "payload_invalid", message: clampText(err?.message, 300) };
      }
      const customer = await customerId(draft.customer);
      if (customer.error) return facturonEmissionResult(customer.error, environment);
      body.customer_id = customer.id;
      const res = await call("/documents", { method: "POST", body, headers: { "Idempotency-Key": key } });
      return facturonEmissionResult(res, environment);
    },
    async fetchStatus({ operationId } = {}) {
      if (!/^\d{1,18}$/.test(String(operationId ?? ""))) return { state: "unknown", code: "operation_id_invalid" };
      return facturonStatusResult(await call(`/documents/${operationId}/status`));
    },
    // URL temporal (30 min) del RIDE en PDF; nunca expone la API key.
    async rideUrl(operationId) {
      if (!/^\d{1,18}$/.test(String(operationId ?? ""))) return null;
      const res = await call(`/documents/${operationId}/ride?url=1`);
      const url = res.http === 200 ? res.data?.data?.url : null;
      return typeof url === "string" && url.startsWith("https://") ? url : null;
    },
  };
}

function facturonCustomer(customer) {
  return {
    identification_type: customer.identificationType,
    identification_number: customer.identification,
    name: customer.name,
    ...(customer.email ? { email: customer.email } : {}),
    ...(customer.phone ? { phone: customer.phone } : {}),
    ...(customer.address ? { address: customer.address } : {}),
  };
}

export function facturonPayload(draft, { companyId, emissionPointId, customerId, reference }) {
  if (!draft?.ready || !draft.customer) throw new Error("borrador bloqueado");
  const ref = clampText(reference || "", 64);
  if (!ref) throw new Error("external_reference requerida");
  const subtotalCents = {};
  for (const group of draft.taxes || []) {
    const field = FACTURON_SUBTOTAL_FIELD.get(group.rateBp);
    if (!field) throw new Error(`tarifa ${group.rateBp / 100} % no soportada por Facturón`);
    subtotalCents[field] = (subtotalCents[field] || 0) + group.baseCents;
  }
  const [day, month, year] = String(draft.date).split("/");
  const additional = Object.fromEntries((draft.additionalInfo || []).map(item => [item.name, item.value]));
  return {
    company_id: companyId,
    emission_point_id: emissionPointId,
    customer_id: customerId,
    document_type: "01",
    issue_date: `${year}-${month}-${day}`,
    ...Object.fromEntries(Object.entries(subtotalCents).map(([field, cents]) => [field, amount(cents)])),
    total_discount: amount(draft.totals.discountCents),
    total_tax: amount(draft.totals.taxCents),
    total: amount(draft.totals.totalCents),
    payment_methods: [{ code: draft.payment.method, amount: amount(draft.payment.amountCents) }],
    items: draft.lines.map(line => ({
      main_code: line.code,
      description: line.description,
      quantity: line.quantity,
      unit_price: line.netUnitAmount,
      discount: amount(line.discountCents),
      subtotal: amount(line.baseCents),
      tax_code: "2",
      tax_percentage_code: line.taxCode,
      tax_rate: line.taxRateBp / 100,
      tax_base: amount(line.baseCents),
      tax_value: amount(line.taxCents),
    })),
    ...(Object.keys(additional).length ? { additional_info: additional } : {}),
    external_reference: ref,
  };
}

function facturonEmissionResult({ http, data }, environment) {
  const doc = isPlainObject(data?.data?.document) ? data.data.document : null;
  const base = {
    operationId: doc?.id != null ? String(doc.id) : null,
    documentNumber: doc?.document_number || null,
    accessKey: doc?.access_key || null,
    code: data?.error || doc?.status || http || null,
    message: providerMessage(data),
  };
  if (doc?.environment && doc.environment !== FACTURON_SRI_ENV[environment]) {
    return {
      ...base, accepted: false, kind: "conflict", code: "environment_mismatch",
      message: "Facturón emitió en otro ambiente SRI que el configurado; revisar la empresa emisora",
    };
  }
  if ((http === 200 || http === 201) && doc && base.operationId) {
    if (doc.status === "rejected" || doc.status === "failed") return { ...base, accepted: false, kind: "rejected" };
    return { ...base, accepted: true, kind: doc.status === "authorized" ? "authorized" : "processing" };
  }
  if (http === 422) return { ...base, accepted: false, kind: "rejected" };
  if (http === 409 && data?.error === "idempotency_key_reused") return { ...base, accepted: false, kind: "conflict" };
  if (http === 409 && data?.error === "send_failed") return { ...base, accepted: false, kind: "configuration" };
  if (http === 401 || http === 403) return { ...base, accepted: false, kind: "configuration" };
  // 429, 5xx, idempotency_in_progress, red: no se sabe si se emitió; se reintenta con la misma clave.
  return { ...base, accepted: false, kind: "uncertain" };
}

function facturonStatusResult({ http, data }) {
  if (http === 401 || http === 403) return { state: "configuration", code: data?.error, message: providerMessage(data) };
  if (http !== 200 || !isPlainObject(data?.data)) return { state: "unknown", code: data?.error || http, message: providerMessage(data) };
  const info = data.data;
  const sri = Array.isArray(info.sri_messages)
    ? info.sri_messages.map(item => [item?.identificador, item?.mensaje, item?.informacionAdicional].filter(Boolean).join(" ")).join(" | ")
    : "";
  const normalized = {
    code: info.status || null,
    message: clampText(sri || info.contingency_message || "", 300),
    authorizationNumber: info.authorization_number || null,
    accessKey: info.access_key || null,
    documentNumber: info.document_number || null,
  };
  if (info.status === "authorized") return { state: "authorized", ...normalized };
  if (["draft", "processing", "signed", "sent"].includes(info.status)) return { state: "processing", ...normalized };
  if (info.status === "rejected" || info.status === "failed") return { state: "rejected", ...normalized };
  if (info.status === "voided") return { state: "cancelled", ...normalized };
  return { state: "unknown", ...normalized };
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function providerMessage(data) {
  if (!isPlainObject(data)) return "";
  const parts = [];
  if (data.success === false && typeof data.message === "string") parts.push(data.message);
  if (isPlainObject(data.errors)) {
    for (const list of Object.values(data.errors)) {
      if (Array.isArray(list)) parts.push(...list.filter(item => typeof item === "string"));
    }
  }
  return clampText(parts.join(" | "), 300);
}

// Adaptador de pruebas/local. Nunca se selecciona desde configuración ni en producción.
export function createMockAdapter({ emissions = [], statuses = [], environment = "sandbox" } = {}) {
  const emitQueue = [...emissions], statusQueue = [...statuses];
  let emitCalls = 0, statusCalls = 0;
  return {
    name: "mock",
    environment,
    calls: () => ({ emitCalls, statusCalls }),
    async emit() {
      emitCalls++;
      return emitQueue.shift() || { accepted: true, kind: "processing", operationId: `mock-op-${emitCalls}` };
    },
    async fetchStatus() {
      statusCalls++;
      return statusQueue.shift() || { state: "processing" };
    },
    buildPayload: draft => ({ mock: true, orderId: draft.orderId }),
  };
}

// ── Webhooks: firma verificada + reconsulta obligatoria ──────────────────────

// Facturón: X-Webhook-Signature = hex(HMAC-SHA256(secreto, "{X-Webhook-Timestamp}.{cuerpo crudo}")).
export async function verifyFacturonSignature({
  secret, signature, timestamp, body, now = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS,
} = {}) {
  if (typeof secret !== "string" || !secret || typeof signature !== "string" || typeof body !== "string") return false;
  const sig = signature.trim().toLowerCase();
  if (!/^\d+$/.test(String(timestamp ?? "")) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Number(now) - Number(timestamp)) > tolerance) return false;
  const key = await crypto.subtle.importKey(
    "raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, ENCODER.encode(`${timestamp}.${body}`)));
  const expected = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return timingEqual(expected, sig);
}

async function eventInvoice(env, slug, event) {
  const operation = clampText(String(event?.data?.document_id ?? ""), 20) || null;
  const reference = clampText(event?.data?.external_reference, 64) || null;
  if (!operation && !reference) return null;
  return env.DB.prepare(
    "SELECT * FROM invoices WHERE slug = ? AND (provider_operation_id = ? OR external_reference = ?) LIMIT 1",
  ).bind(slug, operation, reference).first();
}

export async function handleInvoiceWebhook(request, env, site, { adapter = null, now = Date.now() } = {}) {
  if (request.method !== "POST") return error("metodo_no_permitido", 405);
  const raw = await request.text();
  if (ENCODER.encode(raw).byteLength > MAX_WEBHOOK_BYTES) return error("carga_excesiva", 413);
  const cfg = await loadInvoiceConfig(env, site.slug);
  if (cfg.provider !== "facturon") return error("facturacion_no_configurada", 503);
  const valid = await verifyFacturonSignature({
    secret: env.FACTURON_WEBHOOK_SECRET,
    signature: request.headers.get("X-Webhook-Signature"),
    timestamp: request.headers.get("X-Webhook-Timestamp"),
    body: raw,
    now: Math.floor(now / 1000),
  });
  if (!valid) return error("firma_invalida", 401);

  let event;
  try { event = JSON.parse(raw); } catch { return error("evento_invalido", 400); }
  if (!isPlainObject(event)) return error("evento_invalido", 400);
  if (event.test === true || event.event === "webhook.test") return json({ received: true, test: true });
  const row = await eventInvoice(env, site.slug, event);
  if (!row) return json({ received: true, matched: false });

  // El evento solo identifica la factura: el estado sale de GET /documents/{id}/status.
  const chosen = adapter || adapterFor(env, cfg);
  if (!chosen) return error("proveedor_no_configurado", 503);
  const result = await refreshInvoice(env, {
    slug: site.slug, orderId: row.order_id, config: cfg, adapter: chosen, now,
  });
  return json({ received: true, matched: true, status: result.invoice?.status || row.status });
}

// Cron: reconsulta facturas en proceso y reintenta (misma clave) las que quedaron sin
// respuesta del proveedor. Facturón guarda la idempotencia 24 h; pasado eso, queda manual.
const RECONCILE_LIMIT = 10;
export async function reconcileInvoices(env, now = Date.now()) {
  if (!env?.DB) return { checked: 0 };
  const rows = await env.DB.prepare(
    "SELECT slug, order_id, status FROM invoices WHERE updated_at < ? AND (" +
    "(status = 'submitted' AND created_at >= ?) OR " +
    "(status = 'pending' AND failure_code = 'provider_uncertain' AND created_at >= ?)) " +
    "ORDER BY updated_at ASC LIMIT ?",
  ).bind(now - 60 * 1000, now - 7 * 24 * 3600 * 1000, now - 23 * 3600 * 1000, RECONCILE_LIMIT).all();
  const list = rows.results || [];
  for (const row of list) {
    try {
      if (row.status === "submitted") await refreshInvoice(env, { slug: row.slug, orderId: row.order_id, now });
      else await submitInvoice(env, { slug: row.slug, orderId: row.order_id, now });
    } catch { /* se reintenta en el próximo minuto */ }
  }
  return { checked: list.length };
}

// ── Rutas para el integrador (api.js/index.js) ───────────────────────────────

export async function handleGetInvoice(request, env, site, session, encodedOrderId) {
  if (request.method !== "GET") return error("metodo_no_permitido", 405);
  if (!session || typeof session.email !== "string") return error("sin_sesion", 401);
  const orderId = decodeId(encodedOrderId);
  if (!orderId) return error("pedido_no_existe", 404);
  const row = await rowByOrder(env, site.slug, orderId);
  if (!row) return error("factura_no_existe", 404);
  return json(publicInvoice(row));
}

// RIDE (PDF) de una factura autorizada: redirige a la URL temporal de Facturón.
export async function handleInvoiceRide(request, env, site, session, encodedOrderId) {
  if (request.method !== "GET") return error("metodo_no_permitido", 405);
  if (!session || typeof session.email !== "string") return error("sin_sesion", 401);
  const orderId = decodeId(encodedOrderId);
  const row = orderId ? await rowByOrder(env, site.slug, orderId) : null;
  if (!row || row.status !== "issued" || !row.provider_operation_id) return error("factura_no_existe", 404);
  const chosen = adapterFor(env, await loadInvoiceConfig(env, site.slug));
  const url = chosen?.rideUrl ? await chosen.rideUrl(row.provider_operation_id).catch(() => null) : null;
  if (!url) return error("ride_no_disponible", 502);
  return Response.redirect(url, 302);
}

export async function handleRetryInvoice(request, env, site, session, encodedOrderId, {
  adapter = null, now = Date.now(),
} = {}) {
  if (request.method !== "POST") return error("metodo_no_permitido", 405);
  if (!session || typeof session.email !== "string") return error("sin_sesion", 401);
  const orderId = decodeId(encodedOrderId);
  if (!orderId) return error("pedido_no_existe", 404);
  let body = {};
  try { body = await request.json(); } catch { /* cuerpo vacío permitido */ }
  const forceNewAttempt = isPlainObject(body) && body.confirm_new_attempt === true;
  const result = await retryInvoice(env, {
    slug: site.slug, orderId, session, config: await loadInvoiceConfig(env, site.slug),
    adapter, now, forceNewAttempt,
  });
  if (!result.ok) {
    return error(result.code, result.status || 502, result.invoice ? { invoice: result.invoice } : {});
  }
  return json(result.invoice);
}
