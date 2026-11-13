// Bendo (Geopagos) · API Link de Pagos v1.2. Munch no captura datos de tarjeta:
// crea un link hospedado y redirige al comprador al checkout de Bendo.
//   · Solo llama al proveedor real con BENDO_MODE="live" + credenciales; el mock
//     (BENDO_MODE="mock") simula el resultado por KV `bendo:mock:<ref>`.
//   · La fuente de verdad es GET /api/v4/payments/links/{id} desde el servidor:
//     ni el redirect ni el webhook marcan pagos, solo disparan una reconsulta.
//   · El webhook lleva además una firma propia (HMAC) para descartar ruido sin
//     gastar una llamada a Bendo; `X-Geopagos-Signature` no autoriza nada.
//   · Un error de red/5xx deja el pago `unknown` (nunca rechazo): lo concilia el
//     return, la caja o el cron de cada minuto.
import { error, json } from "./contract.js";
import { timingEqual } from "./auth.js";
import {
  attachProviderId, createPaymentAttempt, failPayment, markPaymentUnknown, orderToken, posOrderForAction,
  posOrderRow, posPaymentByKey, posPaymentByRef, setPaymentPending, settlePaymentApproved, settlePaymentRejected,
} from "./orders.js";

const REF_RE = /^[A-Za-z0-9]{15}$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const SIGNATURE_RE = /^[0-9a-f]{32}$/;
const MOCK_RESULTS = new Set(["aprobado", "rechazado", "timeout"]);
const STATUS_PATH = { aprobado: "aprobado", rechazado: "rechazado", pendiente: "pendiente" };
const BENDO_TIMEOUT_MS = 10_000;
const POS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const RECONCILE_WINDOW_MS = 2 * 60 * 60 * 1000;   // el cron solo mira las últimas 2 h
const RECONCILE_LIMIT = 20;                        // máximo por pasada
const MAX_WEBHOOK_BYTES = 16 * 1024;
const REJECTED_MESSAGE = "El pago con tarjeta no fue aprobado.";

// Entornos fijados por la guía v1.2: staging es el defecto y nunca se mezclan.
const TOKEN_URL = {
  staging: "https://idp.stg.geopagos.io/auth/realms/stg_c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token",
  production: "https://idp.prd.geopagos.io/auth/realms/c6c40b3b-9cb7-5adc-82a8-28cae4c2cfd4/protocol/openid-connect/token",
};
const API_URL = { staging: "https://api.stg.geopagos.io", production: "https://api.geopagos.io" };

class BendoError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

const timeout = () => AbortSignal.timeout(BENDO_TIMEOUT_MS);

export function bendoMode(env) {
  return env.BENDO_MODE === "live" ? "live" : env.BENDO_MODE === "mock" ? "mock" : "disabled";
}

// Disponible = mock, o live con ambas credenciales del comercio.
export function bendoAvailable(env) {
  const mode = bendoMode(env);
  if (mode === "mock") return true;
  if (mode !== "live") return false;
  const id = typeof env.BENDO_CLIENT_ID === "string" ? env.BENDO_CLIENT_ID.trim() : "";
  const secret = typeof env.BENDO_CLIENT_SECRET === "string" ? env.BENDO_CLIENT_SECRET.trim() : "";
  return Boolean(id && secret);
}

function bendoEnvironment(env) {
  return env.BENDO_ENV === "production" ? "production" : "staging";
}

