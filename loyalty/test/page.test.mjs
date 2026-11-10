// Tests del workstream C: SSR de /club, escape de datos del cliente, helpers puros y runtime inyectado.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage, programOf, esc, safeUrl, wheelStopAngle, revealPercent, remainingText } from "../src/page.js";
import { normalizeConfig } from "../src/contract.js";
import vm from "node:vm";

const menu = {
  store_name: "Café Central",
  logo: "https://media.craft-systems.com/cafe/logo.webp",
  favicon: "https://media.craft-systems.com/cafe/favicon.png",
  theme_primary: "#c0392b",
  theme_accent: "#f1c40f",
  fonts: "https://fonts.googleapis.com/css2?family=Anton&display=swap",
  location: { sedes: [{ lat: -0.1807, lng: -78.4678 }] },
};
const cfg = normalizeConfig({
  enabled: true,
  prizes: [{ id: "cafe", label: "Café gratis", weight: 20 }, { id: "postre", label: "Postre de la casa", weight: 5, expires_days: 30 }],
  lose_weight: 70,
  stamps_goal: 8,
  stamps_reward: { label: "Un postre gratis" },
  review_url: "https://g.page/r/abc",
  terms: "Promoción válida en el local.",
});

// Extrae el contenido de un <script id="…"> del HTML generado.
const scriptOf = (html, id) => {
  const m = new RegExp(`<script id="${id}">([\\s\\S]*?)<\\/script>`).exec(html);
  assert.ok(m, `falta <script id="${id}">`);
  return m[1];
};
const dataOf = html => {
  const raw = scriptOf(html, "clubData");
  return JSON.parse(raw.slice(raw.indexOf("window.__CLUB__=") + "window.__CLUB__=".length, raw.lastIndexOf(";")));
};
const browserPure = html => new Function(`${scriptOf(html, "clubPure")}
  return { esc, wheelStopAngle, revealPercent, remainingText };`)();

