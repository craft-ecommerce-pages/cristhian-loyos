// A2: HTML único del panel del restaurante (Menú SaaS). Ver panel/PLAN.md.
// Una sola página, vanilla JS, sin bundler ni CDN: el SSR entrega el shell y el runtime
// consume /panel/api/*. El encoder QR es propio (byte, ECC M, v1-10), se exporta para los
// tests y se inyecta al navegador serializando la función, igual que loyalty/src/page.js.

import { qrMatrix } from "../../shared/qr.js";
// Se importa el módulo completo para serializar también `shiftTicketLines` cuando la
// parte E lo añada. Hoy puede no existir: el panel cae a un reporte HTML simple.
import * as ticketKit from "../../shared/ticket.js";
const { ticketColumns, ticketLines, ticketPageHeight } = ticketKit;
export { qrMatrix };

/* ── Fechas sugeridas de campañas ───────────────────────────────────────────
   Función pura y autocontenida: se serializa al navegador igual que el encoder QR
   (window.__panelDates) y el runtime solo la llama con la fecha de hoy. */

export function campaignDates(today) {
  const CAMPAIGNS = [
    { id: "madre", title: "Día de la Madre", month: 5, nth: 2, weekday: 0,
      body: "Celebra a mamá con un postre gratis en su día. Válido solo el domingo del Día de la Madre." },
    { id: "padre", title: "Día del Padre", month: 6, nth: 3, weekday: 0,
      body: "Ven con papá y llévate un 2x1 en cervezas. Válido el Día del Padre." },
    { id: "valentin", title: "San Valentín", month: 2, day: 14,
      body: "Ven en pareja y recibe un postre para compartir. Válido el 14 de febrero." },
    { id: "pizza", title: "Día de la Pizza", month: 2, day: 9,
      body: "En el Día de la Pizza, la segunda pizza tiene 50 % de descuento." },
    { id: "hamburguesa", title: "Día de la Hamburguesa", month: 5, day: 28,
      body: "En el Día de la Hamburguesa, papas gratis con cada hamburguesa." },
    { id: "navidad", title: "Navidad", month: 12, day: 25,
      body: "Celebra la Navidad con nosotros: postre gratis en pedidos mayores a $20." },
    { id: "fin-de-ano", title: "Fin de año", month: 12, day: 31,
      body: "Despide el año con un brindis de la casa. Válido el 31 de diciembre." },
    { id: "halloween", title: "Halloween", month: 10, day: 31,
      body: "Ven disfrazado y recibe un dulce de la casa. Válido el 31 de octubre." },
    { id: "cafe", title: "Día del Café", month: 10, day: 1,
      body: "En el Día del Café, el segundo café va por la casa." },
  ];
  const base = today instanceof Date && !Number.isNaN(today.getTime())
    ? new Date(today.getFullYear(), today.getMonth(), today.getDate())
    : new Date();
  const pad = n => String(n).padStart(2, "0");
  const dayOfDate = date => date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate());
  // Próxima ocurrencia de cada fecha comercial desde hoy (máximo 3 años para no repetir).
  const nextOccurrence = item => {
    for (let year = base.getFullYear(); year <= base.getFullYear() + 3; year++) {
      let date;
      if (item.nth) {
        const first = new Date(year, item.month - 1, 1);
        const offset = (item.weekday - first.getDay() + 7) % 7;
        date = new Date(year, item.month - 1, 1 + offset + (item.nth - 1) * 7);
      } else {
        date = new Date(year, item.month - 1, item.day);
      }
      if (date >= base) return date;
    }
    return null;
  };
  return CAMPAIGNS.map(item => ({ item, date: nextOccurrence(item) }))
    .filter(entry => entry.date)
    .sort((a, b) => a.date - b.date)
    .slice(0, 6)
    .map(entry => ({ id: entry.item.id, title: entry.item.title, body: entry.item.body, date: dayOfDate(entry.date) }));
}

/* ── SSR ─────────────────────────────────────────────────────────────────── */

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `*{box-sizing:border-box}
[hidden]{display:none!important}
:root{--p:#C4691C;--p-hover:#A95612;--p-dim:rgba(196,105,28,.12);--p-dim2:rgba(196,105,28,.06);--on-p:#17130F;--bg:#F6F5F2;--card:#fff;--soft:#F2F0EC;--soft2:#E9E6E0;--ink:#1F1D1A;--ink2:#5C5850;--muted:#8C877E;--line:#E3DFD8;--line2:#D2CDC4;--danger:#C4362F;--ok:#1F7A55;--side:#111820;--side2:#1a242e;--side-line:#26323d;--side-ink:#f4f7fa;--side-ink2:#aab6c0;--r:10px;--shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
html,body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,Inter,"Segoe UI",Roboto,sans-serif;font-size:14px;line-height:1.5;-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
a{color:var(--p)}
h1,h2,h3{margin:0;letter-spacing:-.01em}
/* ── estructura ── */
.app{display:grid;grid-template-columns:240px minmax(0,1fr);min-height:100vh;min-height:100dvh}
.side{position:sticky;top:0;height:100vh;height:100dvh;display:flex;flex-direction:column;background:var(--side);border-right:1px solid var(--side-line);color:var(--side-ink)}
.side .brand{padding:16px 14px}
.nav{flex:1;display:flex;flex-direction:column;gap:2px;padding:6px 8px}
.nav-title{padding:10px 10px 6px;color:#82919e;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.nav-link{display:block;width:100%;padding:9px 12px;border:0;border-radius:8px;background:none;color:#c9d2da;font:inherit;font-size:13.5px;text-align:left;cursor:pointer;transition:background .13s,color .13s}
.nav-link:hover{background:var(--side2);color:#fff}
.nav-link.active{background:rgba(218,123,43,.19);color:#ffad68;font-weight:600}
.side-foot{display:flex;flex-direction:column;gap:2px;padding:10px 8px 14px;border-top:1px solid var(--side-line)}
.side-foot .nav-link{color:var(--side-ink2);font-size:13px;text-decoration:none}
.user{display:grid;grid-template-columns:32px minmax(0,1fr);gap:4px 10px;align-items:center;margin-top:8px;padding:10px 6px 0;border-top:1px solid var(--side-line)}
.avatar{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--side2);color:#ffad68;font-weight:700;font-size:13px}
.user-txt{min-width:0;display:flex;flex-direction:column}
.user-txt strong{font-size:13px;color:var(--side-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-txt span{font-size:11.5px;color:#82919e;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-out{grid-column:2;justify-self:start;padding:2px 0;color:var(--side-ink2);font-size:12.5px}
.user-out:hover{color:#fff}
.topbar,.backdrop{display:none}
.main{min-width:0}
.view{max-width:1060px;margin:0 auto;padding:28px 32px 48px}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand img{width:34px;height:34px;border-radius:8px;object-fit:contain;background:#fff;flex:none}
.brand-dot{width:34px;height:34px;border-radius:8px;display:grid;place-items:center;background:var(--p);color:var(--on-p);font-weight:800;font-size:15px;flex:none}
.brand-txt{display:flex;flex-direction:column;min-width:0}
.brand-txt strong{font-size:14px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.brand-txt span{font-size:11.5px;color:var(--muted)}
.side .brand-txt span{color:#82919e}
/* ── auth ── */
.auth{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px}
.auth .brand{margin-bottom:18px}
.auth .card{width:100%;max-width:400px;padding:28px}
.auth .card h1{font-size:20px;margin-bottom:6px}
.auth .foot{margin-top:18px}
/* ── encabezados y bloques ── */
.screen{min-width:0}
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin:0 0 20px}
.page-head h1{font-size:22px;line-height:1.2;font-weight:700}
.page-head p{margin:4px 0 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px;margin:0 0 16px;box-shadow:var(--shadow)}
.card h1{font-size:20px;margin-bottom:8px}
.card h2{font-size:15px;font-weight:700;margin:0 0 12px}
.muted{margin:0 0 12px;color:var(--ink2)}
.hint{margin:6px 0 0;color:var(--muted);font-size:12px;line-height:1.45}
.small{font-size:12.5px}
.back{display:inline-block;margin:0 0 10px;padding:4px 0;border:0;background:none;color:var(--ink2);font:inherit;font-size:13px;cursor:pointer}
.back:hover{color:var(--p)}
/* ── formularios por secciones con índice ── */
.layout{display:grid;grid-template-columns:190px minmax(0,1fr);gap:28px;align-items:start}
.index{position:sticky;top:20px}
.index-title{padding:6px 12px;margin-bottom:4px;color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.index a{display:block;margin:2px 0;padding:8px 12px;border-radius:8px;color:var(--ink2);font-size:13px;text-decoration:none;transition:background .13s,color .13s}
.index a:hover{background:var(--p-dim2);color:var(--p)}
.sec{padding:22px 0;border-bottom:1px solid var(--line);scroll-margin-top:20px}
.sec:first-child{padding-top:0}
.sec:last-of-type{border-bottom:0}
.sec-head{margin-bottom:16px}
.sec-head h3{font-size:15px;font-weight:700}
.sec-head p{margin:4px 0 0;color:var(--muted);font-size:12.5px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}
.field{margin:0 0 16px}
.sec>.field:last-child,.grid2 .field{margin-bottom:0}
.grid2{row-gap:16px;margin-bottom:16px}
.sec>.grid2:last-child{margin-bottom:0}
label{display:block;margin:0 0 6px;font-size:12.5px;font-weight:600;color:var(--ink2)}
input,select,textarea{width:100%;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--ink);font:inherit;font-size:14px;outline:none;-webkit-appearance:none;appearance:none;transition:border-color .13s,box-shadow .13s,background .13s}
select{-webkit-appearance:auto;appearance:auto}
textarea{min-height:96px;resize:vertical;line-height:1.55}
input::placeholder,textarea::placeholder{color:var(--muted)}
input:focus,select:focus,textarea:focus{border-color:var(--p);background:#fff;box-shadow:0 0 0 3px var(--p-dim)}
:focus-visible{outline:2px solid var(--p);outline-offset:2px}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:0}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:38px;padding:8px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);font:inherit;font-size:13.5px;font-weight:600;text-decoration:none;cursor:pointer;transition:background .13s,border-color .13s,color .13s}
.btn:hover{background:var(--soft)}
.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:var(--p);border-color:var(--p);color:#fff}
.btn.primary:hover{background:var(--p-hover);border-color:var(--p-hover)}
.btn.ghost{background:transparent}
.btn.danger{color:var(--danger)}
.btn.danger:hover{background:rgba(196,54,47,.06);border-color:rgba(196,54,47,.3)}
.btn.small{min-height:32px;padding:5px 12px;font-size:13px}
.btn.mini{min-height:30px;padding:4px 10px;font-size:12.5px}
.link{padding:4px 2px;border:0;background:none;color:var(--ink2);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
.link:hover{color:var(--p)}
.link.danger:hover{color:var(--danger)}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.auth .form-actions{border:0;padding-top:0;margin-top:18px}
.auth .form-actions .btn,.auth form>.btn{width:100%}
.err{margin:10px 0 0;color:var(--danger);font-size:13px;font-weight:600}
.err:empty{display:none}
.search{position:relative;margin:0 0 16px;max-width:360px}
/* ── switch ── */
.switch{display:flex;align-items:center;gap:10px;padding:6px 0;cursor:pointer;margin:0}
.switch input{position:absolute;opacity:0;width:1px;height:1px}
.switch .track{position:relative;width:36px;height:20px;border-radius:999px;background:var(--line2);transition:background .13s;flex:none}
.switch .track::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .13s}
.switch input:checked+.track{background:var(--p)}
.switch input:checked+.track::after{transform:translateX(16px)}
.switch input:focus-visible+.track{outline:2px solid var(--p);outline-offset:2px}
.switch-label{font-size:13.5px;font-weight:500;color:var(--ink)}
.switches{display:flex;flex-wrap:wrap;gap:4px 24px}
/* ── listas tipo tabla ── */
.table{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
.thead,.prod{display:grid;grid-template-columns:minmax(0,1fr) 150px 120px 120px 130px;gap:14px;align-items:center;padding:10px 16px}
.thead{background:var(--soft);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.group{grid-column:1/-1;margin:0;padding:9px 16px;background:var(--soft);border-bottom:1px solid var(--line);color:var(--ink2);font-size:12px;font-weight:700}
.prod{border-bottom:1px solid var(--line)}
.prod:last-child{border-bottom:0}
.prod:hover{background:#FBFAF8}
.prod-main{display:flex;align-items:center;gap:12px;min-width:0}
.thumb{width:40px;height:40px;border-radius:8px;object-fit:cover;background:var(--soft);flex:none}
.thumb.ph{display:grid;place-items:center;font-size:14px;font-weight:700;color:var(--muted)}
.prod-name{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prod-cat{color:var(--ink2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prod-price{display:flex;flex-direction:column;font-weight:600;font-variant-numeric:tabular-nums}
.price.promo{color:var(--ok)}
.price.strike{color:var(--muted);text-decoration:line-through;font-weight:400;font-size:12px}
.status{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--ink2)}
.status::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ok)}
.status.off::before{background:var(--line2)}
.status.off{color:var(--muted)}
.prod-actions{display:flex;justify-content:flex-end;gap:10px}
.prod-note{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.catalog-row{display:grid;grid-template-columns:28px minmax(0,1fr) 150px 130px;gap:14px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--line)}
.catalog-row:last-child{border-bottom:0}.catalog-row:hover{background:#FBFAF8}.catalog-row .prod-actions{grid-column:auto}
.staff-head,.staff-row,.club-detail-head,.club-detail-row{display:grid;gap:14px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line)}
.staff-head,.club-detail-head{background:var(--soft);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.staff-row{grid-template-columns:minmax(0,1fr) 100px 130px 150px auto}.staff-row:hover,.club-detail-row:hover{background:#FBFAF8}.staff-row:last-child,.club-detail-row:last-child{border-bottom:0}
.club-detail-head,.club-detail-row{grid-template-columns:minmax(0,1fr) 150px minmax(120px,1fr)}
.notice{margin:0 0 16px;padding:10px 12px;border:1px solid rgba(196,105,28,.3);border-radius:8px;background:var(--p-dim2);color:var(--ink2);font-size:13px}
/* ── pedidos ── */
.order-head,.order-row{display:grid;grid-template-columns:minmax(0,1fr) 100px 100px 110px 250px;gap:14px;align-items:center;padding:10px 16px}
.order-head{background:var(--soft);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.order-row{border-bottom:1px solid var(--line)}
.order-row:last-child{border-bottom:0}
.order-row:hover{background:#FBFAF8}
.order-main{display:flex;flex-direction:column;min-width:0}
.order-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.order-total{font-weight:600;font-variant-numeric:tabular-nums}
.order-state{font-size:13px;font-weight:600;color:var(--ink2)}
.order-state.confirmed{color:var(--ok)}
.order-state.rejected{color:var(--muted)}
.order-actions{display:flex;justify-content:flex-end;gap:10px;white-space:nowrap}
.order-state.paid{color:#0f5c7a}
.order-state.ready{color:var(--ok)}
/* ── caja: barra de turno y cierres ── */
.cash-wrap{margin:0 0 16px}
.cashbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}
.cash-id{display:flex;align-items:center;gap:8px;min-width:0;margin-right:auto}
.cash-id strong{font-size:13.5px;white-space:nowrap}
.cash-id select{width:auto;min-width:132px;padding:6px 10px;font-size:13px}
.cash-state{font-size:13px;font-weight:600;color:var(--ink2)}
.cash-state.abierta{color:var(--ok)}
.cashbar .hint{flex-basis:100%;margin:0}
.cashform{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px;width:100%;margin-top:4px;padding-top:10px;border-top:1px dashed var(--line2)}
.cashform .field{margin:0 0 8px}
.cashform .field .hint{margin-top:4px}
.cashform .actions{grid-column:1/-1;margin-top:0}
.cash-line{display:grid;grid-template-columns:minmax(0,1fr) 90px 110px;gap:12px;padding:9px 14px;border-bottom:1px solid var(--line)}
.cash-line:last-child{border-bottom:0}
.cash-line.head{background:var(--soft);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.num{font-variant-numeric:tabular-nums}
.money-negative{color:var(--danger)}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
.shift-head,.shift-row{display:grid;grid-template-columns:minmax(0,1fr) 96px 96px 82px 88px 88px 96px 82px 74px;gap:10px;align-items:center;padding:10px 14px;min-width:860px}
.shift-head{background:var(--soft);border-bottom:1px solid var(--line);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.shift-row{border-bottom:1px solid var(--line)}
.shift-row:last-child{border-bottom:0}
.shift-row:hover{background:#FBFAF8}
.shift-main{display:flex;flex-direction:column;min-width:0}
.shift-main strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shift-head span,.shift-row .num{font-variant-numeric:tabular-nums}
/* ── nueva orden: tarjetas con foto ── */
.neworder{display:grid;gap:18px;grid-template-columns:minmax(0,1.45fr) minmax(280px,1fr);align-items:start}
.neworder-main,.neworder-side{min-width:0}
.pick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:12px;margin:12px 0 0}
.pick-card{display:flex;flex-direction:column;align-items:stretch;min-width:0;padding:0;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);font:inherit;text-align:left;overflow:hidden;cursor:pointer;transition:border-color .12s,transform .08s}
.pick-card:not(:disabled):hover{border-color:var(--p)}
.pick-card:not(:disabled):active{transform:scale(.98)}
.pick-card:focus-visible{outline:3px solid var(--p);outline-offset:2px}
.pick-card:disabled{opacity:.55;cursor:not-allowed}
.pick-card.in-cart{border-color:var(--p);box-shadow:0 0 0 1px var(--p) inset}
.pick-media{position:relative;display:block;width:100%;aspect-ratio:4/3;background:var(--soft);overflow:hidden}
.pick-media img{display:block;width:100%;height:100%;object-fit:cover}
.pick-fallback{display:grid;place-items:center;width:100%;height:100%;background:linear-gradient(135deg,#F3F0EA,#E8E3DA);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.pick-fallback::before{content:"Sin foto"}
.pick-qty{position:absolute;top:8px;right:8px;min-width:24px;padding:2px 7px;border-radius:99px;background:var(--p);color:#fff;font-size:12px;font-weight:700;text-align:center}
.pick-body{display:flex;flex:1;flex-direction:column;justify-content:space-between;gap:6px;padding:10px 12px 12px}
.pick-name{font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.pick-price{font-size:13px;color:var(--ink2);font-variant-numeric:tabular-nums}
.pick-variants{margin:12px 0 0;padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--soft)}
.pick-variants h3{margin:0 0 8px;font-size:14px}
.pick-variants .check-row{background:var(--card)}
.cart-list{display:flex;flex-direction:column;margin:10px 0;border-top:1px solid var(--line)}
.cart-line{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.cart-line b,.cart-line span{display:block}
.cart-line .cart-note{font-size:12px;color:var(--ink2)}
.cart-line input{width:100%;padding:7px 9px;font-size:12.5px;background:var(--card)}
.qty-box{display:flex;align-items:center;gap:4px}
.qty-box button{width:32px;height:32px;padding:0;border:1px solid var(--line);border-radius:7px;background:var(--card);font:inherit;font-size:17px;cursor:pointer}
.qty-box b{min-width:20px;text-align:center}
.pos-cards{display:grid;gap:12px;margin-top:12px}
.pos-card{padding:14px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.pos-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}
.pos-head strong{font-size:17px;font-variant-numeric:tabular-nums}
.pos-meta{margin:3px 0 0;color:var(--ink2);font-size:12.5px}
.pos-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.pos-actions .btn{flex:0 0 auto}
@media(max-width:980px){.neworder{grid-template-columns:1fr}}
.nav-link.nav-split{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nav-note{font-size:11px;font-weight:600;color:#ffad68;white-space:nowrap}
/* ── códigos QR ── */
.qr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:14px}
.qr-item{display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;border:1px solid var(--line);border-radius:10px;background:var(--soft);text-align:center}
.qr-item canvas{display:block;width:100%;max-width:220px;height:auto;border:1px solid var(--line);border-radius:6px;background:#fff}
.qr-item strong{font-size:13.5px}
.qr-item .hint{margin:0}
.qr-item .url{width:100%;text-align:center}
.handle{cursor:grab;color:var(--muted);font-size:16px;letter-spacing:-2px;user-select:none;text-align:center}.handle:active{cursor:grabbing}
.dragging{opacity:.45}.option-row{display:grid;grid-template-columns:minmax(0,1fr) 120px auto;gap:8px;align-items:end;padding:8px 0;border-bottom:1px solid var(--line)}
.option-row:last-child{border-bottom:0}.check-list{display:grid;gap:8px;max-height:280px;overflow:auto;padding:2px}.check-row{display:flex;align-items:center;gap:9px;margin:0;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);font-size:13px;font-weight:500}.check-row input{width:16px;height:16px;padding:0;accent-color:var(--p);-webkit-appearance:auto;appearance:auto}
.check-row input[type=number]{width:120px;height:auto;margin-left:auto;padding:5px 8px;-webkit-appearance:none;appearance:none}.image-list{display:flex;flex-wrap:wrap;gap:10px}.image-item{position:relative;width:104px}.image-item img{display:block;width:104px;height:86px;object-fit:cover;border:1px solid var(--line);border-radius:8px;background:var(--soft)}.image-item .actions{margin-top:5px;gap:4px}.detail-list{display:grid;gap:8px}.detail-item{padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft)}
.empty{padding:36px 16px;text-align:center;color:var(--muted)}
.empty b{display:block;color:var(--ink);font-size:15px;margin-bottom:4px}
.rows{display:flex;flex-direction:column}
.club-row,.campaign{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:12px 0;border:0;border-bottom:1px solid var(--line);background:none;color:var(--ink);font:inherit;text-align:left}
button.club-row{cursor:pointer}
button.club-row:hover strong{color:var(--p)}
.club-row:last-child,.campaign:last-child{border-bottom:0}
.club-row strong,.club-row span{display:block}
.club-row span{font-size:12.5px;color:var(--muted);margin-top:2px}
.campaign{flex-direction:column;align-items:flex-start;gap:2px}
.campaign p{margin:0}
.club-list{display:flex;flex-direction:column}
.op-head,.op-row{display:grid;grid-template-columns:minmax(0,1fr) 64px minmax(0,1.6fr) 130px;
  gap:14px;align-items:start;padding:10px 16px;border-bottom:1px solid var(--line)}
.op-head{background:var(--soft);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.op-row:last-child{border-bottom:0}.op-row:hover{background:#FBFAF8}
.op-note{margin:0;color:var(--ink2);font-size:13px;overflow-wrap:anywhere}
.benefits{margin:0 0 18px;padding-left:20px;color:var(--ink2);font-size:13.5px}
.benefits li{margin:5px 0}
.club-pagination{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.counter{font-size:12px;color:var(--muted);text-align:right;margin:-10px 0 12px}
/* ── pestañas subrayadas ── */
.subtabs{display:flex;gap:4px;margin:0 0 20px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.subtabs::-webkit-scrollbar{display:none}
.subtab{padding:9px 12px;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:none;color:var(--ink2);font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;cursor:pointer}
.subtab:hover{color:var(--ink)}
.subtab.active{color:var(--p);border-bottom-color:var(--p);font-weight:600}
/* ── foto ── */
.photo{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.photo .preview{width:88px;height:88px;border-radius:10px;object-fit:cover;border:1px solid var(--line);background:var(--soft);flex:none}
.photo-info{flex:1;min-width:180px}
.photo-act{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
input[type=file]{padding:8px;border-style:dashed;font-size:13px}
input[type=file]::file-selector-button{margin-right:10px;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--ink);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
/* ── premios, horario, sedes ── */
.prizes,.week-editor,.branches{display:flex;flex-direction:column;margin:0 0 14px;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.prize{display:grid;grid-template-columns:minmax(0,1fr) 80px 100px 110px auto;gap:10px;align-items:end;padding:12px 14px;border-bottom:1px solid var(--line)}
.prize:last-child,.day-editor:last-child,.branch:last-child{border-bottom:0}
.prize .field{margin:0}
.prizes>p,.branches>p{margin:0;padding:14px}
.day-editor{display:grid;grid-template-columns:120px minmax(0,1fr);gap:12px;align-items:start;padding:10px 14px;border-bottom:1px solid var(--line)}
.day-head{display:flex;flex-direction:column;gap:4px;padding-top:6px}
.day-head strong{font-size:13.5px;font-weight:600}
.closed-check{display:flex;align-items:center;gap:6px;margin:0;font-weight:500;font-size:12.5px;color:var(--muted)}
.closed-check input{width:15px;height:15px;padding:0;-webkit-appearance:auto;appearance:auto;accent-color:var(--p)}
.time-ranges{display:flex;flex-direction:column;align-items:flex-start;gap:6px}
.time-ranges:empty::before{content:"Cerrado";padding-top:6px;color:var(--muted);font-size:13px}
.time-range{display:grid;grid-template-columns:150px auto 150px auto;gap:8px;align-items:center;color:var(--muted)}
.time-range input{padding:7px 10px}
.branch{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.6fr) auto;gap:12px;align-items:end;padding:12px 14px;border-bottom:1px solid var(--line)}
.branch .field{margin:0}
/* ── métricas ── */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:0 0 4px}
.kpi{padding:14px 16px;background:var(--card)}
.kpi-l{display:block;font-size:12px;color:var(--muted)}
.kpi-n{display:block;font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1.2;font-variant-numeric:tabular-nums}
.kpis .kpi{display:flex;flex-direction:column-reverse;justify-content:flex-end}
.chart{margin-top:18px}
.legend{display:flex;gap:16px;font-size:12px;color:var(--ink2);margin-bottom:8px}
.key{display:inline-flex;align-items:center;gap:6px}
.key::before{content:"";width:10px;height:3px;border-radius:2px;background:var(--p)}
.key.o::before{background:#22303a}
.bars{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:3px;align-items:end;height:150px;padding:6px 0;border-bottom:1px solid var(--line)}
.bar-col{display:flex;gap:1px;align-items:flex-end;height:100%}
.bar{flex:1;min-height:2px;border-radius:2px 2px 0 0}
.bar.v{background:var(--p)}
.bar.o{background:#22303a}
.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;margin-top:6px}
.club-chart{display:flex;align-items:end;gap:3px;height:150px;margin-top:18px;border-bottom:1px solid var(--line)}
.club-bar{flex:1;min-width:3px;background:var(--p);border-radius:2px 2px 0 0}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.url{display:block;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--soft);word-break:break-all;font-size:13px;color:var(--ink2)}
.foot{margin:24px 0 0;text-align:center;color:var(--muted);font-size:12px}
.boot{display:flex;align-items:center;justify-content:center;gap:10px;min-height:50vh;color:var(--muted);font-size:13.5px}
.spin{width:16px;height:16px;border-radius:50%;border:2px solid var(--p-dim);border-top-color:var(--p);animation:spin .7s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}
.toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom));z-index:60;max-width:min(92vw,420px);padding:10px 16px;border-radius:10px;background:#1F1D1A;color:#fff;font-size:13px;font-weight:500;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.18);opacity:0;pointer-events:none;transform:translate(-50%,8px);transition:opacity .2s,transform .2s}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:var(--danger)}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
/* ── tablet: sin índice, tabla más angosta ── */
@media(max-width:1100px){.layout{grid-template-columns:1fr}.index{display:none}.thead,.prod{grid-template-columns:minmax(0,1fr) 120px 110px 110px 120px}}
/* ── móvil: barra superior + pestañas subrayadas ── */
@media(max-width:820px){
html,body{font-size:15px}
.app{display:block}
.topbar{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:44px 1fr 44px;align-items:center;height:56px;padding:calc(env(safe-area-inset-top)) 8px 0;background:var(--side);border-bottom:1px solid var(--side-line)}
.topbar-logo{justify-self:center;max-height:36px;max-width:160px;object-fit:contain}
.topbar-name{justify-self:center;color:var(--side-ink);font-size:15px}
.burger{width:44px;height:44px;display:grid;place-content:center;gap:4px;border:0;background:none;cursor:pointer}
.burger span{display:block;width:20px;height:2px;border-radius:2px;background:var(--side-ink)}
.side{position:fixed;inset:0 auto 0 0;z-index:50;width:min(84vw,300px);height:100dvh;transform:translateX(-100%);transition:transform .2s ease;padding-top:env(safe-area-inset-top);box-shadow:0 0 40px rgba(0,0,0,.35)}
.side.open{transform:none}
.nav{overflow-y:auto}
.backdrop{display:block;position:fixed;inset:0;z-index:40;background:rgba(10,14,18,.5);opacity:0;pointer-events:none;transition:opacity .2s}
.backdrop.open{opacity:1;pointer-events:auto}
body.lock{overflow:hidden}
.nav-link{padding:11px 12px;font-size:15px}
.side-foot{padding-bottom:calc(14px + env(safe-area-inset-bottom))}
.view{padding:20px 16px 40px}
.page-head h1{font-size:20px}
.card{padding:18px 16px;border-radius:10px}
.grid2{grid-template-columns:1fr}
input,select,textarea{font-size:16px;padding:10px 12px}
.btn{min-height:42px}
.btn.small{min-height:36px}
.search{max-width:none}
.form-actions{position:static;margin:22px 0 0;padding:12px 0 calc(4px + env(safe-area-inset-bottom));background:var(--card);border-radius:0}
.form-actions .btn{flex:1}
.thead{display:none}
.prod{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"main price" "meta actions";gap:6px 12px;padding:12px 14px}
.prod-main{grid-area:main}.prod-price{grid-area:price;align-items:flex-end}.prod-cat{display:none}
.prod .status{grid-area:meta;padding-left:52px;font-size:12.5px}.prod-actions{grid-area:actions}
.catalog-row{grid-template-columns:24px minmax(0,1fr) auto;gap:8px;padding:12px 14px}.catalog-row>span:not(.handle),.catalog-row>.prod-note{display:none}.catalog-row .prod-actions{grid-column:2;justify-content:flex-start}
.staff-head,.club-detail-head{display:none}.staff-row,.club-detail-row{grid-template-columns:1fr;gap:5px;padding:12px 14px}.staff-row .prod-actions{justify-content:flex-start}
.op-head{display:none}.op-row{grid-template-columns:1fr;gap:4px;padding:12px 14px}
.order-head{display:none}
.order-row{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"main total" "meta state" "actions actions";gap:5px 12px;padding:12px 14px}
.order-main{grid-area:main}.order-total{grid-area:total;text-align:right}.order-delivery{grid-area:meta}
.order-state{grid-area:state;text-align:right}.order-actions{grid-area:actions;justify-content:flex-start}
.qr-grid{grid-template-columns:1fr}
.option-row{grid-template-columns:minmax(0,1fr) 92px auto}.image-item{width:calc(50% - 5px)}.image-item img{width:100%;height:100px}
.prize{grid-template-columns:1fr 1fr}.prize .field:first-child{grid-column:1/-1}.prize .btn{grid-column:1/-1}
.day-editor{grid-template-columns:1fr;gap:6px}
.day-head{flex-direction:row;justify-content:space-between;padding:0}
.time-range{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto}
.branch{grid-template-columns:1fr}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
.toast{bottom:calc(84px + env(safe-area-inset-bottom))}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
/* ── comanda térmica 58/80 mm: solo el pre dinámico llega al papel ── */
@media print{
  body{background:#fff}
  body>*:not(.print-ticket){display:none!important}
  .print-ticket{display:block!important;margin:0;font-family:monospace;font-size:11px;line-height:1.25;white-space:pre}
}
/* ── cierre de caja impreso: reporte en HTML simple (sin shiftTicketLines) ── */
@media screen{.print-sheet{display:none}}
.print-sheet{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px;color:#000;white-space:normal}
.print-sheet h4{margin:0 0 2px;font-size:15px}
.print-sheet p{margin:2px 0}
.print-sheet table{width:100%;border-collapse:collapse;margin:6px 0}
.print-sheet th,.print-sheet td{padding:3px 6px;border-bottom:1px solid #ddd;text-align:left}
.print-sheet td.num,.print-sheet th.num{text-align:right;font-variant-numeric:tabular-nums}
@media print{.print-ticket.print-sheet{white-space:normal;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:12px}}
`;

