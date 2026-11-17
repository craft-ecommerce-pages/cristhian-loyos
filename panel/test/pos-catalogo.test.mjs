// POS: catálogo rápido en la caja — jerarquía del menú, un toque = 1 unidad,
// fotos con emoji de respaldo y barra fija de cobro.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import panel from "../src/index.js";
import { signCajaSession } from "../src/caja.js";
import { renderMeseroPage } from "../src/mesero.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };
const host = "pizza.craft-systems.com";

/* ── Backend: meseroCatalog ──────────────────────────────────────────────── */

const config = {
  categories: {
    "sushi-entradas": "🥟 Sushi · Entradas",
    "sushi-rollos": "🍣 Sushi · Rollos",
    "sushi-combos": "🍱 Sushi · Combos",
    "fastfood-hamburguesas": "🍔 Fast Food · Hamburguesas",
    "fastfood-papas": "🍟 Fast Food · Papas",
    "tradicional-almuerzos": "🍲 Tradicional · Almuerzos",
  },
  category_order: [
    "sushi-entradas", "sushi-rollos", "sushi-combos",
    "fastfood-hamburguesas", "fastfood-papas", "tradicional-almuerzos",
  ],
  category_groups: {
    question: "¿Qué buscas hoy?",
    items: [
      { slug: "sushi", name: "Sushi", emoji: "🍣", categories: ["sushi-entradas", "sushi-rollos", "sushi-combos", "no-existe"] },
      { slug: "fastfood", name: "Fast Food", emoji: "🍔", categories: ["fastfood-hamburguesas", "fastfood-papas"] },
      // Basura que el backend debe descartar: sin nombre, duplicado y sin slug.
      { slug: "vacio", categories: ["sushi-rollos"] },
      { slug: "sushi", name: "Duplicado", emoji: "🔁", categories: [] },
      { name: "Sin slug", emoji: "❓", categories: ["sushi-rollos"] },
    ],
  },
};

const productos = [
  { id: "p-roll", nombre: "Roll California", precio: 6.5, categorias: ["sushi-rollos"], imagenes: ["https://cdn.example.com/roll.jpg"] },
  { id: "p-gyozas", nombre: "Gyozas", precio: 5, categorias: ["sushi-entradas"] },
];

async function catalogOf(env) {
  const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
  const response = await panel.fetch(
    new Request(`https://${host}/panel/api/mesero/catalog`, { headers: { cookie } }),
    env,
    {},
  );
  assert.equal(response.status, 200);
  return response.json();
}

test("meseroCatalog publica category_groups saneado desde KV", async () => {
  const env = makeEnv({ "pizza:config": config, "pizza:productos": productos });
  const catalog = await catalogOf(env);
  assert.deepEqual(catalog.category_groups, {
    question: "¿Qué buscas hoy?",
    items: [
      { slug: "sushi", name: "Sushi", emoji: "🍣", categories: ["sushi-entradas", "sushi-rollos", "sushi-combos"] },
      { slug: "fastfood", name: "Fast Food", emoji: "🍔", categories: ["fastfood-hamburguesas", "fastfood-papas"] },
    ],
  });
  // El resto de la respuesta no cambia.
  assert.ok(Array.isArray(catalog.products) && catalog.products.length === 2);
  assert.ok(Array.isArray(catalog.categories));
  assert.equal(typeof catalog.version, "number");
});

test("meseroBoot lleva la misma jerarquía al HTML y null sin configuración válida", async () => {
  const bootOf = async (env) => {
    const cookie = `caja_s=${await signCajaSession(env, "pizza", "staff-1")}`;
    const html = await (
      await panel.fetch(new Request(`https://${host}/panel/pos`, { headers: { cookie } }), env, {})
    ).text();
    return JSON.parse(/window\.__MESERO__=(\{.*?\});<\/script>/s.exec(html)[1]).boot;
  };

  const conGrupos = await bootOf(makeEnv({ "pizza:config": config, "pizza:productos": productos }));
  assert.equal(conGrupos.catalog.category_groups.items.length, 2);

  // Sin configuración, y con configuración inválida o vacía: null y nada más.
  for (const env of [
    makeEnv(),
    makeEnv({ "pizza:config": { category_groups: { items: "no-es-lista" } } }),
    makeEnv({ "pizza:config": { category_groups: { items: [] } } }),
    makeEnv({ "pizza:config": { category_groups: { items: [{ emoji: "❓" }] } } }),
  ]) {
    const boot = await bootOf(env);
    assert.equal(boot.catalog.category_groups, null);
    assert.ok(Array.isArray(boot.catalog.products));
  }
});

