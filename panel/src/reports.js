// Reportes de ventas: solo órdenes POS cobradas, fechas de Ecuador y montos en centavos.
// Lee el snapshot congelado de `pos_order_lines` (0008) que POS escribe al confirmar el pago.
// Sin floats: toda suma se hace en SQL sobre INTEGER y se devuelve como entero.
import { error, json, TZ_OFFSET_MS } from "./contract.js";
import { peek } from "./catalog.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
// Categorías comerciales del snapshot. Las tres primeras son las que pide el cliente
// en la vista pública; `postres` se incluye para que la conciliación sea exacta.
const CATEGORIES = ["sushi", "fastfood", "tradicional", "postres"];
const CATEGORY_LABEL = { sushi: "Sushi", fastfood: "Fast food", tradicional: "Tradicional", postres: "Postres" };
const SEDE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// "YYYY-MM-DD" (día local Ecuador, UTC-5 sin horario de verano) → rango UTC [start, end).
export function salesRange(from, to) {
  const start = ecuadorDayStart(from), last = ecuadorDayStart(to);
  if (start == null || last == null) return null;
  const end = last + DAY_MS;
  if (end - start < DAY_MS || end - start > MAX_DAYS * DAY_MS) return null;
  return { start, end };
}

function ecuadorDayStart(day) {
  const match = typeof day === "string" ? DAY.exec(day) : null;
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), date = Number(match[3]);
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  // Rechaza fechas irreales (2026-02-30) sin depender de la zona horaria del runtime.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return utc - TZ_OFFSET_MS;
}

// GET /panel/api/reports/sales?from=YYYY-MM-DD&to=YYYY-MM-DD&sede_id=...
// El integrador la monta detrás de la sesión del panel (api.js).
export async function salesReport(request, env, site) {
  const parsed = parseQuery(request);
  if (parsed.error) return parsed.error;

  const data = await buildReport(env, site, parsed);
  // Las categorías siguen sumando la BASE de cada línea (sin IVA). El IVA cobrado
  // sale de la diferencia congelada por pedido (total_cents - subtotal_cents), no
  // de la config vigente: un pedido anterior al IVA aporta 0. Invariante:
  // Σ base de categorías + tax_cents == charged_cents == Σ total_cents incluidos.
  const groupsCents = data.groups.reduce((sum, group) => sum + group.total_cents, 0);
  return json({
    groups: data.groups,
    total_cents: data.charged_cents,
    tax_cents: data.tax_cents,
    charged_cents: data.charged_cents,
    base_cents: groupsCents,
    summary: {
      orders: data.orders,
      charged_cents: data.charged_cents,
      base_cents: groupsCents,
      tax_cents: data.tax_cents,
      avg_ticket_cents: data.orders > 0 ? Math.round(data.charged_cents / data.orders) : 0,
    },
    products: data.products,
    by_payment_method: data.by_payment_method,
    by_day: data.by_day,
    by_hour: data.by_hour,
    by_sede: data.by_sede,
    // >0 ⇒ hay cobros sin línea de snapshot (o líneas de más): POS debe completar el snapshot.
    unreconciled_cents: data.charged_cents - groupsCents - data.tax_cents,
    orders: data.orders,
  });
}

// GET /panel/api/reports/sales.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&sede_id=...
// Una fila por producto; totales al final. UTF-8 con BOM y separador `;` para Excel.
export async function salesReportCsv(request, env, site) {
  const parsed = parseQuery(request);
  if (parsed.error) return parsed.error;

  const data = await buildReport(env, site, parsed);
  const baseCents = data.groups.reduce((sum, group) => sum + group.total_cents, 0);
  const lines = [
    ["Producto", "Categoría", "Cantidad", "Ventas sin IVA"],
    ...data.products.map(product => [
      product.name,
      CATEGORY_LABEL[product.report_category] || product.report_category,
      product.qty,
      usd(product.base_cents),
    ]),
    ["Subtotal", "", "", usd(baseCents)],
    ["IVA", "", "", usd(data.tax_cents)],
    ["Total cobrado", "", "", usd(data.charged_cents)],
  ];
  const body = "\uFEFF" + lines.map(row => row.map(csvCell).join(";")).join("\r\n") + "\r\n";
  const from = parsed.from, to = parsed.to;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/csv;charset=utf-8",
      "content-disposition": `attachment; filename="ventas-${from}-${to}.csv"`,
      "cache-control": "no-store",
    },
  });
}

