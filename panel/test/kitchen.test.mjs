// KDS /panel/cocina: sede real, solo pagadas, polling con cursor y acuse antes de imprimir.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { renderKitchenPage } from "../src/kitchen.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };
const order = {
  id: "orden-1", number: 23, status: "paid", sede_id: "centro", total_cents: 1250, currency: "USD",
  created_at: Date.now() - 120000, comanda_at: Date.now() - 60000, print_count: 0,
  customer_name: "Ana", delivery_mode: "mesa", table_no: "4",
  items: [
    { name: "Pizza margarita", qty: 2, unit_cents: 500, variant_id: "Grande" },
    { name: "Jugo natural", qty: 1, unit_cents: 250, note: "Sin azúcar" },
  ],
};

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
    this.disabled = false;
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
  trigger(name, event = {}) { (this.listeners.get(name) || []).forEach(listener => listener(Object.assign({ preventDefault() {}, currentTarget: this, target: this }, event))); }
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const findAll = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
};

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function startKitchen(input = [order]) {
  // Copia por prueba: el acuse incrementa print_count y no debe contaminar otros tests.
  const orders = input.map(item => ({
    ...item,
    items: Array.isArray(item.items) ? item.items.map(row => ({ ...row })) : item.items,
  }));
  const calls = [], printed = [], intervals = [], events = [];
  let confirmAnswer = false, printThrows = false;
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) { const node = new Node(id === "kdsTicket" ? "pre" : "div"); node.id = id; elements.set(id, node); }
    return elements.get(id);
  };
  const root = element("kds");
  const document = {
    visibilityState: "visible",
    body: new Node("body"),
    createElement: tag => new Node(tag),
    createTextNode: text => new Node("#text", String(text)),
    getElementById: id => element(id),
    addEventListener() {},
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    calls.push({ path, search: parsed.searchParams, method, body: init.body ? JSON.parse(init.body) : null });
    if (path === "/panel/api/mesero/me") return Response.json({ staff: { id: "dueno", name: "Dueño" }, owner: true, sedes: [{ id: "centro", nombre: "Centro" }] });
    if (parsed.pathname === "/panel/api/kitchen/orders") {
      const list = orders.filter(o => o.comanda_at > Number(parsed.searchParams.get("since") || 0));
      return Response.json({ orders: list, next: list.length ? list[list.length - 1].comanda_at : Number(parsed.searchParams.get("since") || 0) });
    }
    if (/^\/panel\/api\/kitchen\/orders\/[^/]+\/print$/.test(parsed.pathname) && method === "POST") {
      events.push("ack");
      const target = orders.find(o => o.id === parsed.pathname.split("/")[5]);
      target.print_count = (target.print_count || 0) + 1;
      return Response.json({ order_id: target.id, print_count: target.print_count, printed_at: Date.now() });
    }
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __kdsStore: "Pizza", __kdsTicket: ticketLines, __kdsColumns: ticketColumns, __kdsHeight: ticketPageHeight,
    location: { search: "" },
    print: () => {
      events.push("print");
      if (printThrows) throw new Error("impresión bloqueada");
      printed.push(true);
    },
    confirm: () => confirmAnswer,
    setTimeout() { return 0; },
    clearTimeout() {},
  };
  const localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  new Function("window", "document", "fetch", "localStorage", "confirm", "setInterval", "clearInterval", "URLSearchParams", runtimeSource())(
    window, document, fetch, localStorage, () => confirmAnswer,
    (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, () => {}, URLSearchParams);
  return { document, root, calls, printed, intervals, events, setConfirm: v => { confirmAnswer = v; }, setPrintThrows: v => { printThrows = v; }, window };
}

function runtimeSource() {
  const html = cachedHtml();
  const match = /<script id="kdsMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime de cocina serializado");
  return match[1];
}
let htmlCache = null;
let htmlPromise = null;
function cachedHtml() {
  if (!htmlCache) throw new Error("el HTML se prepara con prepareHtml()");
  return htmlCache;
}
async function prepareHtml() {
  htmlCache = await renderKitchenPage(new Request("https://pizza.craft-systems.com/panel/cocina"), makeEnv({ "pizza:config": { store_name: "<b>Pizzería</b>" } }), site);
  return htmlCache;
}

test("la página de cocina escapa el nombre, pide sede y documenta el acuse", async () => {
  const html = await prepareHtml();
  assert.equal(html.includes("<b>Pizzería</b>"), false);
  assert.match(html, /&lt;b&gt;Pizzería&lt;\/b&gt;/);
  for (const marker of ["kdsSede", "kdsRefresh", "15000", "Reimprimir", "window.print", "@media print", "Acuse", "La cocina solo recibe órdenes pagadas"]) {
    assert.ok(html.includes(marker), marker);
  }
  assert.equal(html.includes("innerHTML"), false);
});

