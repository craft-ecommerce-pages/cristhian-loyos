// Demo del panel y del Modo mesero en los menús demo (demo-{x} / {x}-demo), sin login.
// Todo corre en el navegador del visitante: la API real responde 403 en estos slugs, los datos viven en su
// localStorage y vuelven al estado inicial a los 30 min o con "Reiniciar demo". El menú público nunca cambia:
// el servidor solo LEE el catálogo (peek, sin bootstrap en D1) para armar la semilla.
import { error } from "./contract.js";
import { loyalty } from "./api.js";
import { peek } from "./catalog.js";
import { renderMeseroPage } from "./mesero.js";
import { jsonInline, renderPage } from "./page.js";

export const isDemo = slug => /^demo-|-demo$/.test(slug);

const CAJA_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Modo caja · demo</title></head><body style="font:16px/1.5 system-ui,sans-serif;padding:24px;max-width:480px;margin:auto">
<h1>Modo caja</h1><p>En la demo no se escanean tarjetas reales. En tu negocio, el mesero abre esta pantalla, escanea el QR de la
tarjeta del cliente y valida la visita o canjea el premio con su PIN.</p><p><a href="/panel">← Volver al panel</a></p></body></html>`;

export async function handleDemo(request, env, site, headers) {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/panel/api/")) return error("demo", 403);
  if (pathname === "/panel/caja") return new Response(CAJA_HTML, { headers });
  const inject = async html => {
    const script = `<script id="demoData">var __name=function(f){return f};window.__DEMO__=${jsonInline(await seed(env, site))};
