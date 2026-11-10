// Tests del sprint "Delivery, modos de juego y 2 QR" en la página: modo solo sellos,
// créditos por pedido a domicilio (aviso, botón sin PIN ni ubicación) y error sin_creditos.
// Sin dependencias: DOM mínimo + vm, igual que page-seguridad.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderPage, programOf, playMode } from "../src/page.js";
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
});
// M1 agrega play_mode a normalizeConfig; acá se arma el config normalizado que dejará el merge.
const stampsCfg = { ...baseCfg, play_mode: "stamps" };
const oneGameCfg = { ...baseCfg, games: ["wheel"] };

const html = renderPage(menu, baseCfg);
const htmlStamps = renderPage(menu, stampsCfg);
const program = programOf(menu, baseCfg);
const programStamps = programOf(menu, stampsCfg);
const programOne = programOf(menu, oneGameCfg);

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

test("playMode: stamps solo con el valor exacto; el resto cae en game", () => {
  assert.equal(playMode({ play_mode: "stamps" }), "stamps");
  assert.equal(playMode({ play_mode: "game" }), "game");
  assert.equal(playMode({ play_mode: "<b>" }), "game");
  assert.equal(playMode(undefined), "game");
  assert.equal(programOf(menu, baseCfg).play_mode, "game");
  assert.equal(programOf(menu, stampsCfg).play_mode, "stamps");
  assert.equal(programOf(menu, { play_mode: "stamps" }).play_mode, "stamps");
});

test("SSR en modo stamps: sin chips de juegos y con copy de visitas", () => {
  const main = viewInner(htmlStamps), mainGame = viewInner(html);
  assert.ok(htmlStamps.includes('"play_mode":"stamps"'));
  assert.ok(htmlStamps.includes("Suma un sello en cada visita a Café Central y gana premios."));
  assert.ok(!main.includes(">Ruleta<"));
  assert.ok(!main.includes(">Raspadita<"));
  assert.ok(htmlStamps.includes("8 sellos = Un postre gratis"));
  // el modo game no cambia
  assert.ok(mainGame.includes(">Ruleta<"));
  assert.ok(html.includes("Juega en cada visita a Café Central"));
});

test("SSR: estilos del aviso de créditos y textos nuevos sin voseo", () => {
  assert.ok(html.includes(".card.credit{border-color:color-mix("));
  assert.ok(!/\b(jugá|tenés|podés|querés|mirá|esperá|andá|acá|aboná)\b/i.test(html + htmlStamps));
});

/* ── DOM mínimo para ejecutar el runtime real del HTML ── */
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

function makeDom({ page = html, program: prog = program, routes = {}, geo = "ok" }) {
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
  return {
    view, out, toast, calls, created, settle, form,
    byId: id => document.getElementById(id),
    reloads: () => reloads,
  };
}

const baseMe = {
  customer: { name: "Ana", phone: "593991234567", stamps: 3, visits: 5, cards_completed: 1 },
  program,
  can_play: true,
  next_play_at: null,
  rewards: [],
  wallet_url: null,
};
const click = (dom, dataset) => dom.view.dispatch("click", { target: { closest: () => ({ dataset }) } });
const stampAck = (me, stamps = 4) => ({
  status: 200,
  data: {
    result: { segment_index: -1, won: false, prize: null, reward_id: null, card_completed: false, stamps_reward_id: null },
    me: { ...me, customer: { ...me.customer, stamps, visits: me.customer.visits + 1 } },
  },
});

test("runtime stamps: botón Registrar visita, sin juegos, y registra la visita con geo", async () => {
  const me = { ...baseMe, program: programStamps };
  const dom = makeDom({
    page: htmlStamps, program: programStamps,
    routes: { me: [{ status: 200, data: me }], play: [stampAck(me)] },
  });
  await dom.settle();
  const home = dom.view.innerHTML;
  assert.ok(home.includes(">Registrar visita<"));
  assert.ok(!home.includes(">Jugar<"));
  assert.ok(!home.includes("Elige tu juego"));
  assert.ok(!home.includes("Ruleta"));

  click(dom, { act: "stamp" });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "stamp", lat: -0.18, lng: -78.48 });
  const res = dom.view.innerHTML;
  assert.match(res, /Visita registrada/);
  assert.match(res, /Sello 4 de 8/);
  assert.doesNotMatch(res, /¡Ganaste!|Casi lo logras|Ruleta|Raspadita/);
});

test("runtime stamps: con pin_required no registra sin PIN y el botón dice Validar visita", async () => {
  const pinProgram = { ...programStamps, pin_required: true };
  const me = { ...baseMe, program: pinProgram };
  const dom = makeDom({
    page: htmlStamps, program: pinProgram, geo: "fail",
    routes: { me: [{ status: 200, data: me }], play: [stampAck(me)] },
  });
  await dom.settle();
  click(dom, { act: "stamp" });
  await dom.settle();
  assert.equal(dom.calls.some(c => c.url === "/club/api/play"), false, "no debe registrar sin PIN");
  const pin = dom.view.innerHTML;
  assert.match(pin, /id="clubPinForm"/);
  assert.match(pin, />Validar visita</);
  assert.ok(!pin.includes("Validar y jugar"));

  dom.view.dispatch("submit", { target: form("clubPinForm", { pin: "4821" }) });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "stamp", pin: "4821" });
  assert.match(dom.view.innerHTML, /Visita registrada/);
});

