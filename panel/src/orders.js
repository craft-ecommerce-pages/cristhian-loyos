// Pedidos del menú: best-effort público, sin filtrar errores al visitante.
// Al crear/confirmar un pedido web se avisa al club siempre en silencio.
import { normalizeConfig } from "../../loyalty/src/contract.js";
import { sha256hex, timingEqual } from "./auth.js";
import { bendoAvailable } from "./bendo.js";
import { OWNER_STAFF } from "./caja.js";
import { load, slugify } from "./catalog.js";
import { dayOf, error, json, noContent } from "./contract.js";
import { prepareInvoice, submitInvoice } from "./invoices.js";
import { openShiftFor } from "./turnos.js";

const MAX_BYTES = 16 * 1024;
const STATUS = { confirm: "confirmed", reject: "rejected" };
const STATUS_VALUE = new Set(["pending", "confirmed", "rejected", "all"]);
const ORDER_COLUMNS = [
  "id", "slug", "created_at", "total", "currency", "client_name", "client_phone", "delivery_mode", "address",
  "items", "status", "status_at", "number", "table_no", "source", "staff_id", "note", "edited_at", "edited_by",
  "print_count", "printed_at",
].join(", ");
const str = (v, n = 200, empty = false) => typeof v === "string" && (empty || v.trim()) && [...v].length <= n;
const num = v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000;
const optional = (v, n) => v == null || typeof v === "string" && [...v].length <= n;

function validItems(items) {
  return Array.isArray(items) && items.length <= 50 && items.every(i => i && typeof i === "object" && !Array.isArray(i) &&
    str(i.nombre) && Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 999 && num(i.precio) &&
    (i.variant == null || str(i.variant, 200, true)));
}
function valid(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || !validItems(body.items) || !num(body.total) ||
    !str(body.currency, 20) || !str(body.client_name) || !str(body.client_phone) || !str(body.delivery_mode, 40)) return false;
  return body.address == null || str(body.address, 200, true);
}
function tableValid(body) {
  return body && typeof body === "object" && !Array.isArray(body) && validItems(body.items) && num(body.total) &&
    str(body.currency, 20) && str(body.client_name) && optional(body.client_phone, 40) && optional(body.table_no, 10) &&
    optional(body.note, 200) && (body.order_id == null || str(body.order_id, 200));
}
function manualValid(body) {
  return body && typeof body === "object" && !Array.isArray(body) && validItems(body.items) &&
    optional(body.table_no, 10) && optional(body.note, 200) && optional(body.client_name, 60);
}
function orderData(row) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items); } catch { /* una fila vieja rota no rompe la lista */ }
  return { ...row, items: Array.isArray(items) ? items : [] };
}
function totalOf(items) { return items.reduce((total, item) => total + item.qty * item.precio, 0); }
function orderId(body) { return str(body.order_id, 200) ? body.order_id : crypto.randomUUID(); }
function insertWithNumber(env, values, now, extra = []) {
  const day = dayOf(now);
  return env.DB.batch([
    env.DB.prepare(
      "INSERT INTO order_seq (slug, day, n) VALUES (?, ?, 1) ON CONFLICT(slug, day) DO UPDATE SET n = n + 1",
    ).bind(values.slug, day),
    env.DB.prepare(
      "INSERT INTO orders (id, slug, created_at, total, currency, client_name, client_phone, delivery_mode, address, items, " +
      "status, status_at, number, table_no, source, staff_id, note) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, " +
      "(SELECT n FROM order_seq WHERE slug = ? AND day = ?), ?, ?, ?, ?)",
    ).bind(
      values.id, values.slug, now, values.total, values.currency, values.client_name, values.client_phone,
      values.delivery_mode, values.address || null, JSON.stringify(values.items), values.status || "pending", values.status_at || null,
      values.slug, day, values.table_no || null, values.source, values.staff_id || null, values.note || null,
    ),
    ...extra,
  ]);
}

export async function handleOrder(request, env, ctx, site) {
  try {
    if (request.method !== "POST") return noContent();
    const length = Number(request.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_BYTES) return noContent();
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return noContent();
    const body = JSON.parse(raw); if (!valid(body)) return noContent();
    const ip = request.headers.get("cf-connecting-ip") || "sin-ip";
    if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: `o:${site.slug}:${ip}` })).success) return noContent();
    const now = Date.now(), id = orderId(body);
    const events = env.DB.prepare(
      "INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, 0, 1) " +
      "ON CONFLICT(slug, day) DO UPDATE SET orders = orders + 1",
    ).bind(site.slug, dayOf(now));
    const write = insertWithNumber(env, { ...body, id, slug: site.slug, source: "web" }, now, [events]);
    // El crédito se pide DESPUÉS de guardar; un fallo del club nunca pierde el pedido.
    const task = write.then(() => {
      if (body.delivery_mode !== "mesa") return requestCredit(env, site.slug, id, body.client_phone);
    }).catch(() => {});
    if (ctx?.waitUntil) ctx.waitUntil(task); else await task;
  } catch { /* beacon perdido: siempre 204 */ }
  return noContent();
}

export async function handleTableOrder(request, env, ctx, site) {
  if (request.method !== "POST") return error("pedido_invalido", 400);
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) return error("pedido_muy_grande", 413);
  let raw, body;
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return error("pedido_muy_grande", 413);
    body = JSON.parse(raw);
  } catch { return error("pedido_invalido", 400); }
  if (!tableValid(body)) return error("pedido_invalido", 400);
  const setting = await env.DB.prepare("SELECT tables_enabled FROM panel_settings WHERE slug = ?").bind(site.slug).first();
  if (Number(setting?.tables_enabled) !== 1) return error("mesas_apagadas", 403);
  const ip = request.headers.get("cf-connecting-ip") || "sin-ip";
  if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: `om:${site.slug}:${ip}` })).success)
    return error("demasiados_pedidos", 429);
  if (body.order_id) {
    const existing = await env.DB.prepare("SELECT id, number FROM orders WHERE id = ? AND slug = ?")
      .bind(body.order_id, site.slug).first();
    if (existing) return json({ id: existing.id, number: existing.number });
  }
  const now = Date.now(), id = body.order_id || crypto.randomUUID();
  const events = env.DB.prepare(
    "INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, 0, 1) " +
    "ON CONFLICT(slug, day) DO UPDATE SET orders = orders + 1",
  ).bind(site.slug, dayOf(now));
  try {
    await insertWithNumber(env, {
      ...body, id, slug: site.slug, client_phone: body.client_phone || "", delivery_mode: "mesa", source: "mesa",
    }, now, [events]);
  } catch {
    const existing = body.order_id && await env.DB.prepare("SELECT id, number FROM orders WHERE id = ? AND slug = ?")
      .bind(body.order_id, site.slug).first();
    if (existing) return json({ id: existing.id, number: existing.number });
    return error("pedido_invalido", 400);
  }
  const row = await env.DB.prepare("SELECT id, number FROM orders WHERE id = ? AND slug = ?").bind(id, site.slug).first();
  return json({ id: row.id, number: row.number }, 201);
}

export async function listOrders(request, env, slug) {
  const q = new URL(request.url).searchParams;
  const offset = integer(q.get("offset"), 0, 1_000_000), limit = integer(q.get("limit"), 20, 50);
  if (offset == null || limit == null) return json({ error: "paginacion_invalida" }, 400);
  const [rows, total, pending] = await Promise.all([
    env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE slug = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(slug, limit, offset).all(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM orders WHERE slug = ?").bind(slug).first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM orders WHERE slug = ? AND status = 'pending'").bind(slug).first(),
  ]);
  return json({
    orders: (rows.results || []).map(orderData), total: Number(total?.total) || 0, pending: Number(pending?.total) || 0,
  });
}

