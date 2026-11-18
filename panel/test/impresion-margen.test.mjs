// Impresión térmica: sin márgenes del navegador (@page margin 0) y con padding
// interno, para que Chrome no añada fecha, título ni URL. El ancho 58/80 mm no cambia.
import test from "node:test";
import assert from "node:assert/strict";
import { renderPage } from "../src/page.js";
import { renderKitchenPage } from "../src/kitchen.js";
import { renderMeseroPage } from "../src/mesero.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "munch", host: "munch.craft-systems.com" };
const request = path => new Request(`https://${site.host}${path}`);

test("la comanda de caja usa @page margin 0 y padding en el cuerpo", () => {
  const html = renderPage(site);
  assert.match(html, /@page\{size:" \+ paper \+ "mm " \+ height \+ "mm;margin:0\}/);
  assert.match(html, /@media print\{body\{margin:0;padding:3mm\}\}/);
  assert.equal(html.includes("margin:3mm"), false, "sin margen de página que imprima encabezados");
});

test("la comanda de cocina usa @page margin 0 y padding en el cuerpo", async () => {
  const html = await renderKitchenPage(request("/panel/cocina"), makeEnv(), site);
  assert.match(html, /@page\{size:" \+ paper \+ "mm " \+ height \+ "mm;margin:0\}/);
  assert.match(html, /@media print\{body\{margin:0;padding:3mm\}\}/);
  assert.equal(html.includes("margin:3mm"), false);
});

test("el mesero también imprime sin márgenes externos", async () => {
  const html = await renderMeseroPage(request("/panel/mesero"), makeEnv(), site);
  assert.match(html, /@page\{size:\$\{paper\}mm \$\{height\}mm;margin:0\}/);
  assert.match(html, /margin:0\}\s*body\{margin:0;padding:3mm;/);
});
