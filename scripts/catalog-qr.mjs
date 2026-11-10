// Genera un QR por sede con la URL pública real del menú. Parametrizado: no inventa dominio.
// Uso: CATALOG_BASE_URL="https://menu.cliente.com" node scripts/catalog-qr.mjs
//      node scripts/catalog-qr.mjs https://menu.cliente.com
//
// Salidas: data/qr-links.json (enlaces) y media/qr/<sede>.png (si `qrencode` está instalado).
// El QR solo codifica `?sede=<id>`; el menú conserva la sede elegida y no la cambia por geolocalización.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = process.env.CATALOG_BASE_URL || process.argv[2] || "";
if (!raw) {
  console.error("Falta CATALOG_BASE_URL. Ejemplo: CATALOG_BASE_URL=\"https://menu.cliente.com\" node scripts/catalog-qr.mjs");
  process.exit(2);
}
let base;
try { base = new URL(raw); } catch { console.error(`URL inválida: ${raw}`); process.exit(2); }
if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") {
  console.error("El QR debe apuntar a HTTPS (o localhost para pruebas). No se generó nada.");
  process.exit(2);
}
base.search = "";
base.hash = "";
const baseHref = base.href.replace(/\/+$/, "");

const { sedes } = JSON.parse(await readFile(join(root, "data/sedes.json"), "utf8"));
const links = sedes.map(sede => ({
  sede: sede.id,
  nombre: sede.nombre,
  url: `${baseHref}/?sede=${encodeURIComponent(sede.id)}`,
}));

await mkdir(join(root, "data"), { recursive: true });
await writeFile(join(root, "data/qr-links.json"), JSON.stringify({ base_url: baseHref, parametro: "sede", links }, null, 2) + "\n");

const qr = spawnSync("qrencode", ["--version"], { encoding: "utf8" });
if (qr.status === 0) {
  await mkdir(join(root, "media/qr"), { recursive: true });
  for (const link of links) {
    const out = join(root, "media/qr", `${link.sede}.png`);
    const result = spawnSync("qrencode", ["-o", out, "-s", "8", "-m", "2", "-l", "M", link.url], { encoding: "utf8" });
    if (result.status !== 0) { console.error(`qrencode falló para ${link.sede}: ${result.stderr.trim()}`); process.exit(1); }
  }
  console.log(`qr: ${links.length} PNG en media/qr/ + data/qr-links.json`);
} else {
  console.log(`qr: ${links.length} enlaces en data/qr-links.json (qrencode no instalado; sin PNG)`);
}
for (const link of links) console.log(`${link.sede}\t${link.url}`);
