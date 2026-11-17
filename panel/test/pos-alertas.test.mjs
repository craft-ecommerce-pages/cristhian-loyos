// POS: la caja se entera sola de los pedidos web (insignia, sondeo, pitido).
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { renderMeseroPage } from "../src/mesero.js";
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

async function flush() {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

const catalog = {
  products: [
    { id: "p1", name: "Pizza margarita", price: "9.50", active: true, catalog_visible: true, categories: [] },
  ],
  categories: [],
  variant_groups: [],
};

const order = (extra) => ({
  id: "web-1", number: 31, status: "pending", source: "web", sede_id: "centro",
  created_at: Date.UTC(2026, 10, 17, 15, 0), total_cents: 950, currency: "USD",
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }],
  ...extra,
});

// Navegador mínimo: registra sondeos, pitidos y vibraciones, y permite liberar
// las respuestas del fetch a mano para probar solapes.
async function startPos({ orders = [], fetchImpl = null } = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request("https://pizza.craft-systems.com/panel/mesero"), env, site);
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");

  const root = new Node("main");
  const toast = new Node("div");
  let renders = 0;
  const replaceChildren = root.replaceChildren.bind(root);
  root.replaceChildren = (...kids) => { renders++; return replaceChildren(...kids); };

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
  const vibrations = [];
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
    navigator: { vibrate: pattern => vibrations.push(pattern) },
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
  const poll = async () => {
    assert.ok(polls.length, "el sondeo quedó activo");
    await polls[polls.length - 1].fn();
    await flush();
  };
  return { root, doc, toast, polls, beeps, vibrations, poll, renders: () => renders };
}

// Fetch de caja: pedidos mutables + turno vacío; el conteo permite ver solapes.
function posFetch(state) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).includes("/panel/api/turnos/")) return Response.json({ shift: null });
    return Response.json({ orders: state.orders });
  };
  return { fetchImpl, calls };
}

test("el sondeo cada 10 s no repinta con el constructor abierto", async () => {
  const state = { orders: [order()] };
  const { fetchImpl } = posFetch(state);
  const { root, doc, poll, beeps, renders } = await startPos({ orders: [order()], fetchImpl });

  const nuevo = find(root, node => node.tagName === "button" && node.textContent === "Nueva venta");
  assert.ok(nuevo);
  nuevo.trigger("click");
  await flush();
  const search = find(root, node => node.tagName === "input" && node.getAttribute("aria-label") === "Buscar producto");
  assert.ok(search, "el cajero está armando un pedido");
  search.value = "piz";
  const painted = renders();

  // Llega un pedido web nuevo mientras escribe: no se repinta nada.
  state.orders = [order({ id: "web-2", number: 32, total_cents: 1200 })];
  await poll();
  assert.equal(renders(), painted, "no se re-renderiza con el constructor abierto");
  assert.ok(find(root, node => node === search), "lo que estaba digitando sigue en pantalla");
  assert.match(doc.title, /^\(1\) Caja · Pizza$/, "el contador sí se actualiza");
  assert.equal(beeps.length, 1, "el aviso sonoro no espera al repintado");
});

