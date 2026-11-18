// Líneas de una comanda de cocina. Debe permanecer autocontenida: el panel la
// serializa al navegador con String(ticketLines), sin imports ni cierres externos.
export function ticketColumns(paper) {
  return Number(paper) === 58 ? 32 : 48;
}

export function ticketPageHeight(lineCount) {
  const lines = Number.isInteger(lineCount) ? Math.max(0, lineCount) : 0;
  return Math.max(50, Math.ceil(lines * 3.8 + 8));
}

export function ticketLines(order, { store = "", width = 32, now } = {}) {
  const columns = Number.isInteger(width) ? Math.max(1, width) : 32;
  const value = order && typeof order === "object" ? order : {};
  const lines = [];
  const cut = (text) => Array.from(String(text ?? "").trim());
  const push = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    for (let at = 0; at < chars.length; at += columns)
      lines.push(chars.slice(at, at + columns).join(""));
  };
  const centered = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    if (chars.length >= columns) return push(chars.join(""));
    lines.push(
      " ".repeat(Math.floor((columns - chars.length) / 2)) + chars.join(""),
    );
  };
  const wrapped = (text, indent = "") => {
    // Sin trim: el prefijo son justamente espacios de sangría.
    const prefix = Array.from(indent)
      .slice(0, Math.max(0, columns - 1))
      .join("");
    const available = Math.max(1, columns - prefix.length);
    const words = String(text ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let row = "";
    const flush = () => {
      if (row) {
        lines.push(prefix + row);
        row = "";
      }
    };
    for (const word of words) {
      const chars = Array.from(word);
      if (chars.length > available) {
        flush();
        for (let at = 0; at < chars.length; at += available) {
          const part = chars.slice(at, at + available).join("");
          if (part.length === available) lines.push(prefix + part);
          else row = part;
        }
      } else if (!row) row = word;
      else if (row.length + 1 + word.length <= available) row += " " + word;
      else {
        flush();
        row = word;
      }
    }
    flush();
  };
  const epoch = Number.isFinite(Number(now))
    ? Number(now)
    : Number(value.created_at) || Date.now();
  const local = new Date(epoch - 5 * 60 * 60 * 1000);
  const two = (n) => String(n).padStart(2, "0");
  const date = `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}`;
  const hour = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())} EC`;
  const number =
    Number.isInteger(Number(value.number)) && Number(value.number) > 0
      ? String(value.number).padStart(3, "0")
      : String(value.id || "----").slice(-4) || "----";

  centered(store || "Mi negocio");
  centered(`COMANDA #${number}`);
  const mode = String(value.delivery_mode || "").toLowerCase();
  const service = String(value.service_mode || "");
  if (service === "dine_in") centered("PARA SERVIRSE AQUI");
  else if (service === "takeaway") centered("PARA LLEVAR");
  else if (mode === "mesa") push(value.table_no ? `Mesa ${value.table_no}` : "Mesa");
  else if (mode === "pickup" || mode === "retiro") push("Para llevar");
  else if (mode === "delivery" || mode === "domicilio") push("Domicilio");
  // Pedido programado: la cocina lo prepara para esa hora (hora de Ecuador, UTC-5).
  if (Number(value.pickup_at) > 0) {
    const at = new Date(Number(value.pickup_at) - 5 * 60 * 60 * 1000);
    centered(`*** RETIRA ${two(at.getUTCHours())}:${two(at.getUTCMinutes())} ***`);
  }
  push(`${date} ${hour}`);
  if (value.sede_nombre) push(`Sede: ${String(value.sede_nombre)}`);
  if (Number(value.print_count) > 1)
    centered(`COPIA ${Math.floor(Number(value.print_count))}`);
  lines.push("-".repeat(columns));

  const items = Array.isArray(value.items) ? value.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const qty =
      Number.isInteger(Number(item.qty)) && Number(item.qty) > 0
        ? Number(item.qty)
        : 1;
    wrapped(`${qty} x ${String(item.nombre || "Producto")}`);
    if (item.variant) wrapped(String(item.variant), "  ");
  }
  if (value.note) {
    lines.push("-".repeat(columns));
    wrapped(`Nota: ${String(value.note)}`);
  }
  if (value.client_name) wrapped(`Cliente: ${String(value.client_name)}`);
  return lines.map((line) => Array.from(line).slice(0, columns).join(""));
}

