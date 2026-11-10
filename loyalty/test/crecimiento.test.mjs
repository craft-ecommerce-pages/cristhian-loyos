import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { handleAdmin, handleApi } from "../src/api.js";
import { normalizeBirthday, normalizeConfig } from "../src/contract.js";
import { scheduled } from "../src/index.js";
import { makeCtx, makeD1, makeKV } from "./helpers.mjs";

const SLUG = "crecimiento-prueba",
  PHONE = "593991234567",
  SECRET = "secreto-crecimiento",
  DAY = 86_400_000;

async function sha256(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function fixture(overrides = {}, kv = {}) {
  return {
    env: { DB: makeD1(), MENUS: makeKV(kv), SESSION_SECRET: SECRET, ADMIN_TOKEN: "admin-crecimiento" },
    site: {
      slug: SLUG,
      cfg: normalizeConfig({ enabled: true, cooldown_hours: 0, stamps_goal: 3, prizes: [], lose_weight: 1, ...overrides }),
      menuCfg: { store_name: "Café Crecimiento", location: { sedes: [{ lat: -0.18, lng: -78.48 }] } },
    },
    ctx: makeCtx(),
  };
}

function apiRequest(path, { method = "GET", body, cookie } = {}) {
  return new Request(`https://${SLUG}.craft-systems.com/club/api/${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const callApi = (fx, path, options) => handleApi(apiRequest(path, options), fx.env, fx.ctx, fx.site);

function cookies(response) {
  return (response.headers.get("set-cookie") || "").split(/, (?=club_[sd]=)/).map(x => x.split(";")[0]).join("; ");
}
async function login(fx, phone = "0991234567", birthday) {
  const response = await callApi(fx, "login", { method: "POST", body: { name: "Ana", phone, ...(birthday ? { birthday } : {}) } });
  return { response, cookie: cookies(response), body: await response.json() };
}

function adminRequest(path, { method = "GET" } = {}) {
  return new Request(`https://loyalty.example/admin/${SLUG}/${path}`, {
    method,
    headers: { authorization: "Bearer admin-crecimiento" },
  });
}
const callAdmin = (fx, path, options) => handleAdmin(adminRequest(path, options), fx.env, fx.ctx);

// Fixture de Wallet: firma RS256 real y captura los addMessage sin salir a la red.
async function walletStub(env) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  env.GW_ISSUER_ID = "3388000000023226869";
  env.GW_SA_JSON = JSON.stringify({ client_email: `crecimiento-${crypto.randomUUID()}@example.com`, private_key: pem });
  const messages = [],
    original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("oauth2")) return Response.json({ access_token: "token", expires_in: 3600 });
    if (String(url).includes("addMessage")) {
      messages.push(JSON.parse(init.body).message);
      return Response.json({});
    }
    throw new Error(`URL inesperada: ${url}`);
  };
  return { messages, restore: () => void (globalThis.fetch = original) };
}

