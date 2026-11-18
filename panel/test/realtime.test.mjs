// Tiempo real: Durable Object `OrdersHub`, aviso `notifyOrders` y la ruta
// `GET /panel/api/pos/live`. Sin red: ctx, hub y sockets falsos.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import panel from "../src/index.js";
import { OrdersHub, notifyOrders } from "../src/realtime.js";
import { hashPassword, sha256hex } from "../src/auth.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.example";
const origin = `https://${host}`;
const request = (path, options = {}) => new Request(`${origin}${path}`, options);
const withCookie = (path, cookie, options = {}) => request(path, {
  ...options, headers: { cookie, ...(options.headers || {}) },
});
const jsonBody = (path, value, options = {}) => request(path, {
  method: "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});

/* ── Aviso a la sede ─────────────────────────────────────────────────────── */

test("notifyOrders sin binding o sin sede no hace nada", async () => {
  const env = makeEnv();
  await assert.doesNotReject(notifyOrders(env, "munch", "centro"));
  assert.equal(env.ORDERS_HUB, undefined);

  // Aun con binding, una sede vacía no debe ni resolver el stub.
  const calls = [];
  env.ORDERS_HUB = { idFromName: name => calls.push(name), get: () => calls.push("get") };
  await notifyOrders(env, "munch", "");
  assert.deepEqual(calls, []);
});

test("notifyOrders avisa al hub de la sede y traga los fallos", async () => {
  const env = makeEnv();
  const seen = { idNames: [], gets: [], fetches: [] };
  env.ORDERS_HUB = {
    idFromName: name => { seen.idNames.push(name); return `stub-${name}`; },
    get: id => {
      seen.gets.push(id);
      return { fetch: async (url, init) => { seen.fetches.push({ url, init }); return new Response(null, { status: 204 }); } };
    },
  };

  await notifyOrders(env, "munch", "centro");
  assert.deepEqual(seen.idNames, ["munch:centro"]);
  assert.deepEqual(seen.gets, ["stub-munch:centro"]);
  assert.equal(seen.fetches.length, 1);
  assert.equal(seen.fetches[0].url, "https://hub/notify");
  assert.equal(seen.fetches[0].init.method, "POST");
  // El aviso no puede colgar un cobro: siempre lleva su propio timeout.
  assert.ok(seen.fetches[0].init.signal instanceof AbortSignal);

  // Hub caído: el llamador (pago, creación) no se entera.
  env.ORDERS_HUB.get = () => ({ fetch: async () => { throw new Error("hub caído"); } });
  const warn = console.warn;
  console.warn = () => {};
  try { await assert.doesNotReject(notifyOrders(env, "munch", "centro")); } finally { console.warn = warn; }
});

/* ── Durable Object ──────────────────────────────────────────────────────── */

test("OrdersHub /notify avisa a todos los sockets y responde 204", async () => {
  const sent = [];
  const cerrado = { send: () => { throw new Error("socket cerrado"); } };
  const ctx = { getWebSockets: () => [cerrado, { send: m => sent.push(m) }, { send: m => sent.push(m) }] };
  const hub = new OrdersHub(ctx, {});
  const before = Date.now();

  const response = await hub.fetch(new Request("https://hub/notify", { method: "POST" }));
  assert.equal(response.status, 204);
  assert.equal(sent.length, 2);
  for (const message of sent) {
    const payload = JSON.parse(message);
    // Sin datos del cliente: solo el tipo de aviso y la hora.
    assert.deepEqual(Object.keys(payload).sort(), ["at", "t"]);
    assert.equal(payload.t, "orders");
    assert.ok(payload.at >= before && payload.at <= Date.now());
  }

  const other = await hub.fetch(new Request("https://hub/otra"));
  assert.equal(other.status, 400);
});

test("OrdersHub responde pong al ping e ignora el resto", async () => {
  const hub = new OrdersHub({ getWebSockets: () => [] }, {});
  const out = [];
  const ws = { send: message => out.push(message) };
  await hub.webSocketMessage(ws, "ping");
  await hub.webSocketMessage(ws, "otra-cosa");
  await hub.webSocketError();
  assert.deepEqual(out, ["pong"]);

  // 1005 no se puede enviar: se cierra con 1000; un socket ya cerrado no rompe.
  const closed = [];
  await hub.webSocketClose({ close: code => closed.push(code) }, 1005);
  await hub.webSocketClose({ close: () => { throw new Error("ya cerrado"); } }, 1000);
  assert.deepEqual(closed, [1000]);
});

test("OrdersHub configura la respuesta automática del ping si el runtime la soporta", () => {
  const auto = [];
  const previous = globalThis.WebSocketRequestResponsePair;
  globalThis.WebSocketRequestResponsePair = class {
    constructor(request, response) { this.request = request; this.response = response; }
  };
  try {
    new OrdersHub({ getWebSockets: () => [], setWebSocketAutoResponse: value => auto.push(value) }, {});
  } finally {
    if (previous === undefined) delete globalThis.WebSocketRequestResponsePair;
    else globalThis.WebSocketRequestResponsePair = previous;
  }
  assert.deepEqual(auto.map(pair => [pair.request, pair.response]), [["ping", "pong"]]);
});

/* ── Ruta GET /panel/api/pos/live ────────────────────────────────────────── */

function liveEnv() {
  const env = makeEnv({
    "munch:config": {
      currency: "USD", store_name: "Munch",
      location: {
        sedes: [
          { id: "centro", nombre: "Centro", direccion: "Calle 1" },
          { id: "norte", nombre: "Norte", direccion: "Calle 2" },
        ],
      },
    },
  });
  env.CLIENT_SLUG = "munch";
  return env;
}

async function ownerCookie(env) {
  const owner = await panel.fetch(jsonBody("/admin/munch/owner", { email: "dueno@munch.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(jsonBody("/panel/api/login", await owner.json()), env, {});
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

// Cajero local con PIN real en D1 y solo la sede `centro`.
async function cashierCookie(env, { id = "l_cajero0001", sedes = ["centro"], pin = "2468" } = {}) {
  const now = Date.now();
  env.DB.raw.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('munch', ?, 'Ana', ?, ?, ?, 1, ?, ?)",
  ).run(id, await sha256hex(`munch:${pin}`), await hashPassword(pin), JSON.stringify(sedes), now, now);
  const login = await panel.fetch(jsonBody("/panel/api/mesero/login", { pin }), env, {});
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

test("pos/live: sin sesión, sede inválida y sede sin permiso", async () => {
  const env = liveEnv();
  let response = await panel.fetch(request("/panel/api/pos/live?sede_id=centro"), env, {});
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "sin_sesion" });

  const cookie = await cashierCookie(env);
  response = await panel.fetch(withCookie("/panel/api/pos/live?sede_id=centro%20x", cookie), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "sede_requerida" });

  response = await panel.fetch(withCookie("/panel/api/pos/live", cookie), env, {});
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "sede_requerida" });

  response = await panel.fetch(withCookie("/panel/api/pos/live?sede_id=norte", cookie), env, {});
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "sin_permiso" });
});