async function sellerWebhookSignature(env, ref) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!secret) throw new BendoError("bendo_no_disponible", 503, "SESSION_SECRET no configurado");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`bendo-webhook:${ref}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* ── Verificación: GET del link es la única fuente de verdad ──────────────── */

export function bendoOutcome(link, payment) {
  if (!link || typeof link !== "object" || !payment) return "mismatch";
  const expectedId = payment.provider_id == null ? "" : String(payment.provider_id);
  if (!expectedId || String(link.id ?? "") !== expectedId) return "mismatch";
  const amount = Number(link.amount);
  if (!Number.isFinite(amount) || Math.round(amount * 100) !== Number(payment.amount_cents)) return "mismatch";
  if (link.currency != null && link.currency !== "USD") return "mismatch";
  const payments = Array.isArray(link.payments) ? link.payments.filter(item => item && typeof item === "object") : [];
  // Una devolución exige revisión manual: nunca se marca pagado ni rechazado solo.
  // Se comprueba antes que APPROVED para que un reembolso parcial no se dé por cobrado.
  if (payments.some(item => item.status === "REFUNDED")) return "mismatch";
  if (payments.some(item => item.status === "APPROVED")) return "approved";
  if (link.status === "NOT_AVAILABLE" && !payments.some(item => item.status === "IN_PROGRESS")) return "rejected";
  return "pending";
}

/* ── Cliente HTTP de Bendo ───────────────────────────────────────────────── */

async function bendoToken(env) {
  if (!bendoAvailable(env)) throw new BendoError("bendo_no_disponible", 503, "Bendo no está configurado");
  if (bendoMode(env) === "mock") return "mock"; // el mock nunca toca la red
  const form = new URLSearchParams({
    grant_type: "client_credentials", scope: "openid",
    client_id: env.BENDO_CLIENT_ID, client_secret: env.BENDO_CLIENT_SECRET,
  });
  let response;
  try {
    response = await fetch(TOKEN_URL[bendoEnvironment(env)], {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: timeout(),
    });
  } catch { throw new BendoError("pago_proveedor", 502, "Bendo no respondió a la autenticación"); }
  if (!response.ok) throw new BendoError("pago_proveedor", 502, "Bendo rechazó la autenticación");
  let data;
  try { data = await response.json(); } catch { throw new BendoError("pago_proveedor", 502, "Respuesta inválida de Bendo"); }
  const token = typeof data?.access_token === "string" ? data.access_token.trim() : "";
  if (!token) throw new BendoError("pago_proveedor", 502, "Respuesta inválida de Bendo");
  return token;
}

// `env.BENDO_POINT_OF_SALE` si existe; si no, el primer uuid de points-of-sale,
// cacheado 24 h en KV por entorno para no gastar una llamada en cada cobro.
async function bendoPointOfSale(env, token) {
  const configured = typeof env.BENDO_POINT_OF_SALE === "string" ? env.BENDO_POINT_OF_SALE.trim() : "";
  if (configured) return configured;
  const cacheKey = `bendo:pos:${bendoEnvironment(env)}`;
  const cached = env.MENUS ? await env.MENUS.get(cacheKey).catch(() => null) : null;
  if (typeof cached === "string" && cached.trim()) return cached.trim();
  let response;
  try {
    response = await fetch(`${API_URL[bendoEnvironment(env)]}/api/v4/points-of-sale`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: timeout(),
    });
  } catch { throw new BendoError("pago_proveedor", 502, "Bendo no respondió"); }
  if (!response.ok) throw new BendoError("pago_proveedor", 502, "Bendo rechazó la consulta de puntos de venta");
  let payload;
  try { payload = await response.json(); } catch { throw new BendoError("pago_proveedor", 502, "Respuesta inválida de Bendo"); }
  const list = Array.isArray(payload)
    ? payload
    : [payload?.results, payload?.data, payload?.items, payload?.points_of_sale].find(Array.isArray) || [];
  const uuid = list.map(item => (item && typeof item.uuid === "string" ? item.uuid.trim() : "")).find(Boolean);
  if (!uuid) throw new BendoError("pago_proveedor", 502, "Bendo no devolvió un punto de venta");
  if (env.MENUS) await env.MENUS.put(cacheKey, uuid, { expirationTtl: POS_CACHE_TTL_SECONDS }).catch(() => {});
  return uuid;
}

// Crea el link: una sola línea con el total del pedido, sin `merchant_id` ni impuestos.
async function createBendoLink(env, origin, order, payment) {
  const ref = payment.provider_ref;
  if (bendoMode(env) === "mock") {
    return { id: `mock-${ref}`, url: `${origin}/api/bendo/mock?p=${encodeURIComponent(ref)}&resultado=aprobado` };
  }
  const amount = Number(payment.amount_cents);
  if (!Number.isInteger(amount) || amount < 1) throw new BendoError("pago_proveedor", 502, "Importe inválido");
  const token = await bendoToken(env);
  const pointOfSale = await bendoPointOfSale(env, token);
  const signature = await sellerWebhookSignature(env, ref);
  const label = order.number == null ? order.id : order.number;
  const returnUrl = `${origin}/api/bendo/return?p=${encodeURIComponent(ref)}`;
  const body = {
    source: "ecommerce",
    currency: "USD",
    items: [{
      description: `Pedido Munch #${label}`, quantity: 1, unit_price: amount / 100, external_reference: order.id,
    }],
    expires_in_minutes: 30,
    successful_payment_quantity_limit: 1,
    point_of_sale: pointOfSale,
    webhook_url: `${origin}/api/bendo/webhook?p=${encodeURIComponent(ref)}&s=${signature}`,
    webhook_version: "V4",
    redirect_on_success: returnUrl,
    redirect_on_failure: returnUrl,
    external_data: JSON.stringify({ order_id: order.id, ref }),
  };
  let response;
  try {
    response = await fetch(`${API_URL[bendoEnvironment(env)]}/api/v4/payments/links`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: timeout(),
    });
  } catch { throw new BendoError("pago_proveedor", 502, "Bendo no respondió"); }
  if (!response.ok) throw new BendoError("pago_proveedor", 502, "Bendo rechazó el link de pago");
  let result;
  try { result = await response.json(); } catch { throw new BendoError("pago_proveedor", 502, "Respuesta inválida de Bendo"); }
  const id = typeof result?.id === "string" ? result.id.trim() : "";
  const url = result?.transaction_data?.checkout_url;
  if (!id || typeof url !== "string" || !url.startsWith("https://")) {
    throw new BendoError("pago_proveedor", 502, "Respuesta inválida de Bendo");
  }
  return { id, url };
}

