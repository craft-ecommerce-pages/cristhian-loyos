// Payphone (botón de pago): Prepare + V2/Confirm. Adaptado del sorteo sin acoplar rifas.
//   · Solo llama al proveedor real con PAYPHONE_MODE="live" y env.PAYPHONE_TOKEN.
//   · Cualquier otro caso (o PAYPHONE_MODE="mock") usa el mock local: nunca red.
//   · El intento se guarda en D1 antes de Prepare; el retorno es idempotente y
//     un timeout deja el pago en `unknown` para conciliación (nunca rechazo por timeout).
import { error, json } from "./contract.js";
import {
  attachProviderId, createPaymentAttempt, failPayment, markPaymentUnknown, posOrderForAction,
  posOrderRow, posPaymentByKey, posPaymentByRef, setPaymentPending, settlePaymentApproved, settlePaymentRejected,
} from "./orders.js";

const BASE = "https://pay.payphonetodoesposible.com";
const REF_RE = /^[A-Za-z0-9]{15}$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const STATUS_PATH = { aprobado: "aprobado", rechazado: "rechazado", pendiente: "pendiente" };

class PayphoneError extends Error {
  constructor(code, status, message) { super(message || code); this.code = code; this.status = status; }
}

export function payphoneMode(env) {
  return env.PAYPHONE_MODE === "live" ? "live" : "mock";
}

function baseUrl(env) {
  const raw = typeof env.PAYPHONE_BASE_URL === "string" ? env.PAYPHONE_BASE_URL.trim() : "";
  return raw ? raw.replace(/\/+$/, "") : BASE;
}

// Prepara el botón y devuelve la URL de pago. Lanza PayphoneError si no se puede.
export async function preparePayphone(env, origin, order, payment) {
  const responseUrl = `${origin}/api/payphone/return`;
  if (payphoneMode(env) !== "live") {
    return `${origin}/api/payphone/mock?p=${encodeURIComponent(payment.provider_ref)}&resultado=aprobado`;
  }
  if (typeof env.PAYPHONE_TOKEN !== "string" || !env.PAYPHONE_TOKEN) {
    throw new PayphoneError("pago_proveedor", 503, "Payphone no está configurado");
  }
  const amount = Number(payment.amount_cents);
  let response;
  try {
    response = await fetch(`${baseUrl(env)}/api/button/Prepare`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.PAYPHONE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        amount, amountWithoutTax: 0, amountWithTax: amount, tax: 0,
        clientTransactionId: payment.provider_ref, currency: "USD",
        ...(env.PAYPHONE_STORE_ID ? { storeId: env.PAYPHONE_STORE_ID } : {}),
        responseUrl,
        cancellationUrl: `${origin}/?pago=cancelado`,
        timeZone: -5,
        reference: `Pedido ${order.number == null ? order.id : order.number}`,
      }),
    });
  } catch { throw new PayphoneError("pago_proveedor", 502, "Payphone no respondió"); }
  if (!response.ok) throw new PayphoneError("pago_proveedor", 502, "Payphone rechazó la preparación");
  let result;
  try { result = await response.json(); } catch { throw new PayphoneError("pago_proveedor", 502, "Respuesta inválida de Payphone"); }
  const url = result?.payWithCard || result?.payWithPayPhone; // tarjeta primero: payWithPayPhone exige la app
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new PayphoneError("pago_proveedor", 502, "Respuesta inválida de Payphone");
  }
  return url;
}