// El mesero no usa conteos: una sola consulta (la página cuenta lo que recibió).
export async function listMeseroOrders(request, env, slug) {
  const q = new URL(request.url).searchParams, status = q.get("status") || "all";
  const offset = integer(q.get("offset"), 0, 1_000_000), limit = integer(q.get("limit"), 30, 50);
  if (!STATUS_VALUE.has(status) || offset == null || limit == null) return error("pedido_invalido", 400);
  return json({ orders: await meseroOrders(env, slug, status, limit, offset) });
}
export async function meseroOrders(env, slug, status, limit, offset = 0) {
  const where = status === "all" ? "slug = ?" : "slug = ? AND status = ?";
  const values = status === "all" ? [slug, limit, offset] : [slug, status, limit, offset];
  const rows = await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...values).all();
  return (rows.results || []).map(orderData);
}

export async function createManualOrder(env, site, session, body) {
  if (!manualValid(body)) return error("pedido_invalido", 400);
  const config = await env.MENUS.get(`${site.slug}:config`, "json").catch(() => null);
  const table = body.table_no || "", now = Date.now();
  // ponytail: los precios vienen del navegador; el mesero los revisa antes de confirmar la comanda.
  const values = {
    id: crypto.randomUUID(), slug: site.slug, items: body.items, total: totalOf(body.items), currency:
      typeof config?.currency === "string" && config.currency ? config.currency : "$", client_name: body.client_name || (table ? `Mesa ${table}` : "Mostrador"),
    client_phone: "", delivery_mode: "mesa", source: "mesero", status: "confirmed", status_at: now,
    staff_id: session.staff_id, table_no: table || null, note: body.note || null,
  };
  await insertWithNumber(env, values, now);
  return json({ order: await findOrder(env, site.slug, values.id) }, 201);
}

export async function editMeseroOrder(env, site, session, encodedId, body) {
  const id = decodedId(encodedId); if (!id) return error("pedido_no_existe", 404);
  const old = await findOrder(env, site.slug, id);
  if (!old) return error("pedido_no_existe", 404);
  if (old.status !== "pending") return error("estado_invalido", 409);
  if (!body || typeof body !== "object" || Array.isArray(body)) return error("pedido_invalido", 400);
  const hasItems = Object.hasOwn(body, "items"), hasTable = Object.hasOwn(body, "table_no"), hasNote = Object.hasOwn(body, "note");
  const hasName = Object.hasOwn(body, "client_name");
  if ((!hasItems && !hasTable && !hasNote && !hasName) || (hasItems && !validItems(body.items)) ||
    (hasTable && !optional(body.table_no, 10)) || (hasNote && !optional(body.note, 200)) ||
    (hasName && !optional(body.client_name, 60))) return error("pedido_invalido", 400);
  const items = hasItems ? body.items : old.items, table = hasTable ? body.table_no || null : old.table_no;
  const note = hasNote ? body.note || null : old.note, now = Date.now();
  const name = hasName ? body.client_name || (table ? `Mesa ${table}` : "Mostrador") : old.client_name;
  const changed = await env.DB.prepare(
    "UPDATE orders SET items = ?, total = ?, table_no = ?, note = ?, client_name = ?, edited_at = ?, edited_by = ? " +
    "WHERE id = ? AND slug = ? AND status = 'pending'",
  ).bind(JSON.stringify(items), totalOf(items), table, note, name, now, session.staff_id, id, site.slug).run();
  if (!changed.meta.changes) return error("estado_invalido", 409);
  return json({ order: await findOrder(env, site.slug, id) });
}

export async function printMeseroOrder(env, site, encodedId) {
  const id = decodedId(encodedId); if (!id) return error("pedido_no_existe", 404);
  const changed = await env.DB.prepare(
    "UPDATE orders SET print_count = print_count + 1, printed_at = ? WHERE id = ? AND slug = ? AND status = 'confirmed'",
  ).bind(Date.now(), id, site.slug).run();
  if (!changed.meta.changes) {
    const old = await findOrder(env, site.slug, id);
    return old ? error("estado_invalido", 409) : error("pedido_no_existe", 404);
  }
  return json({ order: await findOrder(env, site.slug, id) });
}

