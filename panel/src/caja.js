// CJ2: Modo caja — el mesero escanea la tarjeta del cliente desde su celular.
// Página SSR /panel/caja (mobile-first, mismo estilo del panel), sesión propia `caja_s` (12 h) y
// proxy a craft-loyalty (/admin/{slug}/card/*). El staff_id SIEMPRE sale de la sesión: el navegador
// nunca lo envía. La función tarjeta es por plan (panel_features): apagada → 402 plan_requerido.
import { readSession, timingEqual } from "./auth.js";
import { featuresFor } from "./admin.js";
import { error, json, noContent } from "./contract.js";

export const CAJA_COOKIE = "caja_s";
export const CAJA_TTL_MS = 12 * 60 * 60 * 1000;  // 12 h: un turno de caja
export const OWNER_STAFF = "owner";              // staff_id del dueño (sesión del panel)
export const CAJA_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";  // sin 0/O/1/I/L
const SESSION_RE = /^([A-Za-z0-9_-]{1,64})\.(\d{1,16})\.([A-Za-z0-9_-]+)$/;
const STAFF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const REWARD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();

/* ── Código de tarjeta ──────────────────────────────────────────────────────
   Copia literal de loyalty/src/contract.js#parseCardCode: acepta el código suelto (tolera
   espacios/guiones) o una URL que termine en /club/t/{code}; query/hash no valen.
   No se importa porque se serializa al navegador con String(): el regex debe ser propio. */
export function parseCardCode(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return null;
  const tail = /\/club\/t\/([0-9A-Z]+)\/?$/i.exec(raw);
  const code = (tail ? tail[1] : raw.replace(/[\s-]/g, "")).toUpperCase();
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/.test(code) ? code : null;
}

/* ── Sesión de caja: `{staff_id}.{exp}.{hmac}` ─────────────────────────────── */

// → valor de cookie; HMAC-SHA256(SESSION_SECRET) sobre `caja:{slug}:{staff_id}:{exp}`.
export async function signCajaSession(env, slug, staffId, exp = Date.now() + CAJA_TTL_MS) {
  return `${staffId}.${exp}.${await cajaHmac(env, slug, staffId, exp)}`;
}

// → {staff_id, exp} | null (firma, slug y vencimiento).
export async function readCajaSession(request, env, slug) {
  const match = SESSION_RE.exec(cookieOf(request.headers.get("cookie"), CAJA_COOKIE) || "");
  if (!match || Number(match[2]) <= Date.now()) return null;
  const expected = await cajaHmac(env, slug, match[1], match[2]);
  return timingEqual(match[3], expected) ? { staff_id: match[1], exp: Number(match[2]) } : null;
}

// Sesión efectiva: cookie de caja o sesión del dueño del panel (staff_id="owner"). null ⇒ 401.
export async function cajaSession(request, env, site) {
  const caja = await readCajaSession(request, env, site.slug);
  if (caja) return { staff_id: caja.staff_id, owner: false };
  const panel = await readSession(request, env, site.slug);
  return panel ? { staff_id: OWNER_STAFF, owner: true } : null;
}

