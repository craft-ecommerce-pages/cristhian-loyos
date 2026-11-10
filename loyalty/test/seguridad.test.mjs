import assert from "node:assert/strict";
import test from "node:test";
import { handleAdmin, handleApi } from "../src/api.js";
import { normalizeConfig } from "../src/contract.js";
import { scheduled } from "../src/index.js";
import { makeCtx, makeD1, makeKV } from "./helpers.mjs";

const SLUG = "cafe-seguro", SECRET = "secreto-seguro", PHONE = "593991234567", DAY = 86_400_000;
const enc = new TextEncoder();
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value)))].map(x => x.toString(16).padStart(2, "0")).join("");

async function fixture(overrides = {}, menu = { location: { sedes: [{ lat: -0.18, lng: -78.48 }] } }) {
  return {
    env: { DB: makeD1(), MENUS: makeKV(), SESSION_SECRET: SECRET, ADMIN_TOKEN: "admin" },
    ctx: makeCtx(),
    site: { slug: SLUG, menuCfg: { store_name: "Café Seguro", ...menu }, cfg: normalizeConfig({ enabled: true, cooldown_hours: 12, stamps_goal: 8, prizes: [], lose_weight: 1, staff_pin_hash: await hash(`${SLUG}:1234`), ...overrides }) },
  };
}
function req(path, { method = "GET", body, cookie } = {}) { return new Request(`https://${SLUG}.craft-systems.com/club/api/${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
const api = (fx, path, opts) => handleApi(req(path, opts), fx.env, fx.ctx, fx.site);
function cookies(response) { return response.headers.get("set-cookie")?.split(/, (?=club_[sd]=)/).map(x => x.split(";")[0]).join("; ") || ""; }
async function login(fx, phone = "0991234567", oldCookie, pin) { const r = await api(fx, "login", { method: "POST", cookie: oldCookie, body: { name: "Ana", phone, ...(pin ? { pin } : {}) } }), fresh = cookies(r); return { r, cookie: fresh.includes("club_d=") || !oldCookie?.includes("club_d=") ? fresh : `${fresh}; ${oldCookie.match(/club_d=[^;]+/)[0]}`, body: await r.json() }; }
function admin(fx, path, { method = "GET", body } = {}) { return handleAdmin(new Request(`https://loyalty.example/admin/${SLUG}/${path}`, { method, headers: { authorization: "Bearer admin", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }), fx.env, fx.ctx); }
async function addStaff(fx, name, pin) { const r = await admin(fx, "staff", { method: "POST", body: { name, pin } }); assert.equal(r.status, 201); return r.json(); }

test("dispositivo: vincula, exige verificación para cuentas con valor y limita tres teléfonos", async () => {
  const fx = await fixture();
  const first = await login(fx);
  assert.match(first.cookie, /club_d=[A-Za-z0-9_-]{43}/);
  await fx.env.DB.prepare("UPDATE customers SET visits=1 WHERE slug=? AND phone=?").bind(SLUG, PHONE).run();
  const other = await login(fx, "0991234567");
  assert.equal(other.r.status, 403); assert.equal(other.body.error, "verificacion_requerida");
  const verified = await login(fx, "0991234567", undefined, "1234");
  assert.equal(verified.r.status, 200);
  const oneDevice = cookies(await api(fx, "login", { method: "POST", body: { name: "Uno", phone: "0991111111" } }));
  for (const phone of ["0992222222", "0993333333"]) assert.equal((await login(fx, phone, oneDevice)).r.status, 200);
  const fourth = await login(fx, "0994444444", oneDevice);
  assert.equal(fourth.r.status, 429); assert.equal(fourth.body.error, "limite_dispositivo");
});

test("sesión antigua migra una vez y la sesión no funciona desde otro dispositivo", async () => {
  const fx = await fixture();
  const first = await login(fx);
  const oldSession = first.cookie.match(/club_s=[^;]+/)[0];
  const migrated = await api(fx, "me", { cookie: oldSession });
  assert.equal(migrated.status, 200);
  const stranger = `club_s=${oldSession.slice(7)}; club_d=${"x".repeat(43)}`;
  const denied = await api(fx, "me", { cookie: stranger });
  assert.equal(denied.status, 401);
});

test("staff: PIN por mesero, legado, repetido, rotación y desactivación", async () => {
  const fx = await fixture({ staff_pin_hash: await hash(`${SLUG}:9999`), cooldown_hours: 0 });
  const ana = await addStaff(fx, "Ana", "12345");
  let list = await admin(fx, "staff"); const listed = await list.json();
  assert.equal(listed.items[0].pin_hash, undefined);
  const duplicate = await admin(fx, "staff", { method: "POST", body: { name: "Otra", pin: "12345" } }); assert.equal(duplicate.status, 409);
  const l = await login(fx);
  let play = await api(fx, "play", { method: "POST", cookie: l.cookie, body: { game: "wheel", pin: "12345" } }); assert.equal(play.status, 200);
  assert.equal(fx.env.DB.raw.prepare("SELECT staff_id FROM plays").get().staff_id, ana.id);
  play = await api(fx, "play", { method: "POST", cookie: l.cookie, body: { game: "wheel", pin: "9999" } }); assert.equal(play.status, 200);
  assert.equal(fx.env.DB.raw.prepare("SELECT staff_id FROM plays ORDER BY id DESC").get().staff_id, "legacy");
  const rotated = await admin(fx, `staff/${ana.id}`, { method: "PUT", body: { pin: "54321" } }); assert.equal(rotated.status, 200); assert.ok((await rotated.json()).rotated_at);
  const off = await admin(fx, `staff/${ana.id}`, { method: "DELETE" }); assert.equal(off.status, 204);
  play = await api(fx, "play", { method: "POST", cookie: l.cookie, body: { game: "wheel", pin: "54321" } }); assert.equal(play.status, 403);
});

test("PIN requerido: no hay nogeo, require_pin ignora geo y diez fallos bloquean el dispositivo", async () => {
  const noGeo = await fixture({ staff_pin_hash: await hash(`${SLUG}:1234`) }, { location: { sedes: [{ nombre: "Centro" }] } });
  const l = await login(noGeo);
  let r = await api(noGeo, "play", { method: "POST", cookie: l.cookie, body: { game: "wheel" } }); assert.equal(r.status, 403); assert.equal((await r.json()).error, "pin_requerido");
  const required = await fixture({ require_pin: true }); const lr = await login(required);
  r = await api(required, "play", { method: "POST", cookie: lr.cookie, body: { game: "wheel", lat: -0.18, lng: -78.48 } }); assert.equal((await r.json()).error, "pin_requerido");
  for (let i = 0; i < 9; i++) { r = await api(required, "play", { method: "POST", cookie: lr.cookie, body: { game: "wheel", pin: "0000" } }); assert.equal(r.status, 403); }
  r = await api(required, "play", { method: "POST", cookie: lr.cookie, body: { game: "wheel", pin: "0000" } }); assert.equal(r.status, 423);
});

test("cooldown también frena otro teléfono del mismo dispositivo", async () => {
  const fx = await fixture({ cooldown_hours: 12 });
  const first = await login(fx, "0991111111");
  let r = await api(fx, "play", { method: "POST", cookie: first.cookie, body: { game: "wheel", lat: -0.18, lng: -78.48 } }); assert.equal(r.status, 200);
  const second = await login(fx, "0992222222", first.cookie);
  r = await api(fx, "play", { method: "POST", cookie: second.cookie, body: { game: "wheel", lat: -0.18, lng: -78.48 } });
  assert.equal(r.status, 429); assert.equal((await r.json()).error, "cooldown");
});

test("detalle de cliente muestra personal de juego/canje sin filtrar hashes", async () => {
  const fx = await fixture({ cooldown_hours: 0 }); const staff = await addStaff(fx, "Mesa 1", "12345"), l = await login(fx);
  await api(fx, "play", { method: "POST", cookie: l.cookie, body: { game: "wheel", pin: "12345" } });
  await fx.env.DB.prepare("INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at,redeemed_staff_id,status,redeemed_at) VALUES ('r',?,?, 'p','P','game',?,?,'redeemed',?)").bind(SLUG, PHONE, Date.now(), staff.id, Date.now()).run();
  const r = await admin(fx, `customers/${PHONE}`), detail = await r.json();
  assert.equal(detail.plays[0].staff_name, "Mesa 1"); assert.equal(detail.rewards.find(x => x.id === "r").redeemed_by, "Mesa 1");
  assert.doesNotMatch(JSON.stringify(detail), /pin_hash/);
});

test("cron avisa una vez y procesa como máximo 500 premios", async () => {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----\n`;
  const fx = await fixture(); fx.env.GW_ISSUER_ID = "3388000000023226869"; fx.env.GW_SA_JSON = JSON.stringify({ client_email: `cron-${crypto.randomUUID()}@example.com`, private_key: pem });
  const now = Date.now(), addCustomer = fx.env.DB.raw.prepare("INSERT INTO customers (slug,phone,name,wallet_saved,created_at) VALUES (?,?,'A',1,?)"), addReward = fx.env.DB.raw.prepare("INSERT INTO rewards (id,slug,phone,prize_id,label,source,created_at,expires_at) VALUES (?,?,?,'p','Café','game',?,?)");
  for (let i = 0; i < 501; i++) { const phone = `5938${String(i).padStart(9, "0")}`; addCustomer.run(SLUG, phone, now); addReward.run(`r${i}`, SLUG, phone, now, now + DAY); }
  let messages = 0; const original = globalThis.fetch; globalThis.fetch = async (url, init = {}) => { if (String(url).includes("oauth2")) return Response.json({ access_token: "token", expires_in: 3600 }); if (String(url).includes("addMessage")) { messages++; return Response.json({}); } throw new Error(`URL inesperada: ${url}`); };
  try { await scheduled(null, fx.env, fx.ctx); assert.equal(messages, 500); await scheduled(null, fx.env, fx.ctx); assert.equal(messages, 501); await scheduled(null, fx.env, fx.ctx); } finally { globalThis.fetch = original; }
  assert.equal(messages, 501); assert.equal(fx.env.DB.raw.prepare("SELECT COUNT(*) n FROM rewards WHERE reminded_at IS NOT NULL").get().n, 501);
});