// Recibo del cliente (no la comanda de cocina): importes con Subtotal, IVA y
// Total. Autocontenido igual que ticketLines: el panel lo serializa al navegador
// con String(clientTicketLines). El IVA nunca se recalcula aquí: el pedido llega
// con `subtotal_cents`, `tax_cents` y `total_cents` ya congelados por el servidor.
export function clientTicketLines(order, { store = "", width = 32, now } = {}) {
  const columns = Number.isInteger(width) ? Math.max(1, width) : 32;
  const value = order && typeof order === "object" ? order : {};
  const lines = [];
  const cut = (text) => Array.from(String(text ?? "").trim());
  const push = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    for (let at = 0; at < chars.length; at += columns)
      lines.push(chars.slice(at, at + columns).join(""));
  };
  const centered = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    if (chars.length >= columns) return push(chars.join(""));
    lines.push(" ".repeat(Math.floor((columns - chars.length) / 2)) + chars.join(""));
  };
  const wrapped = (text, indent = "") => {
    const prefix = Array.from(indent).slice(0, Math.max(0, columns - 1)).join("");
    const available = Math.max(1, columns - prefix.length);
    const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
    let row = "";
    const flush = () => {
      if (row) {
        lines.push(prefix + row);
        row = "";
      }
    };
    for (const word of words) {
      const chars = Array.from(word);
      if (chars.length > available) {
        flush();
        for (let at = 0; at < chars.length; at += available) {
          const part = chars.slice(at, at + available).join("");
          if (part.length === available) lines.push(prefix + part);
          else row = part;
        }
      } else if (!row) row = word;
      else if (row.length + 1 + word.length <= available) row += " " + word;
      else {
        flush();
        row = word;
      }
    }
    flush();
  };
  const cents = (input) => {
    const number = Number(input);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  };
  // Centavos enteros → "$0.00"; nunca se multiplica ni divide con flotantes.
  const money = (input) => {
    const number = cents(input);
    const sign = number < 0 ? "-" : "";
    const abs = Math.abs(number);
    return sign + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  };
  // Etiqueta a la izquierda y monto a la derecha; si no cabe, dos filas.
  const pair = (label, amountText) => {
    const left = Array.from(String(label ?? ""));
    const right = Array.from(String(amountText ?? ""));
    if (!left.length && !right.length) return;
    if (!right.length) return push(left.join(""));
    if (left.length + 1 + right.length <= columns) {
      lines.push(left.join("") + " ".repeat(columns - left.length - right.length) + right.join(""));
      return;
    }
    push(left.join(""));
    lines.push(" ".repeat(Math.max(0, columns - right.length)) + right.join(""));
  };
  const rule = () => lines.push("-".repeat(columns));
  const epoch = Number.isFinite(Number(now)) ? Number(now) : Number(value.created_at) || Date.now();
  const local = new Date(epoch - 5 * 60 * 60 * 1000);
  const two = (n) => String(n).padStart(2, "0");
  const date = `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}`;
  const hour = `${two(local.getUTCHours())}:${two(local.getUTCMinutes())} EC`;
  const number =
    Number.isInteger(Number(value.number)) && Number(value.number) > 0
      ? String(value.number).padStart(3, "0")
      : String(value.id || "----").slice(-4) || "----";

  const items = Array.isArray(value.items) ? value.items : [];
  const itemCents = (item) => {
    if (Number.isInteger(item?.base_cents)) return item.base_cents;
    const qty = Number(item?.qty) || 1;
    return Math.round(qty * (Number(item?.unit_cents) || 0));
  };
  const subtotalCents = Number.isInteger(value.subtotal_cents)
    ? value.subtotal_cents
    : items.reduce((sum, item) => sum + itemCents(item), 0);
  const totalCents = Number.isInteger(value.total_cents) ? value.total_cents : subtotalCents + cents(value.tax_cents);
  const taxCents = Number.isInteger(value.tax_cents) ? value.tax_cents : totalCents - subtotalCents;
  const rateBp = Number.isInteger(value.tax_rate_bp)
    ? value.tax_rate_bp
    : items.reduce((found, item) => (found == null && Number.isInteger(item?.tax_rate_bp) ? item.tax_rate_bp : found), null);
  const rateText = rateBp == null ? "" : String(Number((rateBp / 100).toFixed(2)));

  centered(store || "Mi negocio");
  centered(`RECIBO #${number}`);
  push(`${date} ${hour}`);
  const mode = String(value.delivery_mode || "").toLowerCase();
  if (mode === "mesa") push(value.table_no ? `Mesa ${value.table_no}` : "Mesa");
  else if (mode === "pickup" || mode === "retiro") push("Para llevar");
  else if (mode === "delivery" || mode === "domicilio") push("Domicilio");
  if (value.sede_nombre) push(`Sede: ${String(value.sede_nombre)}`);
  rule();

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const qty = Number.isInteger(Number(item.qty)) && Number(item.qty) > 0 ? Number(item.qty) : 1;
    pair(`${qty} x ${String(item.name || item.nombre || "Producto")}`, money(itemCents(item)));
    if (item.variant || item.variant_id) wrapped(String(item.variant || item.variant_id), "  ");
    if (item.note) wrapped(`Nota: ${String(item.note)}`, "  ");
  }
  rule();
  // El IVA se rotula con la tasa congelada en el pedido ("IVA 15%").
  pair("Subtotal", money(subtotalCents));
  pair(rateText ? `IVA ${rateText}%` : "IVA", money(taxCents));
  pair("TOTAL", money(totalCents));
  if (value.customer_name) wrapped(`Cliente: ${String(value.customer_name)}`);
  return lines.map((line) => Array.from(line).slice(0, columns).join(""));
}