// Link sintético del mock: mismo esquema que el proveedor real, sin red.
async function mockBendoLink(env, payment) {
  const ref = String(payment.provider_ref || "");
  const result = env.MENUS ? await env.MENUS.get(`bendo:mock:${ref}`).catch(() => null) : null;
  if (result === "timeout") throw new BendoError("pago_pendiente", 502, "Timeout simulado de Bendo");
  const link = {
    id: payment.provider_id, amount: Number(payment.amount_cents) / 100, currency: "USD",
    status: "PENDING", payments: [],
  };
  if (result === "aprobado") {
    link.status = "APPROVED";
    link.payments = [{ status: "APPROVED", authorization_code: `MOCK${ref.slice(0, 8)}` }];
  } else if (result === "rechazado") {
    // Link vencido/agotado: `rejected` según el contrato de verificación.
    link.status = "NOT_AVAILABLE";
  }
  return link;
}

async function getBendoLink(env, payment) {
  if (!payment?.provider_id) throw new BendoError("pago_sin_confirmar", 409, "Pago sin link de Bendo");
  if (bendoMode(env) === "mock") return mockBendoLink(env, payment);
  const token = await bendoToken(env);
  let response;
  try {
    response = await fetch(`${API_URL[bendoEnvironment(env)]}/api/v4/payments/links/${encodeURIComponent(payment.provider_id)}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: timeout(),
    });
  } catch { throw new BendoError("pago_pendiente", 502, "Bendo no respondió"); }
  if (!response.ok) throw new BendoError("pago_pendiente", 502, `Bendo HTTP ${response.status}`);
  let link;
  try { link = await response.json(); } catch { throw new BendoError("pago_pendiente", 502, "Respuesta inválida de Bendo"); }
  if (!link || typeof link !== "object" || Array.isArray(link)) {
    throw new BendoError("pago_pendiente", 502, "Respuesta inválida de Bendo");
  }
  return link;
}

/* ── Aplicación del resultado verificado ─────────────────────────────────── */

// Aprueba, rechaza o deja el pago para revisión. Nunca se decide sin link.
async function applyBendoOutcome(env, site, order, payment, link) {
  const outcome = bendoOutcome(link, payment);
  if (outcome === "approved") {
    const approved = (Array.isArray(link.payments) ? link.payments : [])
      .find(item => item && item.status === "APPROVED");
    const paid = await settlePaymentApproved(env, site.slug, order, payment, {
      providerId: String(link.id),
      authorization: approved?.authorization_code == null ? null : String(approved.authorization_code),
    });
    return { outcome, order: paid };
  }
  if (outcome === "rejected") {
    const rejected = await settlePaymentRejected(env, site.slug, order, payment, REJECTED_MESSAGE);
    return { outcome, order: rejected };
  }
  if (outcome === "mismatch") await markPaymentUnknown(env, site.slug, payment.id, "bendo_alterado");
  return { outcome, order: null }; // pending: se conserva para reintentar en Bendo
}

/* ── Inicio del cobro: caja y web ────────────────────────────────────────── */

function idempotencyKeyOf(body) {
  const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  return IDEM_RE.test(key) ? key : "";
}

export async function startBendo(request, env, site, session, encodedId, body) {
  if (!bendoAvailable(env)) return error("bendo_no_disponible", 503);
  const key = idempotencyKeyOf(body);
  if (!key) return error("idempotency_key_requerida", 400);
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  if (found.order.source === "web") return error("estado_invalido", 409);
  return startBendoForOrder(request, env, site, found.order, key, true);
}

export async function startPublicBendo(request, env, site, encodedId, body) {
  if (!bendoAvailable(env)) return error("bendo_no_disponible", 503);
  const id = typeof encodedId === "string" ? encodedId : "";
  const order = await posOrderRow(env, site.slug, id);
  if (!order || order.source !== "web" || order.payment_method !== "bendo") return error("pedido_no_existe", 404);
  const token = typeof body?.order_token === "string" ? body.order_token : "";
  if (!token || !timingEqual(token, await orderToken(env, site.slug, id))) return error("pedido_no_existe", 404);
  const key = idempotencyKeyOf(body);
  if (!key) return error("idempotency_key_requerida", 400);
  return startBendoForOrder(request, env, site, order, key, false);
}

// El intento se guarda en D1 ANTES de llamar a Bendo. Misma clave ⇒ mismo pago:
// se reutiliza la URL si sigue pendiente y se informa `paid` si ya se cobró.
async function startBendoForOrder(request, env, site, order, key, caja) {
  if (order.currency !== "USD") return error("moneda_no_soportada", 400);
  const existing = await posPaymentByKey(env, site.slug, order.id, key);
  if (existing) {
    if (existing.provider !== "bendo") return error("idempotencia_conflicto", 409);
    if (existing.status === "paid") {
      return json({
        order_id: order.id, payment_id: existing.provider_ref, payment_url: null, status: "paid",
        total_cents: Number(order.total_cents),
      });
    }
    if (existing.url && (existing.status === "pending" || existing.status === "unknown")) {
      return json({
        order_id: order.id, payment_id: existing.provider_ref, payment_url: existing.url, status: order.status,
        total_cents: Number(order.total_cents),
      });
    }
  }
  if (caja && order.status !== "confirmed" && order.status !== "paid") return error("estado_invalido", 409);
  if (order.status === "paid") return error("orden_ya_pagada", 409);
  if (order.status === "rejected") return error("estado_invalido", 409);
  const payment = existing || await createPaymentAttempt(env, site.slug, order, key, "bendo");
  if (!payment) return error("idempotencia_conflicto", 409);
  const origin = new URL(request.url).origin;
  let link;
  try { link = await createBendoLink(env, origin, order, payment); }
  catch (cause) {
    const known = cause instanceof BendoError;
    await failPayment(env, site.slug, payment.id, known ? cause.message : "link_fallido");
    return error(known ? cause.code : "pago_proveedor", known ? cause.status : 502);
  }
  if (!await attachProviderId(env, site.slug, payment, link.id)) {
    await failPayment(env, site.slug, payment.id, "link_duplicado");
    return error("pago_proveedor", 502);
  }
  await setPaymentPending(env, site.slug, payment.id, link.url);
  return json({
    order_id: order.id, payment_id: payment.provider_ref, payment_url: link.url, status: order.status,
    total_cents: Number(order.total_cents),
  });
}

/* ── Retorno del comprador: GET del link en el servidor ──────────────────── */

async function returnResponse(request, url, env, site, order, status, httpStatus = 200) {
  const wantsJson = (request.headers.get("accept") || "").includes("application/json") ||
    url.searchParams.get("format") === "json";
  if (wantsJson) return json({ status, order_id: order.id, order_status: order.status }, httpStatus);
  const state = STATUS_PATH[status] || "pendiente";
  const menu = typeof env.MENU_PUBLIC_URL === "string" && /^https:\/\/[a-z0-9.-]+$/i.test(env.MENU_PUBLIC_URL)
    ? env.MENU_PUBLIC_URL.replace(/\/+$/, "") : "";
  // El comprador vuelve a /gracias con el resultado ya conciliado en servidor:
  // solo viajan el id opaco y el token del pedido, nunca datos fiscales.
  // También los cobros de caja por QR: quien vuelve es el celular del cliente,
  // que debe ver su recibo y nunca el login del panel.
  const target = menu
    ? `${menu}/gracias?pago=${state}&pedido=${encodeURIComponent(order.id)}&token=${encodeURIComponent(await orderToken(env, site.slug, order.id))}`
    : `${url.origin}/panel?pago=${state}&pedido=${encodeURIComponent(order.id)}`;
  return new Response(null, {
    status: 302,
    headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" },
  });
}

export async function handleBendoReturn(request, env, site) {
  const url = new URL(request.url);
  const ref = url.searchParams.get("p") || "";
  if (!REF_RE.test(ref)) return error("pago_invalido", 422);
  const payment = await posPaymentByRef(env, site.slug, ref);
  if (!payment || payment.provider !== "bendo") return error("pago_no_existe", 404);
  const order = await posOrderRow(env, site.slug, payment.order_id);
  if (!order) return error("pedido_no_existe", 404);

  // Retorno repetido (recarga del navegador o webhook previo): idempotente.
  if (payment.status === "paid" || order.status === "paid") return returnResponse(request, url, env, site, order, "aprobado");
  if (payment.status === "rejected" || order.status === "rejected") return returnResponse(request, url, env, site, order, "rechazado");
  if (!payment.provider_id) return error("pago_sin_confirmar", 409);

  let link;
  try { link = await getBendoLink(env, payment); }
  catch {
    // Red/5xx: estado desconocido, nunca rechazo ni comanda.
    await markPaymentUnknown(env, site.slug, payment.id, "bendo_timeout");
    return returnResponse(request, url, env, site, order, "pendiente", 502);
  }
  const applied = await applyBendoOutcome(env, site, order, payment, link);
  if (applied.outcome === "approved") return returnResponse(request, url, env, site, applied.order || order, "aprobado");
  if (applied.outcome === "rejected") return returnResponse(request, url, env, site, applied.order || order, "rechazado");
  if (applied.outcome === "mismatch") return error("pago_alterado", 422);
  return returnResponse(request, url, env, site, order, "pendiente");
}

/* ── Webhook: firma propia primero, luego reconsulta ─────────────────────── */

export async function handleBendoWebhook(request, env, site) {
  const url = new URL(request.url);
  const ref = (url.searchParams.get("p") || "").trim();
  const signature = (url.searchParams.get("s") || "").trim();
  // Firma inválida o ref desconocida ⇒ 200 sin trabajo: no se provocan reintentos
  // infinitos de Geopagos y no se gasta ninguna llamada a Bendo.
  if (!REF_RE.test(ref) || !SIGNATURE_RE.test(signature)) return json({ ok: true });
  let expected;
  try { expected = await sellerWebhookSignature(env, ref); }
  // Sin SESSION_SECRET ninguna firma puede validarse: 200 sin trabajo para no
  // provocar reintentos infinitos; return, caja y cron siguen conciliando.
  catch { return json({ ok: true }); }
  if (!timingEqual(signature, expected)) return json({ ok: true });
  const payment = await posPaymentByRef(env, site.slug, ref);
  if (!payment || payment.provider !== "bendo" || !payment.provider_id) return json({ ok: true });
  if (request.method !== "POST") return error("metodo_invalido", 405);
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return error("cuerpo_muy_grande", 413);
  let raw;
  try { raw = await request.text(); } catch { raw = ""; }
  // El cuerpo no se usa ni se registra; solo se acota (máx. 16 KB).
  if (new TextEncoder().encode(raw).byteLength > MAX_WEBHOOK_BYTES) return error("cuerpo_muy_grande", 413);
  const order = await posOrderRow(env, site.slug, payment.order_id);
  if (!order || order.status === "paid" || order.status === "rejected") return json({ ok: true });

  let link;
  try { link = await getBendoLink(env, payment); }
  catch {
    await markPaymentUnknown(env, site.slug, payment.id, "bendo_timeout");
    // 503 para que Geopagos reintente: el pago sigue sin confirmar.
    return json({ ok: false }, 503);
  }
  await applyBendoOutcome(env, site, order, payment, link);
  return json({ ok: true });
}

/* ── Simulador local del checkout ────────────────────────────────────────── */

export function handleBendoMock(request, env) {
  if (bendoMode(env) !== "mock") return error("ruta_no_encontrada", 404);
  const url = new URL(request.url);
  const ref = url.searchParams.get("p") || "";
  if (!REF_RE.test(ref)) return error("pago_invalido", 422);
  const resultado = url.searchParams.get("resultado") || "aprobado";
  if (!MOCK_RESULTS.has(resultado)) return error("resultado_invalido", 422);
  return mockBendoRedirect(env, url, ref, resultado);
}

async function mockBendoRedirect(env, url, ref, resultado) {
  if (env.MENUS) await env.MENUS.put(`bendo:mock:${ref}`, resultado).catch(() => {});
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.origin}/api/bendo/return?p=${encodeURIComponent(ref)}`,
      "cache-control": "no-store",
    },
  });
}