/* Runtime del navegador: se serializa con String() y se inyecta sin build. */
function runtime() {
  const S = window.__PANEL__ || {};
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  const qrFn = window.__qrPanel;
  const datesFn = window.__panelDates;
  const ticketFn = window.__panelTicket;
  const columnsFn = window.__panelColumns;
  const heightFn = window.__panelHeight;
  let me = null, V = null, tab = "products", search = "", viewToken = 0;
  let cats = [], prods = [], catalog = null, catalogVersion = null;
  let pendingOrders = 0, pendingNote = null;
  // Nueva orden POS: estado de pantalla (se conserva al cambiar de sección).
  let newOrder = null;
  // Sede elegida en la barra de caja de la sección de pedidos POS.
  let shiftSede = "";
  const paymentKeys = new Map();
  // Clave propia del cobro con datáfono: si el cajero corrige la autorización,
  // el cuerpo cambia y la clave también (misma clave + otro cuerpo = 409).
  const datafonoKeys = new Map();
  const shiftKeys = new Map();

  /* ── utilidades ── */
  function h(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    let value, checked;
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "value") value = v;
      else if (k === "checked") checked = !!v;
      else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : String(v));
    }
    if (value !== undefined) n.value = value;
    if (checked !== undefined) n.checked = checked;
    add(n, kids);
    return n;
  }
  function add(n, kids) {
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  const btn = (label, cls, onclick, extra) => h("button", Object.assign({ type: "button", class: cls, onclick }, extra || {}), label);
  const uid = (() => { let n = 0; return p => p + "-" + (++n); })();
  const field = (label, input, hint) => h("div", { class: "field" },
    h("label", { for: input.id, text: label }), input,
    hint ? h("p", { class: "hint", text: hint }) : null);
  // [[id, título, ayuda, ...nodos]] → índice lateral + secciones separadas por línea
  function sectioned(sections) {
    const key = uid("s");
    return h("div", { class: "layout" },
      h("nav", { class: "index", "aria-label": "Secciones" }, h("div", { class: "index-title", text: "En esta página" }),
        sections.map(([id, title]) => h("a", { href: "#" + key + id, text: title,
          onclick: ev => { ev.preventDefault(); document.getElementById(key + id).scrollIntoView({ behavior: "smooth", block: "start" }); } }))),
      h("div", {}, sections.map(([id, title, help, ...nodes]) => h("section", { class: "sec", id: key + id },
        h("div", { class: "sec-head" }, h("h3", { text: title }), help ? h("p", { text: help }) : null), nodes))));
  }
  function switchField(label, input, onChange) {
    input.addEventListener("change", () => { if (onChange) onChange(input.checked); });
    return h("label", { class: "switch", for: input.id },
      input, h("span", { class: "track", "aria-hidden": "true" }), h("span", { class: "switch-label", text: label }));
  }
  const safeUrl = u => {
    const s = typeof u === "string" ? u.trim() : "";
    return /^(https:\/\/|\/(?!\/)|blob:|data:image\/)/i.test(s) ? s : "";
  };
  const num = v => {
    const n = Number(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const money = v => "$" + num(v).toFixed(2);
  const priceText = v => (v == null || v === "" ? "" : num(v).toFixed(2));
  const priceValue = v => {
    const s = String(v ?? "").trim();
    if (!s) return null;
    const n = Number(s.replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
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
  const POS_STATE = { pending: "Pendiente · sin comanda", confirmed: "Confirmado · falta cobro", paid: "Pago confirmado", ready: "Listo para avisar", rejected: "Rechazado" };
  const POS_SOURCE = { web: "Web", caja: "Caja", mesero: "Mesero", mesa: "Mesa" };
  // `payphone` solo aparece en filas históricas: la integración está archivada en
  // integraciones/payphone y no se ofrecen cobros nuevos con ese método.
  const POS_PAYMENT = { cash: "efectivo", transfer: "transferencia", datafono: "datáfono", payphone: "tarjeta Payphone (histórico)", bendo: "tarjeta (Bendo)" };
  // Etiquetas del reporte de turno (docs/DATAFONO-MANUAL.md): el listado usa
  // minúscula dentro de "Pago: …"; el cierre y el ticket Z, nombres propios.
  const REPORT_PAYMENT = { cash: "Efectivo", transfer: "Transferencia", datafono: "Datáfono", bendo: "Tarjeta (link)", payphone: "Payphone (histórico)" };
  // "Pago: datáfono · aut. XXXX". El canal y la autorización llegan del listado
  // cuando la API los expone; sin ellos se mantiene la etiqueta del método.
  function posPaymentLabel(order) {
    const method = String(order?.payment_method || "cash");
    const channel = String(order?.payment_channel || order?.channel || "").trim();
    const auth = String(order?.authorization || "").trim();
    if (method === "datafono" || (method === "bendo" && (channel === "datafono" || auth)))
      return "datáfono" + (auth ? " · aut. " + auth : "");
    return POS_PAYMENT[method] || "efectivo";
  }
  const isPosOrder = o => !!o && (o.sede_id != null || o.total_cents != null);
  const posMoney = o => Number.isFinite(Number(o?.total_cents)) ? money(Number(o.total_cents) / 100) : money(o?.total);
  const posName = o => String(o?.customer_name || o?.client_name || "").trim();
  const posPhone = o => {
    const digits = String(o?.customer_phone || o?.client_phone || "").replace(/\D/g, "");
    return /^\d{8,15}$/.test(digits) ? digits : "";
  };
  const sedeNameOf = (id, sedeName) => String((sedeName && sedeName(id)) || id || "").trim();
  // Aviso manual para pedido listo: pedido y sede, sin cédula/RUC, correo ni dirección.
  function posWaLink(o, sedeName) {
    const phone = posPhone(o);
    if (!phone) return "";
    const place = sedeNameOf(o.sede_id, sedeName);
    const text = "Hola" + (posName(o) ? " " + posName(o) : "") +
      ", tu pedido " + orderCode(o) + (place ? " de " + place : "") + " está listo. Te esperamos.";
    return "https://wa.me/" + phone + "?text=" + encodeURIComponent(text);
  }
  const itemName = i => String(i?.name ?? i?.nombre ?? "Producto");
  const productImage = p => {
    const list = Array.isArray(p?.images) ? p.images : Array.isArray(p?.imagenes) ? p.imagenes : [];
    return safeUrl(list.find(Boolean)) || safeUrl(p?.image) || safeUrl(p?.imagen);
  };
  // La foto es decorativa: el nombre va visible y el botón anuncia nombre + precio.
  function productMedia(p) {
    const box = h("span", { class: "pick-media" });
    const url = productImage(p);
    if (!url) { box.append(h("span", { class: "pick-fallback", "aria-hidden": "true" })); return box; }
    const img = h("img", { src: url, alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { img.remove(); box.append(h("span", { class: "pick-fallback", "aria-hidden": "true" })); });
    box.append(img);
    return box;
  }

  /* ── API y mensajes ── */
  const ERRORS = {
    credenciales_invalidas: "El correo o la contraseña no coinciden.",
    password_corta: "La contraseña necesita al menos 8 caracteres.",
    token_invalido: "El enlace venció o ya se usó. Pide uno nuevo.",
    demasiados_intentos: "Demasiados intentos seguidos. Espera un minuto y vuelve a probar.",
    no_existe: "Ese elemento ya no existe. Actualiza la lista.",
    archivo_grande: "La imagen pesa demasiado (máximo 2 MB).",
    tipo_invalido: "Formato no admitido. Usa WEBP, JPG o PNG.",
    archivo_invalido: "No pudimos leer la imagen. Prueba con otra.",
    sin_sesion: "Tu sesión venció. Vuelve a entrar.",
    no_autorizado: "Tu sesión venció. Vuelve a entrar.",
    sesion_vencida: "Tu sesión venció. Vuelve a entrar.",
    sesion_invalida: "Tu sesión venció. Vuelve a entrar.",
    pin_repetido: "Ese PIN ya está asignado a otro mesero activo.",
    limite_meseros: "Ya alcanzaste el máximo de meseros activos.",
    plan_requerido: "Tu tarjeta de fidelidad no está activa. Actívala para encender el club.",
    bendo_no_disponible: "El cobro con tarjeta no está disponible ahora.",
    caja_cerrada: "Abre la caja de esta sede para cobrar.",
    caja_ya_abierta: "Esta sede ya tiene una caja abierta.",
    turno_cerrado: "Ese turno de caja ya se cerró.",
    pago_en_curso: "Este pedido tiene un pago con tarjeta en curso. Verifícalo antes de cobrar con datáfono.",
    orden_ya_pagada: "Ese pedido ya está pagado.",
    idempotencia_conflicto: "Ese intento ya se usó con otros datos. Vuelve a intentar.",
    autorizacion_invalida: "Revisa el número de autorización: 4 a 12 letras o números.",
    tarjeta_invalida: "Los últimos 4 dígitos deben ser 4 números.",
  };
  const errMsg = (r, fallback) => {
    if (r && r.status === 0) return "No pudimos conectar. Revisa tu internet e intenta de nuevo.";
    return (r && r.data && ERRORS[r.data.error]) || fallback || "Algo salió mal. Intenta de nuevo.";
  };
  async function api(path, body, method) {
    const opt = { credentials: "same-origin", headers: { accept: "application/json" }, method: method || (body === undefined ? "GET" : "POST") };
    if (body !== undefined) opt.body = JSON.stringify(body);
    if (opt.method !== "GET") opt.headers["content-type"] = "application/json";
    try {
      const r = await fetch("/panel/api/" + path, opt);
      return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})), version: r.headers.get("x-catalog-version") };
    } catch { return { status: 0, data: {} }; }
  }
  async function loadCatalog() {
    const r = await api("catalog");
    if (r.status === 200) {
      catalog = r.data || {};
      catalogVersion = Number(catalog.version);
      if (!Number.isFinite(catalogVersion)) catalogVersion = null;
      cats = Array.isArray(catalog.categories) ? catalog.categories : [];
      prods = Array.isArray(catalog.products) ? catalog.products : [];
      catalog.variant_groups = (Array.isArray(catalog.variant_groups) ? catalog.variant_groups : []).map(group => ({
        ...group,
        product_ids: prods.filter(product => Array.isArray(product.groups) && product.groups.some(ref => ref.group_id === group.id)).map(product => product.id),
      }));
      catalog.packagings = (Array.isArray(catalog.packagings) ? catalog.packagings : []).map(packaging => ({
        ...packaging,
        product_ids: prods.filter(product => product.packaging_id === packaging.id).map(product => product.id),
      }));
    }
    return r;
  }
  async function catalogApi(path, body, method) {
    const payload = body === undefined ? undefined : Object.assign({}, body, catalogVersion == null ? {} : { if_version: catalogVersion });
    const r = await api(path, payload, method);
    if (r.status === 409) {
      await loadCatalog();
      toast("Alguien más editó el catálogo; recargamos los datos", true);
      return r;
    }
    if ((r.status >= 200 && r.status < 300) && r.version != null) catalogVersion = Number(r.version);
    return r;
  }
  async function uploadBlob(blob) {
    try {
      const r = await fetch("/panel/api/upload", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": blob.type || "image/webp", "x-panel": "1" },
        body: blob,
      });
      return { status: r.status, data: r.status === 204 ? {} : await r.json().catch(() => ({})) };
    } catch { return { status: 0, data: {} }; }
  }
  let toastTimer = 0;
  function toast(message, bad) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.toggle("bad", !!bad);
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 3400);
  }
  // Contador de pedidos sin confirmar junto a "Pedidos" en el menú lateral.
  function paintPending() {
    if (!pendingNote) return;
    pendingNote.textContent = pendingOrders ? pendingOrders + " sin confirmar" : "";
    pendingNote.hidden = !pendingOrders;
  }
  async function refreshPending() {
    const r = await api("orders?limit=1");
    if (r.status !== 200) return;
    pendingOrders = Number(r.data.pending) || 0;
    paintPending();
  }

  /* ── estado de pantalla ── */
  function applyMe(data) {
    me = data || null;
  }
  // Función "tarjeta" por plan. Sin el dato (clubs viejos) se asume habilitada.
  const loyaltyAllowed = () => !(me && me.features && me.features.loyalty === false);
  function bootView(label) {
    app.replaceChildren(h("div", { class: "boot", role: "status" }, h("span", { class: "spin", "aria-hidden": "true" }), label));
  }
  function loadingView(label) {
    if (!V) return bootView(label);
    V.replaceChildren(h("div", { class: "boot", role: "status" }, h("span", { class: "spin", "aria-hidden": "true" }), label));
  }
  function failView(message, retry) {
    const card = h("section", { class: "card" },
      h("h2", { text: "No pudimos cargar esto" }),
      h("p", { class: "muted", text: message }),
      retry ? btn("Reintentar", "btn primary", retry) : null);
    if (V) V.replaceChildren(card);
    else app.replaceChildren(h("div", { class: "screen" }, card));
  }
  function brandBlock() {
    const st = (me && me.store) || {}, logo = safeUrl(st.logo);
    return h("div", { class: "brand" },
      logo ? h("img", { src: logo, alt: "" }) : h("div", { class: "brand-dot", "aria-hidden": "true" }, String(st.store_name || S.slug || "M").slice(0, 1).toUpperCase()),
      h("div", { class: "brand-txt" },
        h("strong", { text: st.store_name || S.slug || "Mi negocio" }),
        h("span", { text: "Panel del menú" })));
  }
  function authShell(...nodes) {
    app.replaceChildren(h("main", { class: "auth" }, brandBlock(), ...nodes,
      me ? btn("Salir", "link", logout) : null,
      h("footer", { class: "foot" }, "Craft Systems · Menú digital")));
  }

  /* ── sesión ── */
  const goLogin = notice => { viewToken++; V = null; loginScreen(notice); };

  function loginScreen(notice) {
    V = null;
    document.title = "Panel · " + (S.slug || "menú");
    const email = h("input", { id: uid("email"), type: "email", autocomplete: "username", inputmode: "email", required: true });
    const pass = h("input", { id: uid("pass"), type: "password", autocomplete: "current-password", required: true });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h("button", { type: "submit", class: "btn primary" }, "Entrar");
    const form = h("form", { novalidate: true },
      field("Correo", email), field("Contraseña", pass), submit, err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      const e = email.value.trim(), p = pass.value;
      if (!e || !p) { err.textContent = "Escribe tu correo y tu contraseña."; return; }
      submit.disabled = true;
      submit.textContent = "Entrando…";
      const r = await api("login", { email: e, password: p });
      submit.disabled = false;
      submit.textContent = "Entrar";
      if (r.status === 200) {
        applyMe(r.data);
        return me.must_change_password ? passwordScreen(true) : shell();
      }
      err.textContent = errMsg(r, "No pudimos entrar. Revisa tus datos.");
      pass.value = "";
      pass.focus();
    });
    authShell(h("section", { class: "card" },
      h("h1", { text: "Tu panel" }),
      h("p", { class: "muted", text: "Administra la carta, los pedidos y los reportes de tus sedes." }),
      notice ? h("p", { class: "hint", text: notice }) : null,
      form));
    email.focus();
  }

  async function logout() {
    await api("logout", {});
    applyMe(null);
    loginScreen();
  }

  function passwordScreen(force) {
    V = null;
    const cur = h("input", { id: uid("pcur"), type: "password", autocomplete: "current-password", required: true });
    const nw = h("input", { id: uid("pnew"), type: "password", autocomplete: "new-password", required: true, minlength: 8 });
    const rep = h("input", { id: uid("prep"), type: "password", autocomplete: "new-password", required: true });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h("button", { type: "submit", class: "btn primary" }, "Guardar contraseña");
    const form = h("form", { novalidate: true },
      field("Contraseña actual", cur),
      field("Contraseña nueva", nw, "Mínimo 8 caracteres."),
      field("Repite la contraseña nueva", rep),
      submit, err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      if (nw.value.length < 8) { err.textContent = "La contraseña necesita al menos 8 caracteres."; return; }
      if (nw.value !== rep.value) { err.textContent = "Las contraseñas nuevas no coinciden."; return; }
      submit.disabled = true;
      submit.textContent = "Guardando…";
      const r = await api("password", { current: cur.value, new: nw.value });
      submit.disabled = false;
      submit.textContent = "Guardar contraseña";
      if (r.status === 204) {
        toast("Contraseña actualizada.");
        const m = await api("me");
        if (m.status === 200) applyMe(m.data);
        return me && me.must_change_password ? passwordScreen(true) : shell();
      }
      err.textContent = r.status === 401 ? "La contraseña actual no coincide." : errMsg(r, "No pudimos cambiar la contraseña.");
    });
    authShell(h("section", { class: "card" },
      h("h1", { text: force ? "Cambia tu contraseña" : "Cambiar contraseña" }),
      h("p", { class: "muted", text: force
        ? "Antes de continuar, define una contraseña nueva. Es obligatorio por seguridad."
        : "Elige una contraseña nueva. Se cerrarán las sesiones abiertas en otros dispositivos." }),
      form,
      force ? btn("Cerrar sesión", "btn ghost", logout) : btn("Volver al panel", "btn ghost", shell)));
    cur.focus();
  }

  function resetScreen() {
    V = null;
    const token = new URLSearchParams(location.search).get("t") || "";
    if (!token) {
      authShell(h("section", { class: "card" },
        h("h1", { text: "Enlace incompleto" }),
        h("p", { class: "muted", text: "Este enlace no trae el código de recuperación. Pide uno nuevo desde tu panel." }),
        h("a", { class: "btn primary", href: "/panel" }, "Ir al panel")));
      return;
    }
    const nw = h("input", { id: uid("rnew"), type: "password", autocomplete: "new-password", required: true, minlength: 8 });
    const rep = h("input", { id: uid("rrep"), type: "password", autocomplete: "new-password", required: true });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h("button", { type: "submit", class: "btn primary" }, "Crear contraseña");
    const form = h("form", { novalidate: true },
      field("Contraseña nueva", nw, "Mínimo 8 caracteres."),
      field("Repite la contraseña", rep),
      submit, err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      if (nw.value.length < 8) { err.textContent = "La contraseña necesita al menos 8 caracteres."; return; }
      if (nw.value !== rep.value) { err.textContent = "Las contraseñas no coinciden."; return; }
      submit.disabled = true;
      submit.textContent = "Guardando…";
      const r = await api("reset", { token, new: nw.value });
      submit.disabled = false;
      submit.textContent = "Crear contraseña";
      if (r.status === 200) {
        applyMe(r.data);
        toast("Contraseña creada. Ya puedes entrar.");
        return me.must_change_password ? passwordScreen(true) : shell();
      }
      err.textContent = errMsg(r, "No pudimos crear la contraseña. Pide un enlace nuevo.");
    });
    authShell(h("section", { class: "card" },
      h("h1", { text: "Crea tu contraseña" }),
      h("p", { class: "muted", text: "El enlace sirve una sola vez y vence en 30 minutos." }),
      form));
    nw.focus();
  }

  /* ── shell con pestañas ── */
  const deliveryLabel = m => (m === "delivery" ? "Domicilio" : m === "mesa" ? "Mesa" : m ? "Retiro en local" : "—");
  function shell() {
    if (!me) return loginScreen();
    const st = me.store || {};
    document.title = "Panel · " + (st.store_name || S.slug || "menú");
    V = h("div", { class: "view" });
    const nav = h("nav", { class: "nav", "aria-label": "Secciones del panel" });
    const tabs = [
      ["products", "Productos", productsScreen, "Menú"],
      ["variants", "Variantes", variantsScreen, "Menú"],
      ["packagings", "Empaques", packagingsScreen, "Menú"],
      ["orders", "Pedidos", ordersScreen, "Ventas"],
      ["new-order", "Nueva orden", newOrderScreen, "Ventas"],
      ["waiters-tables", "Meseros y mesas", meserosTablesScreen, "Ventas"],
      ["stats", "Resultados", statsScreen, "Ventas"],
      ["reports", "Reportes", reportsScreen, "Ventas"],
      ["cierres", "Cierres de caja", cierresScreen, "Ventas"],
      ["store", "Mi negocio", storeScreen, "Negocio"],
      ...(me.loyalty_available ? [["loyalty", "Fidelidad", loyaltyScreen, "Negocio"]] : []),
    ];
    const buttons = [];
    let navGroup = "";
    tabs.forEach(([id, label, action, group]) => {
      if (group !== navGroup) { navGroup = group; nav.append(h("div", { class: "nav-title", text: group })); }
      const b = h("button", { class: "nav-link", type: "button", "data-tab": id, onclick: () => go(id) }, label);
      nav.append(b); buttons.push(b);
    });
    const ordersButton = buttons.find(b => b.dataset.tab === "orders");
    if (ordersButton) {
      ordersButton.classList.add("nav-split");
      pendingNote = h("span", { class: "nav-note" });
      ordersButton.append(pendingNote);
    }
    const go = id => {
      tab = id;
      buttons.forEach(b => {
        const on = b.dataset.tab === id;
        b.classList.toggle("active", on);
        if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
      });
      setDrawer(false);
      window.scrollTo(0, 0);
      tabs.find(t => t[0] === id)[2]();
    };
    const menuUrl = safeUrl(st.menu_url), email = String(me.email || "");
    // Móvil: el sidebar es un cajón que abre la hamburguesa; en escritorio queda fijo.
    const side = h("aside", { class: "side", id: "panelSide" }, brandBlock(), nav,
      h("div", { class: "side-foot" },
        menuUrl ? h("a", { class: "nav-link", href: menuUrl, target: "_blank", rel: "noopener" }, "Ver menú ↗") : null,
        h("div", { class: "user" },
          h("span", { class: "avatar", "aria-hidden": "true", text: (email || "?").slice(0, 1).toUpperCase() }),
          h("div", { class: "user-txt" }, h("strong", { text: st.store_name || S.slug || "Mi negocio" }), h("span", { text: email })),
          btn("Salir", "link user-out", logout))));
    const burger = h("button", { class: "burger", type: "button", "aria-label": "Abrir menú", "aria-controls": "panelSide", "aria-expanded": "false", onclick: () => setDrawer(!side.classList.contains("open")) },
      h("span"), h("span"), h("span"));
    const backdrop = h("div", { class: "backdrop", onclick: () => setDrawer(false) });
    function setDrawer(open) {
      side.classList.toggle("open", open); backdrop.classList.toggle("open", open);
      burger.setAttribute("aria-expanded", String(open)); document.body.classList.toggle("lock", open);
    }
    const logo = safeUrl(st.logo);
    app.replaceChildren(h("div", { class: "app" },
      h("header", { class: "topbar" }, burger,
        logo ? h("img", { class: "topbar-logo", src: logo, alt: st.store_name || "Logo" }) : h("strong", { class: "topbar-name", text: st.store_name || S.slug || "Mi negocio" }),
        h("span", { "aria-hidden": "true" })),
      backdrop, side,
      h("main", { class: "main" }, V)));
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") setDrawer(false); });
    go(tab);
    refreshPending();
  }

  /* ── Catálogo ── */
  function normalizeCats(raw) {
    const one = c => {
      if (typeof c === "string") return { slug: c, label: c };
      if (Array.isArray(c) && c.length >= 2) return { slug: String(c[0] || ""), label: String(c[1] ?? c[0] ?? "") };
      if (c && typeof c === "object") {
        const slug = String(c.slug || c.id || c.value || "");
        const label = c.label ?? c.name ?? slug;
        return { slug, label: typeof label === "string" ? label : String(label || slug) };
      }
      return null;
    };
    let list = [];
    if (Array.isArray(raw)) list = raw.map(one);
    else if (raw && typeof raw === "object") list = Object.entries(raw).map(([slug, label]) => ({
      slug,
      label: typeof label === "string" ? label : (label && (label.label || label.name)) || slug,
    }));
    return list.filter(c => c && c.slug);
  }
  function catOf(value) {
    const v = String(value || "");
    if (!v) return null;
    return cats.find(c => c.slug === v) || cats.find(c => norm(c.label) === norm(v)) || null;
  }
  const firstCat = p => (Array.isArray(p.categories) && p.categories.length ? p.categories[0] : "");
  const productName = p => String(p.name || p.nombre || "Producto");
  const productPrice = p => p.price ?? p.precio;
  const productPromo = p => p.promo_price ?? p.precio_promo;
  const isOff = p => p.active === false || p.catalog_visible === false || p.stock === 0 || p.stock === "0";
  const dayLabel = sku => {
    const names = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
    const d = String(sku || "").split(",").map(x => x.trim()).filter(Boolean);
    return d.length ? d.map(x => names[Number(x)] || x).join(", ") : "Todos los días";
  };

  async function productsScreen() {
    const token = ++viewToken;
    loadingView("Cargando productos…");
    const r = await loadCatalog();
    if (token !== viewToken) return;
    if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (r.status !== 200) return failView(errMsg(r, "No pudimos cargar los productos."), productsScreen);
    paintProducts();
  }

  function catalogTabs(active) {
    const promoCount = prods.filter(p => p.type === "promocion").length;
    return h("nav", { class: "subtabs", "aria-label": "Opciones de productos" },
      btn("Productos", "subtab" + (active === "products" ? " active" : ""), () => paintProducts("products")),
      btn("Categorías (" + cats.length + ")", "subtab" + (active === "categories" ? " active" : ""), categoriesScreen),
      btn("Promos (" + promoCount + ")", "subtab" + (active === "promos" ? " active" : ""), () => paintProducts("promos")));
  }

  function paintProducts(mode = "products") {
    const q = h("input", { id: "prodSearch", type: "search", placeholder: "Buscar por nombre", autocomplete: "off", value: search });
    q.addEventListener("input", () => { search = q.value; paintList(); });
    const list = h("div");
    const wrap = h("section", { class: "screen" },
      h("div", { class: "page-head" },
        h("div", {}, h("h1", { text: mode === "promos" ? "Promociones" : "Productos" }),
          h("p", { class: "muted small", text: prods.length + (prods.length === 1 ? " producto" : " productos") })),
        btn(mode === "promos" ? "+ Nueva promo" : "+ Nuevo", "btn primary small", () => productForm(null, mode === "promos" ? "promocion" : "producto"))),
      catalogTabs(mode),
      h("div", { class: "search" },
        h("label", { class: "sr", for: q.id, text: "Buscar producto" }), q),
      h("div", { class: "table" },
        h("div", { class: "thead", "aria-hidden": "true" }, h("span", { text: "Producto" }), h("span", { text: "Categoría" }),
          h("span", { text: "Precio" }), h("span", { text: "Estado" }), h("span")),
        list));
    V.replaceChildren(wrap);
    paintList();

    function paintList() {
      list.replaceChildren();
      const needle = norm(search);
      const shown = prods.filter(p => (mode === "promos" ? p.type === "promocion" : p.type !== "promocion") && (!needle || norm(productName(p) + " " + (p.description || "")).includes(needle)));
      if (!shown.length) {
        list.append(h("div", { class: "empty" },
          h("b", { text: prods.length ? "Sin resultados" : "Todavía no tienes productos" }),
          h("p", { class: "muted small", text: prods.length ? "Prueba con otro nombre." : "Crea el primero para que aparezca en tu menú." }),
          !prods.length ? btn("+ Nuevo producto", "btn primary small", () => productForm(null)) : null));
        return;
      }
      const groups = new Map();
      for (const p of shown) {
        const own = Array.isArray(p.categories) && p.categories.length ? p.categories : [""];
        own.forEach(key => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(p); });
      }
      const order = cats.map(c => c.slug).concat([""]);
      for (const key of order) {
        const items = groups.get(key);
        if (!items) continue;
        const c = cats.find(x => x.slug === key);
        list.append(h("h2", { class: "group", text: (c ? (c.name || c.label) : key ? key : "Sin categoría") + " · " + items.length }));
        for (const p of items) list.append(productRow(p));
      }
      for (const [key, items] of groups) {
        if (order.includes(key)) continue;
        list.append(h("h2", { class: "group", text: key + " · " + items.length }));
        for (const p of items) list.append(productRow(p));
      }
    }
  }

  function productRow(p) {
    const img = safeUrl(Array.isArray(p.images) ? p.images[0] : "");
    const promo = productPromo(p) ? money(productPromo(p)) : "";
    const c = catOf(firstCat(p));
    return h("article", { class: "prod" },
      h("div", { class: "prod-main" },
        img
          ? h("img", { class: "thumb", src: img, alt: "" })
          : h("div", { class: "thumb ph", "aria-hidden": "true" }, productName(p).slice(0, 1).toUpperCase()),
        h("strong", { class: "prod-name", text: productName(p) })),
      h("span", { class: "prod-cat", text: c ? (c.name || c.label) : firstCat(p) || "—" }),
      h("div", { class: "prod-price" },
        promo ? h("span", { class: "price promo", text: promo }) : null,
        h("span", { class: "price" + (promo ? " strike" : ""), text: money(productPrice(p)) })),
      h("span", { class: "status" + (isOff(p) ? " off" : ""), text: p.active === false ? "Inactivo" : p.catalog_visible === false ? "Oculto" : isOff(p) ? "Agotado" : "Disponible" }),
      h("div", { class: "prod-actions" },
        btn(isOff(p) ? "Disponible" : "Agotar", "link", () => stockQuick(p), { "aria-label": "Cambiar disponibilidad de " + productName(p) }),
        btn("Editar", "link", () => productForm(p), { "aria-label": "Editar " + productName(p) }),
        btn("Eliminar", "link danger", () => removeProduct(p), { "aria-label": "Eliminar " + productName(p) })));
  }

  async function stockQuick(p) {
    const r = await catalogApi("products/" + encodeURIComponent(p.id), Object.assign({}, p, { stock: p.stock === 0 ? null : 0 }), "PUT");
    if (r.status === 409) return productsScreen();
    if (r.status === 200) { toast(p.stock === 0 ? "Producto disponible." : "Producto agotado."); return productsScreen(); }
    toast(errMsg(r, "No pudimos actualizar el producto."), true);
  }

  async function removeProduct(p) {
    if (!confirm('¿Eliminar "' + productName(p) + '"? Esta acción no se puede deshacer.')) return;
    const r = await catalogApi("products/" + encodeURIComponent(p.id), {}, "DELETE");
    if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (r.status === 204 || r.status === 404) { toast("Producto eliminado."); return productsScreen(); }
    toast(errMsg(r, "No pudimos eliminar el producto."), true);
  }

  /* ── Foto: canvas → webp ≤1200 px → subida ── */
  function shrinkImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, 1200 / Math.max(img.width || 1, img.height || 1));
        const w = Math.max(1, Math.round((img.width || 1) * scale));
        const hh = Math.max(1, Math.round((img.height || 1) * scale));
        const cv = document.createElement("canvas");
        cv.width = w; cv.height = hh;
        cv.getContext("2d").drawImage(img, 0, 0, w, hh);
        URL.revokeObjectURL(url);
        const encode = q => cv.toBlob(b => {
          if (!b) return reject(new Error("sin_imagen"));
          if (b.size > 2 * 1024 * 1024 && q > 0.4) return encode(Math.round((q - 0.1) * 10) / 10);
          if (b.size > 2 * 1024 * 1024) return reject(new Error("archivo_grande"));
          resolve(b);
        }, "image/webp", q);
        encode(0.82);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("imagen_invalida")); };
      img.src = url;
    });
  }

  function photoPicker(label, initial, onChange, canClear = true) {
    let url = safeUrl(initial);
    const img = h("img", { class: "preview", alt: "Vista previa" });
    if (url) img.src = url;
    img.hidden = !url;
    const file = h("input", { id: uid("photo"), type: "file", accept: "image/*", class: "sr" });
    // ponytail: botón propio porque el nativo muestra el texto del idioma del navegador ("Choose File")
    const pick = h("label", { for: file.id, class: "btn small", text: "Elegir foto" });
    const msg = h("p", { class: "hint", text: "WEBP, JPG o PNG. Se ajusta a 1200 px y se sube sola; la imagen final no supera 2 MB." });
    const clear = btn("Quitar foto", "btn ghost small", () => {
      url = ""; img.hidden = true; img.removeAttribute("src"); clear.hidden = true;
      msg.textContent = "Foto quitada.";
      if (onChange) onChange("");
    });
    clear.hidden = !url || !canClear;
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (!/^image\//.test(f.type || "")) { msg.textContent = "Elige un archivo de imagen."; return; }
      file.disabled = true;
      msg.textContent = "Preparando la foto…";
      try {
        const blob = await shrinkImage(f);
        msg.textContent = "Subiendo la foto…";
        const r = await uploadBlob(blob);
        if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
        if ((r.status === 200 || r.status === 201) && r.data && r.data.url) {
          url = safeUrl(r.data.url);
          img.src = url; img.hidden = false; clear.hidden = !canClear;
          msg.textContent = "Foto lista.";
          if (onChange) onChange(url);
        } else {
          msg.textContent = errMsg(r, "No pudimos subir la foto.");
        }
      } catch (e) {
        msg.textContent = e && e.message === "archivo_grande"
          ? "La foto sigue pesando más de 2 MB. Prueba con una más liviana."
          : "No pudimos leer la imagen. Prueba con otra.";
      }
      file.disabled = false;
      file.value = "";
    });
    return {
      node: h("div", { class: "photo" }, img,
        h("div", { class: "photo-info" }, h("label", { for: file.id, text: label }), file, h("div", { class: "photo-act" }, pick, clear), msg)),
      get: () => url,
    };
  }

  function productForm(p, presetType) {
    const isNew = !p, base = p || {}, images = Array.isArray(base.images) ? base.images.slice() : [];
    const nombre = h("input", { id: uid("pname"), type: "text", value: base.name || "", maxlength: 120, autocomplete: "off" });
    const precio = h("input", { id: uid("pprice"), type: "text", inputmode: "decimal", value: priceText(base.price) });
    const promo = h("input", { id: uid("ppromo"), type: "text", inputmode: "decimal", value: priceText(base.promo_price) });
    const desc = h("textarea", { id: uid("pdesc"), maxlength: 1000, value: base.description || "" });
    const active = h("input", { id: uid("pactive"), type: "checkbox", checked: base.active !== false });
    const visible = h("input", { id: uid("pvisible"), type: "checkbox", checked: base.catalog_visible !== false });
    const packaging = h("select", { id: uid("ppack") }, h("option", { value: "", text: "Sin envase" }), ...(catalog.packagings || []).map(x => h("option", { value: x.id, text: x.name + " · " + money(x.price) })));
    packaging.value = base.packaging_id || "";
    const stock = h("select", { id: uid("pstock") }, h("option", { value: "unlimited", text: "Ilimitado" }), h("option", { value: "out", text: "Agotado" }), h("option", { value: "count", text: "Cantidad" }));
    stock.value = base.stock == null ? "unlimited" : base.stock === 0 ? "out" : "count";
    const stockQty = h("input", { id: uid("pqty"), type: "number", min: "0", step: "1", value: base.stock == null || base.stock === 0 ? "" : String(base.stock) });
    stock.addEventListener("change", () => { stockQty.hidden = stock.value !== "count"; }); stockQty.hidden = stock.value !== "count";
    const selectedCats = new Set(Array.isArray(base.categories) ? base.categories : []);
    const catChecks = h("div", { class: "check-list" }, cats.map(c => { const input = h("input", { type: "checkbox", checked: selectedCats.has(c.slug) }); input.addEventListener("change", () => input.checked ? selectedCats.add(c.slug) : selectedCats.delete(c.slug)); return h("label", { class: "check-row" }, input, h("span", { text: c.name || c.label })); }));
    const variants = Array.isArray(base.variants) ? base.variants.map(v => Object.assign({}, v, { options: (Array.isArray(v.options) ? v.options : []).map(o => typeof o === "string" ? { name: o } : Object.assign({}, o)) })) : [];
    const variantsBox = h("div", { class: "detail-list" });
    function paintVariants() {
      variantsBox.replaceChildren(...variants.map((v, vi) => {
        const name = h("input", { id: uid("vname"), type: "text", value: v.name || "", maxlength: 120 });
        const type = h("select", { id: uid("vtype"), value: v.type || "option" }, h("option", { value: "option", text: "Una opción" }), h("option", { value: "price_select", text: "Precio por opción" }), h("option", { value: "distribute", text: "Elige hasta N" }));
        const pick = h("input", { id: uid("vpick"), type: "number", min: "0", max: "50", value: String(v.pick || 0) });
        const free = h("input", { id: uid("vfree"), type: "number", min: "0", max: "50", value: String(v.free || 0) });
        const item = h("input", { id: uid("vitem"), type: "text", maxlength: "120", value: v.item || "", placeholder: "Ej. bebida" });
        const optional = h("input", { type: "checkbox", checked: !!v.optional });
        const ops = h("div", {});
        const paintOps = () => { ops.replaceChildren(...v.options.map((o, oi) => {
          const on = h("input", { type: "text", value: o.name || "" });
          const op = h("input", { type: "text", inputmode: "decimal", value: o.price == null ? "" : String(o.price), placeholder: "Precio opcional" });
          on.addEventListener("input", () => { o.name = on.value; });
          op.addEventListener("input", () => { o.price = op.value; });
          return h("div", { class: "option-row" }, on, op, btn("Quitar", "link danger", () => { v.options.splice(oi, 1); paintOps(); }));
        })); };
        paintOps();
        name.addEventListener("input", () => { v.name = name.value; });
        type.addEventListener("change", () => { v.type = type.value; if (v.type === "distribute" && Number(pick.value) < 1) pick.value = "1"; });
        pick.addEventListener("input", () => { v.pick = Math.max(0, Math.min(50, Math.floor(num(pick.value)))); });
        free.addEventListener("input", () => { v.free = Math.max(0, Math.min(50, Math.floor(num(free.value)))); });
        item.addEventListener("input", () => { v.item = item.value; });
        optional.addEventListener("change", () => { v.optional = optional.checked; });
        return h("div", { class: "detail-item" }, h("div", { class: "grid2" }, field("Nombre", name), field("Tipo", type), field("Cantidad / elige hasta", pick), field("Gratis (NxM)", free), field("Nombre singular", item), switchField("Opcional", optional)), ops, btn("+ Opción", "btn ghost mini", () => { v.options.push({ name: "" }); paintOps(); }), btn("Quitar variante", "link danger", () => { variants.splice(vi, 1); paintVariants(); }));
      }));
    }
    paintVariants();
    const assignedGroups = new Map((Array.isArray(base.groups) ? base.groups : []).map(g => [g.group_id, g]));
    const groupChecks = h("div", { class: "check-list" }, (catalog.variant_groups || []).map(g => { const input = h("input", { type: "checkbox", checked: assignedGroups.has(g.id) }); const override = h("input", { type: "number", min: "1", value: assignedGroups.get(g.id)?.pick_override == null ? "" : String(assignedGroups.get(g.id).pick_override), placeholder: "Por defecto" }); override.hidden = g.type !== "distribute"; input.addEventListener("change", () => input.checked ? assignedGroups.set(g.id, { group_id: g.id, pick_override: null }) : assignedGroups.delete(g.id)); override.addEventListener("input", () => { const x = assignedGroups.get(g.id); if (x) x.pick_override = override.value === "" ? null : Math.max(1, Math.floor(num(override.value))); }); return h("div", { class: "check-row" }, input, h("span", { text: g.name }), override); }));
    const sku = h("input", { id: uid("psku"), type: "text", value: base.sku || "", placeholder: "0,1,2" });
    const imagesBox = h("div", { class: "image-list" });
    function paintImages() {
      const cards = images.map((url, i) => h("div", { class: "image-item" },
        h("img", { src: safeUrl(url), alt: "" }),
        h("div", { class: "actions" },
          btn("←", "btn mini", () => { if (i) { [images[i - 1], images[i]] = [images[i], images[i - 1]]; paintImages(); } }),
          btn("→", "btn mini", () => { if (i < images.length - 1) { [images[i + 1], images[i]] = [images[i], images[i + 1]]; paintImages(); } }),
          btn("Quitar", "link danger", () => { images.splice(i, 1); paintImages(); }))));
      if (images.length < 5) cards.push(photoPicker("Agregar foto", "", url => { if (url) { images.push(url); paintImages(); } }, false).node);
      imagesBox.replaceChildren(...cards);
    }
    paintImages();
    const err = h("p", { class: "err", role: "alert" });
    const save = h("button", { type: "submit", class: "btn primary" }, isNew ? "Crear producto" : "Guardar cambios");
    const form = h("form", { novalidate: true, class: "card" },
      sectioned([
        ["info", "Información", "Lo que ve tu cliente en el menú.", field("Nombre", nombre), h("div", { class: "switches" }, switchField("Producto activo", active), switchField("Visible en el menú", visible)), field("Descripción", desc)],
        ["photos", "Fotos", "Hasta cinco fotos; cambia su orden con las flechas.", imagesBox],
        ["price", "Precio", "Puedes escribir precios con coma o punto.", h("div", { class: "grid2" }, field("Precio", precio), field("Precio promo (opcional)", promo), field("Envase", packaging))],
        ["categories", "Categorías", "Un producto puede aparecer en varias categorías.", catChecks],
        ["stock", "Stock", "Elige disponibilidad o una cantidad concreta.", h("div", { class: "grid2" }, field("Disponibilidad", stock), field("Cantidad", stockQty))],
        ["variants", "Variantes propias", "Opciones exclusivas de este producto.", variantsBox, btn("+ Variante", "btn small", () => { variants.push({ name: "", type: "option", options: [], pick: 0, optional: false, item: "" }); paintVariants(); })],
        ["groups", "Grupos reutilizables", "Se agregan después de las variantes propias.", groupChecks],
        ...( (base.type || presetType) === "promocion" ? [["days", "Días", "Vacío significa todos los días. Usa 0 para domingo y 6 para sábado.", field("Días activos", sku)]] : []),
      ]),
      h("div", { class: "form-actions" },
        btn("Cancelar", "btn ghost", paintProducts),
        save),
      err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      const name = nombre.value.trim();
      const price = priceValue(precio.value);
      const promoRaw = String(promo.value || "").trim();
      const promoVal = promoRaw ? priceValue(promoRaw) : null;
      if (!name) { err.textContent = "Escribe el nombre del producto."; return; }
      if (price == null) { err.textContent = "Escribe un precio válido."; return; }
      if (promoRaw && promoVal == null) { err.textContent = "El precio promo no es válido."; return; }
      if (variants.some(v => !String(v.name || "").trim() || !v.options.length || v.options.some(o => !String(o.name || "").trim()))) { err.textContent = "Completa el nombre y las opciones de cada variante."; return; }
      const selectedStock = stock.value === "unlimited" ? null : stock.value === "out" ? 0 : Math.max(0, Math.floor(num(stockQty.value)));
      const body = Object.assign({}, base, { name, type: base.type || presetType || "producto", price: price.toFixed(2), promo_price: promoVal == null ? "" : promoVal.toFixed(2), description: desc.value.trim(), packaging_id: packaging.value || null, packaging_cost: Number(base.packaging_cost) || 0, categories: [...selectedCats], images: images.filter(Boolean).slice(0, 5), stock: selectedStock, active: active.checked, catalog_visible: visible.checked, variants: variants.map(v => Object.assign({}, v, { name: String(v.name).trim(), pick: v.type === "distribute" ? Math.max(1, Number(v.pick) || 1) : Math.max(0, Number(v.pick) || 0), free: Math.max(0, Number(v.free) || 0), item: String(v.item || "").trim(), options: v.options.map(o => { const next = Object.assign({}, o, { name: String(o.name).trim() }); const optionPrice = priceValue(o.price); if (optionPrice == null) delete next.price; else { next.price = optionPrice; delete next.price_delta; } return next; }) })), groups: [...assignedGroups.values()], sku: sku.value.trim() });
      save.disabled = true;
      save.textContent = "Guardando…";
      const r = isNew
        ? await catalogApi("products", body)
        : await catalogApi("products/" + encodeURIComponent(base.id), body, "PUT");
      save.disabled = false;
      save.textContent = isNew ? "Crear producto" : "Guardar cambios";
      if (r.status === 409) return productsScreen();
      if (r.status === 201 || r.status === 200) {
        toast(isNew ? "Producto creado." : "Producto actualizado.");
        return productsScreen();
      }
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      err.textContent = errMsg(r, "No pudimos guardar el producto.");
    });
    V.replaceChildren(h("section", { class: "screen" },
      btn("← Productos", "back", productsScreen),
        h("div", { class: "page-head" }, h("h1", { text: isNew ? "Nuevo producto" : (base.name || base.nombre || "Editar producto") })),
      form));
    nombre.focus();
  }

  function categoriesScreen() {
    let order = cats.slice(), dragging = null;
    const list = h("div", { class: "table" });
    const saveOrder = async () => { const r = await catalogApi("categories", { slugs: order.map(c => c.slug) }, "PUT"); if (r.status === 409) return productsScreen(); if (r.status === 200) { cats = Array.isArray(r.data) ? r.data : order; toast("Orden de categorías actualizado."); paint(); } else toast(errMsg(r, "No pudimos ordenar las categorías."), true); };
    const move = (i, n) => { if (n < 0 || n >= order.length) return; [order[i], order[n]] = [order[n], order[i]]; paint(); saveOrder(); };
    const paint = () => { list.replaceChildren(h("div", { class: "thead" }, h("span"), h("span", { text: "Categoría" }), h("span", { text: "Slug" }), h("span")), ...order.map((c, i) => { const row = h("div", { class: "catalog-row", "data-slug": c.slug }, h("span", { class: "handle", text: "⋮⋮", tabindex: "0", role: "button", "aria-label": "Mover " + c.name }), h("strong", { text: c.name || c.label }), h("span", { class: "prod-note", text: c.slug }), h("div", { class: "prod-actions" }, btn("Editar", "link", () => categoryForm(c)), btn("↑", "link", () => move(i, i - 1)), btn("↓", "link", () => move(i, i + 1)), btn("Eliminar", "link danger", () => removeCategory(c)))); const handle = row.querySelector(".handle"); handle.addEventListener("keydown", e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); move(i, i + (e.key === "ArrowUp" ? -1 : 1)); } }); handle.addEventListener("pointerdown", e => { dragging = c.slug; handle.setPointerCapture(e.pointerId); row.classList.add("dragging"); }); handle.addEventListener("pointermove", e => { if (!dragging) return; const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-slug]"); const j = order.findIndex(x => x.slug === target?.dataset.slug), from = order.findIndex(x => x.slug === dragging); if (j >= 0 && from >= 0 && j !== from) { const [x] = order.splice(from, 1); order.splice(j, 0, x); paint(); } }); handle.addEventListener("pointerup", () => { if (dragging) { dragging = null; saveOrder(); } }); return row; })); };
    paint(); V.replaceChildren(h("section", { class: "screen" }, h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Productos" }), h("p", { class: "muted small", text: "Ordena las categorías y administra sus nombres." })), btn("+ Nueva categoría", "btn primary small", () => categoryForm(null))), catalogTabs("categories"), list));
  }
  function categoryForm(c) { const input = h("input", { id: uid("cat"), value: c?.name || "", maxlength: "120" }), err = h("p", { class: "err" }); const form = h("form", { class: "card" }, field("Nombre", input), h("div", { class: "form-actions" }, btn("Cancelar", "btn ghost", categoriesScreen), h("button", { class: "btn primary", type: "submit" }, c ? "Guardar categoría" : "Crear categoría")), err); form.addEventListener("submit", async e => { e.preventDefault(); if (!input.value.trim()) { err.textContent = "Escribe un nombre."; return; } const r = await catalogApi(c ? "categories/" + encodeURIComponent(c.slug) : "categories", { name: input.value.trim() }, c ? "PUT" : "POST"); if (r.status === 409) return productsScreen(); if (r.status === 200 || r.status === 201) { toast(c ? "Categoría actualizada." : "Categoría creada."); return productsScreen(); } err.textContent = errMsg(r, "No pudimos guardar la categoría."); }); V.replaceChildren(h("section", { class: "screen" }, btn("← Categorías", "back", categoriesScreen), h("div", { class: "page-head" }, h("h1", { text: c ? "Editar categoría" : "Nueva categoría" })), form)); input.focus(); }
  async function removeCategory(c) { if (!confirm('¿Eliminar "' + (c.name || c.slug) + '"? Se quitará de sus productos.')) return; const r = await catalogApi("categories/" + encodeURIComponent(c.slug), {}, "DELETE"); if (r.status === 409) return productsScreen(); if (r.status === 204) { toast("Categoría eliminada."); return productsScreen(); } toast(errMsg(r, "No pudimos eliminar la categoría."), true); }

  async function variantsScreen() { const r = await loadCatalog(); if (r.status !== 200) return failView(errMsg(r, "No pudimos cargar las variantes."), variantsScreen); const groups = catalog.variant_groups || []; const rows = groups.length ? groups.map(g => h("div", { class: "prod" }, h("strong", { text: g.name }), h("span", { class: "prod-cat", text: g.type === "distribute" ? "Elige hasta " + g.pick : g.type === "price_select" ? "Con precio" : "Una opción" }), h("span", { text: String((g.options || []).length) }), h("span", { text: String((g.product_ids || []).length) }), h("div", { class: "prod-actions" }, btn("Editar", "link", () => variantForm(g)), btn("Eliminar", "link danger", () => removeVariant(g))))) : [h("p", { class: "empty", text: "Aún no hay grupos reutilizables." })]; const list = h("div", { class: "table" }, h("div", { class: "thead" }, h("span", { text: "Grupo" }), h("span", { text: "Tipo" }), h("span", { text: "Opciones" }), h("span", { text: "Productos" }), h("span")), rows); V.replaceChildren(h("section", { class: "screen" }, h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Variantes" }), h("p", { class: "muted small", text: "Crea una vez y asigna a varios productos." })), btn("+ Nuevo grupo", "btn primary small", () => variantForm(null))), list)); }
  function variantForm(group) {
    const g = Object.assign({ name: "", type: "option", options: [], pick: 1, optional: false, item: "", product_ids: [] }, group || {});
    g.options = (g.options || []).map(o => typeof o === "string" ? { name: o } : Object.assign({}, o));
    const name = h("input", { id: uid("gname"), value: g.name, maxlength: "120" });
    const type = h("select", { id: uid("gtype"), value: g.type }, h("option", { value: "option", text: "Una opción" }), h("option", { value: "price_select", text: "Con precio por opción" }), h("option", { value: "distribute", text: "Elige hasta N" }));
    const pick = h("input", { id: uid("gpick"), type: "number", min: "1", max: "50", value: String(g.pick || 1) });
    const item = h("input", { id: uid("gitem"), type: "text", maxlength: "120", value: g.item || "", placeholder: "Ej. salsa" });
    const optional = h("input", { id: uid("goptional"), type: "checkbox", checked: !!g.optional });
    const ops = h("div", { class: "detail-list" }), products = new Set(g.product_ids || []), checks = h("div", { class: "check-list" });
    const paintOps = () => ops.replaceChildren(...g.options.map((o, i) => {
      const n = h("input", { type: "text", value: o.name || "" }), p = h("input", { type: "text", inputmode: "decimal", value: o.price == null ? "" : String(o.price), placeholder: "Precio opcional" });
      n.addEventListener("input", () => { o.name = n.value; });
      p.addEventListener("input", () => { o.price = p.value; });
      return h("div", { class: "option-row" }, n, p, btn("Quitar", "link danger", () => { g.options.splice(i, 1); paintOps(); }));
    }));
    const paintProducts = () => checks.replaceChildren(...prods.map(p => { const x = h("input", { type: "checkbox", checked: products.has(p.id) }); x.addEventListener("change", () => x.checked ? products.add(p.id) : products.delete(p.id)); return h("label", { class: "check-row" }, x, h("span", { text: productName(p) })); }));
    paintOps(); paintProducts();
    const searchBox = h("input", { type: "search", placeholder: "Buscar producto" });
    searchBox.addEventListener("input", () => { const q = norm(searchBox.value); [...checks.children].forEach((row, i) => { row.hidden = !!q && !norm(productName(prods[i])).includes(q); }); });
    const err = h("p", { class: "err" }), form = h("form", { class: "card" }, sectioned([["general", "General", "Define cómo el cliente elige.", field("Nombre", name), h("div", { class: "grid2" }, field("Tipo", type), field("Elige hasta", pick), field("Nombre singular", item)), switchField("Opcional", optional)], ["options", "Opciones", "Agrega al menos una opción.", ops, btn("+ Opción", "btn small", () => { g.options.push({ name: "" }); paintOps(); })], ["products", "Productos asignados", "Selecciona dónde aparece este grupo.", searchBox, checks]]), h("div", { class: "form-actions" }, btn("Cancelar", "btn ghost", variantsScreen), h("button", { class: "btn primary", type: "submit" }, "Guardar grupo")), err);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (!name.value.trim() || !g.options.length || g.options.some(o => !String(o.name || "").trim())) { err.textContent = "Completa el nombre y las opciones."; return; }
      const options = g.options.map(o => { const next = Object.assign({}, o, { name: String(o.name).trim() }); const optionPrice = priceValue(o.price); if (optionPrice == null) delete next.price; else { next.price = optionPrice; delete next.price_delta; } return next; });
      const body = { name: name.value.trim(), type: type.value, pick: type.value === "distribute" ? Math.max(1, Math.floor(num(pick.value))) : 0, optional: optional.checked, item: item.value.trim(), options, product_ids: [...products] };
      const r = await catalogApi(group ? "variant-groups/" + encodeURIComponent(group.id) : "variant-groups", body, group ? "PUT" : "POST");
      if (r.status === 409) return variantsScreen();
      if (r.status === 200 || r.status === 201) { toast("Grupo guardado."); return variantsScreen(); }
      err.textContent = errMsg(r, "No pudimos guardar el grupo.");
    });
    V.replaceChildren(h("section", { class: "screen" }, btn("← Variantes", "back", variantsScreen), h("div", { class: "page-head" }, h("h1", { text: group ? "Editar grupo" : "Nuevo grupo" })), form));
  }
  async function removeVariant(g) { if (!confirm('¿Eliminar "' + g.name + '"? Se quitará de todos los productos.')) return; const r = await catalogApi("variant-groups/" + encodeURIComponent(g.id), {}, "DELETE"); if (r.status === 409) return variantsScreen(); if (r.status === 204) { toast("Grupo eliminado."); return variantsScreen(); } toast(errMsg(r, "No pudimos eliminar el grupo."), true); }

  async function packagingsScreen() { const r = await loadCatalog(); if (r.status !== 200) return failView(errMsg(r, "No pudimos cargar los empaques."), packagingsScreen); const items = catalog.packagings || []; const rows = items.length ? items.map(x => h("div", { class: "prod" }, h("strong", { text: x.name }), h("span", { class: "prod-price", text: money(x.price) }), h("span", { text: String((x.product_ids || []).length) }), h("span"), h("div", { class: "prod-actions" }, btn("Editar", "link", () => packagingForm(x)), btn("Eliminar", "link danger", () => removePackaging(x))))) : [h("p", { class: "empty", text: "Aún no hay empaques." })]; const list = h("div", { class: "table" }, h("div", { class: "thead" }, h("span", { text: "Empaque" }), h("span", { text: "Precio" }), h("span", { text: "Productos" }), h("span"), h("span")), rows); V.replaceChildren(h("section", { class: "screen" }, h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Empaques" }), h("p", { class: "muted small", text: "El costo se suma por producto." })), btn("+ Nuevo empaque", "btn primary small", () => packagingForm(null))), list)); }
  function packagingForm(item) { const x = Object.assign({ name: "", price: 0, product_ids: [] }, item || {}), name = h("input", { id: uid("packname"), value: x.name, maxlength: "120" }), price = h("input", { id: uid("packprice"), type: "text", inputmode: "decimal", value: priceText(x.price) }), selected = new Set(x.product_ids || []), checks = h("div", { class: "check-list" }, prods.map(p => { const i = h("input", { type: "checkbox", checked: selected.has(p.id) }); i.addEventListener("change", () => i.checked ? selected.add(p.id) : selected.delete(p.id)); return h("label", { class: "check-row" }, i, h("span", { text: productName(p) })); })), err = h("p", { class: "err" }), form = h("form", { class: "card" }, sectioned([["general", "General", "El precio acepta coma o punto.", h("div", { class: "grid2" }, field("Nombre", name), field("Precio", price))], ["products", "Productos asignados", "Este empaque se aplica a los productos seleccionados.", checks]]), h("div", { class: "form-actions" }, btn("Cancelar", "btn ghost", packagingsScreen), h("button", { class: "btn primary", type: "submit" }, "Guardar empaque")), err); form.addEventListener("submit", async e => { e.preventDefault(); const p = priceValue(price.value); if (!name.value.trim() || p == null) { err.textContent = "Completa nombre y precio válido."; return; } const r = await catalogApi(item ? "packagings/" + encodeURIComponent(item.id) : "packagings", { name: name.value.trim(), price: p, product_ids: [...selected] }, item ? "PUT" : "POST"); if (r.status === 409) return packagingsScreen(); if (r.status === 200 || r.status === 201) { toast("Empaque guardado."); return packagingsScreen(); } err.textContent = errMsg(r, "No pudimos guardar el empaque."); }); V.replaceChildren(h("section", { class: "screen" }, btn("← Empaques", "back", packagingsScreen), h("div", { class: "page-head" }, h("h1", { text: item ? "Editar empaque" : "Nuevo empaque" })), form)); }
  async function removePackaging(x) { if (!confirm('¿Eliminar "' + x.name + '"? Se quitará de sus productos.')) return; const r = await catalogApi("packagings/" + encodeURIComponent(x.id), {}, "DELETE"); if (r.status === 409) return packagingsScreen(); if (r.status === 204) { toast("Empaque eliminado."); return packagingsScreen(); } toast(errMsg(r, "No pudimos eliminar el empaque."), true); }

  const ORDER_STATE = { pending: "Pendiente", confirmed: "Confirmado", paid: "Pagado", rejected: "Rechazado" };
  const ORDER_SOURCE = { web: "Web", mesa: "Mesa", mesero: "Mesero", caja: "Caja" };

  function orderCode(order) {
    const number = Number(order && order.number);
    if (Number.isInteger(number) && number > 0) return "#" + number;
    const id = String(order && order.id || "");
    return "#" + (id.slice(-4) || "—");
  }

  /* ── Órdenes POS compartidas por Pedidos y Nueva orden ── */
  function posOrderCard(order, reload, sedeName) {
    const status = POS_STATE[order.status] ? order.status : "pending";
    const items = Array.isArray(order.items) ? order.items : [];
    const summary = items.slice(0, 3).map(i => (i.qty || 1) + " × " + itemName(i)).join(" · ") + (items.length > 3 ? " +" + (items.length - 3) : "");
    const when = new Date(Number(order.created_at));
    const actions = h("div", { class: "pos-actions" });
    // El link/QR del cobro con tarjeta se pinta aquí, dentro de la misma orden.
    const bendoBox = h("div", { class: "bendo-pay" });
    // Formulario del cobro manual con datáfono (docs/DATAFONO-MANUAL.md).
    const datafonoBox = h("div", { class: "datafono-pay" });
    const run = (action, ev) => posSetStatus(order, action, ev.currentTarget, reload);
    if (order.status === "pending") {
      actions.append(btn("Confirmar", "btn small", ev => run("confirm", ev)));
      actions.append(btn("Rechazar", "btn ghost small", ev => run("reject", ev)));
    }
    if (order.status === "confirmed") {
      if (order.payment_method === "bendo" || order.payment_method === "payphone") {
        // Bendo espera su link; `payphone` solo puede ser una fila histórica.
        actions.append(h("span", { class: "hint", text: "Esperando confirmación de la tarjeta" }));
      } else {
        const transfer = order.payment_method === "transfer";
        actions.append(btn(transfer ? "Confirmar transferencia" : "Cobrar efectivo", "btn primary small",
          ev => payPosOrder(order, transfer ? "transfer" : "cash", ev.currentTarget, reload)));
        // Tarjeta (Bendo): el ensamblador expone `me.bendo`; el pago se verifica aparte.
        if (order.source !== "web" && me?.bendo === true) actions.append(btn("Cobrar con tarjeta", "btn small", ev => payBendoOrder(order, ev.currentTarget, reload, bendoBox)));
      }
      actions.append(btn("Rechazar", "btn ghost small", ev => run("reject", ev)));
    }
    // Datáfono: cobro manual para pedidos pending/confirmed de cualquier método
    // (el servidor deja el pedido en `bendo`). Con un link de tarjeta en curso el
    // propio servidor responde 409 pago_en_curso; aquí se explica sin falsearlo.
    const waitingCard = order.status === "confirmed" &&
      (order.payment_method === "bendo" || order.payment_method === "payphone");
    if ((order.status === "pending" || order.status === "confirmed") && !waitingCard)
      actions.append(btn("Cobrado con datáfono", "btn small",
        () => openDatafonoForm(order, reload, datafonoBox, bendoBox)));
    if (order.status === "paid" || order.status === "ready") {
      actions.append(btn(Number(order.print_count) ? "Reimprimir comanda" : "Imprimir comanda", "btn small",
        ev => printPosOrder(order, sedeName, ev.currentTarget, reload)));
      if (order.status === "paid") actions.append(btn("Marcar listo", "btn primary small",
        ev => readyPosOrder(order, ev.currentTarget, reload)));
      else {
        const wa = posWaLink(order, sedeName);
        if (wa) actions.append(h("a", { class: "btn primary small", href: wa, target: "_blank", rel: "noopener", text: "Avisar por WhatsApp" }));
      }
    }
    const place = sedeNameOf(order.sede_id, sedeName);
    return h("article", { class: "pos-card" },
      h("div", { class: "pos-head" },
        h("strong", { text: order.number ? "#" + order.number : "Orden" }),
        h("strong", { text: posMoney(order) })),
      h("p", { class: "pos-meta", text: [posName(order) || "Sin cliente", POS_SOURCE[order.source] || "", place, Number.isNaN(when.getTime()) ? "" : when.toLocaleString("es-EC", { dateStyle: "short", timeStyle: "short", timeZone: "America/Guayaquil" })].filter(Boolean).join(" · ") }),
      h("p", { class: "pos-meta", text: summary || "Sin ítems" }),
      h("p", { class: "pos-meta", text: "Pago: " + posPaymentLabel(order) }),
      h("span", { class: "order-state " + status, text: POS_STATE[status] }),
      order.status === "pending" ? h("p", { class: "hint", text: "Sin comanda: todavía no se envió a cocina." }) : null,
      order.status === "paid" ? h("p", { class: "hint", text: "Pago confirmado; la comanda ya está en cocina. Marca listo al entregar." }) : null,
      order.status === "ready" ? h("p", { class: "hint", text: "Listo. El aviso por WhatsApp se abre a mano; la app no envía mensajes automáticos." }) : null,
      actions,
      bendoBox,
      datafonoBox);
  }
  // Confirmar no cobra: la comanda sale solo cuando el pago queda confirmado.
  function posSetStatus(order, action, buttonEl, reload) {
    if (action === "reject" && typeof window.confirm === "function" && !window.confirm("¿Rechazar esta orden? No se enviará a cocina.")) return;
    buttonEl.disabled = true;
    return api("orders/" + encodeURIComponent(order.id) + "/" + action, {}, "POST").then(r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) {
        if (r.status === 409 || r.status === 404) { toast("Esa orden ya cambió de estado.", true); return reload(); }
        return toast(errMsg(r, "No pudimos actualizar la orden."), true);
      }
      toast(action === "confirm" ? "Confirmada. Aún falta cobrar: la comanda no salió a cocina." : "Orden rechazada.");
      reload();
    });
  }
  // Cobro POS manual: idempotente por orden. Efectivo y transferencia se
  // confirman a mano; la tarjeta usa payBendoOrder, que nunca asume el cobro.
  function payPosOrder(order, provider, buttonEl, reload) {
    const transfer = provider === "transfer";
    if (typeof window.confirm === "function" && !window.confirm(transfer
      ? "¿Verificaste la transferencia en la cuenta? La comanda se enviará a cocina."
      : "¿Confirmas que recibiste el pago en efectivo de esta orden? La comanda se enviará a cocina.")) return;
    const key = paymentKeys.get(order.id) || uuid();
    paymentKeys.set(order.id, key);
    buttonEl.disabled = true;
    const route = transfer ? "/pay-transfer" : "/pay-cash";
    return api("orders/" + encodeURIComponent(order.id) + route, { idempotency_key: key }, "POST").then(async r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      // Sin fallback silencioso: si la ruta no existe, no se registra el cobro
      // como otro método (falsearía la conciliación y el estado del pedido).
      if (transfer && (r.status === 404 || r.status === 405))
        return toast("Esta versión del panel todavía no permite confirmar transferencias. Actualiza el panel.", true);
      if (r.status !== 200) {
        if (r.status === 409) {
          // La caja cerrada bloquea el cobro manual (efectivo/transferencia):
          // el cajero debe abrir el turno de esa sede primero.
          const code = r.data && r.data.error;
          toast(code === "caja_cerrada" ? ERRORS.caja_cerrada : "Esa orden ya cambió de estado.", true);
          return reload();
        }
        return toast(errMsg(r, "No pudimos registrar el cobro."), true);
      }
      toast((transfer ? "Transferencia confirmada." : "Cobrado.") + " La comanda ya está en cocina; imprímela desde Cocina o aquí.");
      paymentKeys.delete(order.id);
      reload();
    });
  }
  // Cobro manual con datáfono: el cajero cobra primero en el terminal de Bendo y
  // aquí registra el número de autorización impreso en el voucher. El servidor
  // valida el turno abierto, la idempotencia y que no haya un link en curso;
  // esta pantalla nunca marca pagado por su cuenta.
  function openDatafonoForm(order, reload, box, bendoBox) {
    if (!box) return;
    // Un solo formulario abierto por tarjeta: el QR del link no se mezcla.
    if (bendoBox) bendoBox.replaceChildren();
    const auth = h("input", { id: uid("aut"), type: "text", maxlength: "12", autocomplete: "off", autocapitalize: "characters", spellcheck: "false" });
    const last4 = h("input", { id: uid("last4"), type: "text", inputmode: "numeric", maxlength: "4", autocomplete: "off" });
    const err = h("p", { class: "err", role: "alert" });
    const submit = h("button", { type: "submit", class: "btn primary small" }, "Registrar cobro");
    const form = h("form", { class: "cashform", "aria-label": "Cobrado con datáfono" },
      h("p", { class: "hint", text: "Cobra primero en el datáfono y copia el número de autorización del voucher." }),
      field("Número de autorización", auth),
      field("Últimos 4 dígitos (opcional)", last4),
      h("div", { class: "actions" },
        btn("Cancelar", "btn ghost small", () => box.replaceChildren()),
        submit),
      err);
    form.addEventListener("submit", ev => {
      ev.preventDefault();
      const code = String(auth.value || "").trim();
      if (!/^[A-Za-z0-9]{4,12}$/.test(code)) {
        err.textContent = ERRORS.autorizacion_invalida;
        if (auth.focus) auth.focus();
        return;
      }
      const digits = String(last4.value || "").replace(/\s+/g, "");
      if (digits && !/^[0-9]{4}$/.test(digits)) {
        err.textContent = ERRORS.tarjeta_invalida;
        if (last4.focus) last4.focus();
        return;
      }
      submit.disabled = true;
      payDatafonoOrder(order, code, digits, err, reload, box).finally(() => { submit.disabled = false; });
    });
    box.replaceChildren(form);
    if (auth.focus) auth.focus();
  }
  function payDatafonoOrder(order, code, digits, errorEl, reload, box) {
    // Reintentar con el mismo cuerpo reutiliza la clave; cambiarla al corregir
    // la autorización evita el 409 idempotencia_conflicto.
    const base = { authorization_code: code };
    if (digits) base.card_last4 = digits;
    const fingerprint = JSON.stringify(base);
    const saved = datafonoKeys.get(order.id);
    const key = saved && saved.fingerprint === fingerprint ? saved.key : uuid();
    datafonoKeys.set(order.id, { key, fingerprint });
    const body = Object.assign({ idempotency_key: key }, base);
    return api("orders/" + encodeURIComponent(order.id) + "/pay-datafono", body, "POST").then(r => {
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 404 || r.status === 405)
        return toast("Esta versión del panel todavía no permite cobrar con datáfono. Actualiza el panel.", true);
      if (r.status === 400) {
        errorEl.textContent = errMsg(r, "Revisa el número de autorización y los últimos 4 dígitos.");
        return;
      }
      if (r.status === 409) {
        const code409 = r.data && r.data.error;
        datafonoKeys.delete(order.id);
        if (box) box.replaceChildren();
        toast(code409 === "caja_cerrada" ? ERRORS.caja_cerrada
          : code409 === "pago_en_curso" ? ERRORS.pago_en_curso
          : code409 === "orden_ya_pagada" ? ERRORS.orden_ya_pagada
          : code409 === "idempotencia_conflicto" ? ERRORS.idempotencia_conflicto
          : "Esa orden ya cambió de estado.", true);
        return reload();
      }
      if (r.status !== 200) {
        errorEl.textContent = errMsg(r, "No pudimos registrar el cobro con datáfono.");
        return;
      }
      datafonoKeys.delete(order.id);
      if (box) box.replaceChildren();
      toast("Cobrado con datáfono. La comanda ya está en cocina; imprímela desde Cocina o aquí.");
      reload();
    });
  }
  // Cobro con tarjeta (Bendo): el panel genera un link de pago y lo muestra como
  // QR y enlace copiable. NUNCA marca pagado por sí solo: el operador pulsa
  // "Verificar pago" y el servidor reconsulta el link en la pasarela.
  function payBendoOrder(order, buttonEl, reload, box) {
    if (typeof window.confirm === "function" && !window.confirm(
      "¿Generar el cobro con tarjeta para esta orden? La comanda sale solo cuando el banco confirme el pago.")) return;
    const key = paymentKeys.get(order.id) || uuid();
    paymentKeys.set(order.id, key);
    buttonEl.disabled = true;
    return api("orders/" + encodeURIComponent(order.id) + "/bendo", { idempotency_key: key }, "POST").then(r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 404 || r.status === 405)
        return toast("Esta versión del panel todavía no permite cobrar con tarjeta. Actualiza el panel.", true);
      if (r.status === 409) { toast("Esa orden ya cambió de estado.", true); return reload(); }
      if (r.status === 200 && r.data?.status === "paid") {
        paymentKeys.delete(order.id);
        toast("Pago confirmado. La comanda ya está en cocina.");
        return reload();
      }
      const url = safeUrl(r.data?.payment_url), ref = String(r.data?.payment_id || "");
      if (r.status !== 200 || !url || !ref) return toast(errMsg(r, "No pudimos generar el link de cobro."), true);
      showBendoLink(box, order, url, ref, reload);
      toast("Link de cobro generado. Escanéalo o compártelo; pulsa \"Verificar pago\" al terminar.");
    });
  }
  function showBendoLink(box, order, url, ref, reload) {
    if (!box) return;
    const cv = h("canvas", { role: "img", "aria-label": "QR para pagar la orden " + orderCode(order) });
    // El QR es una comodidad: si el navegador no puede dibujarlo queda el enlace.
    try { drawQR(cv, url, false); } catch { cv.hidden = true; }
    const input = h("input", { class: "url", type: "text", readonly: true, value: url, "aria-label": "Enlace de pago" });
    box.replaceChildren(h("div", { class: "qr-item", role: "dialog", "aria-label": "Cobro con tarjeta" },
      h("strong", { text: "Cobro con tarjeta" }),
      cv,
      input,
      h("div", { class: "actions" },
        btn("Copiar enlace", "btn small", () => copyBendoLink(url, input)),
        btn("Verificar pago", "btn primary small", ev => verifyBendoPayment(order, ref, ev.currentTarget, reload))),
      h("p", { class: "hint", text: "El cliente paga en el link. La comanda sale solo cuando la pasarela confirme: pulsa \"Verificar pago\"." })));
  }
  function copyBendoLink(text, input) {
    const fallback = () => { try { input.focus(); input.select(); } catch {} toast("Copia el enlace para compartirlo.", true); };
    try {
      const nav = window.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
        nav.clipboard.writeText(text).then(() => toast("Enlace copiado.")).catch(fallback);
        return;
      }
    } catch { /* sin portapapeles: se ofrece seleccionar el enlace */ }
    fallback();
  }
  function verifyBendoPayment(order, ref, buttonEl, reload) {
    buttonEl.disabled = true;
    return api("payments/" + encodeURIComponent(ref) + "/reconcile", {}, "POST").then(r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 404 || r.status === 405)
        return toast("Esta versión del panel todavía no permite verificar pagos con tarjeta.", true);
      const status = r.data && r.data.status;
      if (r.status === 200 && status === "aprobado") {
        paymentKeys.delete(order.id);
        toast("Pago aprobado. La comanda ya está en cocina.");
        return reload();
      }
      if (r.status === 200 && status === "rechazado") {
        paymentKeys.delete(order.id);
        toast("La tarjeta no aprobó el pago. La comanda no salió a cocina.", true);
        return reload();
      }
      if (r.status === 200) return toast("El pago sigue pendiente en la pasarela. Espera un momento y verifica de nuevo.");
      return toast(errMsg(r, "No pudimos verificar el pago."), true);
    });
  }
  // paid → ready: solo el operador autorizado; el servidor pone la marca de tiempo.
  function readyPosOrder(order, buttonEl, reload) {
    if (typeof window.confirm === "function" && !window.confirm("¿Marcar esta orden como lista para avisar al cliente?")) return;
    buttonEl.disabled = true;
    return api("orders/" + encodeURIComponent(order.id) + "/ready", {}, "POST").then(r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 404 || r.status === 405) return toast("Esta versión del panel todavía no permite marcar listo.", true);
      if (r.status === 409) { toast("Esa orden ya cambió de estado.", true); return reload(); }
      if (r.status !== 200) return toast(errMsg(r, "No pudimos marcar la orden como lista."), true);
      toast("Orden lista. Abre el enlace de WhatsApp para avisar al cliente.");
      reload();
    });
  }
  function paperWidth() {
    try { return localStorage.getItem("panel.paperWidth") === "58" ? 58 : 80; } catch { return 80; }
  }
  // Comanda térmica desde esta PC/estación. Devuelve true solo si el navegador
  // abrió su diálogo; el acuse se registra después y nunca afirma papel impreso.
  function printPosTicket(order, sedeName) {
    const paper = paperWidth();
    const width = typeof columnsFn === "function" ? columnsFn(paper) : 32;
    const printable = Object.assign({}, order, {
      sede_nombre: sedeNameOf(order.sede_id, sedeName),
      items: (Array.isArray(order.items) ? order.items : []).map(item => Object.assign({}, item, {
        nombre: itemName(item),
        variant: [item.variant_id, item.note ? "Nota: " + item.note : ""].filter(Boolean).join(" · "),
      })),
    });
    const lines = typeof ticketFn === "function"
      ? ticketFn(printable, { store: me?.store?.store_name || me?.store?.name || "", width })
      : ["COMANDA " + orderCode(order)];
    const height = typeof heightFn === "function" ? heightFn(lines.length) : Math.max(50, lines.length * 4 + 8);
    const style = document.createElement("style");
    style.textContent = "@page{size:" + paper + "mm " + height + "mm;margin:3mm}";
    const pre = document.createElement("pre");
    pre.className = "print-ticket";
    pre.textContent = lines.join("\n");
    document.body.append(style, pre);
    let opened = false;
    try { window.print(); opened = true; } catch { opened = false; }
    window.setTimeout(() => { pre.remove(); style.remove(); }, 1000);
    return opened;
  }
  function printPosOrder(order, sedeName, buttonEl, reload) {
    if (Number(order.print_count) && typeof window.confirm === "function" &&
      !window.confirm("Esta comanda ya tiene " + Number(order.print_count) + " acuse(s) de impresión. ¿Reimprimir?")) return;
    buttonEl.disabled = true;
    const opened = printPosTicket(Object.assign({}, order, { print_count: (Number(order.print_count) || 0) + 1 }), sedeName);
    if (!opened) {
      buttonEl.disabled = false;
      return toast("No pudimos abrir la impresión. No se registró acuse.", true);
    }
    return api("kitchen/orders/" + encodeURIComponent(order.id) + "/print", { idempotency_key: uuid() }, "POST").then(r => {
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) return toast("La impresión se abrió, pero no pudimos registrar el acuse. Revisa el papel.", true);
      const count = Number(r.data?.print_count);
      if (Number.isFinite(count)) order.print_count = count;
      toast("Acuse registrado. Revisa la comanda en la impresora; la app no confirma el papel.");
      reload();
    });
  }

  /* ── Caja: turno compartido con el cajero ────────────────────────────────
     Misma semántica que el modo mesero: abrir con fondo inicial, registrar
     ingresos/retiros y cerrar con arqueo ciego. La diferencia (contado −
     esperado) se muestra recién al cerrar. Montos en centavos enteros. */
  const centsText = v => money((Number(v) || 0) / 100);
  const guayaquil = ts => {
    const d = new Date(Number(ts) - 5 * 60 * 60 * 1000);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const two = n => String(n).padStart(2, "0");
  const shiftClock = ts => {
    const d = guayaquil(ts);
    return d ? two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) : "—";
  };
  const shiftStamp = ts => {
    const d = guayaquil(ts);
    return d ? two(d.getUTCDate()) + "/" + two(d.getUTCMonth() + 1) + " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) : "—";
  };
  const centsFromInput = value => {
    const amount = priceValue(value);
    return amount == null ? null : Math.round(amount * 100);
  };
  const shiftKey = scope => {
    if (!shiftKeys.has(scope)) shiftKeys.set(scope, uuid());
    return shiftKeys.get(scope);
  };
  const SHIFT_STATUS = { open: "Abierta", closed: "Cerrada" };

  // Barra de estado de caja de una sede: el dueño abre, mueve efectivo y cierra.
  // `sedes` y `sedeNames` salen de /panel/api/sedes; la API de turnos todavía
  // puede no existir en esta rama (404) y entonces la barra lo dice sin inventar.
  function cashBar(sedes, sedeNames) {
    const wrap = h("div", { class: "cash-wrap" });
    const bar = h("div", { class: "cashbar", role: "group", "aria-label": "Estado de la caja" });
    const extra = h("div");
    wrap.append(bar, extra);
    const state = { shift: null, report: null, panel: "", loaded: false, unavailable: false };
    const list = (Array.isArray(sedes) ? sedes : []).filter(s => s && s.id);
    const selectId = uid("cashsede");
    const select = h("select", { id: selectId, "aria-label": "Sede de la caja" },
      ...list.map(s => h("option", { value: String(s.id), text: String(s.nombre || s.id) })));
    const remembered = list.some(s => String(s.id) === shiftSede) ? shiftSede : (list[0] ? String(list[0].id) : "");
    select.value = remembered;
    shiftSede = remembered;
    select.addEventListener("change", () => {
      shiftSede = select.value;
      state.shift = null; state.report = null; state.panel = ""; state.loaded = false;
      paint();
      load();
    });
    const place = () => sedeNameOf(select.value, id => sedeNames.get(id));

    async function load() {
      if (!select.value) { state.loaded = true; paint(); return; }
      const r = await api("turnos/actual?sede_id=" + encodeURIComponent(select.value));
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      state.loaded = true;
      state.unavailable = r.status === 404 || r.status === 405;
      if (state.unavailable) return paint();
      if (r.status !== 200) {
        state.shift = null;
        state.report = null;
        return paint(errMsg(r, "No pudimos consultar la caja."));
      }
      state.shift = r.data && r.data.shift ? r.data.shift : null;
      state.report = r.data && r.data.report && typeof r.data.report === "object" ? r.data.report : null;
      paint();
    }

    function paint(errorText) {
      const shift = state.shift;
      const parts = [h("div", { class: "cash-id" },
        h("strong", { text: "Caja · " + (place() || "sede") }), select)];
      if (state.unavailable) {
        parts.push(h("p", { class: "hint", text: "Esta versión del panel todavía no incluye turnos de caja." }));
        bar.replaceChildren(...parts);
        extra.replaceChildren();
        return;
      }
      if (!list.length) {
        parts.push(h("p", { class: "hint", text: "No hay sedes configuradas." }));
        bar.replaceChildren(...parts);
        extra.replaceChildren();
        return;
      }
      if (!state.loaded) {
        parts.push(h("p", { class: "hint", text: "Consultando la caja…" }));
        bar.replaceChildren(...parts);
        extra.replaceChildren();
        return;
      }
      if (!shift) {
        parts.push(h("span", { class: "cash-state cerrada", text: "Cerrada" }));
        parts.push(btn("Abrir caja", "btn primary small", () => { state.panel = state.panel === "abrir" ? "" : "abrir"; paint(); }));
        if (state.panel === "abrir") parts.push(openForm());
      } else {
        parts.push(h("span", { class: "cash-state abierta", text: "Caja abierta desde " + shiftClock(shift.opened_at) }));
        parts.push(h("p", { class: "hint", text: "Fondo inicial " + centsText(shift.opening_float_cents) +
          (state.report ? " · Ventas " + centsText(state.report.sales_total_cents) + " · Esperado en caja " + centsText(state.report.expected_cash_cents) : "") }));
        parts.push(btn("Ingreso de efectivo", "btn small", () => { state.panel = state.panel === "in" ? "" : "in"; paint(); }));
        parts.push(btn("Retiro de efectivo", "btn small", () => { state.panel = state.panel === "out" ? "" : "out"; paint(); }));
        parts.push(btn("Cerrar caja", "btn primary small", () => { state.panel = state.panel === "cerrar" ? "" : "cerrar"; paint(); }));
        if (state.panel === "in") parts.push(movementForm("in", shift));
        if (state.panel === "out") parts.push(movementForm("out", shift));
        if (state.panel === "cerrar") parts.push(closeForm(shift));
      }
      if (errorText) parts.push(h("p", { class: "err", role: "alert", text: errorText }));
      bar.replaceChildren(...parts);
      extra.replaceChildren(...(state.report && state.report.status === "closed" ? [reportCard(state.report, place())] : []));
    }

    function openForm() {
      const amount = h("input", { type: "text", inputmode: "decimal", placeholder: "20.00", "aria-label": "Fondo inicial" });
      const err = h("p", { class: "err", role: "alert" });
      const submit = btn("Abrir caja", "btn primary small", async () => {
        const opening = centsFromInput(amount.value);
        if (opening == null || opening < 0) { err.textContent = "Escribe el fondo inicial (ej. 20.00)."; return; }
        submit.disabled = true;
        const scope = "abrir:" + select.value;
        const r = await api("turnos/abrir", { sede_id: select.value, opening_float_cents: opening, idempotency_key: shiftKey(scope) });
        submit.disabled = false;
        if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
        if (r.status === 200 || r.status === 201) {
          shiftKeys.delete(scope);
          state.panel = "";
          toast("Caja abierta con fondo de " + centsText(opening) + ".");
          return load();
        }
        if (r.status === 409) {
          toast(ERRORS.caja_ya_abierta, true);
          state.panel = "";
          return load();
        }
        err.textContent = errMsg(r, "No pudimos abrir la caja.");
      });
      return h("div", { class: "cashform" },
        field("Fondo inicial", amount, "Efectivo con el que arranca el turno."),
        h("div", { class: "actions" }, btn("Cancelar", "btn ghost small", () => { state.panel = ""; paint(); }), submit), err);
    }

    function movementForm(kind, shift) {
      const amount = h("input", { type: "text", inputmode: "decimal", placeholder: "0.00", "aria-label": kind === "in" ? "Monto del ingreso" : "Monto del retiro" });
      const reason = h("input", { type: "text", maxlength: "120", placeholder: "Motivo (3 a 120 caracteres)", "aria-label": "Motivo del movimiento" });
      const err = h("p", { class: "err", role: "alert" });
      const submit = btn(kind === "in" ? "Registrar ingreso" : "Registrar retiro", "btn primary small", async () => {
        const amountCents = centsFromInput(amount.value);
        const text = String(reason.value || "").trim();
        if (amountCents == null || amountCents <= 0) { err.textContent = "Escribe un monto mayor a cero."; return; }
        if (text.length < 3 || text.length > 120) { err.textContent = "Escribe un motivo de 3 a 120 caracteres."; return; }
        submit.disabled = true;
        const scope = "mov:" + shift.id;
        const r = await api("turnos/" + encodeURIComponent(shift.id) + "/movimientos", { kind, amount_cents: amountCents, reason: text, idempotency_key: shiftKey(scope) });
        submit.disabled = false;
        if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
        if (r.status === 200 || r.status === 201) {
          shiftKeys.delete(scope);
          state.panel = "";
          toast((kind === "in" ? "Ingreso" : "Retiro") + " de " + centsText(amountCents) + " registrado.");
          return load();
        }
        if (r.status === 409) { toast(ERRORS.turno_cerrado, true); state.panel = ""; return load(); }
        err.textContent = errMsg(r, "No pudimos registrar el movimiento.");
      });
      return h("div", { class: "cashform" },
        field(kind === "in" ? "Monto del ingreso" : "Monto del retiro", amount),
        field("Motivo", reason, "Ej. Cambio adicional, depósito al banco, pago a proveedor."),
        h("div", { class: "actions" }, btn("Cancelar", "btn ghost small", () => { state.panel = ""; paint(); }), submit), err);
    }

    function closeForm(shift) {
      const counted = h("input", { type: "text", inputmode: "decimal", placeholder: "0.00", "aria-label": "Efectivo contado" });
      const note = h("input", { type: "text", maxlength: "200", placeholder: "Opcional", "aria-label": "Nota del cierre" });
      const err = h("p", { class: "err", role: "alert" });
      const submit = btn("Cerrar caja", "btn primary small", async () => {
        const countedCents = centsFromInput(counted.value);
        if (countedCents == null || countedCents < 0) { err.textContent = "Escribe el efectivo contado."; return; }
        const scope = "cerrar:" + shift.id;
        const body = { counted_cash_cents: countedCents, idempotency_key: shiftKey(scope) };
        const text = String(note.value || "").trim();
        if (text) body.note = text;
        submit.disabled = true;
        const r = await api("turnos/" + encodeURIComponent(shift.id) + "/cerrar", body);
        submit.disabled = false;
        if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
        if (r.status === 200 && r.data && r.data.report) {
          shiftKeys.delete(scope);
          state.shift = null; state.panel = ""; state.report = r.data.report;
          paint();
          const difference = Number(r.data.report.difference_cents) || 0;
          return toast("Caja cerrada. Diferencia: " + centsText(difference) +
            (difference < 0 ? " (faltante)." : difference > 0 ? " (sobrante)." : " (cuadra)."), difference !== 0);
        }
        if (r.status === 409) { toast(ERRORS.turno_cerrado, true); state.panel = ""; return load(); }
        err.textContent = errMsg(r, "No pudimos cerrar la caja.");
      });
      return h("div", { class: "cashform" },
        field("Efectivo contado", counted, "Arqueo ciego: cuenta el efectivo sin mirar el esperado; la diferencia aparece al cerrar."),
        field("Nota (opcional)", note),
        h("div", { class: "actions" }, btn("Cancelar", "btn ghost small", () => { state.panel = ""; paint(); }), submit), err);
    }

    paint();
    load();
    return wrap;
  }

  // Reporte de un turno: ventas por método, movimientos, arqueo y reimpresión.
  function reportCard(report, place) {
    const sales = Array.isArray(report.sales) ? report.sales : [];
    const movements = report.movements && typeof report.movements === "object" ? report.movements : {};
    const items = Array.isArray(movements.items) ? movements.items : [];
    const pending = report.pending_payments && typeof report.pending_payments === "object" ? report.pending_payments : {};
    const orders = report.orders && typeof report.orders === "object" ? report.orders : {};
    const difference = Number(report.difference_cents) || 0;
    const closed = report.status === "closed";
    return h("section", { class: "card" },
      h("div", { class: "page-head" }, h("div", {},
        h("h2", { text: "Cierre de caja · " + (place || String(report.sede_id || "")) }),
        h("p", { class: "muted small", text: (closed ? "Cerrado" : "Abierto") + " · apertura " + shiftStamp(report.opened_at) + (closed ? " · cierre " + shiftStamp(report.closed_at) : "") }))),
      h("div", { class: "kpis" },
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: centsText(report.expected_cash_cents) }), h("span", { class: "kpi-l", text: "Efectivo esperado" })),
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: report.counted_cash_cents == null ? "—" : centsText(report.counted_cash_cents) }), h("span", { class: "kpi-l", text: "Efectivo contado" })),
        h("div", { class: "kpi" }, h("span", { class: "kpi-n" + (difference < 0 ? " money-negative" : ""), text: report.difference_cents == null ? "—" : centsText(report.difference_cents) }), h("span", { class: "kpi-l", text: difference < 0 ? "Faltante" : difference > 0 ? "Sobrante" : "Diferencia" })),
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: centsText(report.sales_total_cents) }), h("span", { class: "kpi-l", text: "Ventas del turno" }))),
      h("h2", { text: "Ventas por método" }),
      sales.length ? h("div", { class: "table" },
        h("div", { class: "cash-line head" }, h("span", { text: "Método" }), h("span", { text: "Pagos" }), h("span", { text: "Total" })),
        ...sales.map(row => h("div", { class: "cash-line" },
          h("span", { text: REPORT_PAYMENT[row.method] || String(row.method) }),
          h("span", { class: "num", text: String(Number(row.count) || 0) }),
          h("span", { class: "num", text: centsText(row.total_cents) }))))
        : h("p", { class: "empty", text: "Sin cobros en el turno." }),
      h("h2", { text: "Movimientos de efectivo" }),
      items.length ? h("div", { class: "detail-list" }, ...items.map(item => h("div", { class: "detail-item" },
        h("strong", { text: (item.kind === "in" ? "Ingreso" : "Retiro") + " · " + centsText(item.amount_cents) }),
        h("span", { class: "prod-note", text: String(item.reason || "") + " · " + shiftStamp(item.created_at) }))))
        : h("p", { class: "muted small", text: "Sin movimientos de efectivo." }),
      h("p", { class: "hint", text: "Ingresos " + centsText(movements.in_cents) + " · Retiros " + centsText(movements.out_cents) +
        (orders.paid != null || orders.rejected != null ? " · Pedidos pagados " + String(Number(orders.paid) || 0) + " · rechazados " + String(Number(orders.rejected) || 0) : "") }),
      Number(pending.count) > 0 ? h("p", { class: "notice", text: "Aviso: " + Number(pending.count) + " pago(s) pendientes por " + centsText(pending.total_cents) + ". No entran en el cierre." }) : null,
      report.note ? h("p", { class: "muted small", text: "Nota: " + String(report.note) }) : null,
      h("div", { class: "actions" }, btn("Reimprimir cierre", "btn small", () => printShift(report, place))));
  }

  // Reporte Z en HTML simple. Se usa mientras `shared/ticket.js` no exporte
  // `shiftTicketLines`; si la rama ya lo serializa (window.__panelShiftTicket),
  // se imprime el ticket térmico de 32/48 columnas y este HTML queda de respaldo.
  function shiftSheet(report, place, store) {
    const rows = [
      ["Apertura", shiftStamp(report.opened_at)],
      ["Cierre", report.closed_at ? shiftStamp(report.closed_at) : "—"],
      ["Fondo inicial", centsText(report.opening_float_cents)],
      ["Ventas del turno", centsText(report.sales_total_cents)],
      ["Efectivo esperado", centsText(report.expected_cash_cents)],
      ["Efectivo contado", report.counted_cash_cents == null ? "—" : centsText(report.counted_cash_cents)],
      ["Diferencia", report.difference_cents == null ? "—" : centsText(report.difference_cents)],
    ];
    const difference = Number(report.difference_cents) || 0;
    const sales = (Array.isArray(report.sales) ? report.sales : []).map(row => h("tr", {},
      h("td", { text: REPORT_PAYMENT[row.method] || String(row.method) }),
      h("td", { class: "num", text: String(Number(row.count) || 0) }),
      h("td", { class: "num", text: centsText(row.total_cents) })));
    const movements = report.movements && typeof report.movements === "object" ? report.movements : {};
    const items = Array.isArray(movements.items) ? movements.items : [];
    return h("div", { class: "print-ticket print-sheet" },
      h("h4", { text: store || "Mi negocio" }),
      h("p", { text: "CIERRE DE CAJA · " + (place || String(report.sede_id || "")) }),
      h("table", {}, h("tbody", {}, ...rows.map(([label, value]) => h("tr", {},
        h("th", { text: label }),
        h("td", { class: "num" + (label === "Diferencia" && difference < 0 ? " money-negative" : ""), text: value }))))),
      sales.length ? h("table", {},
        h("thead", {}, h("tr", {}, h("th", { text: "Método" }), h("th", { class: "num", text: "Pagos" }), h("th", { class: "num", text: "Total" }))),
        h("tbody", {}, ...sales)) : null,
      items.length ? h("table", {},
        h("tbody", {},
          ...items.map(item => h("tr", {},
            h("td", { text: (item.kind === "in" ? "Ingreso" : "Retiro") + " · " + String(item.reason || "") }),
            h("td", { class: "num", text: centsText(item.amount_cents) }))),
          h("tr", {}, h("th", { text: "Ingresos / retiros" }),
            h("td", { class: "num", text: centsText(movements.in_cents) + " / " + centsText(movements.out_cents) })))) : null,
      report.note ? h("p", { text: "Nota: " + String(report.note) }) : null);
  }

  function printShift(report, place) {
    const store = me?.store?.store_name || me?.store?.name || "";
    const paper = paperWidth();
    const width = typeof columnsFn === "function" ? columnsFn(paper) : 32;
    const shiftFn = window.__panelShiftTicket;
    let sheet = null;
    if (typeof shiftFn === "function") {
      let lines = null;
      try { lines = shiftFn(report, { store, width, sedeName: place || String(report.sede_id || "") }); } catch { lines = null; }
      if (Array.isArray(lines) && lines.length) sheet = h("pre", { class: "print-ticket", text: lines.join("\n") });
    }
    if (!sheet) sheet = shiftSheet(report, place, store);
    document.body.append(sheet);
    let opened = false;
    try { window.print(); opened = true; } catch { opened = false; }
    window.setTimeout(() => sheet.remove(), 1200);
    if (!opened) toast("No pudimos abrir la impresión del cierre.", true);
    return opened;
  }

  /* ── Cierres de caja (solo dueño): historial y diferencias ── */
  async function cierresScreen() {
    const token = ++viewToken;
    loadingView("Cargando cierres de caja…");
    const sedeR = await api("sedes");
    if (token !== viewToken) return;
    if (sedeR.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    const sedes = sedeR.status === 200 && Array.isArray(sedeR.data?.sedes) ? sedeR.data.sedes.filter(s => s && s.id) : [];
    const sedeNames = new Map(sedes.map(s => [String(s.id), String(s.nombre || s.id)]));
    const place = id => sedeNameOf(id, key => sedeNames.get(key));
    const today = new Date(), weekAgo = new Date(Date.now() - 6 * 86400000);
    const fromInput = h("input", { type: "date", value: isoDay(weekAgo), "aria-label": "Desde" });
    const toInput = h("input", { type: "date", value: isoDay(today), "aria-label": "Hasta" });
    const sedeSelect = h("select", { "aria-label": "Sede" },
      h("option", { value: "", text: "Todas las sedes" }),
      ...sedes.map(s => h("option", { value: String(s.id), text: String(s.nombre || s.id) })));
    const result = h("div", { "aria-live": "polite" });
    const error = h("p", { class: "err", role: "alert" });

    const showShift = report => {
      V.replaceChildren(h("section", { class: "screen" },
        btn("← Cierres de caja", "back", cierresScreen),
        h("div", { class: "page-head" }, h("div", {},
          h("h1", { text: "Cierre de caja" }),
          h("p", { class: "muted small", text: "Reporte del turno · hora de Ecuador" }))),
        reportCard(report, place(report.sede_id))));
    };

    const openShift = async shift => {
      const r = await api("turnos/" + encodeURIComponent(shift.id));
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      const report = r.status === 200 && r.data && r.data.report ? r.data.report : null;
      if (!report) return toast(errMsg(r, "No pudimos cargar el cierre."), true);
      showShift(report);
    };

    const render = data => {
      const shifts = Array.isArray(data?.shifts) ? data.shifts : [];
      const rows = shifts.map(shift => {
        const closed = String(shift.status) === "closed";
        const difference = Number(shift.difference_cents);
        const missing = closed && shift.difference_cents != null && difference < 0;
        return h("div", { class: "shift-row" },
          h("div", { class: "shift-main" },
            h("strong", { text: place(shift.sede_id) }),
            h("span", { class: "prod-note", text: (SHIFT_STATUS[shift.status] || String(shift.status || "")) +
              (shift.opened_by ? " · abrió " + String(shift.opened_by) : "") })),
          h("span", { class: "num", text: shiftStamp(shift.opened_at) }),
          h("span", { class: "num", text: closed ? shiftStamp(shift.closed_at) : "—" }),
          h("span", { class: "num", text: centsText(shift.opening_float_cents) }),
          h("span", { class: "num", text: closed && shift.expected_cash_cents != null ? centsText(shift.expected_cash_cents) : "—" }),
          h("span", { class: "num", text: closed && shift.counted_cash_cents != null ? centsText(shift.counted_cash_cents) : "—" }),
          h("span", { class: "num" + (missing ? " money-negative" : ""), text: closed && shift.difference_cents != null ? centsText(shift.difference_cents) : "—" }),
          h("span", { class: "num", text: centsText(shift.total_cents) }),
          h("div", { class: "prod-actions" }, btn("Detalle", "link", () => openShift(shift), { "aria-label": "Ver el cierre de " + place(shift.sede_id) })));
      });
      result.replaceChildren(
        shifts.length
          ? h("div", { class: "table-scroll" }, h("div", { class: "table" },
            h("div", { class: "shift-head" }, ...["Turno", "Apertura", "Cierre", "Fondo", "Esperado", "Contado", "Diferencia", "Total", ""]
              .map(title => h("span", { text: title }))),
            ...rows))
          : h("p", { class: "empty", text: "Sin turnos en el rango. Prueba con otras fechas o sede." }),
        h("p", { class: "hint", text: "Diferencia = contado − esperado. Se muestra en rojo cuando falta dinero." }));
    };

    const consult = async () => {
      error.textContent = "";
      const from = fromInput.value, to = toInput.value, sede = sedeSelect.value;
      if (!from || !to) { error.textContent = "Elige la fecha inicial y final."; return; }
      const query = "turnos?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) + "&limit=50" +
        (sede ? "&sede_id=" + encodeURIComponent(sede) : "");
      const r = await api(query);
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 404 || r.status === 405) {
        result.replaceChildren(h("p", { class: "empty", text: "Esta versión del panel todavía no incluye cierres de caja." }));
        return;
      }
      if (r.status !== 200) {
        error.textContent = errMsg(r, "No pudimos cargar los cierres. Revisa las fechas e intenta de nuevo.");
        return;
      }
      render(r.data || {});
    };

    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {},
        h("h1", { text: "Cierres de caja" }),
        h("p", { class: "muted small", text: "Turnos y diferencias de todas las sedes · hora de Ecuador" }))),
      h("section", { class: "card" },
        h("div", { class: "grid2" },
          h("label", { class: "field" }, h("span", { text: "Desde" }), fromInput),
          h("label", { class: "field" }, h("span", { text: "Hasta" }), toInput),
          h("label", { class: "field" }, h("span", { text: "Sede" }), sedeSelect)),
        h("div", { class: "form-actions" }, btn("Consultar", "btn primary small", consult)),
        error),
      result));
    await consult();
  }

  function ordersScreen() {
    let offset = 0, total = 0;
    const list = h("div", { class: "table" }), page = h("span", { class: "muted small" });
    const notice = h("p", {
      class: "notice",
      text: "Confirma tus pedidos. Solo los pedidos web de entrega participan en el club. Confirmar no es cobrar: la comanda llega a cocina solo cuando el pago queda confirmado.",
    });
    const prev = btn("Anterior", "btn ghost small", () => load(offset - 20));
    const next = btn("Siguiente", "btn ghost small", () => load(offset + 20));
    // Órdenes con sede (web y caja). Confirmar no cobra; el cobro libera la comanda.
    // La barra de caja del dueño vive aquí: abrir, mover efectivo y cerrar la sede.
    const posBox = h("div", { class: "pos-cards" });
    const cashBox = h("div");
    const posSection = h("section", {},
      h("div", { class: "page-head" }, h("div", {},
        h("h2", { text: "Órdenes con sede" }),
        h("p", { class: "muted small", text: "Web y caja. Confirmar no cobra; la comanda sale al quedar pagada. Los pedidos listos se avisan a mano por WhatsApp." }))),
      cashBox,
      posBox);
    function orderRow(o) {
      const date = new Date(Number(o.created_at)), phone = String(o.client_phone || "").replace(/\D/g, "");
      const status = ORDER_STATE[o.status] ? o.status : "pending", pending = status === "pending";
      const source = ORDER_SOURCE[o.source] || "Web";
      const table = String(o.table_no || "").trim();
      const prints = Math.max(0, Math.floor(Number(o.print_count) || 0));
      return h("article", { class: "order-row" },
        h("div", { class: "order-main" },
          h("strong", { text: orderCode(o) + " · " + (o.client_name || "Sin nombre") }),
          h("span", { class: "prod-note", text: "Mesa: " + (table || "—") + " · Origen: " + source }),
          prints ? h("span", { class: "prod-note", text: "Impresa ×" + prints }) : null,
          h("span", {
            class: "prod-note",
            text: Number.isNaN(date.getTime())
              ? "—"
              : date.toLocaleString("es-EC", { dateStyle: "short", timeStyle: "short", timeZone: "America/Guayaquil" }),
          }),
          phone ? h("a", {
            class: "prod-note", href: "https://wa.me/" + phone, target: "_blank", rel: "noopener", text: o.client_phone,
          }) : null),
        h("span", { class: "order-delivery", text: deliveryLabel(o.delivery_mode) }),
        h("strong", { class: "order-total", text: money(o.total) }),
        h("span", { class: "order-state " + status, text: ORDER_STATE[status] }),
        h("div", { class: "order-actions" },
          pending ? btn(o.delivery_mode === "mesa" ? "Confirmar" : "Confirmar entrega", "link", () => setOrderState(o, "confirm")) : null,
          pending ? btn("Rechazar", "link danger", () => setOrderState(o, "reject")) : null,
          btn("Detalle", "link", () => orderDetail(o))));
    }
    function orderDetail(o) {
      let items = Array.isArray(o.items) ? o.items : [];
      if (!Array.isArray(o.items)) try { items = JSON.parse(o.items || "[]"); } catch { items = []; }
      const itemNodes = items.map(i => h("div", { class: "detail-item" },
        h("strong", { text: (i.qty || 1) + " × " + (i.nombre || i.name || "Producto") }),
        h("span", { class: "prod-note", text: money(i.precio ?? i.price) + (i.variant ? " · " + i.variant : "") })));
      const status = ORDER_STATE[o.status] ? o.status : "pending";
      V.replaceChildren(h("section", { class: "screen" },
        btn("← Pedidos", "back", ordersScreen),
        h("div", { class: "page-head" }, h("h1", { text: o.client_name || "Pedido" })),
        h("section", { class: "card" },
          h("p", { class: "muted", text: deliveryLabel(o.delivery_mode) + (o.address ? " · " + o.address : "") }),
          h("p", { class: "order-state " + status, text: "Estado: " + ORDER_STATE[status] }),
          h("div", { class: "detail-list" }, itemNodes),
          h("h2", { text: "Total: " + money(o.total) }))));
    }
    async function setOrderState(o, action) {
      const question = "¿Rechazar el pedido de " + (o.client_name || "este cliente") + "? No se le dará el sello.";
      if (action === "reject" && !confirm(question)) return;
      const r = await api("orders/" + encodeURIComponent(o.id) + "/" + action, {}, "POST");
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 200) { toast(action === "confirm" ? (isPosOrder(o) ? "Confirmada. Aún falta cobrar: la comanda no salió a cocina." : "Pedido confirmado.") : "Pedido rechazado."); return load(); }
      if (r.status === 409 || r.status === 404) { toast("Ese pedido ya cambió de estado.", true); return load(); }
      toast(errMsg(r, "No pudimos actualizar el pedido."), true);
    }
    async function load(nextOffset = 0) {
      offset = Math.max(0, nextOffset); list.replaceChildren(h("p", { class: "empty", text: "Cargando pedidos…" }));
      const [r, posR, readyR, sedeR] = await Promise.all([
        api("orders?offset=" + offset + "&limit=20"),
        api("pos/orders?status=open&limit=50"),
        api("pos/orders?status=ready&limit=30"),
        api("sedes"),
      ]);
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) return list.replaceChildren(h("p", { class: "empty", text: errMsg(r, "No pudimos cargar los pedidos.") }));
      const orders = Array.isArray(r.data.orders) ? r.data.orders : []; total = Number(r.data.total) || 0;
      pendingOrders = Number(r.data.pending) || 0; paintPending(); notice.hidden = !pendingOrders;
      const rows = orders.length ? orders.map(orderRow) : [h("p", { class: "empty", text: "Aún no hay pedidos desde el menú" })];
      const head = h("div", { class: "order-head" }, h("span", { text: "Pedido" }), h("span", { text: "Entrega" }),
        h("span", { text: "Total" }), h("span", { text: "Estado" }), h("span"));
      list.replaceChildren(head, ...rows);
      // El dueño ve todas las sedes; un operador autorizado ve las suyas. Sin sede: todas.
      const sedeList = sedeR.status === 200 && Array.isArray(sedeR.data?.sedes) ? sedeR.data.sedes : [];
      const sedeNames = new Map(sedeList.map(s => [s.id, s.nombre || s.id]));
      const openPos = posR.status === 200 && Array.isArray(posR.data?.orders) ? posR.data.orders : [];
      const readyPos = readyR.status === 200 && Array.isArray(readyR.data?.orders) ? readyR.data.orders : [];
      const seenPos = new Set();
      const visiblePos = openPos.concat(readyPos).filter(o => {
        if (!o || seenPos.has(o.id)) return false;
        seenPos.add(o.id);
        return true;
      });
      cashBox.replaceChildren(cashBar(sedeList, sedeNames));
      if (visiblePos.length) posBox.replaceChildren(...visiblePos.map(o => posOrderCard(o, () => load(offset), id => sedeNames.get(id) || id)));
      else posBox.replaceChildren(h("p", { class: "empty", text: "Sin órdenes abiertas en caja." }));
      page.textContent = total ? (offset + 1) + "–" + Math.min(offset + orders.length, total) + " de " + total : "0 pedidos";
      prev.disabled = offset === 0; next.disabled = offset + orders.length >= total;
    }
    notice.hidden = true;
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {},
        h("h1", { text: "Pedidos" }),
        h("p", { class: "muted small", text: "Pedidos enviados desde el menú." })),
      h("div", { class: "actions" },
        btn("+ Nueva orden", "btn primary small", () => newOrderScreen()),
        h("a", { class: "btn small", href: "/panel/cocina", target: "_blank", rel: "noopener", text: "Abrir cocina" }),
        h("a", { class: "btn small", href: "/panel/mesero", target: "_blank", rel: "noopener", text: "Abrir modo mesero" }))),
      notice, posSection, list, h("div", { class: "club-pagination" }, prev, page, next)));
    load();
  }

  /* ── Nueva orden (caja) ─────────────────────────────────────────────────
     El pedido nace pendiente. Confirmar no cobra y cobrar es lo único que
     libera la comanda a cocina. La sede se elige de la lista real del panel. */
  function newOrderState() {
    if (!newOrder || typeof newOrder !== "object") newOrder = {};
    const st = newOrder;
    st.sede_id = typeof st.sede_id === "string" ? st.sede_id : "";
    st.items = Array.isArray(st.items) ? st.items : [];
    st.key = typeof st.key === "string" ? st.key : "";
    st.filter = ["open", "pending", "confirmed", "paid", "ready", "all"].includes(st.filter) ? st.filter : "open";
    st.pick = st.pick || null;
    return st;
  }
  function orderGroups(product) {
    const own = Array.isArray(product?.variants) ? product.variants : Array.isArray(product?.variantes) ? product.variantes : [];
    const groups = Array.isArray(catalog?.variant_groups) ? catalog.variant_groups : [];
    const assigned = Array.isArray(product?.groups) ? product.groups : [];
    return own.concat(assigned.map(ref => {
      const group = groups.find(g => g && g.id === ref.group_id);
      return group ? Object.assign({}, group, { pick: ref.pick_override == null ? group.pick : ref.pick_override }) : null;
    }).filter(Boolean));
  }
  const optionLabel = o => String(typeof o === "object" ? (o.name ?? o.label ?? "") : o ?? "");
  const optionKey = (o, i) => String(typeof o === "object" ? (o.id ?? o.name ?? o.label ?? "") : o ?? "") || String(i);
  function choicesOK(groups, choices) {
    return groups.every((group, i) => {
      const chosen = choices[i];
      return group?.type === "distribute"
        ? Array.isArray(chosen) && chosen.length === Math.max(1, Number(group.pick) || 1)
        : group?.optional || String(chosen || "");
    });
  }
  // Un ítem de carrito lleva product_id y, si aplica, la etiqueta publicada de la variante.
  function buildCartItem(product, choices, note) {
    const groups = Array.isArray(product?.__groups) ? product.__groups : orderGroups(product || {});
    const promo = productPromo(product), base = promo != null && promo !== "" ? promo : productPrice(product);
    let price = num(base), labels = [], variantId = "";
    groups.forEach((group, i) => {
      const selected = group?.type === "distribute" ? (Array.isArray(choices[i]) ? choices[i] : []) : [choices[i]];
      selected.filter(Boolean).forEach(key => {
        const option = (group.options || []).find((o, at) => optionKey(o, at) === key);
        if (!option) return;
        const label = optionLabel(option);
        labels.push(label);
        const priced = typeof option === "object" && (Number.isFinite(Number(option.price)) || Number.isFinite(Number(option.price_delta)));
        if (!variantId && (group.type === "price_select" || priced) && group.type !== "distribute") variantId = label;
        if (group.type === "price_select" && typeof option === "object" && Number.isFinite(Number(option.price))) price = Number(option.price);
      });
    });
    const clean = String(note ?? "").trim().slice(0, 200);
    const item = {
      product_id: String(product?.id || ""), nombre: productName(product), precio: price, qty: 1,
      variant: labels.concat(clean ? "Nota: " + clean : []).join(" · "),
      variant_id: variantId, note: clean,
    };
    return item;
  }

  async function newOrderScreen() {
    const token = ++viewToken;
    const st = newOrderState();
    loadingView("Cargando catálogo…");
    const [sedeR, catR] = await Promise.all([api("sedes"), loadCatalog()]);
    if (token !== viewToken) return;
    if (sedeR.status === 401 || catR.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (catR.status !== 200) return failView(errMsg(catR, "No pudimos cargar el catálogo."), newOrderScreen);
    const sedes = sedeR.status === 200 && Array.isArray(sedeR.data?.sedes) ? sedeR.data.sedes.filter(s => s && s.id && s.activa !== false) : [];
    // Solo sedes reales: si no hay ninguna, la pantalla lo dice y no inventa una.
    if (!sedes.some(s => s.id === st.sede_id)) st.sede_id = sedes.length === 1 ? sedes[0].id : "";
    const sedeName = id => (sedes.find(s => s.id === id)?.nombre || id || "");
    let orderRows = [], ordersNote = null;

    const search = h("input", { type: "search", value: st.search || "", placeholder: "Buscar producto", "aria-label": "Buscar producto en el catálogo" });
    search.addEventListener("input", () => { st.search = search.value; paintGrid(); });
    const grid = h("div", { class: "pick-grid" });
    const pickBox = h("div");
    const cartBox = h("div", { class: "card" });
    const list = h("div", { class: "pos-cards" });
    const sedeSelect = h("select", { "aria-label": "Sede de la orden" },
      h("option", { value: "", text: sedes.length ? "Elige una sede" : "Sin sedes configuradas" }),
      sedes.map(s => h("option", { value: s.id, text: s.nombre || s.id })));
    sedeSelect.value = st.sede_id;
    sedeSelect.disabled = !sedes.length;
    sedeSelect.addEventListener("change", () => {
      st.sede_id = sedeSelect.value;
      cartBox.replaceChildren(); // el carrito se repinta con el aviso de sede
      paintCart();
      loadOrders();
    });

    function pickCount(product) {
      return st.items.filter(i => i.product_id === product.id).reduce((sum, i) => sum + i.qty, 0);
    }
    function paintGrid() {
      if (!V || token !== viewToken) return;
      const q = norm(st.search || "");
      const found = prods.filter(p => p && p.active !== false && p.catalog_visible !== false && (!q || norm(productName(p)).includes(q)));
      if (!found.length) {
        grid.replaceChildren(h("p", { class: "empty", text: prods.length ? "Sin resultados." : "No hay productos visibles en el catálogo." }));
        return;
      }
      grid.replaceChildren(...found.map(product => {
        const promo = productPromo(product);
        const qty = pickCount(product), price = money(promo != null && promo !== "" ? promo : productPrice(product));
        const stockOff = isOff(product);
        const card = h("button", {
          type: "button", class: "pick-card" + (qty ? " in-cart" : ""), disabled: stockOff,
          "aria-label": productName(product) + ", " + price + (qty ? ", " + qty + " en el carrito" : "") + (stockOff ? ", agotado" : ""),
        },
        h("span", { class: "pick-media" }, ...(() => {
          const url = productImage(product), kids = [];
          if (url) kids.push(h("img", { src: url, alt: "", loading: "lazy", decoding: "async" }));
          else kids.push(h("span", { class: "pick-fallback", "aria-hidden": "true" }));
          return kids;
        })()),
        qty ? h("span", { class: "pick-qty", "aria-hidden": "true", text: String(qty) }) : null,
        h("span", { class: "pick-body" },
          h("span", { class: "pick-name", text: productName(product) }),
          h("span", { class: "pick-price", text: stockOff ? "Agotado" : price })));
        card.addEventListener("click", () => chooseProduct(product));
        return card;
      }));
    }

    function chooseProduct(product) {
      const groups = orderGroups(product);
      if (!groups.length) { addCart(buildCartItem(product)); return; }
      st.pick = { product, groups, choices: {}, note: "" };
      paintPick();
      pickBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    function paintPick() {
      const pick = st.pick;
      pickBox.replaceChildren();
      if (!pick) return;
      const error = h("p", { class: "err", role: "alert" });
      const noteInput = h("input", { maxlength: "200", placeholder: "Opcional", "aria-label": "Nota para este producto" });
      noteInput.value = pick.note || "";
      const form = h("form", { class: "pick-variants" }, h("h3", { text: productName(pick.product) }));
      pick.groups.forEach((group, index) => {
        form.append(h("h3", { text: optionLabel(group) + (group.optional ? " (opcional)" : "") }));
        (group.options || []).forEach((option, at) => {
          const key = optionKey(option, at);
          const input = h("input", { type: group.type === "distribute" ? "checkbox" : "radio", name: "npick-" + index, value: key });
          input.addEventListener("change", () => {
            if (group.type === "distribute") {
              const selected = Array.isArray(pick.choices[index]) ? pick.choices[index] : [];
              if (input.checked && selected.length < Math.max(1, Number(group.pick) || 1)) pick.choices[index] = selected.concat(key);
              else if (!input.checked) pick.choices[index] = selected.filter(v => v !== key);
              else input.checked = false;
            } else pick.choices[index] = input.checked ? key : "";
          });
          form.append(h("label", { class: "check-row" }, input, h("span", { text: optionLabel(option) })));
        });
      });
      form.append(h("label", { class: "field" }, h("span", { text: "Nota para este producto" }), noteInput),
        h("div", { class: "form-actions" },
          btn("Cancelar", "btn ghost", () => { st.pick = null; paintPick(); }),
          h("button", { class: "btn primary", type: "submit" }, "Agregar a la orden")),
        error);
      form.addEventListener("submit", ev => {
        ev.preventDefault();
        if (!choicesOK(pick.groups, pick.choices)) { error.textContent = "Completa las opciones requeridas."; return; }
        const item = buildCartItem(Object.assign({}, pick.product, { __groups: pick.groups }), pick.choices, noteInput.value);
        st.pick = null;
        addCart(item);
        paintPick();
      });
      pickBox.append(form);
    }
    function addCart(item) {
      const same = st.items.find(old => old.product_id === item.product_id && (old.variant || "") === (item.variant || "") && (old.note || "") === (item.note || ""));
      if (same) same.qty = Math.min(99, same.qty + 1);
      else st.items.push(item);
      paintCart();
      paintGrid();
      toast("+1 " + item.nombre);
    }
    function cartTotal() { return st.items.reduce((sum, i) => sum + num(i.precio) * Math.max(1, Number(i.qty) || 1), 0); }

    function paintCart() {
      const total = cartTotal();
      const name = h("input", { maxlength: "120", placeholder: "Cliente (opcional)", value: st.client_name || "" });
      name.addEventListener("input", () => { st.client_name = name.value; });
      st.delivery_mode = "pickup";
      st.table_no = "";
      const lines = st.items.length ? st.items.map((item, index) => {
        const qty = h("b", { text: String(item.qty) });
        const plus = btn("+", "link", () => { item.qty = Math.min(99, item.qty + 1); paintCart(); paintGrid(); }, { "aria-label": "Aumentar " + item.nombre });
        const minus = btn("−", "link", () => { if ((item.qty = Math.max(0, item.qty - 1)) === 0) st.items.splice(st.items.indexOf(item), 1); paintCart(); paintGrid(); }, { "aria-label": "Quitar uno de " + item.nombre });
        const remove = btn("Quitar", "link danger", () => { st.items.splice(index, 1); paintCart(); paintGrid(); }, { "aria-label": "Quitar " + item.nombre });
        return h("div", { class: "cart-line" },
          h("div", {}, h("b", { text: item.nombre }), item.variant ? h("span", { class: "cart-note", text: item.variant }) : null),
          h("div", { class: "qty-box" }, minus, qty, plus),
          h("div", {}, h("b", { text: money(num(item.precio) * item.qty) }), remove));
      }) : [h("p", { class: "empty", text: "Toca un producto para agregarlo." })];
      const create = btn("Crear orden pendiente", "btn primary", ev => createOrder(ev.currentTarget));
      create.disabled = !st.items.length || !sedes.length;
      cartBox.replaceChildren(
        h("h2", { text: "Orden en curso" }),
        h("label", { class: "field" }, h("span", { text: "Sede" }), sedeSelect),
        ...(!sedes.length ? [h("p", { class: "notice", text: "No hay sedes activas. Configúralas en Mi negocio antes de crear órdenes." })] : []),
        h("div", { class: "cart-list" }, lines),
        h("p", { class: "pos-head" }, h("strong", { text: "Total" }), h("strong", { text: money(total) })),
        h("div", { class: "grid2" },
          h("label", { class: "field" }, h("span", { text: "Cliente" }), name),
          h("p", { class: "field" }, h("span", { text: "Retiro en local" }))),
        h("p", { class: "hint", text: "La orden queda pendiente. Confirmar no cobra: el cobro es lo que envía la comanda a cocina." }),
        create);
    }

    async function createOrder(buttonEl) {
      if (!st.sede_id) return toast("Elige la sede antes de crear la orden.", true);
      if (!st.items.length) return toast("Agrega al menos un producto.", true);
      st.key = st.key || uuid();
      const items = st.items.map(item => {
        const labels = String(item.variant || "").split(" · ").filter(part => part && !part.startsWith("Nota: "));
        const note = [item.variant_id ? "" : labels.join(" · "), item.note || ""].filter(Boolean).join(" · ");
        return {
          product_id: item.product_id, qty: Math.max(1, Number(item.qty) || 1),
          ...(item.variant_id ? { variant_id: item.variant_id } : {}),
          ...(note ? { note } : {}),
        };
      });
      buttonEl.disabled = true;
      const r = await api("mesero/orders", {
        sede_id: st.sede_id, idempotency_key: st.key, delivery_mode: "pickup",
        client_name: st.client_name || undefined, items,
      });
      buttonEl.disabled = false;
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200 && r.status !== 201) return toast(errMsg(r, "No pudimos crear la orden."), true);
      const number = r.data?.number ? "#" + r.data.number : "nueva";
      st.items = []; st.key = ""; st.client_name = ""; st.table_no = ""; st.pick = null;
      paintPick(); paintCart(); paintGrid();
      toast("Orden " + number + " creada como pendiente. Confírmala y cóbrala antes de la comanda.");
      st.filter = "open";
      await loadOrders();
      paintFilter();
    }

    const filters = h("div", { class: "subtabs", role: "tablist", "aria-label": "Estado de las órdenes" });
    const FILTERS = [["open", "Por cobrar"], ["pending", "Pendientes"], ["confirmed", "Falta cobro"], ["paid", "Pagados"], ["ready", "Listos"], ["all", "Todos"]];
    function paintFilter() {
      filters.replaceChildren(...FILTERS.map(([id, label]) =>
        h("button", { type: "button", class: "subtab" + (st.filter === id ? " active" : ""), role: "tab", "aria-selected": String(st.filter === id), onclick: () => { st.filter = id; paintFilter(); loadOrders(); } }, label)));
    }
    async function loadOrders() {
      ordersNote.textContent = st.sede_id ? "Cargando órdenes…" : "Elige una sede para ver sus órdenes.";
      if (!st.sede_id) { orderRows = []; paintOrders(); return; }
      const r = await api("pos/orders?sede_id=" + encodeURIComponent(st.sede_id) + "&status=" + encodeURIComponent(st.filter) + "&limit=30");
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) { ordersNote.textContent = errMsg(r, "No pudimos cargar las órdenes."); orderRows = []; paintOrders(); return; }
      orderRows = Array.isArray(r.data?.orders) ? r.data.orders : [];
      ordersNote.textContent = "";
      paintOrders();
    }
    function paintOrders() {
      if (!V || token !== viewToken) return;
      if (!orderRows.length) {
        list.replaceChildren(h("p", { class: "empty", text: st.sede_id ? "No hay órdenes con este filtro." : "Elige una sede." }));
        return;
      }
      list.replaceChildren(...orderRows.map(o => posOrderCard(o, loadOrders, sedeName)));
    }

    paintGrid(); paintPick(); paintCart(); paintFilter();
    ordersNote = h("p", { class: "muted small" });
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {},
        h("h1", { text: "Nueva orden" }),
        h("p", { class: "muted small", text: "Pedido de caja o teléfono. Queda pendiente hasta que confirmes y cobres." })),
      h("div", { class: "actions" },
        h("a", { class: "btn small", href: "/panel/cocina", target: "_blank", rel: "noopener", text: "Abrir cocina" }),
        h("a", { class: "btn small", href: "/panel/mesero", target: "_blank", rel: "noopener", text: "Modo mesero" }))),
      h("div", { class: "neworder" },
        h("div", { class: "neworder-main" }, pickBox, search, grid),
        h("div", { class: "neworder-side" }, cartBox)),
      h("div", { class: "page-head" }, h("div", {},
        h("h2", { text: "Órdenes de la sede" }),
        h("p", { class: "muted small", text: "Confirmar no cobra; la comanda sale solo al quedar pagada." }))),
      h("div", { class: "actions" }, filters, btn("Actualizar", "btn small", () => loadOrders())),
      ordersNote, list));
    loadOrders();
  }

  /* ── Mi negocio ── */
  async function storeScreen() {
    const token = ++viewToken;
    loadingView("Cargando tu negocio…");
    const r = await api("store");
    if (token !== viewToken) return;
    if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (r.status !== 200) return failView(errMsg(r, "No pudimos cargar los datos del negocio."), storeScreen);
    await loadCatalog();
    const st = (r.data && r.data.store) || (r.data && r.data.config) || r.data || {};
    const rawHours = st.hours && typeof st.hours === "object" && !Array.isArray(st.hours) ? st.hours : {};
    const rawWeekly = rawHours.weekly && typeof rawHours.weekly === "object" ? rawHours.weekly : {};
    const dayNames = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
    const days = dayNames.map((name, day) => ({
      name, closed: !Array.isArray(rawWeekly[String(day)]) || !rawWeekly[String(day)].length,
      ranges: (Array.isArray(rawWeekly[String(day)]) ? rawWeekly[String(day)] : [])
        .filter(x => Array.isArray(x) && x.length === 2).slice(0, 2).map(x => [String(x[0]), String(x[1])]),
    }));
    const schedule = h("div", { class: "week-editor" });
    function paintSchedule() {
      schedule.replaceChildren();
      days.forEach(day => {
        const closed = h("input", { type: "checkbox", checked: day.closed, "aria-label": day.name + " cerrado" });
        const ranges = h("div", { class: "time-ranges" });
        const addRange = btn("+ Segundo rango", "link", () => {
          if (day.ranges.length < 2) day.ranges.push(["14:00", "18:00"]);
          day.closed = false;
          paintSchedule();
        });
        closed.addEventListener("change", () => {
          day.closed = closed.checked;
          if (!day.closed && !day.ranges.length) day.ranges.push(["09:00", "18:00"]);
          paintSchedule();
        });
        if (!day.closed) {
          if (!day.ranges.length) day.ranges.push(["09:00", "18:00"]);
          day.ranges.forEach((range, index) => {
            const start = h("input", { type: "time", value: range[0], "aria-label": day.name + " apertura " + (index + 1) });
            const end = h("input", { type: "time", value: range[1], "aria-label": day.name + " cierre " + (index + 1) });
            start.addEventListener("input", () => { range[0] = start.value; });
            end.addEventListener("input", () => { range[1] = end.value; });
            ranges.append(h("div", { class: "time-range" }, start, h("span", { text: "a" }), end,
              index ? btn("Quitar", "link danger", () => { day.ranges.splice(index, 1); paintSchedule(); }) : null));
          });
          addRange.hidden = day.ranges.length >= 2;
          ranges.append(addRange);
        }
        schedule.append(h("div", { class: "day-editor" },
          h("div", { class: "day-head" }, h("strong", { text: day.name }),
            h("label", { class: "closed-check" }, closed, h("span", { text: "Cerrado" }))), ranges));
      });
    }
    paintSchedule();
    const wa = h("input", { id: uid("bwa"), type: "tel", inputmode: "tel", autocomplete: "tel", value: String(st.whatsapp_number || "") });
    const closedMsg = h("input", { id: uid("bclosed"), type: "text", maxlength: 200, value: String(rawHours.closed_msg || "") });
    const preorders = h("input", { id: uid("bpre"), type: "checkbox", checked: rawHours.allow_preorders === true });
    const rawLocation = st.location && typeof st.location === "object" && !Array.isArray(st.location) ? st.location : {};
    const branches = (Array.isArray(rawLocation.sedes) ? rawLocation.sedes : []).map(s => Object.assign({}, s || {}, {
      id: typeof s?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) ? s.id : "",
      nombre: String(s?.nombre || ""), direccion: String(s?.direccion || ""), telefono: String(s?.telefono || ""),
      universidad: String(s?.universidad || ""), activa: s?.activa !== false,
      coords: s?.lat == null ? "" : String(s.lat) + ", " + String(s.lng), radio_km: s?.radio_km == null ? "" : String(s.radio_km),
    }));
    const branchList = h("div", { class: "branches" });
    const sedesQr = h("div");
    const nextSedeId = () => {
      let n = 1;
      while (branches.some(branch => branch.id === "sede-" + String(n).padStart(2, "0"))) n++;
      return "sede-" + String(n).padStart(2, "0");
    };
    function paintBranches() {
      branchList.replaceChildren();
      if (!branches.length) branchList.append(h("p", { class: "muted small", text: "Todavía no hay sedes. Agrega la primera." }));
      branches.forEach((branch, index) => {
        const name = h("input", { id: uid("bsn"), type: "text", maxlength: 120, value: branch.nombre });
        const address = h("input", { id: uid("bsa"), type: "text", maxlength: 300, value: branch.direccion });
        const phone = h("input", { id: uid("bst"), type: "tel", inputmode: "tel", value: branch.telefono });
        const coords = h("input", { id: uid("bco"), type: "text", placeholder: "-2.18, -79.89", value: branch.coords });
        const radio = h("input", { id: uid("bra"), type: "text", inputmode: "decimal", value: branch.radio_km });
        name.addEventListener("input", () => { branch.nombre = name.value; });
        address.addEventListener("input", () => { branch.direccion = address.value; });
        phone.addEventListener("input", () => { branch.telefono = phone.value; }); coords.addEventListener("input", () => { branch.coords = coords.value; }); radio.addEventListener("input", () => { branch.radio_km = radio.value; });
        branchList.append(h("div", { class: "branch" }, field("Nombre de la sede", name), field("Dirección", address), field("Teléfono", phone), field("Coordenadas (lat, lng)", coords), field("Radio km", radio),
          btn("Quitar", "btn small danger", () => { branches.splice(index, 1); paintBranches(); })));
      });
      sedesQr.replaceChildren(sedesQrCard(branches));
    }
    paintBranches();
    const locationPhone = h("input", { id: uid("blphone"), type: "tel", inputmode: "tel", autocomplete: "tel", value: String(rawLocation.telefono_principal || "") });
    const fee = h("input", { id: uid("bfee"), type: "text", inputmode: "decimal", value: st.delivery_fee == null ? "" : priceText(st.delivery_fee) });
    const coverage = h("textarea", { id: uid("bcoverage"), maxlength: "300", value: String(rawLocation.out_of_coverage_message || "") });
    const facebook = h("input", { id: uid("bfacebook"), type: "url", value: String(rawLocation.social?.facebook || "") });
    const instagram = h("input", { id: uid("binstagram"), type: "url", value: String(rawLocation.social?.instagram || "") });
    const tiktok = h("input", { id: uid("btiktok"), type: "url", value: String(rawLocation.social?.tiktok || "") });
    const mapEmbed = h("input", { id: uid("bmap"), type: "url", value: String(rawLocation.map_embed || "") });
    const cross = st.cross_sell && typeof st.cross_sell === "object" ? st.cross_sell : {};
    const crossTitle = h("input", { id: uid("bcrosst"), type: "text", maxlength: "60", value: String(cross.title || "") });
    const crossMax = h("input", { id: uid("bcrossm"), type: "number", min: "1", max: "12", value: String(cross.max || 4) });
    const selectedCross = new Set(Array.isArray(cross.categories) ? cross.categories : []);
    const crossCats = h("div", { class: "check-list" }, cats.map(c => { const i = h("input", { type: "checkbox", checked: selectedCross.has(c.slug) }); i.addEventListener("change", () => i.checked ? selectedCross.add(c.slug) : selectedCross.delete(c.slug)); return h("label", { class: "check-row" }, i, h("span", { text: c.name || c.label })); }));
    const placeholder = h("input", { id: uid("bsearch"), type: "text", maxlength: "60", value: String(st.search_placeholder || "") });
    const hero = h("input", { id: uid("bhero"), type: "text", maxlength: 120, value: String(st.hero_title || "") });
    const sub = h("input", { id: uid("bsub"), type: "text", maxlength: 120, value: String(st.brand_sub || "") });
    let logo = safeUrl(st.logo);
    const originalLogo = logo;
    const photo = photoPicker("Logo del negocio", logo, url => { logo = url; }, false);
    const err = h("p", { class: "err", role: "alert" });
    const save = h("button", { type: "submit", class: "btn primary" }, "Guardar cambios");
    const form = h("form", { novalidate: true, class: "card" },
      sectioned([
        ["contacto", "Contacto", "A este WhatsApp llegan los pedidos.",
          h("div", { class: "grid2" }, field("WhatsApp", wa, "Con código de país. Ejemplo: 593991234567."),
            field("Teléfono principal de las sedes", locationPhone, "Solo dígitos, con código de país."))],
        ["horario", "Horario semanal", "Marca los días cerrados o configura hasta dos rangos por día.",
          schedule,
          field("Mensaje cuando está cerrado", closedMsg),
          switchField("Permitir pedidos anticipados", preorders)],
        ["sedes", "Sedes", "Dirección de cada local.",
          branchList,
          btn("+ Agregar sede", "btn small", () => { branches.push({ id: nextSedeId(), nombre: "", direccion: "", activa: true }); paintBranches(); }),
          sedesQr],
        ["delivery", "Envío y cobertura", "Tarifa fija y alcance desde cada sede.",
          h("div", { class: "grid2" }, field("Tarifa fija", fee), field("Mensaje fuera de cobertura", coverage))],
        ["social", "Redes y mapa", "Enlaces públicos de tu negocio.",
          h("div", { class: "grid2" }, field("Facebook", facebook), field("Instagram", instagram), field("TikTok", tiktok), field("Mapa embebido", mapEmbed))],
        ["suggest", "Sugeridos al pedir", "Categorías que se recomiendan en el checkout.",
          h("div", { class: "grid2" }, field("Título", crossTitle), field("Máximo", crossMax)), crossCats],
        ["search", "Buscador", "Texto que aparece en el campo de búsqueda del menú.", field("Placeholder", placeholder)],
        ["marca", "Marca y portada", "Logo y textos del inicio del menú.",
          photo.node,
          h("div", { class: "grid2" }, field("Título de portada", hero, "Texto grande que aparece al inicio del menú."),
            field("Texto bajo la marca", sub, "Frase corta debajo del nombre del negocio."))],
        ["seguridad", "Seguridad", "Al cambiar la contraseña se cierran las sesiones abiertas en otros equipos.",
          h("div", { class: "actions" }, btn("Cambiar contraseña", "btn small", () => passwordScreen(false)),
            btn("Cerrar sesión", "btn small", logout))],
      ]),
      h("div", { class: "form-actions" }, save),
      err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      const whatsapp = String(wa.value || "").replace(/\D/g, "");
      const locationNumber = String(locationPhone.value || "").replace(/\D/g, "");
      if (whatsapp && !/^\d{8,15}$/.test(whatsapp)) { err.textContent = "WhatsApp debe tener entre 8 y 15 dígitos."; return; }
      if (locationNumber && !/^\d{8,15}$/.test(locationNumber)) { err.textContent = "El teléfono principal debe tener entre 8 y 15 dígitos."; return; }
      const weekly = {}, timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
      for (let day = 0; day < days.length; day++) {
        weekly[String(day)] = days[day].closed ? [] : days[day].ranges.map(range => [range[0], range[1]]);
        if (weekly[String(day)].some(range => !timePattern.test(range[0]) || !timePattern.test(range[1]) || range[0] === range[1])) {
          err.textContent = "Revisa los rangos de " + days[day].name + "."; return;
        }
      }
      const cleanBranches = branches.map(branch => {
        if (!branch.id) branch.id = nextSedeId();
        const coords = String(branch.coords || "").split(",").map(x => x.trim());
        const out = {
          id: branch.id, nombre: branch.nombre.trim(), direccion: branch.direccion.trim(),
          universidad: String(branch.universidad || "").trim(), activa: branch.activa !== false,
        };
        const branchPhone = String(branch.telefono || "").replace(/\D/g, "");
        if (branchPhone) out.telefono = branchPhone;
        if (coords.length === 2 && coords[0] !== "" && coords[1] !== "" && branch.radio_km !== "") { out.lat = Number(coords[0]); out.lng = Number(coords[1]); out.radio_km = num(branch.radio_km); }
        return out;
      });
      if (cleanBranches.some(branch => !branch.nombre || !branch.direccion)) { err.textContent = "Completa el nombre y la dirección de cada sede."; return; }
      if (cleanBranches.some(branch => (branch.lat == null) !== (branch.lng == null) || (branch.lat == null) !== (branch.radio_km == null) || (branch.lat != null && (!Number.isFinite(branch.lat) || !Number.isFinite(branch.lng) || !Number.isFinite(branch.radio_km))))) { err.textContent = "Las coordenadas y el radio deben estar completos y ser válidos."; return; }
      const deliveryFee = fee.value.trim() === "" ? 0 : priceValue(fee.value);
      if (deliveryFee == null || deliveryFee > 1000) { err.textContent = "Escribe una tarifa entre 0 y 1000."; return; }
      save.disabled = true;
      save.textContent = "Guardando…";
      const social = {};
      for (const [network, input] of [["facebook", facebook], ["instagram", instagram], ["tiktok", tiktok]]) if (input.value.trim()) social[network] = input.value.trim();
      const body = {
        hours: { tz: typeof rawHours.tz === "string" && rawHours.tz ? rawHours.tz : "America/Guayaquil", weekly, closed_msg: closedMsg.value.trim(), allow_preorders: preorders.checked },
        location: { sedes: cleanBranches, telefono_principal: locationNumber, out_of_coverage_message: coverage.value.trim(), social, map_embed: mapEmbed.value.trim() },
        delivery_fee: deliveryFee,
        cross_sell: { categories: [...selectedCross], title: crossTitle.value.trim(), max: Math.max(1, Math.min(12, Math.floor(num(crossMax.value) || 1))) },
        search_placeholder: placeholder.value.trim(),
        hero_title: hero.value.trim(),
        brand_sub: sub.value.trim(),
      };
      if (whatsapp) body.whatsapp_number = whatsapp;
      if (logo !== originalLogo && logo) body.logo = logo;
      const r = await api("store", body, "PATCH");
      save.disabled = false;
      save.textContent = "Guardar cambios";
      if (r.status === 200 || r.status === 204) {
        // Las sedes viven en D1 (pos_sedes); el PATCH de negocio solo actualiza la config.
        const sedeSync = await api("sedes", { sedes: cleanBranches.map(branch => ({
          id: branch.id, nombre: branch.nombre, direccion: branch.direccion,
          universidad: branch.universidad, activa: branch.activa,
        })) }, "PUT");
        if (sedeSync.status !== 200) {
          err.textContent = errMsg(sedeSync, "Guardamos el negocio, pero no pudimos sincronizar las sedes. Vuelve a guardar.");
          return;
        }
        toast("Datos del negocio guardados.");
        const m = await api("me");
        if (m.status === 200) { applyMe(m.data); }
        return storeScreen();
      }
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      err.textContent = errMsg(r, "No pudimos guardar los datos.");
    });
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Mi negocio" }),
        h("p", { class: "muted small", text: "Estos datos aparecen en tu menú." }))),
      form));
  }

  /* ── Fidelidad ── */
  function normalizeLoyalty(d) {
    const c = (d && d.loyalty) || d || {};
    return {
      enabled: c.enabled === true,
      games: Array.isArray(c.games) && c.games.length ? c.games.filter(g => g === "wheel" || g === "scratch") : ["wheel", "scratch"],
      lose_weight: Number(c.lose_weight) >= 0 ? Number(c.lose_weight) : 70,
      stamps_goal: Number(c.stamps_goal) > 0 ? Number(c.stamps_goal) : 8,
      reward: typeof c.stamps_reward_label === "string"
        ? c.stamps_reward_label
        : (c.stamps_reward && c.stamps_reward.label) || "",
      rewardExpires: c.stamps_reward && Number(c.stamps_reward.expires_days) > 0 ? Number(c.stamps_reward.expires_days) : null,
      cooldown_hours: Number(c.cooldown_hours) >= 0 ? Number(c.cooldown_hours) : 12,
      review_url: typeof c.review_url === "string" ? c.review_url : "",
      terms: typeof c.terms === "string" ? c.terms : "",
      requirePin: c.require_pin === true,
      playMode: c.play_mode === "stamps" ? "stamps" : "game",
      birthday: {
        enabled: c.birthday?.enabled === true,
        label: typeof c.birthday?.label === "string" && c.birthday.label.trim() ? c.birthday.label.trim() : "Regalo de cumpleaños",
        expires_days: Number(c.birthday?.expires_days) > 0 ? Math.floor(Number(c.birthday.expires_days)) : 14,
      },
      winback: {
        enabled: c.winback?.enabled === true,
        days: Number(c.winback?.days) >= 14 ? Math.floor(Number(c.winback.days)) : 30,
        label: typeof c.winback?.label === "string" && c.winback.label.trim() ? c.winback.label.trim() : "Un premio de bienvenida",
        expires_days: Number(c.winback?.expires_days) > 0 ? Math.floor(Number(c.winback.expires_days)) : 14,
      },
      prizes: (Array.isArray(c.prizes) ? c.prizes : [])
        .filter(p => p && p.id && p.id !== "__stamps")
        .map(p => ({ id: String(p.id), label: String(p.label || ""), weight: Number(p.weight) > 0 ? Number(p.weight) : 10,
          stock: p.stock == null ? null : Math.max(0, Math.floor(Number(p.stock) || 0)),
          expires_days: Number(p.expires_days) > 0 ? Number(p.expires_days) : null })),
      pinSet: c.pin_set === true || c.has_pin === true,
    };
  }
  function newPrizeId(taken) {
    if (!taken.has("premio")) return "premio";
    let n = 2;
    while (taken.has("premio-" + n)) n++;
    return "premio-" + n;
  }

  async function loyaltyScreen() {
    const token = ++viewToken;
    if (!loyaltyAllowed()) return loyaltyLockedScreen();
    loadingView("Cargando el club de fidelidad…");
    const [r, store] = await Promise.all([api("loyalty"), api("store")]);
    if (token !== viewToken) return;
    if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (r.status !== 200 && r.status !== 404) return failView(errMsg(r, "No pudimos cargar la fidelidad."), loyaltyScreen);
    const club = normalizeLoyalty(r.status === 200 ? r.data : {});
    const menu = store.status === 200 ? ((store.data && store.data.config) || store.data || {}) : {};
    const sedes = Array.isArray(menu.location?.sedes) ? menu.location.sedes : [];
    const hasCoords = sedes.some(sede => Number.isFinite(sede?.lat) && Number.isFinite(sede?.lng));
    // config.club lo escribe esta pantalla y lo lee v1/catalog.js#clubBanner.
    const clubConfig = menu.club && typeof menu.club === "object" && !Array.isArray(menu.club) ? menu.club : null;
    const clubVisible = clubConfig != null;
    const clubLabel = clubConfig && typeof clubConfig.label === "string" && clubConfig.label.trim()
      ? clubConfig.label.trim().slice(0, 40)
      : "Únete al club";
    const enabled = h("input", { id: uid("lenabled"), type: "checkbox", checked: club.enabled });
    const clubOn = h("input", { id: uid("lclub"), type: "checkbox", checked: clubVisible });
    const clubText = h("input", { id: uid("lclubtext"), type: "text", maxlength: 40, value: clubLabel, placeholder: "Únete al club" });
    const playMode = h("select", { id: uid("lplaymode") },
      h("option", { value: "game", text: "Sello + juego (recomendado)" }),
      h("option", { value: "stamps", text: "Solo sellos" }));
    playMode.value = club.playMode;
    const requirePin = h("input", { id: uid("lrequirepin"), type: "checkbox", checked: club.requirePin });
    const goal = h("input", { id: uid("lgoal"), type: "number", inputmode: "numeric", min: "1", max: "50", step: "1", value: String(club.stamps_goal) });
    const reward = h("input", { id: uid("lreward"), type: "text", maxlength: 90, value: club.reward });
    const rewardExpires = h("input", { id: uid("lrewardexp"), type: "number", inputmode: "numeric", min: "1", step: "1", value: club.rewardExpires == null ? "90" : String(club.rewardExpires) });
    const lose = h("input", { id: uid("llose"), type: "number", inputmode: "decimal", min: "0", step: "1", value: String(club.lose_weight) });
    const cooldown = h("input", { id: uid("lcooldown"), type: "number", inputmode: "decimal", min: "0", step: "1", value: String(club.cooldown_hours) });
    const review = h("input", { id: uid("lreview"), type: "url", placeholder: "https://…", value: club.review_url });
    const terms = h("textarea", { id: uid("lterms"), maxlength: "1000", value: club.terms });
    const termsCount = h("p", { class: "counter", text: club.terms.length + "/1000" });
    terms.addEventListener("input", () => { termsCount.textContent = terms.value.length + "/1000"; });
    const games = ["wheel", "scratch"].map(game => h("input", { id: uid("lgame"), type: "checkbox", value: game, checked: club.games.includes(game) }));
    // Cumpleaños e inactivos: los premios automáticos del club.
    const birthdayOn = h("input", { id: uid("lbday"), type: "checkbox", checked: club.birthday.enabled });
    const birthdayLabel = h("input", { id: uid("lbdaylabel"), type: "text", maxlength: 60, value: club.birthday.label });
    const birthdayDays = h("input", { id: uid("lbdaydays"), type: "number", inputmode: "numeric",
      min: "1", max: "365", step: "1", value: String(club.birthday.expires_days) });
    const winbackOn = h("input", { id: uid("lwinback"), type: "checkbox", checked: club.winback.enabled });
    const winbackDays = h("input", { id: uid("lwinbackdays"), type: "number", inputmode: "numeric",
      min: "14", max: "365", step: "1", value: String(club.winback.days) });
    const winbackLabel = h("input", { id: uid("lwinbacklabel"), type: "text", maxlength: 60, value: club.winback.label });
    const winbackExpires = h("input", { id: uid("lwinbackexp"), type: "number", inputmode: "numeric",
      min: "1", max: "365", step: "1", value: String(club.winback.expires_days) });
    const pin = h("input", { id: uid("lpin"), type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "4", autocomplete: "new-password", placeholder: "••••" });
    pin.addEventListener("input", () => { pin.value = pin.value.replace(/\D/g, "").slice(0, 4); });
    const prizes = club.prizes.slice();
    const list = h("div", { class: "prizes" });
    const probability = h("p", { class: "hint" });
    const err = h("p", { class: "err", role: "alert" });
    const save = h("button", { type: "submit", class: "btn primary" }, "Guardar fidelidad");

    function paintPrizes() {
      list.replaceChildren();
      if (!prizes.length) {
        list.append(h("p", { class: "muted small", text: "Todavía no hay premios. Agrega el primero." }));
        return;
      }
      prizes.forEach((pr, i) => {
        const label = h("input", { type: "text", id: uid("prl"), maxlength: 60, value: pr.label });
        const weight = h("input", { type: "number", id: uid("prw"), inputmode: "numeric", min: "1", max: "1000", step: "1", value: String(pr.weight) });
        const stock = h("input", { type: "number", id: uid("prs"), inputmode: "numeric", min: "0", step: "1", placeholder: "Ilimitado", value: pr.stock == null ? "" : String(pr.stock) });
        const expires = h("input", { type: "number", id: uid("pre"), inputmode: "numeric", min: "1", step: "1", placeholder: "Sin vencimiento", value: pr.expires_days == null ? "" : String(pr.expires_days) });
        label.addEventListener("input", () => { pr.label = label.value; });
        weight.addEventListener("input", () => { pr.weight = Math.max(1, Math.floor(Number(weight.value) || 1)); paintProbability(); });
        stock.addEventListener("input", () => { pr.stock = stock.value === "" ? null : Math.max(0, Math.floor(Number(stock.value) || 0)); });
        expires.addEventListener("input", () => { pr.expires_days = expires.value === "" ? null : Math.max(1, Math.floor(Number(expires.value) || 1)); });
        list.append(h("div", { class: "prize" },
          h("div", { class: "field" }, h("label", { for: label.id, text: "Premio " + (i + 1) }), label),
          h("div", { class: "field" }, h("label", { for: weight.id, text: "Peso" }), weight),
          h("div", { class: "field" }, h("label", { for: stock.id, text: "Stock" }), stock),
          h("div", { class: "field" }, h("label", { for: expires.id, text: "Vence (días)" }), expires),
          btn("Quitar", "btn small danger", () => { prizes.splice(i, 1); paintPrizes(); }, { "aria-label": "Quitar premio " + (i + 1) })));
      });
      paintProbability();
    }
    function paintProbability() {
      const loss = Math.max(0, Number(lose.value) || 0), total = prizes.reduce((sum, pr) => sum + Math.max(0, Number(pr.weight) || 0), loss);
      const pct = weight => total ? (weight / total * 100).toFixed(1) + "%" : "0%";
      probability.textContent = "Probabilidad: " + prizes.map(pr => (pr.label.trim() || "Premio") + " " + pct(pr.weight)).concat("Sigue participando " + pct(loss)).join(" · ");
    }
    lose.addEventListener("input", paintProbability);
    paintPrizes();

    const form = h("form", { novalidate: true, class: "card" }, sectioned([
      ["club", "Club", "Enciende el club y elige los juegos.",
      switchField("Club de fidelidad activo", enabled),
      h("div", { class: "switches" },
        h("label", { class: "switch", for: games[0].id }, games[0], h("span", { class: "track", "aria-hidden": "true" }), h("span", { class: "switch-label", text: "Ruleta" })),
        h("label", { class: "switch", for: games[1].id }, games[1], h("span", { class: "track", "aria-hidden": "true" }), h("span", { class: "switch-label", text: "Rasca y gana" }))),
      switchField("Mostrar botón del club en el menú", clubOn),
      field("Texto del botón", clubText, "Máximo 40 caracteres. Si el club está apagado, el botón no se muestra."),
      ],
      ["sellos", "Tarjeta de sellos", "Cuántas visitas necesita el cliente y qué gana.",
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: goal.id, text: "Sellos para el premio" }), goal),
        h("div", { class: "field" }, h("label", { for: rewardExpires.id, text: "Vencimiento del premio (días)" }), rewardExpires,
          h("p", { class: "hint", text: "Recomendado: 90 días. Le avisamos al cliente 5 días antes." }))),
      h("div", { class: "field" }, h("label", { for: reward.id, text: "Premio por completar la tarjeta" }), reward)],
      ["juego", "Juego", "Probabilidad de perder y espera entre jugadas.",
      field("Modo de juego", playMode, "En Solo sellos cada visita validada suma un sello, sin ruleta ni raspadita."),
      h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", { for: lose.id, text: "Peso de “Sigue participando”" }), lose),
        h("div", { class: "field" }, h("label", { for: cooldown.id, text: "Horas entre jugadas" }), cooldown)), probability],
      ["validacion", "Validación de jugadas", "Define cuándo debe confirmarse la presencia en el local.",
      switchField("Exigir PIN del mesero para jugar", requirePin),
      h("p", { class: "hint", text: "Cuando está activo, cada jugada requiere el PIN de un mesero." }),
      !hasCoords ? h("p", { class: "notice", text: "Tu menú no tiene sedes con ubicación: cada jugada pedirá el PIN del mesero" }) : null],
      ["pin", "PIN general (anterior)", "Puedes conservarlo mientras migras a PIN individuales por mesero.",
      h("div", { class: "field" }, h("label", { for: pin.id, text: "PIN general (anterior) (4 dígitos)" }), pin,
        h("p", { class: "hint", text: club.pinSet
          ? "Ya hay un PIN configurado. Escribe uno nuevo solo si quieres cambiarlo; nunca se muestra."
          : "Usa Meseros para crear PIN individuales. Nunca se muestra." }))],
      ["premios", "Premios", "Stock vacío significa ilimitado. Cada premio puede vencer después de emitirse.",
      list,
      btn("+ Agregar premio", "btn small", () => {
        prizes.push({ id: newPrizeId(new Set(prizes.map(p => p.id))), label: "", weight: 10, stock: null, expires_days: 90 });
        paintPrizes();
      }), h("p", { class: "hint", text: "Recomendado: 90 días. Le avisamos al cliente 5 días antes." })],
      ["cumpleanos", "Cumpleaños", "Regalamos un premio a quien cumple años en los próximos días.",
      switchField("Regalar en el cumpleaños", birthdayOn),
      h("div", { class: "grid2" },
        field("Nombre del regalo", birthdayLabel, "Máximo 60 caracteres."),
        field("Vence en (días)", birthdayDays))],
      ["inactivos", "Clientes inactivos", "Invita a volver a quien no visita desde hace un tiempo.",
      switchField("Recuperar clientes inactivos", winbackOn),
      h("div", { class: "grid2" },
        field("Días sin visita", winbackDays, "Mínimo 14 días."),
        field("Vence en (días)", winbackExpires)),
      field("Nombre del regalo", winbackLabel, "Máximo 60 caracteres.")],
      ["despues", "Reseñas y términos", "Lo que ve el cliente después de ganar.",
      field("Enlace para reseñas (opcional)", review, "Debe iniciar con https://."),
      field("Términos del club", terms), termsCount],
      ]),
      h("div", { class: "form-actions" }, save),
      err);
    form.addEventListener("submit", async ev => {
      ev.preventDefault();
      err.textContent = "";
      if (enabled.checked && !reward.value.trim()) { err.textContent = "Escribe el premio por completar la tarjeta."; return; }
      if (pin.value && !/^\d{4}$/.test(pin.value)) { err.textContent = "El PIN debe tener 4 dígitos."; return; }
      if (prizes.some(p => !p.label.trim())) { err.textContent = "Escribe el nombre de cada premio o quítalo."; return; }
      const clean = prizes.map(p => ({ id: p.id, label: p.label.trim(), weight: Math.max(1, Math.floor(p.weight || 1)), stock: p.stock, expires_days: p.expires_days }));
      const selectedGames = games.filter(input => input.checked).map(input => input.value);
      // En Solo sellos los juegos no se usan; sin ninguno marcado se conserva el default del contrato.
      if (!selectedGames.length && playMode.value === "stamps") selectedGames.push("wheel", "scratch");
      if (!selectedGames.length) { err.textContent = "Elige al menos un juego."; return; }
      if (review.value.trim() && !/^https:\/\//i.test(review.value.trim())) { err.textContent = "El enlace de reseñas debe iniciar con https://."; return; }
      if (winbackOn.checked && num(winbackDays.value) < 14) { err.textContent = "Los días sin visita deben ser 14 o más."; return; }
      const body = {
        enabled: enabled.checked,
        require_pin: requirePin.checked,
        play_mode: playMode.value,
        club: { visible: clubOn.checked, label: clubText.value.trim() },
        games: selectedGames,
        lose_weight: Math.max(0, Number(lose.value) || 0),
        cooldown_hours: Math.max(0, Number(cooldown.value) || 0),
        stamps_goal: Math.max(1, Math.floor(Number(goal.value) || 8)),
        stamps_reward: { label: reward.value.trim(), expires_days: rewardExpires.value === "" ? null : Math.max(1, Math.floor(Number(rewardExpires.value) || 1)) },
        stamps_reward_label: reward.value.trim(),
        birthday: {
          enabled: birthdayOn.checked,
          label: birthdayLabel.value.trim(),
          expires_days: Math.max(1, Math.floor(Number(birthdayDays.value) || 14)),
        },
        winback: {
          enabled: winbackOn.checked,
          days: Math.max(14, Math.floor(Number(winbackDays.value) || 30)),
          label: winbackLabel.value.trim(),
          expires_days: Math.max(1, Math.floor(Number(winbackExpires.value) || 14)),
        },
        prizes: clean,
        review_url: review.value.trim() || null,
        terms: terms.value,
      };
      if (pin.value) body.pin = pin.value;
      save.disabled = true;
      save.textContent = "Guardando…";
      const r = await api("loyalty", body, "PATCH");
      save.disabled = false;
      save.textContent = "Guardar fidelidad";
      if (r.status === 200 || r.status === 204) {
        pin.value = "";
        toast("Fidelidad guardada.");
        const m = await api("me");
        if (m.status === 200) applyMe(m.data);
        return loyaltyScreen();
      }
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 402) {
        toast(errMsg(r, "Tu tarjeta de fidelidad no está activa."), true);
        const m = await api("me");
        if (m.status === 200) applyMe(m.data);
        return loyaltyScreen();
      }
      err.textContent = errMsg(r, "No pudimos guardar la fidelidad.");
    });
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Fidelidad" }),
        h("p", { class: "muted small", text: "Sellos, premios y PIN del mesero." }))),
      loyaltySubnav("config"),
      r.status === 404 ? h("p", { class: "hint", text: "El club todavía no está activo en este menú. Guarda para activarlo." }) : null,
      form,
      qrCard(),
      posterCard(club.stamps_goal, club.reward)));
  }

  // Fidelidad con la función apagada por plan: solo la tarjeta de activación.
  function loyaltyLockedScreen() {
    const pay = safeUrl(me && me.loyalty_pay_url);
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Fidelidad" }),
        h("p", { class: "muted small", text: "Tarjeta de sellos para tus clientes." }))),
      h("section", { class: "card" },
        h("h2", { text: "Activa tu tarjeta de fidelidad por USD 5 al mes" }),
        h("p", { class: "muted", text: "Tus clientes juntan sellos en cada visita y vuelven por su premio." }),
        h("ul", { class: "benefits" },
          h("li", { text: "Un sello por cada visita y un premio al completar la tarjeta." }),
          h("li", { text: "Ruleta o raspadita para premiar al instante." }),
          h("li", { text: "Recordatorios de cumpleaños y de clientes que no vuelven." })),
        pay ? h("a", { class: "btn primary", href: pay, target: "_blank", rel: "noopener" }, "Activar ahora") : null,
        h("p", { class: "hint", text: "Se cobra con tarjeta todos los meses. Puedes cancelar cuando quieras." }))));
  }

  function loyaltySubnav(active) {
    const options = [["config", "Configuración", loyaltyScreen], ["staff", "Meseros", loyaltyStaffScreen],
      ["customers", "Clientes", loyaltyCustomersScreen], ["feedback", "Opiniones", loyaltyFeedbackScreen],
      ["stats", "Estadísticas", loyaltyStatsScreen], ["campaigns", "Campañas", loyaltyCampaignsScreen]];
    return h("nav", { class: "subtabs", "aria-label": "Opciones de fidelidad" }, options.map(([id, label, action]) =>
      btn(label, "subtab" + (id === active ? " active" : ""), action, { "aria-current": id === active ? "page" : null })));
  }

  function loyaltyPage(active, title, body, actions) {
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" },
        h("div", {}, h("h1", { text: title }), h("p", { class: "muted small", text: "Club de fidelidad de tu menú." })),
        actions || null),
      loyaltySubnav(active), body));
  }

  function loyaltyStaffScreen() {
    loyaltyPage("staff", "Meseros", staffManager(cajaCard()));
  }

  // La gestión de meseros sirve tanto al club como al modo mesero; la pantalla cambia solo su contenedor y QR.
  function staffManager(modeCard) {
    const name = h("input", { id: uid("staffname"), type: "text", maxlength: "120", autocomplete: "off" });
    const pin = h("input", { id: uid("staffpin"), type: "password", inputmode: "numeric", pattern: "[0-9]*", minlength: "4", maxlength: "6", autocomplete: "new-password", placeholder: "4 a 6 dígitos" });
    const err = h("p", { class: "err", role: "alert" }), list = h("div", { class: "table" });
    let rotating = null;
    const pinOnly = input => input.addEventListener("input", () => { input.value = input.value.replace(/\D/g, "").slice(0, 6); });
    pinOnly(pin);
    const formatDate = value => {
      const date = new Date(Number(value));
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("es-EC", { dateStyle: "short", timeStyle: "short", timeZone: "America/Guayaquil" });
    };
    async function change(staff, body, method = "PUT") {
      const r = await api("loyalty/staff/" + encodeURIComponent(staff.id), body, method);
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status >= 200 && r.status < 300) { toast(method === "DELETE" ? "Mesero desactivado." : "Mesero actualizado."); rotating = null; return load(); }
      err.textContent = errMsg(r, "No pudimos actualizar al mesero.");
    }
    function row(staff) {
      if (rotating === staff.id) {
        const nextPin = h("input", { type: "password", inputmode: "numeric", pattern: "[0-9]*", minlength: "4", maxlength: "6", autocomplete: "new-password", placeholder: "Nuevo PIN" });
        pinOnly(nextPin);
        return h("form", { class: "staff-row" },
          h("strong", { text: staff.name || "Mesero" }),
          h("span", { class: "muted small", text: "Nuevo PIN" }), nextPin, h("span"),
          h("div", { class: "prod-actions" }, btn("Cancelar", "link", () => { rotating = null; paint(items); }), h("button", { type: "submit", class: "btn small primary" }, "Guardar PIN")),
        );
      }
      const active = staff.active !== false && Number(staff.active) !== 0;
      return h("div", { class: "staff-row" },
        h("strong", { text: staff.name || "Mesero" }),
        h("span", { class: "status" + (active ? "" : " off"), text: active ? "Activo" : "Inactivo" }),
        h("span", { class: "small", text: formatDate(staff.created_at) }),
        h("span", { class: "small", text: formatDate(staff.rotated_at) }),
        h("div", { class: "prod-actions" },
          active ? btn("Cambiar PIN", "link", () => { rotating = staff.id; paint(items); }) : null,
          active ? btn("Desactivar", "link danger", () => change(staff, {}, "DELETE")) : btn("Activar", "link", () => change(staff, { active: true }))));
    }
    let items = [];
    function paint(next) {
      items = Array.isArray(next) ? next : [];
      list.replaceChildren(
        h("div", { class: "staff-head" }, h("span", { text: "Nombre" }), h("span", { text: "Estado" }), h("span", { text: "Creado" }), h("span", { text: "Último cambio de PIN" }), h("span")),
        ...(items.length ? items.map(row) : [h("p", { class: "empty", text: "Todavía no hay meseros. Crea el primero para usar PIN individuales." })]));
      const form = list.querySelector("form");
      if (form) form.addEventListener("submit", event => {
        event.preventDefault();
        const nextPin = form.querySelector("input");
        if (!/^\d{4,6}$/.test(nextPin.value)) { err.textContent = "El PIN debe tener entre 4 y 6 dígitos."; return; }
        change(items.find(staff => staff.id === rotating), { pin: nextPin.value });
      });
    }
    async function load() {
      const r = await api("loyalty/staff");
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) return list.replaceChildren(h("p", { class: "empty", text: errMsg(r, "No pudimos cargar los meseros.") }));
      paint(Array.isArray(r.data.items) ? r.data.items : []);
    }
    const create = h("form", { novalidate: true, class: "card" }, sectioned([
      ["nuevo", "Nuevo mesero", "Cada PIN es único para este menú y nunca vuelve a mostrarse.", h("div", { class: "grid2" }, field("Nombre", name), field("PIN (4 a 6 dígitos)", pin))],
    ]), h("div", { class: "form-actions" }, h("button", { type: "submit", class: "btn primary" }, "Crear mesero")), err);
    create.addEventListener("submit", async event => {
      event.preventDefault(); err.textContent = "";
      if (!name.value.trim()) { err.textContent = "Escribe el nombre del mesero."; return; }
      if (!/^\d{4,6}$/.test(pin.value)) { err.textContent = "El PIN debe tener entre 4 y 6 dígitos."; return; }
      const r = await api("loyalty/staff", { name: name.value.trim(), pin: pin.value });
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 201) { name.value = ""; pin.value = ""; toast("Mesero creado."); return load(); }
      err.textContent = errMsg(r, "No pudimos crear el mesero.");
    });
    const content = h("div", {}, create, modeCard || null,
      h("section", { class: "screen" }, h("div", { class: "page-head" }, h("div", {},
        h("h2", { text: "Meseros del menú" }),
        h("p", { class: "muted small", text: "Gestiona quién puede entrar con su PIN." }))), list));
    load();
    return content;
  }

  function meserosTablesScreen() {
    const enabled = h("input", { id: uid("tables"), type: "checkbox", disabled: true });
    const error = h("p", { class: "err", role: "alert" });
    let current = false;
    async function save(next) {
      enabled.disabled = true;
      error.textContent = "";
      const r = await api("tables", { enabled: next }, "PUT");
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 200 && typeof r.data.enabled === "boolean") {
        current = r.data.enabled;
        enabled.checked = current;
        enabled.disabled = false;
        toast(current ? "Ya recibes pedidos de mesa." : "Los pedidos de mesa están apagados.");
        return;
      }
      enabled.checked = current;
      enabled.disabled = false;
      error.textContent = errMsg(r, "No pudimos guardar la configuración de mesas.");
    }
    async function loadTables() {
      const r = await api("tables");
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status === 200 && typeof r.data.enabled === "boolean") {
        current = r.data.enabled;
        enabled.checked = current;
        enabled.disabled = false;
        return;
      }
      error.textContent = errMsg(r, "No pudimos cargar la configuración de mesas.");
    }
    const tables = h("section", { class: "card" },
      h("h2", { text: "Pedidos de mesa" }),
      h("p", { class: "muted", text: "Tus clientes eligen Mesa en el menú y el pedido llega aquí, sin WhatsApp." }),
      switchField("Recibir pedidos de mesa en el panel", enabled, save), error);
    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {},
        h("h1", { text: "Meseros y mesas" }),
        h("p", { class: "muted small", text: "Configura el acceso del equipo y los pedidos para mesa." }))),
      tables, staffManager(meseroCard())));
    loadTables();
  }

  function loyaltyCustomersScreen() {
    const search = h("input", { id: uid("csearch"), type: "search", placeholder: "Buscar por nombre o teléfono", autocomplete: "off" });
    const list = h("div", { class: "club-list" }), page = h("span", { class: "muted small" });
    let offset = 0, total = 0;
    const previous = btn("Anterior", "btn ghost small", () => load(offset - 20));
    const next = btn("Siguiente", "btn ghost small", () => load(offset + 20));
    async function load(nextOffset = 0) {
      offset = Math.max(0, nextOffset); list.replaceChildren(h("p", { class: "muted small", text: "Cargando clientes…" }));
      const r = await api("loyalty/customers?q=" + encodeURIComponent(search.value.trim()) + "&limit=20&offset=" + offset);
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) return list.replaceChildren(h("p", { class: "err", text: errMsg(r, "No pudimos cargar los clientes.") }));
      const items = Array.isArray(r.data.items) ? r.data.items : []; total = Number(r.data.total) || 0;
      list.replaceChildren(...(items.length ? items.map(customer => {
        const row = btn("", "club-row", () => loyaltyCustomerDetail(customer.phone), { "aria-label": "Ver cliente " + (customer.name || customer.phone) });
        row.append(h("div", {}, h("strong", { text: customer.name || "Sin nombre" }), h("span", { text: customer.phone || "" })),
          h("span", { text: (Number(customer.visits) || 0) + " visitas · " + (Number(customer.active_rewards) || 0) + " premios" }));
        return row;
      }) : [h("p", { class: "empty", text: "No hay clientes para esta búsqueda." })]));
      page.textContent = total ? (offset + 1) + "–" + Math.min(offset + items.length, total) + " de " + total : "0 clientes";
      previous.disabled = offset === 0; next.disabled = offset + items.length >= total;
    }
    search.addEventListener("search", () => load(0));
    search.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); load(0); } });
    loyaltyPage("customers", "Clientes", h("section", { class: "card" }, h("div", { class: "search" }, h("label", { class: "sr", for: search.id, text: "Buscar clientes" }), search), list,
      h("div", { class: "club-pagination" }, previous, page, next)),
      btn("Exportar clientes (CSV)", "btn small", exportCustomers));
    load();
  }

  // El CSV lo arma el club; el panel lo descarga con la cookie de la sesión.
  async function exportCustomers() {
    try {
      const response = await fetch("/panel/api/loyalty/customers.csv", { credentials: "same-origin" });
      if (!response.ok) { toast("No pudimos exportar los clientes.", true); return; }
      const href = URL.createObjectURL(await response.blob());
      const link = h("a", { href, download: "clientes-" + String(S.slug || "menu").replace(/[^a-z0-9_-]/gi, "") + ".csv" });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      toast("Descargamos tu lista de clientes.");
    } catch { toast("No pudimos exportar los clientes.", true); }
  }

  async function loyaltyCustomerDetail(phone) {
    loyaltyPage("customers", "Clientes", h("p", { class: "muted small", text: "Cargando cliente…" }));
    const r = await api("loyalty/customers/" + encodeURIComponent(phone));
    if (r.status !== 200) return loyaltyPage("customers", "Clientes", h("p", { class: "err", text: errMsg(r, "No pudimos cargar este cliente.") }));
    const customer = r.data.customer || {}, rewards = Array.isArray(r.data.rewards) ? r.data.rewards : [], plays = Array.isArray(r.data.plays) ? r.data.plays : [];
    loyaltyPage("customers", "Clientes", h("section", { class: "card" }, btn("← Volver a clientes", "back", loyaltyCustomersScreen),
      h("h2", { text: customer.name || "Cliente" }), h("p", { class: "muted small", text: customer.phone || "" }),
      h("div", { class: "kpis" }, h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(customer.visits || 0) }), h("span", { class: "kpi-l", text: "Visitas" })), h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(customer.stamps || 0) }), h("span", { class: "kpi-l", text: "Sellos" }))),
      h("h2", { text: "Premios" }), rewards.length ? h("div", { class: "table" },
        h("div", { class: "club-detail-head" }, h("span", { text: "Premio" }), h("span", { text: "Estado" }), h("span", { text: "Canjeado por" })),
        rewards.map(reward => h("div", { class: "club-detail-row" }, h("strong", { text: reward.label || "Premio" }), h("span", { class: "muted small", text: reward.status || "—" }), h("span", { class: "small", text: reward.redeemed_by || "—" })))) : h("p", { class: "muted small", text: "Todavía no tiene premios." }),
      h("h2", { text: "Jugadas" }), plays.length ? h("div", { class: "table" },
        h("div", { class: "club-detail-head" }, h("span", { text: "Juego" }), h("span", { text: "Fecha" }), h("span", { text: "Sellado por" })),
        plays.map(play => h("div", { class: "club-detail-row" }, h("strong", { text: play.game || "Juego" }), h("span", { class: "muted small", text: new Date(Number(play.created_at)).toLocaleString("es-EC") }), h("span", { class: "small", text: play.staff_name || "—" })))) : h("p", { class: "muted small", text: "Todavía no hay jugadas." })));
  }

  function loyaltyFeedbackScreen() {
    const list = h("div", { class: "table" }), page = h("span", { class: "muted small" }), summary = h("div", { class: "kpis" });
    let offset = 0, total = 0;
    const previous = btn("Anterior", "btn ghost small", () => load(offset - 20));
    const next = btn("Siguiente", "btn ghost small", () => load(offset + 20));
    const formatDate = value => {
      const date = new Date(Number(value));
      return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("es-EC", { dateStyle: "medium", timeZone: "America/Guayaquil" });
    };
    function row(item) {
      return h("div", { class: "op-row" },
        h("strong", { text: item.name || item.phone || "Cliente" }),
        h("span", { class: "order-total", text: (Number(item.rating) || 0) + " / 5" }),
        h("p", { class: "op-note", text: item.comment || "Sin comentario" }),
        h("span", { class: "muted small", text: formatDate(item.created_at) }));
    }
    async function load(nextOffset = 0) {
      offset = Math.max(0, nextOffset);
      list.replaceChildren(h("p", { class: "empty", text: "Cargando opiniones…" }));
      const r = await api("loyalty/feedback?limit=20&offset=" + offset);
      if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (r.status !== 200) return list.replaceChildren(h("p", { class: "empty", text: errMsg(r, "No pudimos cargar las opiniones.") }));
      const items = Array.isArray(r.data.items) ? r.data.items : [];
      total = Number(r.data.total) || 0;
      const avg = Number(r.data.avg);
      summary.replaceChildren(
        h("div", { class: "kpi" },
          h("span", { class: "kpi-n", text: Number.isFinite(avg) && total ? avg.toFixed(1) + " / 5" : "—" }),
          h("span", { class: "kpi-l", text: "Promedio" })),
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(total) }), h("span", { class: "kpi-l", text: "Opiniones" })));
      list.replaceChildren(
        h("div", { class: "op-head" }, h("span", { text: "Cliente" }), h("span", { text: "Nota" }),
          h("span", { text: "Comentario" }), h("span", { text: "Fecha" })),
        ...(items.length ? items.map(row) : [h("p", { class: "empty", text: "Todavía no hay opiniones." })]));
      page.textContent = total ? (offset + 1) + "–" + Math.min(offset + items.length, total) + " de " + total : "0 opiniones";
      previous.disabled = offset === 0; next.disabled = offset + items.length >= total;
    }
    loyaltyPage("feedback", "Opiniones", h("section", { class: "card" },
      h("h2", { text: "Lo que dicen tus clientes" }),
      h("p", { class: "muted small", text: "Solo lo ves tú. El cliente califica su visita desde el club." }),
      summary, list,
      h("div", { class: "club-pagination" }, previous, page, next)));
    load();
  }

  function loyaltyStatsScreen() {
    const controls = h("div", { class: "actions" }), card = h("section", { class: "card" });
    async function load(days) {
      card.replaceChildren(h("p", { class: "muted small", text: "Cargando estadísticas…" }));
      const r = await api("loyalty/stats?days=" + days);
      if (r.status !== 200) return card.replaceChildren(h("p", { class: "err", text: errMsg(r, "No pudimos cargar las estadísticas.") }));
      const data = r.data || {}, series = Array.isArray(data.by_day) ? data.by_day : [], max = Math.max(1, ...series.map(day => Math.max(Number(day.plays) || 0, Number(day.new_customers) || 0)));
      const chart = h("div", { class: "club-chart", role: "img", "aria-label": "Jugadas y clientes nuevos por día" }, series.map(day => h("div", { class: "club-bar", style: "height:" + Math.max(2, Math.max(Number(day.plays) || 0, Number(day.new_customers) || 0) / max * 100) + "%", title: (day.day || "") + ": " + (day.plays || 0) + " jugadas" })));
      card.replaceChildren(h("div", { class: "kpis" },
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(data.customers || 0) }), h("span", { class: "kpi-l", text: "Clientes" })), h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(data.plays || 0) }), h("span", { class: "kpi-l", text: "Jugadas" })),
        h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(data.rewards_issued || 0) }), h("span", { class: "kpi-l", text: "Premios emitidos" })), h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(data.rewards_redeemed || 0) }), h("span", { class: "kpi-l", text: "Premios canjeados" }))), chart);
    }
    [7, 30, 90].forEach(days => controls.append(btn(days + " días", "btn ghost small", () => load(days))));
    loyaltyPage("stats", "Estadísticas", h("div", {}, controls, card)); load(30);
  }

  function loyaltyCampaignsScreen() {
    const title = h("input", { id: uid("ctitle"), type: "text", maxlength: "60" }), body = h("textarea", { id: uid("cbody"), maxlength: "500" });
    const titleCount = h("p", { class: "counter", text: "0/60" }), bodyCount = h("p", { class: "counter", text: "0/500" }), history = h("div", { class: "club-list" }), err = h("p", { class: "err", role: "alert" });
    title.addEventListener("input", () => { titleCount.textContent = title.value.length + "/60"; }); body.addEventListener("input", () => { bodyCount.textContent = body.value.length + "/500"; });
    const send = h("button", { type: "submit", class: "btn primary" }, "Enviar campaña");
    const dateLabel = value => {
      const date = new Date(String(value) + "T12:00:00");
      return Number.isNaN(date.getTime())
        ? String(value || "")
        : date.toLocaleDateString("es-EC", { day: "2-digit", month: "long", year: "numeric" });
    };
    function pick(item) {
      title.value = String(item.title || "").slice(0, 60);
      body.value = String(item.body || "").slice(0, 500);
      titleCount.textContent = title.value.length + "/60";
      bodyCount.textContent = body.value.length + "/500";
      title.focus();
    }
    // Fechas comerciales próximas (las calcula page.js#campaignDates y llegan por window.__panelDates).
    function suggestions() {
      let items = [];
      try { items = typeof datesFn === "function" ? datesFn(new Date()) : []; } catch { items = []; }
      if (!Array.isArray(items) || !items.length) return null;
      return h("section", { class: "card" },
        h("h2", { text: "Fechas que se vienen" }),
        h("p", { class: "muted small", text: "Toca una fecha para cargar el mensaje; después puedes cambiarlo." }),
        h("div", { class: "club-list" }, items.map(item => {
          const row = btn("", "club-row", () => pick(item), { "aria-label": "Usar " + item.title });
          row.append(h("div", {}, h("strong", { text: item.title }), h("span", { text: dateLabel(item.date) })),
            h("span", { text: item.body }));
          return row;
        })));
    }
    async function load() {
      const r = await api("loyalty/campaigns");
      if (r.status !== 200) return history.replaceChildren(h("p", { class: "err", text: errMsg(r, "No pudimos cargar el historial.") }));
      const items = Array.isArray(r.data) ? r.data : [];
      history.replaceChildren(...(items.length ? items.map(campaign => h("article", { class: "campaign" }, h("strong", { text: campaign.title || "Campaña" }), h("p", { class: "muted small", text: campaign.body || "" }), h("span", { class: "muted small", text: "Enviados: " + (campaign.sent || 0) + " · Fallidos: " + (campaign.failed || 0) }))) : [h("p", { class: "muted small", text: "Todavía no has enviado campañas." })]));
    }
    const form = h("form", { novalidate: true }, field("Título", title), titleCount, field("Mensaje", body), bodyCount,
      h("p", { class: "hint", text: "Llega a los clientes que guardaron su tarjeta en Google Wallet." }), send, err);
    form.addEventListener("submit", async event => {
      event.preventDefault(); err.textContent = "";
      if (!title.value.trim() || !body.value.trim()) { err.textContent = "Escribe un título y un mensaje."; return; }
      send.disabled = true; send.textContent = "Enviando…";
      const r = await api("loyalty/campaigns", { title: title.value.trim(), body: body.value.trim() });
      send.disabled = false; send.textContent = "Enviar campaña";
      if (r.status === 200) { title.value = ""; body.value = ""; titleCount.textContent = "0/60"; bodyCount.textContent = "0/500"; toast("Campaña enviada."); return load(); }
      err.textContent = r.status === 429 ? "Ya enviaste una campaña recientemente. Intenta de nuevo después." : errMsg(r, "No pudimos enviar la campaña.");
    });
    loyaltyPage("campaigns", "Campañas", h("div", {}, suggestions(),
      h("section", { class: "card" }, h("h2", { text: "Nueva campaña" }), form),
      h("section", { class: "card" }, h("h2", { text: "Historial" }), history)));
    load();
  }

  /* ── Resultados ── */
  function fmtDay(day) {
    const d = new Date(String(day) + "T12:00:00");
    return Number.isNaN(d.getTime()) ? String(day || "") : d.toLocaleDateString("es-EC", { day: "2-digit", month: "short" });
  }
  function drawQR(cv, text, hi, caption) {
    if (!qrFn) throw new Error("sin_qr");
    const m = qrFn(text), n = m.length, quiet = 4;
    const px = hi ? Math.max(8, Math.ceil(720 / (n + quiet * 2))) : Math.max(3, Math.round(220 / (n + quiet * 2)));
    const size = (n + quiet * 2) * px;
    // El PNG descargable lleva el texto debajo del código; en pantalla se repite como HTML.
    const label = String(caption || "").trim(), scale = hi ? 2 : 1, font = 15 * scale, pad = 14 * scale;
    cv.width = size;
    cv.height = size + (label ? font + pad * 2 : 0);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = "#000";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y][x]) ctx.fillRect((x + quiet) * px, (y + quiet) * px, px, px);
    if (label) {
      ctx.fillStyle = "#1F1D1A";
      ctx.font = "600 " + font + 'px -apple-system, "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, size / 2, size + pad + font / 2);
    }
  }
  function downloadCanvas(cv, name) {
    let href;
    try { href = cv.toDataURL("image/png"); } catch { return toast("No pudimos generar el QR.", true); }
    const a = h("a", { href, download: name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  /* ── Cartel imprimible A6 (1240×1748 px = 300 dpi) ── */
  const POSTER_W = 1240, POSTER_H = 1748;
  function loadImage(url) {
    return new Promise(resolve => {
      const img = new Image();
      let done = false;
      const finish = value => { if (!done) { done = true; resolve(value); } };
      img.crossOrigin = "anonymous";
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      // Si el logo no llega (sin CORS o lento), el cartel usa el nombre del negocio.
      setTimeout(() => finish(null), 2500);
      img.src = url;
    });
  }
  function wrapLines(ctx, text, maxWidth) {
    const words = String(text || "").split(/\s+/).filter(Boolean), lines = [];
    let line = "";
    for (const word of words) {
      const next = line ? line + " " + word : word;
      if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
      else line = next;
    }
    if (line) lines.push(line);
    return lines;
  }
  // Fija la fuente antes de medir: el ajuste de línea depende del tamaño real del texto.
  function paintCentered(ctx, text, y, font, color, gap, maxWidth) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const lines = wrapLines(ctx, text, maxWidth);
    lines.forEach((line, i) => ctx.fillText(line, POSTER_W / 2, y + i * gap));
    return y + lines.length * gap;
  }
  async function drawPoster(cv, spec) {
    if (!qrFn) throw new Error("sin_qr");
    cv.width = POSTER_W; cv.height = POSTER_H;
    const ctx = cv.getContext("2d");
    if (!ctx) throw new Error("sin_canvas");
    const primary = /^#[0-9a-f]{3,8}$/i.test(String(spec.primary || "")) ? spec.primary : "#C4691C";
    const sans = '-apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, POSTER_W, POSTER_H);
    ctx.fillStyle = primary; ctx.fillRect(0, 0, POSTER_W, 360);
    const logo = spec.logo ? await loadImage(spec.logo) : null;
    if (logo) {
      const scale = Math.min(300 / (logo.width || 1), 150 / (logo.height || 1), 1);
      const w = (logo.width || 1) * scale, hh = (logo.height || 1) * scale;
      ctx.drawImage(logo, (POSTER_W - w) / 2, (360 - hh) / 2, w, hh);
    } else {
      paintCentered(ctx, spec.name || "Nuestro negocio", 180, "700 58px " + sans, "#fff", 66, 900);
    }
    let y = paintCentered(ctx, spec.title, 500, "700 72px " + sans, "#1F1D1A", 84, 960);
    if (spec.line) y = paintCentered(ctx, spec.line, y + 40, "500 42px " + sans, "#5C5850", 54, 900);
    // QR grande, centrado y con marco claro.
    const matrix = qrFn(spec.url), n = matrix.length, quiet = 4;
    const unit = Math.max(4, Math.floor(760 / (n + quiet * 2))), size = (n + quiet * 2) * unit;
    const qx = (POSTER_W - size) / 2, qy = Math.max(y + 70, 820);
    ctx.fillStyle = "#fff"; ctx.fillRect(qx - 12, qy - 12, size + 24, size + 24);
    ctx.strokeStyle = "#E3DFD8"; ctx.lineWidth = 4; ctx.strokeRect(qx - 12, qy - 12, size + 24, size + 24);
    ctx.fillStyle = "#000";
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      if (matrix[row][col]) ctx.fillRect(qx + (col + quiet) * unit, qy + (row + quiet) * unit, unit, unit);
    }
    paintCentered(ctx, spec.foot, Math.min(qy + size + 110, POSTER_H - 110), "600 40px " + sans, "#5C5850", 50, 900);
    ctx.fillStyle = primary; ctx.fillRect(0, POSTER_H - 48, POSTER_W, 48);
  }
  async function downloadPoster(kind, info) {
    const club = kind === "caja", cv = document.createElement("canvas");
    const spec = {
      primary: info.primary, logo: info.logo, name: info.name,
      title: club ? "Únete a nuestro club" : "Pide desde tu celular",
      line: club ? "Junta " + info.goal + " sellos y llévate " + info.reward : "Escanea, elige y pide sin esperar.",
      url: info.origin + (club ? "/club" : "/"),
      foot: "Escanea con la cámara de tu celular",
    };
    try {
      await drawPoster(cv, spec);
      downloadCanvas(cv, info.slug + "-cartel-" + kind + ".png");
    } catch { toast("No pudimos generar el cartel.", true); }
  }
  function posterCard(goal, reward) {
    const st = (me && me.store) || {};
    const host = String(S.host || location.host || "").replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const info = {
      origin: host ? "https://" + host : location.origin,
      name: st.store_name || S.slug || "Nuestro negocio",
      logo: safeUrl(st.logo),
      primary: String(st.theme_primary || ""),
      slug: String(S.slug || "menu").replace(/[^a-z0-9_-]/gi, "") || "menu",
      goal: Math.max(1, Math.floor(Number(goal) || 8)),
      reward: String(reward || "").trim() || "tu premio",
    };
    return h("section", { class: "card" },
      h("h2", { text: "Carteles para imprimir" }),
      h("p", { class: "muted small", text: "PNG de 1240 × 1748 px (A6 a 300 dpi). Imprime uno para la caja y otro para las mesas." }),
      h("div", { class: "actions" },
        btn("Descargar cartel para la caja", "btn small", () => downloadPoster("caja", info)),
        btn("Descargar cartel para la mesa", "btn small", () => downloadPoster("mesa", info))));
  }
  // Tarjeta "Tus códigos QR": menú (mesas y redes) y club (caja y mostrador).
  function qrCard() {
    const host = String(S.host || location.host || "").replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const origin = host ? "https://" + host : location.origin;
    const slugName = String(S.slug || "menu").replace(/[^a-z0-9_-]/gi, "") || "menu";
    const items = [
      ["QR del menú", "para mesas y redes", origin + "/", slugName + "-qr-menu.png"],
      ["QR del club", "para caja y mostrador", origin + "/club", slugName + "-qr-club.png"],
    ];
    return h("section", { class: "card" },
      h("h2", { text: "Tus códigos QR" }),
      h("p", { class: "muted small", text: "Imprime el código; el PNG incluye el texto debajo." }),
      h("div", { class: "qr-grid" }, items.map(([title, hint, url, file]) => {
        const cv = h("canvas", { role: "img", "aria-label": title });
        // En pantalla el título va debajo como HTML: el texto dentro del canvas es solo del PNG.
        try { drawQR(cv, url, false); } catch { cv.hidden = true; }
        const download = btn("Descargar PNG", "btn small", () => {
          try {
            const tmp = document.createElement("canvas");
            drawQR(tmp, url, true, title);
            downloadCanvas(tmp, file);
          } catch { toast("No pudimos generar el QR.", true); }
        });
        download.disabled = cv.hidden;
        return h("div", { class: "qr-item" }, cv, h("strong", { text: title }),
          h("span", { class: "hint", text: hint }), h("span", { class: "url", text: url }), download);
      })),
      h("div", { class: "actions" }, h("a", { class: "btn small", href: origin + "/", target: "_blank", rel: "noopener" }, "Ver mi menú")));
  }

  // QR por sede: la misma carta con `?sede=<id>` ya elegida (los IDs son provisionales).
  function sedesQrCard(branches) {
    const host = String(S.host || location.host || "").replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const origin = host ? "https://" + host : location.origin;
    const slugName = String(S.slug || "menu").replace(/[^a-z0-9_-]/gi, "") || "menu";
    const list = (Array.isArray(branches) ? branches : []).filter(branch => branch && branch.id);
    return h("section", { class: "card" },
      h("h2", { text: "QR por sede" }),
      h("p", { class: "muted small", text: "Cada QR abre la misma carta con la sede ya elegida. Imprímelo y pégalo en el food truck. Los IDs de sede son provisionales." }),
      list.length ? h("div", { class: "qr-grid" }, list.map(branch => {
        const url = origin + "/?sede=" + encodeURIComponent(branch.id);
        const title = "QR " + (branch.nombre || branch.id);
        const cv = h("canvas", { role: "img", "aria-label": title });
        try { drawQR(cv, url, false); } catch { cv.hidden = true; }
        const download = btn("Descargar PNG", "btn small", () => {
          try {
            const tmp = document.createElement("canvas");
            drawQR(tmp, url, true, branch.nombre || branch.id);
            downloadCanvas(tmp, slugName + "-qr-" + branch.id + ".png");
          } catch { toast("No pudimos generar el QR.", true); }
        });
        download.disabled = cv.hidden;
        return h("div", { class: "qr-item" }, cv, h("strong", { text: branch.nombre || branch.id }),
          h("span", { class: "hint", text: branch.direccion || "Sede provisional" }), h("span", { class: "url", text: url }), download);
      })) : h("p", { class: "muted small", text: "Agrega al menos una sede para generar sus QR." }));
  }

  // Tarjeta "Modo caja": QR a la página que el mesero abre en su celular (Fidelidad → Meseros).
  function cajaCard() {
    const host = String(S.host || location.host || "").replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const url = (host ? "https://" + host : location.origin) + "/panel/caja";
    const cv = h("canvas", { role: "img", "aria-label": "QR de Modo caja" });
    try { drawQR(cv, url, false); } catch { cv.hidden = true; }
    return h("section", { class: "card" },
      h("h2", { text: "Modo caja" }),
      h("p", { class: "muted small", text: "Ábrelo en el celular del mesero. Entra con su PIN y escanea la tarjeta del cliente." }),
      h("div", { class: "qr-item", style: "max-width:280px;margin-top:14px" }, cv,
        h("span", { class: "url", text: url }),
        h("a", { class: "btn small", href: url, target: "_blank", rel: "noopener" }, "Abrir Modo caja")));
  }

  function meseroCard() {
    const host = String(S.host || location.host || "").replace(/^[a-z]+:\/\//i, "").split("/")[0];
    const url = (host ? "https://" + host : location.origin) + "/panel/mesero";
    const cv = h("canvas", { role: "img", "aria-label": "QR de Modo mesero" });
    try { drawQR(cv, url, false); } catch { cv.hidden = true; }
    return h("section", { class: "card" },
      h("h2", { text: "Modo mesero" }),
      h("p", { class: "muted small", text: "Ábrelo en el celular del mesero; entra con su PIN." }),
      h("div", { class: "qr-item", style: "max-width:280px;margin-top:14px" }, cv,
        h("span", { class: "url", text: url }),
        h("a", { class: "btn small", href: url, target: "_blank", rel: "noopener" }, "Abrir Modo mesero")));
  }

  /* ── Reportes de ventas (POS): cuatro categorías, filtros y conciliación ── */
  const REPORT_LABEL = { sushi: "Sushi", fastfood: "Fast food", tradicional: "Tradicional", postres: "Postres" };
  const isoDay = date => {
    const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, "0"), d = String(date.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  };
  async function reportsScreen() {
    const token = ++viewToken;
    loadingView("Cargando reportes…");
    const sedesResponse = await api("sedes");
    if (token !== viewToken) return;
    if (sedesResponse.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    const sedes = sedesResponse.status === 200 && Array.isArray(sedesResponse.data?.sedes) ? sedesResponse.data.sedes : [];
    const today = new Date(), weekAgo = new Date(Date.now() - 6 * 86400000);
    const fromInput = h("input", { type: "date", value: isoDay(weekAgo), "aria-label": "Desde" });
    const toInput = h("input", { type: "date", value: isoDay(today), "aria-label": "Hasta" });
    const sedeSelect = h("select", { "aria-label": "Sede" },
      h("option", { value: "", text: "Todas las sedes" }),
      ...sedes.map(sede => h("option", { value: String(sede.id || ""), text: String(sede.nombre || sede.id || "") })));
    const result = h("div", { "aria-live": "polite" });
    const error = h("p", { class: "err", role: "alert" });

    const render = data => {
      const groups = Array.isArray(data?.groups) ? data.groups : [];
      const total = Number(data?.total_cents) || 0;
      const bySede = Array.isArray(data?.by_sede) ? data.by_sede : [];
      const unreconciled = Number(data?.unreconciled_cents) || 0;
      const share = cents => (total > 0 ? Math.round((Number(cents) || 0) / total * 1000) / 10 + "%" : "—");
      const groupRows = groups.map(group => h("div", { class: "prod" },
        h("strong", { text: REPORT_LABEL[group.category] || String(group.category) }),
        h("span", { text: String(Number(group.orders) || 0) + " pedidos" }),
        h("span", { text: String(Number(group.quantity) || 0) + " u." }),
        h("span", { class: "prod-price", text: money((Number(group.total_cents) || 0) / 100) }),
        h("span", { class: "muted small", text: share(group.total_cents) })));
      const sedeRows = bySede.map(row => h("div", { class: "prod" },
        h("strong", { text: String(row.sede_id || "Sin sede") }),
        h("span", { text: String(Number(row.orders) || 0) + " pedidos" }),
        h("span", { text: String(Number(row.quantity) || 0) + " u." }),
        h("span", { class: "prod-price", text: money((Number(row.total_cents) || 0) / 100) }),
        h("span", { class: "muted small", text: share(row.total_cents) })));
      result.replaceChildren(
        h("section", { class: "card" },
          h("div", { class: "kpis" },
            h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: money(total / 100) }), h("span", { class: "kpi-l", text: "Cobrado" })),
            h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(Number(data?.orders) || 0) }), h("span", { class: "kpi-l", text: "Pedidos pagados" }))),
          unreconciled !== 0 ? h("p", { class: "err", role: "alert", text: "Diferencia de conciliación: " + money(unreconciled / 100) + ". Revisa las líneas de los pedidos cobrados antes de cerrar caja." }) : null),
        h("h2", { text: "Por categoría" }),
        h("div", { class: "table" },
          h("div", { class: "thead" }, h("span", { text: "Categoría" }), h("span", { text: "Pedidos" }), h("span", { text: "Unidades" }), h("span", { text: "Total" }), h("span", { text: "Participación" })),
          ...groupRows),
        h("h2", { text: "Por sede" }),
        bySede.length ? h("div", { class: "table" },
          h("div", { class: "thead" }, h("span", { text: "Sede" }), h("span", { text: "Pedidos" }), h("span", { text: "Unidades" }), h("span", { text: "Total" }), h("span", { text: "Participación" })),
          ...sedeRows) : h("p", { class: "empty", text: "Sin ventas cobradas en el rango." }));
    };

    const consult = async () => {
      error.textContent = "";
      const from = fromInput.value, to = toInput.value, sede = sedeSelect.value;
      if (!from || !to) { error.textContent = "Elige la fecha inicial y final."; return; }
      const query = "reports/sales?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to) +
        (sede ? "&sede_id=" + encodeURIComponent(sede) : "");
      const response = await api(query);
      if (response.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
      if (response.status !== 200) {
        error.textContent = errMsg(response, "No pudimos cargar el reporte. Revisa las fechas e intenta de nuevo.");
        return;
      }
      render(response.data || {});
    };

    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Reportes" }),
        h("p", { class: "muted small", text: "Solo pedidos cobrados · montos en centavos · hora de Ecuador" }))),
      h("section", { class: "card" },
        h("div", { class: "grid2" },
          h("label", { class: "field" }, h("span", { text: "Desde" }), fromInput),
          h("label", { class: "field" }, h("span", { text: "Hasta" }), toInput),
          h("label", { class: "field" }, h("span", { text: "Sede" }), sedeSelect)),
        h("div", { class: "form-actions" }, btn("Consultar", "btn primary small", consult)),
        error),
      result));
    await consult();
  }

  async function statsScreen() {
    const token = ++viewToken;
    loadingView("Cargando resultados…");
    const [r, clubResponse] = await Promise.all([api("stats?days=30"), api("loyalty")]);
    if (token !== viewToken) return;
    if (r.status === 401) return goLogin("Tu sesión venció. Vuelve a entrar.");
    if (r.status !== 200) return failView(errMsg(r, "No pudimos cargar los resultados."), statsScreen);
    const club = normalizeLoyalty(clubResponse.status === 200 ? clubResponse.data : {});
    const data = r.data || {};
    const days = (Array.isArray(data.days) ? data.days.slice() : []).sort((a, b) => String(a.day).localeCompare(String(b.day)));
    const totals = data.totals || {};
    const views = Number(totals.views) || days.reduce((s, d) => s + (Number(d.views) || 0), 0);
    const orders = Number(totals.orders) || days.reduce((s, d) => s + (Number(d.orders) || 0), 0);
    const max = Math.max(1, ...days.map(d => Math.max(Number(d.views) || 0, Number(d.orders) || 0)));
    const bars = days.map(d => {
      const v = Number(d.views) || 0, o = Number(d.orders) || 0;
      const col = h("div", { class: "bar-col", "aria-hidden": "true", title: fmtDay(d.day) + ": " + v + " visitas, " + o + " pedidos" },
        h("div", { class: "bar v", style: "height:" + Math.round((v / max) * 100) + "%" }),
        h("div", { class: "bar o", style: "height:" + Math.round((o / max) * 100) + "%" }));
      return col;
    });
    const chart = days.length
      ? h("div", { class: "chart" },
        h("div", { class: "legend" },
          h("span", { class: "key", text: "Visitas" }),
          h("span", { class: "key o", text: "Pedidos" })),
        h("div", { class: "bars", role: "img", "aria-label": "Visitas y pedidos de los últimos " + days.length + " días" }, bars),
        h("div", { class: "axis" },
          h("span", { text: fmtDay(days[0].day) }),
          h("span", { text: fmtDay(days[days.length - 1].day) })))
      : h("p", { class: "muted small", text: "Todavía no hay datos de visitas ni pedidos." });

    const loyalty = data.loyalty && typeof data.loyalty === "object" ? data.loyalty : null;

    V.replaceChildren(h("section", { class: "screen" },
      h("div", { class: "page-head" }, h("div", {}, h("h1", { text: "Resultados" }),
        h("p", { class: "muted small", text: "Últimos 30 días · hora de Ecuador" }))),
      h("section", { class: "card" },
        h("div", { class: "kpis" },
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(views) }), h("span", { class: "kpi-l", text: "Visitas" })),
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(orders) }), h("span", { class: "kpi-l", text: "Pedidos" })),
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: views ? (orders / views * 100).toFixed(1) + "%" : "—" }), h("span", { class: "kpi-l", text: "Conversión" })),
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(me.loyalty_enabled ? "Activo" : "Apagado") }), h("span", { class: "kpi-l", text: "Club" }))),
        chart),
      loyalty ? h("section", { class: "card" },
        h("h2", { text: "Club de fidelidad" }),
        h("div", { class: "kpis" },
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(Number(loyalty.customers) || 0) }), h("span", { class: "kpi-l", text: "Clientes del club" })),
          h("div", { class: "kpi" }, h("span", { class: "kpi-n", text: String(Number(loyalty.plays) || 0) }), h("span", { class: "kpi-l", text: "Jugadas" })))) : null,
      qrCard(),
      loyaltyAllowed() ? posterCard(club.stamps_goal, club.reward) : null));
  }

  /* ── arranque ── */
  async function boot() {
    bootView("Cargando tu panel…");
    if (location.pathname === "/panel/reset") return resetScreen();
    const r = await api("me");
    if (r.status === 200) {
      applyMe(r.data);
      return me.must_change_password ? passwordScreen(true) : shell();
    }
    if (r.status === 401) return loginScreen();
    app.replaceChildren(h("div", { class: "screen" },
      h("section", { class: "card" },
        h("h1", { text: "Sin conexión" }),
        h("p", { class: "muted", text: "No pudimos cargar tu panel. Revisa tu internet y vuelve a intentar." }),
        btn("Reintentar", "btn primary", boot))));
  }

  boot();
}