test("renderPage: shell completo con la marca del menú", () => {
  const html = renderPage(menu, cfg);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="es">/);
  assert.match(html, /name="viewport" content="width=device-width/);
  assert.match(html, /<title>Café Central · Club<\/title>/);
  assert.match(html, /--p:#c0392b/);
  assert.match(html, /--a:#f1c40f/);
  assert.match(html, /<meta name="theme-color" content="#c0392b">/);
  assert.ok(html.includes("https://media.craft-systems.com/cafe/logo.webp"));
  assert.ok(html.includes("https://fonts.googleapis.com/css2?family=Anton&amp;display=swap"));
  assert.ok(html.includes("Promoción válida en el local."));
  assert.match(html, /href="\/">← Ver menú/);
});

test("login SSR: nombre + WhatsApp, marca, juegos y premios sin sesión", () => {
  const html = renderPage(menu, cfg);
  assert.match(html, /<form id="clubLogin"/);
  assert.match(html, /id="clubName" name="name" maxlength="60"/);
  assert.match(html, /name="phone" type="tel" inputmode="tel"/);
  assert.ok(html.includes(">Ruleta<"));
  assert.ok(html.includes(">Raspadita<"));
  assert.ok(html.includes("Café gratis"));
  assert.ok(html.includes("8 sellos = Un postre gratis"));
  assert.ok(html.includes("Sigue participando")); // segmento de perder en los datos
});

test("renderPage escapa HTML inyectado (menú, programa y JSON)", () => {
  const evilMenu = {
    store_name: `<img src=x onerror="alert(1)">`,
    logo: "javascript:alert(2)",
    favicon: `" onerror="alert(3)`,
    fonts: `"><script>alert(4)</script>`,
    theme_primary: `red;}</style><script>alert(5)</script>`,
    theme_accent: `#fff;background:url(x)`,
    location: { sedes: [{ lat: 1, lng: 2 }] },
  };
  const evilCfg = normalizeConfig({
    enabled: true,
    prizes: [{ id: "x", label: `</script><script>alert(6)</script>`, weight: 1 }],
    terms: `<b onmouseover=alert(7)>x</b>`,
    review_url: "javascript:alert(8)",
  });
  const html = renderPage(evilMenu, evilCfg);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!/onerror="alert/.test(html));
  assert.ok(!html.includes("javascript:"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(!html.includes("<b onmouseover"));
  // el texto queda escapado y visible
  assert.ok(html.includes(`&lt;img src=x onerror=&quot;alert(1)&quot;&gt;`));
  assert.ok(html.includes(`&lt;b onmouseover=alert(7)&gt;x&lt;/b&gt;`));
  // el JSON embebido neutraliza el cierre de <script> (solo los 3 cierres propios)
  assert.ok(html.includes(`\\u003c/script`));
  assert.equal((html.match(/<\/script>/g) || []).length, 3);
  // colores no válidos caen al default
  assert.match(html, /--p:#E4801C/);
  assert.match(html, /--a:#F5B301/);
});

test("program embebido: misma forma que el del contrato y geo_required por sedes", () => {
  const html = renderPage(menu, cfg);
  const data = dataOf(html);
  assert.deepEqual(data, programOf(menu, cfg));
  assert.equal(data.store_name, "Café Central");
  assert.deepEqual(data.games, ["wheel", "scratch"]);
  assert.equal(data.geo_required, true);
  assert.equal(data.stamps_goal, 8);
  assert.equal(data.cooldown_hours, 12);
  assert.equal(data.review_url, "https://g.page/r/abc");
  assert.deepEqual(data.segments.map(s => s.id), ["cafe", "postre", null]);
  assert.equal(data.segments[2].label, "Sigue participando");
  // sin sedes válidas no se pide geolocalización
  assert.equal(programOf({ location: { sedes: [{ lat: "x", lng: 1 }, {}] } }, cfg).geo_required, false);
  assert.equal(programOf({}, cfg).geo_required, false);
});

test("renderPage tolera config vacío (menú recién creado)", () => {
  const html = renderPage(undefined, undefined);
  assert.match(html, /<title>el local · Club<\/title>/);
  assert.match(html, /--p:#E4801C/);
  assert.ok(!html.includes("fonts.googleapis.com/css2"));
  assert.equal(dataOf(html).geo_required, false);
  assert.equal(html.includes('<footer class="club-foot">'), false);
});

test("esc y safeUrl: texto y URLs del cliente", () => {
  assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
  assert.equal(esc(null), "");
  assert.equal(safeUrl("https://a.example/b.webp"), "https://a.example/b.webp");
  assert.equal(safeUrl(" /logo.png "), "/logo.png");
  assert.equal(safeUrl("//evil.example/x.png"), "");
  assert.equal(safeUrl("http://a.example"), "");
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl(null), "");
});

test("wheelStopAngle: el centro del segmento cae bajo el puntero y siempre gira hacia adelante", () => {
  for (const total of [1, 2, 3, 4, 5, 6, 8]) {
    const step = 360 / total;
    for (let i = 0; i < total; i++) {
      const angle = wheelStopAngle(i, total, 4);
      const pos = (((i + 0.5) * step + angle) % 360 + 360) % 360;
      assert.ok(Math.abs(pos - 270) < 1e-9, `total=${total} index=${i} pos=${pos}`);
      assert.ok(angle >= 1440 && angle < 1800, `vueltas de más/menos: ${angle}`);
    }
  }
  assert.ok(wheelStopAngle(3, 6, 5) > wheelStopAngle(2, 6, 4));
});

test("revealPercent y remainingText", () => {
  assert.equal(revealPercent(0, 100), 0);
  assert.equal(revealPercent(50, 200), 25);
  assert.equal(revealPercent(99, 100), 99);
  assert.equal(revealPercent(200, 200), 100);
  assert.equal(revealPercent(5, 0), 0);
  assert.equal(revealPercent(-4, 10), 0);

  assert.equal(remainingText(0), "¡Ya puedes jugar!");
  assert.equal(remainingText(-1), "¡Ya puedes jugar!");
  assert.equal(remainingText(90_000), "2 min");
  assert.equal(remainingText(3_600_000), "1 h");
  assert.equal(remainingText(3_900_000), "1 h 05 min");
  assert.equal(remainingText(43_200_000), "12 h");
});

test("el runtime inyectado compila y usa las rutas del contrato", () => {
  const html = renderPage(menu, cfg);
  const main = scriptOf(html, "clubMain");
  assert.doesNotThrow(() => new Function(main));
  assert.ok(main.includes(`"/club/api/" + path`), "el runtime no usa la base /club/api/");
  for (const call of [`api("me")`, `api("login"`, `api("play"`, `api("redeem"`, `api("logout"`]) {
    assert.ok(main.includes(call), `el runtime no llama ${call}`);
  }
  for (const copy of [
    "Guardar en Google Wallet", "Pídele al mesero el PIN para validar tu visita", "Rasca aquí",
    "Sigue participando", "Canjear ahora", "Guardar para después", "Escribir reseña",
    "Estás fuera del rango del local", "Muestra esta pantalla al mesero",
  ]) assert.ok(html.includes(copy), `falta el texto: ${copy}`);
  // sin librerías ni scripts externos
  assert.ok(!/<script[^>]+src=/.test(html));
  assert.ok(!/cdn\.|unpkg|jsdelivr/.test(html));
});

test("el navegador recibe los mismos helpers puros que el servidor", () => {
  const html = renderPage(menu, cfg);
  const b = browserPure(html);
  for (const total of [1, 2, 5, 8]) for (let i = 0; i < total; i++)
    assert.equal(b.wheelStopAngle(i, total, 4), wheelStopAngle(i, total, 4));
  assert.equal(b.revealPercent(30, 120), revealPercent(30, 120));
  assert.equal(b.remainingText(3_900_000), remainingText(3_900_000));
  assert.equal(b.esc(`<x y="1">`), esc(`<x y="1">`));
});

test("copy en español neutro: tuteo, sin voseo", () => {
  const html = renderPage(menu, cfg);
  assert.ok(!/\b(jugá|tenés|podés|querés|mirá|esperá|andá|acá|aboná)\b/i.test(html));
});

/* ─────────────────────────────────────────────────────────────────────────────
   Runtime del navegador sobre un DOM mínimo (sin dependencias): se ejecutan los
   scripts reales que salen en el HTML y se comprueba el flujo login → jugar → canje.
   ───────────────────────────────────────────────────────────────────────────── */
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

const viewInner = html => {
  const m = /<main id="clubView" class="club-view">([\s\S]*?)<\/main>/.exec(html);
  assert.ok(m, "el HTML no trae el contenedor clubView");
  return m[1];
};

// Formulario falso: [name=x] devuelve un input con el valor indicado.
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

function makeDom({ html, program, initialView = "", routes = {}, geo = "ok" }) {
  const calls = [], created = [], timers = [], nodes = new Map(), counts = {};
  const view = new El("main", "clubView");
  view.innerHTML = initialView;
  const out = new El("button", "clubLogout");
  out.hidden = true;
  const toast = new El("div", "clubToast");
  nodes.set("clubView", view);
  nodes.set("clubLogout", out);
  nodes.set("clubToast", toast);
  const reloads = [];
  const location = { href: "", reload() { reloads.push(1); } };
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
    head: { appendChild() {} },
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
  return { view, out, toast, calls, created, location, reloads, settle, form, byId: id => document.getElementById(id) };
}

const page = renderPage(menu, cfg);
const program = programOf(menu, cfg);
const baseMe = {
  customer: { name: "Ana", phone: "593991234567", stamps: 3, visits: 5, cards_completed: 1 },
  program,
  can_play: true,
  next_play_at: null,
  rewards: [{ id: "r1", label: "Café gratis", source: "game", status: "active", created_at: 1, expires_at: null, redeemed_at: null }],
  wallet_url: "/club/api/wallet",
};
const meRoute = me => [{ status: 200, data: me }];

test("runtime: con sesión pinta la tarjeta, premios y botón de Wallet", async () => {
  const dom = makeDom({ html: page, program, initialView: viewInner(page), routes: { me: meRoute(baseMe) } });
  await dom.settle();
  const html = dom.view.innerHTML;
  assert.match(html, /Hola, Ana/);
  assert.match(html, /<b>3<\/b> de 8 sellos/);
  assert.match(html, /Café gratis/);
  assert.ok(html.includes('href="/club/api/wallet"'));
  assert.ok(html.includes("Guardar en Google Wallet"));
  assert.ok(html.includes(">Jugar<"));
  assert.equal(dom.out.hidden, false);
  assert.equal(dom.calls.filter(c => c.url === "/club/api/me").length, 1);
});

test("runtime: escapa datos privados y rechaza URL Wallet distinta del contrato", async () => {
  const me = { ...baseMe,
    customer: { ...baseMe.customer, name: '<img src=x onerror=alert(1)>' },
    rewards: [{ ...baseMe.rewards[0], label: '<svg onload=alert(1)>' }],
    wallet_url: 'javascript:alert(1)',
  };
  const dom = makeDom({ html: page, program, initialView: viewInner(page), routes: { me: meRoute(me) } });
  await dom.settle();
  assert.match(dom.view.innerHTML, /&lt;img/);
  assert.match(dom.view.innerHTML, /&lt;svg/);
  assert.doesNotMatch(dom.view.innerHTML, /<img|<svg|javascript:/);
});

test("runtime: jugar manda geo, gira la ruleta y muestra el premio", async () => {
  const after = {
    ...baseMe,
    customer: { ...baseMe.customer, stamps: 4, visits: 6 },
    rewards: [{ ...baseMe.rewards[0], id: "r2" }],
  };
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: {
      me: meRoute(baseMe),
      play: [{ status: 200, data: { result: { segment_index: 1, won: true, prize: { id: "postre", label: "Postre de la casa" }, reward_id: "r2", card_completed: false, stamps_reward_id: null }, me: after } }],
    },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  const play = dom.calls.find(c => c.url === "/club/api/play");
  assert.deepEqual(play, { url: "/club/api/play", method: "POST", body: { game: "wheel", lat: -0.18, lng: -78.48 } });
  const html = dom.view.innerHTML;
  assert.match(html, /¡Ganaste!/);
  assert.match(html, /Postre de la casa/);
  assert.ok(html.includes('data-act="redeem" data-id="r2"'));
  assert.ok(html.includes("Canjear ahora"));
  assert.ok(html.includes("Guardar para después"));
  assert.ok(html.includes("Escribir reseña")); // ofrecida después, no como condición
});

test("runtime: segmento -1 muestra derrota sin girar hacia un premio", async () => {
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: {
      me: meRoute(baseMe),
      play: [{ status: 200, data: { result: { segment_index: -1, won: false, prize: null, reward_id: null }, me: baseMe } }],
    },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Casi lo logras/);
  assert.doesNotMatch(dom.view.innerHTML, /id="clubWheel"/);
});

test("runtime: cooldown 429 avisa y pinta la cuenta regresiva", async () => {
  const cooled = { ...baseMe, can_play: false, next_play_at: Date.now() + 3_900_000 };
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: {
      me: [ { status: 200, data: baseMe }, { status: 200, data: cooled } ],
      play: [{ status: 429, data: { error: "cooldown", next_play_at: cooled.next_play_at } }],
    },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  assert.match(dom.toast.textContent, /Ya jugaste\. Vuelve en 1 h 0[45] min\./);
  assert.match(dom.view.innerHTML, /Vuelve pronto/);
  assert.match(dom.byId("clubNext").textContent, /^Próxima jugada en 1 h 0[45] min$/);
});

test("runtime: sin ubicación pide el PIN del mesero y reintenta la jugada", async () => {
  const dom = makeDom({
    html: page, program, initialView: viewInner(page), geo: "fail",
    routes: {
      me: meRoute(baseMe),
      play: [{ status: 200, data: { result: { segment_index: 2, won: false, prize: null, reward_id: null, card_completed: false, stamps_reward_id: null }, me: { ...baseMe, customer: { ...baseMe.customer, stamps: 4 } } } }],
    },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Pídele al mesero el PIN para validar tu visita/);
  assert.equal(dom.calls.some(c => c.url === "/club/api/play"), false, "no debe jugar sin validar presencia");

  dom.view.dispatch("submit", { target: form("clubPinForm", { pin: "4821" }) });
  await dom.settle();
  const play = dom.calls.find(c => c.url === "/club/api/play");
  assert.deepEqual(play.body, { game: "wheel", pin: "4821" });
  assert.match(dom.view.innerHTML, /Sigue participando/);
  assert.match(dom.view.innerHTML, /Sello 4 de 8/);
  assert.ok(dom.view.innerHTML.includes("Escribir reseña")); // se ofrece después del resultado
});

test("runtime: sesión vencida a mitad de jugada recarga la página", async () => {
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: { me: meRoute(baseMe), play: [{ status: 401, data: { error: "sin_sesion" } }] },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  assert.equal(dom.reloads.length, 1);
});

test("runtime: fuera de rango explica y ofrece el PIN", async () => {
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: { me: meRoute(baseMe), play: [{ status: 403, data: { error: "fuera_de_rango" } }] },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "start", game: "wheel" } }) } });
  await dom.settle();
  assert.match(dom.view.innerHTML, /Estás fuera del rango del local/);
  assert.match(dom.view.innerHTML, /Pide el PIN al mesero/);
});

