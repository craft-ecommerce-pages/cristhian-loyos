// MS2: comandas de cocina y página móvil del mesero.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { renderMeseroPage } from "../src/mesero.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };
const order = {
  id: "pedido-abcdef",
  number: 23,
  created_at: Date.UTC(2026, 0, 2, 5, 6),
  delivery_mode: "mesa",
  table_no: "4",
  client_name: "Ana",
  note: "Sin cebolla",
  print_count: 2,
  total: 99.99,
  currency: "USD",
  items: [
    {
      nombre: "Lomo saltado extraordinariamente largo",
      qty: 2,
      precio: 12.5,
      variant: "Grande · Nota: muy picante",
    },
  ],
};

function everyLineFits(lines, width) {
  assert.ok(lines.length > 3);
  assert.ok(
    lines.every((line) => Array.from(line).length <= width),
    JSON.stringify(lines),
  );
}

test("ticketLines compone una comanda sin precios y respeta 32 columnas", () => {
  const lines = ticketLines(order, {
    store: "Restaurante de nombre muy largo",
    width: 32,
    now: order.created_at,
  });
  everyLineFits(lines, 32);
  const joined = lines.join("\n");
  assert.match(joined, /COMANDA #023/);
  assert.match(joined, /Mesa 4/);
  assert.match(joined, /2026-01-02 00:06 EC/);
  assert.match(joined, /COPIA 2/);
  assert.match(joined, /2 x Lomo saltado/);
  assert.match(joined, /Nota: Sin cebolla/);
  assert.match(joined, /Cliente: Ana/);
  assert.equal(joined.includes("12.5"), false);
  assert.equal(joined.includes("99.99"), false);
  assert.equal(joined.includes("USD"), false);
});

test("ticketLines cubre 48 columnas, palabras largas, modos y el id corto", () => {
  const long = "supercalifragilistico".repeat(5);
  const base = {
    ...order,
    number: null,
    id: "pedido-z9xy",
    items: [{ nombre: long, qty: 1, precio: 2 }],
  };
  const lines = ticketLines(base, {
    store: long,
    width: 48,
    now: order.created_at,
  });
  everyLineFits(lines, 48);
  assert.match(lines.join("\n"), /COMANDA #z9xy/);
  assert.match(
    ticketLines({ ...base, delivery_mode: "pickup" }, { width: 48 }).join("\n"),
    /Para llevar/,
  );
  assert.match(
    ticketLines({ ...base, delivery_mode: "delivery" }, { width: 48 }).join(
      "\n",
    ),
    /Domicilio/,
  );
});

test("el papel de 58/80 mm usa 32/48 columnas", () => {
  assert.equal(ticketColumns(58), 32);
  assert.equal(ticketColumns("58"), 32);
  assert.equal(ticketColumns(80), 48);
  assert.equal(ticketColumns("otro"), 48);
  assert.equal(ticketPageHeight(0), 50);
  assert.equal(ticketPageHeight(20), 84);
  assert.equal(ticketPageHeight(-1), 50);
});

test("la página del mesero tiene shim, escape, marcadores y no sondea", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "<b>Pizzería</b>" } });
  const html = await renderMeseroPage(
    new Request("https://pizza.craft-systems.com/panel/mesero"),
    env,
    site,
  );
  assert.ok(html.indexOf("var __name=") < html.indexOf("meseroMain"));
  assert.equal(html.includes("setInterval"), false);
  assert.equal(html.includes("<b>Pizzería</b>"), false);
  assert.match(html, /&lt;b&gt;Pizzería&lt;\/b&gt;/);
  for (const marker of [
    "Pedidos",
    "Nuevo pedido",
    "Actualizar",
    "visibilitychange",
    "Reimprimir",
    "Quitar",
    "@page",
    "58",
    "80",
  ]) {
    assert.ok(html.includes(marker), marker);
  }
  assert.equal(html.includes("innerHTML"), false);
});

function runtimeFrom(html, request = () => new Promise(() => {})) {
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  const listeners = new Map();
  const node = (tag = "div") => {
    const value = {
      tagName: tag,
      nodeType: tag === "#text" ? 3 : 1,
      children: [],
      _text: "",
      classList: { add() {}, remove() {}, toggle() {} },
      append(...kids) { kids.forEach(kid => this.appendChild(kid)); },
      appendChild(kid) { this.children.push(kid); return kid; },
      replaceChildren(...kids) { this.children = []; this._text = ""; this.append(...kids); },
      attrs: {},
      on: {},
      addEventListener(type, listener) {
        listeners.set(type, listener);
        this.on[type] = listener;
      },
      setAttribute(name, val) { this.attrs[name] = val; },
      focus() {},
      remove() {},
    };
    Object.defineProperty(value, "textContent", {
      get() { return value._text + value.children.map(child => child.textContent || "").join(""); },
      set(text) { value._text = String(text); value.children = []; },
    });
    return value;
  };
  const root = node("main");
  const document = {
    visibilityState: "hidden",
    body: node("body"),
    createElement: tag => node(tag),
    createTextNode: text => {
      const child = node("#text");
      child.textContent = text;
      return child;
    },
    getElementById: (id) => (id === "mesero" ? root : node()),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    querySelectorAll: () => [],
  };
  const window = { __MESERO__: {}, setTimeout() {}, addEventListener() {} };
  window.window = window;
  window.__testRoot = root;
  vm.runInNewContext(match[1], {
    window,
    document,
    fetch: request,
    console,
    Promise,
    Intl,
    Date,
  });
  return window;
}