// Confirmar entrega o rechazar. Repetir el mismo estado es idempotente.
export async function setOrderStatus(env, ctx, site, encodedId, action) {
  const result = await changeOrderStatus(env, ctx, site, encodedId, action);
  return result.error || json({ id: result.order.id, status: result.order.status, status_at: result.order.status_at });
}
export async function setMeseroOrderStatus(env, ctx, site, encodedId, action) {
  const result = await changeOrderStatus(env, ctx, site, encodedId, action);
  return result.error || json({ order: result.order });
}
async function changeOrderStatus(env, ctx, site, encodedId, action) {
  const id = decodedId(encodedId), status = STATUS[action];
  if (!id || !status) return { error: error("pedido_no_existe", 404) };
  const old = await findOrder(env, site.slug, id);
  if (!old) return { error: error("pedido_no_existe", 404) };
  if (old.status === status) return { order: old };
  if (old.status !== "pending") return { error: error("estado_invalido", 409) };
  const now = Date.now();
  const changed = await env.DB.prepare("UPDATE orders SET status = ?, status_at = ? WHERE id = ? AND slug = ? AND status = 'pending'")
    .bind(status, now, id, site.slug).run();
  if (!changed.meta.changes) {
    const current = await findOrder(env, site.slug, id);
    return current?.status === status ? { order: current } : { error: error("estado_invalido", 409) };
  }
  // Los pedidos de mesa y mesero no participan del club ni crean/liberan créditos.
  if (old.source === "web" && old.delivery_mode !== "mesa") {
    const task = notifyStatus(env, site.slug, id, action);
    if (ctx?.waitUntil) ctx.waitUntil(task); else await task;
  }
  return { order: await findOrder(env, site.slug, id) };
}
async function findOrder(env, slug, id) {
  return orderData(await env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = ? AND slug = ?`).bind(id, slug).first());
}
function decodedId(encoded) { try { return decodeURIComponent(encoded); } catch { return null; } }

async function requestCredit(env, slug, orderId, phone) {
  try {
    if (!loyaltyReady(env)) return;
    const config = await env.MENUS.get(`${slug}:loyalty`, "json");
    if (!config || normalizeConfig(config).enabled !== true) return;
    await loyaltyAdmin(env, slug, "credits", { order_id: orderId, phone });
  } catch { /* silencioso: el pedido ya quedó guardado */ }
}
async function notifyStatus(env, slug, orderId, action) {
  try {
    if (!loyaltyReady(env)) return;
    await loyaltyAdmin(env, slug, `credits/${encodeURIComponent(orderId)}/${action === "confirm" ? "grant" : "reject"}`, {});
  } catch { /* silencioso: el estado ya quedó guardado */ }
}
function loyaltyReady(env) { return env.LOYALTY && typeof env.LOYALTY.fetch === "function" && Boolean(env.LOYALTY_ADMIN_TOKEN); }
async function loyaltyAdmin(env, slug, path, body) {
  await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${env.LOYALTY_ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
}
function integer(raw, fallback, max) {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw); return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/* ── POS: cliente web + caja (migración 0006) ──────────────────────────────
   Estados: pending → confirmed → paid, y rejected desde pending/confirmed.
   Importes en centavos recalculados desde el catálogo D1; la sede se congela.
   Idempotencia por (slug, idempotency_key) y pagos por (slug, order_id, key).
   La comanda (pos_comandas) solo nace cuando la orden queda pagada. */

export const POS_STATUS = ["pending", "confirmed", "paid", "ready", "rejected"];
const POS_COLUMNS = "id, slug, sede_id, created_at, updated_at, number, source, status, status_at, currency, " +
  "subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, address, table_no, note, " +
  "staff_id, idempotency_key, paid_at, payment_method, ready_at, " +
  "billing_document_type, billing_document_number, billing_email, billing_address";
const SEDE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DELIVERY_MODES = new Set(["delivery", "pickup", "mesa"]);
const PAYMENT_METHODS = new Set(["cash", "transfer", "bendo"]);

// Facturación: identificación ecuatoriana normalizada. No se valida contra el
// SRI; solo formato. La factura NO se emite por capturar estos datos.
const DOCUMENT_TYPES = new Set(["cedula", "ruc"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?\d{7,15}$/;

const isObject = value => value != null && typeof value === "object" && !Array.isArray(value);
const clippedText = (value, min, max) => typeof value === "string" && [...value.trim()].length >= min &&
  [...value].length <= max ? value.trim() : null;

/* ── Sedes: D1 es la fuente; se siembran una vez desde config.location.sedes ── */

export async function sedesFor(env, slug) {
  let rows = (await env.DB.prepare(
    "SELECT id, nombre, direccion, universidad, activa FROM pos_sedes WHERE slug = ? ORDER BY nombre, id",
  ).bind(slug).all()).results || [];
  if (!rows.length) {
    const config = await env.MENUS.get(`${slug}:config`, "json").catch(() => null);
    const configured = Array.isArray(config?.location?.sedes) ? config.location.sedes.slice(0, 50) : [];
    const seeds = [], used = new Set();
    for (const sede of configured) {
      if (!isObject(sede)) continue;
      const nombre = clippedText(sede.nombre, 1, 120);
      if (!nombre) continue;
      const base = typeof sede.id === "string" && SEDE_ID_RE.test(sede.id) ? sede.id : slugify(nombre) || "sede";
      let id = base.slice(0, 64), n = 2;
      while (used.has(id)) id = `${base.slice(0, 60)}-${n++}`;
      used.add(id);
      seeds.push({ id, nombre, direccion: clippedText(sede.direccion, 0, 300) || "" });
    }
    if (seeds.length) {
      const now = Date.now();
      await env.DB.batch(seeds.map(sede => env.DB.prepare(
        "INSERT OR IGNORE INTO pos_sedes (slug, id, nombre, direccion, universidad, activa, updated_at) " +
        "VALUES (?, ?, ?, ?, '', 1, ?)",
      ).bind(slug, sede.id, sede.nombre, sede.direccion, now)));
      rows = (await env.DB.prepare(
        "SELECT id, nombre, direccion, universidad, activa FROM pos_sedes WHERE slug = ? ORDER BY nombre, id",
      ).bind(slug).all()).results || [];
    }
  }
  return rows.map(sede => ({
    id: sede.id, nombre: sede.nombre, direccion: sede.direccion || "",
    universidad: sede.universidad || "", activa: Number(sede.activa) === 1,
  }));
}

export async function sedeById(env, slug, id) {
  return (await sedesFor(env, slug)).find(sede => sede.id === id) || null;
}

// Alta/actualización de sedes desde el panel. No borra las existentes (baja = activa:false).
export async function upsertSedes(env, slug, input) {
  if (!Array.isArray(input) || input.length > 50) return { error: "sede_invalida", status: 400 };
  const now = Date.now(), sedes = [], seen = new Set();
  for (const raw of input) {
    if (!isObject(raw)) return { error: "sede_invalida", status: 400 };
    const id = typeof raw.id === "string" && SEDE_ID_RE.test(raw.id) ? raw.id : null;
    const nombre = clippedText(raw.nombre, 1, 120);
    const direccion = raw.direccion == null ? "" : typeof raw.direccion === "string" ? raw.direccion.trim().slice(0, 300) : null;
    const universidad = raw.universidad == null ? "" : typeof raw.universidad === "string" ? raw.universidad.trim().slice(0, 120) : null;
    const activa = raw.activa == null ? true : raw.activa;
    if (!id || !nombre || direccion == null || universidad == null || typeof activa !== "boolean" || seen.has(id)) {
      return { error: "sede_invalida", status: 400 };
    }
    seen.add(id);
    sedes.push({ id, nombre, direccion, universidad, activa: activa ? 1 : 0 });
  }
  for (const sede of sedes) {
    await env.DB.prepare(
      "INSERT INTO pos_sedes (slug, id, nombre, direccion, universidad, activa, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(slug, id) DO UPDATE SET nombre = excluded.nombre, direccion = excluded.direccion, " +
      "universidad = excluded.universidad, activa = excluded.activa, updated_at = excluded.updated_at",
    ).bind(slug, sede.id, sede.nombre, sede.direccion, sede.universidad, sede.activa, now).run();
  }
  return { sedes: await sedesFor(env, slug) };
}

/* ── Precios: siempre desde el catálogo vigente en D1 ─────────────────────── */

export function centsOf(value) {
  let text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  text = text.replace(/[^\d.,-]/g, "");
  if (!text) return null;
  if (text.includes(",") && text.includes(".")) text = text.replace(/,/g, "");
  else text = text.replace(",", ".");
  if (!/^\d+(?:\.\d{1,4})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function baseCents(product) {
  const base = centsOf(product.price);
  const promo = centsOf(product.promo_price);
  return product.type === "promocion" && promo != null && promo > 0 ? promo : base;
}

function optionData(option) {
  if (typeof option === "string") return { label: option, price: null, delta: 0 };
  if (!isObject(option) || typeof option.name !== "string" || !option.name.trim()) return null;
  const price = typeof option.price === "number" && Number.isFinite(option.price) && option.price >= 0
    ? Math.round(option.price * 100) : null;
  const delta = typeof option.price_delta === "number" && Number.isFinite(option.price_delta)
    ? Math.round(option.price_delta * 100) : 0;
  return { label: option.name, price, delta };
}

// `variant_id` es el label publicado de la opción (el catálogo no emite ids propios).
function unitCents(product, variantId) {
  const base = baseCents(product);
  if (variantId == null) return base == null ? null : { unit: base };
  const wanted = String(variantId).trim().toLowerCase();
  for (const group of Array.isArray(product.variants) ? product.variants : []) {
    for (const option of Array.isArray(group?.options) ? group.options : []) {
      const data = optionData(option);
      if (!data) continue;
      const plain = data.label.replace(/\s*\(\$[\d.,]+\)\s*$/, "").trim().toLowerCase();
      if (plain !== wanted && data.label.trim().toLowerCase() !== wanted) continue;
      if (data.price != null) return { unit: data.price };
      return base == null ? null : { unit: Math.max(0, base + data.delta) };
    }
  }
  return { missing: true };
}

// Categoría comercial congelada al cobrar. Se toma del producto publicado
// (`report_category`) y, para catálogos legacy sin ese campo, del prefijo de
// sus categorías. Cualquier valor desconocido cae a `tradicional` para que la
// línea nunca quede sin categoría (el reporte expone la conciliación).
export const REPORT_CATEGORIES = ["sushi", "fastfood", "tradicional", "postres"];
export function reportCategoryOf(product) {
  const declared = typeof product?.report_category === "string" ? product.report_category.trim().toLowerCase() : "";
  if (REPORT_CATEGORIES.includes(declared)) return declared;
  for (const category of Array.isArray(product?.categories) ? product.categories : []) {
    if (typeof category !== "string") continue;
    const prefix = category.split("-", 1)[0].toLowerCase();
    if (REPORT_CATEGORIES.includes(prefix)) return prefix;
  }
  return "tradicional";
}

// Valida catálogo/disponibilidad y devuelve el snapshot de líneas en centavos.
export async function pricePosItems(env, slug, items) {
  let doc;
  try { ({ doc } = await load(env, slug)); } catch { return { error: "catalogo_no_disponible", status: 503 }; }
  const products = new Map((doc.products || []).map(product => [product.id, product]));
  const lines = [];
  let total = 0;
  for (const item of items) {
    const product = products.get(item.product_id);
    if (!product || product.active !== true || product.catalog_visible !== true) {
      return { error: "producto_no_disponible", status: 400, product_id: item.product_id };
    }
    if (product.stock != null && Number(product.stock) < item.qty) {
      return { error: "sin_stock", status: 409, product_id: item.product_id };
    }
    const price = unitCents(product, item.variant_id);
    if (price?.missing) return { error: "variante_no_existe", status: 400, product_id: item.product_id };
    if (!price || price.unit == null) return { error: "precio_no_disponible", status: 409, product_id: item.product_id };
    const subtotal = price.unit * item.qty;
    total += subtotal;
    lines.push({
      product_id: product.id, name: product.name, qty: item.qty, unit_cents: price.unit, subtotal_cents: subtotal,
      report_category: reportCategoryOf(product),
      ...(item.variant_id == null ? {} : { variant_id: item.variant_id }), ...(item.note == null ? {} : { note: item.note }),
    });
  }
  return { lines, total_cents: total };
}

export async function currencyOf(env, slug) {
  try {
    const config = await env.MENUS.get(`${slug}:config`, "json");
    const code = typeof config?.currency === "string" ? config.currency.trim().toUpperCase() : "";
    return /^[A-Z]{3}$/.test(code) ? code : "USD";
  } catch { return "USD"; }
}

/* ── Transferencia: datos bancarios solo si están configurados oficialmente ──
   No se inventan cuentas. La fuente es `config.bank_transfer` en KV (la carga
   el integrador/administrador con valores oficiales del titular) y el WhatsApp
   oficial de comprobantes (`location.telefono_principal` o `whatsapp_number`).
   Si falta la cuenta o el WhatsApp, la opción queda deshabilitada y no se
   publica nada. */
export async function transferInfo(env, slug) {
  const config = await env.MENUS.get(`${slug}:config`, "json").catch(() => null);
  const raw = isObject(config?.bank_transfer) ? config.bank_transfer : null;
  if (!raw) return null;
  const text = (value, max) => typeof value === "string" && value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value.trim().slice(0, max) : "";
  const bank = text(raw.bank, 120), accountType = text(raw.account_type, 40);
  const account = typeof raw.account_number === "string" && /^[\dA-Za-z\s-]{4,64}$/.test(raw.account_number.trim())
    ? raw.account_number.trim() : "";
  const holder = text(raw.holder, 120);
  const whatsapp = String(config?.location?.telefono_principal || config?.whatsapp_number || "").replace(/\D/g, "");
  if (!bank || !account || !holder || whatsapp.length < 7 || whatsapp.length > 15) return null;
  const note = text(raw.note, 200);
  return { bank, account_type: accountType, account_number: account, holder, ...(note ? { note } : {}) };
}

/* ── Token opaco del comprador: HMAC determinista, no se guarda ───────────── */

export async function orderToken(env, slug, id) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!secret) throw new Error("SESSION_SECRET no configurado");
  return sha256hex(`order-token:${secret}:${slug}:${id}`);
}

/* ── Consulta y autorización ──────────────────────────────────────────────── */

export async function posOrderRow(env, slug, id) {
  return env.DB.prepare(`SELECT ${POS_COLUMNS} FROM pos_orders WHERE id = ? AND slug = ?`).bind(id, slug).first();
}

export function posOrderData(row, extra = {}) {
  if (!row) return null;
  let items = [];
  try { items = JSON.parse(row.items); } catch { /* snapshot roto: la orden sigue listándose */ }
  const totalCents = Number(row.total_cents) || 0;
  const ready = row.ready_at != null;
  return {
    id: row.id, sede_id: row.sede_id, number: row.number == null ? null : Number(row.number),
    created_at: Number(row.created_at), updated_at: Number(row.updated_at),
    // `ready` es un estado posterior a `paid`; en D1 se conserva `paid` + ready_at
    // para que la comanda, la impresión y los reportes sigan anclados al cobro.
    source: row.source, status: ready ? "ready" : row.status,
    status_at: row.status_at == null ? null : Number(row.status_at),
    currency: row.currency, subtotal_cents: Number(row.subtotal_cents) || 0, total_cents: totalCents,
    total: totalCents / 100, // compatibilidad con las pantallas que muestran soles/dólares
    items: Array.isArray(items) ? items : [],
    customer_name: row.customer_name || "", customer_phone: row.customer_phone || "",
    delivery_mode: row.delivery_mode || "", payment_method: row.payment_method || "cash", address: row.address || null,
    table_no: row.table_no || null, note: row.note || null, staff_id: row.staff_id || null,
    paid_at: row.paid_at == null ? null : Number(row.paid_at),
    ready_at: ready ? Number(row.ready_at) : null,
    print_count: row.print_count == null ? 0 : Number(row.print_count),
    comanda_at: row.comanda_at == null ? null : Number(row.comanda_at),
    ...extra,
  };
}

// null = todas las sedes (dueño o mesero del club sin mapeo); Set = solo las suyas.
export async function sedesAllowed(env, slug, session) {
  if (!session || session.owner || session.staff_id === OWNER_STAFF) return null;
  const id = String(session.staff_id || "");
  if (!id.startsWith("l_")) return null;
  const row = await env.DB.prepare("SELECT sedes, active FROM pos_staff WHERE slug = ? AND id = ?").bind(slug, id).first();
  if (!row || Number(row.active) !== 1) return new Set();
  try {
    const list = JSON.parse(row.sedes);
    return new Set(Array.isArray(list) ? list.filter(value => typeof value === "string") : []);
  } catch { return new Set(); }
}

export async function authorizedForSede(env, slug, session, sedeId) {
  const allowed = await sedesAllowed(env, slug, session);
  return allowed === null || allowed.has(sedeId);
}

/* ── Creación de pedidos (web pública y caja) ────────────────────────────── */

const fiscal = campo => ({ error: "datos_fiscales_invalidos", campo });
const fiscalMissing = campo => ({ error: "datos_fiscales_requeridos", campo });

// Datos fiscales del comprador web. Se aceptan en `customer.billing` y, por
// compatibilidad, en `billing` de nivel superior. Se normalizan antes de
// persistir; nunca se devuelven al navegador.
function parseBilling(body, customer) {
  const source = isObject(customer.billing) ? customer.billing : isObject(body.billing) ? body.billing : null;
  if (!source) return fiscalMissing("billing");
  const type = typeof source.document_type === "string" ? source.document_type.trim().toLowerCase() : "";
  if (!type) return fiscalMissing("billing.document_type");
  if (!DOCUMENT_TYPES.has(type)) return fiscal("billing.document_type");
  const number = typeof source.document_number === "string" ? source.document_number.trim() : "";
  if (!number) return fiscalMissing("billing.document_number");
  // Cédula ecuatoriana: 10 dígitos; RUC: 13. Solo formato, sin consulta al SRI.
  if (type === "cedula" ? !/^\d{10}$/.test(number) : !/^\d{13}$/.test(number)) {
    return fiscal("billing.document_number");
  }
  const email = typeof source.email === "string" ? source.email.trim().toLowerCase() : "";
  if (!email) return fiscalMissing("billing.email");
  if (email.length > 254 || !EMAIL_RE.test(email)) return fiscal("billing.email");
  const address = typeof source.address === "string" ? source.address.trim() : "";
  if (!address) return fiscalMissing("billing.address");
  if ([...address].length > 300) return fiscal("billing.address");
  return { document_type: type, document_number: number, email, address };
}

function parsePosOrder(body, options = {}) {
  if (!isObject(body)) return { error: "pedido_invalido", status: 400 };
  const web = options.source === "web";
  const sedeId = typeof body.sede_id === "string" ? body.sede_id.trim() : "";
  if (!sedeId) return { error: "sede_requerida", status: 400 };
  if (!SEDE_ID_RE.test(sedeId)) return { error: "sede_invalida", status: 400 };
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!IDEM_RE.test(key)) return { error: "idempotency_key_requerida", status: 400 };
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return { error: "pedido_invalido", status: 400 };
  }
  const items = [];
  for (const raw of body.items) {
    if (!isObject(raw) || typeof raw.product_id !== "string" || !PRODUCT_ID_RE.test(raw.product_id) ||
      !Number.isInteger(raw.qty) || raw.qty < 1 || raw.qty > 99 ||
      !(raw.variant_id == null || typeof raw.variant_id === "string" && [...raw.variant_id].length <= 120) ||
      !(raw.note == null || typeof raw.note === "string" && [...raw.note].length <= 200)) {
      return { error: "pedido_invalido", status: 400 };
    }
    items.push({
      product_id: raw.product_id, qty: raw.qty,
      ...(raw.variant_id == null || raw.variant_id === "" ? {} : { variant_id: raw.variant_id }),
      ...(raw.note == null || raw.note === "" ? {} : { note: raw.note }),
    });
  }
  const customer = isObject(body.customer) ? body.customer : {};
  const name = (typeof customer.name === "string" ? customer.name : body.client_name) ?? "";
  const phone = (typeof customer.phone === "string" ? customer.phone : body.client_phone) ?? "";
  if ([...String(name)].length > 120 || [...String(phone)].length > 40) return { error: "pedido_invalido", status: 400 };
  let billing = null;
  if (web) {
    if (!String(name).trim()) return { error: "cliente_requerido", status: 400, campo: "customer.name" };
    if (!PHONE_RE.test(String(phone).trim())) return { error: "telefono_invalido", status: 400, campo: "customer.phone" };
    billing = parseBilling(body, customer);
    if (billing.error) return { ...billing, status: 400 };
  }
  const address = body.address ?? customer.address ?? null;
  if (!(address == null || typeof address === "string" && [...address].length <= 300)) {
    return { error: "pedido_invalido", status: 400 };
  }
  const mode = body.delivery_mode == null ? (address ? "delivery" : "pickup") : body.delivery_mode;
  if (!DELIVERY_MODES.has(mode)) return { error: "pedido_invalido", status: 400 };
  const paymentMethod = body.payment_method == null ? "cash" : body.payment_method;
  if (!PAYMENT_METHODS.has(paymentMethod)) return { error: "metodo_pago_invalido", status: 400 };
  const table = body.table_no == null ? null : String(body.table_no);
  if (table != null && [...table].length > 10) return { error: "pedido_invalido", status: 400 };
  const note = body.note == null ? null : body.note;
  if (!(note == null || typeof note === "string" && [...note].length <= 200)) {
    return { error: "pedido_invalido", status: 400 };
  }
  return {
    sede_id: sedeId, idempotency_key: key, items, customer_name: String(name).trim(), customer_phone: String(phone).trim(),
    delivery_mode: mode, payment_method: paymentMethod, address: address == null ? null : String(address).trim(), table_no: table || null,
    note: note == null || note === "" ? null : note,
    ...(billing ? { billing } : {}),
  };
}

async function idempotencyHash(slug, source, order) {
  return sha256hex(JSON.stringify({
    slug, source, sede_id: order.sede_id, items: order.items,
    delivery_mode: order.delivery_mode, payment_method: order.payment_method, address: order.address, table_no: order.table_no,
    customer_name: order.customer_name, customer_phone: order.customer_phone, note: order.note,
    // La facturación forma parte del cuerpo: misma clave con datos fiscales
    // distintos es un conflicto, nunca una sobrescritura silenciosa.
    billing: order.billing || null,
  }));
}

async function insertPosOrder(env, values) {
  const day = dayOf(values.created_at);
  const billing = values.billing || {};
  return env.DB.batch([
    env.DB.prepare("INSERT INTO order_seq (slug, day, n) VALUES (?, ?, 1) ON CONFLICT(slug, day) DO UPDATE SET n = n + 1")
      .bind(values.slug, day),
    env.DB.prepare(
      "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, currency, " +
      "subtotal_cents, total_cents, items, customer_name, customer_phone, delivery_mode, address, table_no, note, " +
      "staff_id, idempotency_key, idempotency_hash, payment_method, " +
      "billing_document_type, billing_document_number, billing_email, billing_address) " +
      "VALUES (?, ?, ?, ?, ?, (SELECT n FROM order_seq WHERE slug = ? AND day = ?), ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      values.id, values.slug, values.sede_id, values.created_at, values.created_at, values.slug, day, values.source,
      values.currency, values.total_cents, values.total_cents, JSON.stringify(values.items), values.customer_name,
      values.customer_phone, values.delivery_mode, values.address, values.table_no, values.note, values.staff_id,
      values.idempotency_key, values.idempotency_hash, values.payment_method,
      billing.document_type || null, billing.document_number || null, billing.email || null, billing.address || null,
    ),
  ]);
}

async function createdResponse(env, slug, row) {
  return json({
    id: row.id, number: row.number == null ? null : Number(row.number), status: row.status,
    total_cents: Number(row.total_cents), currency: row.currency, payment_method: row.payment_method, order_token: await orderToken(env, slug, row.id),
  }, 201);
}

// Núcleo compartido: web pública (sin sesión) y caja (sesión con sede autorizada).
export async function createPosOrder(env, site, body, options = {}) {
  const source = options.source === "caja" || options.source === "mesero" ? options.source : "web";
  const order = parsePosOrder(body, { source });
  if (order.error) return error(order.error, order.status, order.campo ? { campo: order.campo } : {});
  if (order.delivery_mode !== "pickup") return error("solo_retiro", 400);
  const sede = await sedeById(env, site.slug, order.sede_id);
  if (!sede || !sede.activa) return error("sede_invalida", 400);
  if (source !== "web") {
    if (!options.session || !await authorizedForSede(env, site.slug, options.session, order.sede_id)) {
      return error("sin_permiso", 403);
    }
  }
  const priced = await pricePosItems(env, site.slug, order.items);
  if (priced.error) return error(priced.error, priced.status, priced.product_id ? { product_id: priced.product_id } : {});
  if (source === "web" && order.payment_method === "bendo" && !bendoAvailable(env)) {
    return error("bendo_no_disponible", 503);
  }
  const currency = await currencyOf(env, site.slug);
  const id = crypto.randomUUID(), now = Date.now();
  const hash = await idempotencyHash(site.slug, source, order);
  try {
    await insertPosOrder(env, {
      ...order, id, slug: site.slug, created_at: now, source, currency,
      total_cents: priced.total_cents, items: priced.lines,
      staff_id: source === "web" ? null : String(options.session.staff_id || ""),
      idempotency_hash: hash,
    });
  } catch {
    // Carrera o reintento: la clave ya existe. Igual resultado si el cuerpo coincide.
    const existing = await env.DB.prepare(`SELECT ${POS_COLUMNS}, idempotency_hash FROM pos_orders WHERE slug = ? AND idempotency_key = ?`)
      .bind(site.slug, order.idempotency_key).first();
    if (!existing) return error("pedido_no_creado", 502);
    if (existing.idempotency_hash !== hash) return error("idempotencia_conflicto", 409);
    return createdResponse(env, site.slug, existing);
  }
  const row = await posOrderRow(env, site.slug, id);
  return createdResponse(env, site.slug, row);
}

// Pedido público del menú: JSON, límite por IP y cuerpo acotado antes de parsear.
export async function createPublicPosOrder(request, env, ctx, site) {
  if (request.method !== "POST") return error("metodo_invalido", 405);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return error("content_type_invalido", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) return error("pedido_muy_grande", 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) return error("pedido_muy_grande", 413);
  let body;
  try { body = JSON.parse(raw); } catch { return error("pedido_invalido", 400); }
  const ip = request.headers.get("cf-connecting-ip") || "sin-ip";
  if (env.LOGIN_LIMITER && !(await env.LOGIN_LIMITER.limit({ key: `po:${site.slug}:${ip}` })).success) {
    return error("demasiados_pedidos", 429);
  }
  return createPosOrder(env, site, body, { source: "web" });
}

export async function publicSedes(env, slug) {
  return json({ sedes: await sedesFor(env, slug) });
}

// Último intento de pago del pedido. El recibo necesita distinguir un cobro
// rechazado de uno en verificación (`unknown`) sin exponer datos del proveedor.
async function latestPosPayment(env, slug, orderId) {
  try {
    return await env.DB.prepare(
      "SELECT status, message FROM pos_payments WHERE slug = ? AND order_id = ? " +
      "ORDER BY updated_at DESC, rowid DESC LIMIT 1",
    ).bind(slug, orderId).first();
  } catch { return null; }
}

// Estado de pago público derivado del pedido y su último intento. `unknown`
// (timeout de la pasarela de tarjeta) nunca se degrada a rechazo; un intento fallido
// antes de cobrar es el único caso reintentable sin riesgo de duplicar el cobro.
function publicPaymentStatus(row, payment) {
  if (row.status === "paid") return "paid";
  if (row.status === "rejected") return "rejected";
  const status = payment?.status;
  if (status === "paid") return "paid";
  if (status === "unknown") return "unknown";
  if (status === "rejected") return "rejected";
  if (status === "failed") return "failed";
  return "pending";
}

// Textos públicos neutrales: con tarjeta (Bendo) nunca se nombra al proveedor ni
// se afirma un rechazo cuando el estado aún es desconocido.
function publicPaymentMessage(paymentStatus, method) {
  const card = method === "bendo";
  if (paymentStatus === "unknown") {
    return card
      ? "Estamos verificando el pago con tarjeta. No vuelvas a pagar."
      : "Estamos verificando el pago. No vuelvas a pagar.";
  }
  if (paymentStatus === "failed") {
    return card ? "No se completó el pago con tarjeta." : "No se completó el pago.";
  }
  if (paymentStatus === "rejected") {
    if (card) return "El pago con tarjeta no fue aprobado.";
    return "El pedido fue rechazado.";
  }
  return "";
}

// Estado del comprador autenticado solo por token. Devuelve el resumen que
// necesita la pantalla de gracias (líneas, sede, total, método y estado de pago)
// y NUNCA datos fiscales, teléfono, correo, dirección del cliente ni notas internas.
export async function getPosOrderStatus(env, site, encodedId, token) {
  const id = decodedId(encodedId);
  if (!id || typeof token !== "string" || !token) return error("pedido_no_existe", 404);
  const row = await posOrderRow(env, site.slug, id);
  if (!row) return error("pedido_no_existe", 404);
  const expected = await orderToken(env, site.slug, id);
  if (!timingEqual(token, expected)) return error("pedido_no_existe", 404);
  const sede = await sedeById(env, site.slug, row.sede_id);
  const payment = row.status === "paid" || row.status === "rejected"
    ? null : await latestPosPayment(env, site.slug, row.id);
  const paymentStatus = publicPaymentStatus(row, payment);
  const retryable = row.payment_method === "bendo" &&
    payment?.status === "failed" && row.status !== "paid" && row.status !== "rejected";
  const paymentMessage = publicPaymentMessage(paymentStatus, row.payment_method || "cash");
  return json({
    id: row.id, number: row.number == null ? null : Number(row.number),
    status: row.ready_at != null ? "ready" : row.status,
    total_cents: Number(row.total_cents), currency: row.currency, sede_id: row.sede_id,
    sede: sede ? { id: sede.id, nombre: sede.nombre, direccion: sede.direccion } : null,
    payment_method: row.payment_method || "cash", payment_status: paymentStatus,
    ...(paymentMessage ? { payment_message: paymentMessage } : {}), retryable,
    created_at: Number(row.created_at),
    paid_at: row.paid_at == null ? null : Number(row.paid_at),
    ready_at: row.ready_at == null ? null : Number(row.ready_at),
    items: publicLines(row.items),
  }, 200, { "referrer-policy": "no-referrer" });
}

// Snapshot público de líneas: nombre, cantidad e importes en centavos. Se
// descartan campos internos y cualquier dato del comprador.
function publicLines(raw) {
  let items = [];
  try { items = JSON.parse(raw); } catch { /* snapshot roto: resumen vacío */ }
  if (!Array.isArray(items)) return [];
  return items.filter(isObject).map(item => {
    const qty = Number(item.qty) || 0, unit = Number(item.unit_cents) || 0;
    return {
      name: typeof item.name === "string" ? item.name : "",
      qty, unit_cents: unit, subtotal_cents: Number(item.subtotal_cents) || qty * unit,
      ...(item.variant_id == null ? {} : { variant_id: String(item.variant_id) }),
      ...(item.note == null ? {} : { note: String(item.note).slice(0, 200) }),
    };
  });
}

/* ── Acciones del operador ───────────────────────────────────────────────── */

export async function posOrderForAction(env, site, session, encodedId) {
  const id = decodedId(encodedId);
  if (!id) return { response: error("pedido_no_existe", 404) };
  const row = await posOrderRow(env, site.slug, id);
  if (!row) return { response: error("pedido_no_existe", 404) };
  if (!await authorizedForSede(env, site.slug, session, row.sede_id)) return { response: error("sin_permiso", 403) };
  return { order: row };
}

export async function confirmPosOrder(env, site, session, encodedId) {
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.status === "confirmed" || order.status === "paid") return json({ order: posOrderData(order) });
  if (order.status !== "pending") return error("estado_invalido", 409);
  // Se revalida disponibilidad; el precio de la orden ya está congelado.
  const priced = await pricePosItems(env, site.slug, JSON.parse(order.items).map(line => ({
    product_id: line.product_id, qty: line.qty, variant_id: line.variant_id,
  })));
  if (priced.error) return error(priced.error, priced.status, priced.product_id ? { product_id: priced.product_id } : {});
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE pos_orders SET status = 'confirmed', status_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status = 'pending'",
  ).bind(now, now, site.slug, order.id).run();
  return json({ order: posOrderData(await posOrderRow(env, site.slug, order.id)) });
}

export async function rejectPosOrder(env, site, session, encodedId) {
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.status === "rejected") return json({ order: posOrderData(order) });
  if (order.status === "paid") return error("estado_invalido", 409);
  const now = Date.now();
  const changed = await env.DB.prepare(
    "UPDATE pos_orders SET status = 'rejected', status_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status IN ('pending', 'confirmed')",
  ).bind(now, now, site.slug, order.id).run();
  if (!changed.meta.changes) {
    const current = await posOrderRow(env, site.slug, order.id);
    return current?.status === "rejected" ? json({ order: posOrderData(current) }) : error("estado_invalido", 409);
  }
  return json({ order: posOrderData(await posOrderRow(env, site.slug, order.id)) });
}

export async function editPosOrder(env, site, session, encodedId, body) {
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.status !== "pending") return error("estado_invalido", 409);
  if (!isObject(body)) return error("pedido_invalido", 400);
  const has = key => Object.hasOwn(body, key);
  if (!has("items") && !has("table_no") && !has("note") && !has("client_name")) return error("pedido_invalido", 400);
  let lines = JSON.parse(order.items);
  if (has("items")) {
    const parsed = parsePosOrder({ sede_id: order.sede_id, items: body.items, idempotency_key: order.idempotency_key });
    if (parsed.error) return error(parsed.error, 400);
    const priced = await pricePosItems(env, site.slug, parsed.items);
    if (priced.error) return error(priced.error, priced.status, priced.product_id ? { product_id: priced.product_id } : {});
    lines = priced.lines;
  }
  const table = has("table_no") ? (body.table_no == null || body.table_no === "" ? null : String(body.table_no).slice(0, 10)) : order.table_no;
  const note = has("note") ? (body.note == null || body.note === "" ? null : String(body.note).slice(0, 200)) : order.note;
  const name = has("client_name") ? String(body.client_name ?? "").slice(0, 120) : order.customer_name;
  const total = lines.reduce((sum, line) => sum + line.unit_cents * line.qty, 0);
  const now = Date.now();
  const changed = await env.DB.prepare(
    "UPDATE pos_orders SET items = ?, subtotal_cents = ?, total_cents = ?, table_no = ?, note = ?, customer_name = ?, " +
    "updated_at = ? WHERE slug = ? AND id = ? AND status = 'pending'",
  ).bind(JSON.stringify(lines), total, total, table, note, name, now, site.slug, order.id).run();
  if (!changed.meta.changes) return error("estado_invalido", 409);
  return json({ order: posOrderData(await posOrderRow(env, site.slug, order.id)) });
}

export async function listPosOrders(env, site, session, request) {
  const query = new URL(request.url).searchParams;
  const sedeId = query.get("sede_id");
  const status = query.get("status") || "all";
  const limit = integer(query.get("limit"), 30, 50), offset = integer(query.get("offset"), 0, 1_000_000);
  if (limit == null || offset == null) return error("paginacion_invalida", 400);
  if (!["all", "open", ...POS_STATUS].includes(status)) return error("estado_invalido", 400);
  if (sedeId && !SEDE_ID_RE.test(sedeId)) return error("sede_invalida", 400);
  if (sedeId && !await authorizedForSede(env, site.slug, session, sedeId)) return error("sin_permiso", 403);
  const allowed = await sedesAllowed(env, site.slug, session);
  const clauses = ["slug = ?"], values = [site.slug];
  if (sedeId) { clauses.push("sede_id = ?"); values.push(sedeId); }
  if (status === "open") clauses.push("status IN ('pending', 'confirmed')");
  else if (status === "ready") clauses.push("status = 'paid' AND ready_at IS NOT NULL");
  else if (status !== "all") { clauses.push("status = ?"); values.push(status); }
  if (allowed !== null && !sedeId) {
    const ids = [...allowed].filter(id => SEDE_ID_RE.test(id));
    if (!ids.length) return json({ orders: [] });
    clauses.push(`sede_id IN (${ids.map(() => "?").join(", ")})`);
    values.push(...ids);
  }
  const rows = await env.DB.prepare(
    `SELECT ${POS_COLUMNS} FROM pos_orders WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...values, limit, offset).all();
  return json({ orders: (rows.results || []).map(row => posOrderData(row)) });
}