test("la primera carga no suena y un pedido web nuevo pita y vibra una vez", async () => {
  const state = { orders: [order(), order({ id: "web-2", number: 32 })] };
  const { fetchImpl } = posFetch(state);
  const { beeps, vibrations, poll, doc, root } = await startPos({ orders: state.orders, fetchImpl });

  assert.equal(beeps.length, 0, "la primera carga nunca suena");
  assert.equal(vibrations.length, 0, "la primera carga no vibra");
  assert.equal(doc.title, "(2) Caja · Pizza", "la insignia sí cuenta lo que ya espera");

  // Mismo listado: el sondeo no repite el aviso.
  await poll();
  assert.equal(beeps.length, 0, "reconsultar no vuelve a sonar");

  state.orders = [...state.orders, order({ id: "web-3", number: 33 })];
  await poll();
  assert.equal(beeps.length, 1, "un pedido web nuevo pita una vez");
  assert.deepEqual(vibrations, [[120, 80, 120]], "y vibra si el equipo lo permite");
  assert.equal(doc.title, "(3) Caja · Pizza");
  assert.match(root.textContent, /#33/, "en Pedidos la lista sí se repinta sola");
});

test("la insignia cuenta solo pedidos web pendientes o confirmados", async () => {
  const orders = [
    order({ id: "w-pend", status: "pending", source: "web" }),
    order({ id: "w-conf", status: "confirmed", source: "web" }),
    order({ id: "w-pago", status: "paid", source: "web" }),
    order({ id: "w-listo", status: "ready", source: "web" }),
    order({ id: "c-pend", status: "pending", source: "caja" }),
    order({ id: "w-rech", status: "rejected", source: "web" }),
  ];
  const { fetchImpl } = posFetch({ orders });
  const { root, doc } = await startPos({ orders, fetchImpl });

  const badge = find(root, node => node.classList && node.classList.contains("tab-badge"));
  assert.ok(badge, "la pestaña Pedidos trae insignia");
  assert.equal(badge.textContent, "2", "solo pendiente y confirmado web");
  assert.equal(badge.hidden, false);
  assert.equal(doc.title, "(2) Caja · Pizza");
  const tab = find(root, node => node.tagName === "button" && node.textContent.startsWith("Pedidos"));
  assert.equal(tab.getAttribute("aria-label"), "Pedidos, 2 web sin atender");

  // Sin web esperando, la insignia desaparece y el título vuelve al original.
  const soloCaja = [order({ id: "c-1", status: "pending", source: "caja" })];
  const clean = posFetch({ orders: soloCaja });
  const second = await startPos({ orders: soloCaja, fetchImpl: clean.fetchImpl });
  const off = find(second.root, node => node.classList && node.classList.contains("tab-badge"));
  assert.equal(off.hidden, true);
  assert.equal(second.doc.title, "Caja · Pizza");
});

test("la caja nueva no muestra Mesas ni pide número de mesa", async () => {
  const viejo = [
    order({ id: "vieja-1", number: 12, source: "mesa", table_no: "4", client_name: "Mesa 4", status: "pending" }),
    order({ id: "vieja-2", number: 13, source: "mesa", table_no: "7", client_name: "Andrea", status: "pending" }),
  ];
  const { fetchImpl } = posFetch({ orders: viejo });
  const { root, doc } = await startPos({ orders: viejo, fetchImpl });

  assert.doesNotMatch(root.textContent, /Mesa/, "ni títulos ni etiquetas de origen Mesa");
  assert.match(root.textContent, /Mostrador/, "el histórico sin nombre cae en Mostrador");
  assert.match(root.textContent, /Andrea/);
  assert.match(root.textContent, /Web/, "el origen histórico se rotula Web");

  find(root, node => node.tagName === "button" && node.textContent === "Nueva venta").trigger("click");
  await flush();
  const campos = [];
  const walk = (node) => {
    if (node.tagName === "input" || node.tagName === "select" || node.tagName === "textarea")
      campos.push(node.getAttribute("aria-label") || "");
    (node.children || []).forEach(walk);
  };
  walk(doc.body);
  assert.equal(campos.some(label => /mesa/i.test(label)), false, "sin campo de número de mesa");
  assert.doesNotMatch(doc.body.textContent, /Mesa/);
});

test("el sondeo no se solapa con la consulta en curso", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let orderCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/panel/api/turnos/")) return Response.json({ shift: null });
    orderCalls++;
    await gate;
    return Response.json({ orders: [order()] });
  };
  const { polls } = await startPos({ orders: [order()], fetchImpl });

  const first = polls[polls.length - 1].fn();
  const second = polls[polls.length - 1].fn();
  release();
  await Promise.all([first, second]);
  await flush();
  assert.equal(orderCalls, 2, "una sola recarga (legacy + sede) aunque se dispare dos veces");
});

test("la transferencia muestra número corto y monto exactos para conciliar", async () => {
  const transfer = order({ id: "web-transfer", number: 32, payment_method: "transfer", total_cents: 950 });
  const { fetchImpl } = posFetch({ orders: [transfer] });
  const { root, doc } = await startPos({ orders: [transfer], fetchImpl });

  const button = find(root, node => node.tagName === "button" && node.textContent === "Confirmar transferencia");
  assert.ok(button);
  button.trigger("click");
  await flush();

  const sheet = find(doc.body, node => node.classList && node.classList.contains("transfer-focus"));
  assert.ok(sheet, "la hoja de transferencia destaca el dato");
  assert.match(sheet.textContent, /#32/);
  assert.match(sheet.textContent, /\$9\.50/);
  assert.match(doc.body.textContent, /Busca en tu banco una transferencia de \$9\.50 con referencia #32\./);
});
