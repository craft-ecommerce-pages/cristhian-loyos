// Tests del sprint "Club endurecido" en la página: verificación por PIN en login, PIN obligatorio
// para jugar, errores de dispositivo y vencimiento de premios. Sin dependencias: DOM mínimo + vm.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderPage, programOf, expiryText } from "../src/page.js";
import { normalizeConfig } from "../src/contract.js";

const menu = {
  store_name: "Café Central",
  theme_primary: "#c0392b",
  theme_accent: "#f1c40f",
  location: { sedes: [{ lat: -0.1807, lng: -78.4678 }] },
};
const cfg = normalizeConfig({
  enabled: true,
  prizes: [{ id: "cafe", label: "Café gratis", weight: 20 }],
  lose_weight: 70,
  stamps_goal: 8,
  stamps_reward: { label: "Un postre gratis" },
});

const scriptOf = (html, id) => {
  const m = new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`).exec(html);
  assert.ok(m, `falta <script id="${id}">`);
  return m[1];
};
const viewInner = html => {
  const m = /<main id="clubView" class="club-view">([\s\S]*?)<\/main>/.exec(html);
  assert.ok(m, "el HTML no trae clubView");
  return m[1];
};

test("la página entera sigue saliendo y sus dos scripts parsean", () => {
  const html = renderPage(menu, cfg);
  assert.doesNotThrow(() => new Function(scriptOf(html, "clubPure")));
  assert.doesNotThrow(() => new Function(scriptOf(html, "clubMain")));
  // El bundle de wrangler sigue teniendo su __name nulo para el runtime serializado.
  assert.ok(scriptOf(html, "clubPure").startsWith("var __name=function(f){return f};"));
});

test("SSR: campo PIN del login oculto hasta que el servidor lo pida", () => {
  const html = renderPage(menu, cfg);
  assert.match(html, /<label for="clubLoginPin" id="clubLoginPinLabel" hidden>PIN del mesero<\/label>/);
  assert.match(html, /<input[^>]*id="clubLoginPin"[^>]*hidden>/);
  assert.match(html, /maxlength="6"/);
});

test("textos nuevos del contrato presentes y sin voseo", () => {
  const html = renderPage(menu, cfg);
  for (const copy of [
    "Este número ya tiene sellos o premios. Pide al mesero que escriba su PIN para vincular este celular",
    "Este celular ya tiene el máximo de cuentas.",
    "Demasiados intentos. Prueba mañana o pide ayuda al personal.",
    "Este local pide el PIN del mesero en cada jugada.",
    "Vence hoy",
    "Vence en ",
    "Vencido",
  ]) assert.ok(html.includes(copy), `falta el texto: ${copy}`);
  assert.ok(!/\b(jugá|tenés|podés|querés|mirá|esperá|andá|acá|aboná)\b/i.test(html));
});

test("program.pin_required: config explícita o menú sin sedes con coordenadas", () => {
  assert.equal(programOf(menu, cfg).pin_required, false);
  assert.equal(programOf(menu, { ...cfg, require_pin: true }).pin_required, true);
  assert.equal(programOf({}, cfg).pin_required, true);
  assert.equal(programOf({ location: { sedes: [{ lat: "x" }] } }, cfg).pin_required, true);
});

test("expiryText: sin fecha, vencido, hoy y N días", () => {
  const now = Date.UTC(2026, 9, 23, 12);
  assert.equal(expiryText(null, now), "");
  assert.equal(expiryText(undefined, now), "");
  assert.equal(expiryText(now - 1, now), "");
  assert.equal(expiryText(now + 3_600_000, now), "Vence hoy");
  assert.equal(expiryText(now + 86_400_000, now), "Vence hoy");
  assert.equal(expiryText(now + 86_400_001, now), "Vence en 2 días");
  assert.equal(expiryText(now + 10 * 86_400_000, now), "Vence en 10 días");
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

function makeDom({ html, program, routes = {}, geo = "ok" }) {
  const calls = [], created = [], timers = [], nodes = new Map(), counts = {};
  const view = new El("main", "clubView");
  view.innerHTML = viewInner(html);
  const out = new El("button", "clubLogout");
  out.hidden = true;
  const toastEl = new El("div", "clubToast");
  nodes.set("clubView", view);
  nodes.set("clubLogout", out);
  nodes.set("clubToast", toastEl);
  const location = { href: "", reload() {} };
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
    window: { __CLUB__: program },
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
  vm.runInContext(scriptOf(html, "clubPure"), context);
  vm.runInContext(scriptOf(html, "clubMain"), context);
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
    let guard = 0;
    while (timers.length && guard++ < 40) {
      timers.shift()();
      for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
    }
  };
  return { view, out, toast: toastEl, calls, created, settle, form, byId: id => document.getElementById(id) };
}

const html = renderPage(menu, cfg);
const program = programOf(menu, cfg);
const baseMe = {
  customer: { name: "Ana", phone: "593991234567", stamps: 3, visits: 5, cards_completed: 1 },
  program,
  can_play: true,
  next_play_at: null,
  rewards: [],
  wallet_url: null,
};
const click = (dom, dataset) => dom.view.dispatch("click", { target: { closest: () => ({ dataset }) } });

test("runtime: verificacion_requerida revela el PIN y reintenta login con pin", async () => {
  const dom = makeDom({
    html, program,
    routes: {
      me: [{ status: 401, data: { error: "sin_sesion", program } }],
      login: [
        { status: 403, data: { error: "verificacion_requerida" } },
        { status: 200, data: baseMe },
      ],
    },
  });
  await dom.settle();

  dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567" }) });
  await dom.settle();
  assert.match(dom.byId("clubErr").textContent, /Este número ya tiene sellos o premios/);
  assert.equal(dom.byId("clubLoginPin").hidden, false);
  assert.deepEqual(dom.calls.filter(c => c.url === "/club/api/login")[0].body, { name: "Ana", phone: "0991234567" });

  dom.byId("clubLoginPin").value = "4821";
  dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567" }) });
  await dom.settle();
  assert.deepEqual(dom.calls.filter(c => c.url === "/club/api/login")[1].body, { name: "Ana", phone: "0991234567", pin: "4821" });
  assert.match(dom.view.innerHTML, /Hola, Ana/);
});

test("runtime: limite_dispositivo y bloqueado se explican en el login", async () => {
  const dom = makeDom({
    html, program,
    routes: {
      me: [{ status: 401, data: { error: "sin_sesion", program } }],
      login: [
        { status: 429, data: { error: "limite_dispositivo" } },
        { status: 423, data: { error: "bloqueado" } },
      ],
    },
  });
  await dom.settle();

  const submit = () => dom.view.dispatch("submit", { target: form("clubLogin", { name: "Ana", phone: "0991234567" }) });
  submit();
  await dom.settle();
  assert.equal(dom.byId("clubErr").textContent, "Este celular ya tiene el máximo de cuentas.");

  submit();
  await dom.settle();
  assert.equal(dom.byId("clubErr").textContent, "Demasiados intentos. Prueba mañana o pide ayuda al personal.");
});

test("runtime: pin_required pide el PIN antes de jugar y no pide ubicación", async () => {
  const pinProgram = { ...program, pin_required: true };
  const me = { ...baseMe, program: pinProgram };
  const after = { ...me, customer: { ...me.customer, stamps: 4 }, rewards: [{ id: "r2", label: "Café gratis", source: "game", status: "active", created_at: 1, expires_at: null, redeemed_at: null }] };
  const dom = makeDom({
    html, program: pinProgram,
    geo: "fail", // si intentara geolocalizar igual pediría PIN; el cuerpo no debe llevar lat/lng
    routes: {
      me: [{ status: 200, data: me }],
      play: [{ status: 200, data: { result: { segment_index: 1, won: true, prize: { id: "cafe", label: "Café gratis" }, reward_id: "r2", card_completed: false, stamps_reward_id: null }, me: after } }],
    },
  });
  await dom.settle();
  click(dom, { act: "start", game: "wheel" });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Este local pide el PIN del mesero en cada jugada/);
  assert.equal(dom.calls.some(c => c.url === "/club/api/play"), false, "no debe jugar sin PIN");

  dom.view.dispatch("submit", { target: form("clubPinForm", { pin: "4821" }) });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "wheel", pin: "4821" });
  assert.match(dom.view.innerHTML, /¡Ganaste!/);
});

test("runtime: pin_requerido del servidor muestra el campo (menú sin sedes)", async () => {
  const dom = makeDom({
    html, program,
    routes: {
      me: [{ status: 200, data: baseMe }],
      play: [{ status: 403, data: { error: "pin_requerido" } }],
    },
  });
  await dom.settle();
  click(dom, { act: "start", game: "wheel" });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Este local pide el PIN del mesero en cada jugada/);
  assert.match(dom.view.innerHTML, /id="clubPinForm"/);
});

test("runtime: premios con vencimiento y vencidos en gris", async () => {
  const now = Date.now();
  const me = {
    ...baseMe,
    rewards: [
      { id: "a", label: "Premio próximo", source: "game", status: "active", created_at: 1, expires_at: now + 10 * 86400000 + 43200000, redeemed_at: null },
      { id: "b", label: "Premio de hoy", source: "game", status: "active", created_at: 1, expires_at: now + 3600000, redeemed_at: null },
      { id: "c", label: "Premio viejo", source: "game", status: "active", created_at: 1, expires_at: now - 1000, redeemed_at: null },
      { id: "d", label: "Premio usado", source: "game", status: "redeemed", created_at: 1, expires_at: null, redeemed_at: now },
    ],
  };
  const dom = makeDom({ html, program, routes: { me: [{ status: 200, data: me }] } });
  await dom.settle();
  const out = dom.view.innerHTML;
  assert.ok(out.includes("Vence en 11 días"));
  assert.ok(out.includes("Vence hoy"));
  assert.match(out, /<li class="reward done">[\s\S]*?Premio viejo[\s\S]*?Vencido/);
  assert.match(out, /<li class="reward done">[\s\S]*?Premio usado[\s\S]*?Usado/);
  // el vencido no ofrece canje
  assert.ok(!out.includes('data-act="redeem" data-id="c"'));
  assert.ok(out.includes('data-act="redeem" data-id="a"'));
  assert.ok(html.includes(".reward.done .rw-label{color:var(--tx2)"));
});
