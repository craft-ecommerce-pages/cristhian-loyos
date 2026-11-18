// UI de Configuración → Sedes: alta con id automático, baja/reactivación,
// textos de Contacto y sección de Envío oculta (sin borrar sus datos).
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
    this.value = "";
    this.checked = false;
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
  append(...nodes) {
    nodes.forEach(node => {
      if (node == null || node === false) return;
      if (node.nodeType !== 1 && node.nodeType !== 3) node = this.doc.createTextNode(String(node));
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
  for (const child of node.children || []) { const found = find(child, predicate); if (found) return found; }
  return null;
}
const findAll = (node, predicate, out = []) => {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) findAll(child, predicate, out);
  return out;
};

function runtimeSource() {
  const html = renderPage({ slug: "munch", host: "munch.craft-systems.com" });
  const match = /<script id="panelMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  return match[1];
}

async function flush() {
  for (let round = 0; round < 20; round++) {
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

const sedesPorDefecto = [
  { id: "sede-01", nombre: "UIDE", direccion: "Por confirmar", universidad: "UIDE", activa: true },
  { id: "sede-02", nombre: "Food truck 2", direccion: "Por confirmar", universidad: "", activa: false },
  { id: "sede-03", nombre: "Food truck 3", direccion: "Por confirmar", universidad: "", activa: false },
  { id: "sede-04", nombre: "Food truck 4", direccion: "Por confirmar", universidad: "", activa: false },
  { id: "sede-05", nombre: "Food truck 5", direccion: "Por confirmar", universidad: "", activa: false },
  { id: "sede-06", nombre: "Food truck 6", direccion: "Por confirmar", universidad: "", activa: false },
];

export function startPanel({ sedes = sedesPorDefecto, deliveryFee = 1.5 } = {}) {
  const doc = new Document(), calls = [], events = [];
  let confirmAnswer = true;
  const config = () => ({
    store_name: "Munch", whatsapp_number: "593958610812",
    delivery_fee: deliveryFee,
    location: { sedes: structuredClone(sedes), telefono_principal: "593958610812", out_of_coverage_message: "Elige tu sede." },
    hours: { tz: "America/Guayaquil", weekly: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), []])), closed_msg: "" },
  });
  const state = config();
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://munch.craft-systems.com");
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body });
    if (path === "/panel/api/me") return Response.json({ email: "dueno@munch.ec", store: { store_name: "Munch", currency: "USD" }, features: { loyalty: false } });
    if (path === "/panel/api/store" && method === "GET") return Response.json(structuredClone(state));
    if (path === "/panel/api/store" && method === "PATCH") {
      events.push("store");
      if (body.location) Object.assign(state.location, body.location);
      if (body.delivery_fee != null) state.delivery_fee = body.delivery_fee;
      if (body.hours) state.hours = body.hours;
      if (body.whatsapp_number) state.whatsapp_number = body.whatsapp_number;
      return Response.json(structuredClone(state));
    }
    if (path === "/panel/api/sedes" && method === "GET") return Response.json({ sedes: state.location.sedes.filter(sede => sede.activa) });
    if (path === "/panel/api/sedes" && method === "PUT") {
      events.push("sedes");
      state.location.sedes = body.sedes.map(sede => Object.assign({}, sede));
      return Response.json({ sedes: structuredClone(state.location.sedes) });
    }
    if (path === "/panel/api/catalog") return Response.json({ version: 1, categories: [], products: [], variant_groups: [] });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "munch", host: "munch.craft-systems.com" },
    scrollTo() {},
    confirm: () => confirmAnswer,
    open() {},
    setTimeout: () => 0,
    print: () => { events.push("print"); },
  };
  const location = { pathname: "/panel", host: "munch.craft-systems.com", origin: "https://munch.craft-systems.com", search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => confirmAnswer, () => 0, () => {},
  );
  return { doc, calls, events, config, setConfirm: value => { confirmAnswer = value; } };
}

async function openStore(options) {
  const context = startPanel(options);
  await flush();
  const nav = find(context.doc.body, node => node.tagName === "button" && node.dataset.tab === "store");
  assert.ok(nav, "existe Mi negocio");
  nav.trigger("click");
  await flush();
  return context;
}

test("Contacto rotula el WhatsApp del local y oculta Envío sin perder sus datos", async () => {
  const { doc, calls } = await openStore();
  const text = doc.body.textContent;
  assert.match(text, /WhatsApp del local \(avisos de pedido listo\)/);
  assert.match(text, /Con código de país, ejemplo 593958610812/);
  assert.equal(text.includes("A este WhatsApp llegan los pedidos"), false, "ya no promete pedidos por WhatsApp");

  const deliveryTitle = find(doc.body, node => node.tagName === "h3" && node.textContent === "Envío y cobertura");
  assert.ok(deliveryTitle, "la sección existe en el DOM");
  assert.equal(deliveryTitle.parentNode.getAttribute("hidden"), "", "la sección está oculta");
  assert.equal(text.includes("Tarifa fija"), true, "sus campos siguen en el formulario (datos conservados)");

  // Guardar sin tocar Envío conserva la tarifa y el mensaje previos.
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const patch = calls.find(call => call.path === "/panel/api/store" && call.method === "PATCH");
  assert.ok(patch, "guarda el negocio");
  assert.equal(patch.body.delivery_fee, 1.5);
  assert.equal(patch.body.location.out_of_coverage_message, "Elige tu sede.");
});

