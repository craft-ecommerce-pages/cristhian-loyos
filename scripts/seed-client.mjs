#!/usr/bin/env node
// Carga inicial reproducible del cliente: config/productos en KV, catálogo nativo en D1
// y media en R2. NO pisa datos editados por el cliente. La media y D1 se
// preparan antes de publicar las claves KV; un reintento completa claves ausentes.
//
// Uso local (sin credenciales):
//   node scripts/seed-client.mjs --dry-run
//
// Uso real (desde craft-dev o el workflow, con los IDs del cliente):
//   CLIENT_SLUG=cristhian-loyos KV_MENUS_ID=<id> D1_DATABASE_NAME=<db> R2_BUCKET_NAME=<bucket> \
//   node scripts/seed-client.mjs
//
// Requiere que `scripts/deploy-client.sh --dry-run` (o un deploy) haya renderizado
// `panel/.wrangler/client.toml`. Nunca imprime secretos ni valores de KV.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDoc } from "../panel/src/catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const WRANGLER = process.env.WRANGLER_SPEC || "wrangler@4.160.0";
const CFG = process.env.PANEL_CFG || join(root, "panel/.wrangler/client.toml");
const SLUG = String(process.env.CLIENT_SLUG || "").trim();
const KV_ID = String(process.env.KV_MENUS_ID || "").trim();
const D1_NAME = String(process.env.D1_DATABASE_NAME || "").trim();
const R2_BUCKET = String(process.env.R2_BUCKET_NAME || "").trim();
const ACCOUNT_ID = String(process.env.CLOUDFLARE_ACCOUNT_ID || "").trim();
const API_TOKEN = String(process.env.CLOUDFLARE_API_TOKEN || "").trim();

const log = message => console.log(`[seed-client] ${message}`);
const die = message => { console.error(`[seed-client] ERROR: ${message}`); process.exit(1); };
const readJson = file => JSON.parse(readFileSync(join(root, file), "utf8"));

function run(command, commandArgs, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync(command, commandArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (cause) {
    const stdout = String(cause.stdout || ""), stderr = String(cause.stderr || "");
    if (allowFail) return { code: cause.status ?? 1, stdout, stderr };
    die(`${command} ${commandArgs.slice(0, 4).join(" ")}… falló: ${(stderr || stdout).split("\n")[0]}`);
  }
}
const wrangler = (commandArgs, options) => run("npx", ["--yes", WRANGLER, ...commandArgs], options);

// 1) Validación local del catálogo (mismo contrato que el panel).
const catalog = readJson("data/catalog.json");
const config = readJson("data/config.json");
const sedes = readJson("data/sedes.json");
const validation = validateDoc(catalog);
if (!validation.ok) die(`catálogo inválido en ${validation.campo || "?"}`);
const sedeIds = (config.location?.sedes || []).map(sede => sede.id);
if (sedeIds.length !== 6 || new Set(sedeIds).size !== 6) die("se esperan seis sedes con IDs únicos");
if (JSON.stringify(sedeIds) !== JSON.stringify((sedes.sedes || []).map(sede => sede.id))) die("data/sedes.json no coincide con config.location.sedes");
const products = Array.isArray(catalog.products) ? catalog.products.length : 0;
const mediaFiles = [
  ...readdirSync(join(root, "media/products")).filter(name => !name.startsWith(".")).map(name => ({ local: `media/products/${name}`, key: `panel/${SLUG}/products/${name}` })),
  ...readdirSync(join(root, "media/brand")).filter(name => !name.startsWith(".")).map(name => ({ local: `media/brand/${name}`, key: `panel/${SLUG}/brand/${name}` })),
];

if (DRY) {
  log(`dry-run · slug=${SLUG || "<CLIENT_SLUG>"} · ${products} productos · ${sedeIds.length} sedes · ${mediaFiles.length} archivos de media`);
  log("media y D1 se preparan antes de KV; las claves existentes nunca se sobrescriben");
  log(`claves previstas: ${SLUG || "<slug>"}:config, ${SLUG || "<slug>"}:productos, catalogs(${SLUG || "<slug>"})`);
  process.exit(0);
}

if (!SLUG) die("falta CLIENT_SLUG");
if (!existsSync(CFG)) die(`no existe ${CFG}; ejecuta scripts/deploy-client.sh --dry-run o renderiza la configuración`);
if (!KV_ID) die("falta KV_MENUS_ID");
if (!D1_NAME) die("falta D1_DATABASE_NAME");
if (!R2_BUCKET) die("falta R2_BUCKET_NAME");
if (!ACCOUNT_ID || !API_TOKEN) die("faltan credenciales de Cloudflare");

// 2) Consulta exacta: sólo 404 significa ausencia. Un 403, 5xx o fallo de red
//    debe detener la carga para no interpretar un error como KV vacío.
const kvKeys = [`${SLUG}:config`, `${SLUG}:productos`];
const occupied = new Set();
for (const key of kvKeys) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(ACCOUNT_ID)}/storage/kv/namespaces/${encodeURIComponent(KV_ID)}/values/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch { die("no se pudo verificar el estado de KV"); }
  if (response.status === 404) continue;
  if (!response.ok) die(`KV devolvió HTTP ${response.status} al verificar una clave`);
  occupied.add(key);
}
if (occupied.size === kvKeys.length) {
  log("KV ya tiene config y productos: no se siembra nada. El cliente conserva sus ediciones.");
  process.exit(0);
}
if (occupied.size) log("KV tiene una clave; se completará sólo la ausente, sin tocar datos existentes.");