test("runtime game con un solo juego: el crédito juega directo y sin PIN ni ubicación", async () => {
  const me = { ...baseMe, program: programOne, credits: { granted: 2, pending: 0 } };
  const dom = makeDom({
    page: html, program: programOne,
    routes: { me: [{ status: 200, data: me }], play: [stampAck(me)] },
  });
  await dom.settle();
  const home = dom.view.innerHTML;
  assert.match(home, /Tienes 2 jugadas por tu pedido a domicilio/);
  assert.ok(home.includes("Juégala desde donde estés"));
  assert.ok(home.includes('data-act="credit" data-game="wheel"'));

  click(dom, { act: "credit", game: "wheel" });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "wheel", credit: true });
});

test("runtime game con dos juegos: el crédito deja elegir y manda game + credit", async () => {
  const me = { ...baseMe, credits: { granted: 1, pending: 0 } };
  const dom = makeDom({
    page: html, program,
    routes: {
      me: [{ status: 200, data: me }],
      play: [{ status: 200, data: { result: { segment_index: -1, won: false, prize: null, reward_id: null }, me } }],
    },
  });
  await dom.settle();
  assert.ok(dom.view.innerHTML.includes('data-act="chooseCredit"'));
  click(dom, { act: "chooseCredit" });
  assert.match(dom.view.innerHTML, /Es tu jugada por pedido a domicilio: sin PIN ni ubicación/);
  assert.ok(dom.view.innerHTML.includes('data-act="credit" data-game="scratch"'));

  click(dom, { act: "credit", game: "scratch" });
  await dom.settle();
  const play = dom.calls.find(c => c.url === "/club/api/play");
  assert.deepEqual(play.body, { game: "scratch", credit: true });
});

test("runtime stamps: el crédito suma un sello con game stamp", async () => {
  const me = { ...baseMe, program: programStamps, credits: { granted: 1, pending: 0 } };
  const dom = makeDom({
    page: htmlStamps, program: programStamps,
    routes: { me: [{ status: 200, data: me }], play: [stampAck(me)] },
  });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Tienes 1 jugada por tu pedido a domicilio/);
  assert.ok(dom.view.innerHTML.includes('data-act="credit" data-game="stamp"'));
  assert.ok(dom.view.innerHTML.includes(">Registrar visita con mi crédito<"), "el botón del crédito no se confunde con la visita normal");

  click(dom, { act: "credit", game: "stamp" });
  await dom.settle();
  assert.deepEqual(dom.calls.find(c => c.url === "/club/api/play").body, { game: "stamp", credit: true });
});

test("runtime: play_mode de /me manda y, si falta, se usa el del SSR", async () => {
  const { play_mode, ...withoutMode } = programStamps;
  const domSsr = makeDom({ page: htmlStamps, program: programStamps, routes: { me: [{ status: 200, data: { ...baseMe, program: withoutMode } }] } });
  await domSsr.settle();
  assert.ok(domSsr.view.innerHTML.includes(">Registrar visita<"), "sin play_mode en /me debe seguir stamps");

  const domMe = makeDom({ page: html, program, routes: { me: [{ status: 200, data: { ...baseMe, program: programStamps } }] } });
  await domMe.settle();
  assert.ok(domMe.view.innerHTML.includes(">Registrar visita<"), "/me puede cambiar el modo del SSR");
});

test("runtime: sellos pendientes se avisan sin botón de jugada", async () => {
  const me = { ...baseMe, credits: { granted: 0, pending: 2 } };
  const dom = makeDom({ page: html, program, routes: { me: [{ status: 200, data: me }] } });
  await dom.settle();
  const home = dom.view.innerHTML;
  assert.match(home, /2 sellos por confirmar de tus pedidos a domicilio\. Se acreditan cuando el restaurante confirma la entrega o en tu próxima visita\./);
  assert.ok(!home.includes('data-act="credit"'));
  assert.ok(!home.includes("Jugar con mi crédito"));
  assert.ok(home.includes(">Jugar<"));
});

test("runtime: sin créditos ni avisos, la tarjeta queda igual que antes", async () => {
  const dom = makeDom({ page: html, program, routes: { me: [{ status: 200, data: baseMe }] } });
  await dom.settle();
  assert.ok(!dom.view.innerHTML.includes("Pedido a domicilio"));
  // datos raros no inventan créditos
  for (const credits of [{ granted: "<img src=x>", pending: -3 }, { granted: 0, pending: 0 }, null]) {
    const odd = makeDom({ page: html, program, routes: { me: [{ status: 200, data: { ...baseMe, credits } }] } });
    await odd.settle();
    assert.ok(!odd.view.innerHTML.includes("Pedido a domicilio"), `créditos inválidos: ${JSON.stringify(credits)}`);
  }
});

test("runtime: sin_creditos avisa, refresca /me y no rompe la página", async () => {
  const me = {
    ...baseMe, program: programOne, credits: { granted: 1, pending: 0 },
    rewards: [{ id: "r1", label: "Café gratis", source: "game", status: "active", created_at: 1, expires_at: null, redeemed_at: null }],
  };
  const dom = makeDom({
    page: html, program: programOne,
    routes: {
      me: [{ status: 200, data: me }, { status: 200, data: { ...me, credits: { granted: 0, pending: 0 } } }],
      play: [{ status: 409, data: { error: "sin_creditos" } }],
    },
  });
  await dom.settle();
  click(dom, { act: "credit", game: "wheel" });
  await dom.settle();
  assert.match(dom.toast.textContent, /Ya no tienes jugadas por pedido a domicilio\./);
  assert.equal(dom.calls.filter(c => c.url === "/club/api/me").length, 2);
  assert.ok(!dom.view.innerHTML.includes("Pedido a domicilio"));
  assert.ok(dom.view.innerHTML.includes("Café gratis"));
});