// JSON dentro de <script>: neutraliza el cierre de etiqueta y separadores de línea.
export function jsonInline(obj) {
  return JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// Una sola copia del código cliente: se serializa una vez por isolate.
const QR_SRC = String(qrMatrix);
const DATE_SRC = String(campaignDates);
const TICKET_SRC = String(ticketLines);
const COLUMNS_SRC = String(ticketColumns);
const HEIGHT_SRC = String(ticketPageHeight);
// `shiftTicketLines` es de la parte E y puede no existir todavía en esta rama.
const SHIFT_SRC = typeof ticketKit.shiftTicketLines === "function" ? String(ticketKit.shiftTicketLines) : "";
const MAIN_SRC = String(runtime);

export function renderPage(site) {
  const slug = typeof site === "string" ? site : String(site?.slug ?? "");
  const host = typeof site === "string" ? "" : String(site?.host ?? "");
  const title = "Panel · " + (slug || "menú");
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#E4801C">
<meta name="color-scheme" content="light">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div id="app"><div class="boot" role="status"><span class="spin" aria-hidden="true"></span>Cargando tu panel…</div></div>
<noscript><style>#app{display:none}</style><p style="padding:16px">Activa JavaScript para usar el panel.</p></noscript>
<div id="toast" class="toast" role="status" aria-live="polite"></div>
<script id="panelData">window.__PANEL__=${jsonInline({ slug, host })};</script>
<script id="panelQr">var __name=function(f){return f};var __qr=${QR_SRC};window.__qrPanel=__qr;
var __dates=${DATE_SRC};window.__panelDates=__dates;
var __ticket=${TICKET_SRC};window.__panelTicket=__ticket;
var __columns=${COLUMNS_SRC};window.__panelColumns=__columns;
var __height=${HEIGHT_SRC};window.__panelHeight=__height;${SHIFT_SRC ? `
var __shift=${SHIFT_SRC};window.__panelShiftTicket=__shift;` : ""}</script>
<script id="panelMain">${MAIN_SRC}
runtime();</script>
</body>
</html>`;
}
