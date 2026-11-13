// UI del dueño: barra de caja en pedidos POS y sección "Cierres de caja".
// La API de turnos no existe todavía en esta rama: aquí se simulan las respuestas
// (fetch reemplazado), igual que en ui-page.test.mjs. Montos en centavos enteros.
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
  trigger(name) { (this.listeners.get(name) || []).forEach(listener => listener({ preventDefault() {}, currentTarget: this, target: this })); }
  querySelector(selector) { return find(this, node => matches(node, selector)); }
  scrollIntoView() {}
  focus() {}
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
const button = (node, label) => findAll(node, n => n.tagName === "button" && n.textContent === label);
const byLabel = (node, label) => find(node, n => n.tagName === "input" && n.getAttribute("aria-label") === label);

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

// 2026-11-13 10:30 en America/Guayaquil (UTC-5, sin horario de verano).
const OPENED_AT = Date.UTC(2026, 10, 13, 15, 30);

const SEDES = [{ id: "sede-01", nombre: "Centro", activa: true }, { id: "sede-02", nombre: "Norte", activa: true }];

const OPEN_SHIFT = {
  id: "s1", sede_id: "sede-01", status: "open", opened_at: OPENED_AT,
  opened_by: "dueno@pizza.ec", opening_float_cents: 2000,
  movements: [{ kind: "out", amount_cents: 5000, reason: "Depósito banco", staff_id: "dueno@pizza.ec", created_at: OPENED_AT + 3600000 }],
};

const OPEN_REPORT = {
  shift_id: "s1", sede_id: "sede-01", status: "open", opened_at: OPENED_AT, closed_at: null,
  opened_by: "dueno@pizza.ec", closed_by: null, opening_float_cents: 2000,
  sales: [{ method: "cash", count: 12, total_cents: 18450 }, { method: "bendo", count: 3, total_cents: 4100 }],
  sales_total_cents: 22550,
  movements: { in_cents: 0, out_cents: 5000, items: [{ kind: "out", amount_cents: 5000, reason: "Depósito banco", staff_id: "dueno@pizza.ec", created_at: OPENED_AT + 3600000 }] },
  expected_cash_cents: 15450, counted_cash_cents: null, difference_cents: null,
  pending_payments: { count: 0, total_cents: 0 }, orders: { paid: 15, rejected: 1 }, note: "",
};

const CLOSED_REPORT = {
  ...OPEN_REPORT, status: "closed", closed_at: OPENED_AT + 8 * 3600000,
  closed_by: "dueno@pizza.ec", counted_cash_cents: 15400, difference_cents: -50, note: "Cierre del día",
};

const SHIFT_ROWS = [
  { id: "s1", sede_id: "sede-01", status: "closed", opened_at: OPENED_AT, closed_at: OPENED_AT + 8 * 3600000,
    opened_by: "dueno@pizza.ec", closed_by: "dueno@pizza.ec", opening_float_cents: 2000,
    expected_cash_cents: 15450, counted_cash_cents: 15400, difference_cents: -50, total_cents: 22550 },
  { id: "s2", sede_id: "sede-02", status: "open", opened_at: OPENED_AT, closed_at: null,
    opened_by: "cajero@pizza.ec", closed_by: null, opening_float_cents: 3000,
    expected_cash_cents: null, counted_cash_cents: null, difference_cents: null, total_cents: 0 },
];

