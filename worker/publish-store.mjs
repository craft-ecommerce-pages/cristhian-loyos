#!/usr/bin/env node
// Publica una tienda bespoke estática al edge (Worker craft-menus + KV {slug}:site + R2).
// Replica el árbol tal cual: texto (html/css/js/json) → KV {slug}:site en su ruta raíz-relativa
// (salvo /productos.json y /config.json → KV :productos/:config, que sirve el Worker aparte);
// imágenes (cualquier carpeta) → R2 optimizadas en local. Reescribe TODA referencia a imagen a su
// URL en R2 resolviendo rutas relativas POR-ARCHIVO (maneja ./media, ../media, /producto/, images/1.webp
// co-ubicado), y absolutiza los fetch relativos de productos.json/config.json del shell de la tienda.
// No toca prod: escribe payloads en /tmp e imprime los comandos (local para probar, remoto con aprobación).
//   node publish-store.mjs --dir ../../pages/clientes-tiendas/agropecuaria-yanez --slug agropecuaria-yanez
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, posix } from "node:path";
import { execFileSync } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((v, i, a) => (v.startsWith("--") ? [[v.slice(2), a[i + 1]]] : [])),
);
const { dir, slug } = args;
if (!dir || !slug) { console.error("uso: --dir <carpeta> --slug <slug>"); process.exit(1); }

// Origen público del R2 de la cuenta del cliente (custom domain o r2.dev). Sin valor no reescribe URLs.
const R2 = process.env.R2_PUBLIC_ORIGIN ? `${process.env.R2_PUBLIC_ORIGIN.replace(/\/+$/, "")}/sites/${slug}` : "";
const IMG = /\.(?:jpe?g|png|webp|gif|svg|avif)$/i;
const TEXT = new Set([".html", ".css", ".js", ".json"]);
const SKIP = /(^|\/)(\.git|\.github|node_modules|\.aider[^/]*)$/;

// rewrite: reescribe un archivo de texto ubicado en sitePath (raíz-relativa, con "/" inicial).
function rewrite(text, sitePath) {
  const d = posix.dirname(sitePath);
  const toR2 = (p) => R2 ? R2 + (p.startsWith("/") ? p : posix.normalize(posix.join(d, p))) : p;
  return text
    // refs a imagen (src=/href=/url()/JSON) → R2, resolviendo relativas contra la carpeta del archivo.
    .replace(/(["'(])([^"'()\s?]+\.(?:jpe?g|png|webp|gif|svg|avif))(\?[^"')]*)?(["')])/gi,
      (m, o, p, q, c) => (/^(?:[a-z]+:)?\/\//i.test(p) || p.startsWith("data:")) ? m : `${o}${toR2(p)}${q || ""}${c}`)
    // fetch relativos del shell (mismo app.js corre desde / y /pages) → absolutos.
    .replace(/(["'])(?:\.\.?\/)+(productos|config)\.json/g, "$1/$2.json");
}

const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  if (statSync(p).isDirectory()) return SKIP.test(p) ? [] : walk(p);
  return [p];
});

const site = {};
for (const p of walk(dir)) {
  if (IMG.test(p) || !TEXT.has(extname(p).toLowerCase())) continue; // imágenes→R2; ignora md/xlsx/etc
  const sitePath = "/" + relative(dir, p);
  if (sitePath === "/productos.json" || sitePath === "/config.json") continue; // → KV aparte
  site[sitePath] = rewrite(readFileSync(p, "utf8"), sitePath);
}
const rd = (f) => { try { return rewrite(readFileSync(join(dir, f), "utf8"), "/" + f); } catch { return null; } };
const wr = (n, data) => (writeFileSync(`/tmp/${slug}.${n}`, data), `/tmp/${slug}.${n}`);
const fSite = wr("site.json", JSON.stringify(site));
const fProd = wr("productos.json", rd("productos.json") ?? "[]");
const fCfg = wr("config.json", rd("config.json") ?? "{}");

console.log(`{slug}:site → ${Object.keys(site).length} archivos de texto`);

// Optimizar TODO el árbol de imágenes en local (preserva rutas) antes de R2.
const imgOut = `/tmp/${slug}.img`;
process.stdout.write("imágenes: " + execFileSync("bash", [join(import.meta.dirname, "optimize-images.sh"), dir, imgOut], { encoding: "utf8" }));

const kv = (mode) => [
  `wrangler kv key put ${mode} --binding=MENUS "${slug}:site"      --path=${fSite}`,
  `wrangler kv key put ${mode} --binding=MENUS "${slug}:productos" --path=${fProd}`,
  `wrangler kv key put ${mode} --binding=MENUS "${slug}:config"    --path=${fCfg}`,
].join("\n");

console.log(`\n# --- Prueba LOCAL (wrangler dev lee .wrangler/state) ---`);
console.log(`wrangler kv key put --local --binding=MENUS "domain:localhost" "${slug}"`);
console.log(kv("--local"));
console.log(`wrangler dev &   # luego: curl -s localhost:8787/`);

console.log(`\n# --- Publicar a PROD (requiere aprobación del operador) ---`);
console.log(`# sube ${imgOut} al bucket R2 de la cuenta del cliente (rclone/S3); el prefijo público debe ser ${R2 || "<R2_PUBLIC_ORIGIN>/sites/" + slug}`);
console.log(kv("--remote"));
console.log(`# host: workers.dev (CLIENT_SLUG=${slug}) o dominio propio mapeado en KV domain:{host}`);
