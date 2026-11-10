// Valida el catálogo con el mismo contrato del panel y genera la proyección para KV.
// Uso: node scripts/catalog-import.mjs
//
// Entradas: data/catalog.json (documento nativo), data/config.json, data/sedes.json.
// Salidas:  data/kv/productos.json (buildEntries: forma que consume el menú)
//           data/kv/config.json    (config pública del menú)
// No escribe en KV, D1 ni R2 y no usa credenciales.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDoc, buildEntries } from "../panel/src/catalog.js";
import { isMediaUrl } from "../panel/src/contract.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = async file => JSON.parse(await readFile(join(root, file), "utf8"));

const doc = await read("data/catalog.json");
const config = await read("data/config.json");
const sedes = await read("data/sedes.json");

const errors = [];
const check = (condition, message) => { if (!condition) errors.push(message); };

// 1) Contrato del panel (ids, precios string, media, categorías, variantes, límites).
const validation = validateDoc(doc);
check(validation.ok, `validateDoc: campo inválido ${validation.campo || "?"}`);

// 2) Reglas de negocio del cliente.
const REPORT = new Set(["sushi", "fastfood", "tradicional", "postres"]);
const ids = new Set();
for (const product of doc.products) {
  check(!ids.has(product.id), `product_id duplicado: ${product.id}`);
  ids.add(product.id);
  check(REPORT.has(product.report_category), `report_category inválido en ${product.id}: ${product.report_category}`);
  const price = Number.parseFloat(product.price);
  check(Number.isFinite(price) && price > 0, `precio inválido en ${product.id}: ${product.price}`);
  check(product.images.every(url => isMediaUrl({}, url)), `media inválida en ${product.id}`);
  check(Array.isArray(product.variants), `variants ausente en ${product.id}`);
}
for (const category of doc.categories) {
  check(doc.products.some(p => p.categories.includes(category.slug)), `categoría sin productos: ${category.slug}`);
}

// 3) Sedes estables y QR parametrizable.
const sedeIds = (config.location?.sedes || []).map(sede => sede.id);
check(sedeIds.length === 6, `se esperan 6 sedes, hay ${sedeIds.length}`);
check(new Set(sedeIds).size === sedeIds.length, "ids de sede duplicados");
check(sedeIds.every(id => /^[A-Za-z0-9_-]{1,64}$/.test(id)), "id de sede inválido");
check(JSON.stringify(sedeIds) === JSON.stringify((sedes.sedes || []).map(s => s.id)), "data/sedes.json no coincide con config.location.sedes");
check(sedes.qr?.parametro === "sede", "el QR debe usar el parámetro ?sede=");

// 4) Checkout opt-in: forma mínima que lee v1/catalog.js.
const orders = config.checkout_orders;
if (orders != null) {
  check(orders.enabled === true, "checkout_orders.enabled debe ser true o quitar la clave");
  check(typeof orders.api_base === "string", "checkout_orders.api_base debe ser string ('' = mismo origen)");
  check(Number.isFinite(orders.poll_ms) && orders.poll_ms >= 1000 && orders.poll_ms <= 60000, "checkout_orders.poll_ms fuera de 1000–60000");
}

if (errors.length) {
  console.error(`catalog-import: ${errors.length} error(es)`);
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

const entries = buildEntries(doc);
check(entries.length === doc.products.length, `buildEntries devolvió ${entries.length}/${doc.products.length}`);

await mkdir(join(root, "data/kv"), { recursive: true });
await writeFile(join(root, "data/kv/productos.json"), JSON.stringify(entries, null, 2) + "\n");
await writeFile(join(root, "data/kv/config.json"), JSON.stringify(config, null, 2) + "\n");

const byReport = entries.reduce((acc, entry) => {
  const product = doc.products.find(p => p.id === entry.id);
  acc[product.report_category] = (acc[product.report_category] || 0) + 1;
  return acc;
}, {});
console.log(`import: ${entries.length} entradas · ${doc.categories.length} categorías · sedes ${sedeIds.join(", ")}`);
console.log(`report: ${Object.entries(byReport).map(([k, v]) => `${k}=${v}`).join(" ")}`);
console.log(`kv: data/kv/productos.json + data/kv/config.json (claves <slug>:productos y <slug>:config)`);