/* ── UI del builder sobre un navegador mínimo ────────────────────────────── */

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
    this.checked = false;
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
  products: [
    { id: "p-roll", name: "Roll California", price: "6.50", active: true, catalog_visible: true,
      categories: ["sushi-rollos"], images: ["https://cdn.example.com/roll.jpg"] },
    { id: "p-gyozas", name: "Gyozas", price: "5", active: true, catalog_visible: true, categories: ["sushi-entradas"] },
    { id: "p-burger", name: "Hamburguesa clásica", price: "8", active: true, catalog_visible: true, categories: ["fastfood-hamburguesas"] },
    { id: "p-papas", name: "Papas fritas", price: "3", active: true, catalog_visible: true, categories: ["fastfood-papas"] },
    { id: "p-agotado", name: "Combo agotado", price: "4", stock: 0, active: true, catalog_visible: true, categories: ["fastfood-papas"] },
    { id: "p-lasana", name: "Lasaña de carne", price: "7", active: true, catalog_visible: true, categories: ["tradicional-almuerzos"] },
    { id: "p-combo", name: "Sushi combo", price: "12", active: true, catalog_visible: true, categories: ["sushi-combos"],
      variants: [{ name: "Tamaño", type: "price_select", optional: false, pick: 0,
        options: [{ name: "Regular", price: 12 }, { name: "Grande", price: 16 }] }] },
  ],
  categories: [
    { slug: "sushi-entradas", name: "🥟 Sushi · Entradas" },
    { slug: "sushi-rollos", name: "🍣 Sushi · Rollos" },
    { slug: "sushi-combos", name: "🍱 Sushi · Combos" },
    { slug: "fastfood-hamburguesas", name: "🍔 Fast Food · Hamburguesas" },
    { slug: "fastfood-papas", name: "🍟 Fast Food · Papas" },
    { slug: "tradicional-almuerzos", name: "🍲 Tradicional · Almuerzos" },
  ],
  category_groups: {
    question: "¿Qué buscas hoy?",
    items: [
      { slug: "sushi", name: "Sushi", emoji: "🍣", categories: ["sushi-entradas", "sushi-rollos", "sushi-combos"] },
      { slug: "fastfood", name: "Fast Food", emoji: "🍔", categories: ["fastfood-hamburguesas", "fastfood-papas"] },
      { slug: "tradicional", name: "Comida Tradicional", emoji: "🍲", categories: ["tradicional-almuerzos"] },
    ],
  },
  variant_groups: [],
};

async function startPos({ catalog: catalogData = catalog, fetchImpl = null, html: presetHtml = null } = {}) {
  const env = makeEnv();
  const html = presetHtml || await renderMeseroPage(new Request(`https://${host}/panel/mesero`), env, site);
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
        me: { staff: { id: "dueno", name: "Dueño" }, owner: true,
          store: { name: "Pizza", currency: "$" }, sedes: [{ id: "centro", nombre: "Centro" }] },
        catalog: catalogData,
        orders: [],
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
    window, doc, (fetchImpl || (async () => Response.json({ error: "sin_mock" }, { status: 500 }))),
    localStorage, location, () => true, () => 0, () => {},
  );
  await flush();
  return { root, doc, toast, html };
}

async function openBuilder({ root }) {
  const nav = find(root, node => node.tagName === "button" && node.textContent === "Nueva venta");
  assert.ok(nav, "pestaña Nueva venta");
  nav.trigger("click");
  await flush();
}

const cards = root => findAll(root, node => node.tagName === "button" && node.classList.contains("catalog-product"));
const cardOf = (root, name) => cards(root).find(node => node.textContent.includes(name));
const cardName = card => {
  const label = find(card, node => node.classList.contains("catalog-name"));
  return label ? label.textContent : "";
};
const cardNames = root => cards(root).map(cardName);
const groupChips = root => findAll(root, node => node.tagName === "button" && node.classList.contains("group-chip"));
const categoryRow = root => find(root, node => node.classList.contains("filters") && !node.classList.contains("groups"));
const categoryChips = root => groupChips(root).length === 0 && !categoryRow(root)
  ? []
  : (categoryRow(root)?.children || []).filter(node => node.tagName === "button");