const cookieValue = value => `${CAJA_COOKIE}=${value}; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=${CAJA_TTL_MS / 1000}`;
const expiredCookie = () => `${CAJA_COOKIE}=; Path=/panel; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function cajaHmac(env, slug, staffId, exp) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!secret) throw new Error("SESSION_SECRET no configurado");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`caja:${slug}:${staffId}:${exp}`));
  return b64url(signature);
}

function b64url(buffer) {
  let text = "";
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function cookieOf(header, name) {
  const part = (header || "").split(";").map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : null;
}

/* ── API /panel/api/caja/* (proxy a craft-loyalty) ─────────────────────────── */

export async function handleCajaApi(request, env, site, path) {
  const action = path === "caja" ? "" : path.slice("caja/".length);
  if (request.method === "POST" && action === "login") return cajaLogin(request, env, site);
  if (request.method === "POST" && action === "logout") return noContent({ "set-cookie": expiredCookie() });

  const session = await cajaSession(request, env, site);
  if (!session) return error("sin_sesion", 401);
  if (!(await cajaEnabled(env, site.slug))) return error("plan_requerido", 402);

  const card = /^card\/([^/]+)$/.exec(action);
  if (request.method === "GET" && card) return cajaCard(env, site.slug, card[1]);
  const visit = /^card\/([^/]+)\/visit$/.exec(action);
  if (request.method === "POST" && visit) return cajaVisit(env, site.slug, visit[1], session.staff_id);
  const redeem = /^rewards\/([^/]+)\/redeem$/.exec(action);
  if (request.method === "POST" && redeem) return cajaRedeem(env, site.slug, redeem[1], session.staff_id);
  return error("ruta_no_encontrada", 404);
}

// PIN del mesero → staff/verify del club. La cookie guarda el staff_id, nunca el PIN.
async function cajaLogin(request, env, site) {
  if (!(await cajaEnabled(env, site.slug))) return error("plan_requerido", 402);
  if (await limited(request, env, site.slug)) return error("demasiados_intentos", 429);
  const body = await readJson(request);
  const pin = typeof body?.pin === "string" ? body.pin : "";
  if (!/^\d{4,6}$/.test(pin)) return error("pin_invalido", 403);
  const result = await loyalty(env, site.slug, "staff/verify", { method: "POST", body: { pin } });
  if (!result) return error("club_no_disponible", 503);
  if (result.status === 403) return error("pin_invalido", 403);
  if (result.status < 200 || result.status >= 300) return relay(result);
  const staff = result.body?.staff;
  const id = typeof staff?.id === "string" ? staff.id : "";
  if (!STAFF_RE.test(id)) return error("club_no_disponible", 503);
  const name = typeof staff?.name === "string" ? staff.name.slice(0, 120) : "";
  return json({ staff: { name } }, 200, { "set-cookie": cookieValue(await signCajaSession(env, site.slug, id)) });
}

async function cajaCard(env, slug, encodedCode) {
  const code = cardCode(encodedCode);
  if (!code) return error("codigo_invalido", 400);
  return relay(await loyalty(env, slug, `card/${code}`));
}

async function cajaVisit(env, slug, encodedCode, staffId) {
  const code = cardCode(encodedCode);
  if (!code) return error("codigo_invalido", 400);
  // El body del navegador se ignora por completo: solo viaja el staff_id de la sesión.
  return relay(await loyalty(env, slug, `card/${code}/visit`, { method: "POST", body: { staff_id: staffId } }));
}

async function cajaRedeem(env, slug, encodedId, staffId) {
  let id;
  try { id = decodeURIComponent(encodedId); } catch { return error("premio_no_encontrado", 404); }
  if (!REWARD_RE.test(id)) return error("premio_no_encontrado", 404);
  return relay(await loyalty(env, slug, `rewards/${encodeURIComponent(id)}/redeem`, {
    method: "POST", body: { staff_id: staffId },
  }));
}

function cardCode(encoded) {
  try { return parseCardCode(decodeURIComponent(encoded)); } catch { return null; }
}

// → {status, body} | null. Nunca propaga excepciones del binding.
async function loyalty(env, slug, path, init = {}) {
  if (!env.LOYALTY || typeof env.LOYALTY.fetch !== "function" || !env.LOYALTY_ADMIN_TOKEN) return null;
  try {
    const headers = { authorization: `Bearer ${env.LOYALTY_ADMIN_TOKEN}` };
    const options = { method: init.method || "GET", headers };
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(init.body);
    }
    const response = await env.LOYALTY.fetch(`https://loyalty/admin/${encodeURIComponent(slug)}/${path}`, options);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } catch { return null; }
}

function relay(result) {
  if (!result) return error("club_no_disponible", 503);
  if (result.status === 204) return noContent();
  const body = result.body && typeof result.body === "object" ? result.body : {};
  return json(body, result.status);
}

async function cajaEnabled(env, slug) {
  return (await featuresFor(env, slug)).loyalty;
}

async function limited(request, env, slug) {
  if (!env.LOGIN_LIMITER) return false;
  const ip = request.headers.get("cf-connecting-ip") || "sin-ip";
  return !(await env.LOGIN_LIMITER.limit({ key: `${slug}:${ip}` })).success;
}

