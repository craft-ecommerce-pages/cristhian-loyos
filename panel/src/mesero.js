// MS2: página móvil para recibir, corregir y mandar a cocina las comandas.
import {
  shiftTicketLines,
  ticketColumns,
  ticketLines,
  ticketPageHeight,
} from "../../shared/ticket.js";
import { meseroBoot } from "./api.js";

export async function renderMeseroPage(request, env, site) {
  const slug = String(site?.slug ?? "");
  const config = await env.MENUS.get(`${slug}:config`, "json").catch(
    () => null,
  );
  const saved =
    config && typeof config.store_name === "string"
      ? config.store_name.trim()
      : "";
  const store = saved || slug || "Mi negocio";
  const boot = await meseroBoot(request, env, site).catch(() => null);
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111820"><meta name="color-scheme" content="light"><meta name="robots" content="noindex">
<title>${esc("Modo mesero · " + store)}</title><style>${MESERO_CSS}</style></head><body>
<header class="top"><a class="top-back" href="/panel" rel="noreferrer">← Panel</a>
<span class="top-name">${esc(store)}</span><span class="top-tag">Modo mesero</span></header>
<main id="mesero" class="wrap"><div class="boot" role="status"><span class="spin" aria-hidden="true"></span>
Cargando Modo mesero…</div></main>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script id="meseroData">var __name=function(f){return f};window.__MESERO__=${inline({ store, boot })};</script>
<script id="meseroTicket">var __ticket=${String(ticketLines)};window.__meseroTicket=__ticket;</script>
<script id="meseroColumns">var __columns=${String(ticketColumns)};window.__meseroColumns=__columns;</script>
<script id="meseroHeight">var __height=${String(ticketPageHeight)};window.__meseroHeight=__height;</script>
<script id="meseroShiftTicket">var __shiftTicket=${String(shiftTicketLines)};window.__meseroShiftTicket=__shiftTicket;</script>
<script id="meseroMain">${String(meseroRuntime)}
meseroRuntime();</script></body></html>`;
}

function inline(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

const MESERO_CSS = `*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--p:#C4691C;
--bg:#F6F5F2;
--card:#fff;
--soft:#F2F0EC;
--ink:#1F1D1A;
--ink2:#5C5850;
--muted:#8C877E;
--line:#E3DFD8;
--danger:#C4362F;
--ok:#1F7A55;
--side:#111820;
--side-ink:#f4f7fa;
--side-ink2:#aab6c0}
html,body{margin:0;
background:var(--bg);
color:var(--ink);
font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",Roboto,sans-serif;
font-size:15px;
line-height:1.45;
-webkit-text-size-adjust:100%}
h1,h2,h3,p{margin-top:0}
h1{font-size:23px;
line-height:1.2}
h2{font-size:17px;
line-height:1.25}
h3{font-size:15px;
margin-bottom:5px}
button,input,textarea,select{font:inherit}
.top{position:sticky;
top:0;
z-index:10;
display:flex;
align-items:center;
gap:10px;
padding:calc(10px + env(safe-area-inset-top)) 14px 10px;
background:var(--side);
color:var(--side-ink)}
.top-back{color:var(--side-ink2);
font-size:13px;
text-decoration:none}
.top-name{min-width:0;
flex:1;
overflow:hidden;
text-overflow:ellipsis;
white-space:nowrap;
font-size:14px;
font-weight:600}
.top-tag{color:#ffad68;
font-size:11.5px;
font-weight:700;
letter-spacing:.06em;
text-transform:uppercase}
.wrap{max-width:620px;
margin:0 auto;
padding:16px 14px calc(32px + env(safe-area-inset-bottom))}
.boot{display:flex;
align-items:center;
justify-content:center;
gap:10px;
min-height:45vh;
color:var(--muted)}
.spin{width:16px;
height:16px;
border:2px solid rgba(196,105,28,.18);
border-top-color:var(--p);
border-radius:50%;
animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}
}
.card{margin:0 0 14px;
padding:16px;
background:var(--card);
border:1px solid var(--line);
border-radius:14px;
box-shadow:0 1px 3px rgba(0,0,0,.06)}
.muted,.hint{color:var(--ink2)}
.hint{font-size:12.5px}
.empty{padding:25px 10px;
text-align:center;
color:var(--muted)}
.btn{display:inline-flex;
align-items:center;
justify-content:center;
min-height:44px;
padding:9px 13px;
border:1px solid var(--line);
border-radius:10px;
background:var(--card);
color:var(--ink);
font-size:14px;
font-weight:650;
cursor:pointer}
.btn:hover{background:var(--soft)}
.btn:disabled{opacity:.55;
cursor:default}
.btn.primary{background:var(--p);
border-color:var(--p);
color:#fff}
.btn.danger{border-color:rgba(196,54,47,.35);
color:var(--danger)}
.btn.small{min-height:38px;
padding:7px 10px;
font-size:13px}
.btn.wide{width:100%}
.btn.link{border:0;
background:transparent;
color:var(--ink2)}
.tabs,.filters,.actions,.chips{display:flex;
gap:8px;
align-items:center}
.tabs{margin:0 0 14px}
.tabs .btn{flex:1}
.filters{overflow:auto;
padding-bottom:8px;
margin:0 0 6px}
.filters .btn{white-space:nowrap}
.selected{border-color:var(--p)!important;
background:rgba(196,105,28,.1)!important;
color:var(--p)!important}
.bar{display:flex;
gap:10px;
align-items:center;
justify-content:space-between;
margin:0 0 12px}
.bar strong{font-size:14px}
.order-head{display:flex;
align-items:start;
gap:10px}
.order-no{font-size:27px;
font-weight:800;
line-height:1;
font-variant-numeric:tabular-nums}
.order-meta{flex:1;
min-width:0}
.order-when{display:block}
.catalog-product:disabled{opacity:.5;
cursor:not-allowed}
.badges{display:flex;
flex-wrap:wrap;
gap:5px;
margin:5px 0}
.badge{padding:2px 7px;
border-radius:99px;
background:var(--soft);
color:var(--ink2);
font-size:11px;
font-weight:700}
.badge.pending{color:#935500;
background:#fff1d9}
.badge.confirmed{color:var(--ok);
background:#e6f4ed}
.badge.paid{color:#0f5c7a;
background:#e3f2f8}
.badge.ready{color:var(--ok);
background:#e6f4ed}
.badge.rejected{color:var(--danger);
background:#fbe9e8}
.lines{margin:12px 0;
padding:0;
list-style:none;
border-top:1px solid var(--line)}
.lines li{padding:8px 0;
border-bottom:1px solid var(--line);
font-size:13.5px}
.variant{display:block;
margin-top:2px;
color:var(--ink2);
font-size:12.5px}
.order-note{margin:10px 0 0;
padding:9px 10px;
border-radius:9px;
background:var(--soft);
font-size:13px;
white-space:pre-wrap}
.actions{flex-wrap:wrap;
margin-top:12px}
.actions .btn{flex:1}
.edited{margin:9px 0 0;
color:var(--muted);
font-size:12px}
.field{display:block;
margin:0 0 12px}
.field span{display:block;
margin:0 0 6px;
color:var(--ink2);
font-size:12.5px;
font-weight:650}
input,textarea,select{width:100%;
padding:11px;
border:1px solid var(--line);
border-radius:10px;
background:var(--soft);
color:var(--ink);
outline:none}
textarea{min-height:74px;
resize:vertical}
input:focus,textarea:focus,select:focus{border-color:var(--p);
background:#fff;
box-shadow:0 0 0 3px rgba(196,105,28,.12)}
.pin input{height:60px;
text-align:center;
font-size:26px;
letter-spacing:.35em}
.err{margin:10px 0 0;
color:var(--danger);
font-size:13px;
font-weight:650}
.err:empty{display:none}
.catalog-grid{display:grid;
grid-template-columns:repeat(auto-fill,minmax(150px,1fr));
gap:10px;
margin:0 0 14px}
.catalog-product{display:flex;
flex-direction:column;
justify-content:flex-start;
gap:0;
min-height:0;
padding:0;
font-weight:650;
overflow:hidden;
overflow-wrap:anywhere;
border:1px solid var(--line);
border-radius:11px;
background:var(--card);
color:var(--ink);
text-align:left;
cursor:pointer}
.catalog-media{display:block;
width:100%;
aspect-ratio:4/3;
background:var(--soft);
overflow:hidden}
.catalog-media img{display:block;
width:100%;
height:100%;
object-fit:cover}
.media-fallback{display:grid;
place-items:center;
width:100%;
height:100%;
background:linear-gradient(135deg,#F3F0EA,#E8E3DA);
color:var(--muted);
font-size:11px;
font-weight:700;
letter-spacing:.08em;
text-transform:uppercase}
.media-fallback::before{content:"Sin foto"}
.catalog-body{display:flex;
flex:1;
flex-direction:column;
justify-content:space-between;
gap:4px;
width:100%;
padding:10px 11px}
.catalog-product:focus-visible{outline:3px solid var(--p);
outline-offset:2px}
.catalog-product{position:relative;
transition:transform .08s,background .08s,border-color .08s}
.catalog-product:not(:disabled):active{transform:scale(.96);
border-color:var(--p);
background:rgba(196,105,28,.12)}
@media (hover:hover){.catalog-product:not(:disabled):hover{border-color:var(--p)}}
.catalog-product.in-cart{border-color:var(--p)}
.qty-badge{position:absolute;
top:6px;
right:6px;
padding:1px 7px;
border-radius:99px;
background:var(--p);
color:#fff;
font-size:12px}
.builder{padding-bottom:84px}
.builder>input{margin:0 0 10px}
.cart-bar{position:fixed;
left:12px;
right:12px;
bottom:calc(12px + env(safe-area-inset-bottom));
z-index:20;
display:flex;
justify-content:space-between;
align-items:center;
max-width:620px;
margin:0 auto;
min-height:54px;
padding:0 18px;
border:0;
border-radius:14px;
background:var(--p);
color:#fff;
font-size:16px;
font-weight:700;
box-shadow:0 8px 24px rgba(0,0,0,.2)}
.cart-bar[hidden]{display:none}
.builder-name input{margin-top:6px;
padding:8px;
font-size:13px}
.catalog-price{color:var(--ink2);
font-size:13px;
white-space:nowrap}
.builder-item{display:flex;
align-items:center;
gap:9px;
padding:10px 0;
border-bottom:1px solid var(--line)}
.builder-item:last-child{border-bottom:0}
.builder-name{min-width:0;
flex:1}
.builder-name b,.builder-name span{display:block}
.builder-name span{overflow-wrap:anywhere;
color:var(--ink2);
font-size:12px}
.qty{display:flex;
align-items:center;
gap:5px}
.qty button{width:30px;
height:30px;
border:1px solid var(--line);
border-radius:8px;
background:var(--card);
font-size:18px}
.qty b{min-width:18px;
text-align:center}
.total{display:flex;
justify-content:space-between;
margin:14px 0;
font-size:18px}
.sheet{position:fixed;
inset:0;
z-index:30;
display:flex;
align-items:end;
background:rgba(0,0,0,.35)}
.sheet-box{width:100%;
max-height:88vh;
overflow:auto;
padding:20px 14px calc(20px + env(safe-area-inset-bottom));
background:var(--card);
border-radius:18px 18px 0 0}
.option{display:flex;
gap:10px;
align-items:center;
padding:10px 0;
border-bottom:1px solid var(--line)}
.option input{width:auto;
flex:none}
.toast{position:fixed;
left:50%;
bottom:calc(80px + env(safe-area-inset-bottom));
z-index:60;
max-width:min(92vw,420px);
padding:10px 16px;
border-radius:10px;
background:#1F1D1A;
color:#fff;
font-size:13px;
font-weight:500;
text-align:center;
opacity:0;
pointer-events:none;
transform:translate(-50%,8px);
transition:opacity .2s,transform .2s}
.toast.show{opacity:1;
transform:translate(-50%,0)}
.toast.bad{background:var(--danger)}
.shift-head{display:flex;
align-items:center;
justify-content:space-between;
gap:10px}
.shift-state{font-size:15px;
font-weight:800}
.shift-when{display:block;
margin-top:2px}
.shift-actions{display:flex;
flex-wrap:wrap;
gap:8px;
margin-top:12px}
.shift-actions .btn{flex:1 1 45%}
.shift-moves{margin:12px 0 0;
padding:0;
list-style:none;
border-top:1px solid var(--line);
font-size:13px}
.shift-moves li{display:flex;
justify-content:space-between;
gap:10px;
padding:6px 0;
border-bottom:1px solid var(--line)}
.shift-moves li:last-child{border-bottom:0}
.shift-moves span:last-child{white-space:nowrap;
font-variant-numeric:tabular-nums}
.shift-total{display:flex;
justify-content:space-between;
gap:10px;
padding:7px 0;
border-bottom:1px solid var(--line)}
.shift-total:last-child{border-bottom:0}
.shift-total b{font-variant-numeric:tabular-nums;
white-space:nowrap}
.negative{color:var(--danger)}
.positive{color:var(--ok)}
.denom-row{display:flex;
align-items:center;
justify-content:space-between;
gap:10px;
padding:7px 0;
border-bottom:1px solid var(--line)}
.denom-row:last-child{border-bottom:0}
.denom-row span{font-size:13px;
color:var(--ink2);
font-weight:650}
.denom-row input{width:88px;
flex:none;
padding:8px;
text-align:right}
details{margin:16px 0;
color:var(--ink2);
font-size:13px}
details summary{cursor:pointer;
font-weight:650;
color:var(--ink)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;
transition:none!important}
}
`;

function meseroRuntime() {
  const S = window.__MESERO__ || {};
  const root = document.getElementById("mesero");
  const toastEl = document.getElementById("toast");
  const ticket =
    typeof window.__meseroTicket === "function"
      ? window.__meseroTicket
      : () => [];
  const columnsForPaper =
    typeof window.__meseroColumns === "function"
      ? window.__meseroColumns
      : (paper) => (Number(paper) === 58 ? 32 : 48);
  const pageHeight =
    typeof window.__meseroHeight === "function"
      ? window.__meseroHeight
      : (lineCount) => Math.max(50, Math.ceil(Number(lineCount) * 3.8 + 8));
  const shiftTicket =
    typeof window.__meseroShiftTicket === "function"
      ? window.__meseroShiftTicket
      : () => [];
  const MESSAGES = {
    pin_invalido: "PIN incorrecto. Revísalo con el dueño del menú.",
    demasiados_intentos:
      "Demasiados intentos. Espera unos minutos y vuelve a probar.",
    meseros_no_disponibles:
      "Los meseros no están disponibles; entra con la cuenta del dueño.",
    sin_sesion: "Tu sesión venció. Vuelve a entrar con tu PIN.",
    pedido_invalido: "Revisa los datos del pedido.",
    estado_invalido: "Ese pedido ya no se puede modificar.",
    pedido_no_existe: "No encontramos ese pedido.",
    sin_permiso: "No tienes permiso para operar esta sede.",
    sede_requerida: "Elige la sede antes de continuar.",
    sede_invalida: "La sede elegida ya no está disponible.",
    sin_stock: "Un producto ya no tiene stock suficiente.",
    producto_no_disponible: "Un producto ya no está disponible.",
    orden_ya_pagada: "Ese pedido ya está pagado.",
    idempotencia_conflicto: "Ese intento ya se usó con otros datos. Vuelve a intentar.",
    caja_cerrada: "Abre la caja de esta sede para cobrar.",
    caja_ya_abierta: "Esta sede ya tiene una caja abierta.",
    turno_cerrado: "Ese turno ya está cerrado.",
    monto_invalido: "Revisa el monto: debe ser mayor que cero.",
    motivo_invalido: "Escribe un motivo de 3 a 120 caracteres.",
    fondo_invalido: "Revisa el fondo inicial: no puede ser negativo.",
    conteo_invalido: "Escribe el efectivo contado para cerrar la caja.",
  };
  let me = null,
    catalog = null,
    orders = [],
    sedes = [],
    sede = "",
    filter = "pending",
    tab = "orders",
    builder = null,
    busy = false,
    query = "",
    category = "",
    repaintItems = null,
    loadedAt = 0,
    shift = null,
    shiftSede = "",
    shiftStatus = "ok",
    closedReport = null;
  // Botón "atrás" (Android/tablet): Nuevo pedido y cada modal son entradas del historial.
  const H =
    window.history && typeof window.history.pushState === "function"
      ? window.history
      : null;
  const where = () => (H && H.state && H.state.m) || "orders";
  const push = (m) => H && H.pushState({ m }, "");
  function showSheet(node) {
    closeSheet();
    document.body.append(node);
    if (where() !== "sheet") push("sheet");
  }
  // Cerrar/Cancelar = atrás; el popstate quita el modal.
  function dismissSheet() {
    if (where() === "sheet") H.back();
    else closeSheet();
  }
  function goTab(next) {
    if (next === tab) return;
    if (next === "new") {
      newBuilder();
      tab = "new";
      push("new");
      render();
    } else if (where() === "new") H.back();
    else {
      tab = "orders";
      render();
    }
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("popstate", () => {
      const m = where();
      if (m !== "sheet") closeSheet();
      const next = m === "orders" ? "orders" : "new";
      if (next !== tab) {
        tab = next;
        if (next === "new") newBuilder();
        render();
      } else if (tab === "new" && repaintItems) repaintItems();
    });

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    let value, checked;
    if (attrs)
      for (const key in attrs) {
        const item = attrs[key];
        if (item == null || item === false) continue;
        if (key === "class") node.className = item;
        else if (key === "text") node.textContent = item;
        else if (key === "value") value = item;
        else if (key === "checked") checked = !!item;
        else if (key.startsWith("on") && typeof item === "function")
          node.addEventListener(key.slice(2), item);
        else node.setAttribute(key, item === true ? "" : String(item));
      }
    if (value !== undefined) node.value = value;
    if (checked !== undefined) node.checked = checked;
    for (const kid of kids.flat(Infinity))
      if (kid != null && kid !== false)
        node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return node;
  }
  const button = (label, cls, click, extra) =>
    h(
      "button",
      Object.assign(
        { type: "button", class: cls, onclick: click },
        extra || {},
      ),
      label,
    );
  const text = (value) => String(value ?? "").trim();
  // "Lasaña" se encuentra escribiendo "lasana": sin tildes ni mayúsculas.
  const fold = (value) =>
    text(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
  const amount = (value) =>
    Number.isFinite(Number(value)) ? Number(value) : 0;
  const money = (value) => {
    try {
      return new Intl.NumberFormat("es-EC", {
        style: "currency",
        currency: me?.store?.currency || "USD",
      }).format(amount(value));
    } catch {
      return "$" + amount(value).toFixed(2);
    }
  };
  // El turno trabaja en centavos enteros: se formatea sin dividir por 100 con flotantes.
  const moneyCents = (value) => {
    const number = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
    const sign = number < 0 ? "-" : "";
    const abs = Math.abs(number);
    return (
      sign + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0")
    );
  };
  // "20", "20.5", "20,50" → centavos. Devuelve null si no es un monto válido.
  const centsFrom = (value) => {
    const raw = text(value).replace(/\s+/g, "").replace(",", ".");
    const match = /^(\d{0,9})(?:\.(\d{0,2}))?$/.exec(raw);
    if (!match || (!match[1] && !match[2])) return null;
    const units = Number(match[1] || 0);
    const fraction = (match[2] || "").padEnd(2, "0");
    return units * 100 + Number(fraction || 0);
  };
  // Misma clave mientras el cuerpo no cambie: reintentar tras un corte de red
  // no duplica el turno, el movimiento ni el cierre.
  const idempotency = (state, body) => {
    const fingerprint = JSON.stringify(body || {});
    if (state.key && state.fingerprint === fingerprint) return state.key;
    state.key = uuid();
    state.fingerprint = fingerprint;
    return state.key;
  };
  // Conteo opcional por denominaciones USD; todo suma en centavos enteros.
  const DENOMINATIONS = [
    { cents: 2000, label: "Billetes de $20" },
    { cents: 1000, label: "Billetes de $10" },
    { cents: 500, label: "Billetes de $5" },
    { cents: 100, label: "Billetes de $1" },
    { cents: 100, label: "Monedas de $1" },
    { cents: 50, label: "Monedas de 50 ¢" },
    { cents: 25, label: "Monedas de 25 ¢" },
    { cents: 10, label: "Monedas de 10 ¢" },
    { cents: 5, label: "Monedas de 5 ¢" },
    { cents: 1, label: "Monedas de 1 ¢" },
  ];
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function")
        return window.crypto.randomUUID();
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
      return (
        hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) +
        "-" + hex.slice(16, 20) + "-" + hex.slice(20)
      );
    } catch {
      return "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
  }
  // Solo https o rutas locales: nunca se pinta un src ajeno a la media del menú.
  function imageUrl(value) {
    const url = text(value);
    return /^(https:\/\/|\/(?!\/))/i.test(url) ? url : "";
  }
  function productImage(product) {
    const list = Array.isArray(product?.images)
      ? product.images
      : Array.isArray(product?.imagenes)
        ? product.imagenes
        : [];
    return (
      imageUrl(list.find(Boolean)) ||
      imageUrl(product?.image) ||
      imageUrl(product?.imagen)
    );
  }
  function mediaFallback() {
    return h("span", { class: "media-fallback", "aria-hidden": "true" });
  }
  // La imagen es decorativa: el nombre ya está visible y el botón expone nombre + precio.
  function productMedia(product) {
    const box = h("span", { class: "catalog-media" });
    const url = productImage(product);
    if (!url) {
      box.append(mediaFallback(product));
      return box;
    }
    const img = h("img", {
      src: url,
      alt: "",
      loading: "lazy",
      decoding: "async",
    });
    img.addEventListener("error", () => {
      img.remove();
      box.append(mediaFallback(product));
    });
    box.append(img);
    return box;
  }
  const isPosOrder = (order) =>
    !!order && (order.sede_id != null || order.total_cents != null);
  const clientName = (order) =>
    text(order?.customer_name ?? order?.client_name);
  const orderTotal = (order) =>
    order?.total_cents != null
      ? amount(order.total_cents) / 100
      : amount(order?.total);
  const itemName = (item) => text(item?.nombre ?? item?.name) || "Producto";
  const itemVariant = (item) => text(item?.variant_id ?? item?.variant);
  const itemNote = (item) =>
    item?.note && text(item.note) !== itemVariant(item) ? text(item.note) : "";
  function toast(message, bad) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    window.setTimeout(() => toastEl.classList.remove("show"), 3200);
  }
  function message(result, fallback) {
    return MESSAGES[result?.data?.error] || fallback;
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
      const response = await fetch("/panel/api/mesero/" + path, options);
      return {
        status: response.status,
        data:
          response.status === 204
            ? {}
            : await response.json().catch(() => ({})),
      };
    } catch {
      return { status: 0, data: {} };
    }
  }
  // Acciones POS del operador (cobro) viven bajo /panel/api/orders y aceptan caja_s.
  async function callRoot(path, body) {
    const options = {
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      body: JSON.stringify(body || {}),
    };
    try {
      const response = await fetch("/panel/api/" + path, options);
      return {
        status: response.status,
        data:
          response.status === 204
            ? {}
            : await response.json().catch(() => ({})),
      };
    } catch {
      return { status: 0, data: {} };
    }
  }
  // Turnos y cierre de caja: misma cookie de caja que el resto del panel.
  async function callTurnos(path, body) {
    const options = {
      credentials: "same-origin",
      headers: { accept: "application/json" },
      method: body === undefined ? "GET" : "POST",
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
      options.headers["content-type"] = "application/json";
    }
    try {
      const response = await fetch("/panel/api/turnos/" + path, options);
      return {
        status: response.status,
        data:
          response.status === 204
            ? {}
            : await response.json().catch(() => ({})),
      };
    } catch {
      return { status: 0, data: {} };
    }
  }
  function ecTime(value) {
    try {
      return new Date(Number(value)).toLocaleTimeString("es-EC", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/Guayaquil",
      });
    } catch {
      return "";
    }
  }
  function shortNumber(order) {
    return Number.isInteger(Number(order?.number)) && Number(order.number) > 0
      ? "#" + String(order.number)
      : "#" + text(order?.id).slice(-4);
  }
  function storedSede() {
    try {
      return text(localStorage.getItem("mesero.sede"));
    } catch {
      return "";
    }
  }
  function rememberSede(id) {
    try {
      if (id) localStorage.setItem("mesero.sede", id);
      else localStorage.removeItem("mesero.sede");
    } catch {
      /* navegador restringido */
    }
  }
  function sedeLabel(id) {
    const found = sedes.find((item) => item && item.id === id);
    return found ? text(found.nombre) || id : "";
  }
  // Solo dígitos: el enlace wa.me se abre a mano desde el pedido listo.
  function orderPhone(order) {
    const digits = text(order?.customer_phone ?? order?.client_phone).replace(
      /\D/g,
      "",
    );
    return /^\d{8,15}$/.test(digits) ? digits : "";
  }
  // Aviso manual: número y sede, sin cédula/RUC, correo ni dirección.
  function waLink(order) {
    const phone = orderPhone(order);
    if (!phone) return "";
    const who = clientName(order);
    const place = sedeLabel(order?.sede_id) || text(order?.sede_id);
    const message =
      "Hola" +
      (who ? " " + who : "") +
      ", tu pedido " +
      shortNumber(order) +
      (place ? " de " + place : "") +
      " está listo. Te esperamos.";
    return "https://wa.me/" + phone + "?text=" + encodeURIComponent(message);
  }
  // Sin inventar sedes: la lista sale de /panel/api/mesero/me y empieza vacía.
  function sedeSelect(onChange) {
    const select = h(
      "select",
      { "aria-label": "Sede de esta operación" },
      h("option", { value: "", text: "Elige una sede" }),
      sedes.map((item) =>
        h("option", {
          value: item.id,
          text: text(item.nombre) || item.id,
        }),
      ),
    );
    select.value = sedes.some((item) => item && item.id === sede) ? sede : "";
    select.addEventListener("change", () => {
      sede = select.value;
      rememberSede(sede);
      if (onChange) onChange();
    });
    return select;
  }
  function visibleProducts() {
    return Array.isArray(catalog?.products)
      ? catalog.products.filter(
          (product) => product && product.active && product.catalog_visible,
        )
      : [];
  }
  function groupVariants(product) {
    const own = Array.isArray(product?.variants)
      ? product.variants
      : Array.isArray(product?.variantes)
        ? product.variantes
        : [];
    const groups = Array.isArray(catalog?.variant_groups)
      ? catalog.variant_groups
      : [];
    const assigned = Array.isArray(product?.groups) ? product.groups : [];
    return own.concat(
      assigned
        .map((ref) => {
          const group = groups.find((item) => item && item.id === ref.group_id);
          return group
            ? {
                ...group,
                pick:
                  ref.pick_override == null ? group.pick : ref.pick_override,
              }
            : null;
        })
        .filter(Boolean),
    );
  }
  function optionLabel(option) {
    return text(
      typeof option === "object" ? (option.name ?? option.label) : option,
    );
  }
  function optionKey(option, index) {
    return (
      text(
        typeof option === "object"
          ? (option.id ?? option.name ?? option.label)
          : option,
      ) || String(index)
    );
  }
  function choicesOK(groups, choices) {
    return groups.every((group, index) => {
      const chosen = choices[index];
      if (group?.type === "distribute")
        return (
          Array.isArray(chosen) &&
          chosen.length === Math.max(1, Number(group.pick) || 1)
        );
      return group?.optional || text(chosen);
    });
  }
  function buildItem(product, choices = {}, note = "") {
    const groups = Array.isArray(product?.__groups)
      ? product.__groups
      : groupVariants(product || {});
    let price = amount(product?.price ?? product?.precio);
    const labels = [];
    let variantId = "";
    groups.forEach((group, index) => {
      const selected =
        group?.type === "distribute"
          ? Array.isArray(choices[index])
            ? choices[index]
            : []
          : [choices[index]];
      selected.filter(Boolean).forEach((key) => {
        const option = (group.options || []).find(
          (item, at) => optionKey(item, at) === key,
        );
        if (!option) return;
        const label = optionLabel(option);
        labels.push(label);
        const priced =
          typeof option === "object" &&
          (Number.isFinite(Number(option.price)) ||
            Number.isFinite(Number(option.price_delta)));
        if (
          !variantId &&
          (group.type === "price_select" || priced) &&
          group.type !== "distribute"
        )
          variantId = label;
        if (
          group.type === "price_select" &&
          typeof option === "object" &&
          Number.isFinite(Number(option.price))
        )
          price = Number(option.price);
      });
    });
    const cleanNote = text(note);
    const variant = labels
      .concat(cleanNote ? "Nota: " + cleanNote : [])
      .filter(Boolean)
      .join(" · ");
    const item = {
      nombre: text(product?.name ?? product?.nombre) || "Producto",
      qty: 1,
      precio: price,
    };
    // El POS recalcula con product_id/variant_id; el nombre y precio quedan para la vista.
    if (text(product?.id)) item.product_id = text(product.id);
    if (text(product?.id) && variantId) item.variant_id = variantId;
    if (variant) item.variant = variant;
    if (text(product?.id) && cleanNote) item.note = cleanNote;
    return item;
  }
  window.__meseroBuildItem = buildItem;
  window.__meseroChoicesOK = choicesOK;

  function pinScreen(notice) {
    const pin = h("input", {
      type: "password",
      inputmode: "numeric",
      autocomplete: "one-time-code",
      maxlength: "6",
      placeholder: "••••",
      "aria-label": "PIN del mesero",
    });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h(
      "button",
      { type: "submit", class: "btn primary wide" },
      "Entrar",
    );
    pin.addEventListener("input", () => {
      pin.value = pin.value.replace(/\D/g, "").slice(0, 6);
    });
    const form = h(
      "form",
      { class: "card pin", novalidate: true },
      h("h1", { text: "Modo mesero" }),
      h("p", {
        class: "muted",
        text: "Entra con tu PIN para revisar pedidos y mandar comandas a cocina.",
      }),
      h(
        "label",
        { class: "field" },
        h("span", { text: "PIN del mesero" }),
        pin,
      ),
      submit,
      err,
    );
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!/^\d{4,6}$/.test(pin.value)) {
        err.textContent = "El PIN tiene entre 4 y 6 dígitos.";
        return;
      }
      submit.disabled = true;
      const result = await call("login", { pin: pin.value });
      submit.disabled = false;
      if (result.status === 200) return start();
      pin.value = "";
      pin.focus();
      err.textContent = message(result, "No pudimos entrar. Revisa tu PIN.");
    });
    root.replaceChildren(
      h(
        "section",
        {},
        notice ? h("p", { class: "card", text: notice }) : null,
        form,
      ),
    );
    pin.focus();
  }
  async function start() {
    if (H) H.replaceState({ m: "orders" }, "");
    // El HTML ya trae sesión, catálogo y pendientes: abrir = 1 request.
    const boot = S.boot;
    S.boot = null;
    if (boot && boot.me) {
      me = boot.me;
      catalog = boot.catalog || { products: [] };
      orders = Array.isArray(boot.orders) ? boot.orders : [];
      applySedes();
      loadedAt = Date.now();
      await loadShift();
      return render();
    }
    const result = await call("me");
    if (result.status === 401) return pinScreen("");
    if (result.status === 503)
      return pinScreen(MESSAGES.meseros_no_disponibles);
    if (result.status !== 200)
      return pinScreen("No pudimos abrir el Modo mesero. Intenta de nuevo.");
    me = result.data || {};
    applySedes();
    await Promise.all([loadCatalog(), loadOrders(), loadShift()]);
    if (!me) return;
    render();
  }
  function applySedes() {
    sedes = (Array.isArray(me?.sedes) ? me.sedes : [])
      .filter((item) => item && text(item.id))
      .map((item) => ({ id: text(item.id), nombre: text(item.nombre) }));
    const saved = storedSede();
    sede = sedes.some((item) => item.id === saved) ? saved : "";
  }
  function sessionExpired() {
    me = null;
    pinScreen(MESSAGES.sin_sesion);
  }
  async function loadCatalog() {
    const result = await call("catalog");
    if (result.status === 401) return sessionExpired();
    if (result.status === 200) catalog = result.data || { products: [] };
  }
  async function loadOrders() {
    const legacyStatus = ["pending", "confirmed", "all"].includes(filter)
      ? filter
      : "";
    const jobs = [
      legacyStatus
        ? call("orders?status=" + encodeURIComponent(legacyStatus) + "&limit=50")
        : null,
      sede
        ? call(
            "orders?sede_id=" +
              encodeURIComponent(sede) +
              "&status=" +
              encodeURIComponent(filter) +
              "&limit=50",
          )
        : null,
    ];
    const results = await Promise.all(jobs.filter(Boolean));
    if (results.some((result) => result.status === 401)) return sessionExpired();
    const merged = [];
    let failed = false;
    for (const result of results) {
      if (result.status === 200)
        merged.push(
          ...(Array.isArray(result.data?.orders) ? result.data.orders : []),
        );
      else if (result.status) failed = true;
    }
    if (failed && !merged.length) {
      toast(
        message(results.find((result) => result.status), "No pudimos actualizar los pedidos."),
        true,
      );
    }
    const seen = new Set();
    orders = merged
      .filter((order) => {
        const id = text(order?.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .sort((a, b) => amount(b?.created_at) - amount(a?.created_at));
    loadedAt = Date.now();
  }
  function top() {
    const staff = text(me?.staff?.name) || (me?.owner ? "Dueño" : "Mesero");
    return h(
      "div",
      { class: "bar" },
      h("strong", { text: staff }),
      button("Salir", "btn link", logout),
    );
  }
  function tabs() {
    return h(
      "div",
      { class: "tabs", role: "tablist" },
      button("Pedidos", "btn " + (tab === "orders" ? "selected" : ""), () =>
        goTab("orders"),
      ),
      button("Nuevo pedido", "btn " + (tab === "new" ? "selected" : ""), () =>
        goTab("new"),
      ),
    );
  }
  // "Mesa 4 · Andrea": la mesa y quién pidió; los manuales ya se llaman "Mesa N"/"Mostrador".
  function orderTitle(order) {
    const name = clientName(order);
    if (!order.table_no) return name || "Mostrador";
    const table = "Mesa " + order.table_no;
    return name && name !== table ? table + " · " + name : table;
  }
  const STATE_LABEL = {
    pending: "Pendiente · sin comanda",
    confirmed: "Confirmado · falta cobro",
    paid: "Pago confirmado",
    ready: "Listo para avisar",
    rejected: "Rechazado",
  };
  const METHOD_LABEL = {
    cash: "Efectivo",
    transfer: "Transferencia",
    bendo: "Tarjeta (Bendo)",
    payphone: "Tarjeta (Payphone)",
  };
  // Estado de caja de la sede activa. El cajero ve el turno y sus movimientos,
  // nunca ventas, esperado ni diferencia antes de cerrar (arqueo ciego).
  async function loadShift() {
    const wanted = sede;
    if (!wanted) {
      shift = null;
      shiftSede = "";
      shiftStatus = "ok";
      closedReport = null;
      return;
    }
    const result = await callTurnos("actual?sede_id=" + encodeURIComponent(wanted));
    // La sede pudo cambiar mientras viajaba la consulta.
    if (sede !== wanted) return;
    if (result.status === 401) return sessionExpired();
    if (result.status === 200) {
      shift = result.data?.shift || null;
      shiftSede = wanted;
      shiftStatus = "ok";
      if (closedReport && closedReport.sede_id !== wanted) closedReport = null;
      return;
    }
    shift = null;
    shiftSede = wanted;
    shiftStatus =
      result.status === 404 || result.status === 405 ? "no_disponible" : "error";
  }
  function shiftBar() {
    const aria = { class: "card", "aria-label": "Caja de la sede" };
    if (!sede)
      return h(
        "section",
        aria,
        h("strong", { class: "shift-state", text: "Caja" }),
        h("p", {
          class: "hint",
          text: "Elige la sede para abrir la caja y cobrar.",
        }),
      );
    if (shiftStatus === "no_disponible")
      return h(
        "section",
        aria,
        h("strong", { class: "shift-state", text: "Caja" }),
        h("p", {
          class: "hint",
          text: "Esta versión del panel todavía no permite controlar la caja. Actualiza el panel.",
        }),
      );
    if (shiftStatus === "error")
      return h(
        "section",
        aria,
        h("strong", { class: "shift-state", text: "Caja" }),
        h("p", { class: "hint", text: "No pudimos consultar la caja de esta sede." }),
        button("Reintentar", "btn small", (event) =>
          act(event.currentTarget, async () => {
            await loadShift();
            render();
          }),
        ),
      );
    if (!shift)
      return h(
        "section",
        aria,
        h(
          "div",
          { class: "shift-head" },
          h(
            "div",
            {},
            h("strong", { class: "shift-state", text: "Caja cerrada" }),
            sedeLabel(sede)
              ? h("span", { class: "hint", text: sedeLabel(sede) })
              : null,
          ),
        ),
        h("p", {
          class: "hint",
          text: "Abre la caja antes de cobrar en efectivo o por transferencia.",
        }),
        h(
          "div",
          { class: "shift-actions" },
          button("Abrir caja", "btn primary small", openShiftSheet),
        ),
      );
    const opened = ecTime(shift.opened_at);
    const moves = Array.isArray(shift.movements) ? shift.movements : [];
    return h(
      "section",
      aria,
      h(
        "div",
        { class: "shift-head" },
        h(
          "div",
          {},
          h("strong", { class: "shift-state", text: "Caja abierta" }),
          h("span", {
            class: "hint shift-when",
            text: opened ? "Caja abierta desde " + opened : "Caja abierta",
          }),
          sedeLabel(sede)
            ? h("span", { class: "hint", text: sedeLabel(sede) })
            : null,
        ),
      ),
      moves.length
        ? h(
            "ul",
            { class: "shift-moves", "aria-label": "Movimientos de efectivo" },
            moves.slice(-4).map((move) => {
              const out = text(move?.kind) === "out";
              return h(
                "li",
                {},
                h("span", {
                  text:
                    (out ? "Retiro" : "Ingreso") +
                    " · " +
                    (text(move?.reason) || "Sin motivo") +
                    (ecTime(move?.created_at) ? " · " + ecTime(move.created_at) : ""),
                }),
                h("span", {
                  text: (out ? "−" : "+") + moneyCents(move?.amount_cents),
                }),
              );
            }),
          )
        : null,
      h(
        "div",
        { class: "shift-actions" },
        button("Ingreso de efectivo", "btn small", () => movementSheet("in")),
        button("Retiro de efectivo", "btn small", () => movementSheet("out")),
        button("Cerrar caja", "btn danger small", closeShiftSheet),
      ),
    );
  }
  function reportCard() {
    const report = closedReport;
    if (!report) return null;
    const sales = Array.isArray(report.sales) ? report.sales : [];
    const movements =
      report.movements && typeof report.movements === "object"
        ? report.movements
        : {};
    const pending =
      report.pending_payments && typeof report.pending_payments === "object"
        ? report.pending_payments
        : {};
    const orders =
      report.orders && typeof report.orders === "object" ? report.orders : {};
    const difference = Number.isFinite(Number(report.difference_cents))
      ? Math.trunc(Number(report.difference_cents))
      : 0;
    const row = (label, value, cls) =>
      h(
        "div",
        { class: "shift-total" },
        h("span", { text: label }),
        h("b", { class: cls || "", text: value }),
      );
    const pendingCount = Math.max(0, Math.trunc(Number(pending.count) || 0));
    return h(
      "section",
      { class: "card", "aria-labelledby": "cierre-titulo" },
      h(
        "div",
        { class: "shift-head" },
        h("h2", { id: "cierre-titulo", text: "Cierre de caja" }),
        button("Imprimir cierre", "btn small", (event) =>
          printShift(report, event.currentTarget),
        ),
      ),
      h("p", {
        class: "hint",
        text:
          "Turno cerrado" +
          (ecTime(report.closed_at) ? " a las " + ecTime(report.closed_at) : "") +
          (sedeLabel(report.sede_id) ? " · " + sedeLabel(report.sede_id) : ""),
      }),
      h("h3", { text: "Ventas del turno" }),
      sales.length
        ? h(
            "div",
            {},
            sales.map((sale) =>
              row(
                (METHOD_LABEL[text(sale?.method)] || text(sale?.method) || "Otro") +
                  " · " +
                  Math.max(0, Math.trunc(Number(sale?.count) || 0)) +
                  " pago(s)",
                moneyCents(sale?.total_cents),
              ),
            ),
          )
        : h("p", { class: "hint", text: "Sin ventas en este turno." }),
      row("Total ventas", moneyCents(report.sales_total_cents)),
      h("h3", { text: "Efectivo" }),
      row("Ingresos de efectivo", moneyCents(movements.in_cents)),
      row("Retiros de efectivo", moneyCents(movements.out_cents)),
      row("Efectivo esperado", moneyCents(report.expected_cash_cents)),
      row("Efectivo contado", moneyCents(report.counted_cash_cents)),
      row(
        "Diferencia",
        moneyCents(difference),
        difference < 0 ? "negative" : difference > 0 ? "positive" : "",
      ),
      difference < 0
        ? h("p", {
            class: "hint negative",
            text: "Faltante de caja: " + moneyCents(Math.abs(difference)) + ".",
          })
        : difference > 0
          ? h("p", {
              class: "hint positive",
              text: "Sobrante de caja: " + moneyCents(difference) + ".",
            })
          : null,
      pendingCount
        ? h("p", {
            class: "err",
            role: "status",
            text:
              "Aviso: " +
              pendingCount +
              " pago(s) pendiente(s) por " +
              moneyCents(pending.total_cents) +
              " sin confirmar.",
          })
        : null,
      orders.paid != null
        ? row("Pedidos pagados", String(Math.max(0, Math.trunc(Number(orders.paid) || 0))))
        : null,
      orders.rejected != null
        ? row(
            "Pedidos rechazados",
            String(Math.max(0, Math.trunc(Number(orders.rejected) || 0))),
          )
        : null,
      report.note
        ? h("p", { class: "order-note", text: "Nota: " + text(report.note) })
        : null,
    );
  }
  function openShiftSheet() {
    if (!sede) return toast("Elige la sede antes de abrir la caja.", true);
    const targetSede = sede;
    const input = h("input", {
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      placeholder: "0.00",
      "aria-label": "Fondo inicial en dólares",
    });
    const error = h("p", { class: "err", role: "alert" });
    const submit = h(
      "button",
      { type: "submit", class: "btn primary wide" },
      "Abrir caja",
    );
    const state = {};
    const run = async () => {
      const cents = centsFrom(input.value);
      if (cents === null) {
        error.textContent = MESSAGES.fondo_invalido;
        input.focus();
        return;
      }
      const base = { sede_id: targetSede, opening_float_cents: cents };
      const body = { ...base, idempotency_key: idempotency(state, base) };
      const result = await callTurnos("abrir", body);
      if (result.status === 401) return sessionExpired();
      if (result.status === 409) {
        dismissSheet();
        // La misma clave puede devolver el turno ya abierto: no es un error.
        if (result.data?.shift?.id) {
          shift = result.data.shift;
          shiftSede = targetSede;
          shiftStatus = "ok";
          closedReport = null;
          await loadShift();
          render();
          return toast("La caja ya estaba abierta en esta sede.");
        }
        await loadShift();
        render();
        return toast(
          result.data?.error === "caja_ya_abierta"
            ? MESSAGES.caja_ya_abierta
            : message(result, "No pudimos abrir la caja."),
          true,
        );
      }
      if (result.status !== 200 && result.status !== 201) {
        error.textContent = message(result, "No pudimos abrir la caja.");
        return;
      }
      dismissSheet();
      shift = result.data?.shift || null;
      shiftSede = targetSede;
      shiftStatus = "ok";
      closedReport = null;
      await loadShift();
      render();
      toast("Caja abierta. Fondo inicial " + moneyCents(cents) + ".");
    };
    const form = h(
      "form",
      { novalidate: true },
      h("h2", { text: "Abrir caja" }),
      h("p", {
        class: "hint",
        text:
          "Cuenta el fondo inicial de " +
          (sedeLabel(targetSede) || "esta sede") +
          " antes de cobrar.",
      }),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Fondo inicial en dólares" }),
        input,
      ),
      submit,
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act(submit, run);
    });
    showSheet(
      h(
        "div",
        { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Abrir caja" },
        h(
          "div",
          { class: "sheet-box" },
          button("Cancelar", "btn link", dismissSheet),
          form,
        ),
      ),
    );
    input.focus();
  }
  function movementSheet(kind) {
    if (!shift?.id)
      return toast("La caja no está abierta. Actualiza el estado.", true);
    const shiftId = shift.id;
    const out = kind === "out";
    const amountInput = h("input", {
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      placeholder: "0.00",
      "aria-label": "Monto en dólares",
    });
    const reasonInput = h("input", {
      type: "text",
      maxlength: "120",
      autocomplete: "off",
      placeholder: out ? "Depósito al banco, pago a proveedor…" : "Cambio adicional, reposición…",
      "aria-label": "Motivo del movimiento",
    });
    const error = h("p", { class: "err", role: "alert" });
    const submit = h(
      "button",
      { type: "submit", class: "btn primary wide" },
      out ? "Registrar retiro" : "Registrar ingreso",
    );
    const state = {};
    const run = async () => {
      const cents = centsFrom(amountInput.value);
      if (cents === null || cents <= 0) {
        error.textContent = MESSAGES.monto_invalido;
        amountInput.focus();
        return;
      }
      const reason = text(reasonInput.value);
      if (reason.length < 3 || reason.length > 120) {
        error.textContent = MESSAGES.motivo_invalido;
        reasonInput.focus();
        return;
      }
      const base = { kind, amount_cents: cents, reason };
      const body = { ...base, idempotency_key: idempotency(state, base) };
      const result = await callTurnos(
        encodeURIComponent(shiftId) + "/movimientos",
        body,
      );
      if (result.status === 401) return sessionExpired();
      if (result.status === 409) {
        dismissSheet();
        await loadShift();
        render();
        return toast(message(result, "Ese turno ya está cerrado."), true);
      }
      if (result.status !== 201) {
        error.textContent = message(result, "No pudimos registrar el movimiento.");
        return;
      }
      dismissSheet();
      await loadShift();
      render();
      toast(
        (out ? "Retiro registrado: " : "Ingreso registrado: ") +
          moneyCents(cents) +
          ".",
      );
    };
    const form = h(
      "form",
      { novalidate: true },
      h("h2", { text: out ? "Retiro de efectivo" : "Ingreso de efectivo" }),
      h("p", {
        class: "hint",
        text: out
          ? "Sale dinero de la caja: queda en el reporte del turno."
          : "Entra dinero a la caja: queda en el reporte del turno.",
      }),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Monto en dólares" }),
        amountInput,
      ),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Motivo (3 a 120 caracteres)" }),
        reasonInput,
      ),
      submit,
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act(submit, run);
    });
    showSheet(
      h(
        "div",
        {
          class: "sheet",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": out ? "Retiro de efectivo" : "Ingreso de efectivo",
        },
        h(
          "div",
          { class: "sheet-box" },
          button("Cancelar", "btn link", dismissSheet),
          form,
        ),
      ),
    );
    amountInput.focus();
  }
  function closeShiftSheet() {
    if (!shift?.id) return toast("La caja no está abierta.", true);
    const shiftId = shift.id;
    const counted = h("input", {
      type: "text",
      inputmode: "decimal",
      autocomplete: "off",
      placeholder: "0.00",
      "aria-label": "Efectivo contado en dólares",
    });
    const note = h("textarea", {
      maxlength: "200",
      placeholder: "Opcional",
      "aria-label": "Nota del cierre",
    });
    const preview = h("span", { class: "hint" });
    const quantities = [];
    const paintCount = () => {
      const total = quantities.reduce(
        (sum, item) =>
          sum +
          item.denom.cents *
            Math.max(0, Math.trunc(Number(item.input.value) || 0)),
        0,
      );
      counted.value =
        Math.floor(total / 100) + "." + String(total % 100).padStart(2, "0");
      preview.textContent = "Conteo por denominaciones: " + moneyCents(total);
    };
    const denominationRows = DENOMINATIONS.map((denom) => {
      const qty = h("input", {
        type: "text",
        inputmode: "numeric",
        autocomplete: "off",
        placeholder: "0",
        "aria-label": denom.label + ": cantidad",
      });
      qty.addEventListener("input", () => {
        qty.value = qty.value.replace(/\D/g, "").slice(0, 4);
        paintCount();
      });
      quantities.push({ denom, input: qty });
      return h(
        "label",
        { class: "denom-row" },
        h("span", { text: denom.label }),
        qty,
      );
    });
    const error = h("p", { class: "err", role: "alert" });
    const submit = h(
      "button",
      { type: "submit", class: "btn primary wide" },
      "Confirmar cierre",
    );
    const state = {};
    const run = async () => {
      const cents = centsFrom(counted.value);
      if (cents === null) {
        error.textContent = MESSAGES.conteo_invalido;
        counted.focus();
        return;
      }
      const base = { counted_cash_cents: cents };
      const cleanNote = text(note.value).slice(0, 200);
      if (cleanNote) base.note = cleanNote;
      const body = { ...base, idempotency_key: idempotency(state, base) };
      const result = await callTurnos(
        encodeURIComponent(shiftId) + "/cerrar",
        body,
      );
      if (result.status === 401) return sessionExpired();
      if (result.status === 409) {
        dismissSheet();
        await loadShift();
        // Otro dispositivo pudo cerrar: se intenta recuperar el Z para reimprimir.
        if (result.data?.report) closedReport = result.data.report;
        else if (result.data?.error === "turno_cerrado") {
          const saved = await callTurnos(encodeURIComponent(shiftId));
          if (saved.status === 200 && saved.data?.report)
            closedReport = saved.data.report;
        }
        render();
        return toast(message(result, "Ese turno ya está cerrado."), true);
      }
      if (result.status !== 200) {
        error.textContent = message(result, "No pudimos cerrar la caja.");
        return;
      }
      dismissSheet();
      closedReport = result.data?.report || null;
      await loadShift();
      render();
      toast("Caja cerrada. Revisa el reporte y el ticket Z.");
    };
    const form = h(
      "form",
      { novalidate: true },
      h("h2", { text: "Cerrar caja" }),
      h("p", {
        class: "hint",
        text: "Cuenta el efectivo de la caja y escribe solo el total. El sistema te muestra el esperado después de cerrar.",
      }),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Efectivo contado en dólares" }),
        counted,
      ),
      h(
        "details",
        {},
        h("summary", { text: "Contar por denominaciones (opcional)" }),
        ...denominationRows,
        preview,
      ),
      h(
        "label",
        { class: "field" },
        h("span", { text: "Nota (opcional)" }),
        note,
      ),
      submit,
      h("p", {
        class: "hint",
        text: "El cierre es definitivo: el turno cerrado ya no se puede modificar.",
      }),
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      act(submit, run);
    });
    showSheet(
      h(
        "div",
        {
          class: "sheet",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Cerrar caja",
        },
        h(
          "div",
          { class: "sheet-box" },
          button("Cancelar", "btn link", dismissSheet),
          form,
        ),
      ),
    );
    counted.focus();
  }
  function orderCard(order) {
    const state = text(order.status) || "pending";
    const pos = isPosOrder(order);
    const items = Array.isArray(order.items) ? order.items : [];
    const source =
      { mesa: "Mesa", mesero: "Mesero", caja: "Caja", web: "Web" }[
        order.source
      ] || "Web";
    const actions = [];
    if (state === "pending") {
      actions.push(button("Editar", "btn small", () => edit(order)));
      actions.push(
        button("Confirmar", "btn primary small", (event) =>
          changeStatus(order, "confirm", event.currentTarget),
        ),
      );
      actions.push(
        button("Rechazar", "btn danger small", (event) =>
          changeStatus(order, "reject", event.currentTarget),
        ),
      );
    } else if (state === "confirmed") {
      // Confirmar disponibilidad NO cobra: la comanda sale a cocina solo al pagar.
      if (pos) {
        const transfer = text(order.payment_method) === "transfer";
        actions.push(
          button(
            transfer ? "Confirmar transferencia" : "Cobrar efectivo",
            "btn primary small",
            (event) => payOrder(order, event.currentTarget),
          ),
        );
        actions.push(
          button("Rechazar", "btn danger small", (event) =>
            changeStatus(order, "reject", event.currentTarget),
          ),
        );
      }
    } else if (state === "paid") {
      actions.push(
        button(
          Number(order.print_count) ? "Reimprimir" : "Imprimir",
          "btn primary small",
          (event) => print(order, event.currentTarget),
        ),
      );
      actions.push(
        button("Marcar listo", "btn small", (event) =>
          markReady(order, event.currentTarget),
        ),
      );
    } else if (state === "ready") {
      actions.push(
        button(
          Number(order.print_count) ? "Reimprimir" : "Imprimir",
          "btn small",
          (event) => print(order, event.currentTarget),
        ),
      );
      const wa = waLink(order);
      if (wa)
        actions.push(
          h(
            "a",
            {
              class: "btn primary small",
              href: wa,
              target: "_blank",
              rel: "noopener",
              text: "Avisar por WhatsApp",
            },
          ),
        );
    }
    return h(
      "article",
      { class: "card" },
      h(
        "div",
        { class: "order-head" },
        h("strong", { class: "order-no", text: shortNumber(order) }),
        h(
          "div",
          { class: "order-meta" },
          h("strong", { text: orderTitle(order) }),
          h("span", {
            class: "hint order-when",
            text: ecTime(order.created_at) + " · " + money(orderTotal(order)),
          }),
          h(
            "div",
            { class: "badges" },
            h("span", {
              class: "badge " + state,
              text: STATE_LABEL[state] || state,
            }),
            h("span", { class: "badge", text: source }),
            sedeLabel(order.sede_id)
              ? h("span", {
                  class: "badge",
                  text: sedeLabel(order.sede_id),
                })
              : null,
          ),
        ),
      ),
      h(
        "ul",
        { class: "lines" },
        items.map((item) =>
          h(
            "li",
            {},
            h("b", {
              text: `${Number(item?.qty) || 1} × ${itemName(item)}`,
            }),
            itemVariant(item)
              ? h("span", { class: "variant", text: itemVariant(item) })
              : null,
            itemNote(item)
              ? h("span", { class: "variant", text: "Nota: " + itemNote(item) })
              : null,
          ),
        ),
      ),
      order.note
        ? h("p", { class: "order-note", text: "Nota: " + order.note })
        : null,
      state === "pending"
        ? h("p", {
            class: "edited",
            text: "Pendiente sin comanda: confirma y cobra para enviarla a cocina.",
          })
        : state === "confirmed"
          ? h("p", {
              class: "edited",
              text: "Falta el cobro. La comanda llega a cocina al confirmar el pago.",
            })
          : state === "paid"
            ? h("p", {
                class: "edited",
                text: "Pago confirmado y comanda en cocina. Marca listo cuando esté para entregar.",
              })
            : state === "ready"
              ? h("p", {
                  class: "edited",
                  text: "Listo. El aviso por WhatsApp es manual: la app no envía mensajes solo.",
                })
              : null,
      order.edited_at ? h("p", { class: "edited", text: "Editado" }) : null,
      Number(order.print_count)
        ? h("p", {
            class: "edited",
            text: "Acuse de impresión ×" + Number(order.print_count),
          })
        : null,
      actions.length ? h("div", { class: "actions" }, actions) : null,
    );
  }
  function ordersScreen() {
    const filters = [
      ["pending", "Pendientes"],
      ["confirmed", "Por cobrar"],
      ["paid", "Pagados"],
      ["all", "Todos"],
    ];
    const select = sedeSelect(async () => {
      await loadOrders();
      await loadShift();
      render();
    });
    const sedeField = h(
      "label",
      { class: "field" },
      h("span", { text: "Sede" }),
      select,
      h("p", {
        class: "hint",
        text: sede
          ? "Caja y cocina de " + sedeLabel(sede) + "."
          : "Elige la sede para ver y cobrar los pedidos con sede. Sin sede solo ves los pedidos del menú anterior.",
      }),
    );
    return h(
      "section",
      {},
      sedeField,
      h(
        "div",
        { class: "filters" },
        filters.map(([id, label]) =>
          button(
            label,
            "btn small " + (filter === id ? "selected" : ""),
            async () => {
              filter = id;
              await loadOrders();
              render();
            },
          ),
        ),
      ),
      h(
        "div",
        { class: "bar" },
        h("span", { class: "hint", text: orders.length + " pedido(s)" }),
        button("Actualizar", "btn small", async () => {
          await loadOrders();
          render();
        }),
      ),
      orders.length
        ? orders.map(orderCard)
        : h("p", {
            class: "card empty",
            text: "No hay pedidos en este filtro.",
          }),
    );
  }
  function newBuilder(order) {
    if (builder && !order) return;
    builder = {
      id: order?.id || "",
      sede_id: text(order?.sede_id) || sede,
      table_no: text(order?.table_no),
      client_name: /^(Mesa .*|Mostrador)$/.test(clientName(order))
        ? ""
        : clientName(order),
      note: text(order?.note),
      key: "",
      items: (Array.isArray(order?.items) ? order.items : []).map((item) => {
        const variant = itemVariant(item);
        return {
          ...item,
          nombre: itemName(item),
          precio:
            item?.unit_cents != null
              ? amount(item.unit_cents) / 100
              : amount(item?.precio ?? item?.price),
          qty: Math.max(1, Number(item.qty) || 1),
          variant,
          note: item?.note && text(item.note) !== variant ? text(item.note) : "",
        };
      }),
    };
  }
  function categories() {
    return (Array.isArray(catalog?.categories) ? catalog.categories : [])
      .map((item) => ({ id: item.slug, name: item.name }))
      .filter((item) => text(item.id) && text(item.name));
  }
  function cartTotal() {
    return builder.items.reduce(
      (sum, item) =>
        sum + amount(item.precio) * Math.max(1, Number(item.qty) || 1),
      0,
    );
  }
  function cartCount() {
    return builder.items.reduce((sum, item) => sum + (Number(item.qty) || 1), 0);
  }
  // Catálogo en cuadrícula + barra flotante; mesa, cliente y notas viven en el modal del pedido.
  function builderScreen() {
    if (!builder) newBuilder();
    const list = h("div", { class: "catalog-grid" });
    const search = h("input", {
      type: "search",
      value: query,
      placeholder: "Buscar producto",
      "aria-label": "Buscar producto",
    });
    const inCart = (product) =>
      builder.items
        .filter(
          (item) =>
            (item.product_id && product.id && item.product_id === product.id) ||
            (!item.product_id &&
              item.nombre === (product.name || product.nombre)),
        )
        .reduce((sum, item) => sum + item.qty, 0);
    const paintProducts = () => {
      const q = fold(query);
      const found = visibleProducts().filter(
        (product) =>
          (!category || (product.categories || []).includes(category)) &&
          (!q || fold(product.name || product.nombre).includes(q)),
      );
      chipButtons.forEach(([id, node]) =>
        node.classList.toggle("selected", id === category),
      );
      if (!found.length)
        return list.replaceChildren(
          h("p", { class: "empty", text: "Sin resultados." }),
        );
      list.replaceChildren(
        ...found.map((product) => {
          const qty = inCart(product);
          const name = product.name || product.nombre || "Producto";
          const price =
            product.stock === 0
              ? "Agotado"
              : money(product.price ?? product.precio);
          return h(
            "button",
            {
              type: "button",
              class: "catalog-product" + (qty ? " in-cart" : ""),
              onclick: () => chooseProduct(product),
              // Igual que el menú: stock 0 = agotado, no se puede agregar.
              disabled: product.stock === 0,
              "aria-label":
                product.stock === 0
                  ? "Agotado: " + name
                  : "Agregar " + name + ", " + price,
            },
            qty ? h("span", { class: "qty-badge", text: "×" + qty }) : null,
            productMedia(product),
            h(
              "span",
              { class: "catalog-body" },
              h("span", { text: name }),
              h("span", { class: "catalog-price", text: price }),
            ),
          );
        }),
      );
    };
    const chipButtons = [];
    const chip = (label, id) => {
      const node = button(label, "btn small", () => {
        category = id;
        paintProducts();
      });
      chipButtons.push([id, node]);
      return node;
    };
    const chips = h(
      "div",
      { class: "chips filters" },
      chip("Todo", ""),
      categories().map((item) => chip(item.name, item.id)),
    );
    search.addEventListener("input", () => {
      query = search.value;
      paintProducts();
    });
    const bar = h("button", {
      type: "button",
      class: "cart-bar",
      onclick: openCart,
    });
    const paintBar = () => {
      const count = cartCount();
      bar.hidden = !count && !builder.id;
      bar.replaceChildren(
        h("span", {
          text: (builder.id ? "Editar pedido" : "Ver pedido") + " · " + count,
        }),
        h("b", { text: money(cartTotal()) }),
      );
    };
    repaintItems = () => {
      paintProducts();
      paintBar();
    };
    repaintItems();
    return h(
      "section",
      { class: "builder" },
      builder.id
        ? h("p", { class: "hint", text: "Editando pedido. Toca la barra para guardar." })
        : h(
            "label",
            { class: "field" },
            h("span", { text: "Sede" }),
            sedeSelect(() => {
              if (builder) builder.sede_id = sede;
              loadShift().then(() => {
                if (me) render();
              });
            }),
            h("p", {
              class: "hint",
              text: sedes.length
                ? "Elige la sede antes de guardar: el servidor recalcula precios y congela la sede."
                : "No hay sedes activas. Pide al dueño que configure las sedes antes de crear pedidos.",
            }),
          ),
      search,
      chips,
      list,
      bar,
    );
  }
  function openCart() {
    const box = h("div", { class: "sheet-box" });
    const field = (label, input) =>
      h("label", { class: "field" }, h("span", { text: label }), input);
    const input = (key, max, label, tag = "input") => {
      const node = h(tag, {
        maxlength: String(max),
        value: builder[key],
        placeholder: "Opcional",
        "aria-label": label,
      });
      node.addEventListener("input", () => {
        builder[key] = node.value.slice(0, max);
      });
      return field(label, node);
    };
    const paint = () => {
      if (!builder.items.length && !builder.id) return dismissSheet();
      const lines = builder.items.map((item, index) => {
        const note = h("input", {
          maxlength: "100",
          value: item.note || "",
          placeholder: "Nota (sin cebolla, término…)",
          "aria-label": "Nota para " + item.nombre,
        });
        note.addEventListener("input", () => {
          item.note = note.value.slice(0, 100);
        });
        const change = (delta) => {
          item.qty = Math.min(999, item.qty + delta);
          if (item.qty < 1) builder.items.splice(index, 1);
          paint();
        };
        return h(
          "div",
          { class: "builder-item" },
          h(
            "div",
            { class: "builder-name" },
            h("b", { text: item.nombre }),
            item.variant ? h("span", { text: item.variant }) : null,
            note,
          ),
          h(
            "div",
            { class: "qty" },
            button("−", "", () => change(-1)),
            h("b", { text: item.qty }),
            button("+", "", () => change(1)),
          ),
          button("Quitar", "btn link small", () => change(-item.qty)),
        );
      });
      const send = button(
        builder.id ? "Guardar cambios" : "Enviar pedido",
        "btn primary wide",
        () => submitBuilder(send),
      );
      box.replaceChildren(
        h(
          "div",
          { class: "bar" },
          h("h2", { text: builder.id ? "Editar pedido" : "Pedido" }),
          button("Cerrar", "btn link", dismissSheet),
        ),
        ...lines,
        h(
          "div",
          { class: "total" },
          h("b", { text: "Total" }),
          h("b", { text: money(cartTotal()) }),
        ),
        input("client_name", 60, "Cliente"),
        input("note", 200, "Nota general", "textarea"),
        send,
      );
    };
    paint();
    showSheet(
      h("div", { class: "sheet", role: "dialog", "aria-modal": "true" }, box),
    );
  }
  function chooseProduct(product) {
    const groups = groupVariants(product);
    if (!groups.length) return addItem(buildItem(product));
    const choices = {};
    const note = h("textarea", {
      maxlength: "200",
      placeholder: "Opcional",
      "aria-label": "Nota para este producto",
    });
    const error = h("p", { class: "err", role: "alert" });
    const form = h(
      "form",
      { novalidate: true },
      h("h2", { text: product.name || product.nombre || "Producto" }),
    );
    groups.forEach((group, index) => {
      form.append(
        h("h3", {
          text: text(group.name) + (group.optional ? " (opcional)" : ""),
        }),
      );
      (group.options || []).forEach((option, at) => {
        const key = optionKey(option, at);
        const input = h("input", {
          type: group.type === "distribute" ? "checkbox" : "radio",
          name: "variant-" + index,
          value: key,
        });
        input.addEventListener("change", () => {
          if (group.type === "distribute") {
            const selected = Array.isArray(choices[index])
              ? choices[index]
              : [];
            if (
              input.checked &&
              selected.length < Math.max(1, Number(group.pick) || 1)
            )
              choices[index] = selected.concat(key);
            else if (!input.checked)
              choices[index] = selected.filter((value) => value !== key);
            else input.checked = false;
          } else choices[index] = input.checked ? key : "";
        });
        form.append(
          h("label", { class: "option" }, input, optionLabel(option)),
        );
      });
    });
    form.append(
      h(
        "label",
        { class: "field" },
        h("span", { text: "Nota para este producto" }),
        note,
      ),
    );
    form.append(
      h(
        "button",
        { type: "submit", class: "btn primary wide" },
        "Agregar al pedido",
      ),
      error,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!choicesOK(groups, choices)) {
        error.textContent = "Completa las opciones requeridas.";
        return;
      }
      dismissSheet();
      addItem(buildItem({ ...product, __groups: groups }, choices, note.value));
    });
    showSheet(
      h(
        "div",
        { class: "sheet", role: "dialog", "aria-modal": "true" },
        h(
          "div",
          { class: "sheet-box" },
          button("Cancelar", "btn link", dismissSheet),
          form,
        ),
      ),
    );
  }
  // Solo repinta el resumen: el filtro, la búsqueda y el scroll del catálogo quedan donde estaban.
  function addItem(item) {
    const same = builder.items.find(
      (old) =>
        old.nombre === item.nombre &&
        (old.variant || "") === (item.variant || "") &&
        amount(old.precio) === amount(item.precio),
    );
    if (same && !same.note) same.qty = Math.min(999, same.qty + 1);
    else builder.items.push({ ...item });
    repaintItems ? repaintItems() : render();
    toast("+1 " + item.nombre);
  }
  // El servidor devuelve el pedido actualizado: se reemplaza en la lista sin volver a pedirla.
  function upsert(order) {
    if (!order?.id) return loadOrders();
    const keep = filter === "all" || order.status === filter;
    const at = orders.findIndex((item) => item.id === order.id);
    if (at >= 0) keep ? (orders[at] = order) : orders.splice(at, 1);
    else if (keep) orders.unshift(order);
  }
  // Mientras viaja el request el botón queda en "…" y no acepta otro toque.
  async function act(buttonEl, run) {
    if (busy) return;
    busy = true;
    const label = buttonEl?.textContent;
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = "…";
    }
    try {
      await run();
    } finally {
      busy = false;
      if (buttonEl?.isConnected) {
        buttonEl.disabled = false;
        buttonEl.textContent = label;
      }
    }
  }
  function closeSheet() {
    document.querySelectorAll(".sheet").forEach((item) => item.remove());
  }
  function submitBuilder(buttonEl) {
    if (!builder.items.length)
      return toast("Agrega al menos un producto.", true);
    return act(buttonEl, () => saveBuilder());
  }
  async function saveBuilder() {
    if (!builder.items.length) return toast("Agrega al menos un producto.", true);
    if (!builder.id && !sede) {
      toast("Elige la sede antes de guardar el pedido.", true);
      return;
    }
    if (!builder.id && !sedeLabel(sede)) {
      toast("Esa sede ya no está disponible. Elige otra.", true);
      return;
    }
    const items = builder.items.map((item) => {
      if (item.product_id) {
        const labels = text(item.variant)
          .split(" · ")
          .filter((part) => part && !part.startsWith("Nota: "));
        const note = [
          item.variant_id ? "" : labels.join(" · "),
          text(item.note),
        ]
          .filter(Boolean)
          .join(" · ");
        return {
          product_id: item.product_id,
          qty: Math.max(1, Number(item.qty) || 1),
          ...(item.variant_id ? { variant_id: item.variant_id } : {}),
          ...(note ? { note } : {}),
        };
      }
      // Pedido anterior al POS: conserva la forma que ya validaba el servidor.
      const variant = [item.variant, text(item.note) && "Nota: " + text(item.note)]
        .filter(Boolean)
        .join(" · ");
      return {
        nombre: item.nombre,
        qty: Math.max(1, Number(item.qty) || 1),
        precio: amount(item.precio),
        ...(variant ? { variant } : {}),
      };
    });
    if (!builder.id) builder.key = builder.key || uuid();
    const body = builder.id
      ? {
          table_no: builder.table_no || undefined,
          client_name: builder.client_name || undefined,
          note: builder.note || undefined,
          items,
        }
      : {
          sede_id: sede,
          idempotency_key: builder.key,
          delivery_mode: "pickup",
          client_name: builder.client_name || undefined,
          note: builder.note || undefined,
          items,
        };
    const result = await call(
      builder.id ? "orders/" + encodeURIComponent(builder.id) : "orders",
      body,
      builder.id ? "PUT" : "POST",
    );
    if (result.status === 401) return sessionExpired();
    if (result.status !== 200 && result.status !== 201)
      return toast(message(result, "No pudimos guardar el pedido."), true);
    const created = !builder.id;
    const saved = result.data?.order || null;
    closeSheet();
    builder = null;
    repaintItems = null;
    query = "";
    tab = "orders";
    filter = "pending";
    await loadOrders();
    toast(
      created
        ? "Pedido " +
            shortNumber(
              saved || {
                id: result.data?.id,
                number: result.data?.number,
              },
            ) +
            " creado como pendiente. Confírmalo y cobra antes de la comanda."
        : "Pedido " + shortNumber(saved || {}) + " guardado",
    );
    render();
    // Deshace las entradas Nuevo pedido + modal: "atrás" desde la lista ya sale al panel.
    const steps = { sheet: 2, new: 1 }[where()] || 0;
    if (steps) H.go(-steps);
  }
  function edit(order) {
    newBuilder(order);
    tab = "new";
    push("new");
    render();
    openCart();
  }
  // Solo rechazar pide confirmación: confirmar es la acción de cada pedido y no debe frenar al mesero.
  function changeStatus(order, action, buttonEl) {
    if (
      action === "reject" &&
      typeof window.confirm === "function" &&
      !window.confirm("¿Quieres rechazar este pedido?")
    )
      return;
    return act(buttonEl, async () => {
      const result = await call(
        "orders/" + encodeURIComponent(order.id) + "/" + action,
        {},
      );
      if (result.status === 401) return sessionExpired();
      if (result.status !== 200)
        return toast(message(result, "No pudimos actualizar el pedido."), true);
      upsert(result.data?.order);
      render();
    });
  }
  // Cobro manual: efectivo por pay-cash y transferencia por pay-transfer.
  // Ambos son idempotentes y son la única acción que libera la comanda.
  function payOrder(order, buttonEl) {
    const transfer = text(order.payment_method) === "transfer";
    if (
      typeof window.confirm === "function" &&
      !window.confirm(
        (transfer
          ? "¿Verificaste la transferencia de " + shortNumber(order) + "?"
          : "¿Confirmas que recibiste el pago en efectivo de " +
            shortNumber(order) +
            "?") + " La comanda se enviará a cocina.",
      )
    )
      return;
    return act(buttonEl, async () => {
      const key = uuid();
      const path = "orders/" + encodeURIComponent(order.id);
      const result = await callRoot(
        path + (transfer ? "/pay-transfer" : "/pay-cash"),
        { idempotency_key: key },
      );
      if (result.status === 401) return sessionExpired();
      // Sin fallback a /pay-cash: cambiar de ruta falsearía el método real y
      // la conciliación. Una ruta ausente se informa como error honesto.
      if (transfer && (result.status === 404 || result.status === 405))
        return toast(
          "Esta versión del panel todavía no permite confirmar transferencias. Actualiza el panel.",
          true,
        );
      if (result.status === 409) {
        // Cobrar con la caja cerrada no es un cambio de estado del pedido.
        if (result.data?.error === "caja_cerrada") {
          toast(MESSAGES.caja_cerrada, true);
          await loadShift();
          return render();
        }
        toast("Ese pedido ya cambió de estado. Actualiza la lista.", true);
        await loadOrders();
        return render();
      }
      if (result.status !== 200)
        return toast(
          message(result, "No pudimos registrar el cobro. Intenta de nuevo."),
          true,
        );
      const updated = result.data?.order;
      if (updated) upsert(updated);
      else await loadOrders();
      toast(
        (transfer ? "Transferencia confirmada." : "Cobrado.") +
          " La comanda ya está en cocina; imprímela desde Cocina.",
      );
      render();
    });
  }
  // paid → ready: lo confirma el operador autorizado y queda con marca de tiempo.
  function markReady(order, buttonEl) {
    return act(buttonEl, async () => {
      const result = await callRoot(
        "orders/" + encodeURIComponent(order.id) + "/ready",
        {},
      );
      if (result.status === 401) return sessionExpired();
      if (result.status === 404 || result.status === 405)
        return toast(
          "Esta versión del panel todavía no permite marcar listo.",
          true,
        );
      if (result.status === 409) {
        toast("Ese pedido ya cambió de estado. Actualiza la lista.", true);
        await loadOrders();
        return render();
      }
      if (result.status !== 200)
        return toast(
          message(result, "No pudimos marcar el pedido como listo."),
          true,
        );
      const updated = result.data?.order;
      if (updated) upsert(updated);
      else await loadOrders();
      toast("Pedido listo. Avisa al cliente con el enlace manual de WhatsApp.");
      render();
    });
  }
  function paperWidth() {
    try {
      return localStorage.getItem("mesero.paperWidth") === "58" ? 58 : 80;
    } catch {
      return 80;
    }
  }
  // Devuelve true solo si el navegador pudo abrir su diálogo de impresión.
  // Abrir el diálogo no significa que la impresora haya sacado papel.
  function printTicket(order) {
    const paper = paperWidth();
    const width = columnsForPaper(paper);
    const printable = {
      ...order,
      items: (Array.isArray(order?.items) ? order.items : []).map((item) => ({
        ...item,
        nombre: itemName(item),
        variant: [itemVariant(item), itemNote(item) && "Nota: " + itemNote(item)]
          .filter(Boolean)
          .join(" · "),
      })),
    };
    const body = ticket(printable, {
      store: me?.store?.name || S.store || "",
      width,
    });
    return openPrint(body, paper, "Comanda");
  }
  // Abre el diálogo del navegador con líneas ya compuestas (comanda o ticket Z).
  function openPrint(lines, paper, title) {
    const body = Array.isArray(lines) ? lines : [];
    const height = pageHeight(body.length);
    const escape = (value) =>
      String(value).replace(
        /[&<>"']/g,
        (char) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[char],
      );
    const printCss = `@page{size:${paper}mm ${height}mm;margin:3mm}
body{margin:0;font-family:monospace;font-size:11px;white-space:pre;line-height:1.25}`;
    const html =
      "<!doctype html><html><head><style>" +
      printCss +
      "</style></head><body>" +
      escape(body.join("\n")) +
      "</body></html>";
    const iframe = h("iframe", { title: title || "Impresión", hidden: true });
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        resolve(ok);
        window.setTimeout(() => {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* navegador restringido */
          }
          iframe.remove();
        }, 1000);
      };
      iframe.addEventListener(
        "load",
        () => {
          try {
            iframe.contentWindow.focus();
            iframe.contentWindow.print();
            finish(true);
          } catch {
            finish(false);
          }
        },
        { once: true },
      );
      iframe.addEventListener("error", () => finish(false), { once: true });
      iframe.src = url;
      document.body.append(iframe);
      window.setTimeout(() => finish(false), 5000);
    });
  }
  // Ticket Z: se imprime después de cerrar; no registra acuse en el servidor.
  function printShift(report, buttonEl) {
    return act(buttonEl, async () => {
      const paper = paperWidth();
      const lines = shiftTicket(report, {
        store: me?.store?.name || S.store || "",
        width: columnsForPaper(paper),
        sedeName: sedeLabel(report?.sede_id),
      });
      const opened = await openPrint(lines, paper, "Cierre de caja");
      if (!opened)
        return toast("No pudimos abrir la impresión del cierre.", true);
      toast("Se abrió la impresión del cierre. Revisa el papel.");
    });
  }
  function print(order, buttonEl) {
    if (Number(order.print_count) && typeof window.confirm === "function") {
      if (
        !window.confirm(
          "Esta comanda ya tiene " +
            Number(order.print_count) +
            " acuse(s) de impresión. ¿Reimprimir?",
        )
      )
        return;
    }
    return act(buttonEl, async () => {
      // Primero se abre la impresión: si el navegador falla, no se registra
      // un acuse que parezca una comanda impresa.
      const opened = await printTicket({
        ...order,
        print_count: (Number(order.print_count) || 0) + 1,
      });
      if (!opened) {
        toast("No pudimos abrir la impresión. No se registró acuse.", true);
        return;
      }
      const result = await call(
        "orders/" + encodeURIComponent(order.id) + "/print",
        { idempotency_key: uuid() },
      );
      if (result.status === 401) return sessionExpired();
      if (result.status !== 200) {
        toast(
          "La impresión se abrió, pero no pudimos registrar el acuse. Revisa el papel.",
          true,
        );
        return;
      }
      const updated = result.data?.order || order;
      const count = Number(result.data?.print_count);
      if (Number.isFinite(count) && count > 0) updated.print_count = count;
      upsert(updated);
      render();
      toast(
        "Acuse registrado. Revisa la comanda en la impresora; la app no confirma el papel.",
      );
    });
  }
  async function logout() {
    await call("logout", {});
    me = null;
    catalog = null;
    orders = [];
    shift = null;
    shiftSede = "";
    shiftStatus = "ok";
    closedReport = null;
    pinScreen("");
  }
  function paperSelect() {
    const input = h(
      "select",
      { "aria-label": "Ancho del papel" },
      h("option", { value: "80", text: "Ancho del papel: 80 mm" }),
      h("option", { value: "58", text: "Ancho del papel: 58 mm" }),
    );
    input.value = String(paperWidth());
    input.addEventListener("change", () => {
      try {
        localStorage.setItem("mesero.paperWidth", input.value);
      } catch {
        /* navegador restringido */
      }
    });
    return input;
  }
  function render() {
    if (!me) return;
    const closed = reportCard();
    root.replaceChildren(
      top(),
      shiftBar(),
      tabs(),
      tab === "orders" ? ordersScreen() : builderScreen(),
      ...(closed ? [closed] : []),
      h(
        "details",
        {},
        h("summary", { text: "Ayuda para imprimir" }),
        h("p", {
          text: "Imprime desde una PC o estación de caja con Chrome y una impresora térmica de 58 u 80 mm. No necesitas la tablet ASUS.",
        }),
        h("p", {
          text: "Para imprimir sin diálogo, abre el panel en la PC de la caja con Chrome y la opción --kiosk-printing.",
        }),
        h("p", {
          text:
            "En Windows: crea un acceso directo a Chrome y agrega --kiosk-printing al final de Destino. " +
            "Abre el panel desde ese acceso.",
        }),
        paperSelect(),
      ),
    );
  }
  document.addEventListener("visibilitychange", () => {
    // ponytail: como mucho una recarga cada 30 s al volver a la app; el botón Actualizar no tiene límite.
    if (
      document.visibilityState === "visible" &&
      me &&
      tab === "orders" &&
      Date.now() - loadedAt > 30000
    )
      loadOrders().then(() => {
        if (me) render();
      });
  });
  start();
}
