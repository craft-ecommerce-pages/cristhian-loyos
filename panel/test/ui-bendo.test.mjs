// UI de caja: cobro con tarjeta (Bendo) desde una orden confirmada, con QR,
// enlace copiable y verificación contra la pasarela. Sin red real.
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
  // Canvas mínimo: basta con registrar que el QR se dibujó.
  getContext() {
    if (!this.ctx) this.ctx = { painted: 0, fillStyle: "", font: "", textAlign: "", textBaseline: "", fillRect() { this.painted++; }, fillText() {} };
    return this.ctx;
  }
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
const buttons = (root, label) => findAll(root, node => node.tagName === "button" && node.textContent === label);

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

const CONFIRMED_CAJA = { id: "o2", number: 41, status: "confirmed", source: "caja", sede_id: "centro",
  total_cents: 950, currency: "USD", created_at: 0, customer_name: "Luis",
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] };

function startPanel({ posOrders = [CONFIRMED_CAJA], bendo = true, bendoMissing = false } = {}) {
  const doc = new Document(), calls = [];
  let confirmAnswer = true;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    if (path === "/panel/api/me") return Response.json({ email: "dueno@pizza.ec", store: { store_name: "Pizza", currency: "USD" },
      features: { loyalty: false }, bendo });
    if (path === "/panel/api/catalog") return Response.json({ version: 1, categories: [{ slug: "pizzas", name: "Pizzas" }], products: [], variant_groups: [] });
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
    if (/^\/panel\/api\/orders\/[^/]+\/bendo$/.test(parsed.pathname) && method === "POST") {
      if (bendoMissing) return Response.json({ error: "ruta_no_encontrada" }, { status: 404 });
      return Response.json({ order_id: parsed.pathname.split("/")[4], payment_id: "REF123456789012",
        payment_url: "https://checkout.bendo.test/p/abc123", status: "confirmed", total_cents: 950 });
    }
    if (/^\/panel\/api\/payments\/[^/]+\/reconcile$/.test(parsed.pathname) && method === "POST") {
      return Response.json({ status: "aprobado", order_id: "o2", order_status: "paid" });
    }
    if (/^\/panel\/api\/orders\/[^/]+\/(confirm|reject|pay-cash|pay-transfer|ready)$/.test(parsed.pathname) && method === "POST") {
      return Response.json({ order: { id: parsed.pathname.split("/")[4], status: "paid" } });
    }
    if (path.startsWith("/panel/api/orders")) return Response.json({ orders: [], total: 0, pending: 0 });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "pizza", host: "pizza.craft-systems.com" },
    __qrPanel: () => [[1, 0, 1], [0, 1, 0], [1, 0, 1]],
    scrollTo() {},
    confirm: () => confirmAnswer,
    open() {},
    setTimeout: () => 0,
    print: () => {},
  };
  const location = { pathname: "/panel", host: "pizza.craft-systems.com", origin: "https://pizza.craft-systems.com", search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => confirmAnswer, () => 0, () => {},
  );
  return { doc, calls, setConfirm: value => { confirmAnswer = value; } };
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

test("orden confirmada de caja ofrece cobrar con tarjeta si me.bendo", async () => {
  const { doc, calls } = await openNewOrder();
  assert.match(doc.body.textContent, /Pago: efectivo/);
  const charge = find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar con tarjeta");
  assert.ok(charge, "la caja puede cobrar con tarjeta");
  charge.trigger("click");
  await flush();
  const started = calls.find(call => call.path === "/panel/api/orders/o2/bendo" && call.method === "POST");
  assert.ok(started, "usa la ruta de caja de Bendo");
  assert.match(started.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(started.body.order_token, undefined, "la caja no manda token del pedido");
});

test("el cobro con tarjeta muestra diálogo con QR, enlace copiable y verificación", async () => {
  const { doc } = await openNewOrder();
  const charge = find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar con tarjeta");
  charge.trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Cobro con tarjeta/);
  const dialog = find(doc.body, node => node.getAttribute("role") === "dialog");
  assert.ok(dialog, "se abre el diálogo de cobro");
  assert.equal(dialog.getAttribute("aria-label"), "Cobro con tarjeta");
  const canvas = find(dialog, node => node.tagName === "canvas");
  assert.ok(canvas, "el diálogo incluye el QR");
  assert.ok(!canvas.hidden, "el QR se muestra");
  assert.ok(canvas.ctx && canvas.ctx.painted > 0, "el QR se dibuja con el enlace");
  const link = find(dialog, node => node.tagName === "input" && node.getAttribute("aria-label") === "Enlace de pago");
  assert.ok(link, "el enlace es copiable");
  assert.equal(link.value, "https://checkout.bendo.test/p/abc123");
  assert.match(link.getAttribute("type"), /^text$/);
  assert.ok(find(dialog, node => node.tagName === "button" && node.textContent === "Copiar enlace"));
  assert.ok(find(dialog, node => node.tagName === "button" && node.textContent === "Verificar pago"));
  assert.match(doc.getElementById("toast").textContent, /Link de cobro generado/);
});

test("Verificar pago consulta la pasarela y recarga la caja", async () => {
  const { doc, calls } = await openNewOrder();
  find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar con tarjeta").trigger("click");
  await flush();
  const verify = find(doc.body, node => node.tagName === "button" && node.textContent === "Verificar pago");
  assert.ok(verify);
  verify.trigger("click");
  await flush();
  const reconcile = calls.find(call => call.path === "/panel/api/payments/REF123456789012/reconcile" && call.method === "POST");
  assert.ok(reconcile, "reconsulta el pago por su referencia");
  assert.match(doc.getElementById("toast").textContent, /Pago aprobado\. La comanda ya está en cocina\./);
  assert.ok(calls.filter(call => call.path.startsWith("/panel/api/pos/orders")).length > 1, "recarga la lista");
});

test("un pedido web bendo confirmado espera la confirmación de la tarjeta", async () => {
  const { doc } = await openNewOrder({
    posOrders: [{ ...CONFIRMED_CAJA, id: "o9", number: 49, source: "web", payment_method: "bendo" }],
  });
  assert.match(doc.body.textContent, /Pago: tarjeta \(Bendo\)/);
  assert.match(doc.body.textContent, /Esperando confirmación de la tarjeta/);
  assert.equal(doc.body.textContent.includes("Cobrar con tarjeta"), false, "no se recobra un link ya emitido");
});

test("sin me.bendo no aparece el cobro con tarjeta", async () => {
  const { doc } = await openNewOrder({ bendo: false });
  assert.equal(doc.body.textContent.includes("Cobrar con tarjeta"), false);
  assert.ok(find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar efectivo"), "el efectivo sigue disponible");
});

test("si el panel no expone la ruta bendo, avisa sin falsear otro cobro", async () => {
  const { doc, calls } = await openNewOrder({ bendoMissing: true });
  find(doc.body, node => node.tagName === "button" && node.textContent === "Cobrar con tarjeta").trigger("click");
  await flush();
  assert.ok(calls.some(call => call.path === "/panel/api/orders/o2/bendo"), "intenta la ruta real");
  assert.equal(calls.some(call => call.path === "/panel/api/orders/o2/pay-cash"), false, "nunca cae a efectivo");
  assert.match(doc.getElementById("toast").textContent, /todavía no permite cobrar con tarjeta/);
});
