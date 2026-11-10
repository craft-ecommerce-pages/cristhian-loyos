// Copia y optimiza la media real del cliente a media/products y media/brand.
// Uso: node scripts/catalog-media.mjs
//
// Reglas:
// - Solo fotos reales de producto: las del docx de desayunos/almuerzos y el banco de imágenes.
//   Nunca se recortan fotos de las cartas compuestas (imágenes 02–14) como foto de producto.
// - Cada archivo se guarda como WebP ≤1200 px de lado mayor (marca ≤1600 px), sin metadatos.
// - Reescribe data/catalog.json para publicar únicamente archivos que existan en media/products;
//   si el cliente/Codex agrega `media/products/<product_id>.webp`, se enlaza automáticamente.
// - Genera .ops/imagenes-faltantes.md con la lista exacta para el agente de imágenes.
//
// Requiere ImageMagick (`magick`) y `unzip` en el PATH.
import { readFile, writeFile, mkdir, readdir, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = process.env.MENU_MEDIA_SRC || "/home/jcadmin/mnt/files/filebrowser-data/clientes/menus/cristhian_loyos";
const BANK = process.env.MENU_BANK || "/home/jcadmin/mnt/files/filebrowser-data/banco_imagenes_menus";
const DOCX = process.env.MENU_DOCX || join(SRC, "15_20261110-062712_document_wa_1794310032651.docx");
const BRAND_SRC = process.env.MENU_BRAND_SRC || join(SRC, "17_20261110-093506_image_wa_1794321306422.jpg");
const MAX = Number(process.env.MENU_MEDIA_MAX || 1200);
const QUALITY = Number(process.env.MENU_MEDIA_QUALITY || 82);

const MEDIA_ORIGIN = (process.env.MEDIA_ORIGIN || "").replace(/\/+$/, "");
const CLIENT_SLUG = process.env.CLIENT_SLUG || "cristhian-loyos";
const URL_BASE = `${MEDIA_ORIGIN}/media/panel/${CLIENT_SLUG}/products`;
const BRAND_URL = `${MEDIA_ORIGIN}/media/panel/${CLIENT_SLUG}/brand/food-truck.webp`;

const doc = JSON.parse(await readFile(join(root, "data/catalog.json"), "utf8"));
const mediaMap = JSON.parse(await readFile(join(root, "data/media-map.json"), "utf8"));

/* ── Fuentes: archivo de salida → foto real ──────────────────────────────── */
// docx = fotos extraídas del documento de desayunos/almuerzos del cliente.
// bank = foto real del banco de imágenes; se documenta cuando es aproximada.
const SOURCES = {
  "majado.webp": { docx: "word/media/image1.jpeg", note: "Majado/revuelto de verde con huevo." },
  "bolon.webp": { docx: "word/media/image2.jpeg", note: "Bolones de verde." },
  "tortillas.webp": { docx: "word/media/image3.jpeg", note: "Tortilla de verde; la foto trae el rótulo 'Tortillas Verde'." },
  "almuerzo-ejecutivo.webp": { docx: "word/media/image4.jpeg", note: "Arroz, carne y ensalada." },
  "carne-parrilla-platano.webp": { docx: "word/media/image5.jpeg" },
  "pollo-asado-papas.webp": { docx: "word/media/image6.jpeg" },
  "papas-queso-salchicha.webp": { docx: "word/media/image7.jpeg" },
  "patacones.webp": { docx: "word/media/image8.jpeg", note: "Patacones con salsa; el producto incluye ensalada que no aparece en la foto." },
  "papa-rellena.webp": { docx: "word/media/image9.png", note: "Papas rellenas gratinadas." },
  "arroz-moro.webp": { docx: "word/media/image10.png", note: "Arroz con queso; referencia para arroz moro." },
  "cheese-burger.webp": { bank: "cheese-burger-1.webp", note: "Hamburguesa clásica con papas." },
  "cheese-bacon-burger.webp": { bank: "cheese-bacon-burger-1.webp", note: "Hamburguesa con tocino; aproximada a BBQ Bacon." },
  "salchipapa.webp": { bank: "salchipapa-1.webp" },
  "papas-cheese-bacon.webp": { bank: "papas-cheese-bacon-1.webp", note: "Papas con queso y tocino; aproximada a Papa Loca con Carne." },
  "alitas-bbq-6.webp": { bank: "alitasbbq-6-piezas-1.webp" },
  "alitas-honey-6.webp": { bank: "alitashoneymustard-6-piezas-3.webp", note: "Alitas con miel y mostaza." },
  "alitas-mix-12.webp": { bank: "brutal-wings-12-piezas-2.webp", note: "Bandeja de 12 alitas; sabores surtidos aproximados." },
  "torta-chocolate.webp": { bank: "torta-de-chocolate-mojada-1.webp" },
  "selva-negra.webp": { bank: "selva-negra-1.webp" },
  "combo-burger.webp": { bank: "cheese-burger-1.webp", note: "Misma foto que Arizona Classic Burger; el combo incluye papas, sin bebida visible." },
  "combo-alitas-12.webp": { bank: "alitasbbq-12piezas.webp", note: "12 alitas; el combo incluye papas que no aparecen." },
  "papipollo.webp": { bank: "papipollo-3.webp", note: "Pollo frito con papas; el producto lleva queso." },
};

const fileToProducts = new Map(Object.entries(mediaMap.files || {}).map(([file, ids]) => [file, [...ids]]));
const preferredGenerated = new Set();

/* ── Utilidades ──────────────────────────────────────────────────────────── */
function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} falló: ${(res.stderr || res.stdout || "").trim().slice(0, 300)}`);
  return res.stdout;
}
async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}
async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
function dimensions(path) {
  const out = run("magick", ["identify", "-format", "%w %h", path]);
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return { width: w, height: h };
}

await mkdir(join(root, "media/products"), { recursive: true });
await mkdir(join(root, "media/brand"), { recursive: true });

/* Extrae el docx una vez a /tmp/opencode (no se versiona). */
const docxDir = join(process.env.MENU_TMP || "/tmp/opencode", "catalog-docx");
async function extractDocx() {
  const probe = join(docxDir, "word/media/image1.jpeg");
  if (await exists(probe)) return;
  await rm(docxDir, { recursive: true, force: true });
  await mkdir(docxDir, { recursive: true });
  run("unzip", ["-q", "-o", DOCX, "-d", docxDir]);
}

/* ── Procesa cada foto ───────────────────────────────────────────────────── */
await extractDocx();
const manifest = { generated_at: new Date().toISOString(), origin: MEDIA_ORIGIN, key_prefix: `panel/${CLIENT_SLUG}`, files: {} };
const missingSources = [];
for (const [file, spec] of Object.entries(SOURCES)) {
  const src = spec.docx ? join(docxDir, spec.docx) : join(BANK, spec.bank);
  if (!(await exists(src))) { missingSources.push({ file, src }); continue; }
  const out = join(root, "media/products", file);
  run("magick", [src, "-auto-orient", "-resize", `${MAX}x${MAX}>`, "-strip", "-quality", String(QUALITY), out]);
  const { width, height } = dimensions(out);
  const info = await stat(out);
  manifest.files[`products/${file}`] = {
    source: spec.docx ? `docx:${spec.docx}` : `bank:${spec.bank}`,
    products: fileToProducts.get(file) || [],
    width, height, bytes: info.size, sha256: await sha256(out),
    ...(spec.note ? { note: spec.note } : {}),
  };
}

/* ── Imágenes generadas por el agente de imágenes (media/generated/manifest.json) ──
   Formato: { files: { "<product_id>": "media/generated/<archivo>.webp" } }. */
try {
  const generated = JSON.parse(await readFile(join(root, "media/generated/manifest.json"), "utf8"));
  const generatedIds = new Set(doc.products.map(p => p.id));
  for (const id of generated.preferred_ids || []) if (generatedIds.has(id)) preferredGenerated.add(id);
  for (const [productId, relPath] of Object.entries(generated.files || {})) {
    if (!generatedIds.has(productId) || typeof relPath !== "string") continue;
    const src = join(root, relPath);
    if (!(await exists(src))) continue;
    const file = `${productId}.webp`;
    const out = join(root, "media/products", file);
    run("magick", [src, "-auto-orient", "-resize", `${MAX}x${MAX}>`, "-strip", "-quality", String(QUALITY), out]);
    const { width, height } = dimensions(out);
    const info = await stat(out);
    if (!fileToProducts.has(file)) fileToProducts.set(file, [productId]);
    manifest.files[`products/${file}`] = {
      source: `generated:${relPath}`, products: fileToProducts.get(file),
      width, height, bytes: info.size, sha256: await sha256(out),
      note: "Imagen generada por el agente de imágenes; verificar fidelidad con el plato real.",
    };
  }
} catch (error) {
  if (error && error.code !== "ENOENT") console.warn(`media: no se pudo leer media/generated/manifest.json (${error.message})`);
}

/* Marca: foto real del food truck del cliente. */
if (await exists(BRAND_SRC)) {
  const out = join(root, "media/brand/food-truck.webp");
  run("magick", [BRAND_SRC, "-auto-orient", "-resize", "1600x1600>", "-strip", "-quality", String(QUALITY), out]);
  const { width, height } = dimensions(out);
  const info = await stat(out);
  manifest.files["brand/food-truck.webp"] = { source: `cliente:${basename(BRAND_SRC)}`, products: [], width, height, bytes: info.size, sha256: await sha256(out), note: "Food truck real del cliente; usado como imagen de marca/OG." };
} else missingSources.push({ file: "brand/food-truck.webp", src: BRAND_SRC });

/* ── Archivos nuevos `<product_id>.webp` (faltantes que agregue el agente) ── */
const productIds = new Set(doc.products.map(p => p.id));
const available = new Set();
for (const name of await readdir(join(root, "media/products"))) {
  if (!name.endsWith(".webp")) continue;
  available.add(name);
  const id = name.slice(0, -5);
  if (productIds.has(id) && !fileToProducts.has(name)) fileToProducts.set(name, [id]);
}
// Un archivo puede faltar físicamente aunque esté mapeado: se ignora al publicar.
const usable = Object.fromEntries([...fileToProducts].filter(([file]) => available.has(file)));

/* ── Publica en data/catalog.json solo archivos existentes ───────────────── */
const imageOf = new Map();
for (const [file, ids] of Object.entries(usable)) for (const id of ids) if (!imageOf.has(id)) imageOf.set(id, file);
// Cuando la foto real era sólo una aproximación, una imagen específica aprobada
// puede reemplazarla sin alterar la prioridad de las demás fotos reales.
for (const id of preferredGenerated) if (available.has(`${id}.webp`)) imageOf.set(id, `${id}.webp`);
for (const product of doc.products) {
  const file = imageOf.get(product.id);
  product.images = file ? [`${URL_BASE}/${file}`] : [];
}
await writeFile(join(root, "data/catalog.json"), JSON.stringify(doc, null, 2) + "\n");
await writeFile(join(root, "data/media-map.json"), JSON.stringify({
  media_origin: URL_BASE,
  files: usable,
  auto_products: Object.fromEntries([...imageOf].filter(([id, file]) => file === `${id}.webp`)),
}, null, 2) + "\n");
await writeFile(join(root, "media/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

/* ── Reporte de faltantes ────────────────────────────────────────────────── */
const missing = doc.products.filter(p => !p.images.length);
const byCategory = new Map();
for (const p of missing) {
  const list = byCategory.get(p.report_category) || [];
  list.push(p);
  byCategory.set(p.report_category, list);
}
const shared = Object.entries(usable).filter(([, ids]) => ids.length > 1);
const approximations = Object.entries(manifest.files).filter(([, info]) => info.note && !String(info.source).startsWith("generated:"));
const generatedFiles = Object.entries(manifest.files).filter(([, info]) => String(info.source).startsWith("generated:"));
const esc = s => String(s).replace(/\|/g, "\\|");

const lines = [
  "# Imágenes faltantes — Carta Cristhian Loyos",
  "",
  `Generado: ${new Date().toISOString()} · ${doc.products.length} productos · ${doc.products.length - missing.length} con foto · **${missing.length} sin foto**.`,
  "",
  "Agente destino: Codex gpt-5.6-luna. Buscar primero en el banco de imágenes; generar solo si no existe foto real del plato.",
  "Nunca usar recortes de las cartas compuestas (imágenes 02–14) como foto de producto.",
  "",
  "## Formato de entrega",
  "",
  "- Guardar en `media/products/<product_id>.webp` (el nombre del archivo es el `product_id` de la tabla).",
  "- WebP, lado mayor ≤1200 px, sin texto ni marcas de agua, fondo limpio.",
  "- Después de agregar archivos: `node scripts/catalog-build.mjs` y luego `node scripts/catalog-media.mjs` (este último enlaza las fotos y reescribe `data/catalog.json`); al final `node scripts/catalog-import.mjs` para proyectar KV.",
  "",
  "## Faltantes por categoría de reporte",
  "",
];
for (const [category, list] of [...byCategory].sort(([a], [b]) => a.localeCompare(b))) {
  lines.push(`### ${category} (${list.length})`, "", "| product_id | Producto | Categoría visible | Archivo esperado |", "|---|---|---|---|");
  for (const p of list) lines.push(`| \`${p.id}\` | ${esc(p.name)} | ${esc(p.categories.join(", "))} | \`media/products/${p.id}.webp\` |`);
  lines.push("");
}