function startPanel(options = {}) {
  const doc = new Document(), calls = [], events = [];
  const server = {
    current: options.current === undefined ? null : options.current,
    report: options.report || null,
    shifts: options.shifts || SHIFT_ROWS,
    turnosMissing: !!options.turnosMissing,
    payCashError: options.payCashError || null,
  };
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url), "https://pizza.craft-systems.com");
    const path = parsed.pathname + parsed.search;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, method, body, params: parsed.searchParams });
    if (path === "/panel/api/me") {
      return Response.json({ email: "dueno@pizza.ec", store: { store_name: "Pizza", currency: "USD" }, features: { loyalty: false } });
    }
    if (path === "/panel/api/catalog") return Response.json({ version: 1, categories: [], products: [], variant_groups: [] });
    if (path === "/panel/api/sedes") return Response.json({ sedes: SEDES });
    if (parsed.pathname === "/panel/api/orders") return Response.json({ orders: [], total: 0, pending: 0 });
    if (parsed.pathname === "/panel/api/pos/orders") {
      return Response.json({ orders: options.posOrders || [] });
    }
    if (parsed.pathname === "/panel/api/turnos/actual") {
      if (server.turnosMissing) return Response.json({ error: "ruta_no_encontrada" }, { status: 404 });
      return Response.json({ shift: server.current, report: server.report });
    }
    if (parsed.pathname === "/panel/api/turnos/abrir" && method === "POST") {
      server.current = { ...OPEN_SHIFT, opening_float_cents: body.opening_float_cents };
      server.report = OPEN_REPORT;
      events.push("abrir");
      return Response.json({ shift: server.current }, { status: 201 });
    }
    if (/^\/panel\/api\/turnos\/[^/]+\/movimientos$/.test(parsed.pathname) && method === "POST") {
      events.push("movimiento");
      return Response.json({ movement: { kind: body.kind, amount_cents: body.amount_cents, reason: body.reason } }, { status: 201 });
    }
    if (/^\/panel\/api\/turnos\/[^/]+\/cerrar$/.test(parsed.pathname) && method === "POST") {
      events.push("cerrar");
      server.current = null;
      server.report = null;
      return Response.json({ report: { ...CLOSED_REPORT, counted_cash_cents: body.counted_cash_cents, note: body.note || "" } });
    }
    if (/^\/panel\/api\/turnos\/[^/]+$/.test(parsed.pathname)) {
      events.push("detalle");
      return Response.json({ report: CLOSED_REPORT });
    }
    if (parsed.pathname === "/panel/api/turnos") return Response.json({ shifts: server.shifts });
    if (/^\/panel\/api\/orders\/[^/]+\/pay-cash$/.test(parsed.pathname) && method === "POST") {
      if (server.payCashError) return Response.json({ error: server.payCashError }, { status: 409 });
      return Response.json({ order: { id: parsed.pathname.split("/")[4], status: "paid" } });
    }
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
  const window = {
    __PANEL__: { slug: "pizza", host: "pizza.craft-systems.com" },
    scrollTo() {},
    confirm: () => true,
    open() {},
    setTimeout: () => 0,
    print: () => { events.push("print"); },
  };
  if (options.shiftTicket) window.__panelShiftTicket = options.shiftTicket;
  const location = { pathname: "/panel", host: "pizza.craft-systems.com", origin: "https://pizza.craft-systems.com", search: "" };
  new Function("window", "document", "fetch", "location", "confirm", "setTimeout", "clearTimeout", runtimeSource())(
    window, doc, fetch, location, () => true, () => 0, () => {},
  );
  return { doc, calls, events };
}

async function openTab(context, label) {
  const nav = find(context.doc.body, node => node.tagName === "button" && node.textContent === label && node.classList.contains("nav-link"));
  assert.ok(nav, "existe la entrada " + label);
  nav.trigger("click");
  await flush();
}

async function openOrders(options) {
  const context = startPanel(options);
  await flush();
  await openTab(context, "Pedidos");
  return context;
}

