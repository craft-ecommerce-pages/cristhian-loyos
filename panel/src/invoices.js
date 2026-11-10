// Facturación electrónica (Ecuador) — adaptador aislado del pago.
//
// Contrato:
//  - invoiceDraftFromOrder({order, config, now}) recibe un snapshot YA PAGADO y devuelve un
//    borrador neutral con centavos enteros y tasas configurables (nunca un IVA fijo).
//  - prepareInvoice() crea una sola fila por (slug, order_id): la idempotencia es el pedido.
//  - submitInvoice() habla con el proveedor solo si la configuración lo habilita de forma
//    explícita. Sin proveedor queda `manual`; nunca se emite en producción por defecto.
//  - refreshInvoice() confirma el estado en el proveedor/SRI antes de pasar a `issued`.
//  - handleInvoiceWebhook() solo acepta firmas verificadas o, en proveedores sin firma,
//    un token compartido y SIEMPRE reconsulta; el payload nunca cambia el estado por sí solo.
//
// Secretos: solo desde env (`ECUAFACT_API_KEY`, `ECUAFACT_WEBHOOK_SECRET`,
// `FACTUPLAN_API_KEY`, `INVOICE_WEBHOOK_TOKEN`). Nunca se escriben en D1, KV, logs ni Git.
import { error, json } from "./contract.js";

export const INVOICE_SCHEMA = "invoice-draft.v1";
export const INVOICE_STATUSES = Object.freeze(["pending", "manual", "submitted", "issued", "failed"]);

