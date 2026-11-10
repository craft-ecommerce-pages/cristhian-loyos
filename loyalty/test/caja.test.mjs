// Modo caja: tarjeta con código, visitas desde el panel y canje de premios por el mesero.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { handleAdmin, handleApi } from "../src/api.js";
import { cardUrl, normalizeConfig, parseCardCode } from "../src/contract.js";
import { walletSync } from "../src/wallet.js";
import { makeCtx, makeD1, makeKV } from "./helpers.mjs";

const SLUG = "cafe-caja", SECRET = "secreto-caja", PHONE = "593991234567", DAY = 86_400_000;
const ALPHABET = "[23456789ABCDEFGHJKMNPQRSTUVWXYZ]";
const MENU = {
  store_name: "Café Caja",
  logo: "https://example.com/logo.png",
  theme_primary: "#225544",
  location: { sedes: [{ lat: -0.18, lng: -78.48 }] },
};
const enc = new TextEncoder();
const hash = async value =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");

async function fixture(overrides = {}, menu = MENU) {
  const loyalty = {
    enabled: true,
    games: ["wheel", "scratch"],
    prizes: [{ id: "cafe", label: "Café gratis", weight: 1 }],
    lose_weight: 0,
    stamps_goal: 3,
    stamps_reward: { label: "Postre gratis", expires_days: 30 },
    cooldown_hours: 12,
    staff_pin_hash: await hash(`${SLUG}:1234`),
    ...overrides,
  };
  return {
    env: {
      DB: makeD1(),
      MENUS: makeKV({ [`${SLUG}:loyalty`]: loyalty, [`${SLUG}:config`]: menu }),
      SESSION_SECRET: SECRET,
      ADMIN_TOKEN: "admin",
    },
    ctx: makeCtx(),
    site: { slug: SLUG, cfg: normalizeConfig(loyalty), menuCfg: menu },
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
      headers: { authorization: "Bearer admin", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
const visit = (fx, code, body) => admin(fx, `card/${code}/visit`, { method: "POST", body });

function seedCredit(fx, { id = crypto.randomUUID(), order = id, phone = PHONE, status = "pending", source = "delivery" } = {}) {
  const now = Date.now();
  fx.env.DB.raw
    .prepare("INSERT INTO credits (id,slug,phone,order_id,source,status,created_at,granted_at,granted_by) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, SLUG, phone, order, source, status, now, status === "granted" ? now : null, status === "granted" ? "owner" : null);
  return id;
}
function seedReward(fx, { id = crypto.randomUUID(), slug = SLUG, phone = PHONE, label = "Café gratis", status = "active", expires = null } = {}) {
  fx.env.DB.raw
    .prepare("INSERT INTO rewards (id,slug,phone,prize_id,label,source,status,created_at,expires_at) VALUES (?,?,?,'cafe',?,'game',?,?,?)")
    .run(id, slug, phone, label, status, Date.now(), expires);
  return id;
}

test("parseCardCode: código suelto, URL del QR y basura", () => {
  assert.equal(parseCardCode("ABCD2345EF"), "ABCD2345EF");
  assert.equal(parseCardCode("abcd2345ef"), "ABCD2345EF");
  assert.equal(parseCardCode("  ABCD 2345 EF  "), "ABCD2345EF");
  assert.equal(parseCardCode("https://cafe-caja.craft-systems.com/club/t/ABCD2345EF"), "ABCD2345EF");
  assert.equal(parseCardCode("https://cafe-caja.craft-systems.com/club/t/abcd2345ef/"), "ABCD2345EF");
  assert.equal(parseCardCode("cafe.craft-systems.com/club/t/ABCD2345EF"), "ABCD2345EF");
  assert.equal(parseCardCode("https://x.test/club"), null);
  assert.equal(parseCardCode("https://x.test/club/t/ABCD2345EF?utm=qr"), null);
  assert.equal(parseCardCode("ABCD2345E"), null); // nueve caracteres
  assert.equal(parseCardCode("ABCD0234EF"), null); // 0 no forma parte del alfabeto
  assert.equal(parseCardCode("HOLA MUNDO"), null);
  assert.equal(parseCardCode(""), null);
  assert.equal(parseCardCode(null), null);
  assert.equal(cardUrl(SLUG, "ABCD2345EF"), "https://cafe-caja.craft-systems.com/club/t/ABCD2345EF");
});

test("el código de tarjeta se emite al entrar, es estable y único por local", async () => {
  const fx = await fixture();
  const first = await login(fx),
    card = first.body.card;
  assert.match(card.code, new RegExp(`^${ALPHABET}{10}$`));
  assert.equal(card.url, cardUrl(SLUG, card.code));
  assert.equal(card.url, `https://${SLUG}.craft-systems.com/club/t/${card.code}`);

  const again = await login(fx);
  assert.equal(again.body.card.code, card.code, "el código no cambia entre sesiones");
  const other = await login(fx, "0992222222");
  assert.notEqual(other.body.card.code, card.code);
  assert.equal(fx.env.DB.raw.prepare("SELECT card_code FROM customers WHERE phone=?").get(PHONE).card_code, card.code);
  // El índice único lo impide repetir dentro del mismo local.
  assert.throws(
    () => fx.env.DB.raw.prepare("INSERT INTO customers (slug,phone,card_code,created_at) VALUES (?,?,?,?)").run(SLUG, "593990000001", card.code, 1),
    /UNIQUE/,
  );

  // Un cliente anterior a la migración recibe el código en la primera lectura de su ficha.
  fx.env.DB.raw.prepare("UPDATE customers SET card_code=NULL WHERE phone=?").run(PHONE);
  const r = await api(fx, "me", { cookie: again.cookie }),
    me = await r.json();
  assert.equal(r.status, 200);
  assert.match(me.card.code, new RegExp(`^${ALPHABET}{10}$`));
  assert.equal(fx.env.DB.raw.prepare("SELECT card_code FROM customers WHERE phone=?").get(PHONE).card_code, me.card.code);

  // La caja busca sin distinguir mayúsculas y responde 404 si el código no existe.
  assert.equal((await admin(fx, `card/${me.card.code.toLowerCase()}`)).status, 200);
  assert.equal((await admin(fx, "card/ZZZZZZZZZZ")).status, 404);
});

test("modo sellos: la visita de la caja suma sello y completa la tarjeta", async () => {
  const fx = await fixture({ play_mode: "stamps", cooldown_hours: 0, stamps_goal: 2 });
  const staff = await addStaff(fx, "Mesa 1", "12345");
  const session = await login(fx),
    code = session.body.card.code;

  let r = await admin(fx, `card/${code}`);
  assert.equal(r.status, 200);
  let view = await r.json();
  assert.equal(view.play_mode, "stamps");
  assert.equal(view.card.stamps, 0);
  assert.equal(view.card.stamps_goal, 2);

  r = await visit(fx, code, { staff_id: staff.id });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual(body.result, { card_completed: false, stamps_reward_id: null });
  assert.equal(body.card.stamps, 1);
  assert.equal(body.card.visits, 1);
  assert.ok(body.card.last_play_at > 0);

  r = await visit(fx, code, { staff_id: staff.id });
  body = await r.json();
  assert.equal(body.result.card_completed, true);
  assert.ok(body.result.stamps_reward_id);
  assert.equal(body.card.stamps, 0);
  assert.equal(body.card.cards_completed, 1);
  assert.equal(body.card.rewards.length, 1);
  assert.equal(body.card.rewards[0].source, "stamps");

  const play = fx.env.DB.raw.prepare("SELECT game,via,staff_id FROM plays ORDER BY id DESC").get();
  assert.deepEqual({ ...play }, { game: "stamp", via: "scan", staff_id: staff.id });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 2);
});

test("modo juego: la visita crea un crédito scan y el cliente lo juega desde su celular", async () => {
  const fx = await fixture();
  const staff = await addStaff(fx, "Mesa 2", "54321");
  const session = await login(fx),
    code = session.body.card.code;

  let r = await visit(fx, code, { staff_id: staff.id });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.ok(body.credit_id);
  assert.equal(body.card.credits.granted, 1);
  assert.equal(body.card.pending, undefined);
  assert.equal(body.card.stamps, 0, "la caja no suma el sello: lo suma la jugada");
  assert.equal(body.card.last_play_at, null);

  const credit = fx.env.DB.raw.prepare("SELECT * FROM credits WHERE id=?").get(body.credit_id);
  assert.equal(credit.source, "scan");
  assert.equal(credit.status, "granted");
  assert.equal(credit.order_id, `scan:${body.credit_id}`);
  assert.equal(credit.granted_by, staff.id);
  assert.ok(credit.granted_at > 0);
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 0);

  // El flujo existente no cambia: el cliente juega con credit:true desde su celular.
  r = await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } });
  assert.equal(r.status, 200);
  const played = await r.json();
  assert.equal(played.me.customer.stamps, 1);
  assert.deepEqual(played.me.credits, { granted: 0, pending: 0 });
  assert.equal(fx.env.DB.raw.prepare("SELECT via FROM plays ORDER BY id DESC").get().via, "credit");
  assert.equal(fx.env.DB.raw.prepare("SELECT status FROM credits WHERE id=?").get(body.credit_id).status, "used");

  r = await admin(fx, `card/${code}`);
  const view = await r.json();
  assert.equal(view.card.stamps, 1);
  assert.equal(view.card.visits, 1);
  assert.deepEqual(view.card.credits, { granted: 0, pending: 0 });
});