/* ── Pagos: efectivo confirmado por operador y tarjeta (Bendo) ────────────── */

export async function posPaymentByKey(env, slug, orderId, key) {
  return env.DB.prepare("SELECT * FROM pos_payments WHERE slug = ? AND order_id = ? AND idempotency_key = ?")
    .bind(slug, orderId, key).first();
}

export async function posPaymentByRef(env, slug, ref) {
  return env.DB.prepare("SELECT * FROM pos_payments WHERE slug = ? AND provider_ref = ?").bind(slug, ref).first();
}

function paymentRef() {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return [...crypto.getRandomValues(new Uint8Array(15))].map(byte => alphabet[byte % alphabet.length]).join("");
}

// Guarda el intento ANTES de llamar al proveedor (idempotente por clave).
export async function createPaymentAttempt(env, slug, order, key, provider) {
  const now = Date.now();
  const existing = await posPaymentByKey(env, slug, order.id, key);
  if (existing) return existing.provider === provider ? existing : null;
  const payment = {
    id: crypto.randomUUID(), ref: paymentRef(), provider,
    amount_cents: Number(order.total_cents), currency: order.currency,
  };
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
    "provider_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?)",
  ).bind(payment.id, slug, order.id, provider, key, payment.amount_cents, payment.currency, payment.ref, now, now).run();
  if (!inserted.meta.changes) {
    const raced = await posPaymentByKey(env, slug, order.id, key);
    return raced && raced.provider === provider ? raced : null;
  }
  return posPaymentByKey(env, slug, order.id, key);
}

