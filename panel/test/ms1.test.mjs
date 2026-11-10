// MS1: números diarios, pedidos de mesa y API del modo mesero.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { signCajaSession } from "../src/caja.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const withCookie = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});
const webOrder = id => ({
  order_id: id, items: [{ nombre: "Pizza", qty: 1, precio: 10 }], total: 10, currency: "USD",
  client_name: "Ana", client_phone: "0991234567", delivery_mode: "delivery", address: "Calle 1",
});
const tableOrder = id => ({
  order_id: id, items: [{ nombre: "Pizza", qty: 2, precio: 10 }], total: 20, currency: "USD",
  client_name: "Ana", client_phone: "", table_no: "4", note: "Sin cebolla",
});

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

test("todos los pedidos reciben número diario atómico y el día siguiente reinicia", async () => {
  const env = makeEnv({ "pizza:loyalty": { enabled: false } }), ctx = makeCtx();
  const original = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 0, 2, 12);
    await panel.fetch(body("/panel/o", webOrder("web-1")), env, ctx);
    await panel.fetch(body("/panel/o", webOrder("web-2")), env, ctx);
    await ctx.settle();
    const first = env.DB.raw.prepare("SELECT number FROM orders WHERE id = ?").get("web-1").number;
    const second = env.DB.raw.prepare("SELECT number FROM orders WHERE id = ?").get("web-2").number;
    assert.deepEqual([first, second].sort((a, b) => a - b), [1, 2]);

    Date.now = () => Date.UTC(2026, 0, 3, 12);
    await panel.fetch(body("/panel/o", webOrder("web-next")), env, ctx);
    await ctx.settle();
    assert.equal(env.DB.raw.prepare("SELECT number FROM orders WHERE id = ?").get("web-next").number, 1);
  } finally { Date.now = original; }
});

test("pedido de mesa respeta interruptor, límite, tamaño e idempotencia", async () => {
  const env = makeEnv(), ctx = makeCtx();
  let response = await panel.fetch(body("/panel/o/mesa", tableOrder("mesa-1")), env, ctx);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "mesas_apagadas" });

  const owner = await ownerCookie(env);
  response = await panel.fetch(body("/panel/api/tables", { enabled: true }, { method: "PUT", headers: { cookie: owner } }), env, {});
  assert.deepEqual(await response.json(), { enabled: true });
  response = await panel.fetch(body("/panel/o/mesa", tableOrder("mesa-1")), env, ctx);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.number, 1);
  response = await panel.fetch(body("/panel/o/mesa", tableOrder("mesa-1")), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), created);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM orders").get().n, 1);
  assert.equal(env.DB.raw.prepare("SELECT orders FROM events_daily WHERE slug = ?").get("pizza").orders, 1);

  const invalid = await panel.fetch(body("/panel/o/mesa", { ...tableOrder("mesa-2"), table_no: "12345678901" }), env, ctx);
  assert.equal(invalid.status, 400);
  const large = await panel.fetch(request("/panel/o/mesa", {
    method: "POST", headers: { "content-type": "application/json", "content-length": String(16 * 1024 + 1) }, body: "{}",
  }), env, ctx);
  assert.equal(large.status, 413);
  env.LOGIN_LIMITER = { limit: async ({ key }) => ({ success: key !== "om:pizza:sin-ip" }) };
  const limited = await panel.fetch(body("/panel/o/mesa", tableOrder("mesa-3")), env, ctx);
  assert.deepEqual(await limited.json(), { error: "demasiados_pedidos" });
});

