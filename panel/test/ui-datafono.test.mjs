// UI del cobro manual con datáfono (docs/DATAFONO-MANUAL.md): formulario
// accesible con autorización y últimos 4, idempotencia, errores en español y
// etiquetas nuevas del reporte de turno. Sin red real: fetch simulado.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/page.js";
import { renderMeseroPage } from "../src/mesero.js";
import { shiftTicketLines } from "../../shared/ticket.js";
import { makeEnv } from "./helpers.mjs";

const URL_BASE = "https://pizza.craft-systems.com";
const site = { slug: "pizza", host: "pizza.craft-systems.com" };

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
  append(...nodes) {
    nodes.flat(Infinity).forEach(node => {
      if (node == null || node === false) return;
      if (!node.nodeType) node = this.doc.createTextNode(String(node));
      node.parentNode = this;
      this.children.push(node);
    });
  }
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
  trigger(name) { (this.listeners.get(name) || []).forEach(listener => listener({ preventDefault() {}, currentTarget: this, target: this })); }
  querySelector(selector) { return find(this, node => matches(node, selector)); }
  focus() {}
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
  querySelectorAll(selector) {
    if (!selector.startsWith(".")) return [];
    return findAll(this.body, node => node.classList.contains(selector.slice(1)));
  }
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
const byText = (root, tag, text) => find(root, node => node.tagName === tag && node.textContent === text);

async function flush() {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

const CONFIRMED = { id: "o2", number: 41, status: "confirmed", source: "caja", sede_id: "centro",
  total_cents: 950, currency: "USD", created_at: 0, customer_name: "Luis", payment_method: "cash",
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }] };
const PENDING = { ...CONFIRMED, id: "o1", number: 40, status: "pending", source: "web" };

/* ── Panel del dueño ─────────────────────────────────────────────────────── */

function runtimeSource() {
  const html = renderPage({ slug: "pizza", host: "pizza.craft-systems.com" });
  const match = /<script id="panelMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  return match[1];
}

function startPanel({ posOrders = [CONFIRMED], datafono = null, failFirst = false } = {}) {
  const doc = new Document(), calls = [];
  let attempts = 0;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), URL_BASE);
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    if (path === "/panel/api/me") return Response.json({ email: "dueno@pizza.ec", store: { store_name: "Pizza", currency: "USD" }, features: { loyalty: false } });
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
    if (/^\/panel\/api\/orders\/[^/]+\/pay-datafono$/.test(parsed.pathname) && method === "POST") {
      attempts++;
      if (failFirst && attempts === 1) return Response.json({ error: "sin_mock" }, { status: 500 });
      if (datafono) return datafono(parsed.pathname.split("/")[4]);
      return Response.json({ order: { id: parsed.pathname.split("/")[4], status: "paid", payment_method: "bendo" } });
    }
    if (/^\/panel\/api\/orders\/[^/]+\/(confirm|reject|ready)$/.test(parsed.pathname) && method === "POST") {
      return Response.json({ order: { id: parsed.pathname.split("/")[4], status: "confirmed" } });
    }
    if (path.startsWith("/panel/api/orders")) return Response.json({ orders: [], total: 0, pending: 0 });
    if (path.startsWith("/panel/api/turnos")) return Response.json({ shift: null });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "pizza", host: "pizza.craft-systems.com" },
    scrollTo() {},
    confirm: () => true,
    open() {},
    setTimeout: () => 0,
    print: () => {},
  };
  const location = { pathname: "/panel", host: "pizza.craft-systems.com", origin: URL_BASE, search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => true, () => 0, () => {},
  );
  return { doc, calls, attempts: () => attempts };
}

async function openNewOrder(options) {
  const context = startPanel(options);
  await flush();
  const nav = byText(context.doc.body, "button", "Nueva orden");
  assert.ok(nav, "existe la entrada Nueva orden en Ventas");
  nav.trigger("click");
  await flush();
  return context;
}

// Campos del formulario por su etiqueta visible (label for/id).
function labeledInput(root, labelText) {
  const label = find(root, node => node.tagName === "label" && node.textContent === labelText);
  assert.ok(label, "existe la etiqueta " + labelText);
  const id = label.getAttribute("for");
  const input = find(root, node => node.tagName === "input" && node.id === id);
  assert.ok(input, "el campo " + labelText + " está asociado a su etiqueta");
  return input;
}