const categoryLabels = root => categoryChips(root).map(node => node.textContent);
const selectedCategory = root => (categoryChips(root).find(node => node.classList.contains("selected")) || {}).textContent;
const bar = root => find(root, node => node.classList.contains("cart-bar"));
const payButton = root => find(root, node => node.tagName === "button" && node.textContent === "Cobrar");
const searchField = root => find(root, node => node.tagName === "input" && node.getAttribute("aria-label") === "Buscar producto");

test("la caja pinta los grupos y quita el prefijo de familia de las categorías", async () => {
  const ctx = await startPos();
  await openBuilder(ctx);

  assert.deepEqual(groupChips(ctx.root).map(node => node.textContent), [
    "Todo", "🍣 Sushi", "🍔 Fast Food", "🍲 Comida Tradicional",
  ]);
  // Con "Todo" se ven todas las categorías como hoy.
  assert.deepEqual(categoryLabels(ctx.root), [
    "Todo", "🥟 Sushi · Entradas", "🍣 Sushi · Rollos", "🍱 Sushi · Combos",
    "🍔 Fast Food · Hamburguesas", "🍟 Fast Food · Papas", "🍲 Tradicional · Almuerzos",
  ]);

  groupChips(ctx.root).find(node => node.textContent === "🍣 Sushi").trigger("click");
  await flush();
  assert.deepEqual(categoryLabels(ctx.root), ["Todo", "🥟 Entradas", "🍣 Rollos", "🍱 Combos"]);
  assert.equal(categoryLabels(ctx.root).some(label => label.includes("Sushi ·")), false,
    "sin el prefijo de familia y conservando el emoji");
  assert.deepEqual(cardNames(ctx.root), ["Roll California", "Gyozas", "Sushi combo"],
    "solo los productos del grupo activo");
  assert.equal(groupChips(ctx.root).find(node => node.textContent === "🍣 Sushi").getAttribute("aria-pressed"), "true");

  // Sin category_groups la fila de grupos no existe y todo queda como antes.
  const plain = { ...catalog, category_groups: null };
  const sinGrupos = await startPos({ catalog: plain });
  await openBuilder(sinGrupos);
  assert.equal(groupChips(sinGrupos.root).length, 0);
  assert.ok(categoryLabels(sinGrupos.root).includes("🍣 Sushi · Rollos"));
});

test("un toque agrega 1 unidad directo y la tarjeta muestra la cantidad", async () => {
  const ctx = await startPos();
  await openBuilder(ctx);

  const papas = cardOf(ctx.root, "Papas fritas");
  assert.ok(papas);
  assert.ok(find(papas, node => node.classList.contains("media-fallback")), "sin foto usa el emoji");
  assert.equal(find(papas, node => node.classList.contains("media-fallback")).textContent, "🍟");
  papas.trigger("click");
  await flush();

  assert.match(ctx.toast.textContent, /\+1 Papas fritas/);
  assert.equal(find(ctx.doc.body, node => node.classList.contains("sheet")), null,
    "sin variantes no abre la hoja");
  const fresh = cardOf(ctx.root, "Papas fritas");
  assert.match(fresh.textContent, /×1/);
  assert.ok(fresh.classList.contains("bump"), "la insignia llega con un pop breve");
  assert.equal(fresh.classList.contains("in-cart"), true);
  assert.match(bar(ctx.root).textContent, /1 ítem/);
  assert.match(bar(ctx.root).textContent, /\$3\.00/);

  cardOf(ctx.root, "Papas fritas").trigger("click");
  await flush();
  assert.match(cardOf(ctx.root, "Papas fritas").textContent, /×2/);
  assert.match(bar(ctx.root).textContent, /2 ítems/);
  assert.match(bar(ctx.root).textContent, /\$6\.00/);

  // Agotado: deshabilitado y no agrega.
  const agotado = cardOf(ctx.root, "Combo agotado");
  assert.equal(agotado.getAttribute("disabled"), "", "el atributo disabled lo bloquea");
  assert.match(agotado.textContent, /Agotado/);
});

test("un producto con variantes abre la hoja y respeta la opción elegida", async () => {
  const ctx = await startPos();
  await openBuilder(ctx);

  cardOf(ctx.root, "Sushi combo").trigger("click");
  await flush();
  const sheet = find(ctx.doc.body, node => node.classList.contains("sheet"));
  assert.ok(sheet, "se abre la hoja actual de variantes");
  assert.match(bar(ctx.root).textContent, /0 ítems/, "todavía no agrega nada");

  const form = find(sheet, node => node.tagName === "form");
  const option = find(form, node => node.tagName === "input" && node.value === "Regular");
  assert.ok(option);
  option.checked = true;
  option.trigger("change");
  form.trigger("submit");
  await flush();

  assert.match(ctx.toast.textContent, /\+1 Sushi combo/);
  assert.match(cardOf(ctx.root, "Sushi combo").textContent, /×1/);
  assert.match(bar(ctx.root).textContent, /1 ítem/);
  assert.match(bar(ctx.root).textContent, /\$12\.00/);
});