const ENCODER = new TextEncoder();
const MAX_WEBHOOK_BYTES = 8 * 1024;
const SUBMIT_LOCK_MS = 5 * 60 * 1000;
const SIGNATURE_TOLERANCE_SECONDS = 300;
const ECON_FINAL_CONSUMER_MAX_CENTS = 5000; // USD 50.00, límite documentado por Ecuafact/SRI
const SRI_IVA_CODE_BY_RATE_BP = new Map([
  [0, "0"], [500, "5"], [800, "8"], [1200, "2"], [1300, "10"], [1400, "3"], [1500, "4"],
]);
const FACTUPLAN_TAX_RATES_BP = new Set([0, 500, 800, 1200, 1400, 1500]);
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
  const provider = ["ecuafact", "factuplan"].includes(raw.provider) ? raw.provider : null;
  const environment = ["sandbox", "production"].includes(raw.environment) ? raw.environment : null;
  return {
    provider,
    environment,
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
    payment: { method: cfg.paymentMethod, amountCents: computedTotal },
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
  if (cfg.provider === "ecuafact") return typeof env?.ECUAFACT_API_KEY === "string" && env.ECUAFACT_API_KEY.length > 0;
  if (cfg.provider === "factuplan") return typeof env?.FACTUPLAN_API_KEY === "string" && env.FACTUPLAN_API_KEY.length > 0;
  return false;
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
  if (config.provider === "ecuafact" && providerCredentials(env, config)) {
    try {
      return createEcuafactAdapter({
        apiKey: env.ECUAFACT_API_KEY, ruc: config.ruc, environment: config.environment,
      });
    } catch { return null; }
  }
  if (config.provider === "factuplan" && providerCredentials(env, config)) {
    try {
      return createFactuplanAdapter({
        apiKey: env.FACTUPLAN_API_KEY, ruc: config.ruc, environment: config.environment,
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
      failure_message: result.operationId ? null : "El proveedor no devolvió idOperacion",
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

// ── Adaptadores ──────────────────────────────────────────────────────────────

const ECUAFACT_SANDBOX = "https://staging-api.mynexusapi.com";
const ECUAFACT_PRODUCTION = "https://api.mynexusapi.com";
const FACTUPLAN_API = "https://api-rest.factuplan.com.ec";

export function createEcuafactAdapter({
  apiKey, ruc, environment = "sandbox", fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("ECUAFACT_API_KEY ausente");
  if (!/^\d{13}$/.test(String(ruc ?? ""))) throw new Error("RUC de 13 dígitos requerido");
  if (typeof fetchImpl !== "function") throw new Error("fetch no disponible");
  const baseUrl = environment === "production" ? ECUAFACT_PRODUCTION
    : environment === "sandbox" ? ECUAFACT_SANDBOX : null;
  if (!baseUrl) throw new Error("ambiente Ecuafact inválido");

  return {
    name: "ecuafact",
    environment,
    buildPayload: (draft, reference) => ecuafactPayload(draft, ruc, reference),
    async emit(draft, { idempotencyKey: key, externalReference: reference } = {}) {
      if (!/^[A-Za-z0-9._:/-]{1,128}$/.test(String(key ?? ""))) {
        return { accepted: false, kind: "configuration", code: "idempotency_key_invalid", message: "Clave de idempotencia inválida" };
      }
      let body;
      try {
        body = ecuafactPayload(draft, ruc, reference);
      } catch {
        return { accepted: false, kind: "configuration", code: "payload_invalid", message: "Borrador o referencia inválida" };
      }
      const response = await fetchImpl(`${baseUrl}/v1/contribuyentes/${encodeURIComponent(ruc)}/facturas`, {
        method: "POST",
        headers: {
          "X-Api-Key": apiKey, "Idempotency-Key": key, "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      return ecuafactEmissionResult(response, await safeJson(response));
    },
    async fetchStatus({ operationId } = {}) {
      if (!/^[0-9a-f-]{36}$/i.test(String(operationId ?? ""))) {
        return { state: "unknown", code: "operation_id_invalid" };
      }
      const response = await fetchImpl(`${baseUrl}/v1/operaciones/${encodeURIComponent(operationId)}`, {
        headers: { "X-Api-Key": apiKey },
      });
      return ecuafactStatusResult(response, await safeJson(response));
    },
  };
}

function ecuafactPayload(draft, ruc, externalReference) {
  if (!draft?.ready) throw new Error("borrador bloqueado");
  const reference = clampText(externalReference || draft.externalReference || "", 128);
  if (!reference) throw new Error("referenciaExterna requerida");
  const taxes = (draft.taxes || []).map(group => ({
    codigo: "2",
    codigoPorcentaje: group.code,
    tarifa: group.rateBp / 100,
    baseImponible: amount(group.baseCents),
    valor: amount(group.taxCents),
  }));
  return {
    origenReferencia: draft.origin || "craft-panel",
    referenciaExterna: reference,
    infoTributaria: {
      ruc,
      estab: draft.establishment,
      ptoEmi: draft.emissionPoint,
    },
    info: {
      fechaEmision: draft.date,
      tipoIdentificacionComprador: draft.customer.identificationType,
      identificacionComprador: draft.customer.identification,
      razonSocialComprador: draft.customer.name,
      ...(draft.customer.address ? { direccionComprador: draft.customer.address } : {}),
      ...(draft.customer.phone ? { telefono: draft.customer.phone } : {}),
      ...(draft.customer.email ? { correo: draft.customer.email } : {}),
      totalSinImpuestos: amount(draft.totals.subtotalCents),
      totalDescuento: amount(draft.totals.discountCents),
      totalConImpuestos: taxes,
      propina: 0,
      importeTotal: amount(draft.totals.totalCents),
      moneda: "DOLAR",
      pagos: [{ formaPago: draft.payment.method, total: amount(draft.payment.amountCents) }],
    },
    detalles: draft.lines.map(line => ({
      codigoPrincipal: line.code,
      descripcion: line.description,
      cantidad: line.quantity,
      precioUnitario: line.netUnitAmount,
      descuento: amount(line.discountCents),
      precioTotalSinImpuesto: amount(line.baseCents),
      impuestos: [{
        codigo: "2",
        codigoPorcentaje: line.taxCode,
        tarifa: line.taxRateBp / 100,
        baseImponible: amount(line.baseCents),
        valor: amount(line.taxCents),
      }],
    })),
    ...(draft.additionalInfo?.length
      ? { infoAdicional: draft.additionalInfo.map(item => ({ nombre: item.name, valor: item.value })) }
      : {}),
  };
}

function ecuafactEmissionResult(response, data) {
  const http = Number(response?.status) || 0;
  const estado = data?.estado;
  const code = data?.codEstado;
  const base = {
    operationId: data?.idOperacion || null,
    documentNumber: data?.numeroDocumento || null,
    accessKey: data?.claveAcceso || null,
    code,
    message: providerMessage(data),
  };
  if (http >= 200 && http < 300) {
    if (estado === "autorizado") return { ...base, accepted: true, kind: "authorized" };
    if (estado === "recibido") return { ...base, accepted: true, kind: "processing" };
    if (estado === "rechazo_configuracion") return { ...base, accepted: false, kind: "configuration" };
    if (estado === "rechazado" || estado === "cancelado") return { ...base, accepted: false, kind: "rejected" };
    if (estado === "error") return { ...base, accepted: false, kind: "uncertain" };
    return { ...base, accepted: false, kind: "uncertain", message: base.message || "Respuesta no reconocida" };
  }
  if (http === 409 && Number(code) === 3005) return { ...base, accepted: false, kind: "conflict" };
  if (http === 401 || http === 403) return { ...base, accepted: false, kind: "configuration" };
  if (http === 422) return { ...base, accepted: false, kind: "rejected" };
  if (http === 400 && Number(code) === 3003) return { ...base, accepted: false, kind: "rejected" };
  return { ...base, accepted: false, kind: "uncertain" };
}

function ecuafactStatusResult(response, data) {
  const http = Number(response?.status) || 0;
  if (http === 404) return { state: "unknown", code: 3013, message: "Operación no encontrada" };
  if (http === 401 || http === 403) return { state: "configuration", code: data?.codEstado, message: providerMessage(data) };
  if (http >= 500) return { state: "unknown", code: data?.codEstado, message: providerMessage(data) };
  const code = Number(data?.codEstado);
  const estado = data?.estado;
  const normalized = {
    code: data?.codEstado || null,
    message: providerMessage(data),
    accessKey: data?.claveAcceso || null,
    authorizationNumber: data?.claveAcceso || null,
    documentNumber: data?.numeroDocumento || null,
  };
  if (estado === "autorizado" && code === 2001) return { state: "authorized", ...normalized };
  if (estado === "recibido") return { state: "processing", ...normalized };
  if (estado === "rechazado") return { state: "rejected", ...normalized };
  if (estado === "rechazo_configuracion") return { state: "configuration", ...normalized };
  if (estado === "cancelado") return { state: "cancelled", ...normalized };
  if (estado === "error") {
    if (code === 5007 || code === 5001) return { state: "unknown", ...normalized };
    return { state: "unknown", ...normalized };
  }
  return { state: "unknown", ...normalized };
}

export function createFactuplanAdapter({
  apiKey, ruc, environment = "sandbox", fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof apiKey !== "string" || !apiKey) throw new Error("FACTUPLAN_API_KEY ausente");
  if (!/^\d{13}$/.test(String(ruc ?? ""))) throw new Error("RUC de 13 dígitos requerido");
  if (typeof fetchImpl !== "function") throw new Error("fetch no disponible");
  if (environment !== "sandbox" && environment !== "production") throw new Error("ambiente Factuplan inválido");
  const keyPrefix = environment === "sandbox" ? "ak_test_" : "ak_live_";
  if (!apiKey.startsWith(keyPrefix)) throw new Error(`FACTUPLAN_API_KEY debe empezar con ${keyPrefix}`);

  return {
    name: "factuplan",
    environment,
    buildPayload: (draft, reference) => factuplanPayload(draft, reference),
    async emit(draft, { externalReference: reference } = {}) {
      let body;
      try {
        body = factuplanPayload(draft, reference);
      } catch {
        return {
          accepted: false, kind: "configuration", code: "payload_invalid",
          message: "Borrador, referencia o tarifa no soportada por Factuplan",
        };
      }
      const response = await fetchImpl(`${FACTUPLAN_API}/v1/developer/invoices`, {
        method: "POST",
        headers: { "X-API-Key": apiKey, "x-taxpayer-ruc": ruc, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return factuplanEmissionResult(response, await safeJson(response));
    },
    async fetchStatus({ operationId } = {}) {
      if (!operationId) return { state: "unknown", code: "operation_id_invalid" };
      const response = await fetchImpl(`${FACTUPLAN_API}/v1/developer/receipts/${encodeURIComponent(operationId)}/status`, {
        headers: { "X-API-Key": apiKey, "x-taxpayer-ruc": ruc },
      });
      return factuplanStatusResult(response, await safeJson(response));
    },
  };
}

function factuplanPayload(draft, externalReference) {
  if (!draft?.ready) throw new Error("borrador bloqueado");
  const reference = clampText(externalReference || draft.externalReference || "", 100);
  if (!reference) throw new Error("devReference requerida");
  for (const line of draft.lines) {
    if (!FACTUPLAN_TAX_RATES_BP.has(line.taxRateBp)) throw new Error("tarifa no soportada por Factuplan");
  }
  const customer = draft.customer;
  const identificationType = customer.identificationType === "04" ? "RUC"
    : customer.identificationType === "05" ? "CEDULA"
      : customer.identificationType === "06" ? "PASSPORT"
        : customer.identificationType === "07" ? "FINAL_CONSUMER" : "EXTERIOR";
  const items = draft.lines.map(line => {
    const rate = line.taxRateBp / 100;
    const taxType = line.taxCode === "6" ? "NOT_TAXABLE"
      : line.taxCode === "7" ? "EXEMPT"
        : line.taxRateBp === 0 ? "IVA_0" : "IVA_RATE";
    return {
      quantity: line.quantity,
      code: line.code,
      description: line.description,
      unitPrice: line.netUnitAmount,
      discount: amount(line.discountCents),
      taxType,
      ...(taxType === "IVA_RATE" ? { tax: rate } : {}),
    };
  });
  const additional = {};
  for (const item of draft.additionalInfo || []) additional[item.name] = item.value;
  return {
    customer: {
      identificationType,
      identification: customer.identification,
      legalName: customer.name,
      ...(customer.email ? { email: customer.email } : {}),
      ...(customer.address ? { address: customer.address } : {}),
      ...(/^\+[1-9]\d{6,14}$/.test(customer.phone || "") ? { phone: customer.phone } : {}),
    },
    items,
    establishment: draft.establishment,
    emissionPoint: draft.emissionPoint,
    ...(Object.keys(additional).length ? { additionalInfo: additional } : {}),
    sendEmail: false,
    devReference: reference,
    payments: [{ method: draft.payment.method, amount: amount(draft.payment.amountCents) }],
  };
}

function factuplanEmissionResult(response, data) {
  const http = Number(response?.status) || 0;
  const payload = data?.data;
  const errorCode = data?.error?.code;
  const status = String(payload?.status || "").toUpperCase();
  const base = {
    operationId: payload?.id || null,
    documentNumber: payload?.sequential || null,
    accessKey: payload?.accessKey || null,
    code: errorCode || payload?.status || http,
    message: providerMessage(data),
  };
  if (http >= 200 && http < 300) {
    if (status === "AUTHORIZED" || status === "COMPLETED") return { ...base, accepted: true, kind: "authorized" };
    if (status === "REJECTED" || status === "VOIDED") return { ...base, accepted: false, kind: "rejected" };
    if (status === "ERROR") return { ...base, accepted: false, kind: "uncertain" };
    return { ...base, accepted: true, kind: "processing" };
  }
  if (http === 409) return { ...base, accepted: false, kind: "conflict" };
  if (http === 401 || http === 403) return { ...base, accepted: false, kind: "configuration" };
  if (http === 400 || http === 422) return { ...base, accepted: false, kind: "rejected" };
  return { ...base, accepted: false, kind: "uncertain" };
}

function factuplanStatusResult(response, data) {
  const http = Number(response?.status) || 0;
  if (http === 401 || http === 403) return { state: "configuration", code: data?.error?.code, message: providerMessage(data) };
  if (http === 404) return { state: "unknown", code: "not_found", message: "Comprobante no encontrado" };
  if (http >= 500) return { state: "unknown", code: data?.error?.code, message: providerMessage(data) };
  const payload = data?.data || {};
  const status = String(payload.status || "").toUpperCase();
  const normalized = {
    code: payload.status || null,
    message: providerMessage(data),
    accessKey: payload.accessKey || payload.authorizationNumber || null,
    authorizationNumber: payload.authorizationNumber || payload.accessKey || null,
    documentNumber: payload.sequential || null,
  };
  if (status === "AUTHORIZED" || status === "COMPLETED") return { state: "authorized", ...normalized };
  if (status === "REJECTED") return { state: "rejected", ...normalized };
  if (status === "VOIDED") return { state: "cancelled", ...normalized };
  if (status === "ERROR") return { state: "unknown", ...normalized };
  return { state: "processing", ...normalized };
}

async function safeJson(response) {
  try { return await response.json(); } catch { return null; }
}

function providerMessage(data) {
  if (!data) return "";
  const parts = [];
  if (typeof data.msgError === "string") parts.push(data.msgError);
  if (Array.isArray(data.errores)) parts.push(...data.errores.filter(item => typeof item === "string"));
  if (typeof data.error?.message === "string") parts.push(data.error.message);
  if (Array.isArray(data.error?.details?.validation)) parts.push(...data.error.details.validation);
  if (Array.isArray(data.data?.messages)) parts.push(...data.data.messages.filter(item => typeof item === "string"));
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

export async function verifyEcuafactSignature({
  secret, header, body, now = Math.floor(Date.now() / 1000), tolerance = SIGNATURE_TOLERANCE_SECONDS,
} = {}) {
  if (typeof secret !== "string" || !secret || typeof header !== "string" || typeof body !== "string") return false;
  let timestamp = null, signature = null;
  for (const part of header.split(",")) {
    const item = part.trim();
    if (item.startsWith("t=")) timestamp = item.slice(2);
    else if (item.startsWith("v1=")) signature = item.slice(3).toLowerCase();
  }
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(Number(now) - Number(timestamp)) > tolerance) return false;
  const key = await crypto.subtle.importKey(
    "raw", ENCODER.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, ENCODER.encode(`${timestamp}.${body}`)));
  const expected = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return timingEqual(expected, signature);
}

async function eventInvoice(env, slug, event) {
  const operationIds = [event?.idOperacion, event?.resourceId, event?.data?.idOperacion, event?.data?.id]
    .map(value => clampText(value, 80)).filter(Boolean);
  const references = [event?.referenciaExterna, event?.devReference, event?.data?.devReference]
    .map(value => clampText(value, 100)).filter(Boolean);
  if (!operationIds.length && !references.length) return null;
  const operation = operationIds[0] || null, reference = references[0] || null;
  return env.DB.prepare(
    "SELECT * FROM invoices WHERE slug = ? AND (provider_operation_id = ? OR external_reference = ?) LIMIT 1",
  ).bind(slug, operation, reference).first();
}

export async function handleInvoiceWebhook(request, env, site, { adapter = null, now = Date.now() } = {}) {
  if (request.method !== "POST") return error("metodo_no_permitido", 405);
  const raw = await request.text();
  if (ENCODER.encode(raw).byteLength > MAX_WEBHOOK_BYTES) return error("carga_excesiva", 413);
  const cfg = await loadInvoiceConfig(env, site.slug);
  if (!cfg.provider) return error("facturacion_no_configurada", 503);

  if (cfg.provider === "ecuafact") {
    const valid = await verifyEcuafactSignature({
      secret: env.ECUAFACT_WEBHOOK_SECRET,
      header: request.headers.get("Ecuafact-Signature"),
      body: raw,
      now: Math.floor(now / 1000),
    });
    if (!valid) return error("firma_invalida", 401);
  } else {
    // Factuplan no documenta firma HMAC: se exige token propio y aun así se reconsulta.
    const token = request.headers.get("x-webhook-token") || "";
    if (!env.INVOICE_WEBHOOK_TOKEN || !timingEqual(token, env.INVOICE_WEBHOOK_TOKEN)) {
      return error("firma_invalida", 401);
    }
  }

  let event;
  try { event = JSON.parse(raw); } catch { return error("evento_invalido", 400); }
  if (!isPlainObject(event)) return error("evento_invalido", 400);
  const row = await eventInvoice(env, site.slug, event);
  if (!row) return json({ received: true, matched: false });

  const chosen = adapter || adapterFor(env, cfg);
  if (!chosen) return error("proveedor_no_configurado", 503);
  const result = await refreshInvoice(env, {
    slug: site.slug, orderId: row.order_id, config: cfg, adapter: chosen, now,
  });
  return json({ received: true, matched: true, status: result.invoice?.status || row.status });
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