async function readJson(request) {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/* ── Página SSR /panel/caja ──────────────────────────────────────────────── */

// `ready` se decide en el servidor (cookie caja_s o sesión del dueño) para no pedir PIN de más.
export async function renderCajaPage(request, env, site) {
  const slug = String(site?.slug ?? "");
  const [session, config, features] = await Promise.all([
    cajaSession(request, env, site).catch(() => null),
    env.MENUS.get(`${slug}:config`, "json").catch(() => null),
    featuresFor(env, slug).catch(() => ({ loyalty: true })),
  ]);
  const stored = config && typeof config.store_name === "string" ? config.store_name.trim() : "";
  const store = stored || slug || "Mi negocio";
  const locked = features.loyalty === false;
  const data = { slug, store, ready: Boolean(session) && !locked, locked };
  const title = "Modo caja · " + store;
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111820">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CAJA_CSS}</style>
</head>
<body>
<header class="top">
<a class="top-back" href="/panel" rel="noreferrer">← Panel</a>
<span class="top-name">${esc(store)}</span>
<span class="top-tag">Modo caja</span>
</header>
<main id="caja" class="wrap">
<div class="boot" role="status"><span class="spin" aria-hidden="true"></span>Cargando Modo caja…</div>
</main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script id="cajaData">var __name=function(f){return f};window.__CAJA__=${inline(data)};</script>
<script id="cajaCode">var __code=${String(parseCardCode)};window.__cajaCode=__code;</script>
<script id="cajaMain">${String(cajaRuntime)}
cajaRuntime();</script>
</body>
</html>`;
}

// HTML dentro de <script>: neutraliza el cierre de etiqueta y separadores de línea.
function inline(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* Estilos del panel (mismos tokens y formas), pensados para el celular del mesero. */
const CAJA_CSS = `*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--p:#C4691C;--p-hover:#A95612;--on-p:#17130F;--bg:#F6F5F2;--card:#fff;--soft:#F2F0EC;--ink:#1F1D1A;--ink2:#5C5850;--muted:#8C877E;--line:#E3DFD8;--line2:#D2CDC4;--danger:#C4362F;--ok:#1F7A55;--side:#111820;--side-ink:#f4f7fa;--side-ink2:#aab6c0}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;-webkit-text-size-adjust:100%}
h1,h2{margin:0;letter-spacing:-.01em}
h1{font-size:23px;line-height:1.2}
h2{font-size:15px;font-weight:700;margin:0 0 10px}
a{color:var(--p)}
.top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:var(--side);color:var(--side-ink)}
.top-back{color:var(--side-ink2);font-size:13px;text-decoration:none;flex:none}
.top-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.top-tag{flex:none;color:#ffad68;font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.wrap{max-width:520px;margin:0 auto;padding:16px 14px calc(32px + env(safe-area-inset-bottom))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.muted{margin:0 0 12px;color:var(--ink2)}
.hint{margin:8px 0 0;color:var(--muted);font-size:12.5px;line-height:1.45}
.boot{display:flex;align-items:center;justify-content:center;gap:10px;min-height:45vh;color:var(--muted);font-size:13.5px}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(196,105,28,.18);border-top-color:var(--p);animation:spin .7s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.field{display:block;margin:0 0 12px}
.field span{display:block;margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink2)}
input{width:100%;padding:12px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--ink);font:inherit;font-size:17px;outline:none;-webkit-appearance:none;appearance:none}
input:focus{border-color:var(--p);background:#fff;box-shadow:0 0 0 3px rgba(196,105,28,.12)}
.pin input{font-size:26px;letter-spacing:.35em;text-align:center;height:60px;font-variant-numeric:tabular-nums}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:50px;padding:10px 18px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;font-size:15.5px;font-weight:600;text-decoration:none;cursor:pointer;transition:background .13s,border-color .13s}
.btn:hover{background:var(--soft)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--p);border-color:var(--p);color:#fff}
.btn.primary:hover{background:var(--p-hover);border-color:var(--p-hover)}
.btn.ghost{background:transparent}
.btn.wide{width:100%}
.btn.small{min-height:42px;padding:8px 14px;font-size:14px}
.btn.link{min-height:36px;padding:6px 4px;border:0;background:none;color:var(--ink2);font-size:13.5px}
.err{margin:10px 0 0;color:var(--danger);font-size:13.5px;font-weight:600}
.err:empty{display:none}
.banner{margin:0 0 14px;padding:12px 14px;border:1px solid rgba(31,122,85,.3);border-radius:10px;background:rgba(31,122,85,.08);color:var(--ok);font-size:14px;font-weight:600}
.actions{display:flex;flex-direction:column;gap:10px;margin-top:16px}
video{display:block;width:100%;aspect-ratio:1/1;object-fit:cover;border:1px solid var(--line);border-radius:14px;background:#0d0d10}
.cam{margin:0 0 14px}
.cam-note{margin:10px 0 0;color:var(--muted);font-size:12.5px;text-align:center}
.who{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:0 0 4px}
.who strong{font-size:21px;letter-spacing:-.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.who .tail{flex:none;color:var(--ink2);font-size:14px;font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;margin:14px 0 0;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.stat{background:var(--card);padding:14px}
.stat b{display:block;font-size:26px;line-height:1.15;font-weight:700;font-variant-numeric:tabular-nums}
.stat span{display:block;margin-top:2px;color:var(--muted);font-size:12px}
.rewards{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.reward{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}
.reward:last-child{border-bottom:0}
.reward span{min-width:0;overflow-wrap:anywhere;font-size:14.5px}
.empty{padding:16px 0;text-align:center;color:var(--muted);font-size:13.5px}
.notice{margin:0 0 14px;padding:12px 14px;border:1px solid rgba(196,105,28,.3);border-radius:10px;background:rgba(196,105,28,.06);color:var(--ink2);font-size:13.5px}
.toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));z-index:60;max-width:min(92vw,420px);padding:10px 16px;border-radius:10px;background:#1F1D1A;color:#fff;font-size:13px;font-weight:500;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;pointer-events:none;transform:translate(-50%,8px);transition:opacity .2s,transform .2s}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--danger)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/* ── Runtime del navegador: se serializa con String() y se inyecta sin build ── */
function cajaRuntime() {
  const S = window.__CAJA__ || {};
  const parse = typeof window.__cajaCode === "function" ? window.__cajaCode : () => null;
  const root = document.getElementById("caja");
  const toastEl = document.getElementById("toast");
  const FRAME_MS = 260;
  const JSQR_URL = "https://cdnjs.cloudflare.com/ajax/libs/jsQR/1.4.0/jsQR.min.js";
  const MESSAGES = {
    pin_invalido: "PIN incorrecto. Revísalo con el dueño del menú.",
    demasiados_intentos: "Demasiados intentos. Espera unos minutos y vuelve a probar.",
    plan_requerido: "La tarjeta de fidelidad no está activa en este menú.",
    sin_sesion: "Tu sesión venció. Vuelve a entrar con tu PIN.",
    club_no_disponible: "No pudimos conectar con el club. Reintenta en un momento.",
    tarjeta_no_encontrada: "No encontramos esa tarjeta. Revisa el código e intenta otra vez.",
    codigo_invalido: "Ese código no es de una tarjeta: son 10 caracteres, sin 0, O, 1, I ni L.",
    premio_no_encontrado: "Ese premio ya no está disponible.",
    mesero_inactivo: "Tu usuario ya no está activo. Pide al dueño del menú que te habilite.",
    visita_pendiente: "El cliente aún no usa su jugada.",
    cooldown: "Ya validaste esta visita.",
  };
  let stream = null, scanning = false, timer = 0, detector = null, canvas = null, jsqr = null;
  let currentCode = "", currentMode = "game", banner = null, busy = false;

  /* utilidades */
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    let value, checked;
    if (attrs) for (const key in attrs) {
      const v = attrs[key];
      if (v == null || v === false) continue;
      if (key === "class") node.className = v;
      else if (key === "text") node.textContent = v;
      else if (key === "value") value = v;
      else if (key === "checked") checked = !!v;
      else if (key.startsWith("on") && typeof v === "function") node.addEventListener(key.slice(2), v);
      else node.setAttribute(key, v === true ? "" : String(v));
    }
    if (value !== undefined) node.value = value;
    if (checked !== undefined) node.checked = checked;
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  }
  const btn = (label, cls, onclick, extra) => h("button", Object.assign({ type: "button", class: cls, onclick }, extra || {}), label);
  const messageOf = (result, fallback) => (result && result.data && MESSAGES[result.data.error]) || fallback;
  let toastTimer = 0;
  function toast(message, bad) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3200);
  }
  async function call(path, body, method) {
    const options = {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: method || (body === undefined ? "GET" : "POST"),
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers["content-type"] = "application/json";
    }
    try {
      const response = await fetch("/panel/api/caja/" + path, options);
      return { status: response.status, data: response.status === 204 ? {} : await response.json().catch(() => ({})) };
    } catch { return { status: 0, data: {} }; }
  }
  const digits = (value, max) => String(value ?? "").replace(/\D/g, "").slice(0, max);

  /* cámara */
  function stopCamera() {
    scanning = false;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (stream) {
      try { stream.getTracks().forEach(track => track.stop()); } catch { /* ya cerrada */ }
      stream = null;
    }
  }
  function loadJsQR() {
    if (typeof window.jsQR === "function") return Promise.resolve(window.jsQR);
    if (jsqr) return jsqr;
    jsqr = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = JSQR_URL;
      script.async = true;
      script.onload = () => resolve(typeof window.jsQR === "function" ? window.jsQR : null);
      script.onerror = () => resolve(null);
      document.head.append(script);
    });
    return jsqr;
  }
  // Lee un frame del <video>: BarcodeDetector nativo si existe; si no, jsQR sobre un canvas.
  async function readFrame(video) {
    if (detector) {
      const found = await detector.detect(video);
      return found && found.length ? found[0].rawValue : null;
    }
    const decode = await loadJsQR();
    if (!decode || !video.videoWidth) return null;
    if (!canvas) canvas = document.createElement("canvas");
    const width = Math.min(640, video.videoWidth);
    const height = Math.max(1, Math.round(video.videoHeight * (width / video.videoWidth)));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    const image = context.getImageData(0, 0, width, height);
    const found = decode(image.data, width, height, { inversionAttempts: "dontInvert" });
    return found && found.data ? found.data : null;
  }
  function buzz() {
    if (typeof navigator.vibrate === "function") { try { navigator.vibrate(60); } catch { /* sin vibración */ } }
  }

  /* pantalla: PIN */
  function pinScreen(notice) {
    stopCamera();
    const pin = h("input", { type: "password", inputmode: "numeric", autocomplete: "one-time-code",
      maxlength: "6", placeholder: "••••", "aria-label": "PIN del mesero" });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h("button", { type: "submit", class: "btn primary wide" }, "Entrar");
    pin.addEventListener("input", () => { pin.value = digits(pin.value, 6); });
    const form = h("form", { class: "card pin", novalidate: true },
      h("h1", { text: "Modo caja" }),
      h("p", { class: "muted", text: "Entra con tu PIN de mesero para validar visitas y canjear premios." }),
      h("label", { class: "field" }, h("span", { text: "PIN del mesero" }), pin),
      submit, err);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      err.textContent = "";
      if (!/^\d{4,6}$/.test(pin.value)) { err.textContent = "El PIN tiene entre 4 y 6 dígitos."; return; }
      submit.disabled = true;
      submit.textContent = "Entrando…";
      const result = await call("login", { pin: pin.value });
      submit.disabled = false;
      submit.textContent = "Entrar";
      if (result.status === 200) return scanner();
      pin.value = "";
      pin.focus();
      err.textContent = messageOf(result, "No pudimos entrar. Revisa tu PIN.");
    });
    root.replaceChildren(h("section", { class: "screen" },
      notice ? h("p", { class: "notice", text: notice }) : null, form));
    pin.focus();
  }

  /* pantalla: escáner */
  function scanner() {
    stopCamera();
    const video = h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Cámara para escanear la tarjeta" });
    const note = h("p", { class: "cam-note", text: "Pide la tarjeta del cliente y apunta al QR." });
    const cam = h("div", { class: "cam" }, video, note);
    const manual = h("input", { type: "text", inputmode: "text", autocomplete: "off", autocapitalize: "characters",
      spellcheck: "false", maxlength: "10", placeholder: "ABCD2345EF", "aria-label": "Código de la tarjeta" });
    const err = h("p", { class: "err", role: "alert" });
    manual.addEventListener("input", () => {
      manual.value = manual.value.toUpperCase().replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, "").slice(0, 10);
    });
    const form = h("form", { class: "card", novalidate: true },
      h("h2", { text: "Escribir código" }),
      h("label", { class: "field" }, h("span", { text: "10 caracteres de la tarjeta" }), manual),
      h("button", { type: "submit", class: "btn wide" }, "Buscar tarjeta"),
      err);
    form.addEventListener("submit", event => {
      event.preventDefault();
      err.textContent = "";
      const code = parse(manual.value);
      if (!code) { err.textContent = MESSAGES.codigo_invalido; return; }
      stopCamera();
      loadCard(code);
    });
    root.replaceChildren(h("section", { class: "screen" },
      cam, form,
      h("div", { class: "actions" }, btn("Salir", "btn link", logout))));
    start(video, note, manual);
  }
  // Sin cámara el campo manual queda enfocado: el mesero escribe el código y sigue.
  function cameraFailed(video, note, manual, message) {
    video.hidden = true;
    note.textContent = message;
    manual.focus();
  }
  async function start(video, note, manual) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
      return cameraFailed(video, note, manual, "Este navegador no abre la cámara. Escribe el código de la tarjeta.");
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch {
      return cameraFailed(video, note, manual, "No pudimos abrir la cámara. Revisa el permiso o escribe el código.");
    }
    try { video.srcObject = stream; await video.play(); } catch { /* el navegador la enciende al tocar */ }
    note.textContent = "Apunta al QR de la tarjeta del cliente.";
    if (typeof window.BarcodeDetector === "function") {
      try { detector = new window.BarcodeDetector({ formats: ["qr_code"] }); } catch { detector = null; }
    }
    scanning = true;
    tick(video);
  }
  async function tick(video) {
    if (!scanning) return;
    timer = setTimeout(() => tick(video), FRAME_MS);
    try {
      const text = await readFrame(video);
      if (!scanning) return;  // otro frame ya leyó el código o se cerró la cámara
      const code = text ? parse(text) : null;
      if (!code) return;
      scanning = false;
      stopCamera();
      buzz();
      loadCard(code);
    } catch { /* frame ilegible: sigue con el próximo */ }
  }

  /* pantalla: ficha del cliente */
  async function loadCard(code, notice) {
    stopCamera();
    currentCode = code;
    root.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "card" }, h("p", { class: "muted", text: "Buscando la tarjeta…" }))));
    const result = await call("card/" + encodeURIComponent(code));
    if (result.status === 401) return pinScreen(MESSAGES.sin_sesion);
    if (result.status !== 200) return cardError(code, messageOf(result, "No pudimos leer la tarjeta."));
    renderCard(result.data || {}, notice || "");
  }

  function cardError(code, message) {
    root.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "card" },
        h("h1", { text: "No pudimos abrir la tarjeta" }),
        h("p", { class: "muted", text: message }),
        h("div", { class: "actions" },
          btn("Intentar de nuevo", "btn primary wide", () => loadCard(code)),
          btn("Escanear otro", "btn ghost wide", () => scanner())))));
  }

  function renderCard(data, message) {
    const card = data.card || {};
    // La visita y el canje no devuelven play_mode: se conserva el de la ficha abierta.
    if (data.play_mode === "stamps" || data.play_mode === "game") currentMode = data.play_mode;
    const mode = currentMode;
    const goal = Math.max(1, Math.floor(Number(card.stamps_goal) || 8));
    const stamps = Math.max(0, Math.floor(Number(card.stamps) || 0));
    const credits = card.credits && typeof card.credits === "object" ? card.credits : {};
    const available = Math.max(0, Math.floor(Number(credits.granted) || 0));
    const pending = Math.max(0, Math.floor(Number(credits.pending) || 0));
    const rewards = Array.isArray(card.rewards) ? card.rewards.filter(reward => reward && reward.id) : [];
    const tail = digits(card.phone_tail, 4);
    banner = h("p", { class: "banner", role: "status" });
    banner.textContent = message || "";
    banner.hidden = !message;
    const visit = h("button", { type: "button", class: "btn primary wide" }, "Validar visita");
    visit.addEventListener("click", () => validateVisit(visit));
    root.replaceChildren(h("section", { class: "screen" },
      banner,
      h("div", { class: "card" },
        h("div", { class: "who" },
          h("strong", { text: String(card.name || "Cliente") }),
          h("span", { class: "tail", text: tail ? "••••" + tail : "••••" })),
        h("div", { class: "stats" },
          h("div", { class: "stat" }, h("b", { text: stamps + "/" + goal }), h("span", { text: "sellos" })),
          h("div", { class: "stat" },
            h("b", { text: String(available) }),
            h("span", { text: mode === "stamps" ? "créditos disponibles" : "jugadas disponibles" }))),
        pending ? h("p", { class: "hint", text: pending + " crédito(s) de delivery esperando esta visita." }) : null,
        h("p", { class: "hint", text: mode === "stamps"
          ? "Cada visita suma un sello."
          : "Cada visita habilita una jugada en el celular del cliente." })),
      h("div", { class: "card" },
        h("h2", { text: "Premios activos" }),
        rewards.length
          ? h("ul", { class: "rewards" }, rewards.map(reward => {
            const action = btn("Canjear", "btn small", null);
            action.addEventListener("click", () => redeem(reward, action));
            return h("li", { class: "reward" }, h("span", { text: String(reward.label || "Premio") }), action);
          }))
          : h("p", { class: "empty", text: "Sin premios activos." })),
      h("div", { class: "actions" },
        visit,
        btn("Escanear otro", "btn ghost wide", () => scanner()),
        btn("Salir", "btn link", logout))));
  }

  function showMessage(message) {
    if (!banner) return toast(message, true);
    banner.textContent = message;
    banner.hidden = false;
  }

  async function validateVisit(button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = "Validando…";
    const result = await call("card/" + encodeURIComponent(currentCode) + "/visit", {});
    busy = false;
    button.disabled = false;
    button.textContent = "Validar visita";
    if (result.status === 401) return pinScreen(MESSAGES.sin_sesion);
    if (result.status === 200) return renderCard(result.data || {}, visitMessage(result.data || {}));
    if (result.status === 429 && result.data.error === "cooldown") return showMessage(cooldownMessage(result.data.next_play_at));
    if (result.status === 409 && result.data.error === "visita_pendiente") return showMessage(MESSAGES.visita_pendiente);
    showMessage(messageOf(result, "No pudimos validar la visita. Intenta otra vez."));
  }

  function visitMessage(data) {
    const card = data.card || {};
    if (data.result && data.result.card_completed) {
      const rewards = Array.isArray(card.rewards) ? card.rewards : [];
      const reward = rewards.find(item => item && item.source === "stamps") || rewards[0];
      return reward && reward.label ? "¡Tarjeta completa! Premio: " + reward.label : "¡Tarjeta completa!";
    }
    if (data.credit_id) return "Visita validada: el cliente ya puede jugar desde su celular";
    const goal = Math.max(1, Math.floor(Number(card.stamps_goal) || 8));
    const stamps = Math.max(0, Math.floor(Number(card.stamps) || 0));
    return "Sello sumado (" + stamps + "/" + goal + ")";
  }

  function cooldownMessage(nextPlayAt) {
    const at = Number(nextPlayAt);
    if (!Number.isFinite(at) || at <= 0) return "Ya validaste esta visita.";
    let hour = "";
    try {
      hour = new Date(at).toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit", timeZone: "America/Guayaquil" });
    } catch {
      hour = new Date(at).toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit" });
    }
    return "Ya validaste esta visita. Próxima desde " + hour;
  }

  async function redeem(reward, button) {
    if (busy) return;
    busy = true;
    button.disabled = true;
    button.textContent = "Canjeando…";
    const result = await call("rewards/" + encodeURIComponent(String(reward.id)) + "/redeem", {});
    busy = false;
    button.disabled = false;
    button.textContent = "Canjear";
    if (result.status === 401) return pinScreen(MESSAGES.sin_sesion);
    if (result.status === 200) return loadCard(currentCode, "Premio canjeado.");
    if (result.status === 409) {
      const vencido = result.data && result.data.error === "vencido";
      return showMessage(vencido ? "Ese premio ya venció." : "Ese premio ya se canjeó.");
    }
    showMessage(messageOf(result, "No pudimos canjear el premio."));
  }

  async function logout() {
    stopCamera();
    await call("logout", {});
    pinScreen("");
  }

  function lockedScreen() {
    root.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "card" },
        h("h1", { text: "Modo caja no está disponible" }),
        h("p", { class: "muted", text: "La tarjeta de fidelidad no está activa en este menú." }),
        h("p", { class: "hint", text: "Actívala desde Fidelidad en el panel para usar el escáner." }),
        h("div", { class: "actions" }, h("a", { class: "btn primary wide", href: "/panel" }, "Ir al panel")))));
  }

  /* arranque */
  window.addEventListener("pagehide", stopCamera);
  if (S.locked) return lockedScreen();
  if (S.ready) return scanner();
  return pinScreen("");
}
