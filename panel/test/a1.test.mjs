import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeEnv, makeLimiter } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, { headers = {}, ...options } = {}) => request(path, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), ...options,
});
async function owner(env, email = "dueno@pizza.ec") {
  const response = await panel.fetch(jsonRequest("/admin/pizza/owner", { email }, { headers: { authorization: "Bearer admin-token" } }), env, {});
  assert.equal(response.status, 200);
  return response.json();
}
async function login(env, credentials) {
  return panel.fetch(jsonRequest("/panel/api/login", credentials), env, {});
}
const cookieOf = response => response.headers.get("set-cookie").split(";", 1)[0];
const withCookie = (path, cookie, options = {}) => request(path, { ...options, headers: { ...options.headers, cookie } });

test("login correcto, incorrecto y limitado", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "Pizza" } });
  const credentials = await owner(env);
  let response = await login(env, credentials);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).email, credentials.email);
  assert.match(response.headers.get("set-cookie"), /^panel_s=.*Path=\/panel; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  response = await login(env, { email: credentials.email, password: "mal-password" });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "credenciales_invalidas" });
  env.LOGIN_LIMITER = makeLimiter(true);
  response = await login(env, credentials);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "demasiados_intentos" });
});

test("el panel enlaza la carta del Worker de menú configurado", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "Pizza" } });
  env.MENU_PUBLIC_URL = "https://menu.cliente.example";
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  const response = await panel.fetch(withCookie("/panel/api/me", cookie), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).store.menu_url, "https://menu.cliente.example/");
});

test("la sesión está ligada al slug y una contraseña nueva revoca la cookie previa", async () => {
  const env = makeEnv({ "pizza:config": {}, "other:config": {} });
  const credentials = await owner(env);
  const old = cookieOf(await login(env, credentials));
  let response = await panel.fetch(withCookie("/panel/api/me", old), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(new Request("https://other.craft-systems.com/panel/api/me", { headers: { cookie: old } }), env, {});
  assert.equal(response.status, 401);
  response = await panel.fetch(jsonRequest("/panel/api/password", { current: credentials.password, new: "nueva-clave-123" }, { headers: { cookie: old } }), env, {});
  assert.equal(response.status, 204);
  const fresh = cookieOf(response);
  assert.notEqual(fresh, old);
  assert.equal((await panel.fetch(withCookie("/panel/api/me", old), env, {})).status, 401);
  assert.equal((await panel.fetch(withCookie("/panel/api/me", fresh), env, {})).status, 200);
});

test("reset es de un solo uso y vence", async () => {
  const env = makeEnv({ "pizza:config": {} });
  await owner(env);
  let response = await panel.fetch(jsonRequest("/admin/pizza/reset", {}, { headers: { authorization: "Bearer admin-token" } }), env, {});
  const reset = await response.json(), token = new URL(reset.url).searchParams.get("t");
  response = await panel.fetch(jsonRequest("/panel/api/reset", { token, new: "reset-clave-123" }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await panel.fetch(jsonRequest("/panel/api/reset", { token, new: "otra-clave-123" }), env, {})).status, 400);
  response = await panel.fetch(jsonRequest("/admin/pizza/reset", {}, { headers: { authorization: "Bearer admin-token" } }), env, {});
  const expired = new URL((await response.json()).url).searchParams.get("t");
  env.DB.raw.prepare("UPDATE panel_resets SET expires_at = 0").run();
  response = await panel.fetch(jsonRequest("/panel/api/reset", { token: expired, new: "otra-clave-123" }), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "token_invalido" });
});

