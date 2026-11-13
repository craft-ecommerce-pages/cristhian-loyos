// Worker del panel del restaurante (menú SaaS) + conteo de visitas/pedidos.
//   <host>/panel*   → panel del dueño, caja, mesero y cocina
//   <host>/api*     → API pública de pedidos (el menú reenvía /api vía service binding PANEL)
//   <host>/media/*  → media pública desde el binding R2 `MEDIA` (sin dominio externo)
//   /admin/{slug}/* → API para el CRM (Bearer ADMIN_TOKEN), vía workers.dev
// Datos del menú en KV (env.MENUS, lectura/escritura: el edge es dueño del catálogo tras "Entregar").
import { resolveSlug } from "../../worker/src/lib.js";
import { error } from "./contract.js";
import { handleApi, handlePublicApi } from "./api.js";
import { handleAdmin } from "./admin.js";
import { handleDemo, isDemo } from "./demo.js";
import { renderCajaPage } from "./caja.js";
import { handleEvent } from "./events.js";
import { handleInvoiceWebhook } from "./invoices.js";
import { renderKitchenPage } from "./kitchen.js";
import { handleMedia } from "./media.js";
import { renderMeseroPage } from "./mesero.js";
import { handleOrder, handleTableOrder } from "./orders.js";
import { reconcilePendingBendo } from "./bendo.js";
import { renderPage } from "./page.js";

const pageHeaders = {
  "content-type": "text/html;charset=utf-8", "cache-control": "no-cache", "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/")) return handleAdmin(request, env, ctx);
    // Media pública: no depende de sesión ni del slug; solo del bucket del cliente.
    if (url.pathname === "/media" || url.pathname.startsWith("/media/")) return handleMedia(request, env);

    const slug = await resolveSlug(url.hostname, env);
    if (!slug) return error("no_existe", 404);
    const site = { slug, host: url.hostname };
    if (isDemo(slug)) {
      const demo = await handleDemo(request, env, site, pageHeaders);
      if (demo) return demo;
    }

    // Webhook de facturación: público pero firmado; va antes de la sesión del panel.
    if (url.pathname === "/panel/webhooks/invoices") return handleInvoiceWebhook(request, env, site);
    // API pública del comprador: sedes, creación/estado del pedido y retorno de la tarjeta.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handlePublicApi(request, env, ctx, site);
    if (url.pathname === "/panel/e") return handleEvent(request, env, ctx, site);
    if (url.pathname === "/panel/o") return handleOrder(request, env, ctx, site);
    if (url.pathname === "/panel/o/mesa") return handleTableOrder(request, env, ctx, site);
    if (url.pathname.startsWith("/panel/api/")) return handleApi(request, env, ctx, site);
    if (url.pathname === "/panel/caja")
      return new Response(await renderCajaPage(request, env, site), { headers: pageHeaders });
    if (url.pathname === "/panel/cocina" && request.method === "GET")
      return new Response(await renderKitchenPage(request, env, site), { headers: { ...pageHeaders, "cache-control": "private, no-store" } });
    if (url.pathname === "/panel/mesero" && request.method === "GET")
      // Lleva sesión, catálogo y pedidos dentro del HTML: nunca se cachea.
      return new Response(await renderMeseroPage(request, env, site), { headers: { ...pageHeaders, "cache-control": "private, no-store" } });
    if (url.pathname === "/panel" || url.pathname === "/panel/" || url.pathname === "/panel/reset")
      return new Response(renderPage(site), { headers: pageHeaders });
    return error("no_existe", 404);
  },
  // Cron (cada minuto): reconsulta los links de Bendo en `pending/unknown` de las
  // últimas 2 h. Nunca recobra ni publica dos comandas.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(reconcilePendingBendo(env));
  },
};
