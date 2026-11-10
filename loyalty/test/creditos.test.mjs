import assert from "node:assert/strict";
import test from "node:test";
import { handleAdmin, handleApi } from "../src/api.js";
import { STAMPS_PRIZE_ID, normalizeConfig } from "../src/contract.js";
import { makeCtx, makeD1, makeKV } from "./helpers.mjs";

const SLUG = "club-creditos", SECRET = "secreto-creditos", PHONE = "593991234567", DAY = 86_400_000;
const enc = new TextEncoder();
const hash = async value =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");

async function fixture(overrides = {}, menu = { location: { sedes: [{ lat: -0.18, lng: -78.48 }] } }) {
  return {
    env: { DB: makeD1(), MENUS: makeKV(), SESSION_SECRET: SECRET, ADMIN_TOKEN: "admin" },
    ctx: makeCtx(),
    site: {
      slug: SLUG,
      menuCfg: { store_name: "Club Créditos", ...menu },
      cfg: normalizeConfig({
        enabled: true,
        cooldown_hours: 12,
        stamps_goal: 3,
        prizes: [],
        lose_weight: 1,
        staff_pin_hash: await hash(`${SLUG}:1234`),
        ...overrides,
      }),
    },
  };
}
function req(path, { method = "GET", body, cookie } = {}) {
  return new Request(`https://${SLUG}.craft-systems.com/club/api/${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const api = (fx, path, opts) => handleApi(req(path, opts), fx.env, fx.ctx, fx.site);
function cookies(response) {
  return (
    response.headers
      .get("set-cookie")
      ?.split(/, (?=club_[sd]=)/)
      .map(x => x.split(";")[0])
      .join("; ") || ""
  );
}
// Mantiene el club_d de la primera visita (el dispositivo no cambia al repetir login).
async function login(fx, phone = "0991234567", oldCookie) {
  const r = await api(fx, "login", { method: "POST", cookie: oldCookie, body: { name: "Ana", phone } }),
    fresh = cookies(r);
  return {
    r,
    cookie: fresh.includes("club_d=") || !oldCookie?.includes("club_d=") ? fresh : `${fresh}; ${oldCookie.match(/club_d=[^;]+/)[0]}`,
    body: await r.json(),
  };
}
function admin(fx, path, { method = "GET", body, slug = SLUG } = {}) {
  return handleAdmin(
    new Request(`https://loyalty.example/admin/${slug}/${path}`, {
      method,
      headers: { authorization: "Bearer admin", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    fx.env,
    fx.ctx,
  );
}
async function addStaff(fx, name, pin) {
  const r = await admin(fx, "staff", { method: "POST", body: { name, pin } });
  assert.equal(r.status, 201);
  return r.json();
}
function seedCredit(fx, { id = crypto.randomUUID(), order = id, phone = PHONE, status = "granted", created = Date.now() } = {}) {
  fx.env.DB.raw
    .prepare(
      "INSERT INTO credits (id,slug,phone,order_id,source,status,created_at,granted_at,granted_by) VALUES (?,?,?,?,'delivery',?,?,?,'owner')",
    )
    .run(id, SLUG, phone, order, status, created, status === "granted" ? created : null);
  return id;
}

test("normalizeConfig: play_mode válido, default y basura", () => {
  assert.equal(normalizeConfig({}).play_mode, "game");
  assert.equal(normalizeConfig({ play_mode: "stamps" }).play_mode, "stamps");
  assert.equal(normalizeConfig({ play_mode: "game" }).play_mode, "game");
  assert.equal(normalizeConfig({ play_mode: "ruleta" }).play_mode, "game");
  assert.equal(normalizeConfig(null).play_mode, "game");
});

test("Me expone play_mode y los contadores de créditos en cero por defecto", async () => {
  const fx = await fixture();
  const session = await login(fx);
  assert.equal(session.body.program.play_mode, "game");
  assert.deepEqual(session.body.credits, { granted: 0, pending: 0 });
});

test("alta de crédito: idempotente por pedido, tope de uno por teléfono cada 24 h y listado filtrado", async () => {
  const fx = await fixture();
  let r = await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-1", phone: "0991234567" } });
  assert.equal(r.status, 201);
  const created = await r.json();
  assert.equal(created.order_id, "pedido-1");
  assert.equal(created.phone, PHONE); // normalizePhone
  assert.equal(created.source, "delivery");
  assert.equal(created.status, "pending");
  assert.equal(created.granted_at, null);

  // Repetir el mismo pedido devuelve el mismo crédito sin consumir el tope diario.
  r = await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-1", phone: "+593 99 123 4567" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, created.id);

  r = await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-2", phone: "0991234567" } });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "limite_diario");
  // Otro teléfono del mismo local sí entra.
  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-3", phone: "0992222222" } })).status, 201);
  // El mismo order_id en otro local es un crédito distinto (UNIQUE por slug).
  assert.equal(
    (await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-1", phone: "0991234567" }, slug: "otro-club" })).status,
    201,
  );

  // Pasadas 24 h el tope se libera.
  fx.env.DB.raw.prepare("UPDATE credits SET created_at = ? WHERE order_id = 'pedido-1'").run(Date.now() - DAY - 1000);
  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: "pedido-4", phone: "0991234567" } })).status, 201);

  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: "x/y", phone: "0991234567" } })).status, 400);
  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: "ok", phone: "123" } })).status, 400);
  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: "", phone: "0991234567" } })).status, 400);

  r = await admin(fx, "credits?status=pending");
  const listed = await r.json();
  assert.equal(listed.total, 3); // el crédito del otro local no se mezcla
  assert.ok(listed.items.every(x => x.status === "pending"));
  assert.equal((await (await admin(fx, "credits")).json()).total, 3);
  assert.equal((await admin(fx, "credits?status=inventado")).status, 400);
  assert.equal((await admin(fx, "credits", { method: "POST", body: { order_id: 1.5, phone: "0994444444" } })).status, 400);
  // El panel manda orders.id numérico: se normaliza a texto y se puede liberar por la misma ruta.
  r = await admin(fx, "credits", { method: "POST", body: { order_id: 77, phone: "0993333333" } });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).order_id, "77");
  r = await admin(fx, "credits/77/grant", { method: "POST" });
  assert.equal((await r.json()).status, "granted");
  // Sin token no hay acceso.
  const denied = await handleAdmin(new Request(`https://loyalty.example/admin/${SLUG}/credits`), fx.env, fx.ctx);
  assert.equal(denied.status, 401);
});

