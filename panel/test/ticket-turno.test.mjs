// Ticket Z del turno de caja: 32/48 columnas, dinero en centavos y arqueo ciego.
import test from "node:test";
import assert from "node:assert/strict";
import { shiftTicketLines, ticketColumns } from "../../shared/ticket.js";

const closed = {
  shift_id: "turno-1",
  sede_id: "sede-01",
  status: "closed",
  opened_at: Date.UTC(2026, 10, 13, 13, 0),
  closed_at: Date.UTC(2026, 10, 14, 1, 15),
  opened_by: "l_cajera",
  closed_by: "l_cajera",
  opening_float_cents: 2000,
  sales: [
    { method: "cash", count: 12, total_cents: 18450 },
    { method: "transfer", count: 1, total_cents: 0 },
    { method: "bendo", count: 3, total_cents: 4100 },
    { method: "payphone", count: 0, total_cents: 0 },
  ],
  sales_total_cents: 22550,
  movements: {
    in_cents: 0,
    out_cents: 5000,
    items: [
      { kind: "out", amount_cents: 5000, reason: "Depósito banco", staff_id: "l_cajera", created_at: 0 },
    ],
  },
  expected_cash_cents: 15450,
  counted_cash_cents: 15400,
  difference_cents: -50,
  pending_payments: { count: 1, total_cents: 1200 },
  orders: { paid: 15, rejected: 1 },
  note: "Cierre con faltante de monedas",
};

test("el ticket Z usa 32 columnas y muestra el arqueo con centavos enteros", () => {
  const lines = shiftTicketLines(closed, { store: "Munch", width: 32, sedeName: "Centro" });
  const joined = lines.join("\n");
  assert.ok(lines.every(line => Array.from(line).length <= 32), "ninguna línea excede 32 columnas");
  for (const marker of [
    "Munch", "CIERRE DE CAJA", "TICKET Z", "Sede: Centro",
    "Fondo inicial", "$20.00",
    "Efectivo (12)", "$184.50",
    "Transferencia (1)", "$0.00",
    "Tarjeta (link) (3)", "$41.00",
    "Payphone (histórico) (0)",
    "TOTAL VENTAS", "$225.50",
    "Retiros", "$50.00", "Depósito banco",
    "Efectivo esperado", "$154.50",
    "Efectivo contado", "$154.00",
    "Diferencia", "-$0.50", "Faltante de caja",
    "pago(s) pendiente(s)", "por $12.00", "sin",
    "Pedidos pagados", "15",
    "Pedidos rechazados", "1",
    "Nota: Cierre con faltante de",
  ]) assert.ok(joined.includes(marker), marker);
  assert.doesNotMatch(joined, /154\.5(?!\d)|51\.000000|0\.3000000/, "sin residuos de flotantes");
});

test("58/80 mm usan 32/48 columnas y los textos largos se envuelven sin cortarse", () => {
  assert.equal(ticketColumns(58), 32);
  assert.equal(ticketColumns(80), 48);
  const long = {
    ...closed,
    difference_cents: 1250,
    movements: {
      in_cents: 0,
      out_cents: 1250,
      items: [
        { kind: "out", amount_cents: 1250, reason: "Pago a proveedor de verduras y hielo del mercado central" },
      ],
    },
    note: "Se entrega el sobrante al dueño junto con el comprobante del depósito del día anterior",
  };
  const lines = shiftTicketLines(long, { store: "Munch", width: ticketColumns(80), sedeName: "Centro" });
  const joined = lines.join("\n");
  assert.ok(lines.every(line => Array.from(line).length <= 48), "ninguna línea excede 48 columnas");
  assert.match(joined, /Sobrante de caja/);
  assert.match(joined, /proveedor de verduras/);
  assert.match(joined, /comprobante del depósito/);
  assert.match(joined, /Diferencia\s+\$12\.50/);
  assert.doesNotMatch(joined, /Faltante de caja/);
});

test("un reporte abierto o sin caja no inventa esperado ni diferencia", () => {
  const open = {
    shift_id: "turno-2", sede_id: "sede-02", status: "open",
    opened_at: Date.UTC(2026, 10, 13, 14, 5),
    opening_float_cents: 1000,
    sales: [{ method: "otro", count: 1, total_cents: 1 }],
    sales_total_cents: 1,
  };
  const lines = shiftTicketLines(open, { width: 32 });
  const joined = lines.join("\n");
  assert.match(joined, /RESUMEN DEL TURNO/);
  assert.doesNotMatch(joined, /TICKET Z|Efectivo esperado|Efectivo contado|Diferencia/);
  assert.match(joined, /Sede: sede-02/);
  assert.match(joined, /otro \(1\)/, "un método desconocido no se oculta");
  assert.match(joined, /\$0\.01/);
  assert.ok(lines.every(line => Array.from(line).length <= 32));

  const empty = shiftTicketLines(undefined, { width: 32 });
  assert.match(empty.join("\n"), /Sin ventas registradas/);
  assert.ok(empty.every(line => Array.from(line).length <= 32));
});