(${DEMO_SRC})();</script>`;
    // Antes del primer script de la página, para que el fetch falso exista cuando arranque.
    return new Response(html.replace('<script id="', () => script + '<script id="'), { headers });
  };
  if (pathname === "/panel" || pathname === "/panel/" || pathname === "/panel/reset") return inject(renderPage(site));
  // Request sin cookies: el HTML del mesero nunca trae una sesión real; la demo contesta /me.
  if (pathname === "/panel/mesero" && request.method === "GET") return inject(await renderMeseroPage(new Request(request.url), env, site));
  return null; // /panel/e, /panel/o, /panel/o/mesa: lo que hace el menú demo sigue igual
}

async function seed(env, site) {
  const [catalog, config, club] = await Promise.all([
    peek(env, site.slug),
    env.MENUS.get(`${site.slug}:config`, "json").catch(() => null),
    loyalty(env, site.slug).then(r => r.json()),
  ]);
  return { slug: site.slug, host: site.host, config: config || {}, catalog: { version: catalog.version, ...catalog.doc }, loyalty: { ...club, enabled: true } };
}

// Cliente: reemplaza fetch para /panel/api/* con una API en memoria con la misma forma que la real.
export function demoRuntime() {
  const S = window.__DEMO__, KEY = "craft_demo:" + S.slug, TTL = 30 * 60 * 1000, MIN = 60 * 1000, DAY = 24 * 60 * MIN;
  const now = () => Date.now();
  const read = () => { try { const d = JSON.parse(localStorage.getItem(KEY)); return d && d.exp > now() ? d : null; } catch { return null; } };
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { /* sin storage: la demo vive en memoria */ } };
  const reset = () => { try { localStorage.removeItem(KEY); } catch { /* idem */ } location.reload(); };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "demo-" + Math.random().toString(36).slice(2));
  const dayOf = t => new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const slugify = v => String(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const totalOf = items => items.reduce((s, i) => s + i.qty * i.precio, 0);
  let db = read() || fresh();
  save();

  function fresh() {
    const t = now(), products = (S.catalog.products || []).filter(p => p.active !== false);
    const pick = (i, qty) => {
      const p = products[i % Math.max(products.length, 1)];
      return { nombre: p ? p.name : "Producto", qty, precio: Number(p && (p.promo_price || p.price)) || 5 };
    };
    const order = (n, ago, extra, items) => ({
      id: "demo-pedido-" + n, slug: S.slug, created_at: t - ago * MIN, total: totalOf(items), currency: S.config.currency || "$",
      client_name: "", client_phone: "", delivery_mode: "delivery", address: null, items, status: "pending", status_at: null,
      number: n, table_no: null, source: "web", staff_id: null, note: null, edited_at: null, edited_by: null, print_count: 0,
      printed_at: null, ...extra,
    });
    const names = ["Daniela Torres", "Andrés Mora", "Valentina Ruiz", "José Castillo", "Camila Vega", "Luis Andrade"];
    const days = Array.from({ length: 30 }, (_, i) => {
      const views = 35 + ((i * 37) % 29) + (i % 7 > 4 ? 25 : 0);
      return { day: dayOf(t - (29 - i) * DAY), views, orders: Math.round(views / 8), plays: Math.round(views / 6), new_customers: i % 3 ? 0 : 1 };
    });
    return {
      exp: t + TTL, seq: 3, tables: true, store: S.config, catalog: S.catalog, loyalty: S.loyalty, days,
      orders: [
        order(1, 70, { client_name: "Mesa 2", table_no: "2", delivery_mode: "mesa", source: "mesero", staff_id: "demo-ana",
          status: "confirmed", status_at: t - 65 * MIN, print_count: 1, printed_at: t - 64 * MIN }, [pick(3, 1), pick(4, 2)]),
        order(2, 25, { client_name: "Carlos Pérez", client_phone: "0991234567", address: "Av. Principal y calle 3" }, [pick(2, 1), pick(5, 1)]),
        order(3, 4, { client_name: "María", table_no: "4", delivery_mode: "mesa", source: "mesa", note: "Sin cebolla" }, [pick(0, 2), pick(1, 1)]),
      ],
      staff: [["demo-ana", "Ana", "1234"], ["demo-luis", "Luis", "5678"]].map(([id, name, pin]) => ({ id, name, pin, active: true, created_at: t - 20 * DAY, rotated_at: null })),
      customers: names.map((name, i) => ({
        phone: "5939900000" + (10 + i), name, birthday: null, stamps: (i * 3) % 8, visits: 2 + i * 2, cards_completed: i % 3,
        last_play_at: t - (i + 1) * 1.5 * DAY, active_rewards: i % 2, wallet_saved: i % 2, created_at: t - (10 + i * 4) * DAY,
      })),
      feedback: [[5, "Todo delicioso y llegó rápido"], [4, "Muy rico, la próxima pido más salsa"], [5, ""], [3, "Demoró un poco el sábado"]]
        .map(([rating, comment], i) => ({ rating, comment, name: names[i], phone: "5939900000" + (10 + i), created_at: t - (i * 2 + 1) * DAY })),
      campaigns: [{ id: 1, title: "2x1 los martes", body: "Este martes trae a un amigo: 2x1 en tu plato favorito.", sent: 42, failed: 1, created_at: t - 3 * DAY }],
    };
  }

  const ok = (data, status = 200, headers) => [status, data, headers];
  const fail = (code, status = 400, extra) => [status, { error: code, ...extra }];
  const dec = v => { try { return decodeURIComponent(v); } catch { return v; } };
  const sorted = () => db.orders.slice().sort((a, b) => b.created_at - a.created_at);
  const findOrder = id => db.orders.find(o => o.id === dec(id));
  const activeStaff = () => db.staff.find(s => s.active) || { id: "owner", name: "Dueño" };
  const staffPublic = ({ pin, ...s }) => s;
  const strip = b => { const { if_version, product_ids, ...x } = b; return x; };
  const bump = (data, status = 200) => { db.catalog.version++; return ok(data, status, { "x-catalog-version": String(db.catalog.version) }); };
  const meData = () => ({
    email: "demo@craft-systems.com", must_change_password: false, features: { loyalty: true }, loyalty_pay_url: "/panel",
    store: { slug: S.slug, store_name: db.store.store_name || "", logo: db.store.logo || "", theme_primary: db.store.theme_primary || "", menu_url: "https://" + S.host + "/" },
    loyalty_enabled: db.loyalty.enabled === true,
  });

  function setStatus(id, action) {
    const o = findOrder(id), status = action === "confirm" ? "confirmed" : "rejected";
    if (!o) return fail("pedido_no_existe", 404);
    if (o.status !== status && o.status !== "pending") return fail("estado_invalido", 409);
    if (o.status !== status) Object.assign(o, { status, status_at: now() });
    return ok({ order: o });
  }
  function related(m, key, id, b) {
    const list = db.catalog[key], products = db.catalog.products, groups = key === "variant_groups";
    const linked = gid => products.filter(p => (groups ? (p.groups || []).some(g => g.group_id === gid) : p.packaging_id === gid)).map(p => p.id);
    const assign = (gid, ids) => products.forEach(p => {
      const on = (ids || []).includes(p.id);
      if (groups) {
        p.groups = (p.groups || []).filter(g => g.group_id !== gid);
        if (on) p.groups.push({ group_id: gid, pick_override: null });
      } else if (on) p.packaging_id = gid;
      else if (p.packaging_id === gid) p.packaging_id = null;
    });
    if (m === "POST" && !id) {
      const x = { ...strip(b), id: b.id || uid() };
      list.push(x); assign(x.id, b.product_ids);
      return bump({ ...x, product_ids: linked(x.id) }, 201);
    }
    const i = list.findIndex(x => x.id === id);
    if (i < 0) return fail("no_existe", 404);
    if (m === "DELETE") { list.splice(i, 1); assign(id, []); return bump(null, 204); }
    list[i] = { ...strip(b), id }; assign(id, b.product_ids);
    return bump({ ...list[i], product_ids: linked(id) });
  }

  function panel(m, path, q, b) {
    const c = db.catalog, L = db.loyalty;
    let x;
    if (path === "login" || path === "reset" || path === "me") return ok(meData());
    if (path === "logout" || path === "password") return ok(null, 204);
    if (path === "orders" && m === "GET") {
      const off = Number(q.get("offset")) || 0, lim = Number(q.get("limit")) || 20, list = sorted();
      return ok({ orders: list.slice(off, off + lim), total: list.length, pending: list.filter(o => o.status === "pending").length });
    }
    if ((x = /^orders\/([^/]+)\/(confirm|reject)$/.exec(path))) {
      const r = setStatus(x[1], x[2]);
      return r[0] === 200 ? ok({ id: r[1].order.id, status: r[1].order.status, status_at: r[1].order.status_at }) : r;
    }
    if (path === "tables") { if (m === "PUT") db.tables = b.enabled === true; return ok({ enabled: db.tables }); }
    if (path === "catalog") return ok(c);
    if (path === "products" && m === "GET") return ok(c.products, 200, { "x-catalog-version": String(c.version) });
    if (path === "products" && m === "POST") { const p = { ...strip(b), id: uid() }; c.products.push(p); return bump(p, 201); }
    if ((x = /^products\/([^/]+)$/.exec(path))) {
      const i = c.products.findIndex(p => p.id === dec(x[1]));
      if (i < 0) return fail("no_existe", 404);
      if (m === "DELETE") { c.products.splice(i, 1); return bump(null, 204); }
      c.products[i] = { ...strip(b), id: c.products[i].id };
      return bump(c.products[i]);
    }
    if (path === "categories" && m === "POST") {
      const base = slugify(b.name) || "categoria";
      let slug = base, n = 2;
      while (c.categories.some(k => k.slug === slug)) slug = base + "-" + n++;
      const v = { slug, name: String(b.name || "").trim() };
      c.categories.push(v);
      return bump(v, 201);
    }
    if (path === "categories" && m === "PUT") {
      const order = b.slugs || [];
      c.categories.sort((a, z) => order.indexOf(a.slug) - order.indexOf(z.slug));
      return bump(c.categories);
    }
    if ((x = /^categories\/([^/]+)$/.exec(path))) {
      const slug = dec(x[1]), i = c.categories.findIndex(k => k.slug === slug);
      if (i < 0) return fail("no_existe", 404);
      if (m === "DELETE") {
        c.categories.splice(i, 1);
        c.products.forEach(p => { p.categories = (p.categories || []).filter(s => s !== slug); });
        return bump(null, 204);
      }
      c.categories[i].name = String(b.name || "").trim();
      return bump(c.categories[i]);
    }
    if ((x = /^(variant-groups|packagings)(?:\/([^/]+))?$/.exec(path)))
      return related(m, x[1] === "packagings" ? "packagings" : "variant_groups", x[2] && dec(x[2]), b);
    if (path === "store") { if (m === "PATCH") Object.assign(db.store, b); return ok(db.store); }
    if (path === "loyalty" && m === "PATCH") {
      for (const [k, v] of Object.entries(b)) {
        if (k === "pin") L.pin_set = true;
        else if (k === "stamps_reward_label") L.stamps_reward = { ...L.stamps_reward, label: v };
        else if (k === "club") { if (v && v.visible && b.enabled !== false) db.store.club = { label: v.label || "Únete al club" }; else delete db.store.club; }
        else L[k] = v;
      }
      return ok(L);
    }
    if (path === "loyalty") return ok(L);
    const cs = db.customers, since = Number(q.get("days")) || 30, days = db.days.slice(-since);
    const sum = k => days.reduce((s, d) => s + d[k], 0);
    if (path === "loyalty/stats") return ok({
      customers: cs.length, new_customers: sum("new_customers"), plays: sum("plays"), returning_customers: cs.filter(k => k.visits >= 2).length,
      rewards_issued: 9, rewards_redeemed: 6, cards_completed: cs.reduce((s, k) => s + k.cards_completed, 0),
      by_day: days.map(d => ({ day: d.day, plays: d.plays, new_customers: d.new_customers })),
    });
    if (path === "stats") return ok({
      days: days.map(d => ({ day: d.day, views: d.views, orders: d.orders })), totals: { views: sum("views"), orders: sum("orders") },
      loyalty: { customers: cs.length, plays: sum("plays") },
    });
    if (path === "loyalty/customers") {
      const term = (q.get("q") || "").trim().toLowerCase(), off = Number(q.get("offset")) || 0, lim = Number(q.get("limit")) || 50;
      const items = cs.filter(k => !term || k.name.toLowerCase().includes(term) || k.phone.includes(term));
      return ok({ items: items.slice(off, off + lim).map(({ created_at, ...k }) => k), total: items.length });
    }
    if (path === "loyalty/customers.csv")
      return ok("﻿" + ["Nombre,Teléfono,Visitas,Sellos", ...cs.map(k => `"${k.name}","${k.phone}","${k.visits}","${k.stamps}"`)].join("\n"));
    if ((x = /^loyalty\/customers\/([^/]+)$/.exec(path))) {
      const k = cs.find(v => v.phone === dec(x[1]));
      if (!k) return fail("cliente_no_encontrado", 404);
      const game = (L.games || [])[0] || "scratch", t = now();
      return ok({
        customer: k,
        rewards: k.active_rewards ? [{ id: 1, prize_id: "demo", label: (L.stamps_reward && L.stamps_reward.label) || "Postre gratis", source: "stamps",
          status: "active", pin_fails: 0, created_at: t - 2 * DAY, expires_at: t + 28 * DAY, redeemed_at: null, redeemed_by: null }] : [],
        plays: [1, 2, 3].map(i => ({ id: i, game, prize_id: null, reward_id: null, via: "pin", lat: null, lng: null,
          created_at: t - i * 4 * DAY, staff_name: "Ana" })),
      });
    }
    if (path === "loyalty/feedback") {
      const f = db.feedback;
      return ok({ items: f, total: f.length, avg: Math.round((f.reduce((s, v) => s + v.rating, 0) / f.length) * 10) / 10 });
    }
    if (path === "loyalty/staff" && m === "GET") return ok({ items: db.staff.map(staffPublic) });
    if (path === "loyalty/staff" && m === "POST") {
      const name = String(b.name || "").trim().slice(0, 60), pin = String(b.pin || "");
      if (!name) return fail("nombre_invalido");
      if (!/^\d{4,6}$/.test(pin)) return fail("pin_invalido");
      if (db.staff.some(s => s.active && s.pin === pin)) return fail("pin_repetido", 409);
      const s = { id: uid(), name, pin, active: true, created_at: now(), rotated_at: null };
      db.staff.push(s);
      return ok(staffPublic(s), 201);
    }
    if ((x = /^loyalty\/staff\/([^/]+)$/.exec(path))) {
      const s = db.staff.find(v => v.id === dec(x[1]));
      if (!s) return fail("mesero_no_encontrado", 404);
      if (m === "DELETE") { s.active = false; return ok(null, 204); }
      if (b.pin !== undefined) {
        if (!/^\d{4,6}$/.test(String(b.pin))) return fail("pin_invalido");
        if (db.staff.some(v => v.active && v.id !== s.id && v.pin === String(b.pin))) return fail("pin_repetido", 409);
        Object.assign(s, { pin: String(b.pin), rotated_at: now() });
      }
      if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 60) || s.name;
      if (typeof b.active === "boolean") s.active = b.active;
      return ok(staffPublic(s));
    }
    if (path === "loyalty/campaigns" && m === "GET") return ok(db.campaigns.slice().sort((a, z) => z.created_at - a.created_at));
    if (path === "loyalty/campaigns" && m === "POST") {
      const latest = Math.max(0, ...db.campaigns.map(v => v.created_at));
      if (now() < latest + DAY) return fail("campana_reciente", 429, { next_at: latest + DAY });
      db.campaigns.push({ id: db.campaigns.length + 1, title: b.title, body: b.body, sent: cs.length, failed: 0, created_at: now() });
      return ok({ sent: cs.length, failed: 0 });
    }
    return null;
  }

  function mesero(m, path, q, b) {
    let x;
    if (path === "login") return /^\d{4,6}$/.test(String(b.pin || "")) ? ok({ staff: staffPublic(activeStaff()) }) : fail("pin_invalido", 403);
    if (path === "logout") return ok(null, 204);
    if (path === "me") {
      const s = activeStaff();
      return ok({ staff: { id: s.id, name: s.name }, owner: false, store: { name: db.store.store_name || "", currency: db.store.currency || "$" }, tables_enabled: db.tables });
    }
    if (path === "catalog") return ok(db.catalog);
    if (path === "orders" && m === "GET") {
      const st = q.get("status") || "all", off = Number(q.get("offset")) || 0, lim = Number(q.get("limit")) || 30;
      return ok({ orders: sorted().filter(o => st === "all" || o.status === st).slice(off, off + lim) });
    }
    if (path === "orders" && m === "POST") {
      const items = Array.isArray(b.items) ? b.items : [], table = b.table_no || "", t = now();
      const o = {
        id: uid(), slug: S.slug, created_at: t, total: totalOf(items), currency: db.store.currency || "$",
        client_name: b.client_name || (table ? "Mesa " + table : "Mostrador"), client_phone: "", delivery_mode: "mesa", address: null,
        items, status: "confirmed", status_at: t, number: ++db.seq, table_no: table || null, source: "mesero", staff_id: activeStaff().id,
        note: b.note || null, edited_at: null, edited_by: null, print_count: 0, printed_at: null,
      };
      db.orders.push(o);
      return ok({ order: o }, 201);
    }
    if ((x = /^orders\/([^/]+)\/(confirm|reject)$/.exec(path))) return setStatus(x[1], x[2]);
    if ((x = /^orders\/([^/]+)\/print$/.exec(path))) {
      const o = findOrder(x[1]);
      if (!o) return fail("pedido_no_existe", 404);
      if (o.status !== "confirmed") return fail("estado_invalido", 409);
      Object.assign(o, { print_count: o.print_count + 1, printed_at: now() });
      return ok({ order: o });
    }
    if ((x = /^orders\/([^/]+)$/.exec(path)) && m === "PUT") {
      const o = findOrder(x[1]);
      if (!o) return fail("pedido_no_existe", 404);
      if (o.status !== "pending") return fail("estado_invalido", 409);
      if (Array.isArray(b.items)) Object.assign(o, { items: b.items, total: totalOf(b.items) });
      if ("table_no" in b) o.table_no = b.table_no || null;
      if ("note" in b) o.note = b.note || null;
      if ("client_name" in b) o.client_name = b.client_name || (o.table_no ? "Mesa " + o.table_no : "Mostrador");
      Object.assign(o, { edited_at: now(), edited_by: activeStaff().id });
      return ok({ order: o });
    }
    return null;
  }

  async function upload(blob) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > 2 * 1024 * 1024) return fail("archivo_invalido");
    const url = await new Promise(done => {
      const reader = new FileReader();
      reader.onload = () => done(reader.result);
      reader.onerror = () => done("");
      reader.readAsDataURL(blob);
    });
    return url ? ok({ url }, 201) : fail("archivo_invalido");
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, opt = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/panel/api/")) return realFetch(input, opt);
    // Otra pestaña (panel ↔ mesero) pudo cambiar los datos: se relee antes de cada operación.
    const stored = read();
    if (!stored) { reset(); return new Promise(() => {}); }
    db = stored;
    const m = String(opt.method || "GET").toUpperCase(), path = url.pathname.slice("/panel/api/".length);
    let r;
    if (path === "upload") r = await upload(opt.body);
    else {
      let b = {};
      try { b = (typeof opt.body === "string" && JSON.parse(opt.body)) || {}; } catch { /* cuerpo vacío */ }
      r = path.startsWith("mesero/") ? mesero(m, path.slice("mesero/".length), url.searchParams, b) : panel(m, path, url.searchParams, b);
    }
    const [status, data, headers = {}] = r || fail("ruta_no_encontrada", 404);
    save();
    if (status === 204) return new Response(null, { status, headers });
    if (typeof data === "string") return new Response(data, { status, headers: { "content-type": "text/csv; charset=utf-8", ...headers } });
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
  };

  function banner() {
    const bar = document.createElement("div"), text = document.createElement("span"), again = document.createElement("button");
    bar.setAttribute("role", "note");
    bar.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center;justify-content:center;padding:8px 16px;" +
      "background:#111820;color:#fff;font:600 13px/1.35 system-ui,sans-serif;text-align:center";
    const left = Math.max(1, Math.ceil((db.exp - now()) / MIN));
    text.textContent = "Estás en una demo: toca y cambia lo que quieras. Nada cambia en el menú real y todo vuelve a su estado inicial en " + left + " min.";
    again.type = "button";
    again.textContent = "Reiniciar demo";
    again.style.cssText = "border:1px solid #fff;background:none;color:#fff;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer";
    again.addEventListener("click", reset);
    bar.append(text, again);
    document.body.prepend(bar);
  }
  if (document.body) banner();
  else document.addEventListener("DOMContentLoaded", banner);
}

const DEMO_SRC = String(demoRuntime);
