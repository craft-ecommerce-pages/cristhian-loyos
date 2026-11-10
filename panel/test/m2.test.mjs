// M2: estado de pedidos + créditos al club, config.club, play_mode y los dos QR.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { renderPage } from "../src/page.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(body),
});
const withSession = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});
async function session(env) {
  const owner = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const credentials = await owner.json();
  const login = await panel.fetch(jsonRequest("/panel/api/login", credentials), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const order = (id = "ord-1", phone = "0991234567") => ({
  items: [{ nombre: "Pizza", qty: 1, precio: 10 }],
  total: 10, currency: "USD", client_name: "Ana", client_phone: phone,
  delivery_mode: "delivery", address: "Calle 1", order_id: id,
});
function creditEnv(init = {}) {
  const env = makeEnv({ "pizza:loyalty": { enabled: true, ...(init.loyalty || {}) }, ...(init.kv || {}) }), calls = [];
  env.LOYALTY = { fetch: async (url, request_) => {
    calls.push({ url, method: request_.method, headers: request_.headers, body: request_.body });
    return Response.json({ ok: true }, { status: 201 });
  } };
  return { env, calls };
}
const row = (env, id) => env.DB.raw.prepare("SELECT * FROM orders WHERE id = ?").get(id);

test("pedido nuevo: queda pendiente y pide un crédito al club cuando está activo", async () => {
  const { env, calls } = creditEnv(), ctx = makeCtx();
  assert.equal((await panel.fetch(jsonRequest("/panel/o", order()), env, ctx)).status, 204);
  await ctx.settle();
  const saved = row(env, "ord-1");
  assert.equal(saved.status, "pending");
  assert.equal(saved.status_at, null);
  assert.deepEqual(calls.map(c => [c.url, c.method]), [["https://loyalty/admin/pizza/credits", "POST"]]);
  assert.equal(calls[0].headers.authorization, "Bearer loy-token");
  assert.deepEqual(JSON.parse(calls[0].body), { order_id: "ord-1", phone: "0991234567" });
  // Sin `order_id` el panel genera uno y el crédito usa ese mismo id.
  assert.equal((await panel.fetch(jsonRequest("/panel/o", { ...order(), order_id: undefined }), env, ctx)).status, 204);
  await ctx.settle();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].body).order_id, env.DB.raw.prepare("SELECT id FROM orders WHERE id != 'ord-1' LIMIT 1").get().id);
});

test("sin club activo, sin binding o con error del club el pedido igual se guarda en silencio", async () => {
  // Club apagado: no hay llamada.
  for (const loyalty of [{ enabled: false }, null]) {
    const env = makeEnv(loyalty ? { "pizza:loyalty": loyalty } : {}), ctx = makeCtx(), calls = [];
    env.LOYALTY = { fetch: async url => { calls.push(url); return Response.json({}); } };
    assert.equal((await panel.fetch(jsonRequest("/panel/o", order()), env, ctx)).status, 204);
    await ctx.settle();
    assert.equal(row(env, "ord-1").status, "pending");
    assert.deepEqual(calls, []);
  }
  // Fallo de red, 409 del tope diario o token ausente: 204 y pedido guardado.
  const failures = [
    { LOYALTY: { fetch: async () => { throw new Error("red"); } } },
    { LOYALTY: { fetch: async () => Response.json({ error: "limite_diario" }, { status: 409 }) } },
    { LOYALTY_ADMIN_TOKEN: "" },
  ];
  for (const extra of failures) {
    const { env } = creditEnv();
    Object.assign(env, extra);
    const ctx = makeCtx();
    assert.equal((await panel.fetch(jsonRequest("/panel/o", order()), env, ctx)).status, 204);
    await ctx.settle();
    assert.equal(row(env, "ord-1").status, "pending");
  }
});

test("listar pedidos expone estado, fecha de cambio y cuántos faltan confirmar", async () => {
  const { env } = creditEnv(), ctx = makeCtx();
  for (const id of ["a", "b", "c"]) {
    await panel.fetch(jsonRequest("/panel/o", { ...order(id), created_at: undefined }), env, ctx);
    await ctx.settle();
  }
  env.DB.raw.prepare("UPDATE orders SET status = 'confirmed', status_at = 123 WHERE id = 'b'").run();
  const cookie = await session(env);
  const response = await panel.fetch(withSession("/panel/api/orders?limit=50", cookie), env, {});
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.total, 3);
  assert.equal(data.pending, 2);
  const byId = Object.fromEntries(data.orders.map(o => [o.id, o]));
  assert.equal(byId.b.status, "confirmed");
  assert.equal(byId.b.status_at, 123);
  assert.equal(byId.a.status, "pending");
});

