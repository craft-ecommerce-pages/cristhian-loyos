// Turnos y cierre de caja (migración 0012). Una caja por sede: varios cajeros
// cobran sobre el mismo turno abierto. El cajero abre, registra movimientos de
// efectivo y cierra con arqueo ciego; el dueño revisa historial y diferencias.
//   · Dinero siempre en centavos enteros; ninguna suma pasa por floats.
//   · El efectivo esperado sale de los pagos `paid` con `shift_id` del turno,
//     no de totales de pedidos (un pedido puede tener un intento rechazado).
//   · Un turno cerrado es inmutable: el reporte se lee del snapshot `totals`.
//   · Todos los cálculos filtran por `slug`; el cajero solo opera sus sedes.
import { error, json } from "./contract.js";
import { authorizedForSede, sedeById } from "./orders.js";
import { salesRange } from "./reports.js";

const SEDE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEM_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const KINDS = new Set(["in", "out"]);
// Orden estable del reporte; `payphone` solo aparece si quedan filas históricas.
const METHODS = ["cash", "transfer", "bendo", "payphone"];
const MAX_CENTS = 100_000_000;            // tope de cordura: 1 000 000,00 USD
const MAX_NOTE = 200;
const MIN_REASON = 3;
const MAX_REASON = 120;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/* ── Consultas base ──────────────────────────────────────────────────────── */

// Turno abierto de la sede (el índice parcial garantiza que haya como máximo uno).
// `null` = caja cerrada: el cobro manual debe responder 409 caja_cerrada.
export async function openShiftFor(env, slug, sedeId) {
  return env.DB.prepare(
    "SELECT * FROM pos_shifts WHERE slug = ? AND sede_id = ? AND status = 'open'",
  ).bind(slug, sedeId).first();
}

async function shiftById(env, slug, id) {
  return env.DB.prepare("SELECT * FROM pos_shifts WHERE slug = ? AND id = ?").bind(slug, id).first();
}

async function shiftByOpenKey(env, slug, key) {
  return env.DB.prepare("SELECT * FROM pos_shifts WHERE slug = ? AND open_key = ?").bind(slug, key).first();
}

async function movementByKey(env, slug, key) {
  return env.DB.prepare("SELECT * FROM pos_cash_movements WHERE slug = ? AND idempotency_key = ?").bind(slug, key).first();
}

/* ── Reporte del turno (en vivo o snapshot) ──────────────────────────────── */

// Reporte completo del turno. Cerrado ⇒ snapshot guardado al cerrar (inmutable);
// abierto ⇒ cálculo en vivo para que el dueño vea el avance.
export async function shiftReport(env, slug, shift) {
  if (!shift) return null;
  if (shift.status === "closed") {
    const stored = parseJson(shift.totals);
    if (stored && Array.isArray(stored.sales) && stored.movements && typeof stored.movements === "object") {
      return { ...stored, ...closedFields(shift) };
    }
  }
  return liveReport(env, slug, shift);
}

// Los campos de la fila mandan sobre el snapshot: son la fuente del cierre.
function closedFields(shift) {
  return {
    shift_id: shift.id,
    sede_id: shift.sede_id,
    status: "closed",
    opened_at: whole(shift.opened_at),
    closed_at: shift.closed_at == null ? null : whole(shift.closed_at),
    opened_by: shift.opened_by,
    closed_by: shift.closed_by || null,
    opening_float_cents: whole(shift.opening_float_cents),
    expected_cash_cents: whole(shift.expected_cash_cents),
    counted_cash_cents: shift.counted_cash_cents == null ? null : whole(shift.counted_cash_cents),
    difference_cents: shift.difference_cents == null ? null : whole(shift.difference_cents),
    note: shift.note || "",
  };
}