test("cooldown: la segunda visita de la caja responde 429 con la próxima hora", async () => {
  const fx = await fixture();
  const staff = await addStaff(fx, "Mesa 3", "11111");
  const session = await login(fx),
    code = session.body.card.code;

  assert.equal((await visit(fx, code, { staff_id: staff.id })).status, 200);
  let r = await visit(fx, code, { staff_id: staff.id });
  assert.equal(r.status, 429);
  let body = await r.json();
  assert.equal(body.error, "cooldown");
  assert.ok(body.next_play_at > Date.now());

  // Aunque el cliente ya haya jugado, la visita reciente sigue frenando la caja.
  assert.equal((await api(fx, "play", { method: "POST", cookie: session.cookie, body: { game: "wheel", credit: true } })).status, 200);
  r = await visit(fx, code, { staff_id: staff.id });
  assert.equal(r.status, 429);
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM credits WHERE source='scan'").get().n, 1);
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM plays").get().n, 1);
});

test("visita_pendiente: no se entrega otra jugada si el cliente no usó la anterior", async () => {
  const fx = await fixture({ cooldown_hours: 0 });
  const staff = await addStaff(fx, "Mesa 4", "22222");
  const session = await login(fx),
    code = session.body.card.code;

  assert.equal((await visit(fx, code, { staff_id: staff.id })).status, 200);
  const r = await visit(fx, code, { staff_id: staff.id });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "visita_pendiente" });
  assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM credits WHERE source='scan'").get().n, 1);
});

