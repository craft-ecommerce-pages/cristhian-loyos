// CJ2: Modo caja — PIN del mesero (cookie caja_s, 12 h), proxy a craft-loyalty y página SSR.
// LOYALTY se mockea como en el resto de los tests del panel (service binding env.LOYALTY).
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { renderPage } from "../src/page.js";
import { CAJA_ALPHABET, renderCajaPage, parseCardCode, signCajaSession } from "../src/caja.js";
import { parseCardCode as loyaltyParseCardCode } from "../../loyalty/src/contract.js";
import { makeEnv, makeLimiter } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const site = { slug: "pizza", host };
const CODE = "ABCD2345EF";
const CARD = {
  name: "Ana Torres", phone_tail: "4567", stamps: 3, stamps_goal: 8, visits: 4, cards_completed: 1,
  last_play_at: 1, next_visit_at: null, credits: { granted: 0, pending: 0 }, rewards: [],
};
const past = () => Date.now() - 1000;

const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(body),
});
const withCookie = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});

// Club falso: respeta el contrato de CJ1 y anota cada llamada (URL relativa, método, body y headers).
function makeLoyalty(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname.replace(/^\/admin\/pizza\//, "");
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method: init.method || "GET", body, headers: init.headers || {} });
    const custom = handler ? handler({ path, body, calls }) : null;
    if (custom) return custom;
    if (path === "staff/verify") {
      const ok = body && body.pin === "1234";
      return Response.json(ok ? { staff: { id: "st-ana", name: "Ana" } } : { error: "pin_invalido" }, { status: ok ? 200 : 403 });
    }
    if (path === `card/${CODE}`) return Response.json({ card: CARD, play_mode: "stamps" });
    if (path === `card/${CODE}/visit`) {
      return Response.json({ result: { card_completed: false, stamps_reward_id: null }, card: { ...CARD, stamps: 4 } });
    }
    if (path === "rewards/rw-1/redeem") return Response.json({ reward: { id: "rw-1", status: "redeemed" } });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  return { fetch, calls };
}

function envWith({ kv = {}, handler } = {}) {
  const env = makeEnv({
    "pizza:config": { store_name: "Pizzería Ñandú" },
    "pizza:loyalty": { enabled: true },
    ...kv,
  });
  const loyalty = makeLoyalty(handler);
  env.LOYALTY = loyalty;
  return { env, loyalty };
}

async function ownerCookie(env) {
  const owner = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const credentials = await owner.json();
  const login = await panel.fetch(jsonRequest("/panel/api/login", credentials), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

test("login con PIN: cookie caja_s de 12 h y el club valida el PIN", async () => {
  const { env, loyalty } = envWith();
  const response = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin: "1234" }), env, {});
  assert.equal(response.status, 200);
  // Al navegador solo le llega el nombre: ni staff_id ni el PIN vuelven al cliente.
  assert.deepEqual(await response.json(), { staff: { name: "Ana" } });
  const header = response.headers.get("set-cookie");
  assert.match(header, /^caja_s=[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]+;/);
  assert.match(header, /; Path=\/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
  assert.equal(loyalty.calls.length, 1);
  assert.equal(loyalty.calls[0].path, "staff/verify");
  assert.equal(loyalty.calls[0].method, "POST");
  assert.deepEqual(loyalty.calls[0].body, { pin: "1234" });
  assert.equal(loyalty.calls[0].headers.authorization, "Bearer loy-token");

  // La cookie abre la ficha del cliente.
  const cookie = header.split(";", 1)[0];
  const card = await panel.fetch(withCookie(`/panel/api/caja/card/${CODE}`, cookie), env, {});
  assert.equal(card.status, 200);
  const data = await card.json();
  assert.equal(data.card.name, "Ana Torres");
  assert.equal(data.play_mode, "stamps");

  // Y la página SSR arranca directo en el escáner (sin volver a pedir el PIN).
  const page = await renderCajaPage(withCookie("/panel/caja", cookie), env, site);
  assert.match(page, /"ready":true/);
});

test("PIN incorrecto: 403 pin_invalido, sin cookie y sin llamar al club con PINs mal formados", async () => {
  const { env, loyalty } = envWith();
  for (const pin of ["12", "1234567", "abcd", ""]) {
    const response = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin }), env, {});
    assert.equal(response.status, 403, JSON.stringify(pin));
    assert.deepEqual(await response.json(), { error: "pin_invalido" });
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(loyalty.calls.length, 0);

  const rejected = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin: "9999" }), env, {});
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: "pin_invalido" });
  assert.equal(rejected.headers.get("set-cookie"), null);
  assert.deepEqual(loyalty.calls.map(call => call.path), ["staff/verify"]);
});