test("productos usan el documento nativo del catálogo", async () => {
  const env = makeEnv({
    "pizza:config": { categories: { pizzas: "Pizzas" }, category_order: ["pizzas"] },
    "pizza:productos": [{ id: "p1", slug: "margarita", nombre: "Margarita", precio: "10.00", precio_promo: "", stock: null,
      categorias: ["pizzas"], descripcion: "clásica", imagenes: [], variantes: [], sku: "M1", costo_empaque: 0.2 }],
  });
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  const native = { id: "p1", name: "Margarita grande", type: "producto", price: "12.50", promo_price: "", packaging_id: null, packaging_cost: 0.2,
    sku: "M1", description: "clásica", stock: 0, active: true, catalog_visible: true, images: [], categories: ["pizzas"], variants: [], groups: [] };
  let response = await panel.fetch(jsonRequest("/panel/api/products/p1", native, { method: "PUT", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  const changed = await response.json();
  assert.equal(changed.price, "12.50");
  assert.equal(changed.stock, 0);
  response = await panel.fetch(jsonRequest("/panel/api/products", { ...native, id: undefined, name: "Pepperoni", price: "13", promo_price: "11.5", stock: null }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.promo_price, "11.5");
  assert.equal(created.stock, null);
  assert.equal((await panel.fetch(withCookie("/panel/api/products", cookie), env, {})).status, 200);
  response = await panel.fetch(jsonRequest(`/panel/api/products/${created.id}`, {}, { method: "DELETE", headers: { cookie } }), env, {});
  assert.equal(response.status, 204);
});

test("store valida formas, mezcla sedes y permite solo la lista contratada", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "No cambia", interno: true, location: {
    map_embed: "https://maps.example/embed", telefono_principal: "593991111111",
    sedes: [{ nombre: "Centro", direccion: "Antes", lat: -0.2, lng: -78.5, radio_km: 4, extra: true }],
  } } });
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  const hours = { tz: "America/Guayaquil", weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), day === 1 ? [["09:00", "13:00"], ["14:00", "18:00"]] : []])), closed_msg: "Cerrado", allow_preorders: true };
  let response = await panel.fetch(jsonRequest("/panel/api/store", {
    whatsapp_number: "593991234567", hours,
    location: { telefono_principal: "593992222222", sedes: [{ nombre: "Matriz", direccion: "Nueva" }] },
    logo: "https://media.craft-systems.com/panel/pizza/logo.webp", hero_title: "Pizza artesanal", brand_sub: "Hecha hoy",
    store_name: "inyectado", tracking: { x: 1 },
  }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  const store = await response.json();
  assert.equal(store.store_name, "No cambia");
  assert.equal(store.interno, true);
  assert.deepEqual(store.hours, hours);
  assert.equal(store.location.map_embed, "https://maps.example/embed");
  assert.deepEqual(store.location.sedes[0], { nombre: "Matriz", direccion: "Nueva", lat: -0.2, lng: -78.5, radio_km: 4, extra: true });
  assert.equal(store.location.telefono_principal, "593992222222");
});

test("store rechaza cada campo inválido sin escribir parcialmente", async () => {
  const original = { store_name: "Pizza", brand_sub: "Original" };
  const env = makeEnv({ "pizza:config": original });
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  const weekly = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), []]));
  const cases = [
    ["whatsapp_number", "593-991", "whatsapp_number"],
    ["whatsapp_number", 593991234567, "whatsapp_number"],
    ["logo", "https://evil.example/logo.webp", "logo"],
    ["hero_title", "x".repeat(121), "hero_title"],
    ["brand_sub", 42, "brand_sub"],
    ["hours", { tz: "America/Guayaquil", weekly: { ...weekly, 1: [["25:00", "26:00"]] } }, "hours"],
    ["hours", { tz: "America/Guayaquil", weekly: { 0: [] } }, "hours"],
    ["hours", { tz: "America/Guayaquil", weekly, allow_preorders: "sí" }, "hours"],
    ["location", { sedes: [{ nombre: "Centro", direccion: "" }] }, "location"],
    ["location", { sedes: [], extra: true }, "location"],
    ["location", { sedes: [], telefono_principal: 593991234567 }, "location"],
  ];
  for (const [field, value, campo] of cases) {
    const response = await panel.fetch(jsonRequest("/panel/api/store", { brand_sub: "No guardar", [field]: value }, { method: "PATCH", headers: { cookie } }), env, {});
    assert.equal(response.status, 400, field);
    assert.deepEqual(await response.json(), { error: "campo_invalido", campo });
    assert.deepEqual(await env.MENUS.get("pizza:config", "json"), original, `${field} no escribe cambios parciales`);
  }
});