test("la migración 0003 solo acepta pending, confirmed o rejected", () => {
  const env = makeEnv();
  const sql =
    "INSERT INTO orders (id, slug, created_at, total, currency, client_name, client_phone, delivery_mode, items, status) " +
    "VALUES (?, 'pizza', 1, 1, 'USD', 'A', '099', 'delivery', '[]', ?)";
  const insert = (id, status) => () => env.DB.raw.prepare(sql).run(id, status);
  assert.throws(insert("x", "pagado"), /CHECK/);
  ["pending", "confirmed", "rejected"].forEach((status, i) => assert.doesNotThrow(insert("ok-" + i, status)));
});

test("confirmar entrega y rechazar: estados, grant/reject al club, idempotencia y errores", async () => {
  const { env, calls } = creditEnv(), ctx = makeCtx(), cookie = await session(env);
  for (const id of ["ord-1", "ord-2"]) {
    await panel.fetch(jsonRequest("/panel/o", order(id)), env, ctx);
    await ctx.settle();
  }
  calls.length = 0;
  let response = await panel.fetch(jsonRequest("/panel/api/orders/ord-1/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ["id", "status", "status_at"]);
  await ctx.settle();
  assert.equal(row(env, "ord-1").status, "confirmed");
  assert.ok(Number(row(env, "ord-1").status_at) > 0);
  assert.deepEqual(calls.map(c => [c.url, c.method]), [["https://loyalty/admin/pizza/credits/ord-1/grant", "POST"]]);
  assert.equal(calls[0].headers.authorization, "Bearer loy-token");

  // Repetir el mismo estado no duplica la llamada al club.
  response = await panel.fetch(jsonRequest("/panel/api/orders/ord-1/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  await ctx.settle();
  assert.equal(calls.length, 1);

  // Rechazar (con confirmación visual en la UI) y luego intentar confirmar el mismo pedido.
  response = await panel.fetch(jsonRequest("/panel/api/orders/ord-2/reject", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  await ctx.settle();
  assert.equal(row(env, "ord-2").status, "rejected");
  assert.deepEqual(calls[1].url, "https://loyalty/admin/pizza/credits/ord-2/reject");
  response = await panel.fetch(jsonRequest("/panel/api/orders/ord-2/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "estado_invalido" });
  await ctx.settle();
  assert.equal(calls.length, 2);

  // Pedido inexistente, de otro menú o sin sesión.
  response = await panel.fetch(jsonRequest("/panel/api/orders/nadie/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "pedido_no_existe" });
  env.DB.raw.prepare("INSERT INTO orders (id, slug, created_at, total, currency, client_name, client_phone, delivery_mode, items) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("ajeno", "otro", Date.now(), 1, "USD", "Otro", "099", "delivery", "[]");
  response = await panel.fetch(jsonRequest("/panel/api/orders/ajeno/reject", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 404);
  response = await panel.fetch(jsonRequest("/panel/api/orders/ord-1/confirm", {}), env, ctx);
  assert.equal(response.status, 401);
});

test("si el club falla al confirmar, el estado local igual cambia (silencioso)", async () => {
  const { env } = creditEnv(), ctx = makeCtx(), cookie = await session(env);
  await panel.fetch(jsonRequest("/panel/o", order()), env, ctx);
  await ctx.settle();
  env.LOYALTY = { fetch: async () => { throw new Error("club caído"); } };
  const response = await panel.fetch(jsonRequest("/panel/api/orders/ord-1/confirm", {}, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  await ctx.settle();
  assert.equal(row(env, "ord-1").status, "confirmed");
});

test("PATCH /loyalty escribe y borra config.club sin tocar el resto del menú", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "Pizza", club: { label: "Viejo" } } }), cookie = await session(env);
  const patch = body => panel.fetch(jsonRequest("/panel/api/loyalty", body, { method: "PATCH", headers: { cookie } }), env, {});

  let response = await patch({ enabled: true, club: { visible: true, label: "  Únete al club  " } });
  assert.equal(response.status, 200);
  let config = await env.MENUS.get("pizza:config", "json");
  assert.deepEqual(config.club, { label: "Únete al club" });
  assert.equal(config.store_name, "Pizza");

  // Sin `club` en el body no se toca la clave (compatibilidad con guardados viejos).
  response = await patch({ stamps_goal: 9 });
  assert.equal(response.status, 200);
  assert.deepEqual((await env.MENUS.get("pizza:config", "json")).club, { label: "Únete al club" });

  // Etiqueta vacía ⇒ texto por defecto.
  await patch({ club: { visible: true, label: "" } });
  assert.deepEqual((await env.MENUS.get("pizza:config", "json")).club, { label: "Únete al club" });

  // Botón oculto o club apagado ⇒ se borra config.club y el resto del menú queda igual.
  await patch({ club: { visible: false, label: "Únete al club" } });
  config = await env.MENUS.get("pizza:config", "json");
  assert.equal("club" in config, false);
  assert.equal(config.store_name, "Pizza");
  await patch({ enabled: true, club: { visible: true, label: "Juega" } });
  assert.deepEqual((await env.MENUS.get("pizza:config", "json")).club, { label: "Juega" });
  await patch({ enabled: false, club: { visible: true, label: "Juega" } });
  assert.equal("club" in (await env.MENUS.get("pizza:config", "json")), false);

  // Validación estricta.
  for (const club of [{ visible: "sí" }, { visible: true, label: "x".repeat(41) }, [], "texto", { visible: true, extra: 1 }]) {
    response = await patch({ club });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "campo_invalido", campo: "club" });
  }
});

test("play_mode se valida, persiste y por defecto es game", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  const patch = body => panel.fetch(jsonRequest("/panel/api/loyalty", body, { method: "PATCH", headers: { cookie } }), env, {});

  // Sin config previa, el GET público ya declara el modo por defecto.
  let response = await panel.fetch(withSession("/panel/api/loyalty", cookie), env, {});
  assert.equal((await response.json()).play_mode, "game");

  response = await patch({ play_mode: "stamps" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).play_mode, "stamps");
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).play_mode, "stamps");
  response = await panel.fetch(withSession("/panel/api/loyalty", cookie), env, {});
  assert.equal((await response.json()).play_mode, "stamps");

  // Un guardado que no manda play_mode lo conserva.
  await patch({ stamps_goal: 12 });
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).play_mode, "stamps");

  for (const value of ["otro", "", 1, null, true]) {
    response = await patch({ play_mode: value });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "campo_invalido", campo: "play_mode" });
  }
  await patch({ play_mode: "game" });
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).play_mode, "game");
});

