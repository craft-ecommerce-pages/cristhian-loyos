import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handleAdmin, handleApi, pickSegment } from "../src/api.js";
import { MAX_PIN_FAILS, STAMPS_PRIZE_ID, normalizeConfig } from "../src/contract.js";
import { makeCtx, makeD1, makeKV } from "./helpers.mjs";

const SLUG = "cafe-prueba";
const PHONE = "593991234567";
const SECRET = "secreto-de-pruebas";

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function fixture(overrides = {}, menuOverrides = {}) {
  const cfg = normalizeConfig({
    enabled: true,
    games: ["wheel", "scratch"],
    prizes: [{ id: "cafe", label: "Café gratis", weight: 30 }],
    lose_weight: 70,
    stamps_goal: 3,
    stamps_reward: { label: "Postre gratis", expires_days: 10 },
    cooldown_hours: 12,
    radius_m: 150,
    phone_country: "593",
    staff_pin_hash: await sha256(`${SLUG}:1234`),
    review_url: "https://example.com/review",
    terms: "Una visita por persona",
    ...overrides,
  });
  const menuCfg = {
    store_name: "Café Prueba",
    logo: "https://example.com/logo.png",
    theme_primary: "#112233",
    theme_accent: "#fedcba",
    location: { sedes: [{ lat: -0.180653, lng: -78.467834 }] },
    ...menuOverrides,
  };
  return {
    env: { DB: makeD1(), MENUS: makeKV(), SESSION_SECRET: SECRET, ADMIN_TOKEN: "admin-secreto" },
    site: { slug: SLUG, cfg, menuCfg },
    ctx: makeCtx(),
  };
}