test("la caja ofrece cobrar con datáfono en pedidos pending y confirmed, con formulario accesible", async () => {
  const { doc } = await openNewOrder({ posOrders: [PENDING, CONFIRMED] });
  const buttons = findAll(doc.body, node => node.tagName === "button" && node.textContent === "Cobrado con datáfono");
  assert.equal(buttons.length, 2, "pendiente y confirmado pueden cobrarse con datáfono");
  buttons[1].trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  assert.ok(form, "se abre el formulario dentro de la orden");
  assert.match(form.textContent, /Cobra primero en el datáfono y copia el número de autorización del voucher/);
  assert.ok(labeledInput(form, "Número de autorización"), "la autorización tiene etiqueta");
  assert.ok(labeledInput(form, "Últimos 4 dígitos (opcional)"), "los últimos 4 son opcionales y están etiquetados");
  assert.ok(byText(form, "button", "Registrar cobro"));
  assert.ok(byText(form, "button", "Cancelar"));
});

test("confirmar envía la ruta con idempotency_key, autorización y últimos 4", async () => {
  const { doc, calls } = await openNewOrder();
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  labeledInput(form, "Últimos 4 dígitos (opcional)").value = "1234";
  form.trigger("submit");
  await flush();
  const paid = calls.find(call => call.path === "/panel/api/orders/o2/pay-datafono" && call.method === "POST");
  assert.ok(paid, "usa la ruta pay-datafono");
  assert.match(paid.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(paid.body.authorization_code, "A7K2");
  assert.equal(paid.body.card_last4, "1234");
  assert.equal(calls.some(call => call.path.includes("/pay-cash")), false, "nunca cae a efectivo");
  assert.match(doc.getElementById("toast").textContent, /Cobrado con datáfono\. La comanda ya está en cocina/);
  assert.ok(calls.filter(call => call.path.startsWith("/panel/api/pos/orders")).length > 1, "recarga la lista");
});

test("los últimos 4 dígitos son opcionales y la autorización se valida antes de llamar", async () => {
  const { doc, calls } = await openNewOrder();
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  form.trigger("submit");
  await flush();
  assert.equal(calls.some(call => call.path.endsWith("/pay-datafono")), false, "sin autorización no llama");
  assert.match(find(form, node => node.classList.contains("err")).textContent, /número de autorización/i);

  labeledInput(form, "Número de autorización").value = "ab!"; // inválida
  form.trigger("submit");
  await flush();
  assert.equal(calls.some(call => call.path.endsWith("/pay-datafono")), false);

  labeledInput(form, "Número de autorización").value = "ZX98";
  labeledInput(form, "Últimos 4 dígitos (opcional)").value = "12";
  form.trigger("submit");
  await flush();
  assert.equal(calls.some(call => call.path.endsWith("/pay-datafono")), false, "un 4 inválido no se envía");
  assert.match(find(form, node => node.classList.contains("err")).textContent, /4 números/);

  labeledInput(form, "Últimos 4 dígitos (opcional)").value = "";
  form.trigger("submit");
  await flush();
  const paid = calls.find(call => call.path === "/panel/api/orders/o2/pay-datafono");
  assert.ok(paid, "sin últimos 4 también se registra");
  assert.equal(paid.body.card_last4, undefined, "no se inventa la tarjeta");
});

test("un reintento tras un error reutiliza la misma clave de idempotencia", async () => {
  const { doc, calls } = await openNewOrder({ failFirst: true });
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  form.trigger("submit");
  await flush();
  assert.match(find(form, node => node.classList.contains("err")).textContent, /No pudimos registrar el cobro con datáfono/);
  form.trigger("submit");
  await flush();
  const attempts = calls.filter(call => call.path.endsWith("/pay-datafono"));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].body.idempotency_key, attempts[1].body.idempotency_key, "la clave no cambia al reintentar");
});