// 3) D1: documento nativo del panel, sólo si no existe la fila del slug.
const query = wrangler(["d1", "execute", D1_NAME, "--remote", "--config", CFG, "--json",
  "--command", `SELECT COUNT(*) AS n FROM catalogs WHERE slug = '${SLUG.replaceAll("'", "''")}'`]);
let count = 0;
try {
  const parsed = JSON.parse(query.stdout);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  count = Number(first?.results?.[0]?.n ?? first?.results?.n ?? 0);
} catch { /* salida no JSON: se intenta el INSERT idempotente igualmente */ }
if (count > 0) {
  log("D1 ya tiene catálogo para el slug: no se sobrescribe");
} else {
  mkdirSync(join(root, ".tmp"), { recursive: true });
  const sqlFile = join(root, ".tmp/seed-catalog.sql");
  const doc = JSON.stringify(catalog).replaceAll("'", "''");
  writeFileSync(sqlFile,
    `INSERT INTO catalogs (slug, doc, version, updated_at)\n` +
    `SELECT '${SLUG.replaceAll("'", "''")}', '${doc}', 1, ${Date.now()}\n` +
    `WHERE NOT EXISTS (SELECT 1 FROM catalogs WHERE slug = '${SLUG.replaceAll("'", "''")}');\n`);
  wrangler(["d1", "execute", D1_NAME, "--remote", "--config", CFG, "--file", sqlFile]);
  log("D1 sembrado: catalogs (una fila por slug)");
}

// 4) R2: media del catálogo. Se completa antes de publicar KV. Si un objeto
//    falla, el reintento repite la carga inicial sin exponer un menú incompleto.
let uploaded = 0;
if (!occupied.size) {
  for (const file of mediaFiles) {
    wrangler(["r2", "object", "put", `${R2_BUCKET}/${file.key}`, "--file", join(root, file.local), "--config", CFG, "--remote"]);
    uploaded++;
  }
}
log(`R2: ${uploaded} objetos en ${R2_BUCKET} (prefijo panel/${SLUG}/)`);
// 5) KV se publica al final. Una clave ya presente se respeta incluso si la
//    carga anterior se interrumpió entre las dos escrituras.
for (const [index, key] of kvKeys.entries()) {
  if (occupied.has(key)) continue;
  const file = index === 0 ? "data/kv/config.json" : "data/kv/productos.json";
  wrangler(["kv", "key", "put", key, "--namespace-id", KV_ID, "--path", join(root, file), "--remote"]);
  log(`KV sembrado: ${key}`);
}
log("carga inicial completada. Provisiona el usuario admin del panel por separado.");