test("carga sedes reales y muestra la comanda pagada con sus ítems", async () => {
  await prepareHtml();
  const ctx = startKitchen();
  await flush();
  assert.ok(ctx.calls.some(call => call.path === "/panel/api/mesero/me"));
  const kitchen = ctx.calls.find(call => call.path.startsWith("/panel/api/kitchen/orders?"));
  assert.ok(kitchen, "consulta la cola de cocina");
  assert.equal(kitchen.search.get("sede_id"), "centro");
  assert.ok(Number(kitchen.search.get("since")) > 0);
  assert.match(ctx.root.textContent, /#23/);
  assert.match(ctx.root.textContent, /2×/);
  assert.match(ctx.root.textContent, /Pizza margarita/);
  assert.match(ctx.root.textContent, /Grande/);
  assert.match(ctx.root.textContent, /Sin azúcar/);
  assert.match(ctx.root.textContent, /Imprimir comanda/);
  assert.match(ctx.root.textContent, /Sin acuse/);
});

test("imprimir abre el diálogo y solo después registra el acuse; no afirma el papel", async () => {
  await prepareHtml();
  const ctx = startKitchen();
  await flush();
  const print = find(ctx.root, node => node.tagName === "button" && node.textContent === "Imprimir comanda");
  assert.ok(print);
  print.trigger("click");
  await flush();
  assert.deepEqual(ctx.events, ["print", "ack"], "primero el diálogo, luego el acuse");
  const ack = ctx.calls.find(call => call.path === "/panel/api/kitchen/orders/orden-1/print");
  assert.ok(ack);
  assert.match(ack.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(ctx.printed.length, 1);
  assert.match(ctx.root.textContent, /Acuse ×1/);
  assert.match(ctx.root.textContent, /Reimprimir/);
  const toast = ctx.document.getElementById("kdsToast");
  assert.match(toast.textContent, /Acuse registrado \(1\)/);
  assert.match(toast.textContent, /Revisa el papel en la impresora/);
  assert.doesNotMatch(toast.textContent, /impreso correctamente|impresión exitosa|papel impreso/);
});

test("si el navegador no abre la impresión no se registra un falso acuse", async () => {
  await prepareHtml();
  const ctx = startKitchen();
  await flush();
  ctx.setPrintThrows(true);
  const print = find(ctx.root, node => node.tagName === "button" && node.textContent === "Imprimir comanda");
  print.trigger("click");
  await flush();
  assert.deepEqual(ctx.events, ["print"], "el acuse no se intenta");
  assert.equal(ctx.calls.some(call => call.path.includes("/print")), false);
  const toast = ctx.document.getElementById("kdsToast");
  assert.match(toast.textContent, /No pudimos abrir la impresión\. No se registró acuse\./);
  assert.match(ctx.root.textContent, /Sin acuse/);
});

test("reimprimir exige confirmación explícita y no repite el acuse si se cancela", async () => {
  await prepareHtml();
  const repeated = { ...order, id: "orden-2", number: 24, comanda_at: order.comanda_at + 1, print_count: 2 };
  const ctx = startKitchen([repeated]);
  await flush();
  const reprint = find(ctx.root, node => node.tagName === "button" && node.textContent === "Reimprimir");
  assert.ok(reprint);
  assert.match(ctx.root.textContent, /Acuse ×2/);
  reprint.trigger("click");
  await flush();
  assert.equal(ctx.calls.some(call => call.path.includes("/print")), false, "cancelar no registra otro acuse");
  ctx.setConfirm(true);
  reprint.trigger("click");
  await flush();
  assert.ok(ctx.calls.some(call => call.path === "/panel/api/kitchen/orders/orden-2/print"));
  assert.match(ctx.root.textContent, /Acuse ×3/);
});

test("el polling usa el cursor next y conserva las órdenes ya vistas", async () => {
  await prepareHtml();
  const ctx = startKitchen();
  await flush();
  assert.equal(ctx.intervals.length, 1);
  assert.equal(ctx.intervals[0].ms, 15000);
  ctx.intervals[0].fn();
  await flush();
  const polls = ctx.calls.filter(call => call.path.startsWith("/panel/api/kitchen/orders?"));
  assert.equal(polls.length, 2);
  assert.equal(polls[1].search.get("since"), String(order.comanda_at), "continúa desde el último comanda_at");
  assert.match(ctx.root.textContent, /Pizza margarita/);
});
