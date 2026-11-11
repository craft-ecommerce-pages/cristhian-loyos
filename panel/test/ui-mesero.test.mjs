// Modo mesero: tarjetas con foto y flujo cobro-antes-de-cocina.
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
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
}

const catalog = {
  products: [
    { id: "p1", name: "Pizza margarita", price: "9.50", active: true, catalog_visible: true,
      categories: ["pizzas"], images: ["https://cdn.example.com/pizza.jpg"] },
    { id: "p2", name: "Jugo natural", precio: "2.25", active: true, catalog_visible: true, categories: ["bebidas"] },
  ],
  categories: [{ slug: "pizzas", name: "Pizzas" }, { slug: "bebidas", name: "Bebidas" }],
  variant_groups: [],
};

const confirmedOrder = {
  id: "orden-confirmada", number: 31, status: "confirmed", source: "caja", sede_id: "centro",
  created_at: Date.now(), total_cents: 950, currency: "USD", customer_name: "Ana",
  items: [{ name: "Pizza margarita", qty: 1, unit_cents: 950 }],
};

async function startMesero({ orders = [] } = {}) {
  const env = makeEnv();
  const html = await renderMeseroPage(new Request("https://pizza.craft-systems.com/panel/mesero"), env, site);
  const match = /<script id="meseroMain">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(match, "runtime serializado");
  const root = new Node("main"), toast = new Node("div");
  const doc = {
    visibilityState: "visible",
    body: new Node("body"),
    createElement: tag => new Node(tag),
    createTextNode: text => new Node("#text", String(text)),
    getElementById: id => id === "mesero" ? root : toast,
    addEventListener() {},
    querySelectorAll: () => [],
  };
  const window = {
    __MESERO__: {
      store: "Pizza",
      boot: {
        me: { staff: { id: "dueno", name: "Dueño" }, owner: true, store: { name: "Pizza", currency: "$" }, sedes: [{ id: "centro", nombre: "Centro" }] },
        catalog,
        orders,
      },
    },
    __meseroTicket: ticketLines,
    __meseroColumns: ticketColumns,
    __meseroHeight: ticketPageHeight,
    setTimeout() { return 0; },
    addEventListener() {},
    scrollTo() {},
  };
  const localStorage = { getItem: () => "centro", setItem() {}, removeItem() {} };
  const location = { pathname: "/panel/mesero", search: "" };
  new Function("window", "document", "fetch", "localStorage", "location", "confirm", "setTimeout", "clearTimeout", match[1])(
    window, doc, async () => Response.json({ error: "sin_mock" }, { status: 500 }),
    localStorage, location, () => true, () => 0, () => {},
  );
  await flush();
  return { root, doc, toast };
}

test("el HTML del mesero incluye media, fallback, aria-label y el aviso de cobro", async () => {
  const html = await renderMeseroPage(new Request("https://pizza.craft-systems.com/panel/mesero"), makeEnv(), site);
  for (const marker of ["catalog-product", "catalog-media", "media-fallback", "Sin foto",
    "Confirmado · falta cobro", "Reimprimir", "Acuse de impresión"]) {
    assert.ok(html.includes(marker), marker);
  }
  assert.match(html, /alt:\s*""/, "la foto es decorativa");
  assert.match(html, /"aria-label":/, "las tarjetas anuncian nombre y precio");
});

test("Pedidos muestra la comanda confirmada sin botón de impresión antes de cobrar", async () => {
  const { root } = await startMesero({ orders: [confirmedOrder] });
  assert.match(root.textContent, /Confirmado · falta cobro/);
  assert.match(root.textContent, /Cobrar efectivo/);
  assert.equal(root.textContent.includes("Imprimir"), false, "no se imprime una orden sin pagar");
});

test("una transferencia confirmada y un pedido listo muestran sus acciones honestas", async () => {
  const transfer = {
    ...confirmedOrder, id: "orden-transfer", number: 32, payment_method: "transfer",
  };
  const ready = {
    ...confirmedOrder, id: "orden-lista", number: 33, status: "ready", client_name: "Andrea",
    customer_phone: "0991234567", print_count: 0,
  };
  const { root } = await startMesero({ orders: [transfer, ready] });
  assert.match(root.textContent, /Confirmar transferencia/);
  assert.match(root.textContent, /Listo para avisar/);
  assert.match(root.textContent, /La app no envía mensajes solo|no envía mensajes/);
  const link = find(root, node => node.tagName === "a" && node.textContent === "Avisar por WhatsApp");
  assert.ok(link, "el aviso listo es un enlace manual");
  const href = link.getAttribute("href");
  assert.match(href, /^https:\/\/wa\.me\/0991234567\?text=/);
  const message = decodeURIComponent(href.split("?text=")[1]);
  assert.match(message, /pedido #33/);
  assert.match(message, /Centro/);
  assert.doesNotMatch(message, /RUC|cédula|cedula|correo|dirección|direccion/i);
});

test("Nuevo pedido pinta tarjetas con imagen y fallback, y agrega al carrito", async () => {
  const { root, doc, toast } = await startMesero();
  const nav = find(root, node => node.tagName === "button" && node.textContent === "Nuevo pedido");
  assert.ok(nav);
  nav.trigger("click");
  await flush();
  const cards = findAll(root, node => node.tagName === "button" && node.classList.contains("catalog-product"));
  assert.equal(cards.length, 2);
  const pizza = cards.find(card => card.textContent.includes("Pizza margarita"));
  const juice = cards.find(card => card.textContent.includes("Jugo natural"));
  assert.ok(pizza && juice);
  assert.match(pizza.getAttribute("aria-label"), /Agregar Pizza margarita, \$9\.50/);
  const img = find(pizza, node => node.tagName === "img");
  assert.ok(img, "la tarjeta con foto muestra imagen");
  assert.equal(img.getAttribute("alt"), "", "la foto es decorativa");
  assert.ok(find(juice, node => node.classList.contains("media-fallback")), "sin foto usa el marcador");
  assert.equal(find(juice, node => node.tagName === "img"), null);

  juice.trigger("click");
  await flush();
  assert.match(toast.textContent, /\+1 Jugo natural/);
  const bar = find(root, node => node.tagName === "button" && node.classList.contains("cart-bar"));
  assert.ok(bar, "la barra del pedido suma el producto");
  bar.trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Enviar pedido/);
  assert.match(doc.body.textContent, /Jugo natural/);
  assert.match(doc.body.textContent, /Total/);
});
