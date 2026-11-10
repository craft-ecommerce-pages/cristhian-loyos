// A1: /panel/api/* (ver PLAN.md). Usa auth.js y events.js#statsFor.
import { normalizeConfig } from "../../loyalty/src/contract.js";
import {
  BIRTHDAY_DEFAULT, MAX_UPLOAD_BYTES, STORE_FIELDS, UPLOAD_TYPES, WINBACK_DEFAULT,
  error, isMediaUrl, json, mediaUrl, noContent,
} from "./contract.js";
import { hashPassword, readSession, sha256hex, signSession, verifyPassword } from "./auth.js";
import { statsFor } from "./events.js";
import { featuresFor } from "./admin.js";
import {
  CAJA_COOKIE, CAJA_TTL_MS, cajaSession, handleCajaApi, OWNER_STAFF, readCajaSession, signCajaSession,
} from "./caja.js";
import { handleCatalog, load } from "./catalog.js";
import {
  confirmPosOrder, createManualOrder, createPosOrder, createPublicPosOrder, editMeseroOrder, editPosOrder,
  getPosOrderStatus, listKitchenOrders, listMeseroOrders, listOrders, listPosOrders, meseroOrders, payCash,
  posOrderRow, printKitchenOrder, printMeseroOrder, publicSedes, rejectPosOrder, sedesAllowed, sedesFor,
  setMeseroOrderStatus, setOrderStatus, upsertSedes,
} from "./orders.js";
import { handleGetInvoice, handleRetryInvoice } from "./invoices.js";
import { handlePayphoneMock, handlePayphoneReturn, reconcilePayphone, startPayphone } from "./payphone.js";
import { salesReport } from "./reports.js";

const COOKIE = value => `panel_s=${value}; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`;
const EXPIRED_COOKIE = "panel_s=; Path=/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
const CLUB_DEFAULT_LABEL = "Únete al club";

// API pública del comprador (/api/*). El Worker de menús debe reenviar /api al panel
// (service binding PANEL); ver .ops/pos-handoff.md, pendiente de infraestructura.
export async function handlePublicApi(request, env, ctx, site) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "");
  if (!path) return error("ruta_no_encontrada", 404);
  if (request.method === "GET" && path === "sedes") return publicSedes(env, site.slug);
  if (path === "orders" && request.method === "POST") return createPublicPosOrder(request, env, ctx, site);
  const status = /^orders\/([^/]+)$/.exec(path);
  if (status && request.method === "GET") return getPosOrderStatus(env, site, status[1], url.searchParams.get("token"));
  if (request.method === "GET" && path === "payphone/return") return handlePayphoneReturn(request, env, site);
  if (request.method === "GET" && path === "payphone/mock") return handlePayphoneMock(request, env);
  return error("ruta_no_encontrada", 404);
}

export async function handleApi(request, env, ctx, site) {
  const path = new URL(request.url).pathname.replace(/^\/panel\/api\/?/, "");
  if (!path) return error("ruta_no_encontrada", 404);
  // Modo mesero: su propia cookie caja_s o la sesión del dueño; nunca depende del plan del club.
  if (path === "mesero" || path.startsWith("mesero/")) return handleMeseroApi(request, env, ctx, site, path);
  if (request.method !== "GET" && !(request.method === "POST" && path === "upload") && !isJson(request)) return error("content_type_invalido", 415);

  if (request.method === "POST" && path === "login") return login(request, env, site);
  if (request.method === "POST" && path === "reset") return reset(request, env, site);
  // Modo caja: sesión propia (cookie caja_s) o la del dueño, nunca la del panel para el resto de rutas.
  if (path === "caja" || path.startsWith("caja/")) return handleCajaApi(request, env, site, path);
  // POS: acciones de pedido (confirmar/rechazar/cobrar) y pantallas de caja/cocina.
  if (path === "pos/orders" || path === "kitchen" || path.startsWith("kitchen/") ||
    /^orders\/[^/]+\/(confirm|reject|pay-cash|payphone)$/.test(path)) return handlePosApi(request, env, ctx, site, path);

  const session = await readSession(request, env, site.slug);
  if (!session) return error("sin_sesion", 401);
  // Reportes de ventas: solo sesión del dueño; montos en centavos y conciliación exacta.
  if (request.method === "GET" && path === "reports/sales") return salesReport(request, env, site);
  // Facturas: lectura y reintento autenticados (nunca ruta pública).
  const invoice = /^invoices\/([^/]+)$/.exec(path);
  if (invoice && request.method === "GET") return handleGetInvoice(request, env, site, session, invoice[1]);
  const invoiceRetry = /^invoices\/([^/]+)\/retry$/.exec(path);
  if (invoiceRetry && request.method === "POST") return handleRetryInvoice(request, env, site, session, invoiceRetry[1]);
  // Conciliación de un pago Payphone `unknown`: reconsulta sin recobrar.
  const reconcile = /^payments\/([^/]+)\/reconcile$/.exec(path);
  if (reconcile && request.method === "POST") return reconcilePayphone(env, site, session, reconcile[1]);
  if (request.method === "POST" && path === "upload") return upload(request, env, site);
  if (request.method === "POST" && path === "logout") return noContent({ "set-cookie": EXPIRED_COOKIE });
  if (request.method === "GET" && path === "me") return me(env, site, session);
  if (request.method === "POST" && path === "password") return changePassword(request, env, site, session);
  if (request.method === "GET" && path === "orders") return listOrders(request, env, site.slug);
  if (request.method === "GET" && path === "sedes") return publicSedes(env, site.slug);
  if (request.method === "PUT" && path === "sedes") return updateSedes(request, env, site.slug);
  if (request.method === "GET" && path === "tables") return tables(env, site.slug);
  if (request.method === "PUT" && path === "tables") return updateTables(request, env, site.slug);
  const catalog = await handleCatalog(request, env, site, path);
  if (catalog) return catalog;
  if (request.method === "GET" && path === "store") return store(env, site.slug);
  if (request.method === "PATCH" && path === "store") return patchStore(request, env, site.slug);
  if (request.method === "GET" && path === "loyalty") return loyalty(env, site.slug);
  if (request.method === "PATCH" && path === "loyalty") return patchLoyalty(request, env, site.slug);
  if (request.method === "GET" && path === "loyalty/stats") return loyaltyStats(request, env, site.slug);
  if (request.method === "GET" && path === "loyalty/customers") return loyaltyCustomers(request, env, site.slug);
  if (request.method === "GET" && path === "loyalty/customers.csv") return loyaltyCustomersCsv(env, site.slug);
  if (request.method === "GET" && path === "loyalty/feedback") return loyaltyFeedback(request, env, site.slug);
  const customer = /^loyalty\/customers\/([^/]+)$/.exec(path);
  if (customer && request.method === "GET") return loyaltyCustomer(env, site.slug, customer[1]);
  if (request.method === "GET" && path === "loyalty/staff") return loyaltyStaff(env, site.slug);
  if (request.method === "POST" && path === "loyalty/staff") return createLoyaltyStaff(request, env, site.slug);
  const staff = /^loyalty\/staff\/([^/]+)$/.exec(path);
  if (staff && (request.method === "PUT" || request.method === "DELETE")) return updateLoyaltyStaff(request, env, site.slug, staff[1]);
  if (request.method === "GET" && path === "loyalty/campaigns") return loyaltyCampaigns(env, site.slug);
  if (request.method === "POST" && path === "loyalty/campaigns") return createLoyaltyCampaign(request, env, site.slug);
  if (request.method === "GET" && path === "stats") return stats(request, env, site.slug);
  return error("ruta_no_encontrada", 404);
}