test("grant/reject: pending→granted por el dueño, idempotentes y sin resucitar rechazados", async () => {
  const fx = await fixture();
  await admin(fx, "credits", { method: "POST", body: { order_id: "a", phone: "0991234567" } });
  await admin(fx, "credits", { method: "POST", body: { order_id: "b", phone: "0992222222" } });

  let r = await admin(fx, "credits/a/grant", { method: "POST" });
  assert.equal(r.status, 200);
  const granted = await r.json();
  assert.equal(granted.status, "granted");
  assert.equal(granted.granted_by, "owner");
  assert.ok(granted.granted_at > 0);
  // Repetir grant no rompe el panel (doble click).
  assert.equal((await (await admin(fx, "credits/a/grant", { method: "POST" })).json()).granted_at, granted.granted_at);

  r = await admin(fx, "credits/b/reject", { method: "POST" });
  assert.equal((await r.json()).status, "rejected");
  assert.equal((await admin(fx, "credits/b/reject", { method: "POST" })).status, 200);
  r = await admin(fx, "credits/b/grant", { method: "POST" });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "estado_invalido");
  assert.equal((await admin(fx, "credits/no-existe/grant", { method: "POST" })).status, 404);
  assert.equal((await admin(fx, "credits/no-existe/reject", { method: "POST" })).status, 404);
});

test("el PIN de mesero libera los pendientes del teléfono en la misma jugada", async () => {
  const fx = await fixture({ cooldown_hours: 0 });
  const staff = await addStaff(fx, "Mesa 1", "12345");
  await admin(fx, "credits", { method: "POST", body: { order_id: "pin-1", phone: "0991234567" } });
  await admin(fx, "credits", { method: "POST", body: { order_id: "pin-2", phone: "0992222222" } });

  const session = await login(fx);
  const before = await (await api(fx, "me", { cookie: session.cookie })).json();
  assert.deepEqual(before.credits, { granted: 0, pending: 1 });

  const r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", pin: "12345" } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).me.credits, { granted: 1, pending: 0 });

  const rows = fx.env.DB.raw.prepare("SELECT order_id,status,granted_by,granted_at FROM credits ORDER BY order_id").all();
  assert.equal(rows[0].status, "granted");
  assert.equal(rows[0].granted_by, staff.id);
  assert.ok(rows[0].granted_at > 0);
  assert.equal(rows[1].status, "pending"); // otro teléfono no se toca
  assert.equal(rows[1].granted_by, null);
});

test("uso del crédito: sin presencia ni cooldown, consume el más viejo, sin_creditos al agotarse", async () => {
  const fx = await fixture({ stamps_goal: 99 });
  const now = Date.now();
  seedCredit(fx, { id: "c-viejo", order: "viejo", created: now - 2000 });
  seedCredit(fx, { id: "c-nuevo", order: "nuevo", created: now - 1000 });

  const session = await login(fx);
  assert.deepEqual(session.body.credits, { granted: 2, pending: 0 });

  // Una visita normal deja el cooldown del teléfono y del dispositivo activo.
  let r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", pin: "1234" } });
  assert.equal(r.status, 200);
  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", pin: "1234" } });
  assert.equal(r.status, 429);

  // Con crédito se juega desde cualquier lugar, sin PIN ni coordenadas y sin cooldown.
  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.me.customer.stamps, 2);
  assert.deepEqual(body.me.credits, { granted: 1, pending: 0 });
  assert.equal(fx.env.DB.raw.prepare("SELECT order_id FROM credits WHERE status = 'used'").get().order_id, "viejo");
  let play = fx.env.DB.raw.prepare("SELECT via,lat,lng,staff_id,game FROM plays ORDER BY id DESC").get();
  assert.equal(play.via, "credit");
  assert.equal(play.game, "wheel");
  assert.equal(play.lat, null);
  assert.equal(play.staff_id, null);

  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.deepEqual(body.me.credits, { granted: 0, pending: 0 });
  assert.equal(fx.env.DB.raw.prepare("SELECT order_id FROM credits WHERE status = 'used' ORDER BY used_at DESC LIMIT 1").get().order_id, "nuevo");

  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "sin_creditos" });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 3);
});

