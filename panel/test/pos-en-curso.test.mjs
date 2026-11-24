// POS en curso: pedidos pagados con tarjeta visibles, sede recordada y alertas.
import test from "node:test";
import assert from "node:assert/strict";
import { listPosOrders } from "../src/orders.js";
import { renderMeseroPage } from "../src/mesero.js";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };
const request = (path) => new Request(`https://${site.host}${path}`);
const session = { owner: true, staff_id: "dueno" };

/* ── Backend: status=active ──────────────────────────────────────────────── */

function addOrder(env, { id, status, createdAt, readyAt = null, source = "web", sede = "centro" }) {
  env.DB.raw.prepare(
    "INSERT INTO pos_orders (id, slug, sede_id, created_at, updated_at, number, source, status, " +
    "status_at, currency, subtotal_cents, total_cents, items, customer_name, customer_phone, " +
    "delivery_mode, idempotency_key, idempotency_hash, payment_method, ready_at) " +
    "VALUES (?, 'pizza', ?, ?, ?, 1, ?, ?, ?, 'USD', 950, 950, ?, 'Ana', '', 'pickup', ?, ?, 'cash', ?)",
  ).run(
    id, sede, createdAt, createdAt, source, status, createdAt,
    JSON.stringify([{ name: "Pizza margarita", qty: 1, unit_cents: 950 }]),
    "idem-" + id, "hash-" + id, readyAt,
  );
}

async function activeOrders(env, status = "active") {
  const response = await listPosOrders(
    env, site, session, request(`/panel/api/pos/orders?status=${status}`),
  );
  assert.equal(response.status, 200);
  return (await response.json()).orders;
}

test("status=active: pending, confirmed y paid sin listo, del más antiguo al más nuevo", async () => {
  const env = makeEnv();
  addOrder(env, { id: "pend-viejo", status: "pending", createdAt: 3000 });
  addOrder(env, { id: "conf", status: "confirmed", createdAt: 1000 });
  addOrder(env, { id: "pagado", status: "paid", createdAt: 2000 });
  addOrder(env, { id: "listo", status: "paid", createdAt: 500, readyAt: 4000 });
  addOrder(env, { id: "rechazado", status: "rejected", createdAt: 100 });

  const orders = await activeOrders(env);
  assert.deepEqual(
    orders.map(order => order.id),
    ["conf", "pagado", "pend-viejo"],
    "FIFO de atención y sin pedidos listos ni rechazados",
  );
  assert.equal(orders.find(order => order.id === "pagado").status, "paid");
  assert.equal(orders.find(order => order.id === "listo") ?? null, null);
});

test("status=active con más de 50 en curso incluye el pedido más nuevo", async () => {
  const env = makeEnv();
  for (let i = 0; i < 55; i++) addOrder(env, { id: "viejo-" + i, status: "paid", createdAt: 1000 + i });
  addOrder(env, { id: "nuevo", status: "pending", createdAt: 9000 });
  const response = await listPosOrders(env, site, session, request("/panel/api/pos/orders?status=active&limit=50"));
  const ids = (await response.json()).orders.map(order => order.id);
  assert.equal(ids.length, 50);
  assert.equal(ids.at(-1), "nuevo", "el recién creado aparece (al final, FIFO)");
});

test("status=paid conserva su orden descendente y no cambia por active", async () => {
  const env = makeEnv();
  addOrder(env, { id: "pagado", status: "paid", createdAt: 2000 });
  addOrder(env, { id: "listo", status: "paid", createdAt: 500, readyAt: 4000 });

  const orders = await activeOrders(env, "paid");
  assert.deepEqual(orders.map(order => order.id), ["pagado", "listo"]);
  assert.equal(orders.find(order => order.id === "listo").status, "ready");
});

/* ── UI de la caja ────────────────────────────────────────────────────────── */

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
    this.disabled = false;
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
  append(...nodes) { nodes.forEach(node => { if (node == null || node === false) return; if (!node.nodeType) node = new Node("#text", String(node)); node.parentNode = this; this.children.push(node); }); }
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
const findAll = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
};

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