const STAFF_ID = /^[A-Za-z0-9_-]{1,64}$/;

/* ── POS: caja, cocina y acciones sobre pedidos con sede ─────────────────── */

async function handlePosApi(request, env, ctx, site, path) {
  const panel = await readSession(request, env, site.slug);
  const caja = panel ? null : await readCajaSession(request, env, site.slug);
  const session = panel ? { staff_id: OWNER_STAFF, owner: true } : caja ? { staff_id: caja.staff_id, owner: false } : null;
  if (!session) return error("sin_sesion", 401);
  if (request.method === "GET" && path === "pos/orders") return listPosOrders(env, site, session, request);
  if (request.method === "GET" && path === "kitchen/orders") return listKitchenOrders(env, site, session, request);
  const print = /^kitchen\/orders\/([^/]+)\/print$/.exec(path);
  if (print && request.method === "POST") return printKitchenOrder(env, site, session, print[1], await readJson(request));
  const action = /^orders\/([^/]+)\/(confirm|reject|pay-cash|payphone)$/.exec(path);
  if (!action) return error("ruta_no_encontrada", 404);
  if (request.method !== "POST") return error("ruta_no_encontrada", 404);
  const [, encodedId, name] = action;
  const id = decodedPosId(encodedId);
  // Se despacha por existencia: los pedidos legacy conservan sus rutas y su sesión del dueño.
  if (id && await posOrderRow(env, site.slug, id)) {
    if (name === "confirm") return confirmPosOrder(env, site, session, encodedId);
    if (name === "reject") return rejectPosOrder(env, site, session, encodedId);
    if (name === "pay-cash") return payCash(env, site, session, encodedId, await readJson(request));
    return startPayphone(request, env, site, session, encodedId, await readJson(request));
  }
  if (!panel) return error("sin_sesion", 401);
  if (name === "pay-cash" || name === "payphone") return error("pedido_no_existe", 404);
  return setOrderStatus(env, ctx, site, encodedId, name);
}

function decodedPosId(encoded) { try { return decodeURIComponent(encoded); } catch { return null; } }

async function updateSedes(request, env, slug) {
  const body = await readJson(request);
  if (!body || !Array.isArray(body.sedes)) return error("sede_invalida", 400);
  const result = await upsertSedes(env, slug, body.sedes);
  return result.error ? error(result.error, result.status) : json({ sedes: result.sedes });
}


async function handleMeseroApi(request, env, ctx, site, path) {
  const action = path === "mesero" ? "" : path.slice("mesero/".length);
  if (request.method === "POST" && action === "login") return meseroLogin(request, env, site);
  if (request.method === "POST" && action === "logout") {
    const response = noContent({ "set-cookie": expiredCajaCookie() });
    response.headers.append("set-cookie", `${NAME_COOKIE}=; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    return response;
  }
  const session = await cajaSession(request, env, site);
  if (!session) return error("sin_sesion", 401);
  if (request.method === "GET" && action === "me") return json(await meseroMe(request, env, site, session));
  if (request.method === "GET" && action === "catalog") return json(await meseroCatalog(env, site.slug));
  if (request.method === "GET" && action === "orders") {
    // Con sede se listan los pedidos POS de esa sede; sin sede se conserva la lista legacy.
    if (new URL(request.url).searchParams.get("sede_id")) return listPosOrders(env, site, session, request);
    return listMeseroOrders(request, env, site.slug);
  }
  if (request.method === "POST" && action === "orders") {
    const body = await readJson(request);
    if (isPosOrderBody(body)) return createPosOrder(env, site, body, { source: "caja", session });
    return createManualOrder(env, site, session, body);
  }
  const edit = /^orders\/([^/]+)$/.exec(action);
  if (edit && request.method === "PUT") {
    const body = await readJson(request);
    const id = decodedPosId(edit[1]);
    if (id && await posOrderRow(env, site.slug, id)) return editPosOrder(env, site, session, edit[1], body);
    return editMeseroOrder(env, site, session, edit[1], body);
  }
  const state = /^orders\/([^/]+)\/(confirm|reject)$/.exec(action);
  if (state && request.method === "POST") {
    const id = decodedPosId(state[1]);
    if (id && await posOrderRow(env, site.slug, id)) {
      return state[2] === "confirm" ? confirmPosOrder(env, site, session, state[1]) : rejectPosOrder(env, site, session, state[1]);
    }
    return setMeseroOrderStatus(env, ctx, site, state[1], state[2]);
  }
  const print = /^orders\/([^/]+)\/print$/.exec(action);
  if (print && request.method === "POST") {
    const body = await readJson(request), id = decodedPosId(print[1]);
    if (id && await posOrderRow(env, site.slug, id)) return printKitchenOrder(env, site, session, print[1], body);
    return printMeseroOrder(env, site, print[1]);
  }
  return error("ruta_no_encontrada", 404);
}

// El POS exige product_id (y sede/clave); sin eso se usa el pedido manual legacy.
function isPosOrderBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (typeof body.sede_id === "string" && typeof body.idempotency_key === "string") return true;
  return Array.isArray(body.items) && body.items.some(item =>
    item && typeof item === "object" && typeof item.product_id === "string");
}

async function meseroLogin(request, env, site) {
  if (await meseroLimited(request, env, site.slug)) return error("demasiados_intentos", 429);
  const body = await readJson(request);
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!/^\d{4,6}$/.test(pin)) return error("pin_invalido", 403);
  // PIN local (D1) primero: la caja funciona sin craft-loyalty. Si no hay, el club decide.
  const local = await localStaffLogin(env, site.slug, pin);
  if (local) return meseroSession(env, site, local.id, local.name);
  const result = await meseroLoyalty(env, site.slug, "staff/verify", { method: "POST", body: { pin } });
  if (!result) {
    // Sin club: si hay meseros locales activos el PIN existió pero no coincide.
    return await hasLocalStaff(env, site.slug) ? error("pin_invalido", 403) : error("meseros_no_disponibles", 503);
  }
  if (result.status === 403) return error("pin_invalido", 403);
  if (result.status < 200 || result.status >= 300) return error("meseros_no_disponibles", 503);
  const staff = result.body?.staff, id = typeof staff?.id === "string" ? staff.id : "";
  if (!STAFF_ID.test(id)) return error("meseros_no_disponibles", 503);
  const name = typeof staff?.name === "string" ? staff.name.slice(0, 120) : "";
  return meseroSession(env, site, id, name);
}

async function meseroSession(env, site, id, name) {
  const response = json({ staff: { id, name } }, 200, { "set-cookie": cajaCookie(await signCajaSession(env, site.slug, id)) });
  response.headers.append("set-cookie",
    `${NAME_COOKIE}=${encodeURIComponent(name)}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${CAJA_TTL_MS / 1000}`);
  return response;
}

// ponytail: el nombre del mesero viaja en una cookie sin firmar porque solo se muestra en su propia pantalla
// (la identidad real es staff_id, firmado en caja_s). Así /me no llama a craft-loyalty; sin cookie, cae a loyalty.
const NAME_COOKIE = "mesero_n";
function nameCookie(request) {
  const part = (request.headers.get("cookie") || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${NAME_COOKIE}=`));
  try { return part ? decodeURIComponent(part.slice(NAME_COOKIE.length + 1)).slice(0, 120) : ""; } catch { return ""; }
}

