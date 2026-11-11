// UI: nueva orden de caja con tarjetas, sede obligatoria, carrito y cobro.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/page.js";

class Node {
  constructor(doc, tag, text = "") {
    this.doc = doc;
    this.tagName = tag;
    this.nodeType = tag === "#text" ? 3 : 1;
    this._text = text;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
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
  append(...nodes) { nodes.forEach(node => { if (node == null || node === false) return; if (!node.nodeType) node = this.doc.createTextNode(String(node)); node.parentNode = this; this.children.push(node); }); }
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name === "disabled") this.disabled = true;
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  trigger(name) {
    (this.listeners.get(name) || []).forEach(listener => listener({ preventDefault() {}, currentTarget: this, target: this }));
  }
  querySelector(selector) { return find(this, node => matches(node, selector)); }
  scrollIntoView() {}
}

class Document {
  constructor() {
    this.body = new Node(this, "body");
    this.app = this.createElement("div");
    this.app.id = "app";
    this.toast = this.createElement("div");
    this.toast.id = "toast";
    this.body.append(this.app, this.toast);
  }
  createElement(tag) { return new Node(this, tag); }
  createTextNode(text) { return new Node(this, "#text", String(text)); }
  getElementById(id) { return find(this.body, node => node.id === id); }
  addEventListener() {}
}

function matches(node, selector) {
  if (node.nodeType !== 1) return false;
  return selector.startsWith(".") ? node.classList.contains(selector.slice(1)) : node.tagName === selector;
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}
const findAll = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
};

function runtimeSource() {
  const html = renderPage({ slug: "pizza", host: "pizza.craft-systems.com" });
  const match = /<script id="panelMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  return match[1];
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

const PRODUCTS = [
  { id: "p1", name: "Pizza margarita", price: "9.50", promo_price: "", active: true, catalog_visible: true,
    categories: ["pizzas"], images: ["https://cdn.example.com/pizza.jpg"] },
  { id: "p2", name: "Jugo natural", precio: "2.25", active: true, catalog_visible: true,
    categories: ["bebidas"] },
];

const DEFAULT_POS_ORDERS = [
  { id: "o1", number: 40, status: "pending", source: "web", sede_id: "centro", total_cents: 950, currency: "USD",
    created_at: 0, customer_name: "Ana", items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
  { id: "o2", number: 41, status: "confirmed", source: "caja", sede_id: "centro", total_cents: 225, currency: "USD",
    created_at: 0, customer_name: "Luis", items: [{ name: "Jugo natural", qty: 1, unit_cents: 225 }] },
];

function startPanel({ posOrders = DEFAULT_POS_ORDERS, transferMissing = false } = {}) {
  const doc = new Document(), calls = [], events = [];
  let confirmAnswer = true, printThrows = false;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    if (path === "/panel/api/me") return Response.json({ email: "dueno@pizza.ec", store: { store_name: "Pizza", currency: "USD" }, features: { loyalty: false } });
    if (path === "/panel/api/catalog") return Response.json({ version: 1, categories: [{ slug: "pizzas", name: "Pizzas" }], products: PRODUCTS, variant_groups: [] });
    if (path === "/panel/api/sedes") return Response.json({ sedes: [{ id: "centro", nombre: "Centro", activa: true }] });
    if (parsed.pathname === "/panel/api/pos/orders") {
      const status = parsed.searchParams.get("status");
      const list = status === "open"
        ? posOrders.filter(order => order.status === "pending" || order.status === "confirmed")
        : status && status !== "all"
          ? posOrders.filter(order => order.status === status)
          : posOrders;
      return Response.json({ orders: list });
    }
    if (path === "/panel/api/mesero/orders" && method === "POST") return Response.json({ id: "nuevo", number: 42, status: "pending", total_cents: 950 }, { status: 201 });
    if (/^\/panel\/api\/kitchen\/orders\/[^/]+\/print$/.test(parsed.pathname) && method === "POST") {
      events.push("ack");
      return Response.json({ order_id: parsed.pathname.split("/")[5], print_count: 1, printed_at: Date.now() });
    }
    if (/^\/panel\/api\/orders\/[^/]+\/(confirm|reject|pay-cash|pay-transfer|ready|payphone)$/.test(parsed.pathname) && method === "POST") {
      const action = parsed.pathname.split("/").pop();
      if (transferMissing && action === "pay-transfer") return Response.json({ error: "ruta_no_encontrada" }, { status: 404 });
      const status = action === "confirm" ? "confirmed" : action === "ready" ? "ready" : action === "reject" ? "rejected" : "paid";
      return Response.json({ order: { id: parsed.pathname.split("/")[4], status } });
    }
    if (path.startsWith("/panel/api/orders")) return Response.json({ orders: [], total: 0, pending: 0 });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "pizza", host: "pizza.craft-systems.com" },
    scrollTo() {},
    confirm: () => confirmAnswer,
    open() {},
    setTimeout: () => 0,
    print: () => { events.push("print"); if (printThrows) throw new Error("impresión bloqueada"); },
  };
  const location = { pathname: "/panel", host: "pizza.craft-systems.com", origin: "https://pizza.craft-systems.com", search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => confirmAnswer, () => 0, () => {},
  );
  return {
    doc, calls, events,
    setConfirm: value => { confirmAnswer = value; },
    setPrintThrows: value => { printThrows = value; },
  };
}