async function liveReport(env, slug, shift) {
  const closed = shift.status === "closed";
  const openedAt = whole(shift.opened_at);
  // El cierre congela el instante: los avisos (pendientes, rechazos) se acotan
  // a la vida del turno y no cambian al reimprimir el Z después.
  const end = shift.closed_at == null ? Date.now() : whole(shift.closed_at);
  const sedeId = shift.sede_id;

  const [salesRows, movementRows, pending, rejected, paid] = await Promise.all([
    env.DB.prepare(
      "SELECT provider AS method, COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total_cents " +
      "FROM pos_payments WHERE slug = ? AND shift_id = ? AND status = 'paid' GROUP BY provider",
    ).bind(slug, shift.id).all(),
    env.DB.prepare(
      "SELECT kind, amount_cents, reason, staff_id, created_at FROM pos_cash_movements " +
      "WHERE slug = ? AND shift_id = ? ORDER BY created_at ASC, rowid ASC",
    ).bind(slug, shift.id).all(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count, COALESCE(SUM(p.amount_cents), 0) AS total_cents " +
      "FROM pos_payments p JOIN pos_orders o ON o.slug = p.slug AND o.id = p.order_id " +
      "WHERE p.slug = ? AND o.sede_id = ? AND p.status IN ('pending', 'unknown') " +
      "AND p.created_at >= ? AND p.created_at < ?",
    ).bind(slug, sedeId, openedAt, end).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS count FROM pos_orders WHERE slug = ? AND sede_id = ? AND status = 'rejected' " +
      "AND status_at IS NOT NULL AND status_at >= ? AND status_at < ?",
    ).bind(slug, sedeId, openedAt, end).first(),
    // Pedidos cobrados del turno: una orden puede tener varios intentos, nunca
    // más de un cobro asignado; se cuentan órdenes distintas.
    env.DB.prepare(
      "SELECT COUNT(DISTINCT order_id) AS count FROM pos_payments WHERE slug = ? AND shift_id = ? AND status = 'paid'",
    ).bind(slug, shift.id).first(),
  ]);

  const found = new Map((salesRows.results || []).map(row => [String(row.method), row]));
  const sales = [];
  for (const method of METHODS) {
    const row = found.get(method);
    if (!row) continue;
    sales.push({ method, count: whole(row.count), total_cents: whole(row.total_cents) });
    found.delete(method);
  }
  // Un proveedor fuera del contrato nunca debe romper la conciliación: entra al
  // final para que la suma de ventas siga igualando los pagos del turno.
  for (const method of [...found.keys()].sort()) {
    const row = found.get(method);
    sales.push({ method, count: whole(row.count), total_cents: whole(row.total_cents) });
  }

  const items = (movementRows.results || []).map(movementReport);
  const inCents = items.filter(item => item.kind === "in").reduce((sum, item) => sum + item.amount_cents, 0);
  const outCents = items.filter(item => item.kind === "out").reduce((sum, item) => sum + item.amount_cents, 0);
  const salesTotal = sales.reduce((sum, sale) => sum + sale.total_cents, 0);
  const cashCents = sales.reduce((sum, sale) => sum + (sale.method === "cash" ? sale.total_cents : 0), 0);

  const opening = whole(shift.opening_float_cents);
  const expected = closed && shift.expected_cash_cents != null
    ? whole(shift.expected_cash_cents)
    : opening + cashCents + inCents - outCents;
  const counted = shift.counted_cash_cents == null ? null : whole(shift.counted_cash_cents);
  const difference = shift.difference_cents == null
    ? (counted == null ? null : counted - expected)
    : whole(shift.difference_cents);

  return {
    shift_id: shift.id,
    sede_id: sedeId,
    status: closed ? "closed" : "open",
    opened_at: openedAt,
    closed_at: shift.closed_at == null ? null : whole(shift.closed_at),
    opened_by: shift.opened_by,
    closed_by: shift.closed_by || null,
    opening_float_cents: opening,
    sales,
    sales_total_cents: salesTotal,
    movements: { in_cents: inCents, out_cents: outCents, items },
    expected_cash_cents: expected,
    counted_cash_cents: counted,
    difference_cents: difference,
    pending_payments: { count: whole(pending?.count), total_cents: whole(pending?.total_cents) },
    orders: { paid: whole(paid?.count), rejected: whole(rejected?.count) },
    note: shift.note || "",
  };
}