async function meseroCatalog(env, slug) {
  const catalog = await load(env, slug);
  return { version: catalog.version, ...catalog.doc };
}

// Todo lo que la página necesita al abrir, en el mismo HTML: 1 request en vez de 4. null = sin sesión (pide PIN).
export async function meseroBoot(request, env, site) {
  const session = await cajaSession(request, env, site).catch(() => null);
  if (!session) return null;
  const [me, catalog, orders] = await Promise.all([
    meseroMe(request, env, site, session), meseroCatalog(env, site.slug), meseroOrders(env, site.slug, "pending", 50),
  ]);
  return { me, catalog, orders };
}

async function meseroMe(request, env, site, session) {
  const [config, settings, allowed, allSedes] = await Promise.all([
    kvJson(env, `${site.slug}:config`, {}),
    env.DB.prepare("SELECT tables_enabled FROM panel_settings WHERE slug = ?").bind(site.slug).first(),
    sedesAllowed(env, site.slug, session),
    sedesFor(env, site.slug),
  ]);
  const name = session.owner ? "Dueño" : nameCookie(request) || await staffName(env, site.slug, session.staff_id);
  return {
    staff: { id: session.owner ? OWNER_STAFF : session.staff_id, name }, owner: session.owner,
    store: { name: typeof config.store_name === "string" ? config.store_name : "", currency: config.currency || "$" },
    tables_enabled: Number(settings?.tables_enabled) === 1,
    // Sedes donde este operador puede cobrar/confirmar; el dueño ve todas.
    sedes: allSedes.filter(sede => sede.activa && (allowed === null || allowed.has(sede.id)))
      .map(sede => ({ id: sede.id, nombre: sede.nombre })),
  };
}

async function staffName(env, slug, id) {
  if (String(id).startsWith("l_")) {
    const local = await env.DB.prepare("SELECT name FROM pos_staff WHERE slug = ? AND id = ? AND active = 1").bind(slug, id).first();
    if (typeof local?.name === "string") return local.name;
  }
  const result = await meseroLoyalty(env, slug, "staff");
  const items = Array.isArray(result?.body?.items) ? result.body.items : [];
  const staff = items.find(item => item?.id === id);
  return typeof staff?.name === "string" ? staff.name : "";
}

async function tables(env, slug) {
  const row = await env.DB.prepare("SELECT tables_enabled FROM panel_settings WHERE slug = ?").bind(slug).first();
  return json({ enabled: Number(row?.tables_enabled) === 1 });
}
async function updateTables(request, env, slug) {
  const body = await readJson(request);
  if (!body || typeof body.enabled !== "boolean") return error("pedido_invalido", 400);
  await env.DB.prepare(
    "INSERT INTO panel_settings (slug, tables_enabled, updated_at) VALUES (?, ?, ?) " +
    "ON CONFLICT(slug) DO UPDATE SET tables_enabled = excluded.tables_enabled, updated_at = excluded.updated_at",
  ).bind(slug, body.enabled ? 1 : 0, Date.now()).run();
  return json({ enabled: body.enabled });
}