const MONTH_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Guayaquil", month: "2-digit", day: "2-digit" });
function ecMonthDay(ms) {
  const parts = Object.fromEntries(MONTH_DAY.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${parts.month}-${parts.day}`;
}

function seedCustomer(db, { phone = PHONE, name = "Ana", birthday = null, visits = 0, stamps = 0, cards = 0,
  lastPlay = null, wallet = 0, created = Date.now() } = {}) {
  db.raw.prepare(`INSERT INTO customers
    (slug, phone, name, birthday, stamps, visits, cards_completed, last_play_at, wallet_saved, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SLUG, phone, name, birthday, stamps, visits, cards, lastPlay, wallet, created);
}

const cronKv = config => ({ [`${SLUG}:loyalty`]: { enabled: true, ...config } });

describe("config: cumpleaños e inactivos", () => {
  test("normalizeConfig aplica defaults y acota winback a dos semanas", () => {
    const base = normalizeConfig({});
    assert.deepEqual(base.birthday, { enabled: false, label: "Regalo de cumpleaños", expires_days: 14 });
    assert.deepEqual(base.winback, { enabled: false, days: 30, label: "Un premio de bienvenida", expires_days: 14 });

    const custom = normalizeConfig({
      birthday: { enabled: true, label: "  Postre de cumpleaños  ", expires_days: "10" },
      winback: { enabled: "true", days: 3, label: "Café gratis", expires_days: -5 },
    });
    assert.deepEqual(custom.birthday, { enabled: true, label: "Postre de cumpleaños", expires_days: 10 });
    assert.deepEqual(custom.winback, { enabled: false, days: 14, label: "Café gratis", expires_days: 14 });
    assert.equal(normalizeConfig({ winback: { enabled: true, days: 45 } }).winback.days, 45);
  });

  test("normalizeBirthday acepta MM-DD real y rechaza días imposibles", () => {
    for (const ok of ["01-01", "02-29", "07-15", "12-31"]) assert.equal(normalizeBirthday(ok), ok);
    for (const bad of ["02-30", "04-31", "13-01", "00-10", "1-05", "07/15", "", null, 715]) assert.equal(normalizeBirthday(bad), null);
  });
});

describe("cumpleaños del cliente", () => {
  test("login valida el cumpleaños y no lo cambia en logins posteriores", async () => {
    const fx = await fixture();
    let attempt = await login(fx, "0991234567", "13-01");
    assert.equal(attempt.response.status, 400);
    assert.deepEqual(attempt.body, { error: "cumpleanos_invalido" });
    attempt = await login(fx, "0991234567", "02-30");
    assert.equal(attempt.response.status, 400);

    const first = await login(fx, "0991234567", "02-29");
    assert.equal(first.response.status, 200);
    assert.equal(fx.env.DB.raw.prepare("SELECT birthday FROM customers WHERE phone=?").get(PHONE).birthday, "02-29");

    const again = await login(fx, "0991234567", "03-15");
    assert.equal(again.response.status, 200);
    assert.equal(fx.env.DB.raw.prepare("SELECT birthday FROM customers WHERE phone=?").get(PHONE).birthday, "02-29");
  });

  test("profile exige sesión y solo acepta el cumpleaños una vez", async () => {
    const fx = await fixture();
    let response = await callApi(fx, "profile", { method: "POST", body: { birthday: "07-15" } });
    assert.equal(response.status, 401);

    const { cookie } = await login(fx, "0992222222");
    response = await callApi(fx, "profile", { method: "POST", cookie, body: { birthday: "02-30" } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "cumpleanos_invalido" });

    response = await callApi(fx, "profile", { method: "POST", cookie, body: { birthday: "07-15" } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).customer.name, "Ana");
    assert.equal(fx.env.DB.raw.prepare("SELECT birthday FROM customers WHERE phone=?").get("593992222222").birthday, "07-15");

    response = await callApi(fx, "profile", { method: "POST", cookie, body: { birthday: "07-15" } });
    assert.equal(response.status, 200);
    response = await callApi(fx, "profile", { method: "POST", cookie, body: { birthday: "08-20" } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "cumpleanos_ya_definido" });
    assert.equal(fx.env.DB.raw.prepare("SELECT birthday FROM customers WHERE phone=?").get("593992222222").birthday, "07-15");
  });
});

describe("exportación de clientes", () => {
  test("customers.csv trae BOM, cabecera, fecha EC y neutraliza fórmulas y comillas", async () => {
    const fx = await fixture(),
      now = Date.now();
    seedCustomer(fx.env.DB, { name: "=SUM(A1:A2)", birthday: "02-29", visits: 3, stamps: 2, cards: 1, wallet: 1, lastPlay: now });
    seedCustomer(fx.env.DB, { phone: "593991000002", name: "+Ana" });
    seedCustomer(fx.env.DB, { phone: "593991000003", name: "-Ana" });
    seedCustomer(fx.env.DB, { phone: "593991000004", name: "@Ana" });
    seedCustomer(fx.env.DB, { phone: "593991000005", name: 'Ana "La Jefa"' });

    const response = await callAdmin(fx, "customers.csv");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/csv; charset=utf-8/);
    assert.match(response.headers.get("content-disposition"), /attachment; filename="clientes-crecimiento-prueba\.csv"/);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "BOM UTF-8");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    assert.ok(text.startsWith("\uFEFF"));
    assert.ok(text.includes('"Nombre","WhatsApp","Cumpleaños","Visitas","Sellos"'));
    assert.ok(text.includes('"\'=SUM(A1:A2)"'));
    assert.ok(text.includes('"\'+Ana"'));
    assert.ok(text.includes('"\'-Ana"'));
    assert.ok(text.includes('"\'@Ana"'));
    assert.ok(text.includes('"Ana ""La Jefa"""'));
    assert.ok(text.includes('"02-29"'));
    assert.ok(text.includes('"Sí"'));
    assert.match(text, /"\d{2}\/\d{2}\/\d{4}"/);
    assert.equal(text.trimEnd().split("\r\n").length, 6);
  });

  test("customers.csv no mezcla tenants", async () => {
    const fx = await fixture();
    seedCustomer(fx.env.DB, { name: "Local" });
    fx.env.DB.raw.prepare("INSERT INTO customers (slug, phone, name, created_at) VALUES ('otro', '593999999999', 'Ajeno', ?)")
      .run(Date.now());
    const text = await (await callAdmin(fx, "customers.csv")).text();
    assert.ok(text.includes("Local"));
    assert.ok(!text.includes("Ajeno"));
  });
});