test("Sedes lista activas, agrega con id siguiente y muestra las dadas de baja", async () => {
  const { doc, calls } = await openStore();
  const text = doc.body.textContent;
  assert.match(text, /UIDE/);
  assert.match(text, /Por confirmar/);
  const nombres = () => findAll(doc.body, node => node.tagName === "input" && node.getAttribute("aria-label") === "Nombre de la sede").map(input => input.value);
  assert.equal(nombres().includes("Food truck 2"), false, "las dadas de baja quedan ocultas por defecto");
  assert.match(text, /Mostrar sedes dadas de baja/);
  assert.match(text, /QR por sede/);
  assert.equal(text.includes("Dar de baja"), true);

  const add = find(doc.body, node => node.tagName === "button" && node.textContent === "+ Agregar sede");
  assert.ok(add);
  add.trigger("click");
  await flush();
  const names = findAll(doc.body, node => node.tagName === "input" && node.getAttribute("aria-label") === "Nombre de la sede");
  assert.equal(names.length, 2, "se agregó el editor de la sede nueva");
  const nameInput = names[names.length - 1];
  nameInput.value = "Isla patio";
  nameInput.trigger("input");
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();

  const put = calls.find(call => call.path === "/panel/api/sedes" && call.method === "PUT");
  assert.ok(put, "usa PUT /panel/api/sedes (upsertSedes)");
  const created = put.body.sedes.find(sede => sede.nombre === "Isla patio");
  assert.ok(created, "la sede nueva viaja en el cuerpo");
  assert.equal(created.id, "sede-07", "el id se genera solo y no reutiliza los dados de baja");
  assert.equal(created.activa, true);
  assert.equal(created.direccion, "", "la dirección es opcional");
  const patch = calls.find(call => call.path === "/panel/api/store" && call.method === "PATCH");
  assert.equal(patch.body.location.sedes.find(sede => sede.id === "sede-07").direccion, "Por confirmar");
  assert.equal(nombres().includes("Isla patio"), true, "se pinta al guardar");

  const toggle = find(doc.body, node => node.tagName === "button" && node.textContent === "Mostrar sedes dadas de baja");
  assert.ok(toggle);
  toggle.trigger("click");
  await flush();
  assert.equal(nombres().includes("Food truck 2"), true, "el enlace muestra las inactivas");
  assert.equal(findAll(doc.body, node => node.tagName === "button" && node.textContent === "Reactivar").length, 5);
});

test("la UI no deja dar de baja la última sede activa", async () => {
  const { doc, calls } = await openStore({ sedes: [sedesPorDefecto[0]] });
  const baja = find(doc.body, node => node.tagName === "button" && node.textContent === "Dar de baja");
  assert.ok(baja);
  baja.trigger("click");
  await flush();
  const toast = doc.getElementById("toast");
  assert.match(toast.textContent, /última sede activa/);
  assert.equal(calls.some(call => call.method === "PUT"), false, "no guarda una baja inválida");
  assert.ok(find(doc.body, node => node.tagName === "button" && node.textContent === "Dar de baja"), "la sede sigue activa");
});

test("dar de baja pide confirmación y Reactivar la devuelve", async () => {
  const dosActivas = [
    sedesPorDefecto[0],
    { ...sedesPorDefecto[1], activa: true },
  ];
  const { doc, calls } = await openStore({ sedes: dosActivas });
  const nombres = () => findAll(doc.body, node => node.tagName === "input" && node.getAttribute("aria-label") === "Nombre de la sede").map(input => input.value);
  const baja = find(doc.body, node => node.tagName === "button" && node.textContent === "Dar de baja");
  baja.trigger("click");
  await flush();
  assert.deepEqual(nombres(), ["Food truck 2"], "la sede dada de baja sale de la lista activa");
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const put = calls.find(call => call.path === "/panel/api/sedes" && call.method === "PUT");
  assert.equal(put.body.sedes.find(sede => sede.id === "sede-01").activa, false);

  const toggle = find(doc.body, node => node.tagName === "button" && node.textContent === "Mostrar sedes dadas de baja");
  toggle.trigger("click");
  await flush();
  const reactivar = find(doc.body, node => node.tagName === "button" && node.textContent === "Reactivar");
  assert.ok(reactivar, "la sede dada de baja se puede reactivar");
  reactivar.trigger("click");
  await flush();
  assert.deepEqual(nombres(), ["UIDE", "Food truck 2"]);
});