test("caja cerrada y link en curso explican el 409 en español sin marcar pagado", async () => {
  const { doc, calls } = await openNewOrder({
    datafono: () => Response.json({ error: "caja_cerrada" }, { status: 409 }),
  });
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  let form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  form.trigger("submit");
  await flush();
  assert.match(doc.getElementById("toast").textContent, /Abre la caja de esta sede para cobrar\./);

  const second = await openNewOrder({
    datafono: () => Response.json({ error: "pago_en_curso" }, { status: 409 }),
  });
  byText(second.doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  form = find(second.doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "B9Q4";
  form.trigger("submit");
  await flush();
  assert.match(second.doc.getElementById("toast").textContent,
    /Este pedido tiene un pago con tarjeta en curso\. Verifícalo antes de cobrar con datáfono/);
  assert.ok(second.calls.filter(call => call.path.startsWith("/panel/api/pos/orders")).length > 1, "recarga sin falsear el cobro");
});

test("corregir la autorización cambia la clave; reintentar lo mismo no", async () => {
  const { doc, calls } = await openNewOrder({
    datafono: () => Response.json({ error: "sin_mock" }, { status: 500 }),
  });
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  form.trigger("submit");
  await flush();
  form.trigger("submit");
  await flush();
  labeledInput(form, "Número de autorización").value = "B8K3";
  form.trigger("submit");
  await flush();
  const keys = calls.filter(call => call.path.endsWith("/pay-datafono")).map(call => call.body.idempotency_key);
  assert.equal(keys.length, 3);
  assert.equal(keys[0], keys[1], "reintentar el mismo cuerpo reutiliza la clave");
  assert.notEqual(keys[1], keys[2], "otra autorización usa otra clave");
});

test("un error 400 del servidor se corrige en el formulario sin perder los datos", async () => {  const { doc, calls } = await openNewOrder({
    datafono: () => Response.json({ error: "tarjeta_invalida" }, { status: 400 }),
  });
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  labeledInput(form, "Últimos 4 dígitos (opcional)").value = "1234";
  form.trigger("submit");
  await flush();
  assert.match(find(form, node => node.classList.contains("err")).textContent, /Los últimos 4 dígitos deben ser 4 números\./);
  assert.ok(form.isConnected !== false);
  assert.equal(labeledInput(form, "Número de autorización").value, "A7K2", "conserva lo escrito");
  assert.ok(calls.some(call => call.path.endsWith("/pay-datafono")));
});

test("si el panel no expone pay-datafono avisa sin falsear otro cobro", async () => {
  const { doc, calls } = await openNewOrder({
    datafono: () => Response.json({ error: "ruta_no_encontrada" }, { status: 404 }),
  });
  byText(doc.body, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  const form = find(doc.body, node => node.tagName === "form" && node.getAttribute("aria-label") === "Cobrado con datáfono");
  labeledInput(form, "Número de autorización").value = "A7K2";
  form.trigger("submit");
  await flush();
  assert.match(doc.getElementById("toast").textContent, /todavía no permite cobrar con datáfono/);
  assert.equal(calls.some(call => call.path.includes("/pay-cash")), false, "no cae a efectivo");
});

// Contrato, decisión 3: cualquier pedido pending/confirmed se cobra con datáfono.
// Un cliente que no terminó el link paga en el mostrador; si el link sigue en
// curso, el servidor responde 409 pago_en_curso (la UI no decide por él).
test("un pedido con tarjeta por link sigue esperando, pero ofrece cobrar con datáfono", async () => {
  const { doc } = await openNewOrder({
    posOrders: [{ ...CONFIRMED, id: "o9", payment_method: "bendo" }],
  });
  assert.match(doc.body.textContent, /Esperando confirmación de la tarjeta/);
  assert.equal(doc.body.textContent.includes("Cobrado con datáfono"), true);
});

test("un pedido histórico de Payphone no ofrece datáfono", async () => {
  const { doc } = await openNewOrder({
    posOrders: [{ ...CONFIRMED, id: "o9p", payment_method: "payphone" }],
  });
  assert.equal(doc.body.textContent.includes("Cobrado con datáfono"), false);
});

test("el listado muestra «Pago: datáfono · aut. XXXX» cuando llega la autorización", async () => {
  const { doc } = await openNewOrder({
    posOrders: [
      { ...CONFIRMED, id: "o10", status: "paid", payment_method: "bendo", channel: "datafono", authorization: "A7K2" },
      { ...CONFIRMED, id: "o11", status: "paid", payment_method: "bendo", payment_channel: "datafono" },
      { ...CONFIRMED, id: "o12", status: "paid" },
    ],
  });
  const tab = find(doc.body, node => node.classList.contains("subtab") && node.textContent === "Pagados");
  assert.ok(tab, "existe el filtro Pagados");
  tab.trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Pago: datáfono · aut\. A7K2/);
  assert.match(doc.body.textContent, /Pago: datáfono/);
  assert.match(doc.body.textContent, /Pago: efectivo/, "sin canal sigue la etiqueta del método");
});

/* ── Modo mesero / cajero ────────────────────────────────────────────────── */

async function startMesero({ orders = [CONFIRMED], fetchImpl } = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request(`${URL_BASE}/panel/mesero`), env, site);
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  const root = new Node(null, "main");
  const toastEl = new Node(null, "div");
  const body = new Node(null, "body");
  const doc = {
    visibilityState: "visible",
    body,
    createElement: tag => new Node(null, tag),
    createTextNode: text => new Node(null, "#text", String(text)),
    getElementById: id => id === "mesero" ? root : id === "toast" ? toastEl : null,
    addEventListener() {},
    querySelectorAll: selector => selector.startsWith(".")
      ? findAll(body, node => node.classList.contains(selector.slice(1)))
      : [],
  };
  const window = {
    __MESERO__: {
      store: "Pizza",
      boot: {
        me: {
          staff: { id: "dueno", name: "Dueño" }, owner: true,
          store: { name: "Pizza", currency: "USD" },
          sedes: [{ id: "centro", nombre: "Centro" }],
        },
        catalog: { products: [], categories: [], variant_groups: [] },
        orders,
      },
    },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    setTimeout() { return 0; },
    addEventListener() {},
    scrollTo() {},
  };
  const localStorage = { getItem: () => "centro", setItem() {}, removeItem() {} };
  const location = { pathname: "/panel/mesero", search: "" };
  const calls = [];
  const route = fetchImpl || (async call => {
    if (/\/pay-datafono$/.test(call.path)) return Response.json({ order: { ...orders[0], status: "paid" } });
    if (call.path === "/panel/api/turnos/actual") return Response.json({ shift: null });
    return Response.json({ orders });
  });
  const fetchMock = async (url, init = {}) => {
    const parsed = new URL(String(url), URL_BASE);
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
  return { root, doc, toast: toastEl, calls };
}

function meseroInput(root, labelText) {
  const label = find(root, node => node.tagName === "label" && node.textContent === labelText);
  assert.ok(label, "existe la etiqueta " + labelText);
  const input = find(label, node => node.tagName === "input");
  assert.ok(input, "el campo " + labelText + " está dentro de su etiqueta");
  return input;
}

test("mesero: el cobro con datáfono pide autorización y últimos 4 con etiquetas", async () => {
  const { root, doc, toast, calls } = await startMesero();
  const open = byText(root, "button", "Cobrado con datáfono");
  assert.ok(open, "el pedido confirmado ofrece datáfono");
  open.trigger("click");
  await flush();
  const dialog = find(doc.body, node => node.getAttribute("role") === "dialog");
  assert.ok(dialog, "se abre el diálogo");
  assert.equal(dialog.getAttribute("aria-label"), "Cobrado con datáfono");
  assert.match(dialog.textContent, /Cobra primero en el datáfono y copia el número de autorización del voucher/);
  assert.ok(byText(dialog, "h2", "Cobrado con datáfono"));
  assert.ok(meseroInput(dialog, "Número de autorización"));
  assert.ok(meseroInput(dialog, "Últimos 4 dígitos (opcional)"));
  const form = find(dialog, node => node.tagName === "form");
  meseroInput(dialog, "Número de autorización").value = "A7K2";
  meseroInput(dialog, "Últimos 4 dígitos (opcional)").value = "9876";
  form.trigger("submit");
  await flush();
  const paid = calls.find(call => call.path === "/panel/api/orders/o2/pay-datafono");
  assert.ok(paid, "usa la ruta pay-datafono del panel");
  assert.match(paid.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(paid.body.authorization_code, "A7K2");
  assert.equal(paid.body.card_last4, "9876");
  assert.match(toast.textContent, /Cobrado con datáfono\. La comanda ya está en cocina/);
});

test("mesero: sin autorización válida no llama y el 409 de caja cerrada se explica", async () => {
  const { root, doc, toast, calls } = await startMesero({
    fetchImpl: async call => {
      if (/\/pay-datafono$/.test(call.path)) return Response.json({ error: "caja_cerrada" }, { status: 409 });
      if (call.path === "/panel/api/turnos/actual") return Response.json({ shift: null });
      return Response.json({ orders: [{ ...CONFIRMED, id: "orden-confirmada" }] });
    },
  });
  byText(root, "button", "Cobrado con datáfono").trigger("click");
  await flush();
  let dialog = find(doc.body, node => node.getAttribute("role") === "dialog");
  let form = find(dialog, node => node.tagName === "form");
  form.trigger("submit");
  await flush();
  assert.equal(calls.some(call => call.path.endsWith("/pay-datafono")), false);
  assert.match(find(dialog, node => node.classList.contains("err")).textContent, /4 a 12 letras o números/);
  meseroInput(dialog, "Número de autorización").value = "A7K2";
  form.trigger("submit");
  await flush();
  assert.match(toast.textContent, /Abre la caja de esta sede para cobrar\./);
});

test("mesero: el reporte del turno usa las etiquetas nuevas de los métodos", async () => {
  const shift = { id: "turno-1", sede_id: "centro", status: "open", opened_by: "dueno",
    opened_at: Date.UTC(2026, 10, 13, 13, 0), opening_float_cents: 2000, movements: [] };
  const report = {
    shift_id: "turno-1", sede_id: "centro", status: "closed",
    opened_at: shift.opened_at, closed_at: Date.UTC(2026, 10, 13, 18, 0),
    opened_by: "dueno", closed_by: "dueno", opening_float_cents: 2000,
    sales: [
      { method: "cash", count: 1, total_cents: 11000 },
      { method: "transfer", count: 1, total_cents: 250 },
      { method: "datafono", count: 2, total_cents: 4100 },
      { method: "bendo", count: 1, total_cents: 950 },
      { method: "payphone", count: 0, total_cents: 0 },
    ],
    sales_total_cents: 16300,
    movements: { in_cents: 0, out_cents: 0, items: [] },
    expected_cash_cents: 13000, counted_cash_cents: 13000, difference_cents: 0,
    pending_payments: { count: 0, total_cents: 0 }, orders: { paid: 5, rejected: 0 }, note: "",
  };
  const { root, doc } = await startMesero({
    orders: [CONFIRMED],
    fetchImpl: async call => {
      if (call.path === "/panel/api/turnos/actual") return Response.json({ shift });
      if (/\/cerrar$/.test(call.path)) return Response.json({ report });
      return Response.json({ orders: [CONFIRMED] });
    },
  });
  byText(root, "button", "Cerrar caja").trigger("click");
  await flush();
  meseroInput(doc.body, "Efectivo contado en dólares").value = "130.00";
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const text = root.textContent;
  for (const label of ["Efectivo · 1 pago(s)", "Transferencia · 1 pago(s)", "Datáfono · 2 pago(s)",
    "Tarjeta (link) · 1 pago(s)", "Payphone (histórico) · 0 pago(s)"])
    assert.ok(text.includes(label), label);
});

test("shiftTicketLines rotula Datáfono y los métodos nuevos del contrato", () => {
  const lines = shiftTicketLines({
    status: "closed", sede_id: "sede-01",
    opened_at: Date.UTC(2026, 10, 13, 13, 0), closed_at: Date.UTC(2026, 10, 13, 18, 0),
    opening_float_cents: 2000,
    sales: [
      { method: "cash", count: 1, total_cents: 1000 },
      { method: "transfer", count: 1, total_cents: 250 },
      { method: "datafono", count: 2, total_cents: 4100 },
      { method: "bendo", count: 1, total_cents: 950 },
      { method: "payphone", count: 0, total_cents: 0 },
    ],
    sales_total_cents: 6300,
    expected_cash_cents: 3000, counted_cash_cents: 3000, difference_cents: 0,
  }, { store: "Munch", width: 48, sedeName: "Centro" });
  const joined = lines.join("\n");
  for (const label of ["Efectivo (1)", "Transferencia (1)", "Datáfono (2)", "Tarjeta (link) (1)", "Payphone (histórico) (0)"])
    assert.ok(joined.includes(label), label);
});