const order = (extra) => ({
  id: "web-1", number: 31, status: "pending", source: "web", sede_id: "centro",
  created_at: Date.UTC(2026, 10, 17, 15, 0), total_cents: 950, currency: "USD",
  ready_at: null,
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }],
  ...extra,
});

async function startPos({
  sedes = [{ id: "centro", nombre: "Centro" }],
  bootOrders = [],
  localStore = {},
  fetchImpl = null,
} = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(request("/panel/mesero"), env, site);
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
  const polls = [];
  const beeps = [];
  const audio = {
    state: "running", currentTime: 0, destination: {},
    createOscillator: () => ({ type: "", frequency: {}, connect() {}, start() { beeps.push(1); }, stop() {} }),
    createGain: () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, value: 0 }, connect() {} }),
    resume() {},
  };
  const window = {
    __MESERO__: {
      store: "Pizza",
      slug: "pizza",
      boot: {
        me: {
          staff: { id: "dueno", name: "Dueño" }, owner: true,
          store: { name: "Pizza", currency: "USD" }, sedes,
        },
        catalog,
        orders: bootOrders,
      },
    },
    __meseroTicket: ticketLines,
    __meseroColumns: ticketColumns,
    __meseroHeight: ticketPageHeight,
    navigator: { vibrate() {} },
    AudioContext: function AudioContext() { return audio; },
    setInterval(fn, ms) { polls.push({ fn, ms }); return polls.length; },
    clearInterval() {},
    setTimeout() { return 0; },
    addEventListener() {},
    scrollTo() {},
  };
  const storage = new Map(Object.entries(localStore));
  const localStorage = {
    getItem: key => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const location = { pathname: "/panel/mesero", search: "" };
  const calls = [];
  const route = fetchImpl || (async call => {
    if (call.path === "/panel/api/turnos/actual") return Response.json({ shift: null });
    return Response.json({ orders: bootOrders });
  });
  const fetchMock = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const call = {
      url: String(url), path: parsed.pathname, search: parsed.search,
      method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return route(call);
  };
  new Function("window", "document", "fetch", "localStorage", "location", "confirm", "setTimeout", "clearTimeout", match[1])(
    window, doc, fetchMock, localStorage, location, () => true, () => 0, () => {},
  );
  await flush();
  const poll = async () => {
    assert.ok(polls.length, "el sondeo quedó activo");
    await polls[polls.length - 1].fn();
    await flush();
  };
  return { root, doc, toast, polls, beeps, poll, calls, storage };
}

function ordersFetch(state) {
  return async (call) => {
    if (call.path === "/panel/api/turnos/actual") return Response.json({ shift: null });
    return Response.json({ orders: state.orders });
  };
}

function filterButton(root, label) {
  return find(root, node => node.tagName === "button" && node.textContent === label);
}

test("la caja abre en En curso y cada tarjeta muestra estado y origen", async () => {
  const state = { orders: [
    order({ id: "caja-1", number: 30, status: "pending", source: "caja" }),
    order({ id: "web-pago", number: 31, status: "paid", source: "web" }),
  ] };
  const { root, calls } = await startPos({ bootOrders: state.orders, fetchImpl: ordersFetch(state) });

  const active = filterButton(root, "En curso");
  assert.ok(active, "existe el filtro En curso");
  assert.equal(active.classList.contains("selected"), true, "En curso es el filtro por defecto");
  for (const label of ["Pendientes", "Pagados", "Todos"])
    assert.ok(filterButton(root, label), "filtro " + label);
  assert.equal(filterButton(root, "Por cobrar"), null, "los filtros son los cuatro del contrato");

  assert.ok(
    calls.some(call => call.path === "/panel/api/mesero/orders" &&
      call.search.includes("status=active") && call.search.includes("sede_id=centro")),
    "la carga consulta status=active para la sede elegida",
  );
  assert.match(root.textContent, /Por cobrar/);
  assert.match(root.textContent, /Pagado · en cocina/);
  assert.match(root.textContent, /Caja/);
  assert.match(root.textContent, /Web/);
});