describe("opiniones del cliente", () => {
  test("feedback exige visita, se liga a la última jugada y admite una por jugada", async () => {
    const fx = await fixture(),
      { cookie } = await login(fx);
    let response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 5 } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "sin_visita" });

    const now = Date.now();
    fx.env.DB.raw.prepare("INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'geo', ?)")
      .run(SLUG, PHONE, now - 1000);
    response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 5, comment: "  Excelente  " } });
    assert.equal(response.status, 200);
    const firstPlay = fx.env.DB.raw.prepare("SELECT id FROM plays ORDER BY id").get().id;
    assert.deepEqual(await response.json(), { ok: true, play_id: firstPlay });
    const saved = fx.env.DB.raw.prepare("SELECT * FROM feedback").get();
    assert.equal(saved.rating, 5);
    assert.equal(saved.comment, "Excelente");
    assert.equal(saved.play_id, firstPlay);

    response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 4 } });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "sin_visita" });

    fx.env.DB.raw.prepare("INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'geo', ?)")
      .run(SLUG, PHONE, now + 1000);
    response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 2 } });
    assert.equal(response.status, 200);
    const latest = fx.env.DB.raw.prepare("SELECT id FROM plays ORDER BY id DESC").get().id;
    assert.equal((await response.json()).play_id, latest);
  });

  test("feedback valida nota y comentario; el admin lista con promedio", async () => {
    const fx = await fixture(),
      { cookie } = await login(fx),
      now = Date.now();
    fx.env.DB.raw.prepare("INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'geo', ?)")
      .run(SLUG, PHONE, now);
    let response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 0 } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "calificacion_invalida" });
    response = await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 3, comment: "x".repeat(501) } });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "comentario_largo" });

    await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 5, comment: "Muy rico" } });
    fx.env.DB.raw.prepare("INSERT INTO plays (slug, phone, game, via, created_at) VALUES (?, ?, 'wheel', 'geo', ?)")
      .run(SLUG, PHONE, now + 1);
    await callApi(fx, "feedback", { method: "POST", cookie, body: { rating: 2 } });

    response = await callAdmin(fx, "feedback?limit=10&offset=0");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 2);
    assert.equal(body.avg, 3.5);
    assert.equal(body.items[0].rating, 2);
    assert.equal(body.items[1].comment, "Muy rico");
    assert.equal(body.items[1].name, "Ana");
    assert.equal(body.items[1].phone, PHONE);
    response = await callAdmin(fx, "feedback?limit=0");
    assert.equal(response.status, 400);
  });
});