async function flushRuntime() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

test("runtime serializado arma ítems y exige exactamente el mínimo/máximo de variantes", async () => {
  const env = makeEnv();
  const html = await renderMeseroPage(
    new Request("https://pizza.craft-systems.com/panel/mesero"),
    env,
    site,
  );
  const window = runtimeFrom(html);
  const product = {
    name: "Pizza",
    price: "10",
    __groups: [
      {
        type: "price_select",
        optional: false,
        options: [
          { name: "Mediana", price: 12 },
          { name: "Grande", price: 14 },
        ],
      },
      {
        type: "distribute",
        pick: 2,
        options: ["Jamón", "Champiñón", "Aceituna"],
      },
    ],
  };
  const item = window.__meseroBuildItem(
    product,
    { 0: "Grande", 1: ["Jamón", "Aceituna"] },
    "sin cebolla",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(item)), {
    nombre: "Pizza",
    qty: 1,
    precio: 14,
    variant: "Grande · Jamón · Aceituna · Nota: sin cebolla",
  });
  assert.equal(
    window.__meseroChoicesOK(product.__groups, { 0: "Grande", 1: ["Jamón"] }),
    false,
  );
  assert.equal(
    window.__meseroChoicesOK(product.__groups, {
      0: "Grande",
      1: ["Jamón", "Aceituna"],
    }),
    true,
  );
  assert.equal(
    window.__meseroChoicesOK(product.__groups, {
      0: "Grande",
      1: ["Jamón", "Aceituna", "Champiñón"],
    }),
    false,
  );
});

test("una sesión vencida durante la carga conserva la pantalla de PIN", async () => {
  const env = makeEnv();
  const html = await renderMeseroPage(
    new Request("https://pizza.craft-systems.com/panel/mesero"),
    env,
    site,
  );
  const window = runtimeFrom(html, async url => {
    if (String(url).endsWith("/me")) {
      return Response.json({ staff: { id: "staff-1", name: "Ana" }, store: {} });
    }
    if (String(url).endsWith("/catalog")) {
      return Response.json({ error: "sin_sesion" }, { status: 401 });
    }
    return Response.json({ orders: [] });
  });
  await flushRuntime();
  assert.match(window.__testRoot.textContent, /Tu sesión venció/);
  assert.doesNotMatch(window.__testRoot.textContent, /^AnaPedidos/);
});

const walk = (node, out = []) => { out.push(node); (node.children || []).forEach(kid => walk(kid, out)); return out; };

test("tarjetas muestran mesa + nombre, hora y total; el constructor bloquea agotados", async () => {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request("https://pizza.craft-systems.com/panel/mesero"), env, site);
  const order = (extra) => ({ id: "x", status: "pending", items: [], total: 18.5, created_at: 0, ...extra });
  const window = runtimeFrom(html, async url => {
    if (String(url).endsWith("/me")) return Response.json({ staff: { id: "owner", name: "Dueño" }, store: { currency: "USD" } });
    if (String(url).endsWith("/catalog")) {
      return Response.json({ categories: [], variant_groups: [], products: [
        { id: "a", name: "Pizza", price: "10", active: true, catalog_visible: true, stock: null },
        { id: "b", name: "Lasaña", price: "9", active: true, catalog_visible: true, stock: 0 },
      ] });
    }
    return Response.json({ orders: [
      order({ number: 1, table_no: "4", client_name: "Andrea" }),
      order({ number: 2, table_no: "7", client_name: "Mesa 7", source: "mesero" }),
      order({ number: 3, client_name: "Luis" }),
    ], total: 3, pending: 3 });
  });
  await flushRuntime();
  const text = window.__testRoot.textContent;
  assert.match(text, /Mesa 4 · Andrea/);
  assert.doesNotMatch(text, /Mesa 7 · Mesa 7/);
  assert.match(text, /18[.,]50/);
  const tab = walk(window.__testRoot).find(n => n.tagName === "button" && n.textContent === "Nuevo pedido");
  tab.on.click();
  await flushRuntime();
  const products = walk(window.__testRoot).filter(n => n.attrs?.class === undefined && n.className === "catalog-product");
  const soldOut = products.find(n => n.textContent.startsWith("Lasaña"));
  assert.match(soldOut.textContent, /Agotado/);
  assert.equal("disabled" in soldOut.attrs, true);
  assert.equal("disabled" in products.find(n => n.textContent.startsWith("Pizza")).attrs, false);
});

test("ticketLines sangra variantes y notas de cada ítem", async () => {
  const { ticketLines } = await import("../../shared/ticket.js");
  const lines = ticketLines({ id: "x", number: 1, delivery_mode: "mesa", table_no: "4", created_at: 0,
    items: [{ nombre: "Combo", qty: 2, variant: "Salsas: BBQ · Nota: sin cebolla y sin tomate por favor" }] }, { width: 32 });
  const at = lines.indexOf("2 x Combo");
  assert.ok(at >= 0);
  assert.match(lines[at + 1], /^ {2}Salsas: BBQ/);
  assert.match(lines[at + 2], /^ {2}\S/);
  assert.ok(lines.every(line => Array.from(line).length <= 32));
});