function cajaCookie(value) {
  return `${CAJA_COOKIE}=${value}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${CAJA_TTL_MS / 1000}`;
}
function expiredCajaCookie() { return `${CAJA_COOKIE}=; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=0`; }
async function meseroLimited(request, env, slug) {
  if (!env.LOGIN_LIMITER) return false;
  const ip = request.headers.get("cf-connecting-ip") || "sin-ip";
  return !(await env.LOGIN_LIMITER.limit({ key: `ml:${slug}:${ip}` })).success;
}
async function meseroLoyalty(env, slug, path, init = {}) {
  if (!env.LOYALTY || typeof env.LOYALTY.fetch !== "function" || !env.LOYALTY_ADMIN_TOKEN) return null;
  try {
    const headers = { authorization: `Bearer ${env.LOYALTY_ADMIN_TOKEN}` };
    const options = { method: init.method || "GET", headers };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(init.body);
    }
    const response = await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/${path}`, options);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch { return null; }
}

async function login(request, env, site) {
  if (await limited(request, env, site.slug)) return error("demasiados_intentos", 429);
  const body = await readJson(request);
  const email = emailOf(body?.email), password = typeof body?.password === "string" ? body.password : "";
  const user = email && await env.DB.prepare("SELECT * FROM panel_users WHERE slug = ?").bind(site.slug).first();
  if (!user || !await verifyPassword(password, user.password_hash) || !sameText(email, user.email)) return error("credenciales_invalidas", 401);
  return json(await meData(env, site, user), 200, { "set-cookie": COOKIE(await signSession(env, site.slug, user.email, user.pwd_ver)) });
}

async function reset(request, env, site) {
  if (await limited(request, env, site.slug)) return error("demasiados_intentos", 429);
  const body = await readJson(request);
  if (!body || !validPassword(body.new) || typeof body.token !== "string") return error("token_invalido", 400);
  const now = Date.now(), tokenHash = await sha256hex(body.token);
  const reset = await env.DB.prepare("SELECT * FROM panel_resets WHERE token_hash = ? AND slug = ?").bind(tokenHash, site.slug).first();
  if (!reset || reset.used_at != null || Number(reset.expires_at) <= now) return error("token_invalido", 400);
  const user = await env.DB.prepare("SELECT * FROM panel_users WHERE slug = ?").bind(site.slug).first();
  if (!user) return error("token_invalido", 400);
  const password_hash = await hashPassword(body.new);
  // El WHERE hace que dos usos simultáneos del mismo enlace no puedan ganar ambos.
  const used = await env.DB.prepare("UPDATE panel_resets SET used_at = ? WHERE token_hash = ? AND slug = ? AND used_at IS NULL AND expires_at > ?")
    .bind(now, tokenHash, site.slug, now).run();
  if (!used.meta.changes) return error("token_invalido", 400);
  const pwd_ver = Number(user.pwd_ver) + 1;
  await env.DB.prepare("UPDATE panel_users SET password_hash = ?, pwd_ver = ?, must_change_password = 0, updated_at = ? WHERE slug = ?")
    .bind(password_hash, pwd_ver, now, site.slug).run();
  const fresh = { ...user, password_hash, pwd_ver, must_change_password: 0 };
  return json(await meData(env, site, fresh), 200, { "set-cookie": COOKIE(await signSession(env, site.slug, user.email, pwd_ver)) });
}

async function changePassword(request, env, site, session) {
  const body = await readJson(request);
  if (!body || !validPassword(body.new)) return error("password_corta", 400);
  const user = await env.DB.prepare("SELECT * FROM panel_users WHERE slug = ?").bind(site.slug).first();
  if (!user || user.email !== session.email || !await verifyPassword(body.current, user.password_hash)) return error("credenciales_invalidas", 401);
  const pwd_ver = Number(user.pwd_ver) + 1;
  await env.DB.prepare("UPDATE panel_users SET password_hash = ?, pwd_ver = ?, must_change_password = 0, updated_at = ? WHERE slug = ?")
    .bind(await hashPassword(body.new), pwd_ver, Date.now(), site.slug).run();
  return noContent({ "set-cookie": COOKIE(await signSession(env, site.slug, user.email, pwd_ver)) });
}

async function store(env, slug) { return json(await kvJson(env, `${slug}:config`, {})); }
async function patchStore(request, env, slug) {
  const body = await readJson(request);
  if (!body) return error("json_invalido", 400);
  const config = await kvJson(env, `${slug}:config`, {});
  for (const field of STORE_FIELDS) if (Object.hasOwn(body, field)) {
    const value = storeField(env, field, body[field], config[field], config);
    if (!value.ok) return error("campo_invalido", 400, { campo: field });
    config[field] = value.value;
  }
  await env.MENUS.put(`${slug}:config`, JSON.stringify(config));
  return json(config);
}

export async function loyalty(env, slug) {
  const raw = await kvJson(env, `${slug}:loyalty`, {}), config = normalizeConfig(raw);
  // Compatibilidad temporal: L1 normalizará require_pin y play_mode en el contrato compartido.
  config.require_pin = raw.require_pin === true;
  config.play_mode = raw.play_mode === "stamps" ? "stamps" : "game";
  // Igual con cumpleaños e inactivos: G1 los agrega a normalizeConfig; aquí se preservan y se validan.
  config.birthday = birthdayField(raw.birthday) || { ...BIRTHDAY_DEFAULT };
  config.winback = winbackField(raw.winback) || { ...WINBACK_DEFAULT };
  return json(publicLoyalty(config));
}
async function patchLoyalty(request, env, slug) {
  const body = await readJson(request);
  if (!body) return error("json_invalido", 400);
  // La tarjeta es una función por plan: sin la función no se puede encender el club.
  if (body.enabled === true && !(await featuresFor(env, slug)).loyalty) return error("plan_requerido", 402);
  const raw = await kvJson(env, `${slug}:loyalty`, {});
  const current = normalizeConfig(raw), next = {
    ...current,
    require_pin: raw.require_pin === true,
    play_mode: raw.play_mode === "stamps" ? "stamps" : "game",
    birthday: birthdayField(raw.birthday) || { ...BIRTHDAY_DEFAULT },
    winback: winbackField(raw.winback) || { ...WINBACK_DEFAULT },
  };
  // Botón del club en el menú: {visible, label}. Sin `club` en el body no se toca config.
  let club = null;
  if (Object.hasOwn(body, "club")) {
    club = clubField(body.club);
    if (!club) return invalidLoyalty("club");
  }
  for (const field of ["enabled", "games", "prizes", "lose_weight", "stamps_goal", "cooldown_hours", "review_url", "terms"]) {
    if (Object.hasOwn(body, field)) next[field] = body[field];
  }
  if (Object.hasOwn(body, "stamps_reward")) next.stamps_reward = body.stamps_reward;
  if (Object.hasOwn(body, "stamps_reward_label")) {
    next.stamps_reward = { ...current.stamps_reward, ...(plainObject(next.stamps_reward) ? next.stamps_reward : {}), label: body.stamps_reward_label };
  }
  if (Object.hasOwn(body, "pin")) {
    if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) return invalidLoyalty("pin");
    next.staff_pin_hash = await sha256hex(`${slug}:${body.pin}`);
  }
  // L1 incorpora este campo a normalizeConfig. Lo validamos y preservamos aquí durante la integración.
  if (Object.hasOwn(body, "require_pin")) {
    if (typeof body.require_pin !== "boolean") return invalidLoyalty("require_pin");
    next.require_pin = body.require_pin;
  }
  // Igual que require_pin: M1 lo agrega a normalizeConfig, aquí se valida y se preserva.
  if (Object.hasOwn(body, "play_mode")) {
    if (body.play_mode !== "game" && body.play_mode !== "stamps") return invalidLoyalty("play_mode");
    next.play_mode = body.play_mode;
  }
  if (Object.hasOwn(body, "birthday")) {
    const birthday = birthdayField(body.birthday);
    if (!birthday) return invalidLoyalty("birthday");
    next.birthday = birthday;
  }
  if (Object.hasOwn(body, "winback")) {
    const winback = winbackField(body.winback);
    if (!winback) return invalidLoyalty("winback");
    next.winback = winback;
  }
  const normalized = normalizeConfig(next);
  normalized.require_pin = next.require_pin === true;
  normalized.play_mode = next.play_mode === "stamps" ? "stamps" : "game";
  normalized.birthday = next.birthday;
  normalized.winback = next.winback;
  for (const field of ["enabled", "games", "prizes", "lose_weight", "stamps_goal", "cooldown_hours", "review_url", "terms"]) {
    if (Object.hasOwn(body, field) && !sameLoyaltyField(field, body[field], normalized[field])) return invalidLoyalty(field);
  }
  if (Object.hasOwn(body, "stamps_reward") && !sameStampsReward(body.stamps_reward, normalized.stamps_reward)) return invalidLoyalty("stamps_reward");
  if (Object.hasOwn(body, "stamps_reward_label") && body.stamps_reward_label !== normalized.stamps_reward.label) return invalidLoyalty("stamps_reward_label");
  if (Object.hasOwn(body, "terms") && (typeof normalized.terms !== "string" || [...normalized.terms].length > 1000)) return invalidLoyalty("terms");
  await env.MENUS.put(`${slug}:loyalty`, JSON.stringify(normalized));
  if (club) await writeClub(env, slug, normalized, club);
  return json(publicLoyalty(normalized));
}

// config.club lo lee v1/catalog.js#clubBanner: solo {label}. Apagado ⇒ se borra la clave.
async function writeClub(env, slug, loyalty, club) {
  const config = await kvJson(env, `${slug}:config`, {});
  if (loyalty.enabled && club.visible) config.club = { label: club.label };
  else delete config.club;
  await env.MENUS.put(`${slug}:config`, JSON.stringify(config));
}
function clubField(value) {
  if (!plainObject(value) || !onlyKeys(value, ["visible", "label"]) || typeof value.visible !== "boolean") return null;
  if (value.label != null && typeof value.label !== "string") return null;
  const label = String(value.label ?? "").trim();
  if ([...label].length > 40) return null;
  return { visible: value.visible, label: label || CLUB_DEFAULT_LABEL };
}

async function loyaltyStats(request, env, slug) {
  const url = new URL(request.url), days = url.searchParams.get("days");
  return relayLoyalty(await loyaltyRequest(env, slug, `stats${days == null ? "" : `?days=${encodeURIComponent(days)}`}`));
}
async function loyaltyCustomers(request, env, slug) {
  const query = new URL(request.url).searchParams, params = new URLSearchParams();
  for (const key of ["q", "limit", "offset"]) if (query.has(key)) params.set(key, query.get(key));
  const suffix = params.size ? `?${params}` : "";
  return relayLoyalty(await loyaltyRequest(env, slug, `customers${suffix}`));
}
// Descarga: el CSV lo arma el club (G1) y el panel solo lo reenvía con su nombre de archivo.
async function loyaltyCustomersCsv(env, slug) {
  if (!env.LOYALTY || typeof env.LOYALTY.fetch !== "function" || !env.LOYALTY_ADMIN_TOKEN) return error("club_no_disponible", 503);
  let response;
  try {
    const headers = new Headers();
    headers.set("authorization", `Bearer ${env.LOYALTY_ADMIN_TOKEN}`);
    response = await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/customers.csv`, { headers });
  } catch { return error("club_no_disponible", 503); }
  if (!response.ok) return error("club_no_disponible", 503);
  return new Response(await response.arrayBuffer(), {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="clientes-${slug}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
async function loyaltyFeedback(request, env, slug) {
  const query = new URL(request.url).searchParams, params = new URLSearchParams();
  for (const key of ["limit", "offset"]) if (query.has(key)) params.set(key, query.get(key));
  const suffix = params.size ? `?${params}` : "";
  return relayLoyalty(await loyaltyRequest(env, slug, `feedback${suffix}`));
}
async function loyaltyCustomer(env, slug, encodedPhone) {
  let phone;
  try { phone = decodeURIComponent(encodedPhone); } catch { return error("cliente_no_encontrado", 404); }
  return relayLoyalty(await loyaltyRequest(env, slug, `customers/${encodeURIComponent(phone)}`));
}
async function loyaltyStaff(env, slug) {
  const result = await loyaltyRequest(env, slug, "staff");
  if (result) return relayLoyalty(result);
  return json({ items: await localStaffList(env, slug) });
}
async function createLoyaltyStaff(request, env, slug) {
  if (!hasLoyalty(env)) return createLocalStaff(request, env, slug);
  return relayLoyalty(await loyaltyRequest(env, slug, "staff", {
    method: "POST", headers: { "content-type": "application/json" }, body: await request.text(),
  }));
}
async function updateLoyaltyStaff(request, env, slug, encodedId) {
  if (!hasLoyalty(env)) return updateLocalStaff(request, env, slug, encodedId);
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return error("mesero_no_encontrado", 404); }
  const init = request.method === "PUT"
    ? { method: "PUT", headers: { "content-type": "application/json" }, body: await request.text() }
    : { method: "DELETE" };
  return relayLoyalty(await loyaltyRequest(env, slug, `staff/${encodeURIComponent(id)}`, init));
}
/* ── PIN local del mesero (sin craft-loyalty) ───────────────────────────────
   Permite operar caja cuando el cliente no despliega el club. `id` viaja en la
   cookie caja_s con prefijo l_; las sedes autorizadas se leen de D1 en cada request. */

function hasLoyalty(env) {
  return Boolean(env.LOYALTY && typeof env.LOYALTY.fetch === "function" && env.LOYALTY_ADMIN_TOKEN);
}

async function localStaffList(env, slug) {
  const rows = await env.DB.prepare(
    "SELECT id, name, sedes, active, created_at FROM pos_staff WHERE slug = ? ORDER BY created_at, id",
  ).bind(slug).all();
  return (rows.results || []).map(localStaffPublic);
}

function localStaffPublic(row) {
  let sedes = [];
  try { sedes = JSON.parse(row.sedes); } catch { /* JSON roto: sin sedes */ }
  return {
    id: row.id, name: row.name, active: Number(row.active) === 1,
    sedes: Array.isArray(sedes) ? sedes.filter(id => typeof id === "string") : [], local: true,
  };
}

async function localStaffLogin(env, slug, pin) {
  if (!/^\d{4,6}$/.test(pin)) return null;
  const row = await env.DB.prepare(
    "SELECT id, name, pin_hash FROM pos_staff WHERE slug = ? AND pin_lookup = ? AND active = 1",
  ).bind(slug, await sha256hex(`${slug}:${pin}`)).first();
  if (!row || !await verifyPassword(pin, row.pin_hash)) return null;
  return { id: row.id, name: row.name };
}

async function hasLocalStaff(env, slug) {
  const row = await env.DB.prepare("SELECT 1 AS one FROM pos_staff WHERE slug = ? AND active = 1 LIMIT 1").bind(slug).first();
  return row != null;
}

function sedeList(input, known) {
  const ids = new Set(known.map(sede => sede.id));
  if (input == null) return known.filter(sede => sede.activa).map(sede => sede.id);
  if (!Array.isArray(input) || input.length > 50) return null;
  const out = [];
  for (const id of input) {
    if (typeof id !== "string" || !ids.has(id) || out.includes(id)) return null;
    out.push(id);
  }
  return out;
}

function localId() {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  return "l_" + [...crypto.getRandomValues(new Uint8Array(10))].map(byte => alphabet[byte % alphabet.length]).join("");
}

async function createLocalStaff(request, env, slug) {
  const body = await readJson(request);
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!name) return invalidLoyalty("name");
  if (!/^\d{4,6}$/.test(pin)) return invalidLoyalty("pin");
  const sedes = sedeList(body.sedes, await sedesFor(env, slug));
  if (sedes == null) return invalidLoyalty("sedes");
  const now = Date.now(), id = localId();
  try {
    await env.DB.prepare(
      "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    ).bind(slug, id, name, await sha256hex(`${slug}:${pin}`), await hashPassword(pin), JSON.stringify(sedes), now, now).run();
  } catch { return error("pin_duplicado", 409); }
  const row = await env.DB.prepare("SELECT id, name, sedes, active, created_at FROM pos_staff WHERE slug = ? AND id = ?")
    .bind(slug, id).first();
  return json(localStaffPublic(row), 201);
}

async function updateLocalStaff(request, env, slug, encodedId) {
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return error("mesero_no_encontrado", 404); }
  const row = await env.DB.prepare("SELECT * FROM pos_staff WHERE slug = ? AND id = ?").bind(slug, id).first();
  if (!row) return error("mesero_no_encontrado", 404);
  if (request.method === "DELETE") {
    await env.DB.prepare("UPDATE pos_staff SET active = 0, updated_at = ? WHERE slug = ? AND id = ?")
      .bind(Date.now(), slug, id).run();
    return noContent();
  }
  const body = await readJson(request);
  if (!body) return error("json_invalido", 400);
  const name = Object.hasOwn(body, "name") ? String(body.name ?? "").trim().slice(0, 120) : row.name;
  if (!name) return invalidLoyalty("name");
  let pinLookup = row.pin_lookup, pinHash = row.pin_hash;
  if (Object.hasOwn(body, "pin")) {
    const pin = typeof body.pin === "string" ? body.pin : "";
    if (!/^\d{4,6}$/.test(pin)) return invalidLoyalty("pin");
    pinLookup = await sha256hex(`${slug}:${pin}`);
    pinHash = await hashPassword(pin);
  }
  let sedes = row.sedes;
  if (Object.hasOwn(body, "sedes")) {
    const list = sedeList(body.sedes, await sedesFor(env, slug));
    if (list == null) return invalidLoyalty("sedes");
    sedes = JSON.stringify(list);
  }
  let active = Number(row.active);
  if (Object.hasOwn(body, "active")) {
    if (typeof body.active !== "boolean") return invalidLoyalty("active");
    active = body.active ? 1 : 0;
  }
  try {
    await env.DB.prepare(
      "UPDATE pos_staff SET name = ?, pin_lookup = ?, pin_hash = ?, sedes = ?, active = ?, updated_at = ? WHERE slug = ? AND id = ?",
    ).bind(name, pinLookup, pinHash, sedes, active, Date.now(), slug, id).run();
  } catch { return error("pin_duplicado", 409); }
  return json(localStaffPublic(await env.DB.prepare(
    "SELECT id, name, sedes, active, created_at FROM pos_staff WHERE slug = ? AND id = ?",
  ).bind(slug, id).first()));
}