function movementReport(row) {
  return {
    kind: row.kind, amount_cents: whole(row.amount_cents), reason: row.reason,
    staff_id: row.staff_id, created_at: whole(row.created_at),
  };
}

function movementResponse(row) {
  return { id: row.id, shift_id: row.shift_id, ...movementReport(row) };
}

async function movementItems(env, slug, shiftId) {
  const rows = await env.DB.prepare(
    "SELECT kind, amount_cents, reason, staff_id, created_at FROM pos_cash_movements " +
    "WHERE slug = ? AND shift_id = ? ORDER BY created_at ASC, rowid ASC",
  ).bind(slug, shiftId).all();
  return (rows.results || []).map(movementReport);
}

// Vista para cajero: sin ventas, esperado ni diferencia (arqueo ciego).
function shiftView(shift, movements) {
  return {
    id: shift.id, sede_id: shift.sede_id, opened_at: whole(shift.opened_at),
    opened_by: shift.opened_by, opening_float_cents: whole(shift.opening_float_cents), movements,
  };
}

/* ── Rutas (el ensamblador las monta con la sesión de handlePosApi) ──────── */

export async function handleTurnosApi(request, env, site, session, path) {
  // `path` llega relativo a /panel/api/ y sin query (api.js); se tolera una
  // barra final o una query pegada por error sin cambiar la ruta.
  const route = String(path || "").split("?")[0].replace(/^\/+|\/+$/g, "");
  const method = request.method;
  if (route === "turnos") return method === "GET" ? listShifts(request, env, site, session) : error("metodo_invalido", 405);
  if (route === "turnos/actual") return method === "GET" ? currentShift(request, env, site, session) : error("metodo_invalido", 405);
  if (route === "turnos/abrir") return method === "POST" ? openShift(request, env, site, session) : error("metodo_invalido", 405);
  const movement = /^turnos\/([^/]+)\/movimientos$/.exec(route);
  if (movement) return method === "POST" ? addMovement(request, env, site, session, movement[1]) : error("metodo_invalido", 405);
  const close = /^turnos\/([^/]+)\/cerrar$/.exec(route);
  if (close) return method === "POST" ? closeShift(request, env, site, session, close[1]) : error("metodo_invalido", 405);
  const detail = /^turnos\/([^/]+)$/.exec(route);
  if (detail) return method === "GET" ? shiftDetail(env, site, session, detail[1]) : error("metodo_invalido", 405);
  return error("ruta_no_encontrada", 404);
}

// GET turnos/actual?sede_id= — caja abierta (o null) de la sede activa.
async function currentShift(request, env, site, session) {
  const sedeId = (new URL(request.url).searchParams.get("sede_id") || "").trim();
  if (!sedeId) return error("sede_requerida", 400);
  if (!SEDE_ID_RE.test(sedeId)) return error("sede_invalida", 400);
  if (!await authorizedForSede(env, site.slug, session, sedeId)) return error("sin_permiso", 403);
  const shift = await openShiftFor(env, site.slug, sedeId);
  if (!shift) return json({ shift: null });
  const payload = { shift: shiftView(shift, await movementItems(env, site.slug, shift.id)) };
  if (session.owner) payload.report = await shiftReport(env, site.slug, shift);
  return json(payload);
}

