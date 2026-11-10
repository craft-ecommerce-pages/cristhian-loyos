// MS3: panel del dueño para modo mesero y pedidos de mesa.
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
  append(...nodes) { nodes.forEach(node => { node.parentNode = this; this.children.push(node); }); }
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
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  trigger(name) { (this.listeners.get(name) || []).forEach(listener => listener({ preventDefault() {} })); }
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
  return selector.startsWith(".")
    ? node.classList.contains(selector.slice(1))
    : node.tagName === selector;
}

function find(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const found = find(child, predicate);
    if (found) return found;
  }
  return null;
}

function runtimeSource() {
  const html = renderPage({ slug: "pizza", host: "pizza.craft-systems.com" });
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  return scripts[2];
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

function startPanel() {
  const doc = new Document(), calls = [];
  let tablesEnabled = false;
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url), "https://pizza.craft-systems.com").pathname;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    if (path === "/panel/api/me") return Response.json({
      email: "dueno@pizza.ec",
      store: { store_name: "Pizza", currency: "USD" },
      features: { loyalty: false },
    });
    if (path === "/panel/api/catalog") return Response.json({ error: "sin_catalogo" }, { status: 500 });
    if (path === "/panel/api/tables" && method === "GET") return Response.json({ enabled: tablesEnabled });
    if (path === "/panel/api/tables" && method === "PUT") {
      tablesEnabled = body.enabled;
      return Response.json({ enabled: tablesEnabled });
    }
    if (path === "/panel/api/loyalty/staff") return Response.json({ items: [] });
    if (path.startsWith("/panel/api/orders")) return Response.json({
      orders: [
        { id: "pedido-abcdef", number: 27, table_no: "4", source: "mesa", print_count: 2,
          created_at: 0, total: 12, client_name: "Ana", client_phone: "", status: "pending" },
        { id: "pedido-xyzw", table_no: "", source: "web", print_count: 0,
          created_at: 0, total: 8, client_name: "Luis", client_phone: "", status: "confirmed" },
      ], total: 2, pending: 1,
    });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "pizza", host: "pizza.craft-systems.com" },
    scrollTo() {},
  };
  const location = { pathname: "/panel", host: "pizza.craft-systems.com", origin: "https://pizza.craft-systems.com", search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => true, () => 0, () => {},
  );
  return { doc, calls };
}

test("la página declara Meseros y mesas en Ventas sin condicionarla a fidelidad", () => {
  const html = renderPage({ slug: "pizza", host: "pizza.craft-systems.com" });
  assert.match(
    html,
    /\["orders", "Pedidos", ordersScreen, "Ventas"\],\s*\n\s*\["new-order", "Nueva orden", newOrderScreen, "Ventas"\],\s*\n\s*\["waiters-tables", "Meseros y mesas", meserosTablesScreen, "Ventas"\]/,
  );
  assert.match(html, /function meserosTablesScreen\(\)/);
  assert.doesNotMatch(html, /loyaltyAllowed\(\).*meserosTablesScreen/);
  assert.match(html, /staffManager\(cajaCard\(\)\)/);
  assert.match(html, /staffManager\(meseroCard\(\)\)/);
  assert.match(html, /https:\/\/" \+ host.*\/panel\/mesero/);
});

test("el interruptor simula GET y PUT /panel/api/tables aunque Fidelidad esté apagada", async () => {
  const { doc, calls } = startPanel();
  await flush();
  const section = find(doc.body, node => node.tagName === "button" && node.textContent === "Meseros y mesas");
  assert.ok(section, "la entrada lateral está disponible");
  assert.ok(section.listeners.get("click"), "la entrada abre la pantalla");
  section.trigger("click");
  await flush();
  assert.ok(calls.some(call => call.path === "/panel/api/tables" && call.method === "GET"));
  const input = find(doc.body, node => node.tagName === "input");
  assert.ok(input, "se muestra el interruptor de mesas");
  assert.equal(input.disabled, false);
  input.checked = true;
  input.trigger("change");
  await flush();
  assert.deepEqual(calls.find(call => call.path === "/panel/api/tables" && call.method === "PUT"), {
    path: "/panel/api/tables", method: "PUT", body: { enabled: true },
  });
  assert.match(doc.body.textContent, /Tus clientes eligen Mesa en el menú y el pedido llega aquí, sin WhatsApp\./);
});

test("Pedidos renderiza número o id corto, mesa, origen e impresiones", async () => {
  const { doc } = startPanel();
  await flush();
  const orders = find(doc.body, node => node.tagName === "button" && node.dataset.tab === "orders");
  assert.ok(orders);
  assert.ok(orders.listeners.get("click"));
  orders.trigger("click");
  await flush();
  assert.match(doc.body.textContent, /#27 · Ana/);
  assert.match(doc.body.textContent, /Mesa: 4 · Origen: Mesa/);
  assert.match(doc.body.textContent, /Impresa ×2/);
  assert.match(doc.body.textContent, /#xyzw · Luis/);
  assert.match(doc.body.textContent, /Mesa: — · Origen: Web/);
  assert.doesNotMatch(doc.body.textContent, /Impresa ×0/);
  assert.match(doc.body.textContent, /Abrir modo mesero/);
});