async function loyaltyCampaigns(env, slug) { return relayLoyalty(await loyaltyRequest(env, slug, "campaigns")); }
async function createLoyaltyCampaign(request, env, slug) {
  // El historial es la fuente de verdad: no confiamos en un reloj o estado del navegador.
  const history = await loyaltyRequest(env, slug, "campaigns");
  if (!history) return error("club_no_disponible", 503);
  if (history.response.status !== 200) return relayLoyalty(history);
  const latest = Array.isArray(history.body) ? history.body.reduce((last, campaign) => {
    const created = Number(campaign?.created_at);
    return Number.isFinite(created) && created > last ? created : last;
  }, 0) : 0;
  const nextAt = latest + 86_400_000;
  if (latest && Date.now() < nextAt) return error("campana_reciente", 429, { next_at: nextAt });
  const body = await request.text();
  return relayLoyalty(await loyaltyRequest(env, slug, "campaigns", {
    method: "POST", headers: { "content-type": "application/json" }, body,
  }));
}
async function loyaltyRequest(env, slug, path, init = {}) {
  if (!env.LOYALTY || typeof env.LOYALTY.fetch !== "function" || !env.LOYALTY_ADMIN_TOKEN) return null;
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${env.LOYALTY_ADMIN_TOKEN}`);
    const response = await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/${path}`, { ...init, headers });
    return { response, body: await response.json().catch(() => ({})) };
  } catch { return null; }
}
function relayLoyalty(result) {
  if (!result) return error("club_no_disponible", 503);
  return result.response.status === 204 ? noContent() : json(result.body, result.response.status);
}