/* ── Conciliación autenticada (caja) ─────────────────────────────────────── */

// Reconsulta SIN ventana de tiempo y sin recobrar: el link de Bendo no revierte
// solo como el Confirm de la pasarela retirada.
export async function reconcileBendo(env, site, session, payment) {
  if (!payment || payment.provider !== "bendo") return error("pago_no_existe", 404);
  const found = await posOrderForAction(env, site, session, encodeURIComponent(payment.order_id));
  if (found.response) return found.response;
  const order = found.order;
  if (payment.status === "paid" || order.status === "paid") {
    return json({ status: "aprobado", order_id: order.id, order_status: order.status });
  }
  if (payment.status === "rejected" || order.status === "rejected") {
    return json({ status: "rechazado", order_id: order.id, order_status: order.status });
  }
  if (!payment.provider_id) return error("pago_sin_confirmar", 409);
  let link;
  try { link = await getBendoLink(env, payment); }
  catch {
    await markPaymentUnknown(env, site.slug, payment.id, "conciliacion_timeout");
    return error("pago_pendiente", 502);
  }
  const applied = await applyBendoOutcome(env, site, order, payment, link);
  if (applied.outcome === "mismatch") return error("pago_alterado", 422);
  return json({
    status: applied.outcome === "approved" ? "aprobado" : applied.outcome === "rejected" ? "rechazado" : "pendiente",
    order_id: order.id, order_status: (applied.order || order).status,
  });
}