test("la visita libera los créditos pendientes de delivery del mismo teléfono", async () => {
  const fx = await fixture({ play_mode: "stamps", cooldown_hours: 0, stamps_goal: 9 });
  const staff = await addStaff(fx, "Mesa 5", "33333");
  seedCredit(fx, { id: "del-1", order: "del-1" });
  seedCredit(fx, { id: "del-2", order: "del-2", phone: "593990000009" });
  const session = await login(fx);

  let r = await visit(fx, session.body.card.code, { staff_id: staff.id });
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual(body.card.credits, { granted: 1, pending: 0 });
  const granted = fx.env.DB.raw.prepare("SELECT status,granted_by,granted_at FROM credits WHERE id='del-1'").get();
  assert.equal(granted.status, "granted");
  assert.equal(granted.granted_by, staff.id);
  assert.ok(granted.granted_at > 0);
  assert.equal(fx.env.DB.raw.prepare("SELECT status FROM credits WHERE id='del-2'").get().status, "pending");

  // En modo juego la caja también libera el pendiente y además entrega el crédito scan.
  const game = await fixture({ cooldown_hours: 0 });
  const mesa = await addStaff(game, "Mesa 5b", "33334");
  seedCredit(game, { id: "del-3", order: "del-3" });
  const player = await login(game);
  r = await visit(game, player.body.card.code, { staff_id: mesa.id });
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.card.credits.granted, 2);
  assert.equal(game.env.DB.raw.prepare("SELECT status FROM credits WHERE id='del-3'").get().status, "granted");
});

