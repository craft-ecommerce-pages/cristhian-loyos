import TEMPLATE from "../template.html";
import { clubBinding, handle } from "./lib.js";

// Worker de menú del cliente. Sirve TODOS los menús/tiendas desde KV, ruteando por host:
//   <worker>.<cuenta>.workers.dev → slug = env.CLIENT_SLUG
//   dominio propio (CNAME/custom domain) → KV domain:{host} (o CLIENT_SLUG como fallback)
// Dos modos por slug (ver handle en lib.js):
//   · menú config-driven → KV {slug}:config|:productos|:theme, render del template único
//   · tienda bespoke      → KV {slug}:site (mapa path→HTML/CSS/JS autorado), servido estático
// Los assets del motor (/v1/catalog.js, catalog.css, geo.js) se sirven desde Workers Assets
// de este mismo Worker; no dependen de craft-catalog-engine.pages.dev.
// Imágenes → R2 de la cuenta del cliente (URL absoluta, NO pasan por el Worker).

export default {
  async fetch(request, env) {
    const club = clubBinding(request, env);
    if (club) return club;
    const { status, headers, body } = await handle(new URL(request.url), env, TEMPLATE);
    return new Response(body, { status, headers });
  },
};