test("con una sola sede permitida se elige sola y se recuerda por tienda", async () => {
  const state = { orders: [] };
  const { root, storage } = await startPos({
    sedes: [{ id: "centro", nombre: "Centro" }], fetchImpl: ordersFetch(state),
  });
  const select = find(root, node => node.tagName === "select");
  assert.equal(select.value, "centro");
  assert.equal(root.textContent.includes("Elige tu sede para ver los pedidos"), false);
  assert.equal(storage.get("pos_sede:pizza"), "centro");
});

test("con varias sedes se restaura la última elegida desde localStorage", async () => {
  const state = { orders: [] };
  const { root } = await startPos({
    sedes: [{ id: "centro", nombre: "Centro" }, { id: "norte", nombre: "Norte" }],
    localStore: { "pos_sede:pizza": "norte" },
    fetchImpl: ordersFetch(state),
  });
  const select = find(root, node => node.tagName === "select");
  assert.equal(select.value, "norte");
});

test("sin sede se muestra el aviso grande y no se consultan pedidos", async () => {
  const state = { orders: [order()] };
  const { root, calls, toast } = await startPos({
    sedes: [{ id: "centro", nombre: "Centro" }, { id: "norte", nombre: "Norte" }],
    fetchImpl: ordersFetch(state),
  });
  assert.match(root.textContent, /Elige tu sede para ver los pedidos/);
  assert.equal(
    calls.some(call => call.path === "/panel/api/mesero/orders"),
    false,
    "sin sede no se carga la lista",
  );
  assert.notEqual(toast.textContent, "No pudimos actualizar los pedidos.");
});

test("un pedido web pagado nuevo suena y cuenta; la primera carga no suena", async () => {
  const state = { orders: [] };
  const { root, doc, beeps, poll } = await startPos({ fetchImpl: ordersFetch(state) });
  let badge = find(root, node => node.classList && node.classList.contains("tab-badge"));
  assert.equal(badge.textContent, "", "sin pedidos no hay insignia");
  assert.equal(beeps.length, 0, "la primera carga no suena");

  state.orders = [order({ id: "web-pago", number: 32, status: "paid", source: "web", ready_at: null })];
  await poll();
  badge = find(root, node => node.classList && node.classList.contains("tab-badge"));
  assert.equal(beeps.length, 1, "un pago con tarjeta recién llegado sí avisa");
  assert.equal(badge.textContent, "1", "la insignia cuenta el pedido web en curso");
  assert.equal(doc.title, "(1) Caja · Pizza");
  assert.match(root.textContent, /#32/);
  assert.match(root.textContent, /Pagado · en cocina/);

  // Volver a consultar el mismo pedido no repite el aviso.
  await poll();
  assert.equal(beeps.length, 1);
});

test("una primera carga con un pedido pagado web cuenta pero no suena", async () => {
  const paid = order({ id: "web-pago", number: 32, status: "paid", source: "web" });
  const state = { orders: [paid] };
  const { root, doc, beeps, poll } = await startPos({
    bootOrders: [paid], fetchImpl: ordersFetch(state),
  });
  assert.equal(beeps.length, 0, "la primera carga nunca suena");
  const badge = find(root, node => node.classList && node.classList.contains("tab-badge"));
  assert.equal(badge.textContent, "1");
  assert.equal(doc.title, "(1) Caja · Pizza");

  await poll();
  assert.equal(beeps.length, 0, "reconsultar el mismo pedido no suena");
});

test("un pedido listo deja de estar en curso", async () => {
  const state = { orders: [order({ id: "web-pago", number: 32, status: "paid", source: "web" })] };
  const { root, doc, beeps, poll } = await startPos({
    bootOrders: state.orders, fetchImpl: ordersFetch(state),
  });
  assert.match(root.textContent, /Pagado · en cocina/);
  state.orders = [{ ...state.orders[0], status: "ready", ready_at: Date.now() }];
  await poll();
  assert.doesNotMatch(root.textContent, /Pagado · en cocina/);
  const badge = find(root, node => node.classList && node.classList.contains("tab-badge"));
  assert.equal(badge.hidden, true);
  assert.equal(doc.title, "Caja · Pizza");
  assert.equal(beeps.length, 0);
});