export async function setPaymentPending(env, slug, paymentId, url) {
  await env.DB.prepare(
    "UPDATE pos_payments SET status = 'pending', url = ?, updated_at = ? WHERE slug = ? AND id = ? AND status IN ('created', 'pending')",
  ).bind(url, Date.now(), slug, paymentId).run();
}

export async function failPayment(env, slug, paymentId, message) {
  await env.DB.prepare(
    "UPDATE pos_payments SET status = 'failed', message = ?, attempts = attempts + 1, updated_at = ? WHERE slug = ? AND id = ? AND status <> 'paid'",
  ).bind(String(message || "").slice(0, 200), Date.now(), slug, paymentId).run();
}

export async function attachProviderId(env, slug, payment, providerId) {
  if (payment.provider_id) return payment.provider_id === providerId;
  try {
    await env.DB.prepare(
      "UPDATE pos_payments SET provider_id = ?, updated_at = ? WHERE slug = ? AND id = ? AND provider_id IS NULL",
    ).bind(String(providerId), Date.now(), slug, payment.id).run();
    return true;
  } catch { return false; } // choque del índice único: otro pago ya usa ese id
}

export async function markPaymentUnknown(env, slug, paymentId, message) {
  await env.DB.prepare(
    "UPDATE pos_payments SET status = 'unknown', message = ?, attempts = attempts + 1, updated_at = ? " +
    "WHERE slug = ? AND id = ? AND status <> 'paid'",
  ).bind(String(message || "").slice(0, 200), Date.now(), slug, paymentId).run();
}