lines.push("## Fotos compartidas (varios productos usan la misma foto)", "", "| Archivo | Productos | Nota |", "|---|---|---|");
for (const [file, ids] of shared) lines.push(`| \`${file}\` | ${ids.map(id => `\`${id}\``).join(", ")} | Reemplazar por foto individual cuando exista. |`);

lines.push("", "## Fotos aproximadas (revisar con el cliente)", "", "| Archivo | Fuente | Nota |", "|---|---|---|");
for (const [file, info] of approximations) lines.push(`| \`${file}\` | ${esc(info.source)} | ${esc(info.note)} |`);

if (generatedFiles.length) {
  lines.push("", "## Imágenes generadas por el agente (verificar fidelidad con el plato real)", "", "| Archivo | Producto | Fuente |", "|---|---|---|");
  for (const [file, info] of generatedFiles) lines.push(`| \`${file}\` | ${(info.products || []).map(id => `\`${id}\``).join(", ")} | ${esc(info.source)} |`);
}

if (missingSources.length) {
  lines.push("", "## Fuentes no encontradas en el sistema de archivos", "");
  for (const item of missingSources) lines.push(`- \`${item.file}\`: no existe \`${item.src}\``);
}
lines.push("");
await writeFile(join(root, ".ops/imagenes-faltantes.md"), lines.join("\n"));

console.log(`media: ${Object.keys(manifest.files).length} archivos · ${doc.products.length - missing.length}/${doc.products.length} productos con foto · ${missing.length} faltantes`);
if (missingSources.length) {
  console.warn(`media: ${missingSources.length} fuente(s) no encontrada(s); ver .ops/imagenes-faltantes.md`);
  process.exitCode = 1;
}