// POST turnos/abrir — idempotente por clave; asigna los pagos paid sin turno.
async function openShift(request, env, site, session) {
  const body = await readBody(request);
  if (!body) return error("json_invalido", 400);
  const sedeId = typeof body.sede_id === "string" ? body.sede_id.trim() : "";
  if (!sedeId) return error("sede_requerida", 400);
  if (!SEDE_ID_RE.test(sedeId)) return error("sede_invalida", 400);
  if (!await authorizedForSede(env, site.slug, session, sedeId)) return error("sin_permiso", 403);
  const opening = body.opening_float_cents;
  if (!Number.isInteger(opening) || opening < 0 || opening > MAX_CENTS) return error("fondo_invalido", 400);
  const key = idempotencyKeyOf(body);
  if (!key) return error("idempotency_key_requerida", 400);

  const existing = await shiftByOpenKey(env, site.slug, key);
  if (existing) {
    if (existing.sede_id !== sedeId) return error("idempotencia_conflicto", 409);
    return json({ shift: shiftView(existing, await movementItems(env, site.slug, existing.id)) }, 201);
  }
  const sede = await sedeById(env, site.slug, sedeId);
  if (!sede || !sede.activa) return error("sede_invalida", 400);
  if (await openShiftFor(env, site.slug, sedeId)) return error("caja_ya_abierta", 409);

  const id = crypto.randomUUID(), now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(id, site.slug, sedeId, String(session.staff_id || ""), now, opening, key),
      // Pagos ya cobrados sin turno (tarjeta conciliada con la caja cerrada):
      // pasan al nuevo turno para que el arqueo y el reporte no los pierdan.
      env.DB.prepare(
        "UPDATE pos_payments SET shift_id = ? WHERE slug = ? AND shift_id IS NULL AND status = 'paid' " +
        "AND order_id IN (SELECT id FROM pos_orders WHERE slug = ? AND sede_id = ?)",
      ).bind(id, site.slug, site.slug, sedeId),
    ]);
  } catch {
    // Carrera: ganó el índice parcial o la clave única. Mismo resultado si la
    // clave coincide; si no, otra caja abrió primero.
    const raced = await shiftByOpenKey(env, site.slug, key);
    if (raced) {
      if (raced.sede_id !== sedeId) return error("idempotencia_conflicto", 409);
      return json({ shift: shiftView(raced, await movementItems(env, site.slug, raced.id)) }, 201);
    }
    if (await openShiftFor(env, site.slug, sedeId)) return error("caja_ya_abierta", 409);
    return error("turno_no_creado", 502);
  }
  const created = await shiftById(env, site.slug, id);
  return json({ shift: shiftView(created, []) }, 201);
}

// POST turnos/:id/movimientos — ingreso/retiro de efectivo con motivo.
async function addMovement(request, env, site, session, encodedId) {
  const id = decodedId(encodedId);
  const shift = id && await shiftById(env, site.slug, id);
  if (!shift) return error("turno_no_existe", 404);
  if (!await authorizedForSede(env, site.slug, session, shift.sede_id)) return error("sin_permiso", 403);
  const body = await readBody(request);
  if (!body) return error("json_invalido", 400);
  if (!KINDS.has(body.kind)) return error("movimiento_invalido", 400);
  const amount = body.amount_cents;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_CENTS) return error("monto_invalido", 400);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const length = [...reason].length;
  if (length < MIN_REASON || length > MAX_REASON) return error("motivo_invalido", 400);
  const key = idempotencyKeyOf(body);
  if (!key) return error("idempotency_key_requerida", 400);

  const existing = await movementByKey(env, site.slug, key);
  if (existing) return movementIdempotent(existing, shift.id, body.kind, amount, reason);
  const movementId = crypto.randomUUID(), now = Date.now();
  // Condicionado al turno abierto: una carrera con el cierre no agrega movimientos.
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO pos_cash_movements (id, slug, shift_id, kind, amount_cents, reason, staff_id, idempotency_key, created_at) " +
    "SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? " +
    "WHERE EXISTS (SELECT 1 FROM pos_shifts WHERE slug = ? AND id = ? AND status = 'open')",
  ).bind(
    movementId, site.slug, shift.id, body.kind, amount, reason, String(session.staff_id || ""), key, now,
    site.slug, shift.id,
  ).run();
  if (!inserted.meta.changes) {
    const raced = await movementByKey(env, site.slug, key);
    if (raced) return movementIdempotent(raced, shift.id, body.kind, amount, reason);
    const current = await shiftById(env, site.slug, shift.id);
    return current?.status === "closed" ? error("turno_cerrado", 409) : error("turno_no_existe", 404);
  }
  return json({ movement: movementResponse(await movementByKey(env, site.slug, key)) }, 201);
}

