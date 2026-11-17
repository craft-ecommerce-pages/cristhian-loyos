// Caja: insignia y visor del comprobante de transferencia, alerta cuando llega
// uno nuevo y "Listo y avisar" con la pestaña reutilizable de WhatsApp Web.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import {
  renderMeseroPage, normalizeEcPhone, noticeMessage, noticeUrl, isCoarsePointer,
} from "../src/mesero.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };

class Node {
  constructor(tag, text = "") {
    this.tagName = tag;
    this.nodeType = tag === "#text" ? 3 : 1;
    this._text = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.value = "";
    this.hidden = false;
    this.isConnected = true;
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
  append(...nodes) {
    nodes.forEach(node => {
      if (node == null || node === false) return;
      if (!node.nodeType) node = new Node("#text", String(node));
      node.parentNode = this;
      this.children.push(node);
    });
  }
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === "class") this.className = String(value); if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  trigger(name) { (this.listeners.get(name) || []).forEach(listener => listener({ preventDefault() {}, currentTarget: this, target: this })); }
  focus() {}
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
async function flush() {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

const catalog = {
  products: [{ id: "p1", name: "Pizza margarita", price: "9.50", active: true, catalog_visible: true, categories: [] }],
  categories: [],
  variant_groups: [],
};

const order = (extra = {}) => ({
  id: "web-1", number: 31, status: "pending", source: "web", sede_id: "centro",
  created_at: Date.UTC(2026, 10, 17, 15, 0), total_cents: 950, currency: "USD",
  customer_name: "Ana", customer_phone: "0991234567", payment_method: "transfer",
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }],
  ...extra,
});

async function startCaja({ orders = [], fetchImpl = null } = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request("https://pizza.craft-systems.com/panel/mesero"), env, site);
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");

  const root = new Node("main");
  const toast = new Node("div");
  const doc = {
    title: "Caja · Pizza",
    visibilityState: "visible",
    body: new Node("body"),
    createElement: tag => new Node(tag),
    createTextNode: text => new Node("#text", String(text)),
    getElementById: id => id === "mesero" ? root : toast,
    addEventListener() {},
    querySelectorAll: () => [],
  };
  const polls = [], beeps = [], opens = [];
  const audio = {
    state: "running", currentTime: 0, destination: {},
    createOscillator: () => ({ type: "", frequency: {}, connect() {}, start() { beeps.push(1); }, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, connect() {} }),
    resume() { this.state = "running"; },
  };
  const window = {
    __MESERO__: {
      store: "Pizza",
      boot: {
        me: { staff: { id: "dueno", name: "Dueño" }, owner: true, store: { name: "Pizza", currency: "USD" }, sedes: [{ id: "centro", nombre: "Centro" }] },
        catalog,
        orders,
      },
    },
    __meseroTicket: ticketLines,
    __meseroColumns: ticketColumns,
    __meseroHeight: ticketPageHeight,
    __meseroNotify: { phone: normalizeEcPhone, message: noticeMessage, url: noticeUrl, coarse: isCoarsePointer },
    navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", vibrate() {} },
    matchMedia: () => ({ matches: false }),
    open(url, name) { opens.push([url, name]); return { closed: false }; },
    AudioContext: function AudioContext() { return audio; },
    setInterval(fn, ms) { polls.push({ fn, ms }); return polls.length; },
    clearInterval() {},
    setTimeout() { return 0; },
    scrollTo() {},
  };
  const localStorage = { getItem: () => "centro", setItem() {}, removeItem() {} };
  const location = { pathname: "/panel/mesero", search: "" };
  new Function("window", "document", "fetch", "localStorage", "location", "confirm", "setTimeout", "clearTimeout", match[1])(
    window, doc, (fetchImpl || (async () => Response.json({ error: "sin_mock" }, { status: 500 }))),
    localStorage, location, () => true, () => 0, () => {},
  );
  await flush();
  const poll = async () => { assert.ok(polls.length, "el sondeo quedó activo"); await polls[polls.length - 1].fn(); await flush(); };
  return { root, doc, toast, beeps, opens, poll };
}

const posFetch = state => async (url, init = {}) => {
  const path = String(url);
  if (path.includes("/receipt")) return new Response(null, { status: 200, headers: { "content-type": "image/png" } });
  if (path.endsWith("/ready")) {
    const current = state.orders[0];
    state.orders = [{ ...current, status: "ready", ready_at: Date.now() }];
    return Response.json({ order: state.orders[0] });
  }
  if (path.includes("/panel/api/turnos/")) return Response.json({ shift: null });
  return Response.json({ orders: state.orders });
};