test("runtime: canje con PIN incorrecto, bloqueo y canje exitoso", async () => {
  const redeemed = { ...baseMe, rewards: [{ ...baseMe.rewards[0], status: "redeemed", redeemed_at: Date.now() }] };
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: {
      me: meRoute(baseMe),
      redeem: [
        { status: 403, data: { error: "pin_invalido", attempts_left: 4 } },
        { status: 200, data: { reward: { id: "r1" }, me: redeemed } },
      ],
    },
  });
  await dom.settle();
  dom.view.dispatch("click", { target: { closest: () => ({ dataset: { act: "redeem", id: "r1" } }) } });
  const modal = dom.created.find(e => e.className === "modal");
  assert.ok(modal, "no abrió el modal de canje");
  assert.match(modal.innerHTML, /Muestra esta pantalla al mesero/);

  const modalForm = modal.querySelector("#clubRedeemForm");
  modalForm.querySelector("[name=pin]").value = "1111";
  modalForm.dispatch("submit");
  await dom.settle();
  assert.match(dom.byId("clubRedeemErr").textContent, /Te quedan 4 intentos/);

  modalForm.querySelector("[name=pin]").value = "4821";
  modalForm.dispatch("submit");
  await dom.settle();
  assert.match(dom.toast.textContent, /¡Premio canjeado!/);
  assert.match(dom.view.innerHTML, /Usado/);
  assert.equal(dom.created.find(e => e.className === "modal").removed, true);
});