// Snapshot de líneas cobradas: una fila por ítem, categoría congelada y clave
// natural idempotente. Se escribe en el MISMO batch que marca la orden pagada.
function snapshotStatements(env, slug, order, now) {
  let items = [];
  try { items = JSON.parse(order.items); } catch { /* snapshot roto: sin líneas, el reporte lo delata */ }
  if (!Array.isArray(items)) items = [];
  return items.map((item, index) => {
    if (!item || typeof item !== "object") return null;
    const qty = Number(item.qty), unit = Number(item.unit_cents);
    if (!Number.isInteger(qty) || qty <= 0 || !Number.isInteger(unit) || unit < 0) return null;
    const category = REPORT_CATEGORIES.includes(item.report_category) ? item.report_category : "tradicional";
    return env.DB.prepare(
      "INSERT OR IGNORE INTO pos_order_lines (slug, order_id, line_index, report_category, product_id, variant_id, " +
      "name, qty, unit_cents, line_total_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      slug, order.id, index, category,
      item.product_id == null ? null : String(item.product_id),
      item.variant_id == null ? null : String(item.variant_id),
      item.name == null ? null : String(item.name),
      qty, unit, qty * unit, now,
    );
  }).filter(Boolean);
}

// Datos fiscales capturados en el pedido web para el adaptador de facturación.
// Se entregan solo al borrador de factura; no forman parte de respuestas públicas.
function invoiceCustomerOf(row) {
  const number = typeof row?.billing_document_number === "string" ? row.billing_document_number : "";
  const email = typeof row?.billing_email === "string" ? row.billing_email : "";
  if (!number && !email) return null;
  return {
    identification: number,
    identification_type: row.billing_document_type === "ruc" ? "RUC" : "CEDULA",
    name: row.customer_name || "",
    email,
    address: row.billing_address || "",
    phone: row.customer_phone || "",
  };
}

