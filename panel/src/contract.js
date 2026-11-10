// Contrato compartido del panel (NO cambiar sin avisar al integrador). Ver panel/PLAN.md.
export const SESSION_COOKIE = "panel_s";
export const PBKDF2_ITERATIONS = 100000;          // máximo soportado por workerd
export const RESET_TTL_MS = 30 * 60 * 1000;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_TYPES = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
// Origen público de la media. Vacío = rutas relativas `/media/<key>` servidas por
// los Workers del cliente desde su binding R2 (workers.dev o dominio propio).
// Nunca se usa la cuenta Craft ni un origen fijo de otro cliente.
export const STORE_FIELDS = ["whatsapp_number", "hours", "location", "logo", "hero_title", "brand_sub", "delivery_fee", "cross_sell", "search_placeholder"];
export const EVENT_TYPES = ["view", "order"];
export const TZ_OFFSET_MS = -5 * 3600 * 1000;      // Ecuador

// Funciones por plan (D1 `panel_features`). Sin fila = habilitado.
export const FEATURE_SOURCES = ["saas", "addon", "legacy", "admin"];  // admin = superadmin del CRM
// Defaults de cumpleaños e inactivos; deben coincidir con loyalty/src/contract.js.
export const BIRTHDAY_DEFAULT = { enabled: false, label: "Regalo de cumpleaños", expires_days: 14 };
export const WINBACK_DEFAULT = { enabled: false, days: 30, label: "Un premio de bienvenida", expires_days: 14 };

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json;charset=utf-8", "cache-control": "no-store", ...headers } });
export const error = (code, status, extra = {}) => json({ error: code, ...extra }, status);
export const noContent = (headers = {}) => new Response(null, { status: 204, headers });

// Día local Ecuador de un epoch ms → "YYYY-MM-DD".
export const dayOf = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);

// Origen público de media: `MEDIA_ORIGIN` (var del Worker) sin barra final.
// Vacío ⇒ "" para publicar rutas relativas `/media/<key>`.
export function mediaOrigin(env) {
  const raw = typeof env?.MEDIA_ORIGIN === "string" ? env.MEDIA_ORIGIN.trim() : "";
  return /^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i.test(raw) ? raw.replace(/\/+$/, "") : "";
}

// URL pública de una clave R2. Las claves se guardan sin prefijo (`panel/...`).
export function mediaUrl(env, key) {
  const clean = String(key || "").replace(/^\/+/, "");
  return `${mediaOrigin(env)}/media/${clean}`;
}

// ¿Es una URL de media aceptable? Acepta la forma nueva (`/media/...` o
// `${MEDIA_ORIGIN}/media/...`) y, solo por compatibilidad de datos ya
// guardados, la media legacy de Craft. Nunca se genera una URL legacy.
export function isMediaUrl(env, value) {
  if (typeof value !== "string" || !value || value.length > 2048) return false;
  if (/^\/media\/[A-Za-z0-9._/-]+$/.test(value)) return true;
  const origin = mediaOrigin(env);
  if (origin && value.startsWith(`${origin}/media/`)) return true;
  return /^https:\/\/media\.craft-systems\.com\/[A-Za-z0-9._/-]+$/.test(value);
}