test("runtime: login, error de teléfono y logout", async () => {
  const dom = makeDom({
    html: page, program, initialView: viewInner(page),
    routes: { me: [{ status: 401, data: { error: "sin_sesion", program } }], login: [{ status: 400, data: { error: "telefono_invalido" } }, { status: 200, data: baseMe }] },
  });
  await dom.settle();
  assert.equal(dom.out.hidden, true);
  assert.match(dom.view.innerHTML, /id="clubLogin"/); // login SSR sin tocar

  const f = form("clubLogin", { name: "Ana", phone: "123" });
  dom.view.dispatch("submit", { target: f });
  await dom.settle();
  assert.match(dom.byId("clubErr").textContent, /WhatsApp válido/);

  const ok = form("clubLogin", { name: "Ana", phone: "0991234567" });
  dom.view.dispatch("submit", { target: ok });
  await dom.settle();
  assert.deepEqual(dom.calls.filter(c => c.url === "/club/api/login").pop().body, { name: "Ana", phone: "0991234567" });
  assert.match(dom.view.innerHTML, /Hola, Ana/);

  dom.out.dispatch("click");
  await dom.settle();
  assert.ok(dom.calls.some(c => c.url === "/club/api/logout" && c.method === "POST"));
  assert.equal(dom.location.href, "/club");
});

test("el runtime serializado no depende del helper __name del bundle de wrangler", () => {
  const html = renderPage({ store_name: "X" }, normalizeConfig({ enabled: true }));
  const i = html.indexOf('<script id="clubPure">');
  assert.ok(i > 0 && html.slice(i).startsWith('<script id="clubPure">var __name=function(f){return f};'));
});
