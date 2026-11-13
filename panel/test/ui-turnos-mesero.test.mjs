// Modo mesero: barra de caja, apertura, movimientos, cierre ciego y ticket Z.
import test from "node:test";
import assert from "node:assert/strict";
import { renderMeseroPage } from "../src/mesero.js";
import { shiftTicketLines, ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { makeEnv } from "./helpers.mjs";

const URL_BASE = "https://pizza.craft-systems.com";
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
    this.contentWindow = null;
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
      if (!node.nodeType) node = new Node("#text", String(node));
      node.parentNode = this;
      this.children.push(node);
    });
  }
  replaceChildren(...nodes) { this._text = ""; this.children = []; this.append(...nodes); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(name, listener) { const list = this.listeners.get(name) || []; list.push(listener); this.listeners.set(name, list); }
  trigger(name, extra = {}) {
    const event = { preventDefault() {}, currentTarget: this, target: this, ...extra };
    (this.listeners.get(name) || []).forEach(listener => listener(event));
  }
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
const byText = (node, tag, text) => find(node, n => n.tagName === tag && n.textContent === text);
const byLabel = (node, label) => find(node, n => n.getAttribute("aria-label") === label);

async function flush() {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 12; i++) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
}

const catalog = { products: [], categories: [], variant_groups: [] };
const confirmedOrder = {
  id: "orden-confirmada", number: 31, status: "confirmed", source: "caja", sede_id: "centro",
  created_at: Date.UTC(2026, 10, 13, 13, 0), total_cents: 11000, currency: "USD",
  payment_method: "cash", items: [{ name: "Pizza", qty: 1, unit_cents: 11000 }],
};
const openShift = {
  id: "turno-1", sede_id: "centro", status: "open",
  opened_by: "dueno", opened_at: Date.UTC(2026, 10, 13, 13, 0),
  opening_float_cents: 2000, movements: [],
};