test("la tarjeta muestra insignia y Ver comprobante; sin archivo avisa 'Sin comprobante aún'", async () => {
  const state = { orders: [order({ receipt: { count: 1, latest_at: Date.now() } })] };
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push([String(url), init.method || "GET"]); return posFetch(state)(url, init); };
  const { root, doc } = await startCaja({ orders: state.orders, fetchImpl });

  assert.match(root.textContent, /Comprobante recibido/);
  const view = find(root, node => node.tagName === "button" && node.textContent === "Ver comprobante");
  assert.ok(view, "hay botón para ver el comprobante");
  view.trigger("click");
  await flush();
  assert.ok(calls.some(([url, method]) => method === "HEAD" && url.includes("/panel/api/pos/orders/web-1/receipt")));
  const image = find(doc.body, node => node.tagName === "img");
  assert.ok(image, "la imagen se abre en un visor dentro de la caja");
  assert.match(image.getAttribute("src"), /\/panel\/api\/pos\/orders\/web-1\/receipt$/);

  const withoutState = { orders: [order({ id: "web-2", receipt: null })] };
  const without = await startCaja({ orders: withoutState.orders, fetchImpl: posFetch(withoutState) });
  assert.match(without.root.textContent, /Sin comprobante aún/);
  assert.equal(!!find(without.root, node => node.textContent === "Ver comprobante" && node.tagName === "button"), false);
});

test("un comprobante nuevo suena una vez; la primera carga no suena", async () => {
  const state = { orders: [order({ receipt: { count: 1, latest_at: 1 } })] };
  const { beeps, poll } = await startCaja({ orders: state.orders, fetchImpl: posFetch(state) });
  assert.equal(beeps.length, 0, "la primera carga no suena");

  await poll();
  assert.equal(beeps.length, 0, "sin cambios no vuelve a sonar");

  state.orders = [order({ receipt: { count: 2, latest_at: 2 } })];
  await poll();
  assert.equal(beeps.length, 1, "el comprobante nuevo pita una vez");

  await poll();
  assert.equal(beeps.length, 1, "el mismo comprobante no repite el aviso");
});

test("Listo y avisar: marca listo y abre WhatsApp Web en la pestaña reutilizable", async () => {
  const state = { orders: [order({ status: "paid", payment_method: "cash", receipt: null })] };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([String(url), init.method || "GET", init.body ? JSON.parse(init.body) : null]);
    return posFetch(state)(url, init);
  };
  const { root, opens, toast } = await startCaja({ orders: state.orders, fetchImpl });

  const ready = find(root, node => node.tagName === "button" && node.textContent === "Listo y avisar");
  assert.ok(ready);
  ready.trigger("click");
  await flush();

  assert.ok(calls.some(([url]) => url.endsWith("/panel/api/orders/web-1/ready")));
  assert.equal(opens.length, 1);
  assert.equal(opens[0][1], "munch-whatsapp", "reutiliza siempre la misma pestaña");
  assert.match(opens[0][0], /^https:\/\/web\.whatsapp\.com\/send\?phone=593991234567&text=/);
  const message = decodeURIComponent(opens[0][0].split("&text=")[1]);
  assert.equal(message, "Hola Ana, tu pedido #31 está listo. Retíralo en Centro. ¡Gracias por tu compra en Munch!");
  assert.doesNotMatch(message, /RUC|cédula|correo|dirección/i);
  assert.match(toast.textContent || "", /Aviso de WhatsApp abierto/);
  // El filtro "En curso" ya no lo muestra: en "Todos"/"Listos" queda la marca.
  find(root, node => node.tagName === "button" && node.textContent === "Todos").trigger("click");
  await flush();
  assert.match(root.textContent, /Avisado ✓/);
});

test("Listo y avisar sin teléfono: solo marca listo y pide llamar al cliente", async () => {
  const state = { orders: [order({ status: "paid", payment_method: "cash", customer_phone: "", receipt: null })] };
  const { root, opens, toast } = await startCaja({ orders: state.orders, fetchImpl: posFetch(state) });
  const ready = find(root, node => node.tagName === "button" && node.textContent === "Listo y avisar");
  assert.ok(ready);
  ready.trigger("click");
  await flush();
  assert.equal(opens.length, 0);
  assert.match(toast.textContent, /Sin WhatsApp: llama al cliente por su número/);
  find(root, node => node.tagName === "button" && node.textContent === "Todos").trigger("click");
  await flush();
  assert.match(root.textContent, /Listo para retirar/);
});

test("el constructor de la caja rotula el teléfono como WhatsApp para avisar (opcional)", async () => {
  const { root, doc } = await startCaja({ orders: [] });
  find(root, node => node.tagName === "button" && node.textContent === "Nueva venta").trigger("click");
  await flush();
  find(root, node => node.tagName === "button" && node.textContent.includes("Pizza margarita")).trigger("click");
  find(root, node => node.tagName === "button" && node.textContent === "Cobrar").trigger("click");
  await flush();
  const phone = find(doc.body, node => node.tagName === "input" && node.getAttribute("aria-label") === "WhatsApp para avisar (opcional)");
  assert.ok(phone, "el campo opcional queda disponible para el aviso");
});