// Misma clave con el mismo cuerpo ⇒ misma respuesta; con otro cuerpo ⇒ conflicto.
function movementIdempotent(row, shiftId, kind, amount, reason) {
  if (row.shift_id !== shiftId || row.kind !== kind || Number(row.amount_cents) !== amount || row.reason !== reason) {
    return error("idempotencia_conflicto", 409);
  }
  return json({ movement: movementResponse(row) }, 201);
}

// POST turnos/:id/cerrar — calcula, guarda el snapshot y cierra en un batch
// condicionado a status='open'. Reintento con la misma clave: mismo reporte.
async function closeShift(request, env, site, session, encodedId) {
  const id = decodedId(encodedId);
  const shift = id && await shiftById(env, site.slug, id);
  if (!shift) return error("turno_no_existe", 404);
  if (!await authorizedForSede(env, site.slug, session, shift.sede_id)) return error("sin_permiso", 403);
  const body = await readBody(request);
  if (!body) return error("json_invalido", 400);
  const counted = body.counted_cash_cents;
  if (!Number.isInteger(counted) || counted < 0 || counted > MAX_CENTS) return error("conteo_invalido", 400);
  const key = idempotencyKeyOf(body);
  if (!key) return error("idempotency_key_requerida", 400);
  const note = body.note == null ? "" : typeof body.note === "string" ? body.note.trim() : null;
  if (note == null || [...note].length > MAX_NOTE) return error("nota_invalida", 400);

  if (shift.status === "closed") {
    return shift.close_key === key
      ? json({ report: await shiftReport(env, site.slug, shift) })
      : error("turno_cerrado", 409);
  }
  // 1) Reclamar el cierre primero: al pasar a `closed` dejan de entrar pagos y
  //    movimientos (sus INSERT se condicionan a `status = 'open'`), así el
  //    reporte que se congela abajo ya no tiene ventana de carrera.
  const now = Date.now(), closedBy = String(session.staff_id || "");
  const claimed = await env.DB.prepare(
    "UPDATE pos_shifts SET status = 'closed', closed_by = ?, closed_at = ?, close_key = ? " +
    "WHERE slug = ? AND id = ? AND status = 'open'",
  ).bind(closedBy, now, key, site.slug, shift.id).run();
  if (!claimed.meta.changes) {
    const raced = await shiftById(env, site.slug, shift.id);
    return raced?.status === "closed" && raced.close_key === key
      ? json({ report: await shiftReport(env, site.slug, raced) })
      : error("turno_cerrado", 409);
  }
  // 2) Reporte sobre el turno ya cerrado y snapshot inmutable.
  const report = await liveReport(env, site.slug, await shiftById(env, site.slug, shift.id));
  const expected = report.expected_cash_cents, difference = counted - expected;
  const snapshot = {
    ...report, status: "closed", counted_cash_cents: counted, difference_cents: difference, note,
  };
  await env.DB.prepare(
    "UPDATE pos_shifts SET counted_cash_cents = ?, expected_cash_cents = ?, difference_cents = ?, totals = ?, note = ? " +
    "WHERE slug = ? AND id = ? AND status = 'closed'",
  ).bind(
    counted, expected, difference, JSON.stringify(snapshot), note || null, site.slug, shift.id,
  ).run();
  return json({ report: await shiftReport(env, site.slug, await shiftById(env, site.slug, shift.id)) });
}

// GET turnos/:id — reporte para reimprimir el Z. El cajero solo ve turnos
// cerrados de sus sedes; el dueño ve cualquiera.
async function shiftDetail(env, site, session, encodedId) {
  const id = decodedId(encodedId);
  const shift = id && await shiftById(env, site.slug, id);
  if (!shift) return error("turno_no_existe", 404);
  if (!await authorizedForSede(env, site.slug, session, shift.sede_id)) return error("sin_permiso", 403);
  if (!session.owner && shift.status !== "closed") return error("sin_permiso", 403);
  return json({ report: await shiftReport(env, site.slug, shift) });
}

