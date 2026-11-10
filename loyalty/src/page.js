// Workstream C — página /club: HTML completo (CSS+JS inline, sin librerías), mobile first.
// El shell sale por SSR con la marca del menú y el login; el runtime vanilla consume /club/api/*.
// Los helpers puros se exportan para test y se inyectan al navegador con String(fn): una sola copia.
// El bundle de wrangler (esbuild keepNames) mete __name(...) en esas funciones: la página define un __name nulo.
import { normalizeConfig, segments, sedesWithCoords } from "./contract.js";
import { qrMatrix } from "../../shared/qr.js";

/* ── Helpers puros (los usa el SSR y también el navegador) ── */

// Escapa texto/atributos del cliente (mismo criterio que worker/src/lib.js).
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Grados que hay que girar la ruleta para dejar el centro del segmento `index` bajo el puntero
// (arriba = 270° en coordenadas canvas). Incluye `turns` vueltas completas para el efecto.
export function wheelStopAngle(index, total, turns = 4) {
  const step = 360 / total;
  return turns * 360 + ((270 - (index + 0.5) * step) % 360 + 360) % 360;
}

// % raspado (0-100) a partir de los píxeles ya borrados del canvas.
export function revealPercent(cleared, total) {
  return total > 0 ? Math.max(0, Math.min(100, Math.floor((cleared / total) * 100))) : 0;
}