// V2/Confirm. En mock devuelve la misma forma que el proveedor real, sin red.
export async function confirmPayphone(env, payment, id) {
  if (payphoneMode(env) !== "live") {
    if (id === "timeout") throw new PayphoneError("pago_pendiente", 502, "Timeout simulado de Payphone");
    const expected = `m${payment.provider_ref.slice(0, 12)}`;
    return {
      statusCode: id === "rejected" ? 2 : 3,
      transactionStatus: id === "rejected" ? "Canceled" : "Approved",
      amount: id === "amountbad" ? Number(payment.amount_cents) + 1 : Number(payment.amount_cents),
      currency: "USD",
      clientTransactionId: payment.provider_ref,
      transactionId: id === "rejected" || id === "amountbad" ? id : expected,
      authorizationCode: id === "rejected" ? null : `MOCK${payment.provider_ref.slice(0, 8)}`,
      ...(id === "rejected" ? { messageCode: 16, message: "Fondos insuficientes. Verifica tu saldo o intenta con otro método de pago." } : {}),
    };
  }
  let response;
  try {
    response = await fetch(`${baseUrl(env)}/api/button/V2/Confirm`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.PAYPHONE_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id: Number(id), clientTxId: payment.provider_ref }),
    });
  } catch { throw new PayphoneError("pago_pendiente", 502, "Payphone no respondió a la confirmación"); }
  if (!response.ok) throw new PayphoneError("pago_pendiente", 502, `Payphone HTTP ${response.status}`);
  try { return await response.json(); } catch { throw new PayphoneError("pago_pendiente", 502, "Confirmación inválida"); }
}

// Compara monto, moneda, referencia y transacción: la confirmación debe ser exacta.
export function payphoneMatches(confirmation, payment, id) {
  return Boolean(confirmation) &&
    confirmation.clientTransactionId === payment.provider_ref &&
    Number(confirmation.amount) === Number(payment.amount_cents) &&
    (confirmation.currency == null || confirmation.currency === "USD") &&
    String(confirmation.transactionId) === String(id);
}

/* ── Caja: iniciar pago ──────────────────────────────────────────────────── */

export async function startPayphone(request, env, site, session, encodedId, body) {
  const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!IDEM_RE.test(key)) return error("idempotency_key_requerida", 400);
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.currency !== "USD") return error("moneda_no_soportada", 400);
  const existing = await posPaymentByKey(env, site.slug, order.id, key);
  if (existing) {
    if (existing.provider !== "payphone") return error("idempotencia_conflicto", 409);
    if (existing.status === "paid") {
      return json({ order_id: order.id, payment_id: existing.provider_ref, payment_url: null, status: "paid" });
    }
    if (existing.url && (existing.status === "pending" || existing.status === "unknown")) {
      return json({
        order_id: order.id, payment_id: existing.provider_ref, payment_url: existing.url, status: order.status,
        total_cents: Number(order.total_cents),
      });
    }
  }
  if (order.status === "paid") return error("orden_ya_pagada", 409);
  if (order.status === "rejected") return error("estado_invalido", 409);
  const payment = existing || await createPaymentAttempt(env, site.slug, order, key, "payphone");
  if (!payment) return error("idempotencia_conflicto", 409);
  const origin = new URL(request.url).origin;
  let url;
  try { url = await preparePayphone(env, origin, order, payment); }
  catch (cause) {
    const known = cause instanceof PayphoneError;
    await failPayment(env, site.slug, payment.id, known ? cause.message : "prepare_fallido");
    return error(known ? cause.code : "pago_proveedor", known ? cause.status : 502);
  }
  await setPaymentPending(env, site.slug, payment.id, url);
  return json({
    order_id: order.id, payment_id: payment.provider_ref, payment_url: url, status: order.status,
    total_cents: Number(order.total_cents),
  });
}

/* ── Retorno del comprador: V2/Confirm en el servidor ────────────────────── */