// Ticket Z del turno de caja (`docs/CIERRE-CAJA.md`). Autocontenido igual que
// ticketLines: el panel lo serializa al navegador con String(shiftTicketLines).
// Todo el dinero llega y se suma en centavos enteros; aquí solo se formatea.
export function shiftTicketLines(report, { store = "", width = 32, sedeName = "" } = {}) {
  const columns = Number.isInteger(width) ? Math.max(1, width) : 32;
  const value = report && typeof report === "object" ? report : {};
  const lines = [];
  const cut = (text) => Array.from(String(text ?? "").trim());
  const push = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    for (let at = 0; at < chars.length; at += columns)
      lines.push(chars.slice(at, at + columns).join(""));
  };
  const centered = (text) => {
    const chars = cut(text);
    if (!chars.length) return;
    if (chars.length >= columns) return push(chars.join(""));
    lines.push(
      " ".repeat(Math.floor((columns - chars.length) / 2)) + chars.join(""),
    );
  };
  const wrapped = (text, indent = "") => {
    const prefix = Array.from(indent)
      .slice(0, Math.max(0, columns - 1))
      .join("");
    const available = Math.max(1, columns - prefix.length);
    const words = String(text ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let row = "";
    const flush = () => {
      if (row) {
        lines.push(prefix + row);
        row = "";
      }
    };
    for (const word of words) {
      const chars = Array.from(word);
      if (chars.length > available) {
        flush();
        for (let at = 0; at < chars.length; at += available) {
          const part = chars.slice(at, at + available).join("");
          if (part.length === available) lines.push(prefix + part);
          else row = part;
        }
      } else if (!row) row = word;
      else if (row.length + 1 + word.length <= available) row += " " + word;
      else {
        flush();
        row = word;
      }
    }
    flush();
  };
  const cents = (input) => {
    const number = Number(input);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  };
  // Enteros en centavos: nunca se multiplica ni divide por 100 con flotantes.
  const money = (input) => {
    const number = cents(input);
    const sign = number < 0 ? "-" : "";
    const abs = Math.abs(number);
    return (
      sign + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0")
    );
  };
  const stamp = (input) => {
    const number = Number(input);
    if (!Number.isFinite(number) || number <= 0) return "";
    const local = new Date(number - 5 * 60 * 60 * 1000);
    const two = (part) => String(part).padStart(2, "0");
    return (
      `${local.getUTCFullYear()}-${two(local.getUTCMonth() + 1)}-${two(local.getUTCDate())}` +
      ` ${two(local.getUTCHours())}:${two(local.getUTCMinutes())}`
    );
  };
  // Etiqueta a la izquierda y monto alineado a la derecha; si no cabe, dos filas.
  const pair = (label, amountText) => {
    const left = Array.from(String(label ?? ""));
    const right = Array.from(String(amountText ?? ""));
    if (!left.length && !right.length) return;
    if (!right.length) return push(left.join(""));
    if (left.length + 1 + right.length <= columns) {
      lines.push(
        left.join("") + " ".repeat(columns - left.length - right.length) + right.join(""),
      );
      return;
    }
    push(left.join(""));
    lines.push(" ".repeat(Math.max(0, columns - right.length)) + right.join(""));
  };
  // Nombres visibles de los métodos del contrato; un método desconocido no se oculta.
  const methodLabel = {
    cash: "Efectivo",
    transfer: "Transferencia",
    datafono: "Datáfono",
    bendo: "Tarjeta (link)",
    payphone: "Payphone (histórico)",
  };
  const rule = () => lines.push("-".repeat(columns));

  centered(store || "Mi negocio");
  centered("CIERRE DE CAJA");
  centered(
    String(value.status || "").toLowerCase() === "open"
      ? "RESUMEN DEL TURNO"
      : "TICKET Z",
  );
  const place = String(sedeName || value.sede_id || "").trim();
  if (place) push(`Sede: ${place}`);
  const opened = stamp(value.opened_at);
  const closed = stamp(value.closed_at);
  if (opened) push(`Apertura: ${opened} EC`);
  if (closed) push(`Cierre: ${closed} EC`);
  rule();

  pair("Fondo inicial", money(value.opening_float_cents));
  rule();

  const sales = Array.isArray(value.sales) ? value.sales : [];
  if (sales.length) {
    push("VENTAS POR MÉTODO");
    for (const sale of sales) {
      if (!sale || typeof sale !== "object") continue;
      const method = String(sale.method || "otro");
      const label = methodLabel[method] || method;
      const count = Math.max(0, cents(sale.count));
      pair(`${label} (${count})`, money(sale.total_cents));
    }
  } else push("Sin ventas registradas");
  pair("TOTAL VENTAS", money(value.sales_total_cents));
  rule();

  const movements =
    value.movements && typeof value.movements === "object" ? value.movements : {};
  push("EFECTIVO");
  pair("Ingresos", money(movements.in_cents));
  pair("Retiros", money(movements.out_cents));
  const items = Array.isArray(movements.items) ? movements.items : [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const sign = String(item.kind).toLowerCase() === "out" ? "- " : "+ ";
    const reason = String(item.reason || "").trim();
    pair(sign + (reason || (sign === "- " ? "Retiro" : "Ingreso")), money(item.amount_cents));
  }

  const hasCash =
    value.expected_cash_cents != null ||
    value.counted_cash_cents != null ||
    value.difference_cents != null;
  if (hasCash) {
    rule();
    pair("Efectivo esperado", money(value.expected_cash_cents));
    pair("Efectivo contado", money(value.counted_cash_cents));
    const difference = cents(value.difference_cents);
    pair("Diferencia", money(difference));
    if (difference < 0) push("Faltante de caja");
    else if (difference > 0) push("Sobrante de caja");
  }

  const pending =
    value.pending_payments && typeof value.pending_payments === "object"
      ? value.pending_payments
      : {};
  const pendingCount = Math.max(0, cents(pending.count));
  if (pendingCount)
    wrapped(
      `Aviso: ${pendingCount} pago(s) pendiente(s) por ${money(pending.total_cents)} sin confirmar.`,
    );

  const orders = value.orders && typeof value.orders === "object" ? value.orders : {};
  if (orders.paid != null || orders.rejected != null) {
    rule();
    if (orders.paid != null) pair("Pedidos pagados", String(Math.max(0, cents(orders.paid))));
    if (orders.rejected != null)
      pair("Pedidos rechazados", String(Math.max(0, cents(orders.rejected))));
  }
  if (value.note) {
    rule();
    wrapped(`Nota: ${String(value.note)}`);
  }
  rule();
  return lines.map((line) => Array.from(line).slice(0, columns).join(""));
}
