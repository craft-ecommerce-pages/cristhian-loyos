// Cocina (KDS): solo pedidos pagados de la sede elegida. La ruta la integra
// panel/src/index.js como /panel/cocina; este módulo no toca el backend.
import { ticketColumns, ticketLines, ticketPageHeight } from "../../shared/ticket.js";

export async function renderKitchenPage(request, env, site) {
  const slug = String(site?.slug ?? "");
  const config = await env.MENUS.get(`${slug}:config`, "json").catch(() => null);
  const saved = config && typeof config.store_name === "string" ? config.store_name.trim() : "";
  const store = saved || slug || "Mi negocio";
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111820"><meta name="color-scheme" content="light"><meta name="robots" content="noindex">
<title>${esc("Cocina · " + store)}</title><style>${KDS_CSS}</style></head><body>
<header class="top">
  <a class="top-back" href="/panel" rel="noreferrer">← Panel</a>
  <span class="top-name">${esc(store)}</span>
  <span class="top-tag">Cocina</span>
</header>
<main class="wrap">
  <div class="bar">
    <label class="sede-field"><span>Sede</span><select id="kdsSede" aria-label="Sede de la cocina"></select></label>
    <div class="bar-actions">
      <select id="kdsPaper" aria-label="Ancho del papel"><option value="80">Papel 80 mm</option><option value="58">Papel 58 mm</option></select>
      <button type="button" class="btn small" id="kdsRefresh">Actualizar</button>
    </div>
  </div>
  <p class="status" id="kdsStatus" role="status" aria-live="polite">Cargando órdenes pagadas…</p>
  <section id="kds" class="grid" aria-live="polite"></section>
  <p class="hint">La cocina solo recibe órdenes pagadas. La app registra el acuse de impresión, pero no puede confirmar que la impresora haya sacado el papel.</p>
</main>
<div id="kdsToast" class="toast" role="status" aria-live="polite"></div>
<div class="print-only"><pre id="kdsTicket"></pre></div>
<style id="kdsPrintCss"></style>
<script id="kdsStore">var __kdsStore=${inline(store)};</script>
<script id="kdsTicketFn">var __kdsTicket=${String(ticketLines)};window.__kdsTicket=__kdsTicket;</script>
<script id="kdsColumns">var __kdsColumns=${String(ticketColumns)};window.__kdsColumns=__kdsColumns;</script>
<script id="kdsHeight">var __kdsHeight=${String(ticketPageHeight)};window.__kdsHeight=__kdsHeight;</script>
<script id="kdsMain">${String(kitchenRuntime)}
kitchenRuntime();</script></body></html>`;
}

function inline(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

const KDS_CSS = `*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--p:#C4691C;--bg:#F6F5F2;--card:#fff;--soft:#F2F0EC;--ink:#1F1D1A;--ink2:#5C5850;
--muted:#8C877E;--line:#E3DFD8;--danger:#C4362F;--ok:#1F7A55;--side:#111820;--side-ink:#f4f7fa;--side-ink2:#aab6c0}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",Roboto,sans-serif;
font-size:16px;line-height:1.4;-webkit-text-size-adjust:100%}
h1,h2,h3,p{margin-top:0}
.top{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:10px;
padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:var(--side);color:var(--side-ink)}
.top-back{color:var(--side-ink2);font-size:13px;text-decoration:none}
.top-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:600}
.top-tag{color:#ffad68;font-size:11.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.wrap{max-width:1180px;margin:0 auto;padding:14px 14px calc(28px + env(safe-area-inset-bottom))}
.bar{display:flex;flex-wrap:wrap;gap:10px;align-items:end;justify-content:space-between;margin:0 0 10px}
.bar-actions{display:flex;gap:8px;align-items:center}
.sede-field{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:700;color:var(--ink2)}
.sede-field select{min-width:190px}
select,input,button{font:inherit}
select{padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card);color:var(--ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:9px 14px;border:1px solid var(--line);
border-radius:10px;background:var(--card);color:var(--ink);font-size:14px;font-weight:650;cursor:pointer}
.btn:hover{background:var(--soft)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--p);border-color:var(--p);color:#fff}
.btn.small{min-height:38px;padding:7px 11px;font-size:13px}
.status{min-height:20px;margin:0 0 12px;color:var(--ink2);font-size:13px}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));align-items:start}
.ticket-card{padding:0;border:1px solid var(--line);border-radius:14px;background:var(--card);overflow:hidden;
box-shadow:0 1px 3px rgba(0,0,0,.06)}
.ticket-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:14px 16px 8px}
.ticket-no{font-size:30px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.ticket-time{color:var(--ink2);font-size:13px;font-variant-numeric:tabular-nums}
.ticket-meta{margin:0;padding:0 16px;color:var(--ink2);font-size:13px}
.ticket-items{margin:12px 0 0;padding:0;list-style:none;border-top:1px solid var(--line)}
.ticket-items li{display:grid;grid-template-columns:44px minmax(0,1fr);gap:8px;padding:10px 16px;border-bottom:1px solid var(--line);font-size:16px}
.ticket-items .qty{font-weight:800;font-size:18px;font-variant-numeric:tabular-nums}
.ticket-items b{display:block;overflow-wrap:anywhere}
.ticket-items small{display:block;margin-top:2px;color:var(--ink2);font-size:13px}
.ticket-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px}
.ticket-foot .btn{min-height:44px}
.print-count{font-size:12.5px;font-weight:700;color:var(--muted)}
.print-count.printed{color:var(--ok)}
.empty{padding:40px 16px;text-align:center;color:var(--muted);grid-column:1/-1}
.hint{margin:18px 0 0;color:var(--muted);font-size:12.5px;max-width:760px}
.toast{position:fixed;left:50%;bottom:18px;z-index:40;max-width:calc(100% - 32px);padding:11px 16px;border-radius:10px;
background:#1F2A33;color:#fff;font-size:13.5px;box-shadow:0 8px 24px rgba(0,0,0,.2);opacity:0;transform:translate(-50%,10px);
transition:opacity .18s,transform .18s;pointer-events:none}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:#8f2b26}
.print-only{display:none}
@media print{
  body{background:#fff}
  .top,.wrap,.toast{display:none!important}
  .print-only{display:block!important}
  #kdsTicket{margin:0;font-family:monospace;font-size:11px;line-height:1.25;white-space:pre}
}
@media(max-width:640px){.grid{grid-template-columns:1fr}.bar{align-items:stretch}.sede-field select{min-width:0;width:100%}}`;

function kitchenRuntime() {
  const store = window.__kdsStore || "";
  const ticketFn = window.__kdsTicket;
  const columnsFn = window.__kdsColumns;
  const heightFn = window.__kdsHeight;
  const root = document.getElementById("kds");
  const statusEl = document.getElementById("kdsStatus");
  const toastEl = document.getElementById("kdsToast");
  const ticketEl = document.getElementById("kdsTicket");
  const printCss = document.getElementById("kdsPrintCss");
  const sedeSelect = document.getElementById("kdsSede");
  const paperSelect = document.getElementById("kdsPaper");
  const refreshBtn = document.getElementById("kdsRefresh");
  let sedes = [], sede = "", orders = [], since = 0, timer = 0, loading = false, printing = "";

  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const btn = (label, cls, onclick, extra) => h("button", Object.assign({ type: "button", class: cls, onclick }, extra || {}), label);
  function text(value) { return typeof value === "string" ? value : value == null ? "" : String(value); }
  function money(cents) {
    const value = Number(cents);
    return Number.isFinite(value) ? "$" + (value / 100).toFixed(2) : "";
  }
  function timeOf(value) {
    try { return new Date(Number(value)).toLocaleTimeString("es-EC", { hour: "2-digit", minute: "2-digit", timeZone: "America/Guayaquil" }); }
    catch { return ""; }
  }
  function dateOf(value) {
    try { return new Date(Number(value)).toLocaleString("es-EC", { dateStyle: "short", timeStyle: "short", timeZone: "America/Guayaquil" }); }
    catch { return ""; }
  }
  function uuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
    } catch { return "k-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10); }
  }
  let toastTimer = 0;
  function toast(message, bad) {
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3600);
  }
  const MESSAGES = {
    sin_sesion: "Tu sesión venció. Vuelve a entrar al panel.",
    sin_permiso: "No tienes permiso para esta sede.",
    sede_requerida: "Elige la sede de la cocina.",
    estado_invalido: "Esa orden ya no admite impresión.",
    idempotency_key_requerida: "No pudimos preparar el acuse. Intenta de nuevo.",
  };
  function message(result, fallback) { return MESSAGES[result?.data?.error] || fallback; }
  async function call(path, body, method) {
    const options = { credentials: "same-origin", headers: { accept: "application/json" }, method: method || (body === undefined ? "GET" : "POST") };
    if (body !== undefined) { options.body = JSON.stringify(body); options.headers["content-type"] = "application/json"; }
    try {
      const response = await fetch("/panel/api/" + path, options);
      return { status: response.status, data: response.status === 204 ? {} : await response.json().catch(() => ({})) };
    } catch { return { status: 0, data: {} }; }
  }
  function storedSede() { try { return text(localStorage.getItem("cocina.sede")); } catch { return ""; } }
  // /panel/cocina?sede=<id> tiene prioridad para abrir directo la tablet de esa sede.
  function querySede() {
    try { return text(new URLSearchParams(window.location.search).get("sede")); } catch { return ""; }
  }
  function rememberSede(id) { try { if (id) localStorage.setItem("cocina.sede", id); else localStorage.removeItem("cocina.sede"); } catch { /* navegador restringido */ } }
  function paperWidth() { try { return localStorage.getItem("cocina.paperWidth") === "58" ? 58 : 80; } catch { return 80; } }
  function rememberPaper(value) { try { localStorage.setItem("cocina.paperWidth", value); } catch { /* navegador restringido */ } }

  function paintSede() {
    sedeSelect.replaceChildren(
      h("option", { value: "", text: sedes.length ? "Elige una sede" : "Sin sedes disponibles" }),
      sedes.map(item => h("option", { value: item.id, text: text(item.nombre) || item.id })));
    sedeSelect.value = sedes.some(item => item.id === sede) ? sede : "";
    sedeSelect.disabled = !sedes.length;
  }
  function messageView(message, showLogin) {
    statusEl.textContent = "";
    root.replaceChildren(h("div", { class: "empty" },
      h("b", { text: message }),
      showLogin ? h("p", {}, h("a", { href: "/panel", text: "Entrar al panel" }), " · ", h("a", { href: "/panel/mesero", text: "Entrar como mesero" })) : null));
  }
  function render() {
    if (!sede) return messageView(sedes.length ? "Elige la sede para ver su cocina." : "No hay sedes activas. Configúralas en Mi negocio.");
    if (!orders.length) return messageView("No hay órdenes pagadas todavía. La lista se actualiza cada 15 segundos.");
    root.replaceChildren(...orders.map(order => {
      const count = Math.max(0, Number(order.print_count) || 0);
      const items = Array.isArray(order.items) ? order.items : [];
      const when = order.comanda_at || order.paid_at || order.created_at;
      const printButton = btn(count ? "Reimprimir" : "Imprimir comanda", "btn primary", ev => {
        const target = order;
        if (count && typeof window.confirm === "function" && !window.confirm("Esta comanda ya tiene " + count + " acuse(s) de impresión. ¿Reimprimir?")) return;
        printOrder(target, ev.currentTarget);
      }, { "aria-label": (count ? "Reimprimir" : "Imprimir") + " comanda " + (order.number ? "#" + order.number : "") });
      printButton.disabled = printing === order.id;
      return h("article", { class: "ticket-card", "data-order": order.id },
        h("div", { class: "ticket-head" },
          h("span", { class: "ticket-no", text: order.number ? "#" + order.number : "#" + text(order.id).slice(-4) }),
          h("span", { class: "ticket-time", text: timeOf(when) })),
        h("p", { class: "ticket-meta", text: [money(order.total_cents), dateOf(when), text(order.customer_name) || (order.table_no ? "Mesa " + order.table_no : "")].filter(Boolean).join(" · ") }),
        h("ul", { class: "ticket-items" }, items.map(item => h("li", {},
          h("span", { class: "qty", text: (Number(item.qty) || 1) + "×" }),
          h("div", {},
            h("b", { text: text(item.name || item.nombre) || "Producto" }),
            item.variant_id ? h("small", { text: text(item.variant_id) }) : null,
            item.note ? h("small", { text: "Nota: " + text(item.note) }) : null)))),
        h("div", { class: "ticket-foot" },
          h("span", { class: "print-count" + (count ? " printed" : ""), text: count ? "Acuse ×" + count : "Sin acuse" }),
          printButton));
    }));
  }
  const printOrderTitle = order => order.number ? "#" + order.number : "#" + text(order.id).slice(-4);
  async function printOrder(order, buttonEl) {
    if (printing) return;
    printing = order.id;
    if (buttonEl) buttonEl.disabled = true;
    const result = await call("kitchen/orders/" + encodeURIComponent(order.id) + "/print", { idempotency_key: uuid() });
    printing = "";
    if (buttonEl && buttonEl.isConnected) buttonEl.disabled = false;
    if (result.status === 401) return messageView("Tu sesión venció. Vuelve a entrar al panel.", true);
    if (result.status !== 200) {
      toast(message(result, "No pudimos registrar el acuse de la comanda."), true);
      return;
    }
    const count = Number(result.data?.print_count);
    order.print_count = Number.isFinite(count) ? count : (Number(order.print_count) || 0) + 1;
    render();
    printTicket(order);
    // Nunca se afirma impresión física: solo queda el acuse del servidor.
    toast("Acuse registrado (" + order.print_count + ") para " + printOrderTitle(order) + ". Revisa el papel en la impresora.");
  }
  function printTicket(order) {
    const paper = paperWidth();
    const width = typeof columnsFn === "function" ? columnsFn(paper) : 32;
    const printable = Object.assign({}, order, {
      items: (Array.isArray(order.items) ? order.items : []).map(item => Object.assign({}, item, {
        nombre: text(item.name || item.nombre) || "Producto",
        variant: [item.variant_id, item.note ? "Nota: " + text(item.note) : ""].filter(Boolean).join(" · "),
      })),
    });
    const lines = typeof ticketFn === "function"
      ? ticketFn(printable, { store, width })
      : [store, "COMANDA " + printOrderTitle(order), ...printable.items.map(item => item.qty + " x " + item.nombre)];
    const height = typeof heightFn === "function" ? heightFn(lines.length) : Math.max(50, lines.length * 4 + 8);
    if (printCss) printCss.textContent = "@page{size:" + paper + "mm " + height + "mm;margin:3mm}";
    ticketEl.textContent = lines.join("\n");
    try { window.print(); } catch { toast("No pudimos abrir la impresión desde este navegador.", true); }
  }
  async function load(reset) {
    if (loading || !sede) return;
    loading = true;
    statusEl.textContent = "Actualizando…";
    if (reset) { orders = []; since = Date.now() - 24 * 60 * 60 * 1000; }
    const result = await call("kitchen/orders?sede_id=" + encodeURIComponent(sede) + "&since=" + encodeURIComponent(String(since)));
    loading = false;
    if (result.status === 401) return messageView("Tu sesión venció. Vuelve a entrar al panel.", true);
    if (result.status === 403) return messageView("No tienes permiso para la sede elegida.");
    if (result.status !== 200) {
      statusEl.textContent = message(result, "No pudimos cargar las órdenes. Reintentaremos en 15 segundos.");
      return;
    }
    const incoming = Array.isArray(result.data?.orders) ? result.data.orders : [];
    const map = new Map(orders.map(order => [order.id, order]));
    for (const order of incoming) map.set(order.id, Object.assign(map.get(order.id) || {}, order));
    orders = [...map.values()].sort((a, b) => (Number(b.comanda_at) || 0) - (Number(a.comanda_at) || 0));
    const next = Number(result.data?.next);
    if (Number.isFinite(next) && next >= since) since = next;
    statusEl.textContent = orders.length
      ? orders.length + (orders.length === 1 ? " orden pagada" : " órdenes pagadas") + " · actualizado " + timeOf(Date.now())
      : "No hay órdenes pagadas en las últimas 24 horas · actualizado " + timeOf(Date.now());
    render();
  }
  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState !== "hidden") load(false); }, 15000);
  }
  async function start() {
    paperSelect.value = String(paperWidth());
    paperSelect.addEventListener("change", () => { rememberPaper(paperSelect.value); toast("Papel " + paperSelect.value + " mm para la próxima impresión."); });
    refreshBtn.addEventListener("click", () => load(true));
    const result = await call("mesero/me");
    if (result.status === 401) return messageView("Abre esta pantalla con la sesión del panel o del modo mesero.", true);
    if (result.status !== 200) return messageView(message(result, "No pudimos cargar la sesión de cocina."), true);
    sedes = (Array.isArray(result.data?.sedes) ? result.data.sedes : [])
      .filter(item => item && text(item.id))
      .map(item => ({ id: text(item.id), nombre: text(item.nombre) }));
    const saved = querySede() || storedSede();
    sede = sedes.some(item => item.id === saved) ? saved : sedes.length === 1 ? sedes[0].id : "";
    paintSede();
    sedeSelect.addEventListener("change", () => {
      sede = sedeSelect.value;
      rememberSede(sede);
      orders = []; since = Date.now() - 24 * 60 * 60 * 1000;
      load(true);
    });
    if (!sedes.length) return messageView("No hay sedes activas. Configúralas en Mi negocio.");
    if (!sede) return messageView("Elige la sede para ver su cocina.");
    await load(true);
    startTimer();
  }
  document.addEventListener("visibilitychange", () => {
    // Al volver a la tablet se refresca de inmediato; el polling normal sigue cada 15 s.
    if (document.visibilityState === "visible" && sede) load(false);
  });
  start();
}
