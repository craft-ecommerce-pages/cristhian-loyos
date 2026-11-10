// A3: administración completa del club desde el panel edge.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(body),
});
async function session(env) {
  const owner = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const credentials = await owner.json();
  const login = await panel.fetch(jsonRequest("/panel/api/login", credentials), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const withSession = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});

test("los proxies de fidelidad usan el slug de la sesión y codifican sus rutas", async () => {
  const env = makeEnv({ "pizza:config": {} }), seen = [];
  env.LOYALTY = { fetch: async (url, init) => {
    seen.push({ url, init });
    return Response.json(url.includes("campaigns") ? [] : { ok: true });
  } };
  const cookie = await session(env);
  let response = await panel.fetch(withSession("/panel/api/loyalty/stats?days=7&slug=otro", cookie), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(withSession("/panel/api/loyalty/customers?q=Ana&limit=2&offset=1", cookie), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(withSession("/panel/api/loyalty/customers/%2B593%2099", cookie), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(seen.map(call => call.url), [
    "https://loyalty/admin/pizza/stats?days=7",
    "https://loyalty/admin/pizza/customers?q=Ana&limit=2&offset=1",
    "https://loyalty/admin/pizza/customers/%2B593%2099",
  ]);
  assert.ok(seen.every(call => call.init.headers.get("authorization") === "Bearer loy-token"));
});

test("los proxies de meseros conservan el Bearer interno y el método", async () => {
  const env = makeEnv({ "pizza:config": {} }), seen = [];
  env.LOYALTY = { fetch: async (url, init) => {
    seen.push({ url, init, body: init.body });
    const status = init.method === "DELETE" ? 204 : init.method === "POST" ? 201 : 200;
    return new Response(init.method === "DELETE" ? null : JSON.stringify(init.method === "GET" ? { items: [] } : { ok: true }), { status, headers: { "content-type": "application/json" } });
  } };
  const cookie = await session(env);
  let response = await panel.fetch(withSession("/panel/api/loyalty/staff", cookie), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(jsonRequest("/panel/api/loyalty/staff", { name: "Ana", pin: "1234" }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 201);
  response = await panel.fetch(jsonRequest("/panel/api/loyalty/staff/staff-1", { pin: "4321" }, { method: "PUT", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(jsonRequest("/panel/api/loyalty/staff/staff-1", {}, { method: "DELETE", headers: { cookie } }), env, {});
  assert.equal(response.status, 204);
  assert.deepEqual(seen.map(call => [call.url, call.init.method || "GET"]), [
    ["https://loyalty/admin/pizza/staff", "GET"],
    ["https://loyalty/admin/pizza/staff", "POST"],
    ["https://loyalty/admin/pizza/staff/staff-1", "PUT"],
    ["https://loyalty/admin/pizza/staff/staff-1", "DELETE"],
  ]);
  assert.equal(seen[1].body, JSON.stringify({ name: "Ana", pin: "1234" }));
  assert.ok(seen.every(call => call.init.headers.get("authorization") === "Bearer loy-token"));
});

test("el club no se expone sin binding y limita campañas recientes", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  delete env.LOYALTY;
  let response = await panel.fetch(withSession("/panel/api/loyalty/stats", cookie), env, {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "club_no_disponible" });

  const recent = Date.now() - 1_000, calls = [];
  env.LOYALTY = { fetch: async url => {
    calls.push(url);
    return Response.json([{ id: 7, created_at: recent }]);
  } };
  response = await panel.fetch(jsonRequest("/panel/api/loyalty/campaigns", { title: "Hola", body: "Oferta" }, {
    headers: { cookie },
  }), env, {});
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "campana_reciente", next_at: recent + 86_400_000 });
  assert.deepEqual(calls, ["https://loyalty/admin/pizza/campaigns"]);
});

test("la configuración completa se normaliza estrictamente y nunca revela el hash del PIN", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  let response = await panel.fetch(jsonRequest("/panel/api/loyalty", {
    enabled: true, games: ["wheel"], lose_weight: 25, cooldown_hours: 4, stamps_goal: 9,
    stamps_reward: { label: "Postre", expires_days: 30 },
    prizes: [{ id: "cafe", label: "Café", weight: 75, stock: null, expires_days: 7 }],
    review_url: "https://example.com/resena", terms: "Una participación por visita.", pin: "1234",
  }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.equal(config.prizes[0].stock, null);
  assert.equal(config.stamps_reward.expires_days, 30);
  assert.equal("staff_pin_hash" in config, false);
  assert.equal("radius_m" in config, true, "se conserva el contrato público del club");

  response = await panel.fetch(jsonRequest("/panel/api/loyalty", {
    prizes: [{ id: "cafe", label: " Café ", weight: 75 }],
  }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "campo_invalido", campo: "prizes" });
  response = await panel.fetch(jsonRequest("/panel/api/loyalty", { review_url: "http://inseguro.example" }, {
    method: "PATCH", headers: { cookie },
  }), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "campo_invalido", campo: "review_url" });
});

test("require_pin se valida y persiste aunque normalizeConfig aún no lo conozca", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  let response = await panel.fetch(jsonRequest("/panel/api/loyalty", { require_pin: true }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).require_pin, true);
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).require_pin, true);
  response = await panel.fetch(jsonRequest("/panel/api/loyalty", { require_pin: "sí" }, { method: "PATCH", headers: { cookie } }), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "campo_invalido", campo: "require_pin" });
});