// GET turnos?sede_id=&from=&to=&limit= — historial, solo el dueño.
async function listShifts(request, env, site, session) {
  if (!session.owner) return error("sin_permiso", 403);
  const query = new URL(request.url).searchParams;
  const sedeId = (query.get("sede_id") || "").trim();
  if (sedeId && !SEDE_ID_RE.test(sedeId)) return error("sede_invalida", 400);
  const from = query.get("from") || "", to = query.get("to") || "";
  const range = from === "" && to === "" ? null : salesRange(from, to);
  if ((from !== "" || to !== "") && !range) return error("fechas_invalidas", 400);
  const limit = limitOf(query.get("limit"));
  if (limit == null) return error("paginacion_invalida", 400);

  const clauses = ["slug = ?"], values = [site.slug];
  if (sedeId) { clauses.push("sede_id = ?"); values.push(sedeId); }
  // Las fechas de Ecuador filtran por la apertura del turno.
  if (range) { clauses.push("opened_at >= ?", "opened_at < ?"); values.push(range.start, range.end); }
  const rows = (await env.DB.prepare(
    "SELECT id, sede_id, status, opened_at, closed_at, opened_by, closed_by, opening_float_cents, " +
    "expected_cash_cents, counted_cash_cents, difference_cents, totals FROM pos_shifts " +
    `WHERE ${clauses.join(" AND ")} ORDER BY opened_at DESC, rowid DESC LIMIT ?`,
  ).bind(...values, limit).all()).results || [];
  const totals = await salesTotals(env, site.slug, rows.map(row => row.id));
  return json({
    shifts: rows.map(row => {
      const stored = row.status === "closed" ? parseJson(row.totals) : null;
      const total = stored && Number.isInteger(stored.sales_total_cents)
        ? stored.sales_total_cents : totals.get(row.id) || 0;
      return {
        id: row.id, sede_id: row.sede_id, status: row.status,
        opened_at: whole(row.opened_at),
        closed_at: row.closed_at == null ? null : whole(row.closed_at),
        opened_by: row.opened_by, closed_by: row.closed_by || null,
        opening_float_cents: whole(row.opening_float_cents),
        expected_cash_cents: row.expected_cash_cents == null ? null : whole(row.expected_cash_cents),
        counted_cash_cents: row.counted_cash_cents == null ? null : whole(row.counted_cash_cents),
        difference_cents: row.difference_cents == null ? null : whole(row.difference_cents),
        total_cents: total,
      };
    }),
  });
}

async function salesTotals(env, slug, ids) {
  if (!ids.length) return new Map();
  const rows = await env.DB.prepare(
    "SELECT shift_id, COALESCE(SUM(amount_cents), 0) AS total_cents FROM pos_payments " +
    `WHERE slug = ? AND status = 'paid' AND shift_id IN (${ids.map(() => "?").join(", ")}) GROUP BY shift_id`,
  ).bind(slug, ...ids).all();
  return new Map((rows.results || []).map(row => [row.shift_id, whole(row.total_cents)]));
}

/* ── Utilidades de entrada/salida ────────────────────────────────────────── */

// `request.json()` protegido: cuerpo ausente, roto o no-objeto ⇒ null (400).
async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch { return null; }
}

function idempotencyKeyOf(body) {
  const key = typeof body?.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  return IDEM_RE.test(key) ? key : "";
}

function limitOf(raw) {
  if (raw == null || raw === "") return DEFAULT_LIMIT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= MAX_LIMIT ? value : null;
}

function decodedId(encoded) { try { return decodeURIComponent(encoded); } catch { return null; } }

function parseJson(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// D1/SQLite devuelve enteros; un valor ausente nunca se convierte a float.
function whole(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