test("un crédito pendiente no se puede usar y no se consume al fallar", async () => {
  const fx = await fixture({ prizes: [{ id: "agotado", label: "Agotado", weight: 1, stock: 0 }], lose_weight: 0 });
  seedCredit(fx, { id: "p", order: "pendiente", status: "pending" });
  const session = await login(fx);
  let r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "sin_creditos" });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);
  assert.equal(fx.env.DB.raw.prepare("SELECT status FROM credits").get().status, "pending");
});

test("carrera de crédito: la misma jugada no se entrega dos veces", async () => {
  const fx = await fixture({ stamps_goal: 99 });
  seedCredit(fx, { id: "unico", order: "unico" });
  const session = await login(fx);
  const batch = fx.env.DB.batch;
  // Otro request consume el crédito justo antes de confirmar el batch.
  fx.env.DB.batch = async statements => {
    fx.env.DB.raw.prepare("UPDATE credits SET status = 'used', used_at = ? WHERE id = 'unico'").run(Date.now());
    return batch(statements);
  };
  const r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "sin_creditos" });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);
  assert.equal(fx.env.DB.raw.prepare("SELECT visits FROM customers").get().visits, 0);
});

test("los créditos esperan por el teléfono y aparecen al unirse al club", async () => {
  const fx = await fixture();
  await admin(fx, "credits", { method: "POST", body: { order_id: "espera-1", phone: "0998765432" } });
  await admin(fx, "credits/espera-1/grant", { method: "POST" });
  seedCredit(fx, { id: "espera-2", order: "espera-2", phone: "593998765432", status: "pending" });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM customers").get().n, 0);

  const session = await login(fx, "0998765432");
  assert.equal(session.body.credits.granted, 1);
  assert.equal(session.body.credits.pending, 1);

  const r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).me.credits, { granted: 0, pending: 1 });
});

test("modo stamps: solo 'stamp', sin sorteo y premio de tarjeta al completar", async () => {
  const fx = await fixture({
    play_mode: "stamps",
    cooldown_hours: 0,
    stamps_goal: 2,
    lose_weight: 0,
    prizes: [{ id: "cafe", label: "Café", weight: 1 }],
    stamps_reward: { label: "Postre gratis", expires_days: 30 },
  });
  const session = await login(fx);
  assert.equal(session.body.program.play_mode, "stamps");

  let r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", pin: "1234" } });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: "juego_invalido" });

  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "stamp", pin: "1234" } });
  assert.equal(r.status, 200);
  let body = await r.json();
  // Sin sorteo: aunque hay premio con peso y lose_weight=0, no hay segmento ni recompensa de juego.
  assert.deepEqual(body.result, {
    segment_index: -1,
    won: false,
    prize: null,
    reward_id: null,
    card_completed: false,
    stamps_reward_id: null,
  });
  assert.equal(body.me.customer.stamps, 1);
  const play = fx.env.DB.raw.prepare("SELECT game,prize_id,reward_id,via FROM plays").get();
  assert.equal(play.game, "stamp");
  assert.equal(play.prize_id, null);
  assert.equal(play.reward_id, null);
  assert.equal(play.via, "pin");

  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "stamp", pin: "1234" } });
  body = await r.json();
  assert.equal(body.result.card_completed, true);
  assert.ok(body.result.stamps_reward_id);
  assert.equal(body.me.customer.stamps, 0);
  assert.equal(body.me.customer.cards_completed, 1);
  const rewards = fx.env.DB.raw.prepare("SELECT source,prize_id FROM rewards").all();
  assert.equal(rewards.length, 1);
  assert.equal(rewards[0].source, "stamps");
  assert.equal(rewards[0].prize_id, STAMPS_PRIZE_ID);

  // El crédito también sirve en modo sellos: suma sello sin sorteo y sin presencia.
  seedCredit(fx, { id: "s-c", order: "s-c" });
  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "stamp", credit: true } });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.me.customer.stamps, 1);
  assert.deepEqual(body.me.credits, { granted: 0, pending: 0 });
  assert.equal(fx.env.DB.raw.prepare("SELECT via FROM plays ORDER BY id DESC").get().via, "credit");
});
