// Reportes de ventas: solo órdenes POS cobradas, fechas de Ecuador y montos en centavos.
// Lee el snapshot congelado de `pos_order_lines` (0008) que POS escribe al confirmar el pago.
// Sin floats: toda suma se hace en SQL sobre INTEGER y se devuelve como entero.
import { error, json, TZ_OFFSET_MS } from "./contract.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
// Categorías comerciales del snapshot. Las tres primeras son las que pide el cliente
// en la vista pública; `postres` se incluye para que la conciliación sea exacta.
const CATEGORIES = ["sushi", "fastfood", "tradicional", "postres"];
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
  const query = new URL(request.url).searchParams;
  const range = salesRange(query.get("from"), query.get("to"));
  if (!range) return error("fechas_invalidas", 400);
  const sede = (query.get("sede_id") || "").trim();
  if (sede && !SEDE_ID.test(sede)) return error("sede_invalida", 400);

  // Una orden cuenta por su estado POS `paid` y su marca de cobro, no por la entrega.
  const where = ["o.slug = ?", "o.status = 'paid'", "o.paid_at IS NOT NULL", "o.paid_at >= ?", "o.paid_at < ?"];
  const values = [site.slug, range.start, range.end];
  if (sede) { where.push("o.sede_id = ?"); values.push(sede); }
  const filter = where.join(" AND ");

  const [groupRows, sedeRows, charged] = await Promise.all([
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
      `SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_cents), 0) AS total_cents FROM pos_orders o WHERE ${filter}`,
    ).bind(...values).first(),
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

  const totalCents = whole(charged?.total_cents);
  const groupsCents = groups.reduce((sum, group) => sum + group.total_cents, 0);
  return json({
    groups,
    total_cents: totalCents,
    by_sede: bySede,
    // >0 ⇒ hay cobros sin línea de snapshot (o líneas de más): POS debe completar el snapshot.
    unreconciled_cents: totalCents - groupsCents,
    orders: whole(charged?.orders),
  });
}

// D1/SQLite devuelve enteros; un valor ausente o no entero nunca se convierte a float.
function whole(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