test("login con PIN respeta LOGIN_LIMITER con la misma clave slug+IP del panel", async () => {
  const { env, loyalty } = envWith();
  const keys = [];
  env.LOGIN_LIMITER = { limit: async ({ key }) => { keys.push(key); return { success: false }; } };
  const response = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin: "1234" }), env, {});
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "demasiados_intentos" });
  assert.deepEqual(keys, ["pizza:sin-ip"]);
  assert.equal(loyalty.calls.length, 0);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("cookie de caja inválida, vencida o de otro menú → 401 sin_sesion", async () => {
  const { env } = envWith();
  const valid = await signCajaSession(env, "pizza", "st-ana");
  const [staff, exp, signature] = valid.split(".");
  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  const expired = await signCajaSession(env, "pizza", "st-ana", past());
  const otherSlug = await signCajaSession(env, "otro", "st-ana");
  const cookies = [
    null,
    "caja_s=",
    "caja_s=basura",
    `caja_s=${staff}.${exp}.${flipped}`,                  // firma alterada
    `caja_s=${staff}.${Number(exp) + 60_000}.${signature}`, // vencimiento estirado
    `caja_s=${expired}`,                                  // vencida de verdad
    `caja_s=${otherSlug}`,                                // firmada para otro menú
    `caja_s=${staff}.99999999999999999999.${signature}`,  // formato raro
  ];
  for (const cookie of cookies) {
    const options = cookie ? { headers: { cookie } } : {};
    const response = await panel.fetch(request(`/panel/api/caja/card/${CODE}`, options), env, {});
    assert.equal(response.status, 401, String(cookie));
    assert.deepEqual(await response.json(), { error: "sin_sesion" });
  }
  const fresh = await panel.fetch(withCookie(`/panel/api/caja/card/${CODE}`, `caja_s=${valid}`), env, {});
  assert.equal(fresh.status, 200, "la cookie buena sí entra");
});

test("el navegador no puede inyectar staff_id: el proxy manda el de la sesión", async () => {
  const { env, loyalty } = envWith();
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "st-ana")}`;
  let response = await panel.fetch(jsonRequest(`/panel/api/caja/card/${CODE}/visit`, { staff_id: "owner", pin: "1234" }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(loyalty.calls.find(call => call.path.endsWith("/visit")).body, { staff_id: "st-ana" });

  loyalty.calls.length = 0;
  response = await panel.fetch(jsonRequest("/panel/api/caja/rewards/rw-1/redeem", { staff_id: "owner" }, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(loyalty.calls[0].body, { staff_id: "st-ana" });
  assert.deepEqual([loyalty.calls[0].path, loyalty.calls[0].method], ["rewards/rw-1/redeem", "POST"]);
});

test("el dueño con sesión del panel entra directo con staff_id owner, sin PIN", async () => {
  const { env, loyalty } = envWith();
  const cookie = await ownerCookie(env);
  let response = await panel.fetch(withCookie(`/panel/api/caja/card/${CODE}`, cookie), env, {});
  assert.equal(response.status, 200);
  response = await panel.fetch(jsonRequest(`/panel/api/caja/card/${CODE}/visit`, {}, { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(loyalty.calls.find(call => call.path.endsWith("/visit")).body, { staff_id: "owner" });
  assert.equal(loyalty.calls.filter(call => call.path === "staff/verify").length, 0, "no pide PIN");

  const html = await renderCajaPage(withCookie("/panel/caja", cookie), env, site);
  assert.match(html, /"ready":true/);
  assert.match(html, /"locked":false/);
  // wrangler (esbuild keepNames) mete __name() en las funciones serializadas: sin este shim la caja no arranca.
  assert.ok(html.indexOf("var __name=") < html.indexOf("cajaMain"), "shim __name antes del runtime");
});

test("función tarjeta apagada: 402 plan_requerido y el club ni se toca", async () => {
  const { env, loyalty } = envWith();
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "st-ana")}`;
  env.DB.raw.prepare("INSERT INTO panel_features (slug, loyalty, source, updated_at) VALUES (?, ?, ?, ?)")
    .run("pizza", 0, "legacy", Date.now());

  const requests = [
    request(`/panel/api/caja/card/${CODE}`, { headers: { cookie } }),
    jsonRequest(`/panel/api/caja/card/${CODE}/visit`, {}, { headers: { cookie } }),
    jsonRequest("/panel/api/caja/rewards/rw-1/redeem", {}, { headers: { cookie } }),
  ];
  for (const item of requests) {
    const response = await panel.fetch(item, env, {});
    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), { error: "plan_requerido" });
  }
  const login = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin: "1234" }), env, {});
  assert.equal(login.status, 402);
  assert.equal(loyalty.calls.length, 0, "no llama al club con la función apagada");

  const html = await renderCajaPage(request("/panel/caja", { headers: { cookie } }), env, site);
  assert.match(html, /"locked":true/);
  assert.match(html, /"ready":false/);
});

