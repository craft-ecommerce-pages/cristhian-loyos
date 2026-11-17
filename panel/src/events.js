// B: POST /panel/e (conteo público) + statsFor (lo usan api.js y admin.js).
import { EVENT_TYPES, TZ_OFFSET_MS, dayOf, noContent } from "./contract.js";

const DAY_MS = 86_400_000;
const MAX_DAYS = 90;          // ventana del panel: 1..90 días

// Conteo público: responde 204 SIEMPRE (método o body inválido también, sin revelar nada ni ensuciar la tabla).
// El slug sale del host (site), nunca del body; el día se agrupa en hora Ecuador (UTC-5).
export async function handleEvent(request, env, ctx, site) {
  try {
    if (request.method === "POST" && (Number(request.headers.get("content-length")) || 0) <= 1024) {
      // sendBeacon no deja elegir content-type (manda text/plain): se parsea igual.
      const body = JSON.parse(await request.text());
      if (body && EVENT_TYPES.includes(body.t)) {
        const [views, orders] = body.t === "view" ? [1, 0] : [0, 1];
        const write = env.DB.prepare(
          `INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, ?, ?)
           ON CONFLICT(slug, day) DO UPDATE SET views = views + excluded.views, orders = orders + excluded.orders`
        ).bind(site.slug, dayOf(Date.now()), views, orders).run();
        ctx.waitUntil(write.catch(() => {}));   // fuera del camino crítico: un fallo de D1 no rompe el menú
      }
    }
  } catch { /* un beacon perdido nunca es un error visible */ }
  return noContent();
}

// Stats del panel: días completos con ceros, totales y club (null si el club no responde).
// Visitas = events_daily (menú); pedidos y ventas = pos_orders cobrados (POS), no events_daily.
export async function statsFor(env, slug, days = 30) {
  const n = days == null ? 30 : Math.trunc(Number(days));
  const span = Number.isFinite(n) ? Math.min(MAX_DAYS, Math.max(1, n)) : 30;   // clamp 1..90
  const now = Date.now();
  const firstDay = dayOf(now - (span - 1) * DAY_MS);
  let rows = [];
  try {
    rows = (await env.DB.prepare(
      "SELECT day, views, orders FROM events_daily WHERE slug = ? AND day >= ? ORDER BY day"
    ).bind(slug, firstDay).all()).results || [];
  } catch { /* sin tabla/lectura fallida = serie en ceros, igual se responde */ }

  // Ventana de la serie en hora Ecuador → epoch UTC [start, end).
  const start = Date.parse(firstDay + "T00:00:00Z") - TZ_OFFSET_MS;
  const end = Date.parse(dayOf(now) + "T00:00:00Z") - TZ_OFFSET_MS + DAY_MS;
  let posRows = [];
  try {
    posRows = (await env.DB.prepare(
      "SELECT date((paid_at + ?) / 1000, 'unixepoch') AS day, COUNT(*) AS orders, " +
      "COALESCE(SUM(total_cents), 0) AS sales_cents FROM pos_orders " +
      "WHERE slug = ? AND status = 'paid' AND paid_at IS NOT NULL AND paid_at >= ? AND paid_at < ? GROUP BY day"
    ).bind(TZ_OFFSET_MS, slug, start, end).all()).results || [];
  } catch { /* sin tabla POS/lectura fallida = pedidos y ventas en cero */ }

  const byDay = new Map(rows.map(r => [r.day, r]));
  const posByDay = new Map(posRows.map(r => [r.day, r]));
  const list = [];
  let views = 0, orders = 0, salesCents = 0;
  for (let i = span - 1; i >= 0; i--) {
    const day = dayOf(now - i * DAY_MS);
    const row = byDay.get(day), pos = posByDay.get(day);
    const v = Number(row?.views) || 0, o = Number(pos?.orders) || 0, s = Number(pos?.sales_cents) || 0;
    views += v; orders += o; salesCents += s;
    list.push({ day, views: v, orders: o, sales_cents: s });
  }
  return {
    days: list,
    totals: { views, orders, sales_cents: salesCents },
    loyalty: await loyaltyStats(env, slug),
  };
}

// craft-loyalty /admin/{slug}/stats (Bearer LOYALTY_ADMIN_TOKEN) → {customers, plays}.
// Cualquier fallo (sin binding, red, 401/404, JSON roto) ⇒ null: el panel omite la tarjeta del club.
async function loyaltyStats(env, slug) {
  if (!env.LOYALTY || typeof env.LOYALTY.fetch !== "function" || !env.LOYALTY_ADMIN_TOKEN) return null;
  try {
    const res = await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/stats`, {
      headers: { authorization: `Bearer ${env.LOYALTY_ADMIN_TOKEN}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return { customers: Number(body?.customers) || 0, plays: Number(body?.plays) || 0 };
  } catch {
    return null;
  }
}
