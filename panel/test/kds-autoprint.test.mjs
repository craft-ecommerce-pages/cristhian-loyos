// KDS con impresión automática: interruptor por sede, cola con print_count==0,
// acuse solo después de imprimir, aviso visible al fallar y sonido de aviso.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { autoPrintCandidates, renderKitchenPage } from "../src/kitchen.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };
const base = Date.now() - 120000;

function order(id, number, overrides = {}) {
  return {
    id, number, status: "paid", sede_id: "centro", total_cents: 1250, currency: "USD",
    created_at: base, comanda_at: base + number, print_count: 0,
    customer_name: "Ana",
    items: [{ name: "Pizza margarita", qty: 1, unit_cents: 1250 }],
    ...overrides,
  };
}

class Node {
  constructor(tag, text = "") {
    this.tagName = tag;
    this.nodeType = tag === "#text" ? 3 : 1;
    this._text = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.isConnected = true;
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.contentWindow = null;
    this.classList = {
      add: (...names) => this.updateClasses(names, true),
      remove: (...names) => this.updateClasses(names, false),
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on) => this.updateClasses([name], on),
    };
  }
  updateClasses(names, add) {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    names.forEach(name => add ? classes.add(name) : classes.delete(name));
    this.className = [...classes].join(" ");
  }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...nodes) { nodes.forEach(node => { if (node == null || node === false) return; if (!node.nodeType) node = new Node("#text", String(node)); node.parentNode = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "class") this.className = String(value); if (name === "disabled") this.disabled = true; }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  trigger(name, event = {}) {
    const detail = Object.assign({ preventDefault() {}, currentTarget: this, target: this }, event);
    (this.listeners.get(name) || []).forEach(listener => listener(detail));
  }
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}

async function flush() {
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

function runtimeSource(html) {
  const match = /<script id="kdsMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime de cocina serializado");
  return match[1];
}