test("la barra de caja del panel abre el turno con fondo inicial en centavos", async () => {
  const { doc, calls, events } = await openOrders();
  assert.match(doc.body.textContent, /Caja · Centro/, "la barra usa la primera sede del panel");
  assert.match(doc.body.textContent, /Cerrada/);
  const [open] = button(doc.body, "Abrir caja");
  assert.ok(open, "existe el botón Abrir caja");
  open.trigger("click");
  await flush();
  const form = find(doc.body, node => node.classList.contains("cashform"));
  assert.ok(form, "abre el formulario de apertura");
  assert.match(form.textContent, /Fondo inicial/);
  byLabel(form, "Fondo inicial").value = "20";
  button(form, "Abrir caja")[0].trigger("click");
  await flush();
  const posted = calls.find(call => call.path === "/panel/api/turnos/abrir" && call.method === "POST");
  assert.ok(posted, "usa la ruta de apertura");
  assert.equal(posted.body.sede_id, "sede-01");
  assert.equal(posted.body.opening_float_cents, 2000, "el monto viaja en centavos enteros");
  assert.match(posted.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.deepEqual(events, ["abrir"]);
  assert.match(doc.body.textContent, /Caja abierta desde 10:30/, "hora de Ecuador");
  assert.match(doc.body.textContent, /Ingreso de efectivo/);
  assert.match(doc.body.textContent, /Cerrar caja/);
});

test("un turno abierto registra retiros con motivo y clave de idempotencia", async () => {
  const { doc, calls } = await openOrders({ current: OPEN_SHIFT, report: OPEN_REPORT });
  assert.match(doc.body.textContent, /Caja abierta desde 10:30/);
  button(doc.body, "Retiro de efectivo")[0].trigger("click");
  await flush();
  let form = find(doc.body, node => node.classList.contains("cashform"));
  assert.ok(form, "abre el formulario de retiro");
  byLabel(form, "Monto del retiro").value = "5";
  byLabel(form, "Motivo del movimiento").value = "ab";
  button(form, "Registrar retiro")[0].trigger("click");
  await flush();
  assert.equal(calls.filter(call => call.path === "/panel/api/turnos/s1/movimientos").length, 0, "el motivo corto no se envía");
  assert.match(form.textContent, /Escribe un motivo de 3 a 120 caracteres/);

  byLabel(form, "Motivo del movimiento").value = "Depósito banco";
  button(form, "Registrar retiro")[0].trigger("click");
  await flush();
  const posted = calls.find(call => call.path === "/panel/api/turnos/s1/movimientos" && call.method === "POST");
  assert.ok(posted);
  assert.equal(posted.body.kind, "out");
  assert.equal(posted.body.amount_cents, 500, "retiro de $5.00 en centavos");
  assert.equal(posted.body.reason, "Depósito banco");
  assert.match(posted.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.match(doc.getElementById("toast").textContent, /Retiro de \$5\.00 registrado/);
});

test("el cierre es ciego, guarda el contado y muestra la diferencia en rojo", async () => {
  const { doc, calls, events } = await openOrders({ current: OPEN_SHIFT, report: OPEN_REPORT });
  button(doc.body, "Cerrar caja")[0].trigger("click");
  await flush();
  const form = find(doc.body, node => node.classList.contains("cashform"));
  assert.ok(form, "abre el formulario de cierre");
  assert.match(form.textContent, /sin mirar el esperado/, "arqueo ciego");
  assert.equal(form.textContent.includes("$154.50"), false, "el esperado no se muestra antes de cerrar");
  byLabel(form, "Efectivo contado").value = "154.00";
  byLabel(form, "Nota del cierre").value = "Cierre del día";
  button(form, "Cerrar caja")[0].trigger("click");
  await flush();
  const posted = calls.find(call => call.path === "/panel/api/turnos/s1/cerrar" && call.method === "POST");
  assert.ok(posted, "usa la ruta de cierre");
  assert.equal(posted.body.counted_cash_cents, 15400);
  assert.equal(posted.body.note, "Cierre del día");
  assert.match(posted.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.deepEqual(events, ["cerrar"]);
  assert.match(doc.body.textContent, /Faltante/);
  const red = find(doc.body, node => node.classList.contains("money-negative"));
  assert.ok(red, "la diferencia negativa va marcada");
  assert.match(red.textContent, /\$-0\.50/);
  assert.match(doc.getElementById("toast").textContent, /Diferencia: \$-0\.50 \(faltante\)/);
});

test("reimprimir el cierre usa el ticket térmico si la rama lo expone y si no el HTML simple", async () => {
  const plain = await openOrders({ current: OPEN_SHIFT, report: OPEN_REPORT });
  button(plain.doc.body, "Cerrar caja")[0].trigger("click");
  await flush();
  let form = find(plain.doc.body, node => node.classList.contains("cashform"));
  byLabel(form, "Efectivo contado").value = "154.00";
  button(form, "Cerrar caja")[0].trigger("click");
  await flush();
  button(plain.doc.body, "Reimprimir cierre")[0].trigger("click");
  await flush();
  assert.ok(plain.events.includes("print"), "abre el diálogo de impresión");
  const sheet = find(plain.doc.body, node => node.classList.contains("print-sheet"));
  assert.ok(sheet, "sin shiftTicketLines imprime el reporte en HTML simple");
  assert.match(sheet.textContent, /CIERRE DE CAJA · Centro/);
  assert.match(sheet.textContent, /Diferencia/);
  assert.match(sheet.textContent, /\$-0\.50/);
  assert.match(sheet.textContent, /Depósito banco/);

  const thermal = await openOrders({
    current: OPEN_SHIFT, report: OPEN_REPORT,
    shiftTicket: (report, opts) => ["CIERRE " + report.shift_id, "SEDE " + opts.sedeName, "DIFF " + report.difference_cents],
  });
  button(thermal.doc.body, "Cerrar caja")[0].trigger("click");
  await flush();
  form = find(thermal.doc.body, node => node.classList.contains("cashform"));
  byLabel(form, "Efectivo contado").value = "154.00";
  button(form, "Cerrar caja")[0].trigger("click");
  await flush();
  button(thermal.doc.body, "Reimprimir cierre")[0].trigger("click");
  await flush();
  const pre = find(thermal.doc.body, node => node.classList.contains("print-ticket"));
  assert.ok(pre, "usa las líneas de shiftTicketLines");
  assert.match(pre.textContent, /CIERRE s1/);
  assert.match(pre.textContent, /SEDE Centro/);
  assert.equal(find(thermal.doc.body, node => node.classList.contains("print-sheet")), null);
});

test("Cierres de caja filtra por fecha y sede, y marca la diferencia faltante en rojo", async () => {
  const context = startPanel();
  const { doc, calls } = context;
  await flush();
  await openTab(context, "Cierres de caja");
  const list = calls.find(call => call.path.startsWith("/panel/api/turnos?"));
  assert.ok(list, "consulta el historial de turnos");
  assert.match(list.path, /from=\d{4}-\d{2}-\d{2}/);
  assert.match(list.path, /to=\d{4}-\d{2}-\d{2}/);
  assert.match(list.path, /limit=50/);
  assert.equal(list.path.includes("sede_id="), false, "sin sede: todas");

  assert.match(doc.body.textContent, /Centro/);
  assert.match(doc.body.textContent, /Norte/);
  assert.match(doc.body.textContent, /Abierta/);
  assert.match(doc.body.textContent, /Cerrada/);
  assert.match(doc.body.textContent, /\$154\.50/);
  assert.match(doc.body.textContent, /\$225\.50/);
  const rows = findAll(doc.body, node => node.classList.contains("shift-row"));
  assert.equal(rows.length, 2);
  const redCells = findAll(doc.body, node => node.classList.contains("money-negative"));
  assert.equal(redCells.length, 1, "solo la diferencia faltante va en rojo");
  assert.match(redCells[0].textContent, /\$-0\.50/);
  const missing = rows.find(row => row.textContent.includes("Centro"));
  assert.ok(find(missing, node => node.classList.contains("money-negative")), "el faltante está en la fila del turno cerrado");
  const clean = rows.find(row => row.textContent.includes("Norte"));
  assert.equal(find(clean, node => node.classList.contains("money-negative")), null, "un turno abierto no inventa diferencia");

  const sede = find(doc.body, node => node.tagName === "select" && node.getAttribute("aria-label") === "Sede");
  sede.value = "sede-02";
  button(doc.body, "Consultar")[0].trigger("click");
  await flush();
  const filtered = calls.filter(call => call.path.startsWith("/panel/api/turnos?")).pop();
  assert.match(filtered.path, /sede_id=sede-02/);
});

test("el detalle del cierre muestra el reporte y las ventas por método", async () => {
  const context = startPanel();
  const { doc, calls, events } = context;
  await flush();
  await openTab(context, "Cierres de caja");
  const rows = findAll(doc.body, node => node.classList.contains("shift-row"));
  button(rows[0], "Detalle")[0].trigger("click");
  await flush();
  assert.ok(calls.some(call => call.path === "/panel/api/turnos/s1"), "pide el reporte del turno");
  assert.match(doc.body.textContent, /Cierre de caja · Centro/);
  assert.match(doc.body.textContent, /Ventas por método/);
  assert.match(doc.body.textContent, /efectivo/);
  assert.match(doc.body.textContent, /tarjeta \(Bendo\)/);
  assert.match(doc.body.textContent, /Faltante/);
  assert.match(doc.body.textContent, /\$-0\.50/);
  assert.match(doc.body.textContent, /Depósito banco/);
  assert.deepEqual(events, ["detalle"]);
  button(doc.body, "Reimprimir cierre")[0].trigger("click");
  await flush();
  assert.ok(events.includes("print"));
});

test("cobrar con la caja cerrada explica que hay que abrirla", async () => {
  const { doc, calls } = await openOrders({
    payCashError: "caja_cerrada",
    posOrders: [{ id: "o2", number: 41, status: "confirmed", source: "caja", sede_id: "sede-01", total_cents: 225,
      currency: "USD", created_at: 0, customer_name: "Luis", payment_method: "cash",
      items: [{ name: "Jugo natural", qty: 1, unit_cents: 225 }] }],
  });
  const cash = button(doc.body, "Cobrar efectivo")[0];
  assert.ok(cash, "la orden confirmada ofrece cobro en efectivo");
  cash.trigger("click");
  await flush();
  assert.ok(calls.some(call => call.path === "/panel/api/orders/o2/pay-cash" && call.method === "POST"));
  assert.match(doc.getElementById("toast").textContent, /Abre la caja de esta sede para cobrar\./);
});

test("si la API de turnos aún no existe, la barra lo dice sin inventar estado", async () => {
  const { doc } = await openOrders({ turnosMissing: true });
  assert.match(doc.body.textContent, /todavía no incluye turnos de caja/);
  assert.equal(doc.body.textContent.includes("Caja abierta desde"), false);
  assert.equal(button(doc.body, "Abrir caja").length, 0, "sin API no ofrece acciones a ciegas");
});
