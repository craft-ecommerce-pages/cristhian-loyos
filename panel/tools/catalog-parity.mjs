// Herramienta manual: compara ExportCatalog de Go con la publicación JS de K1.
// Requiere artefactos generados por: go test -tags parity ./internal/catalogsync -run RealCatalogParityArtifacts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildEntries, publish, validateDoc } from "../src/catalog.js";

const directory = process.env.PARITY_OUT || "/tmp/ens-cat/parity";
const slugs = process.env.PARITY_SLUGS ? process.env.PARITY_SLUGS.split(",") : ["zuba", "cafeteria-san-agustin"];

for (const slug of slugs) {
  const [expected, expectedCategories, doc] = await Promise.all([
    json(`${directory}/${slug}-go-products.json`),
    json(`${directory}/${slug}-go-categories.json`),
    json(`${directory}/${slug}-export.json`),
  ]);
  const validation = validateDoc(doc);
  assert.equal(validation.ok, true, `${slug}: ExportCatalog inválido en ${validation.campo}`);
  const actual = buildEntries(doc);
  assert.deepEqual(actual, expected, `${slug}: buildEntries difiere de Go`);

  const state = new Map([[`${slug}:config`, JSON.stringify({ keep: "intacto" })]]);
  const env = { MENUS: {
    async get(key, type) { const raw = state.get(key); return type === "json" && raw ? JSON.parse(raw) : raw ?? null; },
    async put(key, value) { state.set(key, value); },
  } };
  await publish(env, slug, doc);
  assert.deepEqual(JSON.parse(state.get(`${slug}:productos`)), expected, `${slug}: publish productos difiere`);
  const config = JSON.parse(state.get(`${slug}:config`));
  assert.deepEqual(config.categories, Object.fromEntries(expectedCategories.map(c => [c.Slug ?? c.slug, c.Name ?? c.name])));
  assert.deepEqual(config.category_order, expectedCategories.map(c => c.Slug ?? c.slug));
  assert.deepEqual(config.packaging, { enabled: true, mode: "per_product", label: "Empaque" });
  assert.equal(config.keep, "intacto");
  console.log(`${slug}: ${actual.length} productos publicados, paridad exacta`);
}

async function json(path) { return JSON.parse(await readFile(path, "utf8")); }
