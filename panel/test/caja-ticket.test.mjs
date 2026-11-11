// Comanda térmica: sede visible, sin precios ni datos fiscales, inyectable al panel de caja.
import test from "node:test";
import assert from "node:assert/strict";
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";
import { renderPage } from "../src/page.js";

const order = {
  id: "orden-caja-1", number: 52, created_at: Date.UTC(2026, 0, 2, 5, 6),
  sede_nombre: "Centro", delivery_mode: "pickup", client_name: "Ana", note: "Sin cebolla",
  total_cents: 1250, currency: "USD",
  // Aunque el objeto traiga datos fiscales, la comanda física no los imprime.
  billing: { document_type: "ruc", document_number: "1790012345001", email: "ana@example.com", address: "Av. Siempre Viva" },
  customer_phone: "0991234567",
  items: [{ nombre: "Pizza margarita", qty: 2, unit_cents: 500, variant: "Grande · Nota: sin sal" }],
};

test("la comanda muestra pedido y sede sin precios ni datos fiscales", () => {
  const lines = ticketLines(order, { store: "Munch", width: 32, now: order.created_at });
  const joined = lines.join("\n");
  assert.ok(lines.every(line => Array.from(line).length <= 32));
  assert.match(joined, /COMANDA #052/);
  assert.match(joined, /Sede: Centro/);
  assert.match(joined, /2 x Pizza margarita/);
  assert.match(joined, /Sin cebolla/);
  assert.doesNotMatch(joined, /\$|12\.50|1250|USD/);
  assert.doesNotMatch(joined, /RUC|cédula|cedula|1790012345001|ana@example\.com|Av\. Siempre Viva|0991234567/i);
});

test("58/80 mm siguen usando 32/48 columnas y la comanda larga no se corta", () => {
  assert.equal(ticketColumns(58), 32);
  assert.equal(ticketColumns(80), 48);
  assert.equal(ticketPageHeight(0), 50);
  const lines = ticketLines({ ...order, note: "x".repeat(120) }, { store: "Munch", width: ticketColumns(80) });
  assert.ok(lines.every(line => Array.from(line).length <= 48));
});

test("el panel de caja recibe las funciones de comanda y su estilo de impresión", () => {
  const html = renderPage({ slug: "pizza", host: "pizza.craft-systems.com" });
  for (const marker of ["window.__panelTicket", "window.__panelColumns", "window.__panelHeight", "print-ticket", "@media print"]) {
    assert.ok(html.includes(marker), marker);
  }
});