/* ── Job programado: pending/unknown de las últimas 2 h ──────────────────── */

// Cron del Worker (cada minuto): reconsulta el link y aplica el resultado. Un
// error de red conserva el pago `unknown` y se reintenta en la próxima pasada.
export async function reconcilePendingBendo(env, now = Date.now()) {
  const rows = await env.DB.prepare(
    "SELECT p.* FROM pos_payments p JOIN pos_orders o ON o.slug = p.slug AND o.id = p.order_id " +
    "WHERE p.provider = 'bendo' AND p.status IN ('pending', 'unknown') AND p.provider_id IS NOT NULL " +
    "AND p.created_at >= ? AND o.status IN ('pending', 'confirmed') ORDER BY p.created_at ASC LIMIT ?",
  ).bind(now - RECONCILE_WINDOW_MS, RECONCILE_LIMIT).all();
  const payments = rows.results || [];
  let settled = 0, pending = 0;
  for (const payment of payments) {
    const order = await posOrderRow(env, payment.slug, payment.order_id);
    if (!order || order.status === "paid" || order.status === "rejected") { pending++; continue; }
    let link;
    try { link = await getBendoLink(env, payment); }
    catch {
      await markPaymentUnknown(env, payment.slug, payment.id, "job_timeout");
      pending++;
      continue;
    }
    const applied = await applyBendoOutcome(env, { slug: payment.slug }, order, payment, link);
    if (applied.outcome === "approved" || applied.outcome === "rejected") settled++;
    else pending++;
  }
  return { checked: payments.length, settled, pending };
}