// Factura derivada: se prepara después de persistir el cobro y NUNCA revierte,
// bloquea ni pierde la orden o la comanda. Sin configuración fiscal queda `manual`.
async function afterPaid(env, slug, row) {
  if (!row) return;
  try {
    const order = { ...posOrderData(row), invoice_customer: invoiceCustomerOf(row) };
    const prepared = await prepareInvoice(env, { slug, order });
    if (prepared.ok && prepared.invoice?.status === "pending") {
      await submitInvoice(env, { slug, orderId: order.id });
    }
  } catch { /* la factura es un artefacto derivado */ }
}

// Aprobado: pago, orden, comanda y snapshot de líneas en un solo batch.
export async function settlePaymentApproved(env, slug, order, payment, details = {}) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pos_payments SET status = 'paid', provider_id = COALESCE(provider_id, ?), authorization = ?, message = NULL, " +
      "paid_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status <> 'paid'",
    ).bind(details.providerId == null ? null : String(details.providerId), details.authorization == null ? null : String(details.authorization),
      now, now, slug, payment.id),
    // Tarjeta confirmada sin turno abierto: queda sin turno y el próximo que se
    // abra en la sede la asigna (0012). Si ya hay turno, entra en el mismo batch.
    env.DB.prepare(
      "UPDATE pos_payments SET shift_id = (SELECT id FROM pos_shifts WHERE slug = ? AND sede_id = ? AND status = 'open') " +
      "WHERE slug = ? AND id = ? AND shift_id IS NULL",
    ).bind(slug, order.sede_id, slug, payment.id),
    env.DB.prepare(
      "UPDATE pos_orders SET status = 'paid', status_at = ?, paid_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status IN ('pending', 'confirmed')",
    ).bind(now, now, now, slug, order.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO pos_comandas (slug, order_id, created_at, print_count) VALUES (?, ?, ?, 0)",
    ).bind(slug, order.id, now),
    ...snapshotStatements(env, slug, order, now),
  ]);
  const paid = await posOrderRow(env, slug, order.id);
  await afterPaid(env, slug, paid);
  return paid;
}