test("confirmar mesa no llama al club, confirmar web sí", async () => {
  const env = makeEnv(), ctx = makeCtx(), calls = [];
  env.LOYALTY = { fetch: async (url, init) => {
    calls.push(new URL(url).pathname);
    return Response.json({ ok: true }, { status: 200 });
  } };
  env.DB.raw.prepare("INSERT INTO panel_settings (slug, tables_enabled, updated_at) VALUES (?, 1, ?)")
    .run("pizza", Date.now());
  await panel.fetch(body("/panel/o/mesa", tableOrder("mesa-confirm")), env, ctx);
  await ctx.settle();
  await panel.fetch(body("/panel/o", webOrder("web-confirm")), env, ctx);
  await ctx.settle();
  calls.length = 0;
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  let response = await panel.fetch(body("/panel/api/mesero/orders/mesa-confirm/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  await ctx.settle();
  assert.deepEqual(calls, []);
  response = await panel.fetch(body("/panel/api/mesero/orders/web-confirm/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  await ctx.settle();
  assert.deepEqual(calls, ["/admin/pizza/credits/web-confirm/grant"]);
});

test("el fallback web de Mesa no toca el club y delivery conserva su crédito", async () => {
  const env = makeEnv({ "pizza:loyalty": { enabled: true } }), ctx = makeCtx(), calls = [];
  env.LOYALTY = { fetch: async (url, init) => {
    calls.push({ path: new URL(url).pathname, body: init?.body && JSON.parse(init.body) });
    return Response.json({ ok: true });
  } };
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  await panel.fetch(body("/panel/o", { ...webOrder("web-mesa"), delivery_mode: "mesa", address: undefined }), env, ctx);
  await ctx.settle();
  assert.deepEqual(calls, []);
  const confirmed = await panel.fetch(body("/panel/api/mesero/orders/web-mesa/confirm", {}, {
    headers: { cookie },
  }), env, ctx);
  assert.equal(confirmed.status, 200);
  await ctx.settle();
  assert.deepEqual(calls, []);

  await panel.fetch(body("/panel/o", webOrder("web-delivery")), env, ctx);
  await ctx.settle();
  assert.deepEqual(calls, [{
    path: "/admin/pizza/credits",
    body: { order_id: "web-delivery", phone: "0991234567" },
  }]);
});

test("rutas mesero aceptan caja_s y sesión del dueño, sin 402", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "Pizza", currency: "USD" } });
  env.DB.raw.prepare("INSERT INTO panel_features (slug, loyalty, source, updated_at) VALUES (?, 0, ?, ?)")
    .run("pizza", "legacy", Date.now());
  const caja = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  let response = await panel.fetch(withCookie("/panel/api/mesero/me", caja), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).owner, false);
  const owner = await ownerCookie(env);
  response = await panel.fetch(withCookie("/panel/api/mesero/me", owner), env, {});
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.owner, true);
  assert.equal(me.staff.name, "Dueño");
  response = await panel.fetch(withCookie("/panel/api/mesero/catalog", owner), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.status, 200, "modo mesero nunca devuelve plan_requerido");
});

