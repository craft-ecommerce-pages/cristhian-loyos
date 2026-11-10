// A1: /admin/{slug}/* con Bearer ADMIN_TOKEN (owner, reset, stats). Ver PLAN.md.
import { FEATURE_SOURCES, error, json, noContent } from "./contract.js";
import { createResetToken, generatePassword, hashPassword, timingEqual } from "./auth.js";
import { statsFor } from "./events.js";
import { load, save, validateDoc } from "./catalog.js";

const encoder = new TextEncoder();

export async function handleAdmin(request, env, _ctx) {
  if (!validBearer(request.headers.get("authorization"), env.ADMIN_TOKEN)) return error("no_autorizado", 401);
  const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean), slug = parts[1] || "", tail = parts.slice(2);
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) return error("slug_invalido", 400);
  if (request.method === "POST" && tail.join("/") === "owner") return owner(request, env, slug);
  if (request.method === "DELETE" && tail.join("/") === "owner") return removeOwner(env, slug);
  if (request.method === "GET" && tail.join("/") === "owner") return ownerInfo(env, slug);
  if (request.method === "POST" && tail.join("/") === "reset") return reset(request, env, slug);
  if (request.method === "GET" && tail.join("/") === "stats") {
    const days = daysOf(url);
    return days == null ? error("dias_invalidos", 400) : json(await statsFor(env, slug, days));
  }
  if (tail.join("/") === "features") {
    if (request.method === "GET") return json(await featuresFor(env, slug));
    if (request.method === "PUT") return setFeatures(request, env, slug);
  }
  if (tail.join("/") === "catalog") {
    if (request.method === "GET") { const current = await load(env, slug); return json({ version: current.version, ...current.doc }); }
    if (request.method === "PUT") return catalog(request, env, slug);
  }
  return error("ruta_no_encontrada", 404);
}
async function catalog(request, env, slug) {
  const body = await readJson(request), check = validateDoc(body);
  if (!check.ok) return error("campo_invalido", 400, { campo: check.campo });
  const current = await load(env, slug);
  const saved = await save(env, slug, body, current.version);
  if (saved.error) return error(saved.error, saved.status);
  return json({ version: saved.version, products: saved.doc.products, categories: saved.doc.categories });
}

// Estado de las funciones por plan. Sin fila = habilitado (clubs viejos y Menú SaaS).
// Lo usan este archivo, api.js (#Me, 402) y el CRM vía `PUT /admin/{slug}/features`.
export async function featuresFor(env, slug) {
  const row = await env.DB.prepare("SELECT loyalty, source, updated_at FROM panel_features WHERE slug = ?").bind(slug).first();
  if (!row) return { loyalty: true, source: null, updated_at: null };
  return {
    loyalty: Number(row.loyalty) === 1,
    source: typeof row.source === "string" && row.source ? row.source : null,
    updated_at: Number(row.updated_at) || null,
  };
}
async function setFeatures(request, env, slug) {
  const body = await readJson(request);
  if (!body || typeof body.loyalty !== "boolean") return error("campo_invalido", 400, { campo: "loyalty" });
  const source = body.source == null ? null : body.source;
  if (source !== null && !FEATURE_SOURCES.includes(source)) return error("campo_invalido", 400, { campo: "source" });
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO panel_features (slug, loyalty, source, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET loyalty = excluded.loyalty, source = excluded.source, updated_at = excluded.updated_at`)
    .bind(slug, body.loyalty ? 1 : 0, source, now).run();
  if (!body.loyalty) await turnOffLoyalty(env, slug);
  return json(await featuresFor(env, slug));
}
// Apagar la función deja el club invisible: `enabled=false` y sin botón en config.club.
// Al reactivarla el dueño decide cuándo encenderla desde el panel.
async function turnOffLoyalty(env, slug) {
  const loyalty = await kvJson(env, `${slug}:loyalty`, {});
  if (loyalty.enabled !== false) await env.MENUS.put(`${slug}:loyalty`, JSON.stringify({ ...loyalty, enabled: false }));
  const config = await kvJson(env, `${slug}:config`, {});
  if ("club" in config) {
    delete config.club;
    await env.MENUS.put(`${slug}:config`, JSON.stringify(config));
  }
}
async function kvJson(env, key, fallback) {
  const value = await env.MENUS.get(key, "json");
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

async function owner(request, env, slug) {
  const body = await readJson(request), email = emailOf(body?.email);
  if (!email) return error("email_invalido", 400);
  const password = generatePassword(), now = Date.now();
  await env.DB.prepare(`INSERT INTO panel_users (slug, email, password_hash, pwd_ver, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, 1, 1, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash,
      pwd_ver = panel_users.pwd_ver + 1, must_change_password = 1, updated_at = excluded.updated_at`)
    .bind(slug, email, await hashPassword(password), now, now).run();
  return json({ email, password });
}
// Soporte desde el superadmin del CRM: quién es el dueño, sin datos de contraseña.
async function ownerInfo(env, slug) {
  const user = await env.DB.prepare("SELECT email, must_change_password, updated_at FROM panel_users WHERE slug = ?").bind(slug).first();
  return user ? json({ email: user.email, must_change_password: Boolean(user.must_change_password), updated_at: user.updated_at }) : error("sin_dueno", 404);
}
async function removeOwner(env, slug) {
  await env.DB.prepare("DELETE FROM panel_users WHERE slug = ?").bind(slug).run();
  return noContent();
}
async function reset(request, env, slug) {
  const user = await env.DB.prepare("SELECT email FROM panel_users WHERE slug = ?").bind(slug).first();
  if (!user) return error("sin_dueno", 404);
  const body = await readJson(request);
  // Host explícito del CRM, host de la petición o PANEL_PUBLIC_URL. Nunca un
  // dominio de Craft ni un subdominio inventado.
  const host = hostOf(body?.host) || hostOf(new URL(request.url).hostname) || publicHost(env.PANEL_PUBLIC_URL);
  if (!host) return error("host_requerido", 400);
  const token = await createResetToken(env, slug);
  return json({ url: `https://${host}/panel/reset?t=${encodeURIComponent(token.token)}`, expires_at: token.expires_at });
}
function validBearer(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || typeof token !== "string" || !token) return false;
  return timingEqual(encoder.encode(header.slice(7)), encoder.encode(token));
}
function hostOf(value) {
  if (typeof value !== "string" || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) return null;
  try { const url = new URL(`https://${value}`); return url.hostname === value.toLowerCase() ? url.hostname : null; } catch { return null; }
}
function publicHost(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return hostOf(new URL(value.trim()).hostname); } catch { return null; }
}
function emailOf(value) { const email = typeof value === "string" ? value.trim().toLowerCase() : ""; return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null; }
function daysOf(url) { const raw = url.searchParams.get("days"); const value = raw == null || raw === "" ? 30 : Number(raw); return Number.isInteger(value) && value >= 1 && value <= 366 ? value : null; }
async function readJson(request) { try { const value = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } }
