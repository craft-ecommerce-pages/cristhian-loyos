// Tests del sprint "Modo caja" en la página del club: botón "Mostrar mi tarjeta", QR a pantalla
// completa, sondeo de /club/api/me mientras está abierta y reacciones a sello, tarjeta y crédito.
// Sin dependencias: DOM mínimo + vm, igual que page-seguridad.test.mjs y page-creditos.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderPage, programOf, groupCardCode } from "../src/page.js";
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
const oneGameCfg = { ...cfg, games: ["wheel"] };

const page = renderPage(menu, cfg);
const pageOne = renderPage(menu, oneGameCfg);
const program = programOf(menu, cfg);
const programOne = programOf(menu, oneGameCfg);

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

/* ── DOM mínimo para ejecutar el runtime real del HTML ── */
function makeCtx() {
  return {
    fillStyle: "",
    rects: [],
    fillRect(x, y, w, h) { this.rects.push({ x, y, w, h, fill: this.fillStyle }); },
    clearRect() {}, beginPath() {}, moveTo() {}, arc() {}, closePath() {}, fill() {}, stroke() {},
    save() {}, restore() {}, translate() {}, rotate() {}, fillText() {}, strokeText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
}

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
    this.width = 0;
    this.height = 0;
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
  getContext() { return (this._ctx ||= makeCtx()); }
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

function makeDom({ page: html = page, program: prog = program, routes = {} }) {
  const calls = [], created = [], timers = [], intervals = new Map(), nodes = new Map(), counts = {};
  const clock = { value: Date.now() };
  let seq = 0;
  const view = new El("main", "clubView");
  view.innerHTML = viewInner(html);
  const out = new El("button", "clubLogout");
  out.hidden = true;
  const toast = new El("div", "clubToast");
  nodes.set("clubView", view);
  nodes.set("clubLogout", out);
  nodes.set("clubToast", toast);
  const location = { href: "", reload() {} };
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
  class FakeDate extends Date {
    static now() { return clock.value; }
  }
  const context = vm.createContext({
    window: { __CLUB__: prog },
    document,
    fetch: fetchMock,
    location,
    navigator: { geolocation: { getCurrentPosition(ok) { ok({ coords: { latitude: -0.18, longitude: -78.48 } }); } } },
    console,
    Date: FakeDate,
    TextEncoder,
    setTimeout: fn => { timers.push(fn); return ++seq; },
    clearTimeout() {},
    setInterval: (fn, ms) => { const id = ++seq; intervals.set(id, { fn, ms }); return id; },
    clearInterval: id => { intervals.delete(id); },
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
  const fireIntervals = async () => {
    for (const { fn } of [...intervals.values()]) await fn();
    await settle();
  };
  return {
    view, out, toast, calls, created, settle, fireIntervals, clock,
    activeIntervals: () => [...intervals.values()],
    byId: id => document.getElementById(id),
  };
}

const card = { code: "ABCD2345EF", url: "https://cafe.craft-systems.com/club/t/ABCD2345EF" };
const meSinCard = {
  customer: { name: "Ana", stamps: 3, visits: 5, cards_completed: 1 },
  program,
  can_play: true,
  next_play_at: null,
  rewards: [],
  wallet_url: null,
};
const meConCard = { ...meSinCard, card };
const meCalls = dom => dom.calls.filter(c => c.url === "/club/api/me").length;
const click = (dom, dataset) => dom.view.dispatch("click", { target: { closest: () => ({ dataset }) } });
const openCard = async dom => {
  click(dom, { act: "card" });
  await dom.settle();
};

test("groupCardCode: grupos de 4, mayúsculas y sin espacios de sobra", () => {
  assert.equal(groupCardCode("ABCD2345EF"), "ABCD 2345 EF");
  assert.equal(groupCardCode(" abcd 2345 ef "), "ABCD 2345 EF");
  assert.equal(groupCardCode("ABCD"), "ABCD");
  assert.equal(groupCardCode(""), "");
  assert.equal(groupCardCode(null), "");
});

test("botón 'Mostrar mi tarjeta' solo cuando /me trae card", async () => {
  // El SSR no conoce la sesión: el botón nunca sale en el HTML inicial.
  assert.ok(!viewInner(page).includes("Mostrar mi tarjeta"));

  const sin = makeDom({ routes: { me: [{ status: 200, data: meSinCard }] } });
  await sin.settle();
  assert.ok(!sin.view.innerHTML.includes("Mostrar mi tarjeta"), "backend viejo: sin botón");

  const con = makeDom({ routes: { me: [{ status: 200, data: meConCard }] } });
  await con.settle();
  assert.ok(con.view.innerHTML.includes("Mostrar mi tarjeta"));
  assert.ok(con.view.innerHTML.includes('data-act="card"'));
});

test("la tarjeta abre el QR a pantalla completa con código, nombre y respaldo del PIN", async () => {
  const dom = makeDom({ routes: { me: [{ status: 200, data: meConCard }] } });
  await dom.settle();
  await openCard(dom);
  const html = dom.view.innerHTML;
  assert.ok(html.includes('class="card-scan"'));
  assert.ok(html.includes('id="clubCardQr"'));
  assert.ok(html.includes('id="clubCardCode"'));
  assert.ok(html.includes('id="clubCardName"'));
  assert.ok(html.includes("Muéstrala al mesero para sumar tu sello"));
  assert.ok(html.includes("¿Sin escáner? Usa el PIN del mesero"));
  assert.ok(html.includes('data-act="cardClose"'));
  assert.equal(dom.byId("clubCardName").textContent, "Ana");
  assert.equal(dom.byId("clubCardCode").textContent, "ABCD 2345 EF");

  const cv = dom.byId("clubCardQr");
  const ctx = cv.getContext();
  const black = ctx.rects.filter(r => r.fill === "#000");
  assert.ok(cv.width > 0 && cv.height === cv.width, "el canvas se dimensiona cuadrado");
  assert.ok(black.length > 0, "se pintan módulos negros");
  assert.ok(ctx.rects.some(r => r.fill === "#fff" && r.w === cv.width && r.h === cv.height), "fondo blanco completo");
  // Zona de silencio: 4 módulos (px) libres en los cuatro bordes.
  const unit = black[0].w;
  const minX = Math.min(...black.map(r => r.x)), minY = Math.min(...black.map(r => r.y));
  const maxX = Math.max(...black.map(r => r.x + r.w)), maxY = Math.max(...black.map(r => r.y + r.h));
  assert.ok(minX >= 4 * unit && minY >= 4 * unit, "margen izquierdo/superior de 4 módulos");
  assert.ok(maxX <= cv.width - 4 * unit && maxY <= cv.height - 4 * unit, "margen derecho/inferior de 4 módulos");
});

test("el sondeo cada 3 s detecta el sello y muestra el resultado", async () => {
  const after = { ...meConCard, customer: { ...meConCard.customer, stamps: 4, visits: 6 } };
  const dom = makeDom({
    routes: { me: [{ status: 200, data: meConCard }, { status: 200, data: after }] },
  });
  await dom.settle();
  await openCard(dom);
  assert.equal(dom.activeIntervals().length, 1);
  assert.equal(dom.activeIntervals()[0].ms, 3000);
  assert.equal(meCalls(dom), 1);

  await dom.fireIntervals();
  assert.equal(meCalls(dom), 2);
  const html = dom.view.innerHTML;
  assert.ok(!html.includes("card-scan"), "la tarjeta se cierra al detectar el cambio");
  assert.match(html, /Sello sumado/);
  assert.match(html, /Sello 4 de 8\./);
  assert.equal(dom.activeIntervals().length, 0, "el sondeo se detiene al mostrar el resultado");
});

test("el sondeo se detiene al cerrar la tarjeta y no vuelve a consultar", async () => {
  const dom = makeDom({ routes: { me: [{ status: 200, data: meConCard }] } });
  await dom.settle();
  await openCard(dom);
  assert.equal(dom.activeIntervals().length, 1);

  click(dom, { act: "cardClose" });
  await dom.settle();
  assert.ok(dom.view.innerHTML.includes("Mostrar mi tarjeta"));
  assert.ok(!dom.view.innerHTML.includes("card-scan"));
  assert.equal(dom.activeIntervals().length, 0);
  assert.equal(meCalls(dom), 1);

  await dom.fireIntervals();
  assert.equal(meCalls(dom), 1, "sin intervalos activos no hay consultas nuevas");
});

test("el sondeo se corta a los 5 minutos (la tarjeta sigue visible)", async () => {
  const dom = makeDom({ routes: { me: [{ status: 200, data: meConCard }] } });
  await dom.settle();
  await openCard(dom);
  dom.clock.value += 300001;
  await dom.fireIntervals();
  assert.equal(meCalls(dom), 1, "pasado el máximo no consulta");
  assert.equal(dom.activeIntervals().length, 0);
  assert.ok(dom.view.innerHTML.includes("card-scan"), "la tarjeta no se cierra sola");
});

test("la tarjeta no mete datos del cliente en innerHTML", async () => {
  const evil = {
    ...meConCard,
    customer: { ...meConCard.customer, name: '<img src=x onerror="alert(1)">' },
    card: { code: "<script>alert(1)</script>", url: card.url },
  };
  const dom = makeDom({ routes: { me: [{ status: 200, data: evil }] } });
  await dom.settle();
  await openCard(dom);
  const html = dom.view.innerHTML;
  assert.ok(!html.includes("<img src=x"), "el nombre no entra por innerHTML");
  assert.ok(!html.includes("<script>"), "el código no entra por innerHTML");
  assert.equal(dom.byId("clubCardName").textContent, '<img src=x onerror="alert(1)">');
  assert.equal(dom.byId("clubCardCode").textContent, groupCardCode("<script>alert(1)</script>"));
});

test("tarjeta completa detectada por sondeo reusa la pantalla y ofrece el premio", async () => {
  const reward = {
    id: "r9", label: "Un postre gratis", source: "stamps", status: "active",
    created_at: 1, expires_at: null, redeemed_at: null,
  };
  const after = {
    ...meConCard,
    customer: { ...meConCard.customer, stamps: 0, cards_completed: 2, visits: 6 },
    rewards: [reward],
  };
  const dom = makeDom({
    routes: { me: [{ status: 200, data: meConCard }, { status: 200, data: after }] },
  });
  await dom.settle();
  await openCard(dom);
  await dom.fireIntervals();
  const html = dom.view.innerHTML;
  assert.match(html, /¡Tarjeta completa!/);
  assert.ok(html.includes('data-act="redeem" data-id="r9"'));
  assert.equal(dom.activeIntervals().length, 0);
});

test("crédito validado en caja ofrece jugar con credit:true", async () => {
  const meCredit = { ...meConCard, program: programOne, credits: { granted: 0, pending: 0 } };
  const after = { ...meCredit, credits: { granted: 1, pending: 0 } };
  const ack = {
    status: 200,
    data: {
      result: { segment_index: -1, won: false, prize: null, reward_id: null, card_completed: false, stamps_reward_id: null },
      me: after,
    },
  };
  const dom = makeDom({
    page: pageOne, program: programOne,
    routes: { me: [{ status: 200, data: meCredit }, { status: 200, data: after }], play: [ack] },
  });
  await dom.settle();
  await openCard(dom);
  await dom.fireIntervals();
  const html = dom.view.innerHTML;
  assert.match(html, /¡Visita validada!/);
  assert.ok(html.includes('data-act="credit" data-game="wheel"'));
  assert.ok(html.includes("Toca para jugar"));

  click(dom, { act: "credit", game: "wheel" });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "wheel", credit: true });
});

test("el respaldo del PIN cierra la tarjeta y abre el formulario de siempre", async () => {
  const dom = makeDom({ routes: { me: [{ status: 200, data: meConCard }] } });
  await dom.settle();
  await openCard(dom);
  click(dom, { act: "cardPin" });
  await dom.settle();
  const html = dom.view.innerHTML;
  assert.ok(html.includes('id="clubPinForm"'));
  assert.ok(html.includes("Muéstrale tu tarjeta o pídele al mesero que escriba su PIN para validar tu visita."));
  assert.ok(!html.includes("card-scan"));
  assert.equal(dom.activeIntervals().length, 0);
});