async function upload(request, env, site) {
  if (request.headers.get("x-panel") !== "1") return error("no_autorizado", 401);
  const type = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[type];
  const length = Number(request.headers.get("content-length"));
  if (!ext || (Number.isFinite(length) && length > MAX_UPLOAD_BYTES)) return error("archivo_invalido", 400);
  const data = await request.arrayBuffer();
  if (!data.byteLength || data.byteLength > MAX_UPLOAD_BYTES) return error("archivo_invalido", 400);
  const key = `panel/${site.slug}/${crypto.randomUUID()}.${ext}`;
  await env.MEDIA.put(key, data, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  return json({ url: mediaUrl(env, key) }, 201);
}

async function stats(request, env, slug) {
  const days = daysOf(new URL(request.url));
  return days == null ? error("dias_invalidos", 400) : json(await statsFor(env, slug, days));
}

async function me(env, site, session) {
  const user = await env.DB.prepare("SELECT * FROM panel_users WHERE slug = ?").bind(site.slug).first();
  return !user || user.email !== session.email ? error("sin_sesion", 401) : json(await meData(env, site, user));
}
async function meData(env, site, user) {
  const [config, loyaltyConfig, features] = await Promise.all([
    kvJson(env, `${site.slug}:config`, {}),
    kvJson(env, `${site.slug}:loyalty`, {}),
    featuresFor(env, site.slug),
  ]);
  return {
    email: user.email,
    must_change_password: Boolean(user.must_change_password),
    payment_mode: env.PAYPHONE_MODE === "live" && typeof env.PAYPHONE_TOKEN === "string" && env.PAYPHONE_TOKEN ? "live" : "mock",
    store: {
      slug: site.slug, store_name: config.store_name || "", logo: config.logo || "",
      theme_primary: config.theme_primary || "", menu_url: publicMenuUrl(env.MENU_PUBLIC_URL),
    },
    loyalty_enabled: normalizeConfig(loyaltyConfig).enabled,
    loyalty_available: Boolean(env.LOYALTY),
    // Función "tarjeta" por plan: la UI bloquea Fidelidad si está apagada.
    features: { loyalty: features.loyalty },
    loyalty_pay_url: loyaltyPayUrl(env, site.slug),
  };
}
function publicMenuUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  try {
    const url = new URL(raw.trim());
    return url.protocol === "https:" && !url.username && !url.password ? url.origin + "/" : "";
  } catch { return ""; }
}
// Enlace del addon de fidelidad (USD 5/mes). `CRM_PAY_URL` es var de wrangler;
// sin ella no se inventa un cobro externo (el panel oculta el botón).
function loyaltyPayUrl(env, slug) {
  const raw = typeof env.CRM_PAY_URL === "string" ? env.CRM_PAY_URL.trim() : "";
  const base = /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?(?:\/\S*)?$/i.test(raw) ? raw.replace(/\/+$/, "") : "";
  return base ? `${base}/api/v1/billing/pay/loyalty/${encodeURIComponent(slug)}` : null;
}