describe("cron de crecimiento", () => {
  test("cumpleaños: regala una vez al año y avisa al pase guardado", async () => {
    const fx = await fixture({}, cronKv({ birthday: { enabled: true, label: "Postre de cumpleaños", expires_days: 10 } })),
      now = Date.now(),
      today = ecMonthDay(now),
      inThree = ecMonthDay(now + 3 * DAY),
      inTwenty = ecMonthDay(now + 20 * DAY);
    seedCustomer(fx.env.DB, { phone: "593991000001", name: "Cumple hoy", birthday: today, wallet: 1 });
    seedCustomer(fx.env.DB, { phone: "593991000002", name: "Cumple pronto", birthday: inThree });
    seedCustomer(fx.env.DB, { phone: "593991000003", name: "Lejos", birthday: inTwenty });
    seedCustomer(fx.env.DB, { phone: "593991000004", name: "Viejo", birthday: today });
    fx.env.DB.raw.prepare(`INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at)
      VALUES ('viejo', ?, '593991000004', '__birthday', 'Regalo anterior', 'birthday', ?)`)
      .run(SLUG, now - 400 * DAY);

    const stub = await walletStub(fx.env);
    try {
      await scheduled(null, fx.env, fx.ctx);
      await scheduled(null, fx.env, fx.ctx);
    } finally {
      stub.restore();
    }

    const rows = fx.env.DB.raw.prepare("SELECT * FROM rewards WHERE source='birthday' ORDER BY phone").all(),
      nuevos = rows.filter(x => x.id !== "viejo");
    assert.equal(nuevos.length, 3, "hoy, en 3 días y el regalo del año pasado caducado");
    for (const row of nuevos) {
      assert.equal(row.prize_id, "__birthday");
      assert.equal(row.label, "Postre de cumpleaños");
      assert.ok(row.expires_at >= now + 10 * DAY - 5000 && row.expires_at <= now + 10 * DAY + 5000);
    }
    assert.equal(rows.filter(x => x.phone === "593991000001").length, 1, "no se repite en la segunda corrida");
    assert.equal(rows.filter(x => x.phone === "593991000004").length, 2, "el del año pasado no bloquea el de este año");
    assert.equal(stub.messages.length, 1, "solo se avisa a quien guardó el pase");
    assert.equal(stub.messages[0].header, "🎂 Se acerca tu cumpleaños");
    assert.match(stub.messages[0].body, /^Te regalamos Postre de cumpleaños\. Válido hasta \d{2}\/\d{2}$/);
  });

  test("inactivos: regala una vez por período y exige visitas previas", async () => {
    const fx = await fixture({}, cronKv({
      winback: { enabled: true, days: 30, label: "Café gratis", expires_days: 14 },
    })),
      now = Date.now();
    seedCustomer(fx.env.DB, { phone: "593992000001", name: "Inactivo", visits: 2, lastPlay: now - 40 * DAY, wallet: 1 });
    seedCustomer(fx.env.DB, { phone: "593992000002", name: "Reciente", visits: 2, lastPlay: now - 10 * DAY });
    seedCustomer(fx.env.DB, { phone: "593992000003", name: "Nunca vino", visits: 0, lastPlay: now - 40 * DAY });
    seedCustomer(fx.env.DB, { phone: "593992000004", name: "Ya regalado", visits: 2, lastPlay: now - 40 * DAY });
    fx.env.DB.raw.prepare(`INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at)
      VALUES ('reciente', ?, '593992000004', '__winback', 'Ya recibido', 'winback', ?)`)
      .run(SLUG, now - DAY);

    const stub = await walletStub(fx.env);
    try {
      await scheduled(null, fx.env, fx.ctx);
      await scheduled(null, fx.env, fx.ctx);

      let rows = fx.env.DB.raw.prepare("SELECT * FROM rewards WHERE source='winback' ORDER BY phone").all();
      assert.deepEqual(rows.map(x => x.phone), ["593992000001", "593992000004"]);
      assert.equal(rows.find(x => x.phone === "593992000001").label, "Café gratis");
      assert.equal(stub.messages.length, 1);
      assert.equal(stub.messages[0].header, "Te extrañamos 👋");
      assert.equal(stub.messages[0].body, "Vuelve y te regalamos Café gratis");

      // Nuevo período: el regalo es anterior a la última visita (volvió) y vuelve a estar inactivo.
      fx.env.DB.raw.prepare("UPDATE rewards SET created_at=? WHERE source='winback' AND phone='593992000001'")
        .run(now - 60 * DAY);
      fx.env.DB.raw.prepare("UPDATE customers SET last_play_at=? WHERE phone='593992000001'").run(now - 40 * DAY);
      await scheduled(null, fx.env, fx.ctx);
      rows = fx.env.DB.raw.prepare("SELECT * FROM rewards WHERE source='winback' AND phone='593992000001'").all();
      assert.equal(rows.length, 2, "otro período de inactividad = otro regalo");
    } finally {
      stub.restore();
    }
  });

  test("regalos desactivados no escriben nada", async () => {
    const fx = await fixture({}, cronKv({})),
      now = Date.now();
    seedCustomer(fx.env.DB, { phone: "593993000001", visits: 1, lastPlay: now - 40 * DAY });
    seedCustomer(fx.env.DB, { phone: "593993000002", birthday: ecMonthDay(now) });
    await scheduled(null, fx.env, fx.ctx);
    assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM rewards").get().n, 0);
  });
});