test("fidelidad devuelve stamps_reward normalizado y nunca el PIN hash", async () => {
  const env = makeEnv({ "pizza:config": {} });
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  let response;
  response = await panel.fetch(jsonRequest("/panel/api/loyalty", { enabled: true, stamps_goal: 6, stamps_reward_label: "Pizza gratis", prizes: [], pin: "1234" }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  const loyalty = await response.json();
  assert.equal("staff_pin_hash" in loyalty, false);
  assert.equal(loyalty.stamps_reward.label, "Pizza gratis");
  assert.equal("stamps_reward_label" in loyalty, false);
  const raw = await env.MENUS.get("pizza:loyalty", "json");
  assert.match(raw.staff_pin_hash, /^[0-9a-f]{64}$/);
});

test("upload restringe sesión, tipo y tamaño", async () => {
  const env = makeEnv({ "pizza:config": {} });
  const credentials = await owner(env), cookie = cookieOf(await login(env, credentials));
  let response = await panel.fetch(request("/panel/api/upload", { method: "POST", headers: { "x-panel": "1", "content-type": "image/gif" }, body: new Uint8Array([1]) }), env, {});
  assert.equal(response.status, 401);
  response = await panel.fetch(request("/panel/api/upload", { method: "POST", headers: { cookie, "x-panel": "1", "content-type": "image/gif" }, body: new Uint8Array([1]) }), env, {});
  assert.equal(response.status, 400);
  response = await panel.fetch(request("/panel/api/upload", { method: "POST", headers: { cookie, "x-panel": "1", "content-type": "image/png" }, body: new Uint8Array(2 * 1024 * 1024 + 1) }), env, {});
  assert.equal(response.status, 400);
  response = await panel.fetch(request("/panel/api/upload", { method: "POST", headers: { cookie, "x-panel": "1", "content-type": "image/webp" }, body: new Uint8Array([1, 2]) }), env, {});
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.match(uploaded.url, /^\/media\/panel\/pizza\/.+\.webp$/);
  assert.equal(env.MEDIA.map.values().next().value.o.httpMetadata.cacheControl, "public, max-age=31536000, immutable");
});

test("admin exige Bearer y permite owner, reset y delete", async () => {
  const env = makeEnv();
  let response = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "a@pizza.ec" }), env, {});
  assert.equal(response.status, 401);
  response = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "a@pizza.ec" }, { headers: { authorization: "Bearer admin-token" } }), env, {});
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).password, "string");
  response = await panel.fetch(jsonRequest("/admin/pizza/reset", { host: "menu.pizza.ec" }, { headers: { authorization: "Bearer admin-token" } }), env, {});
  assert.equal(response.status, 200);
  assert.match((await response.json()).url, /^https:\/\/menu\.pizza\.ec\/panel\/reset\?t=/);
  response = await panel.fetch(request("/admin/pizza/owner", { method: "DELETE" }), env, {});
  assert.equal(response.status, 401);
  response = await panel.fetch(request("/admin/pizza/owner", { method: "DELETE", headers: { authorization: "Bearer admin-token" } }), env, {});
  assert.equal(response.status, 204);
  response = await panel.fetch(jsonRequest("/admin/pizza/reset", {}, { headers: { authorization: "Bearer admin-token" } }), env, {});
  assert.equal(response.status, 404);
});

test("admin GET owner devuelve correo sin hash y 404 sin dueño", async () => {
  const env = makeEnv();
  const call = (m, body) => panel.fetch(new Request("https://x.workers.dev/admin/pizza/owner", { method: m, headers: { authorization: "Bearer " + env.ADMIN_TOKEN, "content-type": "application/json" }, body: body && JSON.stringify(body) }), env, { waitUntil() {} });
  assert.equal((await call("GET")).status, 404);
  await call("POST", { email: "Dueno@Pizza.com" });
  const r = await call("GET"); const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.email, "dueno@pizza.com"); assert.equal(j.must_change_password, true); assert.equal("password_hash" in j, false);
});
