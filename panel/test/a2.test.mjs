// A2: contrato de la página del panel y del encoder QR propio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPage, qrMatrix } from "../src/page.js";

const html = renderPage({ slug: "demo", host: "demo.craft-systems.com" });

test("renderPage devuelve un documento HTML completo", () => {
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="es">/);
  assert.match(html, /<meta name="viewport" content="width=device-width/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.ok(html.includes("demo"), "el slug aparece en el título");
  assert.equal((html.match(/<html/g) || []).length, 1);
  assert.equal((html.match(/<\/html>/g) || []).length, 1);
});

test("la página no usa recursos externos ni protocolos inseguros", () => {
  assert.equal(html.includes("http://"), false, "sin http:// literal");
  assert.equal(/<script\s+src/i.test(html), false, "sin scripts externos");
  assert.equal(/<link\b/i.test(html), false, "sin hojas de estilo externas");
  assert.equal(/@import/i.test(html), false, "sin imports de CSS");
  assert.equal(/innerHTML/.test(html), false, "los datos del cliente se insertan con textContent");
});

test("la página usa español neutro (cero voseo)", () => {
  const voseo = /podés|tenés|querés|acá|hacés|sabés|debés|mirá|agregá|guardá|probá|revisá|volvé|escribí|completá|elegí/i;
  assert.equal(voseo.test(html), false, "no debe haber voseo");
});

test("Mi negocio usa editores estructurados para horario y sedes", () => {
  assert.match(html, /Horario semanal/);
  assert.match(html, /type:\s*"time"/);
  assert.match(html, /hasta dos rangos por día/);
  assert.match(html, /Nombre de la sede/);
  assert.match(html, /Agregar sede/);
  assert.match(html, /QR por sede/);
  assert.match(html, /"\/\?sede=" \+ encodeURIComponent\(branch\.id\)/);
  assert.equal(/id:\s*uid\("bhours"\)/.test(html), false, "el horario no es texto libre");
  assert.equal(/id:\s*uid\("bloc"\)/.test(html), false, "la ubicación no es texto libre");
});

test("el catálogo completo expone sus pantallas y control de versión", () => {
  for (const text of ["Variantes", "Empaques", "Pedidos", "Categorías (", "Promos (", "Aún no hay pedidos desde el menú"]) {
    assert.ok(html.includes(text), `incluye ${text}`);
  }
  assert.match(html, /if_version/);
  assert.match(html, /Alguien más editó el catálogo; recargamos los datos/);
  assert.ok(html.includes('api("catalog")'));
});

test("producto, negocio y pedidos usan los campos del contrato", () => {
  for (const text of ["Grupos reutilizables", "Variantes propias", "Gratis (NxM)", "Nombre singular", "Sugeridos al pedir", "Envío y cobertura", "Coordenadas (lat, lng)", "https://wa.me/"]) {
    assert.ok(html.includes(text), `incluye ${text}`);
  }
  assert.ok(html.includes('toLocaleString("es-EC"'));
});

test("la UI deriva asignaciones del documento real y expande las filas de pedidos", () => {
  assert.match(html, /product_ids:\s*prods\.filter\(product => Array\.isArray\(product\.groups\)/);
  assert.match(html, /product_ids:\s*prods\.filter\(product => product\.packaging_id === packaging\.id\)/);
  assert.match(html, /list\.replaceChildren\([^;]+, \.\.\.rows\)/);
  assert.match(html, /const next = Object\.assign\(\{\}, o, \{ name:/, "editar opciones conserva metadatos no visibles");
});

test("Fidelidad lee stamps_reward.label y escribe stamps_reward_label", () => {
  assert.match(html, /c\.stamps_reward\s*&&\s*c\.stamps_reward\.label/);
  assert.match(html, /stamps_reward_label:\s*reward\.value\.trim\(\)/);
});

test("Fidelidad incluye meseros, PIN obligatorio y auditoría por personal", () => {
  for (const text of ["Meseros", "Exigir PIN del mesero para jugar", "PIN general (anterior)", "Tu menú no tiene sedes con ubicación: cada jugada pedirá el PIN del mesero", "Recomendado: 90 días. Le avisamos al cliente 5 días antes.", "Sellado por", "Canjeado por"]) {
    assert.ok(html.includes(text), `incluye ${text}`);
  }
  assert.match(html, /api\("store"\)/, "consulta la configuración del menú para verificar sedes");
  assert.match(html, /require_pin:\s*requirePin\.checked/);
  assert.match(html, /loyalty\/staff/);
});

test("los scripts inline compilan (sin bundler)", () => {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.equal(scripts.length, 3, "datos, QR y runtime");
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
});

test("el slug se escapa en el título y en los datos inline", () => {
  const out = renderPage({ slug: "<b>x</b>", host: "demo.craft-systems.com" });
  assert.ok(out.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.equal(out.includes("<b>x</b>"), false);
});

test("qrMatrix elige la versión según el largo (byte, ECC M)", () => {
  assert.equal(qrMatrix("hola").length, 21);
  assert.equal(qrMatrix("x".repeat(20)).length, 25);
  assert.equal(qrMatrix("x".repeat(30)).length, 29);
  assert.equal(qrMatrix("x".repeat(200)).length, 57);
  for (const size of [21, 25, 29, 57]) assert.equal((size - 21) % 4, 0);
  assert.throws(() => qrMatrix("x".repeat(260)), /demasiado largo/);
});

test("qrMatrix dibuja los tres patrones finder", () => {
  const texts = ["hola", "x".repeat(20), "x".repeat(30), "https://demo.craft-systems.com/"];
  const want = (r, c) =>
    r === 0 || r === 6 || c === 0 || c === 6 ? 1 : r >= 2 && r <= 4 && c >= 2 && c <= 4 ? 1 : 0;
  for (const text of texts) {
    const m = qrMatrix(text);
    const size = m.length;
    const finder = (row, col) => {
      for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
        assert.equal(m[row + r][col + c], want(r, c), `${text.slice(0, 8)} finder en ${row},${col} módulo ${r},${c}`);
      }
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
  }
});

test("qrMatrix es cuadrado, determinista y usa ambos colores", () => {
  const text = "https://mi-restaurante.craft-systems.com/";
  const a = qrMatrix(text), b = qrMatrix(text);
  assert.equal(a.length, b.length);
  assert.deepEqual(a, b);
  for (const row of a) assert.equal(row.length, a.length);
  const flat = a.flat();
  assert.ok(flat.includes(1) && flat.includes(0));
  assert.ok(flat.every(v => v === 0 || v === 1));
});

test("qrMatrix acepta UTF-8 (nombres y rutas con tildes)", () => {
  const m = qrMatrix("https://menú.example/ñandú");
  assert.equal((m.length - 21) % 4, 0);
  assert.ok(m.length >= 21);
});
