// Tests del sprint "Crecimiento": cumpleaños opcional (login + aviso con sesión), opinión privada
// tras la jugada/visita (la reseña NUNCA se oculta) y etiquetas de premios birthday/winback.
// Sin dependencias: DOM mínimo + vm, igual que page-creditos.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderPage, programOf, birthdayOf, birthdayValue, birthdaySelects } from "../src/page.js";
import { normalizeConfig } from "../src/contract.js";

const menu = {
  store_name: "Café Central",
  theme_primary: "#c0392b",
  theme_accent: "#f1c40f",
  location: { sedes: [{ lat: -0.1807, lng: -78.4678 }] },
};
const baseCfg = normalizeConfig({
  enabled: true,
  prizes: [{ id: "cafe", label: "Café gratis", weight: 20 }],
  lose_weight: 70,
  stamps_goal: 8,
  stamps_reward: { label: "Un postre gratis" },
  review_url: "https://g.page/r/abc",
});
// G1 expone `birthday` en normalizeConfig; acá se arma el config normalizado que dejará el merge.
const bdayCfg = { ...baseCfg, birthday: { enabled: true, label: "Postre de cumpleaños", expires_days: 14 } };

const html = renderPage(menu, baseCfg);
const htmlBday = renderPage(menu, bdayCfg);
const program = programOf(menu, baseCfg);
const programBday = programOf(menu, bdayCfg);