// Tiempo restante de cooldown en texto corto ("11 h 59 min", "8 min").
export function remainingText(ms) {
  if (!(ms > 0)) return "¡Ya puedes jugar!";
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} h ${String(r).padStart(2, "0")} min` : `${h} h`;
}

// Código de la tarjeta en grupos de 4 para leerlo en voz alta: "ABCD2345EF" → "ABCD 2345 EF".
export function groupCardCode(code) {
  return String(code ?? "").replace(/\s+/g, "").toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

// Texto del vencimiento de un premio: "" sin fecha/pasado, "Vence hoy" a ≤ 24 h y "Vence en N días" al resto.
export function expiryText(expiresAt, now = Date.now()) {
  if (expiresAt == null) return "";
  const left = Number(expiresAt) - now;
  if (!Number.isFinite(left) || left <= 0) return "";
  const days = Math.ceil(left / 86400000);
  return days <= 1 ? "Vence hoy" : `Vence en ${days} días`;
}

// Cumpleaños MM-DD (sin año) a partir de los selects. "" = sin datos, null = incompleto/inválido.
// El 29 de febrero se acepta siempre (no hay año que validar).
export function birthdayValue(day, month) {
  if (!day && !month) return "";
  const d = Number(day), m = Number(month);
  if (!Number.isInteger(d) || !Number.isInteger(m) || m < 1 || m > 12 || d < 1) return null;
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d > max ? null : `${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Selects de día y mes del cumpleaños (opcionales). `prefix` evita ids repetidos entre login y aviso.
export function birthdaySelects(prefix = "clubBday") {
  const months = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio",
    "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const days = Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join("");
  const opts = months.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  return `<div class="bday">
        <select id="${prefix}Day" name="bday_day" aria-label="Día de nacimiento"><option value="">Día</option>${days}</select>
        <select id="${prefix}Month" name="bday_month" aria-label="Mes de nacimiento"><option value="">Mes</option>${opts}</select>
      </div>`;
}

/* ── SSR ── */

const GAME_NAMES = { wheel: "Ruleta", scratch: "Raspadita" };

// Solo https o ruta absoluta del mismo sitio. Evita javascript:/data:/protocol-relative.
export function safeUrl(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^(https:\/\/|\/(?!\/))/i.test(s) ? s : "";
}

// Color de marca: solo hex (los temas del pipeline son hex). Cualquier otra cosa → default.
function hexColor(raw, fallback) {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : fallback;
}

// `program` del contrato (/me) armado desde el menú + el programa. El runtime lo usa como fallback
// antes de tener sesión (login con marca, juegos y premios) y los tests lo verifican.
export function programOf(menuCfg, cfg) {
  const m = menuCfg && typeof menuCfg === "object" ? menuCfg : {};
  const c = normalizeConfig(cfg); // idempotente: index.js ya entrega el config normalizado
  const geo = sedesWithCoords(m).length > 0;
  return {
    store_name: String(m.store_name ?? "").trim() || "el local",
    logo: safeUrl(m.logo),
    theme_primary: hexColor(m.theme_primary || m.theme?.primary, "#E4801C"),
    theme_accent: hexColor(m.theme_accent || m.theme?.accent, "#F5B301"),
    games: [...c.games],
    segments: segments(c).map(s => ({ id: s.id, label: s.label })),
    stamps_goal: c.stamps_goal,
    stamps_reward_label: c.stamps_reward.label,
    cooldown_hours: c.cooldown_hours,
    review_url: c.review_url,
    terms: c.terms,
    geo_required: geo,
    // Mismo criterio que la API: PIN obligatorio si la config lo exige o si el menú no tiene sedes con coordenadas.
    pin_required: cfg?.require_pin === true || c.require_pin === true || !geo,
    // "stamps" = solo sellos (sin ruleta ni raspadita); "game" = sello + jugada (default).
    play_mode: playMode(cfg),
    // Cumpleaños opcional (sección 1 del contrato): `{enabled, label}`. Apagado = la página no lo pide.
    birthday: birthdayOf(cfg),
  };
}

// Modo de juego de la config del club. Se lee del crudo y del normalizado: el contrato lo agrega
// a normalizeConfig y así la página funciona igual antes y después del merge.
export function playMode(cfg) {
  return cfg?.play_mode === "stamps" ? "stamps" : "game";
}

// Config del cumpleaños de la página. Mismo criterio que playMode: se lee del config normalizado
// que expone el contrato (`{slug}:loyalty.birthday`); sin la clave, queda apagado.
export function birthdayOf(cfg) {
  const b = cfg?.birthday && typeof cfg.birthday === "object" ? cfg.birthday : {};
  const label = typeof b.label === "string" ? b.label.trim() : "";
  return { enabled: b.enabled === true, label: label || "Regalo de cumpleaños" };
}

// Campo PIN del mesero (login y jugada). Se comparte para que ambos flujos luzcan igual.
function pinInput(attrs = "") {
  return `<input class="pin-in" name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" autocomplete="one-time-code" aria-label="PIN del mesero (4 a 6 dígitos)"${attrs}>`;
}

function loginHTML(p) {
  const stamps = p.play_mode === "stamps";
  const chips = stamps ? "" : `<div class="chips">${p.games.map(g => `<span class="chip">${esc(GAME_NAMES[g] || g)}</span>`).join("")}</div>`;
  const prizes = p.segments.filter(s => s.id).slice(0, 6).map(s => `<span class="chip soft">${esc(s.label)}</span>`).join("");
  const intro = stamps
    ? `Entra con tu nombre y WhatsApp. Suma un sello en cada visita a ${esc(p.store_name)} y gana premios.`
    : `Entra con tu nombre y WhatsApp. Juega en cada visita a ${esc(p.store_name)}, suma sellos y gana premios.`;
  return `<section class="card login">
    <p class="kicker">Bienvenido</p>
    <h1>Tu club de sellos</h1>
    <p class="muted">${intro}</p>
    <form id="clubLogin" novalidate>
      <label for="clubName">Nombre</label>
      <input id="clubName" name="name" maxlength="60" autocomplete="name" placeholder="Tu nombre" required>
      <label for="clubPhone">WhatsApp</label>
      <input id="clubPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="099 123 4567" required>
      ${p.birthday.enabled ? `<label>Cumpleaños (opcional)</label>
      <p class="muted small bday-note">Te enviamos un regalo en tu cumpleaños.</p>
      ${birthdaySelects("clubLoginBday")}` : ""}
      <label for="clubLoginPin" id="clubLoginPinLabel" hidden>PIN del mesero</label>
      ${pinInput(' id="clubLoginPin" hidden')}
      <button class="btn primary big" type="submit">Entrar</button>
      <p class="err" id="clubErr" role="alert"></p>
    </form>
    ${chips}
    ${prizes ? `<p class="muted small">Premios: ${prizes}</p>` : ""}
    <p class="muted small">${p.stamps_goal} sellos = ${esc(p.stamps_reward_label)}</p>
  </section>`;
}

// CSS inline: tokens del menú (--p/--a) y componentes del club. Mobile first, max 520px.
function css(primary, accent) {
  return `*{box-sizing:border-box}
:root{--p:${primary};--a:${accent};--bg:#100d14;--card:#1a1620;--line:rgba(255,255,255,.1);--tx:#f5f2f7;--tx2:#a9a2b4;--r:20px}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--tx);font-family:'DM Sans',system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-tap-highlight-color:transparent}
body{min-height:100dvh;font-size:15px;line-height:1.45}
.club-wrap{max-width:520px;margin:0 auto;padding:max(14px,env(safe-area-inset-top)) 16px calc(30px + env(safe-area-inset-bottom))}
.club-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:16px}
.club-brand{display:flex;align-items:center;gap:8px;font-weight:800;font-size:14px;min-width:0}
.club-brand span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.club-brand img{width:30px;height:30px;object-fit:contain;border-radius:8px;background:rgba(255,255,255,.06)}
.club-menu,.club-out{font-size:12px;font-weight:700;color:var(--tx2);text-decoration:none;background:none;border:0;padding:8px 10px;border-radius:999px;cursor:pointer;white-space:nowrap}
.club-menu:hover,.club-out:hover{color:var(--tx);background:rgba(255,255,255,.06)}
.card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:20px 18px;margin-bottom:14px}
.card h1,.card h2,.card h3{margin:0 0 8px;line-height:1.15}
.card h1{font-size:clamp(23px,6vw,29px);font-weight:900;letter-spacing:-.02em}
.card h2{font-size:clamp(19px,5vw,23px);font-weight:800}
.card h3{font-size:17px;font-weight:800}
.kicker{margin:0 0 4px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--a)}
.muted{margin:0 0 12px;color:var(--tx2);font-size:14px}
.muted.small,.small{font-size:12.5px}
.err{margin:8px 0 0;color:#ff8f8f;font-size:13px;min-height:0}
label{display:block;margin:12px 0 6px;font-size:12px;font-weight:700;color:var(--tx2);letter-spacing:.04em;text-transform:uppercase}
input,select{width:100%;padding:14px 15px;border-radius:14px;border:1px solid var(--line);background:#241e2c;color:var(--tx);font:inherit;font-size:16px;outline:none;-webkit-appearance:none}
input:focus,select:focus{border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 28%,transparent)}
textarea{width:100%;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:#241e2c;color:var(--tx);font:inherit;font-size:15px;outline:none;resize:vertical;min-height:84px;-webkit-appearance:none}
textarea:focus{border-color:var(--a);box-shadow:0 0 0 3px color-mix(in srgb,var(--a) 28%,transparent)}
.bday{display:grid;grid-template-columns:1fr 1.35fr;gap:8px;margin-top:4px}
.bday select{padding:12px 10px}
.bday-note{margin:0}
.card.bday-card{border-color:color-mix(in srgb,var(--a) 36%,var(--line))}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;margin-top:14px;padding:14px 18px;border:0;border-radius:15px;background:rgba(255,255,255,.08);color:var(--tx);font:inherit;font-weight:800;font-size:15px;text-decoration:none;cursor:pointer;transition:transform .15s,opacity .2s}
.btn:active{transform:scale(.985)}
.btn:disabled{opacity:.45;cursor:default}
.btn.primary{background:linear-gradient(135deg,var(--p),var(--a));color:#141018;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.btn.big{padding:16px 18px;font-size:16px}
.btn.mini{width:auto;margin:0;padding:8px 14px;border-radius:999px;font-size:12.5px;background:linear-gradient(135deg,var(--p),var(--a));color:#141018}
.btn.ghost,.ghost{display:block;width:100%;margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:14px;background:none;color:var(--tx2);font:inherit;font-weight:700;text-align:center;text-decoration:none;cursor:pointer}
.btn.wallet{background:#fff;color:#1f1f1f}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:14px}
.chip{padding:5px 11px;border-radius:999px;background:rgba(255,255,255,.09);font-size:12px;font-weight:700}
.chip.soft{background:none;border:1px solid var(--line);color:var(--tx2);margin-right:4px}
.stamps{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:6px;margin:16px 0 10px}
.stamp{aspect-ratio:1;border-radius:50%;border:1.5px dashed rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;font-size:14px;line-height:1}
.stamp.on{background:linear-gradient(135deg,var(--p),var(--a));border:0;color:#141018;font-weight:900;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.stamp-line{margin:0 0 4px;font-size:14px;font-weight:700}
.stamp-line b{font-size:20px}
.rewards{list-style:none;margin:10px 0 0;padding:0}
.reward{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 0;border-top:1px solid var(--line)}
.reward:first-child{border-top:0}
.rw-main{min-width:0}
.rw-label{font-weight:700;font-size:14px}
.rw-exp{display:block;margin-top:2px;font-size:11.5px;color:var(--tx2)}
.reward.done .rw-label{color:var(--tx2);text-decoration:line-through}
.tag{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--tx2);background:rgba(255,255,255,.07);padding:4px 9px;border-radius:999px}
.tag.gift{color:var(--a);background:color-mix(in srgb,var(--a) 16%,transparent);margin-left:6px}
.games{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
.games .btn{margin:0;aspect-ratio:5/4;flex-direction:column;font-size:15px}
.games .btn .em{font-size:28px}
.card.credit{border-color:color-mix(in srgb,var(--a) 48%,var(--line));background:linear-gradient(160deg,color-mix(in srgb,var(--a) 13%,var(--card)),var(--card) 68%)}
.card.credit h3{margin:0 0 6px}
.card.credit .pending{margin:8px 0 0}
.wheel-wrap{position:relative;width:100%;max-width:330px;margin:10px auto 18px;aspect-ratio:1}
.wheel-wrap canvas{width:100%;height:100%;display:block;border-radius:50%;box-shadow:0 12px 34px rgba(0,0,0,.5);will-change:transform}
.wheel-pointer{position:absolute;top:-7px;left:50%;transform:translateX(-50%);z-index:2;width:0;height:0;border-left:11px solid transparent;border-right:11px solid transparent;border-top:22px solid var(--a);filter:drop-shadow(0 2px 4px rgba(0,0,0,.55))}
.scratch-wrap{position:relative;width:100%;border-radius:16px;overflow:hidden;background:#221c29;margin:10px 0 12px;border:1px solid var(--line)}
.scratch-wrap canvas{position:relative;z-index:1;width:100%;height:auto;display:block;touch-action:none}
.scratch-under{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:12px;text-align:center}
.scratch-under b{font-size:clamp(20px,6vw,30px);line-height:1.1}
.pin-in{text-align:center;font-size:26px;font-weight:800;letter-spacing:.55em;text-indent:.55em;font-variant-numeric:tabular-nums}
.result{overflow:hidden}
.result .kicker{font-size:12px}
.res-actions{display:grid;gap:8px;margin-top:6px}
.res-actions .btn{margin-top:0}
.fb{margin-top:18px;padding-top:14px;border-top:1px solid var(--line)}
.fb-q{margin:0 0 8px;font-weight:800;font-size:14px;text-align:center}
.fb-stars{display:flex;gap:6px;justify-content:center;margin:4px 0 8px}
.fb-star{width:44px;height:44px;border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.06);color:var(--tx2);font-size:22px;line-height:1;cursor:pointer;padding:0}
.fb-star.on{color:#141018;background:linear-gradient(135deg,var(--p),var(--a));border-color:transparent}
.fb-thanks{margin:6px 0 0;font-size:13.5px;color:var(--tx2);text-align:center}
.fb .err{text-align:center}
.review{margin-top:20px;padding-top:16px;border-top:1px solid var(--line);text-align:center}
.review .btn{margin-top:8px}
.review.low{opacity:.66}
.confetti{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.confetti i{position:absolute;top:-14px;width:7px;height:13px;border-radius:2px;animation:club-fall 2.8s linear forwards}
.complete .stamp.last{animation:club-stamp .5s cubic-bezier(.2,1.6,.4,1) .35s both}
.big-prize{font-size:30px;line-height:1.15;margin:2px 0 10px;animation:club-pop .5s ease-out .9s both}
@keyframes club-stamp{from{transform:scale(2.6) rotate(-25deg);opacity:0}to{transform:none;opacity:1}}
@keyframes club-pop{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}
@keyframes club-fall{to{transform:translateY(420px) rotate(560deg);opacity:0}}
.modal{position:fixed;inset:0;z-index:900;display:flex;align-items:flex-end;justify-content:center;padding:14px;background:rgba(0,0,0,.72);backdrop-filter:blur(6px)}
.modal-box{width:100%;max-width:440px;margin-bottom:env(safe-area-inset-bottom);padding:22px 18px;border:1px solid var(--line);border-radius:24px;background:var(--card)}
.toast{position:fixed;left:50%;bottom:calc(18px + env(safe-area-inset-bottom));z-index:1000;max-width:90vw;padding:11px 18px;border-radius:999px;background:#241e2c;color:var(--tx);font-size:13px;font-weight:700;text-align:center;opacity:0;pointer-events:none;transform:translate(-50%,18px);transition:.25s}
.toast.show{opacity:1;transform:translate(-50%,0)}
.club-foot{margin:20px 4px 0;color:var(--tx2);font-size:11.5px;line-height:1.5;text-align:center}
.card-show{background:#fff;color:#141018;margin-top:10px}
.card-scan{position:fixed;inset:0;z-index:950;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:10px;padding:max(20px,env(safe-area-inset-top)) 18px max(24px,env(safe-area-inset-bottom));
  background:#fff;color:#111;text-align:center;overflow:auto}
.card-scan-close{position:absolute;top:max(12px,env(safe-area-inset-top));right:14px;width:44px;height:44px;border:0;
  border-radius:50%;background:#eee;color:#111;font-size:26px;line-height:1;cursor:pointer}
.card-scan-kicker{margin:0;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#666}
.card-scan-name{margin:0;font-size:clamp(18px,5vw,24px);font-weight:900}
.card-scan-qr{padding:10px;border:1px solid #e5e5e5;border-radius:18px;background:#fff}
.card-scan-qr canvas{display:block;width:min(78vw,340px);height:auto;image-rendering:pixelated}
.card-scan-code{margin:0;font-size:clamp(20px,6vw,28px);font-weight:900;letter-spacing:.12em;font-variant-numeric:tabular-nums}
.card-scan-hint{margin:0;font-size:14px;color:#444}
.card-scan-msg{margin:0;font-size:12.5px;color:#777;min-height:16px}
.card-scan-pin{margin-top:6px;padding:12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#333;
  font:inherit;font-size:13px;font-weight:700;cursor:pointer}
`;
}

/* Runtime del navegador. Se serializa con String() y se inyecta tal cual: sin build, sin copia. */
function runtime() {
  const P = window.__CLUB__ || {};
  const view = document.getElementById("clubView");
  const outBtn = document.getElementById("clubLogout");
  const toastEl = document.getElementById("clubToast");
  const NAMES = { wheel: "Ruleta", scratch: "Raspadita" };
  let me = null, tick = 0, busy = false, lastGame = null, revealNow = null;
  let fbState = null, bdayDismissed = false;
  let scanTimer = null, scanStart = 0, scanBase = null, scanOpen = false, scanBusy = false;

  const th = () => (me && me.program) || P;
  // Modo de juego: /me lo trae; si no, el program embebido en el SSR (misma config).
  const isStamps = () => ((me && me.program && me.program.play_mode) || P.play_mode) === "stamps";
  // Tarjeta para caja: solo si el servidor entrega `me.card` (backend viejo = sin botón).
  const cardOf = () => {
    const card = me && me.card;
    const url = safeUrl(card && card.url);
    return url ? { url, code: String(card.code || "") } : null;
  };
  // Cumpleaños: /me puede traerlo; si no, el del SSR. Apagado por defecto.
  const birthdayCfg = () => {
    const b = (me && me.program && me.program.birthday) || P.birthday;
    return b && b.enabled === true ? b : { enabled: false, label: "Regalo de cumpleaños" };
  };

  async function api(path, body) {
    const opts = body === undefined
      ? { headers: { accept: "application/json" }, credentials: "same-origin" }
      : { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, credentials: "same-origin", body: JSON.stringify(body) };
    try {
      const r = await fetch("/club/api/" + path, opts);
      if (r.status === 401 && path !== "me") location.reload(); // sesión vencida a mitad de flujo
      return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) };
    } catch { return { status: 0, data: {} }; }
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    setTimeout(() => toastEl.classList.remove("show"), 3200);
  }

  /* ── sesión ── */
  async function load() {
    const r = await api("me");
    if (r.status === 200) { me = r.data; if (outBtn) outBtn.hidden = false; return home(); }
    if (r.status === 401) {
      if (outBtn) outBtn.hidden = true;
      if (!document.getElementById("clubLogin")) location.reload();
      return;
    }
    toast("No pudimos cargar tu club. Recarga la página.");
  }

  async function login(form) {
    const name = form.querySelector("[name=name]").value.trim();
    const phone = form.querySelector("[name=phone]").value.trim();
    const pinEl = document.getElementById("clubLoginPin");
    const pin = String((pinEl && pinEl.value) || "").replace(/\D/g, "");
    const btn = form.querySelector("button[type=submit]");
    const err = document.getElementById("clubErr");
    if (!name) { if (err) err.textContent = "Escribe tu nombre."; return; }
    // Cumpleaños opcional: si eligen solo día o mes, se avisa y no se envía nada a medias.
    let birthday = "";
    if (birthdayCfg().enabled) {
      const d = form.querySelector("[name=bday_day]"), m = form.querySelector("[name=bday_month]");
      birthday = birthdayValue(d && d.value, m && m.value);
      if (birthday === null) { if (err) err.textContent = "Elige día y mes de tu cumpleaños, o déjalo vacío."; return; }
    }
    btn.disabled = true;
    const body = { name, phone };
    if (pin) body.pin = pin;
    if (birthday) body.birthday = birthday;
    const r = await api("login", body);
    btn.disabled = false;
    if (r.status === 200) { me = r.data; if (outBtn) outBtn.hidden = false; return home(); }
    const e = r.data.error;
    if (e === "verificacion_requerida" || e === "pin_invalido") {
      showLoginPin();
      if (err) err.textContent = e === "pin_invalido"
        ? "PIN incorrecto. Pide al mesero que lo revise."
        : "Este número ya tiene sellos o premios. Pide al mesero que escriba su PIN para vincular este celular";
      return;
    }
    const map = {
      telefono_invalido: "Escribe un WhatsApp válido (por ejemplo 0991234567).",
      nombre_requerido: "Escribe tu nombre.",
      limite_dispositivo: "Este celular ya tiene el máximo de cuentas.",
      bloqueado: "Demasiados intentos. Prueba mañana o pide ayuda al personal.",
      demasiados_intentos: "Demasiados intentos. Espera un momento y vuelve a probar.",
    };
    if (err) err.textContent = map[e] || "No pudimos entrar. Intenta de nuevo.";
  }

  // Revela el campo PIN del login solo cuando el servidor lo pide (cuenta con valor en otro celular).
  function showLoginPin() {
    for (const id of ["clubLoginPin", "clubLoginPinLabel"]) {
      const el = document.getElementById(id);
      if (el) el.hidden = false;
    }
    const pinEl = document.getElementById("clubLoginPin");
    if (pinEl && pinEl.focus) pinEl.focus();
  }

  /* ── inicio ── */
  function home() {
    clearInterval(tick);
    revealNow = null;
    const c = (me && me.customer) || {}, p = th();
    const stampsMode = isStamps();
    const goal = p.stamps_goal || 1, stamps = c.stamps || 0, slots = Math.min(goal, 40);
    const canPlay = me ? me.can_play === true : false;
    const games = p.games || [];
    const card = cardOf();
    const one = stampsMode || games.length > 1 ? "" : ` data-game="${esc(games[0] || "wheel")}"`;
    const playAct = stampsMode ? "stamp" : games.length > 1 ? "choose" : "start";
    const playLabel = canPlay ? (stampsMode ? "Registrar visita" : "Jugar") : "Vuelve pronto";
    const dots = Array.from({ length: slots }, (_, i) => `<span class="stamp${i < stamps ? " on" : ""}">${i < stamps ? "★" : ""}</span>`).join("");
    const now = Date.now();
    const GIFT = { birthday: "🎂 Cumpleaños", winback: "👋 Te extrañamos" };
    const rewards = (me && me.rewards || []).map(r => {
      const expired = r.status === "expired" || (r.status === "active" && r.expires_at != null && Number(r.expires_at) <= now);
      const gift = GIFT[r.source] ? `<span class="tag gift">${GIFT[r.source]}</span>` : "";
      if (r.status === "active" && !expired) {
        const exp = expiryText(r.expires_at, now);
        return `<li class="reward"><div class="rw-main"><span class="rw-label">${esc(r.label)}</span>${gift}${exp ? `<span class="rw-exp">${exp}</span>` : ""}</div><button class="btn mini" data-act="redeem" data-id="${esc(r.id)}">Canjear</button></li>`;
      }
      return `<li class="reward done"><div class="rw-main"><span class="rw-label">${esc(r.label)}</span>${gift}</div><span class="tag">${expired ? "Vencido" : "Usado"}</span></li>`;
    }).join("");
    view.innerHTML = `${creditCard()}${birthdayCard()}<section class="card">
      <p class="kicker">Hola, ${esc(c.name || "")}</p>
      <h2>Tu tarjeta de sellos</h2>
      <div class="stamps" style="--n:${slots}" role="img" aria-label="${stamps} de ${goal} sellos">${dots}</div>
      <p class="stamp-line"><b>${stamps}</b> de ${goal} sellos</p>
      ${card ? `<button class="btn big card-show" data-act="card">Mostrar mi tarjeta</button>` : ""}
      <p class="muted">Completa la tarjeta y ganas: ${esc(p.stamps_reward_label || "un premio")}</p>
      <button class="btn primary big" id="clubPlay" data-act="${playAct}"${one}${canPlay ? "" : " disabled"}>${playLabel}</button>
      <p class="muted small" id="clubNext"></p>
      <p class="muted small">${c.visits || 0} visita(s) · ${c.cards_completed || 0} tarjeta(s) completa(s)</p>
      ${me && me.wallet_url === "/club/api/wallet" ? `<a class="btn wallet" href="/club/api/wallet">Guardar en Google Wallet</a>` : ""}
    </section>
    <section class="card">
      <h2>Tus premios</h2>
      ${rewards ? `<ul class="rewards">${rewards}</ul>` : `<p class="muted">Todavía no tienes premios. ${stampsMode ? "¡Suma sellos y gana!" : "¡Juega y gana!"}</p>`}
    </section>`;
    if (outBtn) outBtn.hidden = false;
    if (me && !canPlay) countdown();
  }

  // Aviso de créditos por pedido a domicilio: cada uno es un sello (y una jugada en modo game).
  // Se usa sin PIN ni ubicación; los pendientes se acreditan al confirmarse la entrega.
  function creditCard() {
    const cr = (me && me.credits) || {};
    const count = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? Math.min(n, 999) : 0; };
    const granted = count(cr.granted), pending = count(cr.pending);
    if (!granted && !pending) return "";
    const stampsMode = isStamps(), games = th().games || [];
    const game = stampsMode ? "stamp" : games.length > 1 ? "" : games[0] || "wheel";
    const action = game ? "credit" : "chooseCredit";
    const pendingNote = `${pending} ${pending === 1 ? "sello" : "sellos"} por confirmar de tus pedidos a domicilio. `
      + "Se acreditan cuando el restaurante confirma la entrega o en tu próxima visita.";
    return `<section class="card credit">
      <p class="kicker">Pedido a domicilio</p>
      ${granted ? `<h3>Tienes ${granted} ${granted === 1 ? "jugada" : "jugadas"} por tu pedido a domicilio</h3>
        <p class="muted small">Juégala desde donde estés: ya la validó el restaurante.</p>
        <button class="btn primary big" data-act="${action}"${game ? ` data-game="${esc(game)}"` : ""}>${stampsMode ? "Registrar visita con mi crédito" : "Jugar con mi crédito"}</button>` : ""}
      ${pending ? `<p class="muted small${granted ? " pending" : ""}">${pendingNote}</p>` : ""}
    </section>`;
  }

  // Cumpleaños opcional para quien ya tiene sesión: sin fecha guardada se ofrece agregarla una vez.
  function birthdayCard() {
    const bd = birthdayCfg(), c = (me && me.customer) || {};
    if (!bd.enabled || c.birthday || bdayDismissed) return "";
    return `<section class="card bday-card">
      <p class="kicker">Cumpleaños</p>
      <h3>Te enviamos un regalo en tu cumpleaños</h3>
      <p class="muted small">Agrega el día y el mes. Solo lo usamos para tu regalo.</p>
      <form id="clubBdayForm" novalidate>
        ${birthdaySelects("clubBday")}
        <p class="err" id="clubBdayErr" role="alert"></p>
        <button class="btn primary" type="submit">Guardar cumpleaños</button>
        <button class="ghost" type="button" data-act="dismissBday">Ahora no</button>
      </form>
    </section>`;
  }

  // Guarda el cumpleaños con sesión (solo se puede registrar la primera vez; el servidor decide).
  async function saveBirthday(form) {
    const err = document.getElementById("clubBdayErr");
    const d = form.querySelector("[name=bday_day]"), m = form.querySelector("[name=bday_month]");
    const value = birthdayValue(d && d.value, m && m.value);
    if (!value) { if (err) err.textContent = "Elige día y mes."; return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("profile", { birthday: value });
    btn.disabled = false;
    if (r.status === 200) {
      me = r.data && r.data.program ? r.data : { ...me, customer: { ...me.customer, birthday: value } };
      toast("¡Listo! Te enviamos un regalo en tu cumpleaños.");
      return home();
    }
    if (err) err.textContent = r.data.error === "cumpleanos_ya_registrado"
      ? "Tu cumpleaños ya está registrado."
      : "No pudimos guardar tu cumpleaños. Intenta de nuevo.";
  }

  // Cuenta regresiva del cooldown: repinta cada 15 s y al llegar a cero recarga /me (el servidor decide).
  function countdown() {
    clearInterval(tick);
    const next = () => document.getElementById("clubNext");
    const left = () => (me && me.next_play_at || 0) - Date.now();
    if (!(left() > 0)) return;
    const paint = () => {
      if (left() <= 0) { clearInterval(tick); return load(); }
      const el = next();
      if (el) el.textContent = "Próxima jugada en " + remainingText(left());
    };
    paint();
    tick = setInterval(paint, 15000);
  }

  /* ── mi tarjeta (QR para la caja) ── */
  // QR en un canvas propio: blanco/negro puro, zona de silencio de 4 módulos y sin datos en el DOM.
  function drawCardQR(cv, text) {
    const matrix = qrMatrix(text), n = matrix.length, quiet = 4;
    const px = Math.max(4, Math.floor(320 / (n + quiet * 2)));
    const size = (n + quiet * 2) * px;
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (matrix[y][x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    }
  }

  // Foto del estado al abrir la tarjeta: el sondeo solo reacciona a lo que suba desde acá.
  function scanSnapshot() {
    const c = (me && me.customer) || {}, cr = (me && me.credits) || {};
    return { stamps: Number(c.stamps) || 0, cards: Number(c.cards_completed) || 0, granted: Number(cr.granted) || 0 };
  }

  // Vista a pantalla completa. Los datos del cliente van por textContent/canvas, nunca por innerHTML.
  function cardView() {
    const card = cardOf(), c = (me && me.customer) || {};
    if (!card) return home();
    clearInterval(tick);
    view.innerHTML = `<section class="card-scan">
      <button class="card-scan-close" type="button" data-act="cardClose" aria-label="Cerrar mi tarjeta">×</button>
      <p class="card-scan-kicker">Tu tarjeta del club</p>
      <p class="card-scan-name" id="clubCardName"></p>
      <div class="card-scan-qr"><canvas id="clubCardQr" aria-label="Código QR de tu tarjeta"></canvas></div>
      <p class="card-scan-code" id="clubCardCode"></p>
      <p class="card-scan-hint">Muéstrala al mesero para sumar tu sello</p>
      <p class="card-scan-msg" id="clubCardMsg"></p>
      <button class="card-scan-pin" type="button" data-act="cardPin">¿Sin escáner? Usa el PIN del mesero</button>
    </section>`;
    const nameEl = document.getElementById("clubCardName");
    if (nameEl) nameEl.textContent = String(c.name || "");
    const codeEl = document.getElementById("clubCardCode");
    if (codeEl) codeEl.textContent = groupCardCode(card.code);
    try {
      const cv = document.getElementById("clubCardQr");
      if (cv) drawCardQR(cv, card.url);
    } catch {
      const msg = document.getElementById("clubCardMsg");
      if (msg) msg.textContent = "No pudimos generar el código. Usa el PIN del mesero.";
    }
    scanBase = scanSnapshot();
    startScanPoll();
  }

  // Mientras la tarjeta está abierta se consulta /me cada 3 s (máx. 5 min).
  function startScanPoll() {
    if (scanTimer) clearInterval(scanTimer);
    scanOpen = true;
    scanBusy = false;
    scanStart = Date.now();
    scanTimer = setInterval(pollScan, 3000);
  }

  function stopScan() {
    scanOpen = false;
    scanBusy = false;
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
  }

  async function pollScan() {
    if (!scanOpen || scanBusy) return;
    if (Date.now() - scanStart > 300000) return stopScan(); // 5 min: deja de sondear, la tarjeta sigue visible
    scanBusy = true;
    const r = await api("me");
    scanBusy = false;
    if (!scanOpen || r.status !== 200) return;
    const next = r.data || {}, c = next.customer || {}, cr = next.credits || {};
    const base = scanBase || { stamps: 0, cards: 0, granted: 0 };
    const stamps = Number(c.stamps) || 0, cards = Number(c.cards_completed) || 0, granted = Number(cr.granted) || 0;
    if (cards > base.cards) { stopScan(); me = next; return cardCompleteResult(); }
    if (stamps > base.stamps) {
      stopScan();
      me = next;
      return resultView({ segment_index: -1, won: false, prize: null, reward_id: null, card_completed: false }, true);
    }
    if (granted > base.granted) { stopScan(); me = next; return scanCreditView(); }
  }

  // Tarjeta completa detectada por sondeo: reusa la pantalla de siempre y ofrece canjear el premio nuevo.
  function cardCompleteResult() {
    const reward = (me && me.rewards || []).find(r => r.status === "active" && r.source === "stamps");
    return cardCompleteView({ card_completed: true, stamps_reward_id: reward ? reward.id : null }, false, th());
  }

  // Crédito validado por la caja (modo game): se juega desde el celular con credit:true.
  function scanCreditView() {
    const stampsMode = isStamps(), games = th().games || [];
    const multiple = !stampsMode && games.length > 1;
    const act = multiple ? "chooseScan" : "credit";
    const game = stampsMode ? "stamp" : multiple ? "" : games[0] || "wheel";
    const note = stampsMode ? "El mesero validó tu visita. Toca para sumar tu sello." : "El mesero validó tu visita. Toca para jugar.";
    const label = stampsMode ? "Sumar mi sello" : "Toca para jugar";
    view.innerHTML = `<section class="card result">
      <p class="kicker">Visita validada</p>
      <h2>¡Visita validada!</h2>
      <p class="muted">${note}</p>
      <button class="btn primary big" data-act="${act}"${game ? ` data-game="${esc(game)}"` : ""}>${label}</button>
      <button class="btn ghost" data-act="home">Volver a mi tarjeta</button>
    </section>`;
  }

  function closeCard() {
    stopScan();
    home();
  }

  // Alternativa sin escáner: el mesero escribe su PIN igual que en el flujo de siempre.
  function cardPin() {
    stopScan();
    const game = lastGame || (isStamps() ? "stamp" : (th().games || [])[0] || "wheel");
    pinScreen(game, "tarjeta");
  }

  function choose(credit, scan) {
    const games = th().games || [];
    const act = credit ? "credit" : "start";
    const note = scan ? "El mesero validó tu visita: elige con qué jugar."
      : credit ? "Es tu jugada por pedido a domicilio: sin PIN ni ubicación."
        : "Una jugada por visita. El premio lo elige la suerte.";
    const gameBtn = g => `<button class="btn primary" data-act="${act}" data-game="${esc(g)}">`
      + `<span class="em">${g === "scratch" ? "🎫" : "🎡"}</span>${esc(NAMES[g] || g)}</button>`;
    view.innerHTML = `<section class="card">
      <h2>Elige tu juego</h2>
      <p class="muted">${note}</p>
      <div class="games">${games.map(gameBtn).join("")}</div>
      <button class="ghost" data-act="home">Volver</button>
    </section>`;
  }

  /* ── jugar ── */
  function locate() {
    return new Promise(resolve => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(
        pos => resolve(pos),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 },
      );
    });
  }

  async function play(game) {
    if (busy || !game) return;
    lastGame = game;
    // PIN obligatorio (config del local o menú sin sedes): se pide antes de ubicar o animar.
    if (th().pin_required) return pinScreen(game, "pin_requerido");
    busy = true;
    const body = { game };
    if (th().geo_required) {
      const pos = await locate();
      if (!pos) { busy = false; return pinScreen(game, "sin_ubicacion"); }
      body.lat = pos.coords.latitude;
      body.lng = pos.coords.longitude;
    }
    const r = await api("play", body);
    busy = false;
    if (r.status === 200) return animate(game, r.data);
    if (r.status === 429) {
      if (r.data.error === "demasiados_intentos") { toast("Demasiados intentos. Espera un momento y vuelve a probar."); return; }
      toast("Ya jugaste. " + (r.data.next_play_at ? "Vuelve en " + remainingText(r.data.next_play_at - Date.now()) + "." : "Vuelve más tarde."));
      return load();
    }
    if (r.status === 403 && r.data.error === "fuera_de_rango") return farScreen(game);
    if (r.status === 403 && (r.data.error === "sin_ubicacion" || r.data.error === "pin_invalido" || r.data.error === "pin_requerido")) return pinScreen(game, r.data.error);
    if (r.status === 423) { toast("Demasiados intentos. Prueba mañana o pide ayuda al personal."); return home(); }
    toast("No pudimos registrar tu jugada. Intenta de nuevo.");
    home();
  }

  // Crédito por pedido a domicilio: vale 1 sello (y en modo game, 1 jugada) sin PIN ni ubicación.
  async function playCredit(game) {
    if (busy) return;
    const stampsMode = isStamps(), games = th().games || [];
    if (!game && !stampsMode && games.length > 1) return choose(true);
    const g = game || (stampsMode ? "stamp" : games[0] || "wheel");
    busy = true;
    const r = await api("play", { game: g, credit: true });
    busy = false;
    if (r.status === 200) return animate(g, r.data);
    if (r.status === 409 && r.data.error === "sin_creditos") {
      toast("Ya no tienes jugadas por pedido a domicilio.");
      return load();
    }
    if (r.status === 429) { toast("Demasiados intentos. Espera un momento y vuelve a probar."); return; }
    if (r.status === 423) { toast("Demasiados intentos. Prueba mañana o pide ayuda al personal."); return home(); }
    toast("No pudimos usar tu jugada. Intenta de nuevo.");
    home();
  }

  function farScreen(game) {
    view.innerHTML = `<section class="card">
      <h2>Estás fuera del rango del local</h2>
      <p class="muted">El club solo valida visitas dentro del local. Acércate y vuelve a intentarlo.</p>
      <button class="btn primary" data-act="start" data-game="${esc(game)}">Intentar de nuevo</button>
      <button class="ghost" data-act="pin" data-game="${esc(game)}">Pide el PIN al mesero</button>
      <button class="ghost" data-act="home">Volver</button>
    </section>`;
  }

  function pinScreen(game, error) {
    lastGame = game;
    view.innerHTML = `<section class="card">
      <h2>Pídele al mesero el PIN para validar tu visita</h2>
      <p class="muted">${error === "pin_invalido"
        ? "El PIN no coincidió. Pídele al mesero que lo revise."
        : error === "pin_requerido"
          ? "Este local pide el PIN del mesero en cada jugada. Pídeselo para continuar."
          : error === "tarjeta"
            ? "Muéstrale tu tarjeta o pídele al mesero que escriba su PIN para validar tu visita."
            : "No pudimos confirmar que estás en el local. El mesero puede validarlo con su PIN."}</p>
      <form id="clubPinForm" novalidate>
        ${pinInput("")}
        <p class="err" id="clubPinErr" role="alert"></p>
        <button class="btn primary" type="submit">${isStamps() ? "Validar visita" : "Validar y jugar"}</button>
        <button class="ghost" type="button" data-act="home">Cancelar</button>
      </form>
    </section>`;
  }

  async function submitPin(form) {
    const pin = (form.querySelector("[name=pin]").value || "").replace(/\D/g, "");
    const err = document.getElementById("clubPinErr");
    if (pin.length < 4 || pin.length > 6) { if (err) err.textContent = "El PIN tiene entre 4 y 6 dígitos."; return; }
    const game = lastGame || (isStamps() ? "stamp" : (th().games || [])[0] || "wheel");
    const r = await api("play", { game, pin });
    if (r.status === 200) return animate(game, r.data);
    if (r.status === 403 && r.data.error === "pin_invalido") { if (err) err.textContent = "PIN incorrecto. Pídele al mesero que lo revise."; return; }
    if (r.status === 403 && r.data.error === "pin_requerido") { if (err) err.textContent = "Este local pide el PIN del mesero para jugar."; return; }
    if (r.status === 403 && r.data.error === "fuera_de_rango") return farScreen(game);
    if (r.status === 423) { toast("Demasiados intentos. Prueba mañana o pide ayuda al personal."); return home(); }
    if (r.status === 429) {
      if (r.data.error === "cooldown") {
        toast("Ya jugaste." + (r.data.next_play_at ? " Vuelve en " + remainingText(r.data.next_play_at - Date.now()) + "." : ""));
        return load();
      }
      if (err) err.textContent = "Demasiados intentos. Espera un momento y vuelve a probar.";
      return;
    }
    toast("No pudimos validar tu visita. Intenta de nuevo.");
  }

  /* ── animaciones + resultado ── */
  function animate(game, data) {
    me = data.me || me;
    const res = data.result || {};
    // Modo solo sellos: la visita no sortea premio, se muestra el resultado directo.
    if (game === "stamp") return resultView(res, true);
    const total = (th().segments || []).length || 1;
    // Sin segmentos disponibles, el servidor devuelve -1: no simular un premio en la ruleta.
    if (res.segment_index === -1) return resultView(res);
    const index = Math.min(Math.max(0, Number(res.segment_index) || 0), total - 1);
    if (game === "scratch") {
      scratchView(res);
      startScratch(() => setTimeout(() => resultView(res), 900));
      return;
    }
    const cv = wheelView();
    spin(cv, index, total, () => resultView(res));
  }

  function wheelView() {
    view.innerHTML = `<section class="card">
      <h2>Ruleta</h2>
      <div class="wheel-wrap"><div class="wheel-pointer"></div><canvas id="clubWheel" width="640" height="640" aria-label="Ruleta de premios"></canvas></div>
      <p class="muted" id="clubMsg">Girando…</p>
    </section>`;
    return document.getElementById("clubWheel");
  }

  // Dibuja la ruleta: segmentos del servidor, colores de la marca, etiquetas legibles.
  function drawWheel(cv) {
    const segs = th().segments || [], ctx = cv.getContext("2d"), R = cv.width / 2, n = segs.length || 1, step = Math.PI * 2 / n;
    const cols = [th().theme_accent || "#F5B301", th().theme_primary || "#E4801C"];
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < n; i++) {
      const a0 = i * step, a1 = a0 + step;
      ctx.beginPath();
      ctx.moveTo(R, R);
      ctx.arc(R, R, R - 8, a0, a1);
      ctx.closePath();
      ctx.fillStyle = cols[i % 2];
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,.18)";
      ctx.lineWidth = 3;
      ctx.stroke();
      const label = String(segs[i].label || "");
      const short = label.length > 19 ? label.slice(0, 18) + "…" : label;
      ctx.save();
      ctx.translate(R, R);
      ctx.rotate(a0 + step / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.font = "bold " + Math.max(15, Math.round(R / 17)) + "px system-ui,sans-serif";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,.35)";
      ctx.strokeText(short, R - 26, 0);
      ctx.fillStyle = "#fff";
      ctx.fillText(short, R - 26, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(R, R, R * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = "#1a1620";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.35)";
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.font = "bold " + Math.round(R / 9) + "px system-ui,sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("★", R, R + 1);
  }

  function spin(cv, index, total, done) {
    if (!cv) return done();
    drawWheel(cv);
    const to = wheelStopAngle(index, total, 5);
    cv.style.transition = "none";
    cv.style.transform = "rotate(0deg)";
    void cv.offsetWidth; // fuerza reflow para que la transición arranque desde 0
    requestAnimationFrame(() => {
      cv.style.transition = "transform 4s cubic-bezier(.12,.62,.05,1)";
      cv.style.transform = "rotate(" + to + "deg)";
    });
    setTimeout(() => { if (document.getElementById("clubWheel")) done(); }, 4300);
  }

  // Debajo de la capa va el resultado que ya dio el servidor: al raspar se ve aparecer el premio.
  function scratchView(res) {
    const won = res && res.won === true;
    view.innerHTML = `<section class="card">
      <h2>Raspadita</h2>
      <div class="scratch-wrap"><div class="scratch-under" aria-hidden="true"><span>${won ? "🎉 ¡Ganaste!" : "😅"}</span><b>${won ? esc(res.prize && res.prize.label || "Premio") : "Sigue participando"}</b></div><canvas id="clubScratch" width="640" height="340" aria-label="Raspadita de premios"></canvas></div>
      <button class="ghost" data-act="reveal">Revelar</button>
    </section>`;
  }

  // Cubre el canvas y lo va borrando con el dedo; al 50 % revelado (o con el botón) muestra el resultado.
  function startScratch(done) {
    const cv = document.getElementById("clubScratch");
    if (!cv) return done();
    const ctx = cv.getContext("2d"), w = cv.width, h = cv.height;
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, th().theme_primary || "#E4801C");
    g.addColorStop(1, th().theme_accent || "#F5B301");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,.94)";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "bold 40px system-ui,sans-serif";
    ctx.fillText("Rasca aquí", w / 2, h / 2 - 16);
    ctx.font = "22px system-ui,sans-serif";
    ctx.fillText("y descubre tu premio", w / 2, h / 2 + 30);
    let finished = false, down = false, last = 0;
    const finish = () => { if (finished) return; finished = true; revealNow = null; ctx.clearRect(0, 0, w, h); done(); };
    revealNow = finish;
    const erase = ev => {
      const r = cv.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const x = (ev.clientX - r.left) * (w / r.width), y = (ev.clientY - r.top) * (h / r.height);
      ctx.globalCompositeOperation = "destination-out";
      ctx.beginPath();
      ctx.arc(x, y, 34, 0, Math.PI * 2);
      ctx.fill();
      if (Date.now() - last < 150) return;
      last = Date.now();
      const data = ctx.getImageData(0, 0, w, h).data;
      let clear = 0, total = 0;
      for (let i = 3; i < data.length; i += 64) { total++; if (data[i] < 32) clear++; }
      if (revealPercent(clear, total) >= 50) finish();
    };
    cv.addEventListener("pointerdown", ev => { down = true; cv.setPointerCapture?.(ev.pointerId); erase(ev); });
    cv.addEventListener("pointermove", ev => { if (down) erase(ev); });
    cv.addEventListener("pointerup", () => { down = false; });
    cv.addEventListener("pointercancel", () => { down = false; });
  }

  function resultView(res, stamp, keep) {
    clearInterval(tick);
    revealNow = null;
    // La opinión va por jugada/visita: al pintar un resultado nuevo se reinicia; al calificar se conserva.
    if (keep && fbState) { fbState.res = res; fbState.stamp = stamp; }
    else fbState = { res, stamp, rating: 0, sent: false, err: "" };
    const won = !stamp && res.won === true, c = (me && me.customer) || {}, p = th();
    if (res.card_completed) return cardCompleteView(res, won, p);
    const confetti = won
      ? `<div class="confetti" aria-hidden="true">${Array.from({ length: 18 }, (_, i) =>
          `<i style="left:${(i * 37) % 100}%;animation-delay:${(i % 9) * 0.12}s;background:${i % 2 ? "var(--a)" : "var(--p)"}"></i>`).join("")}</div>`
      : "";
    const extra = res.card_completed
      ? `${stamp ? "" : "¡Completaste tu tarjeta! "}Ganaste además: ${esc(p.stamps_reward_label || "premio por completar")}.`
      : `Sello ${c.stamps || 0} de ${p.stamps_goal || 1}.`;
    const kicker = stamp ? "Visita registrada" : won ? "¡Ganaste!" : "Sigue participando";
    const title = stamp
      ? res.card_completed ? "¡Completaste tu tarjeta!" : "Sello sumado"
      : won ? esc(res.prize && res.prize.label || "Premio") : "Casi lo logras";
    view.innerHTML = `<section class="card result">${confetti}
      <p class="kicker">${kicker}</p>
      <h2>${title}</h2>
      <p class="muted">${extra}</p>
      ${won && res.reward_id
        ? `<div class="res-actions">
             <button class="btn primary" data-act="redeem" data-id="${esc(res.reward_id)}">Canjear ahora</button>
             <button class="btn" data-act="home">Guardar para después</button>
           </div>`
        : `<button class="btn primary" data-act="home">Volver a mi tarjeta</button>`}
      ${feedbackHTML()}
      ${reviewHTML()}
    </section>`;
  }

  // Tarjeta completa: momento propio (tarjeta llena, el último sello "cae" y el premio grande al centro).
  function cardCompleteView(res, won, p) {
    const goal = Math.min(p.stamps_goal || 1, 40);
    const dots = Array.from({ length: goal }, (_, i) =>
      `<span class="stamp on${i === goal - 1 ? " last" : ""}">★</span>`).join("");
    const confetti = `<div class="confetti" aria-hidden="true">${Array.from({ length: 36 }, (_, i) =>
      `<i style="left:${(i * 29) % 100}%;animation-delay:${0.6 + (i % 12) * 0.1}s;background:${i % 2 ? "var(--a)" : "var(--p)"}"></i>`).join("")}</div>`;
    const id = res.stamps_reward_id;
    view.innerHTML = `<section class="card result complete">${confetti}
      <p class="kicker">¡Tarjeta completa!</p>
      <div class="stamps" style="--n:${goal}" role="img" aria-label="${goal} de ${goal} sellos">${dots}</div>
      <p class="stamp-line"><b>${goal}</b> de ${goal} sellos</p>
      <p class="muted">Te ganaste</p>
      <h2 class="big-prize">${esc(p.stamps_reward_label || "Premio por completar")}</h2>
      ${won ? `<p class="muted small">Y en el juego: ${esc(res.prize && res.prize.label || "un premio")}</p>` : ""}
      ${id
        ? `<div class="res-actions">
             <button class="btn primary" data-act="redeem" data-id="${esc(id)}">Canjear ahora</button>
             <button class="btn" data-act="home">Guardar para después</button>
           </div>`
        : `<button class="btn primary" data-act="home">Volver a mi tarjeta</button>`}
      ${feedbackHTML()}
      ${reviewHTML()}
    </section>`;
  }

  // Opinión privada de la visita (sección 4): 1–5. La reseña de Google nunca se condiciona a la nota.
  function feedbackHTML() {
    const f = fbState || { rating: 0 };
    const n = Number(f.rating) || 0;
    const stars = [1, 2, 3, 4, 5].map(v =>
      `<button type="button" class="fb-star${v <= n ? " on" : ""}" data-act="rate" data-rating="${v}" aria-label="${v} de 5">★</button>`).join("");
    let extra;
    if (!n) extra = `<p class="muted small">Tu respuesta es privada y nos ayuda a mejorar.</p>`;
    else if (f.sent) extra = `<p class="fb-thanks">${n >= 4 ? "¡Gracias! Nos alegra que la hayas pasado bien." : "¡Gracias! Tomamos nota para mejorar."}</p>`;
    else if (n <= 3) extra = `<form id="clubFeedbackForm" novalidate>
        <label for="clubFeedbackComment">Cuéntanos qué pasó (solo lo ve el restaurante)</label>
        <textarea id="clubFeedbackComment" name="comment" maxlength="500" rows="3" placeholder="Opcional"></textarea>
        <p class="err" id="clubFeedbackErr" role="alert">${esc(f.err || "")}</p>
        <button class="btn" type="submit">Enviar</button>
      </form>`;
    else extra = f.err
      ? `<p class="err" role="alert">${esc(f.err)}</p>`
      : `<p class="muted small">Enviando…</p>`;
    return `<div class="fb" id="clubFeedback">
      <p class="fb-q">¿Cómo estuvo tu visita?</p>
      <div class="fb-stars" role="group" aria-label="Califica tu visita de 1 a 5">${stars}</div>
      ${extra}
    </div>`;
  }

  // Reseña de Google: siempre visible tras el resultado; con nota baja queda más abajo y discreta.
  function reviewHTML() {
    const p = th();
    if (!p.review_url) return "";
    const low = fbState && fbState.rating >= 1 && fbState.rating <= 3;
    return `<div class="review${low ? " low" : ""}"><p class="muted small">¿Te gustó? Déjanos tu reseña.</p>
      <a class="btn ghost" href="${esc(p.review_url)}" target="_blank" rel="noopener">Escribir reseña</a></div>`;
  }

  async function rate(n) {
    if (!fbState || fbState.sent) return;
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 5) return;
    fbState.rating = v;
    fbState.err = "";
    resultView(fbState.res, fbState.stamp, true);
    if (v >= 4) await sendFeedback("");
  }

  // 4–5 se envía al instante; 1–3 espera el comentario. Un 409 (sin visita o ya enviada) no molesta.
  async function sendFeedback(comment) {
    if (!fbState || fbState.sent || !fbState.rating) return;
    const body = { rating: fbState.rating };
    const text = String(comment || "").trim().slice(0, 500);
    if (text) body.comment = text;
    const r = await api("feedback", body);
    if (r.status === 401) return; // api() ya recargó la página
    if (r.status === 0 || r.status >= 500) fbState.err = "No pudimos enviar tu opinión. Intenta de nuevo.";
    else { fbState.sent = true; fbState.err = ""; }
    resultView(fbState.res, fbState.stamp, true);
  }

  function submitFeedback(form) {
    const el = form.querySelector("[name=comment]");
    return sendFeedback(el ? el.value : "");
  }

  /* ── canje ── */
  function redeem(id) {
    const rw = (me && me.rewards || []).find(r => r.id === id);
    const el = document.createElement("div");
    el.className = "modal";
    el.id = "clubModal";
    el.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-label="Canjear premio">
      <h3>Muestra esta pantalla al mesero</h3>
      <p class="muted">Premio: <b>${esc(rw ? rw.label : "tu premio")}</b>. El mesero escribirá el PIN para canjearlo.</p>
      <form id="clubRedeemForm" novalidate>
        ${pinInput("")}
        <p class="err" id="clubRedeemErr" role="alert"></p>
        <button class="btn primary" type="submit">Confirmar canje</button>
        <button class="ghost" type="button" data-act="close">Cancelar</button>
      </form>
    </div>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    el.addEventListener("click", ev => { if (ev.target === el) close(); });
    el.querySelector("[data-act=close]").addEventListener("click", close);
    el.querySelector("#clubRedeemForm").addEventListener("submit", ev => {
      ev.preventDefault();
      submitRedeem(ev.target, id, close);
    });
  }

  async function submitRedeem(form, id, close) {
    const pin = (form.querySelector("[name=pin]").value || "").replace(/\D/g, "");
    const err = document.getElementById("clubRedeemErr");
    if (pin.length < 4 || pin.length > 6) { if (err) err.textContent = "El PIN tiene entre 4 y 6 dígitos."; return; }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const r = await api("redeem", { reward_id: id, pin });
    btn.disabled = false;
    if (r.status === 200) {
      me = r.data.me || me;
      close();
      toast("¡Premio canjeado! Muéstraselo al mesero.");
      return home();
    }
    if (r.status === 403 && r.data.error === "pin_invalido") {
      if (err) err.textContent = "PIN incorrecto. " + (r.data.attempts_left != null ? "Te quedan " + r.data.attempts_left + " intentos." : "Intenta de nuevo.");
      return;
    }
    if (r.status === 423) { close(); toast("Canje bloqueado. Pídele al mesero que te ayude."); return home(); }
    if (r.status === 429) { if (err) err.textContent = "Demasiados intentos. Espera un momento y vuelve a probar."; return; }
    if (r.status === 409) {
      close();
      toast(r.data.error === "vencido" ? "Este premio ya venció."
        : r.data.error === "sin_pin" ? "El local aún no activó el canje con PIN."
        : "Este premio ya fue canjeado.");
      return load();
    }
    if (err) err.textContent = "No pudimos canjear el premio. Intenta de nuevo.";
  }

  /* ── eventos ── */
  view.addEventListener("click", ev => {
    const b = ev.target.closest("[data-act]");
    if (!b || !view.contains(b)) return;
    ev.preventDefault();
    const act = b.dataset.act;
    if (act === "choose") choose();
    else if (act === "chooseCredit") choose(true);
    else if (act === "chooseScan") choose(true, true);
    else if (act === "start") play(b.dataset.game);
    else if (act === "stamp") play("stamp");
    else if (act === "credit") playCredit(b.dataset.game);
    else if (act === "pin") pinScreen(b.dataset.game || lastGame, "sin_ubicacion");
    else if (act === "card") cardView();
    else if (act === "cardClose") closeCard();
    else if (act === "cardPin") cardPin();
    else if (act === "reveal") { if (revealNow) revealNow(); }
    else if (act === "redeem") redeem(b.dataset.id);
    else if (act === "rate") rate(b.dataset.rating);
    else if (act === "dismissBday") { bdayDismissed = true; home(); }
    else if (act === "home") home();
  });

  view.addEventListener("submit", ev => {
    ev.preventDefault();
    if (ev.target.id === "clubLogin") login(ev.target);
    else if (ev.target.id === "clubPinForm") submitPin(ev.target);
    else if (ev.target.id === "clubBdayForm") saveBirthday(ev.target);
    else if (ev.target.id === "clubFeedbackForm") submitFeedback(ev.target);
  });

  if (outBtn) outBtn.addEventListener("click", async () => {
    await api("logout", {});
    location.href = "/club";
  });

  load();
}