async function openNewOrder(options) {
  const context = startPanel(options);
  await flush();
  const nav = find(context.doc.body, node => node.tagName === "button" && node.textContent === "Nueva orden");
  assert.ok(nav, "existe la entrada Nueva orden en Ventas");
  nav.trigger("click");
  await flush();
  return context;
}

async function showFilter(doc, label) {
  const tab = find(doc.body, node => node.tagName === "button" && node.classList.contains("subtab") && node.textContent === label);
  assert.ok(tab, "existe el filtro " + label);
  tab.trigger("click");
  await flush();
}

test("Nueva orden pinta tarjetas con imagen, fallback y etiquetas accesibles", async () => {
  const { doc } = await openNewOrder();
  const cards = findAll(doc.body, node => node.tagName === "button" && node.classList.contains("pick-card"));
  assert.equal(cards.length, 2);
  const pizza = cards.find(card => card.textContent.includes("Pizza margarita"));
  const juice = cards.find(card => card.textContent.includes("Jugo natural"));
  assert.ok(pizza, "producto con foto");
  assert.ok(juice, "producto sin foto");
  assert.match(pizza.getAttribute("aria-label"), /Pizza margarita, \$9\.50/);
  const img = find(pizza, node => node.tagName === "img");
  assert.ok(img, "la tarjeta con foto muestra imagen");
  assert.equal(img.getAttribute("alt"), "", "la foto es decorativa");
  assert.ok(find(pizza, node => node.classList.contains("pick-media")));
  assert.ok(find(juice, node => node.classList.contains("pick-fallback")), "sin foto usa el marcador");
  assert.equal(find(juice, node => node.tagName === "img"), null);
  assert.match(doc.body.textContent, /\$9\.50/);
  assert.match(doc.body.textContent, /Elige una sede|Centro/, "la sede se elige de la lista real");
});