const scriptOf = (page, id) => {
  const m = new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`).exec(page);
  assert.ok(m, `falta <script id="${id}">`);
  return m[1];
};
const viewInner = page => {
  const m = /<main id="clubView" class="club-view">([\s\S]*?)<\/main>/.exec(page);
  assert.ok(m, "el HTML no trae clubView");
  return m[1];
};

/* ── helpers puros ── */

test("birthdayOf: apagado por defecto y label propia cuando se habilita", () => {
  assert.deepEqual(birthdayOf(undefined), { enabled: false, label: "Regalo de cumpleaños" });
  assert.deepEqual(birthdayOf({}), { enabled: false, label: "Regalo de cumpleaños" });
  assert.deepEqual(birthdayOf({ birthday: { enabled: "sí", label: "  " } }), { enabled: false, label: "Regalo de cumpleaños" });
  assert.deepEqual(birthdayOf({ birthday: { enabled: true, label: "  Postre  " } }), { enabled: true, label: "Postre" });
  assert.equal(programOf(menu, baseCfg).birthday.enabled, false);
  assert.equal(programOf(menu, bdayCfg).birthday.enabled, true);
  assert.equal(programOf(menu, bdayCfg).birthday.label, "Postre de cumpleaños");
});

test("birthdayValue: vacío, incompleto, MM-DD y días por mes (29/02 permitido)", () => {
  assert.equal(birthdayValue("", ""), "");
  assert.equal(birthdayValue(undefined, undefined), "");
  assert.equal(birthdayValue("5", ""), null);
  assert.equal(birthdayValue("", "7"), null);
  assert.equal(birthdayValue("0", "7"), null);
  assert.equal(birthdayValue("5", "13"), null);
  assert.equal(birthdayValue("31", "4"), null);
  assert.equal(birthdayValue("29", "2"), "02-29");
  assert.equal(birthdayValue("5", "7"), "07-05");
  assert.equal(birthdayValue(9, 12), "12-09");
});

test("birthdaySelects: 31 días, 12 meses en español y prefijo de ids", () => {
  const s = birthdaySelects("clubBday");
  assert.match(s, /id="clubBdayDay" name="bday_day"/);
  assert.match(s, /id="clubBdayMonth" name="bday_month"/);
  assert.equal((s.match(/<option value="\d+">/g) || []).length, 43); // 31 días + 12 meses
  assert.ok(s.includes(">Septiembre<") && s.includes(">Diciembre<"));
  assert.ok(s.includes('<option value="">Día</option>') && s.includes('<option value="">Mes</option>'));
});

/* ── SSR ── */

test("la página entera sigue saliendo y sus dos scripts parsean", () => {
  for (const page of [html, htmlBday]) {
    assert.doesNotThrow(() => new Function(scriptOf(page, "clubPure")));
    assert.doesNotThrow(() => new Function(scriptOf(page, "clubMain")));
    assert.ok(scriptOf(page, "clubPure").startsWith("var __name=function(f){return f};"));
  }
  const main = scriptOf(htmlBday, "clubMain");
  assert.ok(main.includes(`api("profile"`), "el runtime no guarda el cumpleaños con sesión");
  assert.ok(main.includes(`api("feedback"`), "el runtime no envía la opinión");
});

test("SSR login: cumpleaños opcional solo con la config habilitada", () => {
  assert.ok(!viewInner(html).includes("bday_day"));
  assert.ok(!viewInner(html).includes("Te enviamos un regalo en tu cumpleaños."));
  const login = viewInner(htmlBday);
  assert.match(login, /<label>Cumpleaños \(opcional\)<\/label>/);
  assert.ok(login.includes("Te enviamos un regalo en tu cumpleaños."));
  assert.ok(login.includes('name="bday_day"') && login.includes('name="bday_month"'));
  assert.ok(htmlBday.includes(".bday{display:grid"));
});

test("textos nuevos del contrato presentes y sin voseo", () => {
  for (const copy of [
    "¿Cómo estuvo tu visita?",
    "Cuéntanos qué pasó (solo lo ve el restaurante)",
    "Tu respuesta es privada y nos ayuda a mejorar.",
    "Gracias",
    "Guardar cumpleaños",
    "Ahora no",
    "Escribir reseña",
    "🎂 Cumpleaños",
    "👋 Te extrañamos",
  ]) assert.ok(htmlBday.includes(copy), `falta el texto: ${copy}`);
  assert.ok(!/\b(jugá|tenés|podés|querés|mirá|esperá|andá|acá|aboná)\b/i.test(html + htmlBday));
});

/* ── DOM mínimo para ejecutar el runtime real del HTML ── */
const ctx2d = {
  clearRect() {}, beginPath() {}, moveTo() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
  save() {}, restore() {}, translate() {}, rotate() {}, fillRect() {}, fillText() {}, strokeText() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  getImageData: () => ({ data: new Uint8ClampedArray(4) }),
};

class El {
  constructor(tag = "div", id = "") {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this._html = "";
    this.textContent = "";
    this.className = "";
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.width = 640;
    this.height = 640;
    this.offsetWidth = 640;
    this._l = {};
    this._q = {};
    this.classList = { _s: new Set(), add: c => this.classList._s.add(c), remove: c => this.classList._s.delete(c) };
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  addEventListener(t, fn) { (this._l[t] ||= []).push(fn); }
  dispatch(t, ev = {}) { for (const fn of this._l[t] || []) fn({ preventDefault() {}, target: this, ...ev }); }
  contains() { return true; }
  closest() { return null; }
  appendChild(el) { el.parent = this; }
  remove() { this.removed = true; }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { width: 320, height: 170, left: 0, top: 0 }; }
  getContext() { return ctx2d; }
  querySelector(sel) {
    if (sel in this._q) return this._q[sel];
    let el = null;
    const m = /^#([\w-]+)$/.exec(sel);
    if (m) {
      if (this.id === m[1]) el = this;
      else if (this._html.includes(`id="${m[1]}"`)) { el = new El("form", m[1]); el._html = this._html; }
    } else if (/^\[[\w-]+(=[\w-]+)?\]$/.test(sel) || sel === "button[type=submit]") el = new El("input");
    if (el) this._q[sel] = el;
    return el;
  }
}

function form(id, values = {}) {
  const els = {};
  const f = {
    id, _l: {},
    addEventListener(t, fn) { (f._l[t] ||= []).push(fn); },
    dispatch(t, ev = {}) { for (const fn of f._l[t] || []) fn({ preventDefault() {}, target: f, ...ev }); },
    querySelector(sel) {
      if (els[sel]) return els[sel];
      const m = /^\[name=(\w+)\]$/.exec(sel);
      if (m) return (els[sel] = Object.assign(new El("input"), { value: values[m[1]] ?? "" }));
      if (sel === "button[type=submit]") return (els[sel] = new El("button"));
      return null;
    },
  };
  return f;
}

function makeDom({ page = htmlBday, program: prog = programBday, routes = {}, geo = "ok" }) {
  const calls = [], created = [], timers = [], nodes = new Map(), counts = {};
  const view = new El("main", "clubView");
  view.innerHTML = viewInner(page);
  const out = new El("button", "clubLogout");
  out.hidden = true;
  const toast = new El("div", "clubToast");
  nodes.set("clubView", view);
  nodes.set("clubLogout", out);
  nodes.set("clubToast", toast);
  let reloads = 0;
  const location = { href: "", reload() { reloads++; } };
  const geolocation = {
    getCurrentPosition(ok, bad) {
      geo === "fail" ? bad(new Error("denied")) : ok({ coords: { latitude: -0.18, longitude: -78.48 } });
    },
  };
  const fetchMock = async (url, opts = {}) => {
    const name = String(url).split("/").pop();
    calls.push({ url, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    const queue = routes[name] || [{ status: 404, data: { error: "sin_ruta" } }];
    const i = Math.min(counts[name] || 0, queue.length - 1);
    counts[name] = (counts[name] || 0) + 1;
    return { status: queue[i].status, json: async () => queue[i].data ?? {} };
  };
  const document = {
    getElementById(id) {
      if (nodes.has(id)) return nodes.get(id);
      const hay = [view, ...created].map(e => e._html || "").join("");
      if (hay.includes(`id="${id}"`)) { const el = new El("div", id); nodes.set(id, el); return el; }
      return null;
    },
    createElement(tag) { const el = new El(tag); created.push(el); return el; },
    body: { appendChild() {} },
  };
  const context = vm.createContext({
    window: { __CLUB__: prog },
    document,
    fetch: fetchMock,
    location,
    navigator: { geolocation },
    console,
    setTimeout: fn => timers.push(fn),
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame: fn => fn(),
  });
  vm.runInContext(scriptOf(page, "clubPure"), context);
  vm.runInContext(scriptOf(page, "clubMain"), context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    let guard = 0;
    while (timers.length && guard++ < 40) {
      timers.shift()();
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    }
  };
  return { view, out, toast, calls, created, settle, form, byId: id => document.getElementById(id), reloads: () => reloads };
}

const baseMe = {
  customer: { name: "Ana", phone: "593991234567", stamps: 3, visits: 5, cards_completed: 1 },
  program: programBday,
  can_play: true,
  next_play_at: null,
  rewards: [],
  wallet_url: null,
};
const click = (dom, dataset) => dom.view.dispatch("click", { target: { closest: () => ({ dataset }) } });
const loginRoute = () => [{ status: 401, data: { error: "sin_sesion", program: programBday } }];
// Resultado de jugada que no gira la ruleta (segmento -1) para llegar directo al resultado.
const playLoss = me => ({
  status: 200,
  data: { result: { segment_index: -1, won: false, prize: null, reward_id: null, card_completed: false, stamps_reward_id: null }, me },
});

/* ── cumpleaños ── */

test("runtime login: manda el cumpleaños elegido y lo omite si queda vacío", async () => {
  const dom = makeDom({
    routes: { me: loginRoute(), login: [{ status: 200, data: baseMe }] },
  });
  await dom.settle();
  dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567", bday_day: "5", bday_month: "7" }) });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/login").body, { name: "Ana", phone: "0991234567", birthday: "07-05" });
  assert.match(dom.view.innerHTML, /Hola, Ana/);
});

test("runtime login: sin cumpleaños el cuerpo no lleva la clave", async () => {
  const dom = makeDom({ routes: { me: loginRoute(), login: [{ status: 200, data: baseMe }] } });
  await dom.settle();
  dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567" }) });
  await dom.settle();
  const body = dom.calls.find(c => c.url === "/club/api/login").body;
  assert.equal("birthday" in body, false);
});

test("runtime login: día sin mes avisa y no intenta entrar", async () => {
  const dom = makeDom({ routes: { me: loginRoute(), login: [{ status: 200, data: baseMe }] } });
  await dom.settle();
  dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567", bday_day: "5", bday_month: "" }) });
  await dom.settle();
  assert.match(dom.byId("clubErr").textContent, /Elige día y mes de tu cumpleaños, o déjalo vacío\./);
  assert.equal(dom.calls.some(c => c.url === "/club/api/login"), false);
});

test("runtime: sin cumpleaños guardado, la sesión muestra el aviso y lo guarda", async () => {
  const saved = { ...baseMe, customer: { ...baseMe.customer, birthday: "07-05" } };
  const dom = makeDom({
    routes: { me: [{ status: 200, data: baseMe }], profile: [{ status: 200, data: saved }] },
  });
  await dom.settle();
  const home = dom.view.innerHTML;
  assert.ok(home.includes("Te enviamos un regalo en tu cumpleaños"));
  assert.ok(home.includes('id="clubBdayForm"'));
  assert.ok(home.includes('name="bday_day"') && home.includes('name="bday_month"'));
  assert.ok(home.includes(">Guardar cumpleaños<"));
  assert.ok(home.includes(">Ahora no<"));

  dom.view.dispatch("submit", { target: form("clubBdayForm", { bday_day: "5", bday_month: "7" }) });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/profile"),
    { url: "/club/api/profile", method: "POST", body: { birthday: "07-05" } });
  assert.match(dom.toast.textContent, /Te enviamos un regalo en tu cumpleaños/);
  assert.ok(!dom.view.innerHTML.includes('id="clubBdayForm"'), "el aviso desaparece al guardar");
});

test("runtime: con cumpleaños guardado o config apagada no aparece el aviso", async () => {
  const withBday = { ...baseMe, customer: { ...baseMe.customer, birthday: "12-09" } };
  const dom = makeDom({ routes: { me: [{ status: 200, data: withBday }] } });
  await dom.settle();
  assert.ok(!dom.view.innerHTML.includes("clubBdayForm"));

  const off = makeDom({ page: html, program, routes: { me: [{ status: 200, data: { ...baseMe, program } }] } });
  await off.settle();
  assert.ok(!off.view.innerHTML.includes("clubBdayForm"));
});

test("runtime: 'Ahora no' oculta el aviso en esta visita", async () => {
  const dom = makeDom({ routes: { me: [{ status: 200, data: baseMe }] } });
  await dom.settle();
  click(dom, { act: "dismissBday" });
  assert.ok(!dom.view.innerHTML.includes("clubBdayForm"));
});

/* ── opinión privada ── */

test("runtime: tras la jugada pide opinión 1–5 y la reseña sigue visible", async () => {
  const dom = makeDom({
    routes: {
      me: [{ status: 200, data: baseMe }],
      play: [playLoss(baseMe)],
      feedback: [{ status: 200, data: { ok: true } }],
    },
  });
  await dom.settle();
  click(dom, { act: "start", game: "wheel" });
  await dom.settle();
  const res = dom.view.innerHTML;
  assert.ok(res.includes("¿Cómo estuvo tu visita?"));
  assert.equal((res.match(/data-act="rate"/g) || []).length, 5);
  assert.ok(res.includes('data-rating="1"') && res.includes('data-rating="5"'));
  assert.ok(res.includes("Escribir reseña"));
  assert.ok(res.includes('href="https://g.page/r/abc"'));

  click(dom, { act: "rate", rating: "5" });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/feedback").body, { rating: 5 });
  assert.match(dom.view.innerHTML, /¡Gracias! Nos alegra que la hayas pasado bien\./);
  assert.ok(dom.view.innerHTML.includes("Escribir reseña"), "la reseña nunca se oculta");
});

test("runtime: nota baja pide comentario privado y la reseña queda abajo, discreta", async () => {
  const dom = makeDom({
    routes: {
      me: [{ status: 200, data: baseMe }],
      play: [playLoss(baseMe)],
      feedback: [{ status: 200, data: { ok: true } }],
    },
  });
  await dom.settle();
  click(dom, { act: "start", game: "wheel" });
  await dom.settle();

  click(dom, { act: "rate", rating: "2" });
  await dom.settle();
  assert.equal(dom.calls.some(c => c.url === "/club/api/feedback"), false, "1–3 espera el comentario");
  const low = dom.view.innerHTML;
  assert.ok(low.includes("Cuéntanos qué pasó (solo lo ve el restaurante)"));
  assert.match(low, /<textarea id="clubFeedbackComment" name="comment" maxlength="500"/);
  assert.ok(low.includes('data-act="rate" data-rating="2"'));
  assert.match(low, /class="review low"/);
  assert.ok(low.includes("Escribir reseña"), "con nota baja la reseña se muestra igual");

  dom.view.dispatch("submit", { target: form("clubFeedbackForm", { comment: "La música estaba muy alta." }) });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/feedback").body, { rating: 2, comment: "La música estaba muy alta." });
  assert.match(dom.view.innerHTML, /¡Gracias! Tomamos nota para mejorar\./);
  assert.ok(dom.view.innerHTML.includes("Escribir reseña"), "sigue visible aunque ya envió la opinión");
});

test("runtime: 409 sin_visita no molesta con un error y agradece igual", async () => {
  const dom = makeDom({
    routes: {
      me: [{ status: 200, data: baseMe }],
      play: [playLoss(baseMe)],
      feedback: [{ status: 409, data: { error: "sin_visita" } }],
    },
  });
  await dom.settle();
  click(dom, { act: "start", game: "wheel" });
  await dom.settle();
  click(dom, { act: "rate", rating: "4" });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Gracias/);
  assert.ok(!dom.view.innerHTML.includes("No pudimos enviar tu opinión"));
});

/* ── premios con etiqueta ── */

test("runtime: premios birthday/winback con su etiqueta y los de juego sin ella", async () => {
  const me = {
    ...baseMe,
    rewards: [
      { id: "b", label: "Postre de cumpleaños", source: "birthday", status: "active", created_at: 1, expires_at: null, redeemed_at: null },
      { id: "w", label: "Café de regreso", source: "winback", status: "active", created_at: 1, expires_at: null, redeemed_at: null },
      { id: "g", label: "Café gratis", source: "game", status: "active", created_at: 1, expires_at: null, redeemed_at: null },
    ],
  };
  const dom = makeDom({ routes: { me: [{ status: 200, data: me }] } });
  await dom.settle();
  const out = dom.view.innerHTML;
  assert.match(out, /Postre de cumpleaños[\s\S]*?🎂 Cumpleaños/);
  assert.match(out, /Café de regreso[\s\S]*?👋 Te extrañamos/);
  assert.equal((out.match(/class="tag gift"/g) || []).length, 2);
  assert.match(out, /<span class="rw-label">Café gratis<\/span><\/div><button/, "el premio de juego no lleva etiqueta de regalo");
});