test("pedido manual recalcula total; editar e imprimir respetan sus estados", async () => {
  const env = makeEnv({ "pizza:config": { currency: "USD" } });
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  let response = await panel.fetch(body("/panel/api/mesero/orders", {
    table_no: "7", note: "Para compartir", items: [{ nombre: "Pizza", qty: 2, precio: 8 }], total: 1,
  }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 201);
  const manual = (await response.json()).order;
  assert.equal(manual.total, 16);
  assert.equal(manual.status, "confirmed");
  assert.equal(manual.source, "mesero");
  assert.equal(manual.staff_id, "staff-1");
  assert.equal(manual.client_name, "Mesa 7");
  response = await panel.fetch(body("/panel/api/mesero/orders", {
    table_no: "4", client_name: "Andrea", items: [{ nombre: "Pizza", qty: 1, precio: 8 }],
  }, { headers: { cookie } }), env, {});
  assert.equal((await response.json()).order.client_name, "Andrea");
  response = await panel.fetch(body(`/panel/api/mesero/orders/${manual.id}`, {
    items: [{ nombre: "Pizza", qty: 3, precio: 8 }],
  }, { method: "PUT", headers: { cookie } }), env, {});
  assert.equal(response.status, 409);
  response = await panel.fetch(body(`/panel/api/mesero/orders/${manual.id}/print`, {}, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.print_count, 1);
  response = await panel.fetch(body(`/panel/api/mesero/orders/${manual.id}/print`, {}, { headers: { cookie } }), env, {});
  assert.equal((await response.json()).order.print_count, 2);

  env.DB.raw.prepare(
    "INSERT INTO orders (id, slug, created_at, total, currency, client_name, client_phone, delivery_mode, items) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run("pending-edit", "pizza", Date.now(), 1, "USD", "Ana", "", "mesa", "[]");
  response = await panel.fetch(body("/panel/api/mesero/orders/pending-edit", {
    table_no: "9", items: [{ nombre: "Bebida", qty: 2, precio: 2.5 }], note: "Fría",
  }, { method: "PUT", headers: { cookie } }), env, {});
  const edited = (await response.json()).order;
  assert.equal(response.status, 200);
  assert.equal(edited.total, 5);
  assert.equal(edited.edited_by, "staff-1");
  assert.equal(edited.client_name, "Ana", "sin client_name en el PUT se conserva");
  response = await panel.fetch(body("/panel/api/mesero/orders/pending-edit", { client_name: "" },
    { method: "PUT", headers: { cookie } }), env, {});
  assert.equal((await response.json()).order.client_name, "Mesa 9");
});

test("login de mesero limita, valida PIN y exige el binding", async () => {
  const env = makeEnv(), seen = [];
  env.LOYALTY = { fetch: async (url, init) => {
    seen.push({ url, init });
    return Response.json({ staff: { id: "staff-1", name: "Ana" } });
  } };
  let response = await panel.fetch(body("/panel/api/mesero/login", { pin: "1234" }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { staff: { id: "staff-1", name: "Ana" } });
  assert.match(response.headers.get("set-cookie"), /^caja_s=/);
  assert.equal(new URL(seen[0].url).pathname, "/admin/pizza/staff/verify");
  response = await panel.fetch(body("/panel/api/mesero/login", { pin: "mal" }), env, {});
  assert.deepEqual(await response.json(), { error: "pin_invalido" });
  env.LOGIN_LIMITER = { limit: async ({ key }) => ({ success: key !== "ml:pizza:sin-ip" }) };
  response = await panel.fetch(body("/panel/api/mesero/login", { pin: "1234" }), env, {});
  assert.deepEqual(await response.json(), { error: "demasiados_intentos" });
  delete env.LOGIN_LIMITER;
  delete env.LOYALTY;
  response = await panel.fetch(body("/panel/api/mesero/login", { pin: "1234" }), env, {});
  assert.deepEqual(await response.json(), { error: "meseros_no_disponibles" });
});

test("la página del mesero trae sesión, catálogo y pendientes en el HTML (1 request al abrir)", async () => {
  const env = makeEnv({ "pizza:config": { currency: "USD", store_name: "Pizza" } });
  let loyaltyCalls = 0;
  env.LOYALTY = { fetch: async () => { loyaltyCalls++; return Response.json({ items: [] }); } };
  const bootOf = async (cookie) => {
    const html = await (await panel.fetch(withCookie("/panel/mesero", cookie), env, {})).text();
    return JSON.parse(/window\.__MESERO__=(\{.*?\});<\/script>/s.exec(html)[1]).boot;
  };
  assert.equal(await bootOf(""), null, "sin sesión no filtra datos");
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}; mesero_n=${encodeURIComponent("Ana Pérez")}`;
  const boot = await bootOf(cookie);
  assert.equal(boot.me.staff.name, "Ana Pérez");
  assert.equal(loyaltyCalls, 0, "el nombre sale de la cookie, no de craft-loyalty");
  assert.ok(Array.isArray(boot.catalog.products));
  assert.ok(Array.isArray(boot.orders));
  const response = await panel.fetch(withCookie("/panel/mesero", cookie), env, {});
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
