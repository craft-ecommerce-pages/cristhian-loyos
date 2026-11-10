// Worker craft-loyalty: club de fidelización de los menús edge.
//   {slug}.craft-systems.com/club*  → llega por service binding desde craft-menus (host original intacto)
//   /admin/{slug}/*                 → API para craft-crm (Bearer ADMIN_TOKEN), vía workers.dev
// Estado del cliente final en D1 (env.DB); config del programa y del menú en KV (env.MENUS, solo lectura).
import { resolveSlug } from "../../worker/src/lib.js";
import { BIRTHDAY_PRIZE_ID, WINBACK_PRIZE_ID, normalizeConfig, parseCardCode } from "./contract.js";
import { handleApi, handleAdmin } from "./api.js";
import { renderPage } from "./page.js";
import { walletNotify } from "./wallet.js";

const DAY = 86_400_000;
const CAP = 500;                                 // tope de destinatarios por trabajo y por corrida
const EC_TZ = "America/Guayaquil";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);

    const slug = await resolveSlug(url.hostname, env);
    const [loyRaw, menuRaw] = slug
      ? await Promise.all([env.MENUS.get(`${slug}:loyalty`, "json"), env.MENUS.get(`${slug}:config`, "json")])
      : [];
    const cfg = normalizeConfig(loyRaw);
    if (!slug || !cfg.enabled) return new Response("No existe", { status: 404 });

    const site = { slug, cfg, menuCfg: menuRaw || {} };
    if (url.pathname.startsWith("/club/api/")) return handleApi(request, env, ctx, site);
    if (url.pathname.startsWith("/club/t/")) return cardPass(url, site);
    if (url.pathname === "/club" || url.pathname === "/club/")
      return new Response(renderPage(site.menuCfg, cfg), {
        headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
      });
    return new Response("No existe", { status: 404 });
  },
  // Sin esta referencia el runtime ignora el cron: el `scheduled` suelto no es handler.
  scheduled,
};

// Tarjeta del cliente: el QR del pase (Wallet o página del club) abre esta página. Es pública y no
// consulta ni revela datos: solo confirma que la tarjeta es de este local y ofrece volver al club.
function cardPass(url, site) {
  if (!parseCardCode(url.pathname)) return new Response("No existe", { status: 404 });
  const store = typeof site.menuCfg.store_name === "string" && site.menuCfg.store_name.trim()
      ? site.menuCfg.store_name.trim()
      : "tu local",
    name = escapeHtml(store),
    primary = /^#[0-9a-f]{6}$/i.test(site.menuCfg.theme_primary) ? site.menuCfg.theme_primary : "#111111";
  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Tu tarjeta · ${name}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#111;text-align:center;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:26rem}
h1{margin:0 0 .75rem;font-size:1.35rem}
p{margin:0 0 1.75rem;color:#333}
a{display:block;padding:1rem 1.25rem;border-radius:999px;background:${primary};color:#fff;text-decoration:none;font-weight:600}
</style>
</head>
<body>
<main>
<h1>${name}</h1>
<p>Esta es tu tarjeta de ${name}. Muéstrala en caja para sumar tu sello.</p>
<a href="/club">Abrir mi club</a>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache", "x-robots-tag": "noindex" },
  });
}
const escapeHtml = value =>
  String(value).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

// Cron diario (09:00 Ecuador): recordatorio de vencimiento, regalo de cumpleaños y recuperación de
// inactivos. Cada trabajo tiene su propio tope y es idempotente; un fallo no detiene a los demás.
export async function scheduled(_controller, env, _ctx) {
  const now = Date.now();
  await job("recordatorios", () => remindExpiring(env, now));
  await job("cumpleaños", () => giftBirthdays(env, now));
  await job("inactivos", () => giftInactive(env, now));
}

async function job(label, run) {
  try {
    await run();
  } catch (cause) {
    console.error(`Club: falló el cron de ${label}`, cause);
  }
}

// Se marca incluso si Wallet falla para no insistir al cliente.
async function remindExpiring(env, now) {
  const until = now + 5 * DAY;
  const rows = await env.DB.prepare(
    `SELECT r.id, r.slug, r.phone, r.label, r.expires_at
    FROM rewards r JOIN customers c ON c.slug = r.slug AND c.phone = r.phone
    WHERE r.status = 'active' AND r.expires_at > ? AND r.expires_at <= ?
      AND r.reminded_at IS NULL AND c.wallet_saved = 1
    ORDER BY r.expires_at, r.id LIMIT ${CAP}`,
  )
    .bind(now, until)
    .all();
  for (const reward of rows.results) {
    try {
      const menu = (await env.MENUS.get(`${reward.slug}:config`, "json")) || {};
      await walletNotify(env, reward.slug, [reward.phone], {
        title: "Tu premio vence pronto",
        body: `“${reward.label}” vence el ${ecDayMonth(reward.expires_at)}. Pásalo a canjear en ${
          typeof menu.store_name === "string" ? menu.store_name : "tu local"
        }.`,
      });
    } catch (cause) {
      console.error("Club: no se pudo enviar recordatorio", cause);
    }
    await env.DB.prepare("UPDATE rewards SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL").bind(now, reward.id).run();
  }
}