test("la página incluye las pantallas nuevas, los dos QR y mantiene el contrato de estilo", () => {
  const html = renderPage({ slug: "demo", host: "demo.craft-systems.com" });
  for (const text of [
    "Tus códigos QR", "QR del menú", "para mesas y redes", "QR del club", "para caja y mostrador",
    "Descargar PNG", "Confirmar entrega", "Rechazar", "sin confirmar", "Estado",
    "Confirma tus pedidos. Solo los pedidos web de entrega participan en el club.",
    "Mostrar botón del club en el menú", "Texto del botón", "Únete al club",
    "Sello + juego (recomendado)", "Solo sellos",
  ]) assert.ok(html.includes(text), `incluye ${text}`);
  assert.ok(html.includes('origin + "/club"'), "el QR del club apunta a /club");
  assert.match(html, /drawQR\(cv, url, false\)/, "la vista previa no repite el texto (va como HTML debajo)");
  assert.match(html, /drawQR\(tmp, url, true, title\)/, "el PNG descargable lleva el texto bajo el código");
  assert.match(html, /setOrderState\(o, "confirm"\)/);
  assert.match(html, /setOrderState\(o, "reject"\)/);
  assert.match(html, /play_mode: playMode\.value/);
  assert.match(html, /club: \{ visible: clubOn\.checked, label: clubText\.value\.trim\(\) \}/);
  assert.equal(html.includes("http://"), false, "sin http:// literal");
  assert.equal(/innerHTML/.test(html), false, "sin innerHTML");
  for (const src of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])) {
    assert.doesNotThrow(() => new Function(src));
  }
});