test("el buscador recorre todo el catálogo, sin acentos e ignorando el grupo", async () => {
  const ctx = await startPos();
  await openBuilder(ctx);
  groupChips(ctx.root).find(node => node.textContent === "🍔 Fast Food").trigger("click");
  await flush();
  assert.deepEqual(cardNames(ctx.root), ["Hamburguesa clásica", "Papas fritas", "Combo agotado"]);

  const search = searchField(ctx.root);
  search.value = "lasana";
  search.trigger("input");
  await flush();
  assert.deepEqual(cardNames(ctx.root), ["Lasaña de carne"],
    "encuentra fuera del grupo y sin tilde");

  search.value = "sushi";
  search.trigger("input");
  await flush();
  assert.deepEqual(cardNames(ctx.root), ["Sushi combo"], "nombre y variantes del otro grupo");

  search.value = "";
  search.trigger("input");
  await flush();
  assert.deepEqual(cardNames(ctx.root), ["Hamburguesa clásica", "Papas fritas", "Combo agotado"],
    "al limpiar vuelve el grupo activo");
});

test("la barra de cobro es fija, siempre visible y lleva a Continuar al cobro", async () => {
  const { root, doc, html } = await startPos();
  assert.match(html, /\.cart-bar\{position:fixed/, "la barra vive fija abajo");
  await openBuilder({ root });

  assert.ok(bar(root), "visible incluso sin ítems");
  assert.match(bar(root).textContent, /0 ítems/);
  assert.match(bar(root).textContent, /\$0\.00/);
  assert.equal(payButton(root).disabled, true, "nada que cobrar todavía");

  cardOf(root, "Gyozas").trigger("click");
  await flush();
  assert.match(bar(root).textContent, /1 ítem/);
  assert.equal(payButton(root).disabled, false);
  payButton(root).trigger("click");
  await flush();
  assert.match(doc.body.textContent, /Continuar al cobro/);
  assert.match(doc.body.textContent, /Gyozas/);
});

test("la caja recuerda grupo y categoría al cobrar y empezar otro pedido", async () => {
  const created = {
    id: "venta-1", number: 5, status: "pending", source: "caja", sede_id: "centro",
    created_at: Date.now(), total_cents: 300, currency: "USD",
    items: [{ name: "Papas fritas", qty: 1, unit_cents: 300 }],
  };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url), method = init.method || "GET";
    calls.push({ url: target, method });
    if (target.includes("/panel/api/turnos/")) return Response.json({ shift: null });
    if (target.endsWith("/panel/api/mesero/orders") && method === "POST")
      return Response.json({ id: created.id, number: created.number, status: created.status, total_cents: created.total_cents }, { status: 201 });
    if (target.includes("/panel/api/mesero/orders")) return Response.json({ orders: [created] });
    return Response.json({});
  };
  const ctx = await startPos({ fetchImpl });
  await openBuilder(ctx);

  groupChips(ctx.root).find(node => node.textContent === "🍔 Fast Food").trigger("click");
  await flush();
  categoryChips(ctx.root).find(node => node.textContent === "🍟 Papas").trigger("click");
  await flush();
  cardOf(ctx.root, "Papas fritas").trigger("click");
  await flush();
  payButton(ctx.root).trigger("click");
  await flush();
  find(ctx.doc.body, node => node.tagName === "button" && node.textContent === "Continuar al cobro").trigger("click");
  await flush();
  assert.ok(calls.some(call => call.method === "POST" && call.url.endsWith("/panel/api/mesero/orders")));

  // Cierra el cobro en efectivo y arranca otra venta.
  const close = find(ctx.doc.body, node => node.tagName === "button" && node.textContent === "Cerrar");
  if (close) close.trigger("click");
  await flush();
  await openBuilder(ctx);

  assert.equal(groupChips(ctx.root).find(node => node.textContent === "🍔 Fast Food")
    .getAttribute("aria-pressed"), "true", "el último grupo sigue activo");
  assert.equal(selectedCategory(ctx.root), "🍟 Papas", "la última categoría sigue elegida");
  assert.deepEqual(cardNames(ctx.root), ["Papas fritas", "Combo agotado"]);
});