test("pos/live: origen ajeno, falta de upgrade y binding ausente", async () => {
  const env = liveEnv();
  const cookie = await ownerCookie(env);
  const live = (headers = {}) => panel.fetch(withCookie("/panel/api/pos/live?sede_id=centro", cookie, { headers }), env, {});

  let response = await live({ origin: "https://otro.example" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "origen_invalido" });

  // Mismo host pero sin WebSocket: no se abre un socket por HTTP normal.
  response = await live({ origin });
  assert.equal(response.status, 426);
  assert.deepEqual(await response.json(), { error: "se_requiere_websocket" });

  response = await live({ upgrade: "websocket" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "tiempo_real_no_disponible" });
});

test("pos/live: con binding entrega el socket de la sede correcta", async () => {
  const env = liveEnv();
  const cookie = await ownerCookie(env);
  const calls = [];
  env.ORDERS_HUB = {
    idFromName: name => { calls.push(["idFromName", name]); return `id-${name}`; },
    get: id => ({
      fetch: async incoming => {
        calls.push(["fetch", id, incoming.url, incoming.headers.get("upgrade")]);
        return new Response("vivo", { status: 200, headers: { "x-hub": "1" } });
      },
    }),
  };

  const response = await panel.fetch(
    withCookie("/panel/api/pos/live?sede_id=norte", cookie, { headers: { origin, upgrade: "WebSocket" } }), env, {},
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-hub"), "1");
  assert.equal(await response.text(), "vivo");
  assert.deepEqual(calls, [
    ["idFromName", "munch:norte"],
    ["fetch", "id-munch:norte", `${origin}/panel/api/pos/live?sede_id=norte`, "WebSocket"],
  ]);
});

/* ── Plantilla y export ──────────────────────────────────────────────────── */

test("plantilla de wrangler y export de OrdersHub", () => {
  const template = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(template, /name = "ORDERS_HUB"/);
  assert.match(template, /class_name = "OrdersHub"/);
  assert.match(template, /tag = "v1-orders-hub"/);
  assert.match(template, /new_sqlite_classes = \["OrdersHub"\]/);

  const entry = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(entry, /export \{ OrdersHub \} from "\.\/realtime\.js";/);
});
