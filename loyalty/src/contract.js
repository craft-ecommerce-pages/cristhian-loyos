// Contrato compartido del Worker craft-loyalty. NO cambiar sin avisar al integrador (ver loyalty/PLAN.md).
// Lógica pura: sin env, sin fetch, sin D1.

export const GAMES = ["wheel", "scratch"];
export const PLAY_MODES = ["game", "stamps"];  // "game" = sello + minijuego; "stamps" = solo sellos
export const STAMPS_PRIZE_ID = "__stamps";     // prize_id de los premios por completar la tarjeta
export const BIRTHDAY_PRIZE_ID = "__birthday"; // prize_id del regalo automático de cumpleaños
export const WINBACK_PRIZE_ID = "__winback";   // prize_id del regalo para clientes inactivos
export const MAX_PIN_FAILS = 5;                // fallos de PIN por premio antes de bloquear el canje
export const SESSION_COOKIE = "club_s";
export const DEVICE_COOKIE = "club_d";
export const MAX_PHONES_PER_DEVICE = 3;
export const MAX_PIN_FAILS_DEVICE = 10;
export const CARD_CODE_LENGTH = 10;
// Sin 0/O/1/I/L: se dicta y se escribe a mano sin ambigüedad.
export const CARD_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// Config del programa: KV `{slug}:loyalty` (la escribe craft-crm). Sin la clave = club apagado (404).
// {
//   enabled: true,
//   games: ["wheel","scratch"],              // juegos ofrecidos; el cliente elige si hay más de uno
//   prizes: [{ id, label, weight, stock?, expires_days? }],  // stock = máx. emitidos en total (null = ilimitado)
//   lose_weight: 70,                         // peso de "Sigue participando" (0 = siempre gana)
//   stamps_goal: 8, stamps_reward: { label, expires_days? },
//   cooldown_hours: 12, radius_m: 150, phone_country: "593",
//   play_mode: "game",                       // "stamps" = cada visita validada suma 1 sello, sin minijuego
//   staff_pin_hash: "<sha256 hex de `${slug}:${pin}`>",
//   review_url: "https://g.page/r/...",      // se ofrece DESPUÉS del premio, nunca como condición
//   terms: "texto corto",
//   birthday: { enabled, label, expires_days },              // regalo automático de cumpleaños
//   winback: { enabled, days, label, expires_days }          // regalo para clientes inactivos
// }
export function normalizeConfig(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const prizes = (Array.isArray(c.prizes) ? c.prizes : [])
    .filter(p => p && /^[a-z0-9_-]{1,40}$/.test(p.id) && p.id !== STAMPS_PRIZE_ID && typeof p.label === "string" && p.label.trim() && num(p.weight, 0) > 0)
    .map(p => ({ id: p.id, label: p.label.trim(), weight: num(p.weight, 0), stock: p.stock == null ? null : Math.max(0, Math.floor(num(p.stock, 0))), expires_days: posOrNull(p.expires_days) }));
  return {
    enabled: c.enabled === true,
    games: (Array.isArray(c.games) ? c.games.filter(g => GAMES.includes(g)) : []).length ? c.games.filter(g => GAMES.includes(g)) : [...GAMES],
    prizes,
    lose_weight: Math.max(0, num(c.lose_weight, 70)),
    stamps_goal: Math.max(1, Math.floor(num(c.stamps_goal, 8))),
    stamps_reward: { label: str(c.stamps_reward?.label) || "Premio por completar tu tarjeta", expires_days: posOrNull(c.stamps_reward?.expires_days) },
    cooldown_hours: Math.max(0, num(c.cooldown_hours, 12)),
    play_mode: PLAY_MODES.includes(c.play_mode) ? c.play_mode : "game",
    radius_m: Math.max(10, num(c.radius_m, 150)),
    phone_country: /^\d{1,3}$/.test(c.phone_country) ? c.phone_country : "593",
    staff_pin_hash: /^[0-9a-f]{64}$/.test(c.staff_pin_hash) ? c.staff_pin_hash : null,
    require_pin: c.require_pin === true,
    review_url: /^https:\/\//.test(c.review_url) ? c.review_url : null,
    terms: str(c.terms),
    birthday: {
      enabled: c.birthday?.enabled === true,
      label: str(c.birthday?.label) || "Regalo de cumpleaños",
      expires_days: daysOr(c.birthday?.expires_days, 14),
    },
    winback: {
      enabled: c.winback?.enabled === true,
      days: Math.max(14, Math.floor(num(c.winback?.days, 30))), // nunca menos de dos semanas
      label: str(c.winback?.label) || "Un premio de bienvenida",
      expires_days: daysOr(c.winback?.expires_days, 14),
    },
  };
}

// Segmentos de la ruleta en orden estable: premios configurados y, si lose_weight > 0, "Sigue participando" al final.
// play devuelve `segment_index` sobre esta lista; la página la recibe en /me (program.segments).
export function segments(cfg) {
  const s = cfg.prizes.map(p => ({ id: p.id, label: p.label, weight: p.weight }));
  if (cfg.lose_weight > 0) s.push({ id: null, label: "Sigue participando", weight: cfg.lose_weight });
  return s;
}

// Cumpleaños sin año: "MM-DD". 29/02 se acepta (solo cae en años bisiestos). Inválido → null.
export function normalizeBirthday(input) {
  const m = /^(\d{2})-(\d{2})$/.exec(typeof input === "string" ? input.trim() : "");
  if (!m) return null;
  const month = Number(m[1]),
    day = Number(m[2]);
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month] ? m[0] : null;
}

// Teléfono → solo dígitos con código de país. "0991234567" (EC) → "593991234567". Inválido → null.
export function normalizePhone(input, country = "593") {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  else if (d.startsWith("0")) d = country + d.slice(1);
  else if (d.length <= 10 && !d.startsWith(country)) d = country + d;
  return /^\d{10,15}$/.test(d) ? d : null;
}

// URL pública de la tarjeta: es la que abre el QR del pase (Wallet y página del club).
export function cardUrl(slug, code) {
  return `https://${slug}.craft-systems.com/club/t/${code}`;
}

// Acepta el código suelto ("ABCD 2345 EF") o cualquier URL que termine en /club/t/{code}
// (el escáner devuelve el texto del QR tal cual). Devuelve el código en mayúsculas o null.
export function parseCardCode(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  const tail = /\/club\/t\/([0-9A-Z]+)\/?$/i.exec(raw);
  const code = (tail ? tail[1] : raw.replace(/[\s-]/g, "")).toUpperCase();
  return CARD_CODE_RE.test(code) ? code : null;
}

// Distancia en metros (haversine).
export function distanceM(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180, a = Math.sin((lat2 - lat1) * r / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
}

// Sedes con coordenadas válidas del config del MENÚ (KV `{slug}:config` → location.sedes[]).
export function sedesWithCoords(menuCfg) {
  const s = menuCfg?.location?.sedes;
  return (Array.isArray(s) ? s : []).filter(x => Number.isFinite(x?.lat) && Number.isFinite(x?.lng) && Math.abs(x.lat) <= 90 && Math.abs(x.lng) <= 180);
}

const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : d);
const posOrNull = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const str = v => (typeof v === "string" ? v.trim() : "");
const CARD_CODE_RE = new RegExp(`^[${CARD_CODE_ALPHABET}]{${CARD_CODE_LENGTH}}$`);
const daysOr = (v, d) => {
  const n = posOrNull(v);
  return n == null ? d : Math.max(1, Math.floor(n));
};
// Días por mes; febrero admite 29 porque el cumpleaños no guarda año.
const DAYS_IN_MONTH = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