// Regalo de cumpleaños: clientes cuyo MM-DD cae en los próximos 7 días (incluye hoy) y que no
// recibieron el regalo este año calendario de Ecuador.
async function giftBirthdays(env, now) {
  const monthDays = Array.from({ length: 7 }, (_, i) => ecMonthDay(now + i * DAY)),
    yearStart = ecYearStart(now),
    configs = new Map();
  const rows = await env.DB.prepare(
    `SELECT c.slug, c.phone, c.wallet_saved FROM customers c
     WHERE c.birthday IN (${monthDays.map(() => "?").join(",")})
       AND NOT EXISTS (SELECT 1 FROM rewards r WHERE r.slug = c.slug AND r.phone = c.phone
             AND r.source = 'birthday' AND r.created_at >= ?)
     ORDER BY c.slug, c.phone LIMIT ${CAP}`,
  )
    .bind(...monthDays, yearStart)
    .all();
  for (const row of rows.results) {
    const cfg = await loyaltyConfig(env, row.slug, configs);
    if (!cfg.birthday.enabled) continue;
    const expiresAt = now + cfg.birthday.expires_days * DAY,
      created = await grantGift(env, {
        slug: row.slug,
        phone: row.phone,
        source: "birthday",
        prizeId: BIRTHDAY_PRIZE_ID,
        label: cfg.birthday.label,
        now,
        expiresAt,
        since: yearStart,
      });
    if (!created || !Number(row.wallet_saved)) continue;
    await walletNotify(env, row.slug, [row.phone], {
      title: "🎂 Se acerca tu cumpleaños",
      body: `Te regalamos ${cfg.birthday.label}. Válido hasta ${ecDayMonth(expiresAt)}`,
    });
  }
}

// Recuperación de inactivos: visitó al menos una vez, lleva `days` días sin jugar y no recibió
// otro regalo de este tipo desde esa última visita (una vez por período de inactividad).
async function giftInactive(env, now) {
  const configs = new Map(),
    minInactive = 14 * DAY; // `winback.days` nunca baja de 14; el SQL filtra el mínimo global
  const rows = await env.DB.prepare(
    `SELECT c.slug, c.phone, c.wallet_saved, c.last_play_at FROM customers c
     WHERE c.visits >= 1 AND c.last_play_at IS NOT NULL AND c.last_play_at < ?
       AND NOT EXISTS (SELECT 1 FROM rewards r WHERE r.slug = c.slug AND r.phone = c.phone
             AND r.source = 'winback' AND r.created_at >= c.last_play_at)
     ORDER BY c.last_play_at LIMIT ${CAP}`,
  )
    .bind(now - minInactive)
    .all();
  for (const row of rows.results) {
    const cfg = await loyaltyConfig(env, row.slug, configs);
    if (!cfg.winback.enabled || Number(row.last_play_at) > now - cfg.winback.days * DAY) continue;
    const expiresAt = now + cfg.winback.expires_days * DAY,
      created = await grantGift(env, {
        slug: row.slug,
        phone: row.phone,
        source: "winback",
        prizeId: WINBACK_PRIZE_ID,
        label: cfg.winback.label,
        now,
        expiresAt,
        since: Number(row.last_play_at),
      });
    if (!created || !Number(row.wallet_saved)) continue;
    await walletNotify(env, row.slug, [row.phone], {
      title: "Te extrañamos 👋",
      body: `Vuelve y te regalamos ${cfg.winback.label}`,
    });
  }
}

// Inserta el premio solo si el cliente no tiene uno del mismo tipo desde `since` (carreras incluidas).
async function grantGift(env, { slug, phone, source, prizeId, label, now, expiresAt, since }) {
  const inserted = await env.DB.prepare(
    `INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at,expires_at)
     SELECT ?,?,?,?,?,?,?,?
     WHERE NOT EXISTS (SELECT 1 FROM rewards WHERE slug = ? AND phone = ? AND source = ? AND created_at >= ?)`,
  )
    .bind(crypto.randomUUID(), slug, phone, prizeId, label, source, now, expiresAt, slug, phone, source, since)
    .run();
  return inserted.meta.changes > 0;
}

async function loyaltyConfig(env, slug, cache) {
  if (!cache.has(slug)) cache.set(slug, normalizeConfig(await env.MENUS.get(`${slug}:loyalty`, "json")));
  return cache.get(slug);
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: EC_TZ, month: "2-digit", day: "2-digit" });
function ecMonthDay(ms) {
  const parts = Object.fromEntries(MONTH_DAY.formatToParts(new Date(Number(ms))).map(x => [x.type, x.value]));
  return `${parts.month}-${parts.day}`;
}

// Ecuador es UTC-5 fijo: el 1 de enero local son las 05:00 UTC.
const YEAR = new Intl.DateTimeFormat("en-US", { timeZone: EC_TZ, year: "numeric" });
const ecYearStart = ms => Date.UTC(Number(YEAR.format(new Date(Number(ms)))), 0, 1, 5);

const ecDayMonth = ms => {
  const [month, day] = ecMonthDay(ms).split("-");
  return `${day}/${month}`;
};