export async function settlePaymentRejected(env, slug, order, payment, message) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE pos_payments SET status = 'rejected', message = ?, updated_at = ? WHERE slug = ? AND id = ? AND status <> 'paid'",
    ).bind(String(message || "").slice(0, 200), now, slug, payment.id),
    env.DB.prepare(
      "UPDATE pos_orders SET status = 'rejected', status_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status IN ('pending', 'confirmed')",
    ).bind(now, now, slug, order.id),
  ]);
  return posOrderRow(env, slug, order.id);
}

// Pago manual (efectivo o transferencia): lo confirma un operador autorizado
// por sede; una sola comanda por orden y respuesta idempotente por clave.
export async function payCash(env, site, session, encodedId, body) {
  return payManual(env, site, session, encodedId, body, "cash");
}

// Transferencia: misma semántica que efectivo. La caja verifica el comprobante
// por fuera del sistema y confirma aquí; nunca se asume pago por el comprobante.
export async function payTransfer(env, site, session, encodedId, body) {
  return payManual(env, site, session, encodedId, body, "transfer");
}

async function payManual(env, site, session, encodedId, body, provider) {
  const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!IDEM_RE.test(key)) return error("idempotency_key_requerida", 400);
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  // El método de cobro debe coincidir con el elegido por el comprador.
  if (order.payment_method !== provider) return error("metodo_pago_invalido", 409);
  const existing = await posPaymentByKey(env, site.slug, order.id, key);
  if (existing) {
    if (existing.provider !== provider) return error("idempotencia_conflicto", 409);
    if (order.status === "paid") {
      await afterPaid(env, site.slug, order);
      return paidManualResponse(env, site, order, existing);
    }
  }
  if (order.status === "paid") return error("orden_ya_pagada", 409);
  if (order.status === "rejected") return error("estado_invalido", 409);
  // Caja cerrada no cobra: efectivo y transferencia exigen turno abierto en la
  // sede del pedido. La tarjeta (Bendo) sí se confirma siempre y queda sin turno.
  const shift = await openShiftFor(env, site.slug, order.sede_id);
  if (!shift) return error("caja_cerrada", 409);
  const now = Date.now(), paymentId = crypto.randomUUID();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE pos_orders SET status = 'paid', status_at = ?, paid_at = ?, updated_at = ? " +
      "WHERE slug = ? AND id = ? AND status IN ('pending', 'confirmed') " +
      // El turno se revalida en el mismo batch: si se cerró entre la lectura y
      // este INSERT, no se cobra y la caja responde 409 caja_cerrada.
      "AND EXISTS (SELECT 1 FROM pos_shifts WHERE slug = ? AND sede_id = ? AND status = 'open')",
    ).bind(now, now, now, site.slug, order.id, site.slug, order.sede_id),
    env.DB.prepare(
      "INSERT INTO pos_payments (id, slug, order_id, provider, idempotency_key, status, amount_cents, currency, " +
      "provider_ref, created_at, updated_at, paid_at, shift_id) " +
      "SELECT ?, ?, ?, ?, ?, 'paid', ?, ?, NULL, ?, ?, ?, ? " +
      "WHERE EXISTS (SELECT 1 FROM pos_orders WHERE slug = ? AND id = ? AND status = 'paid' AND paid_at = ?)",
    ).bind(paymentId, site.slug, order.id, provider, key, Number(order.total_cents), order.currency, now, now, now,
      shift.id, site.slug, order.id, now),
    env.DB.prepare("INSERT OR IGNORE INTO pos_comandas (slug, order_id, created_at, print_count) VALUES (?, ?, ?, 0)")
      .bind(site.slug, order.id, now),
    ...snapshotStatements(env, site.slug, order, now),
  ]);
  const payment = await posPaymentByKey(env, site.slug, order.id, key);
  if (!results[0]?.meta?.changes) {
    const current = await posOrderRow(env, site.slug, order.id);
    if (current?.status === "paid" && payment) {
      await afterPaid(env, site.slug, current);
      return paidManualResponse(env, site, current, payment);
    }
    // El turno pudo cerrarse entre la lectura y el batch: no se cobró nada.
    if (!await openShiftFor(env, site.slug, order.sede_id)) return error("caja_cerrada", 409);
    return error("estado_invalido", 409);
  }
  const paid = await posOrderRow(env, site.slug, order.id);
  await afterPaid(env, site.slug, paid);
  return paidManualResponse(env, site, paid, payment);
}

function paidManualResponse(env, site, order, payment) {
  return json({
    order: posOrderData(order),
    payment: { id: payment.id, provider: payment.provider, status: "paid", amount_cents: Number(payment.amount_cents) },
  });
}

// `paid` → `ready`: solo un operador autorizado de la sede, con marca de tiempo.
// Repetir la acción es idempotente. La comanda y la impresión siguen ligadas al
// cobro; este estado únicamente avisa que el pedido está listo para entregar.
export async function markOrderReady(env, site, session, encodedId) {
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.status !== "paid") return error("estado_invalido", 409);
  if (order.ready_at == null) {
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE pos_orders SET ready_at = ?, updated_at = ? WHERE slug = ? AND id = ? AND status = 'paid' AND ready_at IS NULL",
    ).bind(now, now, site.slug, order.id).run();
  }
  return json({ order: posOrderData(await posOrderRow(env, site.slug, order.id)) });
}

/* ── Cocina: solo pedidos pagados, filtrados por sede ────────────────────── */

export async function listKitchenOrders(env, site, session, request) {
  const query = new URL(request.url).searchParams;
  const sedeId = query.get("sede_id") || "";
  if (!SEDE_ID_RE.test(sedeId)) return error("sede_requerida", 400);
  if (!await authorizedForSede(env, site.slug, session, sedeId)) return error("sin_permiso", 403);
  const sinceRaw = query.get("since"), since = sinceRaw == null || sinceRaw === "" ? 0 : Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) return error("cursor_invalido", 400);
  const rows = await env.DB.prepare(
    `SELECT o.${POS_COLUMNS.replace(/, /g, ", o.")}, c.print_count, c.printed_at, c.created_at AS comanda_at ` +
    "FROM pos_orders o JOIN pos_comandas c ON c.slug = o.slug AND c.order_id = o.id " +
    "WHERE o.slug = ? AND o.sede_id = ? AND o.status = 'paid' AND c.created_at > ? ORDER BY c.created_at ASC LIMIT 50",
  ).bind(site.slug, sedeId, since).all();
  const orders = (rows.results || []).map(row => posOrderData(row));
  return json({ orders, next: orders.length ? orders[orders.length - 1].comanda_at : since });
}

// Acuse de impresión: la clave evita contar dos veces el mismo ticket.
export async function printKitchenOrder(env, site, session, encodedId, body) {
  const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!IDEM_RE.test(key)) return error("idempotency_key_requerida", 400);
  const found = await posOrderForAction(env, site, session, encodedId);
  if (found.response) return found.response;
  const order = found.order;
  if (order.status !== "paid") return error("estado_invalido", 409);
  const now = Date.now();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO pos_comanda_prints (slug, order_id, idempotency_key, printed_at) VALUES (?, ?, ?, ?)",
  ).bind(site.slug, order.id, key, now).run();
  if (inserted.meta.changes) {
    await env.DB.prepare(
      "UPDATE pos_comandas SET print_count = print_count + 1, printed_at = ? WHERE slug = ? AND order_id = ?",
    ).bind(now, site.slug, order.id).run();
  }
  const comanda = await env.DB.prepare(
    "SELECT print_count, printed_at FROM pos_comandas WHERE slug = ? AND order_id = ?",
  ).bind(site.slug, order.id).first();
  return json({
    order_id: order.id, print_count: Number(comanda?.print_count) || 0,
    printed_at: Number(comanda?.printed_at) || null,
  });
}