test("mesero inactivo: 403 al verificar la visita, canjear o pedir PIN", async () => {
  const fx = await fixture({ cooldown_hours: 0 });
  const staff = await addStaff(fx, "Mesa 6", "44444");
  const session = await login(fx),
    code = session.body.card.code;

  let r = await admin(fx, "staff/verify", { method: "POST", body: { pin: "44444" } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { staff: { id: staff.id, name: "Mesa 6" } });
  assert.deepEqual(await (await admin(fx, "staff/verify", { method: "POST", body: { pin: "1234" } })).json(), {
    staff: { id: "legacy", name: "PIN general" },
  });
  assert.equal((await admin(fx, "staff/verify", { method: "POST", body: { pin: "0000" } })).status, 403);
  assert.equal((await admin(fx, "staff/verify", { method: "POST", body: { pin: "9999999" } })).status, 403);

  assert.equal((await admin(fx, `staff/${staff.id}`, { method: "DELETE" })).status, 204);
  assert.equal((await admin(fx, "staff/verify", { method: "POST", body: { pin: "44444" } })).status, 403);

  for (const staffId of [staff.id, "no-existe", undefined]) {
    r = await visit(fx, code, { staff_id: staffId });
    assert.equal(r.status, 403, `staff_id=${staffId}`);
    assert.deepEqual(await r.json(), { error: "mesero_inactivo" });
  }
  const reward = seedReward(fx, { id: "r-inactivo" });
  r = await admin(fx, `rewards/${reward}/redeem`, { method: "POST", body: { staff_id: staff.id } });
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "mesero_inactivo" });

  // El dueño con sesión del panel entra directo, sin PIN.
  r = await visit(fx, code, { staff_id: "owner" });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.card.credits.granted, 1);
});

test("canje por caja: premio activo, idempotencia, vencido y de otro local", async () => {
  const fx = await fixture();
  const staff = await addStaff(fx, "Mesa 7", "55555");
  await login(fx);
  seedReward(fx, { id: "r-1", expires: Date.now() + DAY });
  seedReward(fx, { id: "r-viejo", expires: Date.now() - 1000 });
  seedReward(fx, { id: "r-otro", slug: "otro-local" });

  let r = await admin(fx, "rewards/r-1/redeem", { method: "POST", body: { staff_id: staff.id } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.reward.id, "r-1");
  assert.equal(body.reward.status, "redeemed");
  assert.ok(body.reward.redeemed_at > 0);
  assert.equal(fx.env.DB.raw.prepare("SELECT redeemed_staff_id FROM rewards WHERE id='r-1'").get().redeemed_staff_id, staff.id);

  r = await admin(fx, "rewards/r-1/redeem", { method: "POST", body: { staff_id: staff.id } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "ya_canjeado" });
  r = await admin(fx, "rewards/r-viejo/redeem", { method: "POST", body: { staff_id: staff.id } });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "vencido" });
  assert.equal((await admin(fx, "rewards/no-existe/redeem", { method: "POST", body: { staff_id: staff.id } })).status, 404);
  assert.equal((await admin(fx, "rewards/r-otro/redeem", { method: "POST", body: { staff_id: staff.id } })).status, 404);
  // La ficha de la caja ya no ofrece el premio canjeado.
  const session = await login(fx);
  const view = await (await admin(fx, `card/${session.body.card.code}`)).json();
  assert.deepEqual(view.card.rewards, []);
});