export async function handlePayphoneReturn(request, env, site) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const ref = url.searchParams.get("clientTransactionId") || "";
  if (!id || id.length > 80) return error("pago_invalido", 422);
  if (!REF_RE.test(ref)) return error("pago_invalido", 422);
  const payment = await posPaymentByRef(env, site.slug, ref);
  if (!payment) return error("pago_no_existe", 404);
  const order = await posOrderRow(env, site.slug, payment.order_id);
  if (!order) return error("pedido_no_existe", 404);

  // Retorno repetido (recarga del navegador): idempotente, sin nueva comanda.
  if (payment.status === "paid" || order.status === "paid") return finish(request, url, site, order, "aprobado");
  if (payment.status === "rejected" || order.status === "rejected") return finish(request, url, site, order, "rechazado");
  if (payment.provider_id && payment.provider_id !== id) {
    await markPaymentUnknown(env, site.slug, payment.id, "identificador_alterado");
    return error("pago_alterado", 422);
  }
  if (!payment.provider_id) {
    const attached = await attachProviderId(env, site.slug, payment, id);
    if (!attached) return error("pago_alterado", 422);
  }

  let confirmation;
  try { confirmation = await confirmPayphone(env, payment, id); }
  catch (cause) {
    // Timeout/red: estado desconocido. Nunca se asume rechazo ni se rechaza la orden.
    await markPaymentUnknown(env, site.slug, payment.id, cause instanceof PayphoneError ? cause.code : "confirm_timeout");
    return finish(request, url, site, order, "pendiente", 502);
  }
  if (!payphoneMatches(confirmation, payment, id)) {
    await markPaymentUnknown(env, site.slug, payment.id, "confirmacion_alterada");
    return error("pago_alterado", 422);
  }
  if (Number(confirmation.statusCode) === 3) {
    const resolved = await settlePaymentApproved(env, site.slug, order, payment, {
      providerId: id, authorization: confirmation.authorizationCode,
    });
    return finish(request, url, site, resolved, "aprobado");
  }
  const rejected = await settlePaymentRejected(env, site.slug, order, payment,
    confirmation.message || "Pago no aprobado por el banco.");
  return finish(request, url, site, rejected, "rechazado");
}

function finish(request, url, site, order, status, httpStatus = 200) {
  const wantsJson = (request.headers.get("accept") || "").includes("application/json") ||
    url.searchParams.get("format") === "json";
  if (wantsJson) return json({ status, order_id: order.id, order_status: order.status }, httpStatus);
  const state = STATUS_PATH[status] || "pendiente";
  const token = `${url.origin}/?pago=${state}&pedido=${encodeURIComponent(order.id)}`;
  return new Response(null, { status: 302, headers: { location: token, "cache-control": "no-store" } });
}

/* ── Conciliación autenticada de un pago `unknown` ───────────────────────── */

// Payphone exige confirmar V2/Confirm dentro de 5 minutos tras el retorno; pasado
// ese plazo la transacción se revierte sola. Esta ruta reconsulta SIN recobrar:
//  - dentro de la ventana: reintenta Confirm y concilia;
//  - fuera de la ventana: deja el pago `unknown` para revisión manual (nunca lo marca pagado).
export const RECONCILE_WINDOW_MS = 5 * 60 * 1000;