function storeField(env, field, value, current, config) {
  if (field === "whatsapp_number") return typeof value === "string" && /^\d{8,15}$/.test(value) ? valid(value) : invalid();
  if (field === "logo") return isMediaUrl(env, value) ? valid(value) : invalid();
  if (field === "hero_title" || field === "brand_sub") return typeof value === "string" && [...value].length <= 120 ? valid(value.trim()) : invalid();
  if (field === "hours") return hoursField(value);
  if (field === "location") return locationField(value, current);
  if (field === "delivery_fee") return finiteMoney(value, 1000) ? valid(value) : invalid();
  if (field === "search_placeholder") return typeof value === "string" && [...value].length <= 60 ? valid(value.trim()) : invalid();
  if (field === "cross_sell") return crossSellField(value, config);
  return invalid();
}

function hoursField(value) {
  if (!plainObject(value) || !onlyKeys(value, ["tz", "weekly", "closed_msg", "allow_preorders"])) return invalid();
  if (typeof value.tz !== "string" || !value.tz.trim() || value.tz.length > 100 || !plainObject(value.weekly)) return invalid();
  if (!onlyKeys(value.weekly, ["0", "1", "2", "3", "4", "5", "6"]) || Object.keys(value.weekly).length !== 7) return invalid();
  const weekly = {};
  for (let day = 0; day <= 6; day++) {
    const ranges = value.weekly[String(day)];
    if (!Array.isArray(ranges) || ranges.length > 2) return invalid();
    weekly[String(day)] = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !range.every(validTime) || range[0] === range[1]) return invalid();
      weekly[String(day)].push([range[0], range[1]]);
    }
  }
  const out = { tz: value.tz.trim(), weekly };
  if (Object.hasOwn(value, "closed_msg")) {
    if (typeof value.closed_msg !== "string" || [...value.closed_msg].length > 200) return invalid();
    out.closed_msg = value.closed_msg.trim();
  }
  if (Object.hasOwn(value, "allow_preorders")) {
    if (typeof value.allow_preorders !== "boolean") return invalid();
    out.allow_preorders = value.allow_preorders;
  }
  return valid(out);
}

function locationField(value, current) {
  if (!plainObject(value) || !onlyKeys(value, ["sedes", "telefono_principal", "map_embed", "out_of_coverage_message", "social"]) || !Array.isArray(value.sedes) || value.sedes.length > 50) return invalid();
  if (Object.hasOwn(value, "telefono_principal") && (typeof value.telefono_principal !== "string" || [...value.telefono_principal].length > 30)) return invalid();
  const previous = plainObject(current) ? current : {}, oldSedes = Array.isArray(previous.sedes) ? previous.sedes : [];
  const sedes = [];
  for (let i = 0; i < value.sedes.length; i++) {
    const sede = value.sedes[i];
    if (!plainObject(sede) || !onlyKeys(sede, ["id", "nombre", "direccion", "telefono", "universidad", "activa", "lat", "lng", "radio_km"])) return invalid();
    if (typeof sede.nombre !== "string" || !sede.nombre.trim() || [...sede.nombre].length > 120) return invalid();
    if (typeof sede.direccion !== "string" || !sede.direccion.trim() || [...sede.direccion].length > 300) return invalid();
    if (Object.hasOwn(sede, "id") && (typeof sede.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sede.id))) return invalid();
    if (Object.hasOwn(sede, "universidad") && (typeof sede.universidad !== "string" || [...sede.universidad].length > 120)) return invalid();
    if (Object.hasOwn(sede, "activa") && typeof sede.activa !== "boolean") return invalid();
    const old = plainObject(oldSedes[i]) ? oldSedes[i] : {};
    const geo = ["lat", "lng", "radio_km"].filter(k => Object.hasOwn(sede, k));
    if (geo.length && geo.length !== 3) return invalid();
    if (geo.length && (!finiteNumber(sede.lat, -90, 90) || !finiteNumber(sede.lng, -180, 180) || !finiteNumber(sede.radio_km, 0.01, 1000))) return invalid();
    if (Object.hasOwn(sede, "telefono") && (typeof sede.telefono !== "string" || [...sede.telefono].length > 30)) return invalid();
    const next = { ...old, nombre: sede.nombre.trim(), direccion: sede.direccion.trim() };
    if (Object.hasOwn(sede, "id")) next.id = sede.id;
    if (Object.hasOwn(sede, "universidad")) next.universidad = sede.universidad.trim();
    if (Object.hasOwn(sede, "activa")) next.activa = sede.activa;
    if (geo.length) Object.assign(next, { lat: sede.lat, lng: sede.lng, radio_km: sede.radio_km });
    if (Object.hasOwn(sede, "telefono")) next.telefono = sede.telefono.trim();
    sedes.push(next);
  }
  const out = { ...previous, sedes };
  if (Object.hasOwn(value, "telefono_principal")) out.telefono_principal = value.telefono_principal.trim();
  if (Object.hasOwn(value, "map_embed")) {
    if (typeof value.map_embed !== "string" || (value.map_embed && !/^https:\/\/www\.google\.com\/maps\/embed/.test(value.map_embed)) || value.map_embed.length > 2048) return invalid();
    out.map_embed = value.map_embed;
  }
  if (Object.hasOwn(value, "out_of_coverage_message")) {
    if (typeof value.out_of_coverage_message !== "string" || [...value.out_of_coverage_message].length > 300) return invalid();
    out.out_of_coverage_message = value.out_of_coverage_message.trim();
  }
  if (Object.hasOwn(value, "social")) {
    if (!plainObject(value.social) || !onlyKeys(value.social, ["facebook", "instagram", "tiktok"])) return invalid();
    for (const v of Object.values(value.social)) if (typeof v !== "string" || !/^https:\/\//.test(v) || v.length > 2048) return invalid();
    out.social = { ...value.social };
  }
  return valid(out);
}