test("la caja nunca recibe el teléfono completo", async () => {
  const fx = await fixture({ play_mode: "stamps", cooldown_hours: 0 });
  const staff = await addStaff(fx, "Mesa 8", "66666");
  const session = await login(fx),
    code = session.body.card.code;

  const responses = [await admin(fx, `card/${code}`), await visit(fx, code, { staff_id: staff.id })];
  for (const response of responses) {
    const text = await response.text();
    for (const fragment of [PHONE, "991234567", "9991234567"]) assert.ok(!text.includes(fragment), fragment);
    assert.equal(JSON.parse(text).card.phone_tail, "4567");
  }
});

test("la ficha de la caja lista solo premios activos y no vencidos", async () => {
  const fx = await fixture();
  const session = await login(fx),
    code = session.body.card.code;
  seedReward(fx, { id: "activo", label: "Café", expires: Date.now() + DAY });
  seedReward(fx, { id: "sin-vencimiento", label: "Postre", expires: null });
  seedReward(fx, { id: "vencido", expires: Date.now() - 1 });
  seedReward(fx, { id: "canjeado", status: "redeemed" });
  const view = await (await admin(fx, `card/${code}`)).json();
  assert.deepEqual(view.card.rewards.map(x => x.id).sort(), ["activo", "sin-vencimiento"]);
  assert.equal(view.card.rewards.every(x => typeof x.label === "string" && x.source === "game" && "expires_at" in x), true);
});

// Clave RSA solo para firmar el JWT del pase de Wallet (misma técnica que wallet.test.mjs).
const pair = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["sign"],
);
const privatePem = `-----BEGIN PRIVATE KEY-----\n${
  Buffer.from(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))).toString("base64").match(/.{1,64}/g).join("\n")
}\n-----END PRIVATE KEY-----\n`;

test("el pase de Wallet lleva el QR de la tarjeta del cliente", async () => {
  const fx = await fixture();
  const session = await login(fx),
    code = session.body.card.code;
  const env = {
    ...fx.env,
    GW_ISSUER_ID: "3388000000023226869",
    GW_SA_JSON: JSON.stringify({ client_email: `caja-${crypto.randomUUID()}@example.iam.gserviceaccount.com`, private_key: privatePem }),
  };
  const objects = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "token-caja", expires_in: 3600 });
    if (init.method === "PUT" && String(url).includes("/loyaltyObject/")) {
      objects.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    throw new Error(`request inesperado: ${url}`);
  };
  try {
    await walletSync(env, SLUG, MENU, fx.site.cfg, { ...session.body.customer, card_code: code }, []);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(objects.length, 1);
  assert.deepEqual(objects[0].barcode, { type: "QR_CODE", value: cardUrl(SLUG, code), alternateText: code });
});

