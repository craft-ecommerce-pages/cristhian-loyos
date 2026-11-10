// Demo del panel/mesero: el servidor nunca deja pasar la API real y el navegador trabaja con datos locales.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../src/index.js";
import { demoRuntime, isDemo } from "../src/demo.js";
import { makeEnv } from "./helpers.mjs";

const HOST = "pizza-demo.craft-systems.com";
const kv = {
  "pizza-demo:config": { store_name: "Pizza Demo", currency: "$", categories: { pizzas: "Pizzas" } },
  "pizza-demo:productos": [
    { id: "p1", nombre: "Pizza Margarita", precio: "8.50", categorias: ["pizzas"] },
    { id: "p2", nombre: "Pizza Pepperoni", precio: "9.00", categorias: ["pizzas"] },
  ],
};
const get = (env, path, init) => worker.fetch(new Request(`https://${HOST}${path}`, init), env, { waitUntil() {} });

test("isDemo solo reconoce demo-x y x-demo", () => {
  assert.ok(isDemo("pizza-planet-demo") && isDemo("demo-alitas"));
  assert.ok(!isDemo("demolicion") && !isDemo("pizza-planet") && !isDemo("ademo"));
});

test("en un slug demo la API real responde 403 y el panel no escribe en D1", async () => {
  const env = makeEnv(kv);
  assert.equal((await get(env, "/panel/api/me")).status, 403);
  assert.equal((await get(env, "/panel/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  const html = await (await get(env, "/panel")).text();
  assert.ok(html.indexOf('id="demoData"') < html.indexOf('id="panelData"'));
  assert.match(html, /Pizza Margarita/);
  const mesero = await (await get(env, "/panel/mesero")).text();
  assert.ok(mesero.includes('id="demoData"') && mesero.includes('"boot":null'));
  assert.equal((await get(env, "/panel/caja")).status, 200);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM catalogs").get().n, 0);
  assert.equal(await env.MENUS.get("pizza-demo:loyalty"), null);
});

test("un slug normal sigue con la API real", async () => {
  const env = makeEnv({ "pizza:config": {} });
  const r = await worker.fetch(new Request("https://pizza.craft-systems.com/panel/api/me"), env, {});
  assert.equal(r.status, 401);
});

function browser(seed, storage = new Map()) {
  const real = [];
  const ctx = {
    __DEMO__: seed, Response, URL, Blob, crypto, Date, reloads: 0,
    location: { href: `https://${HOST}/panel`, origin: `https://${HOST}`, reload() { ctx.reloads++; } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async url => { real.push(url); return new Response("{}"); },
    document: { body: { prepend() {} }, createElement: () => ({ style: {}, setAttribute() {}, append() {}, addEventListener() {} }) },
  };
  ctx.window = ctx;
  vm.runInNewContext(`(${String(demoRuntime)})()`, ctx);
  const call = async (path, body, method) => {
    const r = await ctx.fetch("/panel/api/" + path, { method: method || (body ? "POST" : "GET"), body: body && JSON.stringify(body) });
    return { status: r.status, data: r.status === 204 ? null : await r.json(), version: r.headers.get("x-catalog-version") };
  };
  return { call, real, storage, ctx };
}

test("el runtime demo cubre panel y mesero sin tocar la red", async () => {
  const env = makeEnv(kv);
  const html = await (await get(env, "/panel")).text();
  const seed = JSON.parse(/window\.__DEMO__=(.*);\n/.exec(html)[1]);
  const { call, real, storage } = browser(seed);

  assert.equal((await call("me")).data.store.store_name, "Pizza Demo");
  const created = await call("products", { name: "Calzone", price: "7.00", categories: ["pizzas"], if_version: 1 });
  assert.equal(created.status, 201);
  assert.equal(created.version, "2");
  assert.equal((await call("catalog")).data.products.length, 3);

  const orders = (await call("orders?limit=20")).data;
  assert.equal(orders.total, 3);
  assert.equal(orders.pending, 2);
  const manual = await call("mesero/orders", { table_no: "7", items: [{ nombre: "Calzone", qty: 2, precio: 7 }] });
  assert.equal(manual.status, 201);
  assert.equal(manual.data.order.total, 14);
  assert.equal(manual.data.order.number, 4);
  assert.equal((await call(`mesero/orders/${manual.data.order.id}/print`, {})).data.order.print_count, 1);
  const mesa = (await call("mesero/orders?status=pending&limit=50")).data.orders.find(o => o.source === "mesa");
  assert.equal((await call(`mesero/orders/${mesa.id}`, { note: "Sin hielo" }, "PUT")).data.order.note, "Sin hielo");
  assert.equal((await call(`orders/${mesa.id}/confirm`, {})).data.status, "confirmed");
  assert.equal((await call(`mesero/orders/${mesa.id}`, { note: "x" }, "PUT")).status, 409);

  assert.equal((await call("loyalty/staff", { name: "Pedro", pin: "1234" })).status, 409);
  assert.equal((await call("loyalty/staff", { name: "Pedro", pin: "4321" })).status, 201);
  assert.equal((await call("loyalty/campaigns", { title: "Hoy", body: "2x1" })).status, 200);
  assert.equal((await call("loyalty/campaigns", { title: "Otra", body: "x" })).status, 429);
  assert.equal((await call("stats?days=30")).data.days.length, 30);
  assert.equal((await call("loyalty", { pin: "9999" }, "PATCH")).data.pin_set, true);
  assert.ok(!JSON.stringify((await call("loyalty/staff")).data).includes("4321"));

  // Otra pestaña (mesero) ve lo mismo: comparte el localStorage.
  const other = browser(seed, storage);
  assert.equal((await other.call("mesero/orders?status=all&limit=50")).data.orders.length, 4);
  assert.deepEqual(real, []);
});

test("la demo vence y vuelve al estado inicial", async () => {
  const seed = { slug: "x-demo", host: HOST, config: {}, catalog: { version: 1, categories: [], packagings: [], variant_groups: [], products: [] }, loyalty: { enabled: true } };
  const { call, storage, ctx } = browser(seed);
  await call("products", { name: "Algo", price: "1.00" });
  const key = "craft_demo:x-demo", db = JSON.parse(storage.get(key));
  storage.set(key, JSON.stringify({ ...db, exp: Date.now() - 1 }));
  call("catalog");
  await new Promise(r => setTimeout(r, 0));
  assert.equal(ctx.reloads, 1);
  assert.equal(storage.has(key), false);
});