test("la página de Modo caja escapa el nombre del negocio y no usa innerHTML", async () => {
  const { env } = envWith({ kv: { "pizza:config": { store_name: "<b>Pizzería</b>" } } });
  const html = await renderCajaPage(request("/panel/caja"), env, site);
  assert.equal(html.includes("innerHTML"), false);
  assert.equal(html.includes("document.write"), false);
  assert.equal(html.includes("<b>Pizzería</b>"), false);
  assert.ok(html.includes("&lt;b&gt;Pizzería&lt;/b&gt;"));
  assert.ok(html.includes("textContent"), "la ficha se pinta con textContent");
  assert.match(html, /window\.__cajaCode/);
  assert.match(html, /__CAJA__=\{"slug":"pizza"/);
  assert.match(html, /"ready":false/);

  // La ruta responde HTML del panel, sin caché y sin iframes.
  const response = await panel.fetch(request("/panel/caja"), env, {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("cache-control"), /no-cache/);
});

test("cooldown, visita pendiente, tarjeta inexistente y club caído se reenvían tal cual", async () => {
  const scenarios = [
    [({ path }) => path.endsWith("/visit") ? Response.json({ error: "cooldown", next_play_at: 1_792_000_000_000 }, { status: 429 }) : null, 429, "cooldown"],
    [({ path }) => path.endsWith("/visit") ? Response.json({ error: "visita_pendiente" }, { status: 409 }) : null, 409, "visita_pendiente"],
    [({ path }) => path.startsWith("card/") ? Response.json({ error: "tarjeta_no_encontrada" }, { status: 404 }) : null, 404, "tarjeta_no_encontrada"],
  ];
  for (const [handler, status, error] of scenarios) {
    const { env } = envWith({ handler });
    const cookie = `caja_s=${await signCajaSession(env, "pizza", "st-ana")}`;
    const path = status === 404 ? `/panel/api/caja/card/${CODE}` : `/panel/api/caja/card/${CODE}/visit`;
    const options = { headers: { cookie } };
    const response = status === 404
      ? await panel.fetch(request(path, options), env, {})
      : await panel.fetch(jsonRequest(path, {}, options), env, {});
    assert.equal(response.status, status);
    assert.equal((await response.json()).error, error);
  }
  // Sin binding o con el club caído: 503 club_no_disponible (nunca excepción).
  const { env } = envWith();
  delete env.LOYALTY;
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "st-ana")}`;
  const down = await panel.fetch(withCookie(`/panel/api/caja/card/${CODE}`, cookie), env, {});
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: "club_no_disponible" });
  const login = await panel.fetch(jsonRequest("/panel/api/caja/login", { pin: "1234" }), env, {});
  assert.equal(login.status, 503);
});

test("logout borra la cookie de caja", async () => {
  const { env } = envWith();
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "st-ana")}`;
  const response = await panel.fetch(jsonRequest("/panel/api/caja/logout", {}, { headers: { cookie } }), env, {});
  assert.equal(response.status, 204);
  assert.match(response.headers.get("set-cookie"), /^caja_s=; Path=\/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
});

test("parseCardCode acepta el código suelto o la URL de la tarjeta", () => {
  assert.equal(parseCardCode(CODE), CODE);
  assert.equal(parseCardCode(CAJA_ALPHABET.slice(0, 10).toLowerCase()), CAJA_ALPHABET.slice(0, 10));
  assert.equal(parseCardCode(`  ${CODE.toLowerCase()} `), CODE);
  assert.equal(parseCardCode("ABCD 2345 EF"), CODE);
  assert.equal(parseCardCode("ABCD-2345-EF"), CODE);
  assert.equal(parseCardCode(`https://pizza.craft-systems.com/club/t/${CODE}`), CODE);
  assert.equal(parseCardCode(`https://pizza.craft-systems.com/club/t/${CODE.toLowerCase()}/`), CODE);
  for (const bad of ["", null, undefined, "ABC", "ABCD2345E", "ABCD2345EFG", "ABCD2345E0", "ABCD2345EI",
    `https://pizza.craft-systems.com/club/t/${CODE}?utm=qr`, "https://pizza.craft-systems.com/club",
    "https://pizza.craft-systems.com/club/t/"]) {
    assert.equal(parseCardCode(bad), null, JSON.stringify(bad));
  }
});

// El panel no puede importar el parseo del club (se serializa con String() al navegador); el test
// fija la paridad para que un cambio en el contrato de CJ1 no deje dos comportamientos distintos.
test("parseCardCode del panel coincide con el contrato del club", () => {
  const cases = [CODE, CODE.toLowerCase(), "  ABCD 2345 EF  ", "ABCD-2345-EF", "HOLA MUNDO", "ABCD0234EF",
    `https://pizza.craft-systems.com/club/t/${CODE}`, `https://pizza.craft-systems.com/club/t/${CODE}/`,
    `https://pizza.craft-systems.com/club/t/${CODE}?utm=qr`, "https://pizza.craft-systems.com/club/t/",
    "pizza.craft-systems.com/club/t/" + CODE, "", null, undefined];
  for (const text of cases) assert.equal(parseCardCode(text), loyaltyParseCardCode(text), JSON.stringify(text));
});

test("Fidelidad → Meseros ofrece la tarjeta Modo caja con su QR", () => {
  const html = renderPage(site);
  assert.ok(html.includes("Modo caja"));
  assert.ok(html.includes("/panel/caja"));
  assert.ok(html.includes("Ábrelo en el celular del mesero. Entra con su PIN y escanea la tarjeta del cliente."));
});