test("la página pública de la tarjeta no revela datos del cliente", async () => {
  const fx = await fixture();
  const session = await login(fx),
    code = session.body.card.code;
  const worker = (await import("../src/index.js")).default;
  const call = (f, path) => worker.fetch(new Request(`https://${SLUG}.craft-systems.com${path}`), f.env, f.ctx);

  let r = await call(fx, `/club/t/${code}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const html = await r.text();
  assert.match(html, /Esta es tu tarjeta de Café Caja\. Muéstrala en caja para sumar tu sello\./);
  assert.match(html, /href="\/club">Abrir mi club</);
  for (const fragment of ["Ana", PHONE]) assert.ok(!html.includes(fragment), fragment);

  assert.equal((await call(fx, "/club/t/no-es-un-codigo")).status, 404);
  // El nombre del local se escapa: es el único dato del cliente que entra al HTML.
  const evil = await fixture({}, { store_name: "<script>alert(1)</script>" });
  const escaped = await (await call(evil, "/club/t/ABCD2345EF")).text();
  assert.ok(!escaped.includes("<script>alert"));
  assert.ok(escaped.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("la migración 0005 conserva filas, columnas e índices y amplía los CHECK", () => {
  const dir = new URL("../migrations/", import.meta.url),
    files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort(),
    db = new DatabaseSync(":memory:"),
    apply = list => {
      for (const f of list) db.exec(readFileSync(new URL(f, dir), "utf8"));
    };
  assert.ok(files.includes("0005_caja.sql"));

  apply(files.filter(f => f < "0005"));
  db.prepare("INSERT INTO customers (slug,phone,name,stamps,visits,created_at) VALUES (?,?,?,?,?,?)").run(SLUG, PHONE, "Ana", 2, 5, 1);
  db.prepare("INSERT INTO staff (id,slug,name,pin_hash,active,created_at) VALUES ('s1',?, 'Mesa', 'x', 1, 1)").run(SLUG);
  db.prepare(
    "INSERT INTO credits (id,slug,phone,order_id,source,status,created_at,granted_at,granted_by) VALUES ('c1',?,?,?,'delivery','granted',10,11,'owner')",
  ).run(SLUG, PHONE, "pedido-1");
  db.prepare(
    "INSERT INTO plays (id,slug,phone,game,prize_id,reward_id,via,lat,lng,staff_id,device_hash,created_at) VALUES (7,?,?,'wheel','cafe',NULL,'pin',NULL,NULL,'s1','d1',10)",
  ).run(SLUG, PHONE);
  db.prepare("INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at) VALUES ('r1',?,?,'cafe','Café','game',10)").run(SLUG, PHONE);

  apply(files.filter(f => f >= "0005"));

  const c = db.prepare("SELECT * FROM customers WHERE phone=?").get(PHONE);
  assert.equal(c.name, "Ana");
  assert.equal(c.stamps, 2);
  assert.equal(c.visits, 5);
  assert.equal(c.card_code, null);
  db.prepare("UPDATE customers SET card_code='ABCD2345EF' WHERE phone=?").run(PHONE);
  assert.throws(
    () => db.prepare("INSERT INTO customers (slug,phone,card_code,created_at) VALUES (?,?,?,?)").run(SLUG, "593990000001", "ABCD2345EF", 2),
    /UNIQUE/,
  );

  const credit = db.prepare("SELECT * FROM credits WHERE id='c1'").get();
  assert.equal(credit.source, "delivery");
  assert.equal(credit.status, "granted");
  assert.equal(credit.granted_at, 11);
  assert.equal(credit.granted_by, "owner");
  const play = db.prepare("SELECT * FROM plays WHERE id=7").get();
  assert.deepEqual(
    { game: play.game, via: play.via, staff_id: play.staff_id, device_hash: play.device_hash, created_at: play.created_at },
    { game: "wheel", via: "pin", staff_id: "s1", device_hash: "d1", created_at: 10 },
  );
  assert.equal(db.prepare("SELECT COUNT(*) n FROM rewards").get().n, 1);

  // Los CHECK aceptan los valores nuevos y siguen rechazando el resto.
  db.prepare("INSERT INTO credits (id,slug,phone,order_id,source,status,created_at) VALUES ('c2',?,?,'scan:x','scan','granted',12)").run(SLUG, PHONE);
  assert.throws(
    () => db.prepare("INSERT INTO credits (id,slug,phone,order_id,source,status,created_at) VALUES ('c3',?,?,'o','otro','granted',13)").run(SLUG, PHONE),
    /CHECK/,
  );
  db.prepare("INSERT INTO plays (id,slug,phone,game,via,created_at) VALUES (8,?,?,'stamp','scan',14)").run(SLUG, PHONE);
  assert.throws(
    () => db.prepare("INSERT INTO plays (id,slug,phone,game,via,created_at) VALUES (9,?,?,'stamp','otro',15)").run(SLUG, PHONE),
    /CHECK/,
  );

  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('customers','credits','plays')")
    .all()
    .map(x => x.name);
  for (const name of ["customers_card_code", "credits_customer", "plays_slug_at", "plays_customer", "plays_slug_device_at"])
    assert.ok(indexes.includes(name), name);
});

test("caja: el PIN general (legacy) valida visitas mientras siga configurado", async () => {
  const fx = await fixture({ cooldown_hours: 0 });
  const code = (await login(fx)).body.card.code;
  const r = await visit(fx, code, { staff_id: "legacy" });
  assert.equal(r.status, 200);
});
