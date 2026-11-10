// Dobles de prueba: D1 sobre node:sqlite (mismas migraciones) y KV en memoria.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);  // panel/migrations

export function makeD1() {
  const db = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async col => { const r = db.prepare(sql).get(...args); return r == null ? null : col ? r[col] : { ...r }; },
    all: async () => ({ results: db.prepare(sql).all(...args).map(r => ({ ...r })), success: true }),
    run: async () => { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
  });
  return {
    prepare: sql => stmt(sql),
    batch: async list => { db.exec("BEGIN"); try { const out = []; for (const s of list) out.push(await s.run()); db.exec("COMMIT"); return out; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    raw: db,
  };
}

export function makeKV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    get: async (k, type) => { const v = m.get(k) ?? null; return v != null && (type === "json" || type?.type === "json") ? JSON.parse(v) : v; },
    put: async (k, v) => void m.set(k, v),
    delete: async k => void m.delete(k),
  };
}

// ctx.waitUntil que acumula promesas para poder esperarlas en el test.
export function makeCtx() {
  const pending = [];
  return { waitUntil: p => pending.push(p), settle: () => Promise.all(pending) };
}

// R2 en memoria (put/get) y rate limiter que siempre deja pasar salvo `deny`.
export function makeR2() {
  const m = new Map();
  return { put: async (k, v, o) => void m.set(k, { v, o }), get: async k => m.get(k) ?? null, map: m };
}
export const makeLimiter = (deny = false) => ({ limit: async () => ({ success: !deny }) });
export function makeEnv(kv = {}) {
  return { MENUS: makeKV(kv), DB: makeD1(), MEDIA: makeR2(), LOGIN_LIMITER: makeLimiter(),
    SESSION_SECRET: "test-secret", ADMIN_TOKEN: "admin-token", LOYALTY_ADMIN_TOKEN: "loy-token",
    LOYALTY: { fetch: async () => new Response(JSON.stringify({ customers: 0, plays: 0 }), { headers: { "content-type": "application/json" } }) } };
}