function apiRequest(path, { method = "GET", body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  return new Request(`https://${SLUG}.craft-systems.com/club/api/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callApi(fx, path, options) {
  return handleApi(apiRequest(path, options), fx.env, fx.ctx, fx.site);
}

async function login(fx, name = "Ana", phone = "0991234567") {
  const response = await callApi(fx, "login", { method: "POST", body: { name, phone } });
  assert.equal(response.status, 200);
  const cookies = response.headers.get("set-cookie").split(/, (?=club_[sd]=)/).map(value => value.split(";")[0]);
  return { response, cookie: cookies.join("; "), me: await response.json() };
}

function adminRequest(path, { method = "GET", body, token = "admin-secreto" } = {}) {
  const headers = token == null ? {} : { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://loyalty.example/admin/${SLUG}/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function callAdmin(fx, path, options) {
  return handleAdmin(adminRequest(path, options), fx.env, fx.ctx);
}

async function seedCustomer(db, {
  slug = SLUG, phone = PHONE, name = "Ana", stamps = 0, visits = 0,
  cards = 0, lastPlay = null, wallet = 0, created = Date.now(),
} = {}) {
  await db.prepare(`INSERT INTO customers
    (slug, phone, name, stamps, visits, cards_completed, last_play_at, wallet_saved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(slug, phone, name, stamps, visits, cards, lastPlay, wallet, created).run();
}

async function seedReward(db, {
  id = crypto.randomUUID(), slug = SLUG, phone = PHONE, prize = "cafe", label = "Café gratis",
  source = "game", status = "active", fails = 0, created = Date.now(), expires = null, redeemed = null,
} = {}) {
  await db.prepare(`INSERT INTO rewards
    (id, slug, phone, prize_id, label, source, status, pin_fails, created_at, expires_at, redeemed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, slug, phone, prize, label, source, status, fails, created, expires, redeemed).run();
  return id;
}

describe("pickSegment", () => {
  test("respeta pesos, extremos y total vacío", () => {
    const segs = [{ weight: 1 }, { weight: 3 }, { weight: 6 }];
    assert.equal(pickSegment(segs, () => 0), 0);
    assert.equal(pickSegment(segs, () => 0.1), 1);
    assert.equal(pickSegment(segs, () => 0.3999), 1);
    assert.equal(pickSegment(segs, () => 0.4), 2);
    assert.equal(pickSegment(segs, () => 1), 2);
    assert.equal(pickSegment([{ weight: 0 }, { weight: -2 }], () => 0), -1);
  });
});

describe("API del cliente", () => {
  test("login valida, normaliza, hace upsert y emite una cookie endurecida", async () => {
    const fx = await fixture();
    let response = await callApi(fx, "login", { method: "POST", body: { name: "  ", phone: "0991234567" } });
    assert.deepEqual(await response.json(), { error: "nombre_requerido" });
    response = await callApi(fx, "login", { method: "POST", body: { name: "x".repeat(61), phone: "0991234567" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).customer.name.length, 60);
    response = await callApi(fx, "login", { method: "POST", body: { name: "Ana", phone: "123" } });
    assert.deepEqual(await response.json(), { error: "telefono_invalido" });

    const first = await login(fx, "  Ana Pérez  ");
    assert.match(first.response.headers.get("set-cookie"), /^club_s=593991234567\.[0-9a-f]{64}; Path=\/club; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000, club_d=[A-Za-z0-9_-]{43}; Path=\/club; HttpOnly; Secure; SameSite=Lax; Max-Age=63072000$/);
    assert.equal(first.response.headers.get("cache-control"), "no-store");
    assert.equal(first.response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(first.me.customer, { name: "Ana Pérez", phone: PHONE, birthday: null, stamps: 0, visits: 0, cards_completed: 0 });
    assert.equal(first.me.program.store_name, "Café Prueba");
    assert.equal(first.me.program.geo_required, true);
    assert.equal(first.me.program.segments.at(-1).label, "Sigue participando");
    assert.equal(first.me.wallet_url, null);

    const second = await login(fx, "Ana Actualizada", "+593 99 123 4567");
    assert.equal(second.me.customer.name, "Ana Actualizada");
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM customers").get().n, 1);

    response = await callApi(fx, "logout", { method: "POST" });
    assert.equal(response.status, 204);
    assert.match(response.headers.get("set-cookie"), /^club_s=;.*Max-Age=0, club_d=/);
  });

  test("GET /me entrega programa público sin sesión y rechaza cookies forjadas o de otro slug", async () => {
    const fx = await fixture();
    let response = await callApi(fx, "me");
    assert.equal(response.status, 401);
    const anonymous = await response.json();
    assert.equal(anonymous.error, "sin_sesion");
    assert.equal(anonymous.program.stamps_goal, 3);

    const { cookie } = await login(fx);
    // Rompe la firma de forma determinista (el último char puede ser ya "0").
    response = await callApi(fx, "me", { cookie: cookie.replace(/.$/, (c) => (c === "0" ? "1" : "0")) });
    assert.equal(response.status, 401);

    const otherSite = { ...fx.site, slug: "otro-local" };
    response = await handleApi(apiRequest("me", { cookie }), fx.env, fx.ctx, otherSite);
    assert.equal(response.status, 401);

    response = await callApi(fx, "me", { cookie });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).customer.phone, PHONE);
  });

  test("play valida juego, ubicación, distancia y cooldown antes de mutar", async () => {
    const fx = await fixture({ prizes: [], lose_weight: 10 });
    const { cookie } = await login(fx);
    let response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "dados", lat: -0.180653, lng: -78.467834 } });
    assert.deepEqual(await response.json(), { error: "juego_invalido" });
    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel" } });
    assert.deepEqual(await response.json(), { error: "sin_ubicacion" });
    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", lat: 0, lng: 0 } });
    assert.deepEqual(await response.json(), { error: "fuera_de_rango" });

    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", lat: -0.180653, lng: -78.467834 } });
    assert.equal(response.status, 200);
    const played = await response.json();
    assert.equal(played.result.won, false);
    assert.equal(played.result.segment_index, 0);
    assert.equal(played.me.customer.stamps, 1);
    assert.equal(played.me.customer.visits, 1);
    assert.equal(played.me.can_play, false);
    const row = fx.env.DB.raw.prepare("SELECT * FROM plays").get();
    assert.equal(row.via, "geo");
    assert.equal(row.lat, -0.180653);

    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "scratch", pin: "1234" } });
    assert.equal(response.status, 429);
    assert.equal((await response.json()).next_play_at, row.created_at + 12 * 3_600_000);
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 1);
  });

  test("play usa PIN válido con sedes y exige PIN cuando ninguna sede tiene coordenadas", async () => {
    const fx = await fixture({ cooldown_hours: 0, prizes: [], lose_weight: 1 });
    const { cookie } = await login(fx);
    let response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "0000" } });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "pin_invalido" });
    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    assert.equal(response.status, 200);
    assert.equal(fx.env.DB.raw.prepare("SELECT via FROM plays").get().via, "pin");

    const nogeo = await fixture({ cooldown_hours: 0, prizes: [], lose_weight: 1 }, { location: { sedes: [{ nombre: "Centro" }] } });
    const session = await login(nogeo);
    response = await callApi(nogeo, "play", { method: "POST", cookie: session.cookie, body: { game: "scratch" } });
    assert.deepEqual(await response.json(), { error: "pin_requerido" });
    response = await callApi(nogeo, "play", { method: "POST", cookie: session.cookie, body: { game: "scratch", pin: "1234" } });
    assert.equal(response.status, 200);
    assert.equal(nogeo.env.DB.raw.prepare("SELECT via FROM plays").get().via, "pin");
  });

  test("sorteo excluye stock agotado y representa sin premio cuando todo tiene peso cero", async () => {
    const fx = await fixture({
      cooldown_hours: 0,
      prizes: [
        { id: "agotado", label: "Agotado", weight: 100, stock: 1 },
        { id: "vigente", label: "Vigente", weight: 1, stock: 1 },
      ],
      lose_weight: 0,
      stamps_goal: 99,
    }, { location: {} });
    await seedReward(fx.env.DB, { id: "emitido", prize: "agotado", label: "Agotado" });
    const { cookie } = await login(fx);
    let response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    let body = await response.json();
    assert.equal(body.result.segment_index, 1);
    assert.deepEqual(body.result.prize, { id: "vigente", label: "Vigente" });
    assert.ok(body.result.reward_id);
    response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    body = await response.json();
    assert.deepEqual(body.result, {
      segment_index: -1, won: false, prize: null, reward_id: null, card_completed: false, stamps_reward_id: null,
    });
  });

  test("carrera de stock revierte la jugada y no entrega el último premio dos veces", async () => {
    const fx = await fixture({ prizes: [{ id: "cafe", label: "Café", weight: 1, stock: 1 }], lose_weight: 0 }, { location: {} });
    const { cookie } = await login(fx);
    const batch = fx.env.DB.batch;
    fx.env.DB.batch = async statements => {
      await seedReward(fx.env.DB, { id: "premio-paralelo" });
      return batch(statements);
    };
    const response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "premio_agotado");
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 0);
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM rewards").get().n, 1);
    assert.equal(fx.env.DB.raw.prepare("SELECT visits FROM customers WHERE slug = ? AND phone = ?").get(SLUG, PHONE).visits, 0);
  });

  test("carrera de cooldown revierte el batch completo", async () => {
    const fx = await fixture({ prizes: [], lose_weight: 1 }, { location: {} });
    const { cookie } = await login(fx);
    const batch = fx.env.DB.batch;
    fx.env.DB.batch = async statements => {
      fx.env.DB.raw.prepare("UPDATE customers SET last_play_at = ? WHERE slug = ? AND phone = ?").run(Date.now(), SLUG, PHONE);
      return batch(statements);
    };
    const response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    assert.equal(response.status, 429);
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM plays").get().n, 0);
  });

  test("una visita ganadora completa tarjeta, reinicia sellos y emite ambos premios", async () => {
    const fx = await fixture({
      cooldown_hours: 0,
      prizes: [{ id: "cafe", label: "Café", weight: 1, expires_days: 2 }],
      lose_weight: 0,
      stamps_goal: 2,
      stamps_reward: { label: "Postre", expires_days: 5 },
    }, { location: {} });
    const { cookie } = await login(fx);
    await fx.env.DB.prepare("UPDATE customers SET stamps = 1 WHERE slug = ? AND phone = ?").bind(SLUG, PHONE).run();
    const before = Date.now();
    const response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
    const body = await response.json();
    assert.equal(body.result.won, true);
    assert.equal(body.result.card_completed, true);
    assert.ok(body.result.reward_id);
    assert.ok(body.result.stamps_reward_id);
    assert.equal(body.me.customer.stamps, 0);
    assert.equal(body.me.customer.cards_completed, 1);
    assert.equal(body.me.rewards.length, 2);
    const rows = fx.env.DB.raw.prepare("SELECT * FROM rewards ORDER BY source").all();
    assert.deepEqual(rows.map(row => row.source), ["game", "stamps"]);
    assert.equal(rows.find(row => row.source === "stamps").prize_id, STAMPS_PRIZE_ID);
    assert.ok(rows.find(row => row.source === "game").expires_at >= before + 2 * 86_400_000);
    const play = fx.env.DB.raw.prepare("SELECT reward_id FROM plays").get();
    assert.equal(play.reward_id, body.result.reward_id);
  });

  test("Me calcula expirados, prioriza activos y limita la lista a 50", async () => {
    const fx = await fixture();
    const { cookie } = await login(fx);
    const now = Date.now();
    await seedReward(fx.env.DB, { id: "expired", created: now + 100, expires: now - 1 });
    await seedReward(fx.env.DB, { id: "active", created: now });
    for (let i = 0; i < 50; i++) await seedReward(fx.env.DB, { id: `used-${i}`, status: "redeemed", created: now - i - 1, redeemed: now });
    const response = await callApi(fx, "me", { cookie });
    const body = await response.json();
    assert.equal(body.rewards.length, 50);
    assert.equal(body.rewards[0].id, "active");
    assert.equal(body.rewards.find(reward => reward.id === "expired")?.status, "expired");
  });

  test("redeem aísla dueño, registra fallos, bloquea, canjea una vez y detecta vencidos", async () => {
    const fx = await fixture();
    const { cookie } = await login(fx);
    const rewardId = await seedReward(fx.env.DB, { id: "premio-bloqueable" });
    await seedCustomer(fx.env.DB, { phone: "593999999999", name: "Otra" });
    const foreignId = await seedReward(fx.env.DB, { id: "ajeno", phone: "593999999999" });
    let response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: foreignId, pin: "1234" } });
    assert.equal(response.status, 404);

    for (let attempt = 1; attempt <= MAX_PIN_FAILS; attempt++) {
      response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: rewardId, pin: "9999" } });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).attempts_left, MAX_PIN_FAILS - attempt);
    }
    response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: rewardId, pin: "1234" } });
    assert.equal(response.status, 423);
    assert.deepEqual(await response.json(), { error: "bloqueado" });

    const goodId = await seedReward(fx.env.DB, { id: "canjeable" });
    response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: goodId, pin: "1234" } });
    assert.equal(response.status, 200);
    const redeemed = await response.json();
    assert.equal(redeemed.reward.status, "redeemed");
    assert.ok(redeemed.reward.redeemed_at);
    response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: goodId, pin: "1234" } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "ya_canjeado" });

    const expiredId = await seedReward(fx.env.DB, { id: "vencido", expires: Date.now() - 1 });
    response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: expiredId, pin: "1234" } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "vencido" });
  });

  test("redeem informa programa sin PIN y wallet informa indisponibilidad", async () => {
    const fx = await fixture({ staff_pin_hash: null });
    const { cookie } = await login(fx);
    const rewardId = await seedReward(fx.env.DB);
    let response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: rewardId, pin: "1234" } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "sin_pin" });
    response = await callApi(fx, "wallet", { cookie });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "wallet_no_disponible" });
  });
});

describe("API admin", () => {
  test("exige Bearer exacto y valida el slug", async () => {
    const fx = await fixture();
    let response = await callAdmin(fx, "stats", { token: null });
    assert.equal(response.status, 401);
    response = await callAdmin(fx, "stats", { token: "incorrecto" });
    assert.equal(response.status, 401);
    response = await handleAdmin(new Request("https://loyalty.example/admin/Slug_Invalido/stats", {
      headers: { authorization: "Bearer admin-secreto" },
    }), fx.env, fx.ctx);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "slug_invalido" });
  });

  test("stats agrega el período y by_day en UTC-5 sin mezclar tenants", async () => {
    const fx = await fixture();
    const now = Date.now();
    const today = new Date(now - 5 * 3_600_000).toISOString().slice(0, 10);
    await seedCustomer(fx.env.DB, { visits: 2, cards: 1, created: now - 1000 });
    await seedCustomer(fx.env.DB, { phone: "593992222222", name: "Beto", visits: 1, created: now - 2000 });
    await seedCustomer(fx.env.DB, { slug: "otro", phone: "593993333333", created: now });
    await fx.env.DB.prepare(`INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'nogeo', ?)`)
      .bind(SLUG, PHONE, now - 500).run();
    await fx.env.DB.prepare(`INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'nogeo', ?)`)
      .bind("otro", "593993333333", now).run();
    await seedReward(fx.env.DB, { id: "r1", created: now - 400, status: "redeemed", redeemed: now - 100 });
    await seedReward(fx.env.DB, { id: "r-antiguo", created: now - 2 * 86_400_000, status: "redeemed", redeemed: now - 50 });

    const response = await callAdmin(fx, "stats?days=1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      customers: 2,
      new_customers: 2,
      plays: 1,
      returning_customers: 1,
      rewards_issued: 1,
      rewards_redeemed: 2,
      cards_completed: 1,
      by_day: [{ day: today, plays: 1, new_customers: 2 }],
    });
    const invalid = await callAdmin(fx, "stats?days=0");
    assert.equal(invalid.status, 400);
  });

  test("customers busca nombre/teléfono, pagina, cuenta activos y da detalle con 50 jugadas", async () => {
    const fx = await fixture();
    const now = Date.now();
    await seedCustomer(fx.env.DB, { name: "Ángela Café", visits: 3, wallet: 1, lastPlay: now });
    await seedCustomer(fx.env.DB, { phone: "593992222222", name: "Beto", lastPlay: now - 1 });
    await seedReward(fx.env.DB, { id: "activo" });
    await seedReward(fx.env.DB, { id: "expirado", expires: now - 1 });
    for (let i = 0; i < 55; i++) {
      await fx.env.DB.prepare(`INSERT INTO plays (slug, phone, game, via, created_at)
        VALUES (?, ?, 'wheel', 'nogeo', ?)`).bind(SLUG, PHONE, now - i).run();
    }

    let response = await callAdmin(fx, "customers?q=Caf%C3%A9&limit=1&offset=0");
    let body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(body.items[0].phone, PHONE);
    assert.equal(body.items[0].active_rewards, 1);
    assert.equal(body.items[0].wallet_saved, 1);
    response = await callAdmin(fx, "customers?q=222222");
    body = await response.json();
    assert.equal(body.items[0].name, "Beto");
    response = await callAdmin(fx, `customers/${PHONE}`);
    body = await response.json();
    assert.equal(body.customer.name, "Ángela Café");
    assert.equal(body.rewards.find(row => row.id === "expirado").status, "expired");
    assert.equal(body.plays.length, 50);
    assert.ok(body.plays[0].created_at > body.plays.at(-1).created_at);
    response = await callAdmin(fx, "customers/593000000000");
    assert.equal(response.status, 404);
    response = await callAdmin(fx, "customers?limit=0");
    assert.equal(response.status, 400);
  });

  test("campaigns notifica solo pases guardados, persiste resultado y lista las últimas 20", async () => {
    const fx = await fixture();
    await seedCustomer(fx.env.DB, { wallet: 1 });
    await seedCustomer(fx.env.DB, { phone: "593992222222", wallet: 0 });
    let response = await callAdmin(fx, "campaigns", { method: "POST", body: { title: "  Promo  ", body: "  Ven hoy  " } });
    assert.equal(response.status, 200);
    // El stub de Wallet simula un fallo por destinatario; el workstream B reemplaza esta implementación.
    assert.deepEqual(await response.json(), { sent: 0, failed: 1 });
    const stored = fx.env.DB.raw.prepare("SELECT * FROM campaigns").get();
    assert.equal(stored.title, "Promo");
    assert.equal(stored.body, "Ven hoy");
    response = await callAdmin(fx, "campaigns");
    assert.equal((await response.json()).length, 1);

    response = await callAdmin(fx, "campaigns", { method: "POST", body: { title: "x".repeat(61), body: "ok" } });
    assert.equal(response.status, 400);
    response = await callAdmin(fx, "campaigns", { method: "POST", body: { title: "ok", body: "x".repeat(501) } });
    assert.equal(response.status, 400);

    for (let i = 0; i < 25; i++) await fx.env.DB.prepare(
      "INSERT INTO campaigns (slug, title, body, created_at) VALUES (?, ?, 'b', ?)",
    ).bind(SLUG, `c-${i}`, Date.now() + i).run();
    response = await callAdmin(fx, "campaigns");
    const campaigns = await response.json();
    assert.equal(campaigns.length, 20);
    assert.equal(campaigns[0].title, "c-24");
  });

  test("campaigns rechaza más de 900 destinatarios sin insertar ni notificar", async () => {
    const fx = await fixture();
    const insert = fx.env.DB.raw.prepare(`INSERT INTO customers
      (slug, phone, name, wallet_saved, created_at) VALUES (?, ?, 'Cliente', 1, ?)`);
    for (let i = 0; i < 901; i++) insert.run(SLUG, `593${String(i).padStart(9, "0")}`, Date.now());
    const response = await callAdmin(fx, "campaigns", { method: "POST", body: { title: "Promo", body: "Texto" } });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "demasiados_destinatarios" });
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) AS n FROM campaigns").get().n, 0);
  });
});

test("PIN con rate limit: play y redeem responden 429 sin evaluar el PIN", async () => {
  const fx = await fixture({ cooldown_hours: 0, prizes: [], lose_weight: 1 });
  const keys = [];
  fx.env.PIN_LIMITER = { limit: async ({ key }) => (keys.push(key), { success: keys.length <= 1 }) };
  const { cookie } = await login(fx);
  let response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "0000" } });
  assert.equal(response.status, 403);
  response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", pin: "1234" } });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "demasiados_intentos" });
  fx.env.DB.raw.prepare(`INSERT INTO rewards (id, slug, phone, prize_id, label, source, created_at) VALUES ('r1', ?, '593991234567', 'cafe', 'Café', 'game', 1)`).run(SLUG);
  response = await callApi(fx, "redeem", { method: "POST", cookie, body: { reward_id: "r1", pin: "1234" } });
  assert.equal(response.status, 429);
  assert.equal(fx.env.DB.raw.prepare("SELECT status, pin_fails FROM rewards WHERE id = 'r1'").get().pin_fails, 0);
  assert.ok(keys.every(k => k === `${SLUG}:sin-ip`));
  // geo sin PIN no consume el limitador
  const before = keys.length;
  response = await callApi(fx, "play", { method: "POST", cookie, body: { game: "wheel", lat: -0.180653, lng: -78.467834 } });
  assert.equal(response.status, 200);
  assert.equal(keys.length, before);
});
