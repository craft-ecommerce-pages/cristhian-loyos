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
  if (mode === "mesa") push(value.table_no ? `Mesa ${value.table_no}` : "Mesa");
  else if (mode === "pickup" || mode === "retiro") push("Para llevar");
  else if (mode === "delivery" || mode === "domicilio") push("Domicilio");
  push(`${date} ${hour}`);
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