test("el carrito crea una orden pendiente con product_id, sede y clave de idempotencia", async () => {
  const { doc, calls } = await openNewOrder();
  const pizza = findAll(doc.body, node => node.tagName === "button" && node.classList.contains("pick-card"))
    .find(card => card.textContent.includes("Pizza margarita"));
  pizza.trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Pizza margarita/);
  assert.match(doc.body.textContent, /Crear orden pendiente/);
  const create = find(doc.body, node => node.tagName === "button" && node.textContent === "Crear orden pendiente");
  assert.ok(create);
  create.trigger("click");
  await flush();
  const posted = calls.find(call => call.path === "/panel/api/mesero/orders" && call.method === "POST");
  assert.ok(posted, "la orden se crea por la ruta POS de caja");
  assert.equal(posted.body.sede_id, "centro");
  assert.equal(posted.body.delivery_mode, "pickup");
  assert.match(posted.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.deepEqual(posted.body.items, [{ product_id: "p1", qty: 1 }]);
  assert.match(doc.body.textContent, /Orden #42 creada como pendiente/);
  assert.match(doc.body.textContent, /Confírmala y cóbrala antes de la comanda/);
});

test("la lista separa confirmar de cobrar y no imprime en estados sin pago", async () => {
  const { doc, calls } = await openNewOrder();
  assert.match(doc.body.textContent, /Confirmado · falta cobro/);
  assert.match(doc.body.textContent, /Pendiente/);
  assert.match(doc.body.textContent, /Cobrar efectivo/);
  assert.equal(doc.body.textContent.includes("Payphone (simulación)"), false);
  assert.equal(doc.body.textContent.includes("Imprimir comanda"), false, "la caja no imprime antes de pagar");

  const confirm = find(doc.body, node => node.tagName === "button" && node.textContent === "Confirmar");
  assert.ok(confirm, "hay confirmación pendiente");
  confirm.trigger("click");
  await flush();
  const confirmed = calls.find(call => call.path === "/panel/api/orders/o1/confirm" && call.method === "POST");
  assert.ok(confirmed, "confirmar usa la ruta POS");
  assert.match(doc.body.textContent, /Confirmada\. Aún falta cobrar: la comanda no salió a cocina\./);
});

test("cobrar en efectivo envía idempotency_key y avisa que la comanda ya está en cocina", async () => {
  const { doc, calls } = await openNewOrder();
  const cash = find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar efectivo");
  assert.ok(cash);
  cash.trigger("click");
  await flush();
  const paid = calls.find(call => call.path === "/panel/api/orders/o2/pay-cash" && call.method === "POST");
  assert.ok(paid, "el cobro usa la ruta POS");
  assert.match(paid.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.match(doc.body.textContent, /Cobrado\. La comanda ya está en cocina/);
});

test("caja confirma transferencia por pay-transfer y efectivo por pay-cash", async () => {
  const { doc, calls } = await openNewOrder({
    posOrders: [
      { id: "o3", number: 43, status: "confirmed", source: "web", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Ana", payment_method: "transfer",
        items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
    ],
  });
  const transfer = find(doc.body, node => node.tagName === "button" && node.textContent === "Confirmar transferencia");
  assert.ok(transfer, "la transferencia tiene su propia confirmación manual");
  transfer.trigger("click");
  await flush();
  const call = calls.find(item => item.path === "/panel/api/orders/o3/pay-transfer" && item.method === "POST");
  assert.ok(call, "usa la ruta de transferencia");
  assert.match(call.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(calls.some(item => item.path === "/panel/api/orders/o3/pay-cash"), false);
  assert.match(doc.body.textContent, /Transferencia confirmada\./);
});

test("sin pay-transfer la caja muestra error honesto y no cae a pay-cash", async () => {
  const { doc, calls } = await openNewOrder({
    transferMissing: true,
    posOrders: [
      { id: "o3b", number: 46, status: "confirmed", source: "web", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Ana", payment_method: "transfer",
        items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
    ],
  });
  const transfer = find(doc.body, node => node.tagName === "button" && node.textContent === "Confirmar transferencia");
  assert.ok(transfer);
  transfer.trigger("click");
  await flush();
  assert.ok(calls.some(item => item.path === "/panel/api/orders/o3b/pay-transfer"), "intenta la ruta real");
  assert.equal(calls.some(item => item.path === "/panel/api/orders/o3b/pay-cash"), false, "nunca falsea el método");
  assert.match(doc.body.textContent, /todavía no permite confirmar transferencias/);
});

test("un pedido listo ofrece wa.me manual con pedido y sede, sin datos fiscales", async () => {
  const { doc } = await openNewOrder({
    posOrders: [
      { id: "o4", number: 44, status: "ready", source: "web", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Ana", customer_phone: "0991234567",
        items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
    ],
  });
  await showFilter(doc, "Listos");
  assert.match(doc.body.textContent, /Listo para avisar/);
  assert.match(doc.body.textContent, /no envía mensajes automáticos/);
  const link = find(doc.body, node => node.tagName === "a" && node.textContent === "Avisar por WhatsApp");
  assert.ok(link, "el aviso es un enlace manual");
  const href = link.getAttribute("href");
  assert.match(href, /^https:\/\/wa\.me\/0991234567\?text=/);
  const message = decodeURIComponent(href.split("?text=")[1]);
  assert.match(message, /pedido #44/);
  assert.match(message, /Centro/);
  assert.match(message, /está listo/);
  assert.doesNotMatch(message, /RUC|cédula|cedula|correo|dirección|direccion/i);
});

test("marcar listo usa la ruta autenticada y no adelanta el estado", async () => {
  const { doc, calls } = await openNewOrder({
    posOrders: [
      { id: "o5", number: 45, status: "paid", source: "caja", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Luis", payment_method: "cash",
        items: [{ name: "Jugo natural", qty: 1, unit_cents: 950 }] },
    ],
  });
  await showFilter(doc, "Pagados");
  assert.match(doc.body.textContent, /Pago confirmado/);
  assert.equal(doc.body.textContent.includes("Listo para avisar"), false, "paid no se pinta como listo");
  const ready = find(doc.body, node => node.tagName === "button" && node.textContent === "Marcar listo");
  assert.ok(ready);
  ready.trigger("click");
  await flush();
  assert.ok(calls.some(item => item.path === "/panel/api/orders/o5/ready" && item.method === "POST"));
  assert.match(doc.body.textContent, /Orden lista\. Abre el enlace de WhatsApp/);
});

test("la comanda de caja abre la impresión antes de registrar el acuse", async () => {
  const { doc, calls, events } = await openNewOrder({
    posOrders: [
      { id: "o6", number: 46, status: "paid", source: "caja", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Ana", print_count: 0,
        items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
    ],
  });
  await showFilter(doc, "Pagados");
  const print = find(doc.body, node => node.tagName === "button" && node.textContent === "Imprimir comanda");
  assert.ok(print);
  print.trigger("click");
  await flush();
  assert.deepEqual(events, ["print", "ack"], "si no se abre el diálogo, no hay acuse");
  const ack = calls.find(item => item.path === "/panel/api/kitchen/orders/o6/print" && item.method === "POST");
  assert.ok(ack);
  assert.match(ack.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  const toast = doc.getElementById("toast");
  assert.match(toast.textContent, /Acuse registrado/);
  assert.match(toast.textContent, /no confirma el papel/);
  assert.doesNotMatch(toast.textContent, /impreso correctamente|impresión exitosa|papel impreso/);
});

test("si la impresión no se abre, la caja no registra un falso acuse", async () => {
  const context = await openNewOrder({
    posOrders: [
      { id: "o7", number: 47, status: "paid", source: "caja", sede_id: "centro", total_cents: 950,
        currency: "USD", created_at: 0, customer_name: "Ana", print_count: 0,
        items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] },
    ],
  });
  await showFilter(context.doc, "Pagados");
  context.setPrintThrows(true);
  const print = find(context.doc.body, node => node.tagName === "button" && node.textContent === "Imprimir comanda");
  print.trigger("click");
  await flush();
  assert.deepEqual(context.events, ["print"]);
  assert.equal(context.calls.some(item => item.path.includes("/print")), false);
  const toast = context.doc.getElementById("toast");
  assert.match(toast.textContent, /No pudimos abrir la impresión\. No se registró acuse\./);
});

test("Pedidos también muestra las órdenes web/caja con sede", async () => {
  const { doc, calls } = startPanel();
  await flush();
  const nav = find(doc.body, node => node.tagName === "button" && node.dataset.tab === "orders");
  assert.ok(nav);
  nav.trigger("click");
  await flush();
  assert.ok(calls.some(call => call.path.startsWith("/panel/api/pos/orders?status=open")));
  assert.match(doc.body.textContent, /Órdenes con sede/);
  assert.match(doc.body.textContent, /#40/);
  assert.match(doc.body.textContent, /Confirmado · falta cobro/);
  assert.match(doc.body.textContent, /Cobrar efectivo/);
  assert.match(doc.body.textContent, /Centro/, "muestra el nombre de la sede");
});