function parseQuery(request) {
  const query = new URL(request.url).searchParams;
  const from = query.get("from"), to = query.get("to");
  const range = salesRange(from, to);
  if (!range) return { error: error("fechas_invalidas", 400) };
  const sede = (query.get("sede_id") || "").trim();
  if (sede && !SEDE_ID.test(sede)) return { error: error("sede_invalida", 400) };
  return { from, to, range, sede };
}

// Agregaciones SQL sobre pedidos POS cobrados. Todos los importes son INTEGER.
async function buildReport(env, site, { range, sede }) {
  // Una orden cuenta por su estado POS `paid` y su marca de cobro, no por la entrega.
  const where = ["o.slug = ?", "o.status = 'paid'", "o.paid_at IS NOT NULL", "o.paid_at >= ?", "o.paid_at < ?"];
  const values = [site.slug, range.start, range.end];
  if (sede) { where.push("o.sede_id = ?"); values.push(sede); }
  const filter = where.join(" AND ");

  const [groupRows, sedeRows, charged, productRows, paymentRows, dayRows, hourRows] = await Promise.all([
    env.DB.prepare(
      "SELECT l.report_category AS category, COUNT(DISTINCT o.id) AS orders, " +
      "COALESCE(SUM(l.qty), 0) AS quantity, COALESCE(SUM(l.line_total_cents), 0) AS total_cents " +
      "FROM pos_orders o JOIN pos_order_lines l ON l.slug = o.slug AND l.order_id = o.id " +
      `WHERE ${filter} GROUP BY l.report_category`,
    ).bind(...values).all(),
    env.DB.prepare(
      "SELECT o.sede_id AS sede_id, COUNT(DISTINCT o.id) AS orders, " +
      "COALESCE(SUM(l.qty), 0) AS quantity, COALESCE(SUM(l.line_total_cents), 0) AS total_cents " +
      "FROM pos_orders o JOIN pos_order_lines l ON l.slug = o.slug AND l.order_id = o.id " +
      `WHERE ${filter} GROUP BY o.sede_id ORDER BY o.sede_id`,
    ).bind(...values).all(),
    env.DB.prepare(
      "SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS total_cents, " +
      "COALESCE(SUM(o.total_cents - o.subtotal_cents), 0) AS tax_cents FROM pos_orders o WHERE " + filter,
    ).bind(...values).first(),
    env.DB.prepare(
      // El nombre y la categoría se toman de la línea más reciente del producto
      // (bare columns junto al único MAX de SQLite).
      "SELECT l.product_id AS product_id, l.name AS name, l.report_category AS report_category, " +
      "MAX(l.created_at) AS latest_at, COALESCE(SUM(l.qty), 0) AS qty, " +
      "COALESCE(SUM(l.line_total_cents), 0) AS base_cents, COUNT(DISTINCT o.id) AS orders " +
      "FROM pos_orders o JOIN pos_order_lines l ON l.slug = o.slug AND l.order_id = o.id " +
      `WHERE ${filter} GROUP BY l.product_id ORDER BY qty DESC, base_cents DESC`,
    ).bind(...values).all(),
    env.DB.prepare(
      "SELECT COALESCE(o.payment_method, 'cash') AS method, COUNT(*) AS orders, " +
      "COALESCE(SUM(o.total_cents), 0) AS charged_cents FROM pos_orders o " +
      `WHERE ${filter} GROUP BY method ORDER BY charged_cents DESC, method`,
    ).bind(...values).all(),
    env.DB.prepare(
      "SELECT date((o.paid_at + " + TZ_OFFSET_MS + ") / 1000, 'unixepoch') AS day, " +
      "COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS charged_cents FROM pos_orders o " +
      `WHERE ${filter} GROUP BY day ORDER BY day`,
    ).bind(...values).all(),
    env.DB.prepare(
      "SELECT CAST(strftime('%H', (o.paid_at + " + TZ_OFFSET_MS + ") / 1000, 'unixepoch') AS INTEGER) AS hour, " +
      "COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS charged_cents FROM pos_orders o " +
      `WHERE ${filter} GROUP BY hour ORDER BY hour`,
    ).bind(...values).all(),
  ]);

  const found = new Map((groupRows.results || []).map(row => [row.category, row]));
  const groups = CATEGORIES.map(category => {
    const row = found.get(category);
    return {
      category,
      orders: whole(row?.orders),
      quantity: whole(row?.quantity),
      total_cents: whole(row?.total_cents),
    };
  });
  const bySede = (sedeRows.results || []).map(row => ({
    sede_id: row.sede_id == null ? null : String(row.sede_id),
    orders: whole(row.orders),
    quantity: whole(row.quantity),
    total_cents: whole(row.total_cents),
  }));

  // Categoría vigente de la carta (primer slug); null si el producto ya no existe.
  const menuCategories = await menuCategoryMap(env, site.slug);
  const products = (productRows.results || []).map(row => {
    const productId = row.product_id == null ? null : String(row.product_id);
    return {
      product_id: productId,
      name: row.name == null ? "Sin producto" : String(row.name),
      report_category: CATEGORIES.includes(row.report_category) ? row.report_category : "tradicional",
      menu_category: productId == null ? null : (menuCategories.get(productId) ?? null),
      qty: whole(row.qty),
      base_cents: whole(row.base_cents),
      orders: whole(row.orders),
    };
  }).sort((a, b) => b.qty - a.qty || b.base_cents - a.base_cents);

  const byPayment = (paymentRows.results || []).map(row => ({
    method: String(row.method || "cash"),
    orders: whole(row.orders),
    charged_cents: whole(row.charged_cents),
  }));
  const byDay = (dayRows.results || []).map(row => ({
    day: String(row.day || ""),
    orders: whole(row.orders),
    charged_cents: whole(row.charged_cents),
  }));
  // 24 horas completas: la UI dibuja barras estables aunque alguna hora no venda.
  const hourMap = new Map((hourRows.results || []).map(row => [whole(row.hour), row]));
  const byHour = Array.from({ length: 24 }, (_, hour) => {
    const row = hourMap.get(hour);
    return { hour, orders: whole(row?.orders), charged_cents: whole(row?.charged_cents) };
  });

  return {
    groups,
    by_sede: bySede,
    products,
    by_payment_method: byPayment,
    by_day: byDay,
    by_hour: byHour,
    orders: whole(charged?.orders),
    charged_cents: whole(charged?.total_cents),
    tax_cents: whole(charged?.tax_cents),
  };
}

async function menuCategoryMap(env, slug) {
  try {
    const { doc } = await peek(env, slug);
    const map = new Map();
    for (const product of Array.isArray(doc?.products) ? doc.products : []) {
      if (typeof product?.id !== "string") continue;
      map.set(product.id, Array.isArray(product.categories) && product.categories.length ? String(product.categories[0]) : null);
    }
    return map;
  } catch { return new Map(); }
}

function csvCell(value) {
  const text = String(value == null ? "" : value);
  return /[";\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// Centavos enteros → dólares con punto decimal y dos decimales (solo presentación).
function usd(cents) {
  return (whole(cents) / 100).toFixed(2);
}

// D1/SQLite devuelve enteros; un valor ausente o no entero nunca se convierte a float.
function whole(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