function startKds(html, {
  orders: input = [order("orden-1", 23)],
  storage = {},
  printThrows = false,
  visibility = "visible",
} = {}) {
  const orders = input.map(item => ({ ...item, items: item.items.map(row => ({ ...row })) }));
  const calls = [], events = [], intervals = [], printed = [];
  const audio = { contexts: 0, resumes: 0, starts: 0, stops: 0 };
  const vibrate = [];
  const wakeLocks = [];
  let throwPrint = printThrows;
  const store = new Map(Object.entries(storage));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const tag = id === "kdsTicket" ? "pre" : id === "kdsAuto" ? "input" : "div";
      const node = new Node(tag);
      node.id = id;
      elements.set(id, node);
    }
    return elements.get(id);
  };
  const root = element("kds");
  const document = {
    visibilityState: visibility,
    body: new Node("body"),
    createElement: tag => new Node(tag),
    createTextNode: text => new Node("#text", String(text)),
    getElementById: id => element(id),
    addEventListener() {},
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const method = init.method || "GET";
    calls.push({ path: parsed.pathname + parsed.search, search: parsed.searchParams, method, body: init.body ? JSON.parse(init.body) : null });
    if (parsed.pathname === "/panel/api/mesero/me") {
      return Response.json({ staff: { id: "dueno", name: "Dueño" }, owner: true, sedes: [{ id: "centro", nombre: "Centro" }] });
    }
    if (parsed.pathname === "/panel/api/kitchen/orders") {
      const since = Number(parsed.searchParams.get("since") || 0);
      const list = orders.filter(item => Number(item.comanda_at) > since);
      return Response.json({ orders: list, next: list.length ? Number(list[list.length - 1].comanda_at) : since });
    }
    if (/^\/panel\/api\/kitchen\/orders\/[^/]+\/print$/.test(parsed.pathname) && method === "POST") {
      events.push("ack");
      const target = orders.find(item => item.id === parsed.pathname.split("/")[5]);
      target.print_count = (Number(target.print_count) || 0) + 1;
      return Response.json({ order_id: target.id, print_count: target.print_count, printed_at: Date.now() });
    }
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const localStorage = {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); },
  };
  class AudioContext {
    constructor() {
      audio.contexts++;
      this.state = "suspended";
      this.currentTime = 0;
      this.destination = {};
    }
    resume() { audio.resumes++; this.state = "running"; return Promise.resolve(); }
    createOscillator() {
      return { type: "", frequency: { value: 0 }, connect() {}, start() { audio.starts++; }, stop() { audio.stops++; } };
    }
    createGain() { return { gain: { value: 0 }, connect() {} }; }
  }
  const window = {
    __kdsStore: "Pizza", __kdsTicket: ticketLines, __kdsColumns: ticketColumns, __kdsHeight: ticketPageHeight,
    __kdsQueue: autoPrintCandidates,
    AudioContext,
    location: { search: "" },
    print: () => {
      events.push("print");
      if (throwPrint) throw new Error("impresión bloqueada");
      printed.push(true);
    },
    confirm: () => true,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const navigator = {
    vibrate: ms => { vibrate.push(ms); return true; },
    wakeLock: { request: async type => { wakeLocks.push(type); return { addEventListener() {} }; } },
  };
  new Function("window", "document", "fetch", "localStorage", "navigator", "setInterval", "clearInterval", "setTimeout", "clearTimeout", "URLSearchParams", runtimeSource(html))(
    window, document, fetch, localStorage, navigator,
    (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    () => {}, () => 0, () => {}, URLSearchParams);
  return {
    root, document, calls, printed, events, intervals, audio, vibrate, wakeLocks,
    storage: store,
    order: id => orders.find(item => item.id === id),
    addOrder: item => { orders.push(item); return item; },
    setPrintThrows: value => { throwPrint = value; },
    auto: () => element("kdsAuto"),
    sound: () => element("kdsSound"),
  };
}

async function prepareHtml() {
  const html = await renderKitchenPage(
    new Request("https://pizza.craft-systems.com/panel/cocina?sede=centro"),
    makeEnv({ "pizza:config": { store_name: "Pizzería" } }),
    site);
  return html;
}

test("la cabecera trae el interruptor por sede, el sonido y la ayuda de kiosco", async () => {
  const html = await prepareHtml();
  for (const marker of [
    "Impresión automática", "kdsAuto", "Activar sonido", "kdsSound",
    "kds_autoprint:", "120000", "kdsQueue",
    "Usa una sola estación con impresión automática por sede. En Chrome abre con --kiosk-printing para imprimir sin diálogo.",
  ]) assert.ok(html.includes(marker), marker);
  assert.ok(html.includes("// ponytail:"), "la nota de doble impresión queda en el código");
  assert.ok(html.includes('kds_autoprint:" + text(id)'));
  assert.equal(html.includes("innerHTML"), false);
});

test("autoPrintCandidates: solo print_count 0, sin intentos previos y de la más antigua a la más nueva", () => {
  const list = [
    order("nueva", 30, { comanda_at: base + 300 }),
    order("vieja", 10, { comanda_at: base + 100 }),
    order("impresa", 20, { comanda_at: base + 200, print_count: 1 }),
    order("fallida", 15, { comanda_at: base + 150 }),
  ];
  const queue = autoPrintCandidates(list, new Set(["fallida"]));
  assert.deepEqual(queue.map(item => item.id), ["vieja", "nueva"]);
  assert.deepEqual(list.map(item => item.id), ["nueva", "vieja", "impresa", "fallida"], "no muta la entrada");
  assert.deepEqual(autoPrintCandidates(null, null), []);
  assert.deepEqual(autoPrintCandidates(list, ["fallida"]).map(item => item.id), ["vieja", "nueva"]);
});

test("con impresión automática imprime sola la comanda sin acuse, acusa después y no repite ids", async () => {
  const html = await prepareHtml();
  const ctx = startKds(html, {
    orders: [order("orden-1", 23), order("orden-2", 24, { comanda_at: base + 240, print_count: 1 })],
    storage: { "kds_autoprint:centro": "1" },
  });
  await flush();
  assert.equal(ctx.auto().checked, true, "el interruptor refleja la preferencia guardada");
  assert.deepEqual(ctx.events, ["print", "ack"], "primero imprime y luego acusa");
  assert.equal(ctx.calls.filter(call => call.path.endsWith("/print")).length, 1);
  assert.match(ctx.calls.find(call => call.path.endsWith("/print")).path, /orden-1\/print$/);
  assert.equal(ctx.order("orden-1").print_count, 1);
  assert.equal(ctx.order("orden-2").print_count, 1, "la ya impresa no se toca");
  assert.equal(ctx.intervals.length, 1);
  assert.equal(ctx.intervals[0].ms, 120000, "el respaldo consulta cada 2 min");
  assert.deepEqual(ctx.wakeLocks, ["screen"], "pide wake lock de pantalla");

  // Aunque el servidor siga mostrando print_count 0, esta pestaña ya lo intentó.
  const target = ctx.order("orden-1");
  target.print_count = 0;
  target.comanda_at = base + 400;
  ctx.intervals[0].fn();
  await flush();
  assert.equal(ctx.calls.filter(call => call.path.endsWith("/print")).length, 1, "no repite el acuse");
  assert.equal(ctx.events.filter(event => event === "print").length, 1, "no reimprime la misma orden");

  // Sigue consultando con la pestaña oculta.
  ctx.document.visibilityState = "hidden";
  const before = ctx.calls.filter(call => call.path.startsWith("/panel/api/kitchen/orders?")).length;
  ctx.intervals[0].fn();
  await flush();
  const after = ctx.calls.filter(call => call.path.startsWith("/panel/api/kitchen/orders?")).length;
  assert.equal(after, before + 1);
});

test("si la impresión automática falla no registra acuse, deja aviso y no reintenta sola", async () => {
  const html = await prepareHtml();
  const ctx = startKds(html, { printThrows: true, storage: { "kds_autoprint:centro": "1" } });
  await flush();
  assert.deepEqual(ctx.events, ["print"], "no se intenta el acuse");
  assert.equal(ctx.calls.some(call => call.path.endsWith("/print")), false);
  assert.match(ctx.root.textContent, /Falló la impresión automática\. Usa el botón para reintentar\./);
  assert.match(ctx.document.getElementById("kdsToast").textContent, /No pudimos abrir la impresión\. No se registró acuse\./);

  // Un nuevo load no la reintenta: queda pendiente del botón manual.
  const target = ctx.order("orden-1");
  target.comanda_at = base + 500;
  ctx.intervals[0].fn();
  await flush();
  assert.equal(ctx.events.filter(event => event === "print").length, 1);

  // El botón manual sí funciona y limpia el aviso.
  ctx.setPrintThrows(false);
  const manual = find(ctx.root, node => node.tagName === "button" && node.textContent === "Imprimir comanda");
  assert.ok(manual);
  manual.trigger("click");
  await flush();
  assert.deepEqual(ctx.events.slice(-2), ["print", "ack"]);
  assert.doesNotMatch(ctx.root.textContent, /Falló la impresión automática/);
  assert.match(ctx.root.textContent, /Acuse ×1/);
});

test("el interruptor guarda la preferencia por sede y desbloquea el AudioContext", async () => {
  const html = await prepareHtml();
  const ctx = startKds(html);
  await flush();
  assert.equal(ctx.auto().checked, false, "por defecto apagado");
  assert.equal(ctx.storage.has("kds_autoprint:centro"), false);

  ctx.auto().checked = true;
  ctx.auto().trigger("change");
  await flush();
  assert.equal(ctx.storage.get("kds_autoprint:centro"), "1");
  assert.ok(ctx.audio.contexts >= 1, "crea el AudioContext en el gesto del usuario");
  assert.equal(ctx.audio.resumes, 1);
  assert.equal(ctx.intervals.at(-1).ms, 120000, "el ritmo de respaldo no cambia al encender");

  ctx.auto().checked = false;
  ctx.auto().trigger("change");
  await flush();
  assert.equal(ctx.storage.has("kds_autoprint:centro"), false, "apagar borra la clave");
  assert.equal(ctx.intervals.at(-1).ms, 120000);

  ctx.sound().trigger("click");
  await flush();
  assert.equal(ctx.audio.contexts, 1, "reutiliza el AudioContext ya creado");
  assert.match(ctx.document.getElementById("kdsToast").textContent, /Sonido de aviso activado/);
});

test("suena una sola vez por comanda nueva y nunca en la primera carga", async () => {
  const html = await prepareHtml();
  const ctx = startKds(html, { orders: [order("orden-1", 23, { print_count: 1 })] });
  await flush();
  assert.equal(ctx.audio.starts, 0, "sin pitido en la primera carga");
  assert.deepEqual(ctx.vibrate, []);

  ctx.addOrder(order("orden-2", 24, { comanda_at: base + 900, print_count: 1 }));
  ctx.intervals[0].fn();
  await flush();
  assert.equal(ctx.audio.starts, 1, "pita al detectar un id nuevo");
  assert.deepEqual(ctx.vibrate, [140]);

  ctx.intervals[0].fn();
  await flush();
  assert.equal(ctx.audio.starts, 1, "no repite el pitido para la misma orden");
});

test("apagada usa el respaldo de 2 min y se pausa con la pestaña oculta", async () => {
  const html = await prepareHtml();
  const ctx = startKds(html, { visibility: "hidden" });
  await flush();
  assert.equal(ctx.intervals[0].ms, 120000);
  const polls = () => ctx.calls.filter(call => call.path.startsWith("/panel/api/kitchen/orders?")).length;
  const before = polls();
  ctx.intervals[0].fn();
  await flush();
  assert.equal(polls(), before, "oculta no consulta con impresión automática apagada");
  ctx.document.visibilityState = "visible";
  ctx.intervals[0].fn();
  await flush();
  assert.equal(polls(), before + 1);
});
