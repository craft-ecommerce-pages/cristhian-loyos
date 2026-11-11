#!/usr/bin/env node
// Publica las fotos corregidas (data/media-sync.json): sube los archivos a R2 y cambia
// SOLO `imagenes` de esos productos en KV (:productos) y D1 (catalogs.doc). No pisa
// precios ni otras ediciones del cliente. Guarda backup en .backup/ antes de escribir.
//
//   node scripts/sync-media.mjs --backup   solo respaldo (KV + versión del doc D1)
//   node scripts/sync-media.mjs            respaldo + R2 + KV + D1 + verificación
//
// Requiere panel/.wrangler/client.toml (lo deja scripts/deploy-client.sh) y las variables
// CLOUDFLARE_*, CLIENT_SLUG, KV_MENUS_ID, D1_DATABASE_NAME, R2_BUCKET_NAME.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BACKUP_ONLY = process.argv.includes("--backup");
const env = k => String(process.env[k] || "").trim();
const [SLUG, KV_ID, D1, BUCKET, ACCOUNT, TOKEN] = ["CLIENT_SLUG", "KV_MENUS_ID", "D1_DATABASE_NAME", "R2_BUCKET_NAME", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].map(env);
const CFG = join(root, "panel/.wrangler/client.toml");
const OUT = join(root, ".backup");
const die = m => { console.error(`[sync-media] ERROR: ${m}`); process.exit(1); };
const log = m => console.log(`[sync-media] ${m}`);
for (const [k, v] of Object.entries({ SLUG, KV_ID, D1, BUCKET, ACCOUNT, TOKEN })) if (!v) die(`falta ${k}`);

const sync = JSON.parse(readFileSync(join(root, "data/media-sync.json"), "utf8"));
const wrangler = args => execFileSync("npx", ["--yes", "wrangler@4.160.0", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const kvUrl = key => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`;
const auth = { Authorization: `Bearer ${TOKEN}` };

async function kvGet(key) {
  const r = await fetch(kvUrl(key), { headers: auth, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) die(`KV ${key}: HTTP ${r.status}`);
  return r.text();
}
async function kvPut(key, text) {
  const r = await fetch(kvUrl(key), { method: "PUT", headers: auth, body: text, signal: AbortSignal.timeout(20000) });
  if (!r.ok) die(`KV put ${key}: HTTP ${r.status}`);
}
const d1Json = sql => {
  const out = JSON.parse(wrangler(["d1", "execute", D1, "--remote", "--config", CFG, "--json", "--command", sql]));
  return (Array.isArray(out) ? out[0] : out).results || [];
};
const patch = (list, key) => {
  let n = 0;
  for (const p of list) {
    const imgs = sync.images[p.id];
    if (imgs && JSON.stringify(p[key]) !== JSON.stringify(imgs)) { p[key] = imgs; n++; }
  }
  return n;
};

// 1) Respaldo (siempre, antes de tocar nada).
mkdirSync(OUT, { recursive: true });
const kvKeys = [`${SLUG}:config`, `${SLUG}:productos`, `${SLUG}:theme`];
for (const key of kvKeys) {
  const v = await kvGet(key);
  if (v !== null) writeFileSync(join(OUT, `${key.replace(":", "_")}.json`), v);
}
const row = d1Json(`SELECT doc, version FROM catalogs WHERE slug = '${SLUG.replaceAll("'", "''")}'`)[0];
if (row) writeFileSync(join(OUT, "d1_catalogs_doc.json"), row.doc);
log(`respaldo en .backup/ (KV: ${kvKeys.length} claves, D1 doc v${row?.version ?? "-"})`);
if (BACKUP_ONLY) process.exit(0);

// 2) R2 primero, para que KV/D1 nunca apunten a un objeto inexistente.
for (const f of sync.files) {
  wrangler(["r2", "object", "put", `${BUCKET}/panel/${SLUG}/products/${f}`, "--file", join(root, "media/products", f),
    "--content-type", "image/webp", "--config", CFG, "--remote"]);
}
log(`R2: ${sync.files.length} objetos subidos`);

// 3) KV :productos (solo `imagenes` de los ids del manifiesto).
const raw = await kvGet(`${SLUG}:productos`);
if (raw === null) die("KV :productos no existe");
const doc = JSON.parse(raw);
const list = Array.isArray(doc) ? doc : doc.productos || doc.products;
if (!Array.isArray(list)) die("forma inesperada de :productos");
const nKv = patch(list, "imagenes");
await kvPut(`${SLUG}:productos`, JSON.stringify(doc));
log(`KV: ${nKv} productos actualizados`);

// 4) D1 catalogs.doc (el panel republica desde aquí; si no, revertiría las fotos).
if (row) {
  const catalog = JSON.parse(row.doc);
  const nD1 = patch(catalog.products, "images");
  const file = join(OUT, "d1_new_doc.sql");
  writeFileSync(file, `UPDATE catalogs SET doc = '${JSON.stringify(catalog).replaceAll("'", "''")}', version = version + 1, updated_at = ${Date.now()} WHERE slug = '${SLUG.replaceAll("'", "''")}' AND version = ${Number(row.version)};\n`);
  wrangler(["d1", "execute", D1, "--remote", "--config", CFG, "--file", file]);
  const after = d1Json(`SELECT version FROM catalogs WHERE slug = '${SLUG.replaceAll("'", "''")}'`)[0];
  if (Number(after?.version) !== Number(row.version) + 1) die("D1 cambió durante la sincronización; reintenta");
  log(`D1: ${nD1} productos actualizados (v${after.version})`);
}

// 5) Verificación: KV releído coincide con el manifiesto.
const check = JSON.parse(await kvGet(`${SLUG}:productos`));
const bad = (Array.isArray(check) ? check : check.productos || check.products).filter(p => sync.images[p.id] && JSON.stringify(p.imagenes) !== JSON.stringify(sync.images[p.id]));
if (bad.length) die(`KV no coincide en ${bad.length} productos`);
log("verificado: KV coincide con el manifiesto");