// El runtime solo ejecuta el `scheduled` que cuelga del default export; un export suelto se ignora
// y el cron quedaría mudo en producción.
test("el handler scheduled está montado en el default export", async () => {
  const { default: worker } = await import("../src/index.js");
  assert.equal(worker.scheduled, scheduled);
});

test("migración 0004 conserva filas, columnas e índices de rewards", () => {
  const dir = new URL("../migrations/", import.meta.url),
    files = readdirSync(dir).filter(f => f.endsWith(".sql")).sort(),
    db = new DatabaseSync(":memory:");
  for (const file of files.filter(f => f < "0004")) db.exec(readFileSync(new URL(file, dir), "utf8"));
  db.exec("INSERT INTO customers (slug, phone, name, created_at) VALUES ('demo', '593991234567', 'Ana', 1)");
  db.exec(`INSERT INTO rewards
    (id, slug, phone, prize_id, label, source, status, pin_fails, created_at, expires_at, redeemed_at, redeemed_staff_id, reminded_at)
    VALUES ('viejo', 'demo', '593991234567', 'cafe', 'Café', 'stamps', 'active', 2, 10, 20, NULL, 'legacy', 30)`);

  db.exec(readFileSync(new URL("0004_crecimiento.sql", dir), "utf8"));

  assert.deepEqual({ ...db.prepare("SELECT * FROM rewards WHERE id = 'viejo'").get() }, {
    id: "viejo",
    slug: "demo",
    phone: "593991234567",
    prize_id: "cafe",
    label: "Café",
    source: "stamps",
    status: "active",
    pin_fails: 2,
    created_at: 10,
    expires_at: 20,
    redeemed_at: null,
    redeemed_staff_id: "legacy",
    reminded_at: 30,
  });
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='rewards'").all().map(x => x.name);
  for (const name of ["rewards_customer", "rewards_prize", "rewards_reminder", "rewards_source"]) assert.ok(indexes.includes(name), name);

  db.exec(`INSERT INTO rewards (id, slug, phone, prize_id, label, source, created_at)
    VALUES ('regalo', 'demo', '593991234567', '__birthday', 'Regalo', 'birthday', 40)`);
  db.exec(`INSERT INTO rewards (id, slug, phone, prize_id, label, source, created_at)
    VALUES ('vuelve', 'demo', '593991234567', '__winback', 'Vuelve', 'winback', 41)`);
  assert.throws(() => db.exec(`INSERT INTO rewards (id, slug, phone, prize_id, label, source, created_at)
    VALUES ('mal', 'demo', '593991234567', 'x', 'X', 'otro', 42)`));

  db.prepare("UPDATE customers SET birthday = '07-15' WHERE slug = 'demo'").run();
  assert.equal(db.prepare("SELECT birthday FROM customers WHERE slug = 'demo'").get().birthday, "07-15");
  db.prepare("INSERT INTO feedback (slug, phone, rating, comment, play_id, created_at) VALUES ('demo', '593991234567', 5, 'ok', 1, 50)").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feedback").get().n, 1);
  assert.throws(() => db.prepare("INSERT INTO feedback (slug, phone, rating, comment, play_id, created_at) VALUES ('demo', '593991234567', 6, '', 2, 51)").run());
  assert.throws(() => db.prepare("INSERT INTO feedback (slug, phone, rating, comment, play_id, created_at) VALUES ('demo', '593991234567', 4, '', 1, 52)").run());
});
