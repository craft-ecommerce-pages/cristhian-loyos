// Conteo del panel (B): POST /panel/e siempre 204 + statsFor (serie con ceros, clamp, club null).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleEvent, statsFor } from "../src/events.js";
import { dayOf } from "../src/contract.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const DAY_MS = 86_400_000;
const URL_E = "https://demo.craft-systems.com/panel/e";
const site = { slug: "demo", host: "demo.craft-systems.com" };
const post = body => new Request(URL_E, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const all = env => env.DB.raw.prepare("SELECT slug, day, views, orders FROM events_daily ORDER BY slug, day").all().map(r => ({ ...r }));

test("POST /panel/e: 204 y upsert acumulativo por (slug, día)", async () => {
  const env = makeEnv(), ctx = makeCtx();
  for (const t of ["view", "view", "order"]) assert.equal((await handleEvent(post({ t }), env, ctx, site)).status, 204);
  await ctx.settle();
  assert.deepEqual(all(env), [{ slug: "demo", day: dayOf(Date.now()), views: 2, orders: 1 }]);

  // El slug sale del host (site), nunca del body → otro menú acumula en su propia fila.
  await handleEvent(post({ t: "order", slug: "demo" }), env, ctx, { slug: "otro", host: "otro.craft-systems.com" });
  await ctx.settle();
  assert.deepEqual(all(env).map(r => [r.slug, r.views, r.orders]), [["demo", 2, 1], ["otro", 0, 1]]);
});

test("POST /panel/e: 204 siempre y sin escribir con método, body o tamaño inválidos", async () => {
  const env = makeEnv(), ctx = makeCtx();
  const requests = [
    new Request(URL_E, { method: "GET" }),
    new Request(URL_E, { method: "PUT", body: JSON.stringify({ t: "view" }) }),
    post("{no es json"),
    post("null"),
    post("[]"),
    post({}),
    post({ t: "purchase" }),
    post({ t: ["view"] }),
    post({ t: null }),
    // cuerpo enorme: se descarta por content-length (el handler solo acepta JSON chiquito)
    new Request(URL_E, { method: "POST", headers: { "content-length": "5000" }, body: JSON.stringify({ t: "view" }) }),
  ];
  for (const req of requests) {
    const res = await handleEvent(req, env, ctx, site);
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  await ctx.settle();
  assert.deepEqual(all(env), []);   // nada escrito

  // D1 caído tampoco rompe el beacon: sigue siendo 204.
  const roto = { ...env, DB: { prepare() { throw new Error("D1 caído"); } } };
  assert.equal((await handleEvent(post({ t: "view" }), roto, makeCtx(), site)).status, 204);
});

test("statsFor: serie completa de días (con ceros) desde hoy-hace days-1 hasta hoy, en hora Ecuador", async () => {
  const env = makeEnv(), ctx = makeCtx();
  await handleEvent(post({ t: "view" }), env, ctx, site);
  await handleEvent(post({ t: "order" }), env, ctx, site);
  await ctx.settle();
  // Evento de hace 2 días: el handler solo escribe hoy, la fila vieja entra directo al SQLite de prueba.
  env.DB.raw.prepare("INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, ?, ?)")
    .run("demo", dayOf(Date.now() - 2 * DAY_MS), 5, 0);

  const s = await statsFor(env, "demo", 4);
  assert.deepEqual(s.days.map(d => d.day), [3, 2, 1, 0].map(i => dayOf(Date.now() - i * DAY_MS)));
  assert.deepEqual(s.days.map(d => [d.views, d.orders]), [[0, 0], [5, 0], [0, 0], [1, 1]]);
  assert.deepEqual(s.totals, { views: 6, orders: 1 });
  assert.deepEqual(s.loyalty, { customers: 0, plays: 0 });

  // Los días fuera de la ventana y las filas de otro slug no cuentan.
  env.DB.raw.prepare("INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, ?, ?)").run("demo", dayOf(Date.now() - 40 * DAY_MS), 100, 100);
  env.DB.raw.prepare("INSERT INTO events_daily (slug, day, views, orders) VALUES (?, ?, ?, ?)").run("otro", dayOf(Date.now()), 9, 9);
  assert.deepEqual((await statsFor(env, "demo", 4)).totals, { views: 6, orders: 1 });
});

test("statsFor: days se limita a 1..90 y un valor inválido cae a 30", async () => {
  const env = makeEnv();
  for (const [input, expected] of [[1, 1], [0, 1], [-3, 1], [45.7, 45], [90, 90], [200, 90], ["7", 7], ["abc", 30], [undefined, 30], [NaN, 30], [null, 30]]) {
    assert.equal((await statsFor(env, "demo", input)).days.length, expected, `days=${String(input)}`);
  }
  // Sin eventos también devuelve la serie completa en ceros.
  const vacio = await statsFor(env, "nadie", 30);
  assert.equal(vacio.days.length, 30);
  assert.deepEqual(vacio.totals, { views: 0, orders: 0 });
  // D1 caído ⇒ ceros, no excepción.
  const roto = { ...env, DB: { prepare() { throw new Error("D1 caído"); } } };
  assert.deepEqual((await statsFor(roto, "demo", 2)).totals, { views: 0, orders: 0 });
});

test("statsFor: loyalty {customers, plays} y null si falla, no es ok, no hay binding o falta el token", async () => {
  const seen = [];
  const ok = { ...makeEnv(), LOYALTY: { fetch: async (url, init) => { seen.push([url, init.headers.authorization]); return Response.json({ customers: 42, plays: 7, rewards_issued: 3 }); } } };
  assert.deepEqual((await statsFor(ok, "demo", 1)).loyalty, { customers: 42, plays: 7 });
  assert.deepEqual(seen, [["https://loyalty/admin/demo/stats", "Bearer loy-token"]]);   // solo esos dos campos salen al panel

  const loy = l => statsFor({ ...makeEnv(), LOYALTY: l }, "demo", 1).then(s => s.loyalty);
  assert.equal(await loy(undefined), null);                                          // sin binding
  assert.equal(await loy({}), null);                                                 // binding sin fetch
  assert.equal(await loy({ fetch: async () => { throw new Error("red"); } }), null);  // red caída
  assert.equal(await loy({ fetch: async () => new Response("no", { status: 503 }) }), null);
  assert.equal(await loy({ fetch: async () => new Response("{roto") }), null);         // JSON inválido
  const sinToken = { ...makeEnv(), LOYALTY_ADMIN_TOKEN: "" };
  assert.equal((await statsFor(sinToken, "demo", 1)).loyalty, null);
});