export async function reconcilePayphone(env, site, session, encodedRef) {
  let ref;
  try { ref = decodeURIComponent(encodedRef); } catch { return error("pago_invalido", 422); }
  if (!REF_RE.test(ref)) return error("pago_invalido", 422);
  const payment = await posPaymentByRef(env, site.slug, ref);
  if (!payment) return error("pago_no_existe", 404);
  const found = await posOrderForAction(env, site, session, encodeURIComponent(payment.order_id));
  if (found.response) return found.response;
  const order = found.order;
  if (payment.status === "paid" || order.status === "paid") {
    return json({ status: "aprobado", order_id: order.id, order_status: order.status });
  }
  if (payment.status === "rejected") {
    return json({ status: "rechazado", order_id: order.id, order_status: order.status });
  }
  if (!payment.provider_id) return error("pago_sin_confirmar", 409);
  const updatedAt = Number(payment.updated_at) || 0;
  if (!updatedAt || Date.now() - updatedAt > RECONCILE_WINDOW_MS) {
    return error("conciliacion_vencida", 409, { payment_status: payment.status });
  }
  let confirmation;
  try { confirmation = await confirmPayphone(env, payment, payment.provider_id); }
  catch {
    await markPaymentUnknown(env, site.slug, payment.id, "conciliacion_timeout");
    return error("pago_pendiente", 502);
  }
  if (!payphoneMatches(confirmation, payment, payment.provider_id)) {
    await markPaymentUnknown(env, site.slug, payment.id, "conciliacion_alterada");
    return error("pago_alterado", 422);
  }
  if (Number(confirmation.statusCode) === 3) {
    const paid = await settlePaymentApproved(env, site.slug, order, payment, {
      providerId: payment.provider_id, authorization: confirmation.authorizationCode,
    });
    return json({ status: "aprobado", order_id: paid.id, order_status: paid.status });
  }
  const rejected = await settlePaymentRejected(env, site.slug, order, payment,
    confirmation.message || "Pago no aprobado por el banco.");
  return json({ status: "rechazado", order_id: rejected.id, order_status: rejected.status });
}

/* ── Job programado: conciliar `unknown` dentro de la ventana de 5 minutos ── */

// Cron del Worker (cada minuto). Reconsulta V2/Confirm sin recobrar y sin sesión.
// Fuera de la ventana no se toca: Payphone ya revirtió y el pago queda para revisión
// manual. Un error de red conserva el pago `unknown` y se reintenta en la próxima pasada.
export async function reconcilePendingPayments(env, now = Date.now()) {
  const rows = await env.DB.prepare(
    "SELECT p.* FROM pos_payments p JOIN pos_orders o ON o.slug = p.slug AND o.id = p.order_id " +
    "WHERE p.provider = 'payphone' AND p.status = 'unknown' AND p.provider_id IS NOT NULL " +
    "AND p.updated_at >= ? AND o.status IN ('pending', 'confirmed') ORDER BY p.updated_at ASC LIMIT 50",
  ).bind(now - RECONCILE_WINDOW_MS).all();
  let settled = 0, pending = 0;
  for (const payment of rows.results || []) {
    const order = await posOrderRow(env, payment.slug, payment.order_id);
    if (!order || order.status === "paid") continue;
    let confirmation;
    try { confirmation = await confirmPayphone(env, payment, payment.provider_id); }
    catch {
      await markPaymentUnknown(env, payment.slug, payment.id, "job_timeout");
      pending++;
      continue;
    }
    if (!payphoneMatches(confirmation, payment, payment.provider_id)) {
      await markPaymentUnknown(env, payment.slug, payment.id, "job_alterada");
      pending++;
      continue;
    }
    if (Number(confirmation.statusCode) === 3) {
      await settlePaymentApproved(env, payment.slug, order, payment, {
        providerId: payment.provider_id, authorization: confirmation.authorizationCode,
      });
      settled++;
    } else {
      await settlePaymentRejected(env, payment.slug, order, payment,
        confirmation.message || "Pago no aprobado por el banco.");
      settled++;
    }
  }
  return { checked: (rows.results || []).length, settled, pending };
}

// Simulador local del retorno de Payphone. En live no existe.
export function handlePayphoneMock(request, env) {
  if (payphoneMode(env) === "live") return error("ruta_no_encontrada", 404);
  const url = new URL(request.url);
  const ref = url.searchParams.get("p") || "";
  if (!REF_RE.test(ref)) return error("pago_invalido", 422);
  const resultado = url.searchParams.get("resultado") || "aprobado";
  const id = resultado === "timeout" ? "timeout"
    : resultado === "rechazado" ? "rejected"
      : resultado === "importe" ? "amountbad"
        : `m${ref.slice(0, 12)}`;
  const target = `${url.origin}/api/payphone/return?id=${encodeURIComponent(id)}&clientTransactionId=${encodeURIComponent(ref)}`;
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
}