async function startMesero({ orders = [], serverShift = null, fetchImpl } = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request(`${URL_BASE}/panel/mesero`), env, site);
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  const root = new Node("main");
  const toastEl = new Node("div");
  const body = new Node("body");
  let blobSeq = 0;
  const blobs = new Map();
  const doc = {
    visibilityState: "visible",
    body,
    createElement: tag => new Node(tag),
    createTextNode: text => new Node("#text", String(text)),
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
        catalog,
        orders,
      },
    },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++blobSeq).padStart(12, "0")}` },
    __meseroTicket: ticketLines,
    __meseroColumns: ticketColumns,
    __meseroHeight: ticketPageHeight,
    __meseroShiftTicket: shiftTicketLines,
    setTimeout() { return 0; },
    addEventListener() {},
    scrollTo() {},
  };
  const localStorage = { getItem: () => "centro", setItem() {}, removeItem() {} };
  const location = { pathname: "/panel/mesero", search: "" };
  const calls = [];
  const state = { shift: serverShift ? { ...serverShift } : null, report: null };
  const route = fetchImpl || (async call => {
    if (call.path === "/panel/api/turnos/actual") return Response.json({ shift: state.shift });
    return Response.json({ error: "sin_mock" }, { status: 500 });
  });
  const fetchMock = async (url, init = {}) => {
    const parsed = new URL(String(url), URL_BASE);
    const call = {
      url: String(url),
      path: parsed.pathname,
      search: parsed.search,
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return route(call);
  };
  const URLMock = {
    createObjectURL(blob) { const url = `blob:test-${++blobSeq}`; blobs.set(url, blob.parts.join("")); return url; },
    revokeObjectURL() {},
  };
  class BlobMock { constructor(parts) { this.parts = parts; } }
  new Function(
    "window", "document", "fetch", "localStorage", "location", "confirm",
    "setTimeout", "clearTimeout", "URL", "Blob",
    match[1],
  )(
    window, doc, fetchMock, localStorage, location, () => true, () => 0, () => {},
    URLMock, BlobMock,
  );
  await flush();
  return { root, doc, toast: toastEl, calls, state, blobs };
}

// Respuestas que imitan el contrato de panel/src/turnos.js (parte D).
function shiftRoute(state, { report = null } = {}) {
  return async call => {
    const withReport = extra => report
      ? { ...extra, report: { ...report, ...extra.shift } }
      : extra;
    if (call.path === "/panel/api/turnos/actual")
      return Response.json(withReport({ shift: state.shift }));
    if (call.path === "/panel/api/turnos/abrir") {
      assert.equal(call.method, "POST");
      state.shift = {
        ...openShift,
        opening_float_cents: call.body.opening_float_cents,
        movements: [],
      };
      return Response.json({ shift: state.shift }, { status: 201 });
    }
    if (/\/movimientos$/.test(call.path)) {
      const movement = {
        id: "mov-" + (state.shift.movements.length + 1),
        kind: call.body.kind, amount_cents: call.body.amount_cents,
        reason: call.body.reason, staff_id: "dueno", created_at: Date.now(),
      };
      state.shift.movements.push(movement);
      return Response.json({ movement }, { status: 201 });
    }
    if (/\/cerrar$/.test(call.path)) {
      const counted = call.body.counted_cash_cents;
      state.report = {
        shift_id: state.shift.id, sede_id: "centro", status: "closed",
        opened_at: state.shift.opened_at, closed_at: Date.now(),
        opened_by: "dueno", closed_by: "dueno",
        opening_float_cents: state.shift.opening_float_cents,
        sales: [{ method: "cash", count: 1, total_cents: 11000 }],
        sales_total_cents: 11000,
        movements: {
          in_cents: 0, out_cents: 5000,
          items: state.shift.movements.map(item => ({
            kind: item.kind, amount_cents: item.amount_cents,
            reason: item.reason, staff_id: "dueno", created_at: item.created_at,
          })),
        },
        expected_cash_cents: 8000, counted_cash_cents: counted,
        difference_cents: counted - 8000,
        pending_payments: { count: 0, total_cents: 0 },
        orders: { paid: 1, rejected: 0 },
        note: call.body.note || "",
      };
      state.shift = null;
      return Response.json({ report: state.report });
    }
    if (call.path === "/panel/api/turnos/turno-1") {
      return Response.json({ report: state.report });
    }
    return Response.json({ error: "sin_mock" }, { status: 500 });
  };
}

test("caja cerrada: abre con fondo en centavos y etiquetas accesibles", async () => {
  const { root, doc, calls } = await startMesero({
    orders: [confirmedOrder],
    fetchImpl: shiftRoute({ shift: null }),
  });
  assert.match(root.textContent, /Caja cerrada/);
  assert.match(root.textContent, /Abre la caja antes de cobrar/);
  const openButton = byText(root, "button", "Abrir caja");
  assert.ok(openButton, "botón Abrir caja visible");
  openButton.trigger("click");
  await flush();
  const input = byLabel(doc.body, "Fondo inicial en dólares");
  assert.ok(input, "campo con etiqueta accesible");
  assert.ok(byText(doc.body, "button", "Cancelar"));
  input.value = "20";
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const open = calls.find(call => call.path === "/panel/api/turnos/abrir");
  assert.ok(open, "llamó a abrir");
  assert.equal(open.body.sede_id, "centro");
  assert.equal(open.body.opening_float_cents, 2000, "20 dólares son 2000 centavos");
  assert.match(open.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.match(root.textContent, /Caja abierta desde/);
  assert.match(root.textContent, /Ingreso de efectivo/);
  assert.match(root.textContent, /Retiro de efectivo/);
  assert.match(root.textContent, /Cerrar caja/);
});

test("arqueo ciego: movimientos y cierre con denominaciones sin ver el esperado", async () => {
  const { root, doc, calls, blobs, toast } = await startMesero({
    orders: [confirmedOrder],
    // El dueño recibe report en vivo; el cajero no debe pintarlo antes de cerrar.
    fetchImpl: shiftRoute(
      { shift: { ...openShift } },
      { report: { sales_total_cents: 11000, expected_cash_cents: 8000, difference_cents: -50 } },
    ),
  });
  assert.match(root.textContent, /Caja abierta desde/);
  for (const hidden of ["Efectivo esperado", "Efectivo contado", "Diferencia", "$80.00"]) {
    assert.equal(root.textContent.includes(hidden), false, `no muestra ${hidden} antes de cerrar`);
  }

  byText(root, "button", "Retiro de efectivo").trigger("click");
  await flush();
  assert.ok(byText(doc.body, "button", "Cancelar"), "el movimiento es un modal");
  const amount = byLabel(doc.body, "Monto en dólares");
  const reason = byLabel(doc.body, "Motivo del movimiento");
  assert.ok(amount && reason, "monto y motivo con etiquetas");
  amount.value = "50";
  reason.value = "Depósito banco";
  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const movement = calls.find(call => /\/movimientos$/.test(call.path));
  assert.ok(movement, "llamó al movimiento");
  assert.deepEqual(
    { kind: movement.body.kind, amount_cents: movement.body.amount_cents, reason: movement.body.reason },
    { kind: "out", amount_cents: 5000, reason: "Depósito banco" },
  );
  assert.match(movement.body.idempotency_key, /^[A-Za-z0-9_.:-]{8,100}$/);
  assert.match(root.textContent, /Retiro · Depósito banco/);
  assert.match(root.textContent, /−\$50\.00/);

  byText(root, "button", "Cerrar caja").trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Contar por denominaciones \(opcional\)/);
  for (const hidden of ["Efectivo esperado", "Diferencia", "$80.00"]) {
    assert.equal(doc.body.textContent.includes(hidden), false, `el cierre no revela ${hidden}`);
  }
  const count = (label, value) => {
    const input = byLabel(doc.body, `${label}: cantidad`);
    assert.ok(input, label);
    input.value = String(value);
    input.trigger("input");
  };
  count("Billetes de $10", 7);
  count("Billetes de $5", 1);
  count("Billetes de $1", 4);
  count("Monedas de 50 ¢", 1);
  const counted = byLabel(doc.body, "Efectivo contado en dólares");
  assert.equal(counted.value, "79.50", "7×10 + 5 + 4×1 + 0.50 = 79.50 exactos");

  find(doc.body, node => node.tagName === "form").trigger("submit");
  await flush();
  const close = calls.find(call => /\/cerrar$/.test(call.path));
  assert.ok(close, "llamó al cierre");
  assert.equal(close.body.counted_cash_cents, 7950, "el conteo suma en centavos");
  assert.match(root.textContent, /Cierre de caja/);
  assert.match(root.textContent, /Caja cerrada/);
  assert.match(root.textContent, /Efectivo esperado\s*\$80\.00/);
  assert.match(root.textContent, /Efectivo contado\s*\$79\.50/);
  assert.match(root.textContent, /Diferencia\s*-\$0\.50/);
  assert.match(root.textContent, /Faltante de caja: \$0\.50/);
  assert.match(root.textContent, /Imprimir cierre/);
  assert.doesNotMatch(root.textContent, /80\.5(?!\d)|79\.500000|0\.4999999/);

  byText(root, "button", "Imprimir cierre").trigger("click");
  await flush();
  const iframe = find(doc.body, node => node.tagName === "iframe");
  assert.ok(iframe, "abrió el iframe de impresión");
  let printed = "";
  iframe.contentWindow = { focus() {}, print() { printed = blobs.get(iframe.src) || ""; } };
  iframe.trigger("load");
  await flush();
  assert.match(printed, /TICKET Z/);
  assert.match(printed, /Sede: Centro/);
  assert.match(printed, /Efectivo esperado/);
  assert.match(printed, /-\$0\.50/);
  assert.match(toast.textContent, /Se abrió la impresión del cierre/);
});

test("un cierre fallido se reintenta con la misma clave idempotente", async () => {
  let attempts = 0;
  const base = shiftRoute({ shift: { ...openShift } });
  const { root, doc, calls } = await startMesero({
    fetchImpl: async call => {
      if (/\/cerrar$/.test(call.path)) {
        attempts += 1;
        if (attempts === 1) return Response.json({ error: "error_interno" }, { status: 500 });
      }
      return base(call);
    },
  });
  byText(root, "button", "Cerrar caja").trigger("click");
  await flush();
  byLabel(doc.body, "Efectivo contado en dólares").value = "80.00";
  const form = find(doc.body, node => node.tagName === "form");
  form.trigger("submit");
  await flush();
  assert.match(doc.body.textContent, /No pudimos cerrar la caja/);
  assert.equal(attempts, 1);
  form.trigger("submit");
  await flush();
  assert.equal(attempts, 2);
  const keys = calls.filter(call => /\/cerrar$/.test(call.path)).map(call => call.body.idempotency_key);
  assert.equal(new Set(keys).size, 1, "el reintento reutiliza la clave");
  assert.match(root.textContent, /Cierre de caja/);
});

test("cobrar con la caja cerrada explica que hay que abrirla", async () => {
  const base = shiftRoute({ shift: null });
  const { root, toast, calls } = await startMesero({
    orders: [confirmedOrder],
    fetchImpl: async call => {
      if (/\/pay-cash$/.test(call.path))
        return Response.json({ error: "caja_cerrada" }, { status: 409 });
      return base(call);
    },
  });
  const pay = byText(root, "button", "Cobrar efectivo");
  assert.ok(pay, "el cobro manual está disponible");
  pay.trigger("click");
  await flush();
  assert.equal(toast.textContent, "Abre la caja de esta sede para cobrar.");
  assert.ok(calls.some(call => /\/pay-cash$/.test(call.path)));
  assert.ok(calls.filter(call => call.path === "/panel/api/turnos/actual").length >= 2,
    "refresca el estado de caja tras el 409");
});

test("el HTML del mesero serializa el ticket Z y su barra de caja", async () => {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request(`${URL_BASE}/panel/mesero`), env, site);
  for (const marker of [
    'id="meseroShiftTicket"',
    "window.__meseroShiftTicket",
    "shift-actions",
    "denom-row",
    "Contar por denominaciones",
    "Abre la caja de esta sede para cobrar.",
  ]) assert.ok(html.includes(marker), marker);
  assert.match(html, /<meta name="viewport"/, "sigue siendo usable en celular");
});