function crossSellField(value, current) {
  if (!plainObject(value) || !onlyKeys(value, ["categories", "title", "max"]) || !Array.isArray(value.categories) || !value.categories.every(v => typeof v === "string") || typeof value.title !== "string" || [...value.title].length > 60 || !Number.isInteger(value.max) || value.max < 1 || value.max > 12) return invalid();
  const available = plainObject(current) ? Object.keys(current.categories || {}) : [];
  return value.categories.every(c => available.includes(c)) ? valid({ categories: value.categories, title: value.title.trim(), max: value.max }) : invalid();
}
function finiteNumber(value, min, max) { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function finiteMoney(value, max) { return finiteNumber(value, 0, max) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-9; }

function validTime(value) { return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
function plainObject(value) { return value != null && typeof value === "object" && !Array.isArray(value); }
function onlyKeys(value, keys) { const allowed = new Set(keys); return Object.keys(value).every(key => allowed.has(key)); }
function valid(value) { return { ok: true, value }; }
function invalid() { return { ok: false }; }

// Cumpleaños e inactivos: config opcional del club. Devuelven la forma normalizada o null si no sirve.
function birthdayField(value) {
  if (!plainObject(value) || !onlyKeys(value, ["enabled", "label", "expires_days"]) || typeof value.enabled !== "boolean") return null;
  const label = value.label == null ? "" : value.label;
  if (typeof label !== "string" || [...label.trim()].length > 60) return null;
  const expires = value.expires_days == null ? BIRTHDAY_DEFAULT.expires_days : wholeNumber(value.expires_days, 1, 365);
  if (expires == null) return null;
  return { enabled: value.enabled, label: label.trim() || BIRTHDAY_DEFAULT.label, expires_days: expires };
}
function winbackField(value) {
  if (!plainObject(value) || !onlyKeys(value, ["enabled", "days", "label", "expires_days"])) return null;
  if (typeof value.enabled !== "boolean") return null;
  const days = value.days == null ? WINBACK_DEFAULT.days : wholeNumber(value.days, 14, 365);
  const expires = value.expires_days == null ? WINBACK_DEFAULT.expires_days : wholeNumber(value.expires_days, 1, 365);
  if (days == null || expires == null) return null;
  const label = value.label == null ? "" : value.label;
  if (typeof label !== "string" || [...label.trim()].length > 60) return null;
  return { enabled: value.enabled, days, label: label.trim() || WINBACK_DEFAULT.label, expires_days: expires };
}
function wholeNumber(value, min, max) { return Number.isInteger(value) && value >= min && value <= max ? value : null; }

function validPassword(value) { return typeof value === "string" && value.length >= 8 && value.length <= 1024; }
function emailOf(value) { const email = typeof value === "string" ? value.trim().toLowerCase() : ""; return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && email.length <= 254 ? email : null; }
function sameText(a, b) { return String(a).length === String(b).length && [...String(a)].every((char, i) => char === String(b)[i]); }
function publicLoyalty(config) {
  const { staff_pin_hash, ...safe } = config;
  return { ...safe, pin_set: Boolean(staff_pin_hash) };
}
function invalidLoyalty(campo) { return error("campo_invalido", 400, { campo }); }
function sameLoyaltyField(field, input, output) {
  if (field === "prizes") return samePrizes(input, output);
  if (field === "terms") return typeof input === "string" && [...input].length <= 1000 && input === output;
  return sameJson(input, output);
}
function samePrizes(input, output) {
  if (!Array.isArray(input) || !Array.isArray(output) || input.length !== output.length) return false;
  return input.every((prize, index) => {
    const normalized = output[index];
    if (!plainObject(prize) || !onlyKeys(prize, ["id", "label", "weight", "stock", "expires_days"])) return false;
    if (prize.id !== normalized.id || prize.label !== normalized.label || prize.weight !== normalized.weight) return false;
    const stock = Object.hasOwn(prize, "stock") ? prize.stock : null;
    const expires = Object.hasOwn(prize, "expires_days") ? prize.expires_days : null;
    return stock === normalized.stock && expires === normalized.expires_days;
  });
}
function sameStampsReward(input, output) {
  if (!plainObject(input) || !onlyKeys(input, ["label", "expires_days"])) return false;
  const expires = Object.hasOwn(input, "expires_days") ? input.expires_days : null;
  return input.label === output.label && expires === output.expires_days;
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function isJson(request) { return request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "application/json"; }
async function readJson(request) { try { const value = await request.json(); return value && typeof value === "object" && !Array.isArray(value) ? value : null; } catch { return null; } }
async function kvJson(env, key, fallback) { const value = await env.MENUS.get(key, "json"); return value && typeof value === "object" ? value : fallback; }
async function limited(request, env, slug) { if (!env.LOGIN_LIMITER) return false; return !(await env.LOGIN_LIMITER.limit({ key: `${slug}:${request.headers.get("cf-connecting-ip") || "sin-ip"}` })).success; }
function daysOf(url) { const raw = url.searchParams.get("days"); const value = raw == null || raw === "" ? 30 : Number(raw); return Number.isInteger(value) && value >= 1 && value <= 366 ? value : null; }