// Una sola copia del código: el navegador recibe exactamente estas funciones (sin minificar ni duplicar).
const CLIENT_PURE = [
  qrMatrix, esc, safeUrl, wheelStopAngle, revealPercent, remainingText, groupCardCode, expiryText,
  birthdayValue, birthdaySelects, pinInput,
].map(String).join("\n");
const CLIENT_MAIN = String(runtime);

// JSON dentro de <script>: neutraliza </script> y separadores de línea (mismo criterio que el Worker).
function jsonInline(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderPage(menuCfg, cfg) {
  const m = menuCfg && typeof menuCfg === "object" ? menuCfg : {};
  const p = programOf(m, cfg);
  const favicon = safeUrl(m.favicon);
  const fonts = safeUrl(m.fonts);
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="${p.theme_primary}">
<title>${esc(p.store_name)} · Club</title>
${favicon ? `<link rel="icon" href="${esc(favicon)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts ? `<link rel="stylesheet" href="${esc(fonts)}">` : ""}
<style>${css(p.theme_primary, p.theme_accent)}</style>
</head>
<body>
<div class="club-wrap">
  <header class="club-head">
    <a class="club-menu" href="/">← Ver menú</a>
    <div class="club-brand">${p.logo ? `<img src="${esc(p.logo)}" alt="">` : ""}<span>${esc(p.store_name)}</span></div>
    <button class="club-out" id="clubLogout" type="button" hidden>Salir</button>
  </header>
  <main id="clubView" class="club-view">${loginHTML(p)}</main>
  ${p.terms ? `<footer class="club-foot">${esc(p.terms)}</footer>` : ""}
</div>
<div class="toast" id="clubToast" role="status" aria-live="polite"></div>
<script id="clubData">window.__CLUB__=${jsonInline(p)};</script>
<script id="clubPure">var __name=function(f){return f};${CLIENT_PURE}</script>
<script id="clubMain">${CLIENT_MAIN}
runtime();</script>
</body>
</html>`;
}
