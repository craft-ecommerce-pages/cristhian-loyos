#!/usr/bin/env node
// Publica la carta local (data/catalog.json + data/kv/*) en la cuenta Cloudflare del cliente.
// Pensado para cambios de catálogo/config (categorías, jerarquía del menú, precios), no para fotos:
// las fotos se suben con scripts/sync-media.mjs.
//
//   node scripts/publish-catalog.mjs            solo valida y muestra el plan (no usa credenciales)
//   node scripts/publish-catalog.mjs --apply    respaldo + KV config/productos + D1 catalogs.doc
//
// Requiere panel/.wrangler/client.toml (lo deja scripts/deploy-client.sh) y las variables
// CLOUDFLARE_*, CLIENT_SLUG, KV_MENUS_ID, D1_DATABASE_NAME al aplicar.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDoc } from "../panel/src/catalog.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPLY = process.argv.includes("--apply");
const read = file => JSON.parse(readFileSync(join(root, file), "utf8"));
const log = m => console.log(`[publish-catalog] ${m}`);
const die = m => { console.error(`[publish-catalog] ERROR: ${m}`); process.exit(1); };

const doc = read("data/catalog.json");
const config = read("data/config.json");
const entries = read("data/kv/productos.json");

// 1) Validaciones locales (mismo contrato que el panel).
const check = validateDoc(doc);
if (!check.ok) die(`validateDoc: campo inválido ${check.campo || "?"}`);
const cats = new Set(doc.categories.map(c => c.slug));
const groups = config.category_groups?.items;
if (groups) {
  if (!Array.isArray(groups)) die("config.category_groups.items debe ser un arreglo");
  const seen = new Set();
  for (const g of groups) {
    if (!g || !/^[a-z0-9-]+$/.test(g.slug || "")) die(`grupo inválido: ${JSON.stringify(g)}`);
    if (seen.has(g.slug)) die(`grupo duplicado: ${g.slug}`);
    seen.add(g.slug);
    for (const slug of g.categories || []) if (!cats.has(slug)) die(`grupo ${g.slug} referencia categoría inexistente: ${slug}`);
  }
}
for (const p of entries) for (const slug of p.categorias || []) if (!cats.has(slug)) die(`${p.id} usa categoría inexistente: ${slug}`);
if (entries.length !== doc.products.length) die(`KV productos (${entries.length}) no coincide con catalog.json (${doc.products.length}); ejecuta scripts/catalog-import.mjs`);
log(`válido: ${doc.products.length} productos · ${doc.categories.length} categorías · ${groups?.length || 0} grupos`);

if (!APPLY) {
  log("plan: KV <slug>:config y <slug>:productos + D1 catalogs.doc desde data/");
  log("sin --apply no se escribe nada; para publicar: node scripts/publish-catalog.mjs --apply");
  process.exit(0);
}

// 2) Credenciales y destino.
const env = k => String(process.env[k] || "").trim();
const [SLUG, KV_ID, D1, ACCOUNT, TOKEN] = ["CLIENT_SLUG", "KV_MENUS_ID", "D1_DATABASE_NAME", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"].map(env);
for (const [k, v] of Object.entries({ SLUG, KV_ID, D1, ACCOUNT, TOKEN })) if (!v) die(`falta ${k}`);
const CFG = join(root, "panel/.wrangler/client.toml");
const wrangler = args => execFileSync("npx", ["--yes", "wrangler@4.160.0", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const kvUrl = key => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(key)}`;
const auth = { Authorization: `Bearer ${TOKEN}` };
const kvGet = async key => {
  const r = await fetch(kvUrl(key), { headers: auth, signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) die(`KV ${key}: HTTP ${r.status}`);
  return r.text();
};
const kvPut = async (key, text) => {
  const r = await fetch(kvUrl(key), { method: "PUT", headers: auth, body: text, signal: AbortSignal.timeout(20000) });
  if (!r.ok) die(`KV put ${key}: HTTP ${r.status}`);
};
const d1Json = sql => {
  const out = JSON.parse(wrangler(["d1", "execute", D1, "--remote", "--config", CFG, "--json", "--command", sql]));
  return (Array.isArray(out) ? out[0] : out).results || [];
};
const q = s => String(s).replaceAll("'", "''");

// 3) Respaldo antes de escribir.
const backup = join(root, ".backup", `publish-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(backup, { recursive: true });
for (const key of [`${SLUG}:config`, `${SLUG}:productos`]) {
  const v = await kvGet(key);
  if (v !== null) writeFileSync(join(backup, `${key.replace(":", "_")}.json`), v);
}
const row = d1Json(`SELECT doc, version FROM catalogs WHERE slug = '${q(SLUG)}'`)[0];
if (!row) die("no existe la fila catalogs del cliente; sembrar D1 primero");
writeFileSync(join(backup, "d1_catalogs_doc.json"), row.doc);
log(`respaldo en .backup/${backup.split("/").pop()} (D1 doc v${row.version})`);

// 4) KV (menú) y D1 (fuente del panel) — así un guardado del panel no revierte las categorías.
await kvPut(`${SLUG}:config`, JSON.stringify(config));
await kvPut(`${SLUG}:productos`, JSON.stringify(entries));
writeFileSync(join(backup, "d1_new_doc.sql"),
  `UPDATE catalogs SET doc = '${q(JSON.stringify(doc))}', version = version + 1, updated_at = ${Date.now()} WHERE slug = '${q(SLUG)}' AND version = ${Number(row.version)};\n`);
wrangler(["d1", "execute", D1, "--remote", "--config", CFG, "--file", join(backup, "d1_new_doc.sql")]);
const after = d1Json(`SELECT version FROM catalogs WHERE slug = '${q(SLUG)}'`)[0];
if (Number(after?.version) !== Number(row.version) + 1) die("D1 cambió durante la publicación; reintenta");

// 5) Verificación: KV releído coincide con los archivos locales.
const kvCfg = JSON.parse(await kvGet(`${SLUG}:config`));
const kvProd = JSON.parse(await kvGet(`${SLUG}:productos`));
if (JSON.stringify(kvCfg) !== JSON.stringify(config)) die("KV :config no coincide con data/config.json");
if (JSON.stringify(kvProd) !== JSON.stringify(entries)) die("KV :productos no coincide con data/kv/productos.json");
log(`publicado y verificado · D1 v${after.version} · ${entries.length} productos`);
