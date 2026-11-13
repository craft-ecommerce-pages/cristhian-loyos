// Lógica pura del Worker de menús (testeable sin el runtime de CF ni el import de HTML).

// Host por defecto de los assets del motor dentro de este Worker (Workers Assets).
// Ningún menú depende de craft-catalog-engine.pages.dev ni de dominios de la cuenta Craft.
export const ENGINE_ORIGIN_DEFAULT = "/v1";

// Prefijos servidos por otro Worker vía service binding (conserva request, Host, método, cuerpo y cookie).
// `/api` y `/media` los sirve el panel: pedidos públicos y objetos R2 del cliente. LOYALTY es opcional:
// si la cuenta del cliente no tiene ese Worker, /club sigue el flujo del menú.
const BINDINGS = [["/panel", "PANEL"], ["/api", "PANEL"], ["/media", "PANEL"], ["/club", "LOYALTY"]];
export function clubBinding(request, env) {
  const path = new URL(request.url).pathname;
  const hit = BINDINGS.find(([p, b]) => (path === p || path.startsWith(p + "/")) && env[b]);
  return hit ? env[hit[1]].fetch(request) : null;
}

// resolveSlug: host del Worker (workers.dev, dominio propio o host de KV) → slug del cliente.
//   1. KV `domain:{host}` → slug (mapping explícito, permite varios menús/hosts).
//   2. `CLIENT_SLUG` como fallback: el Worker solo recibe los hosts que tenga enrutados
//      (workers.dev incluido), así que un despliegue por cliente no necesita sembrar KV.
//   3. Compatibilidad de desarrollo/multimenú sin CLIENT_SLUG: primer label de un host con
//      subdominio. En producción CLIENT_SLUG siempre está definido y este paso no se usa.
export async function resolveSlug(host, env) {
  const slug = typeof env?.CLIENT_SLUG === "string" ? env.CLIENT_SLUG.trim() : "";
  if (host.endsWith(".workers.dev")) return slug || null;
  const mapped = env?.MENUS ? await env.MENUS.get(`domain:${host}`) : null;
  if (mapped) return mapped;
  if (slug) return slug;
  const parts = host.split(".");
  return parts.length >= 3 ? parts[0] : null;
}

// i18n del shell por SSR (opt-in con config.locale="en"): pares exactos texto-es → texto-en sobre el
// template ANTES de inyectar contenido del cliente. Sin locale el HTML sale byte-idéntico.
export const SHELL_EN = [
  ['<html lang="es">', '<html lang="en">'],
  ['aria-label="Cerrar"', 'aria-label="Close"'],
  ['aria-label="Volver"', 'aria-label="Back"'],
  ['aria-label="Favorito"', 'aria-label="Favorite"'],
  ['aria-label="Anterior"', 'aria-label="Previous"'],
  ['aria-label="Siguiente"', 'aria-label="Next"'],
  ['</span> Ver mi carrito</span>', '</span> View cart</span>'],
  ['</svg>\n      Inicio\n', '</svg>\n      Home\n'],
  ['</svg>\n      Ofertas\n', '</svg>\n      Deals\n'],
  ['</svg>\n      Carrito\n', '</svg>\n      Cart\n'],
  ['</svg>\n      Ubicación\n', '</svg>\n      Location\n'],
  ['<h2 id="cartTitle">Tu Pedido</h2>', '<h2 id="cartTitle">Your Order</h2>'],
  ['\n        Realizar pedido\n', '\n        Place order\n'],
  ['data-mode="delivery">Domicilio</button>', 'data-mode="delivery">Delivery</button>'],
  ['data-mode="pickup">Retiro en local</button>', 'data-mode="pickup">Pickup</button>'],
  ['data-mode="mesa">Mesa</button>', 'data-mode="mesa">Dine-in</button>'],
  ['<label for="fieldName">Nombre y Apellido</label>', '<label for="fieldName">Full name</label>'],
  ['placeholder="Ej: María González"', 'placeholder="e.g. John Smith"'],
  ['<label for="fieldPhone">Teléfono</label>', '<label for="fieldPhone">Phone</label>'],
  ['placeholder="Ej: 0991234567"', 'placeholder="e.g. (315) 555-0123"'],
  ['<label for="fieldDocType">Tipo de documento</label>', '<label for="fieldDocType">Document type</label>'],
  ['<option value="cedula">Cédula</option>', '<option value="cedula">ID card</option>'],
  ['<option value="ruc">RUC</option>', '<option value="ruc">Tax ID</option>'],
  ['<label for="fieldDocNumber">Número de documento</label>', '<label for="fieldDocNumber">Document number</label>'],
  ['<label for="fieldEmail">Correo electrónico</label>', '<label for="fieldEmail">Email</label>'],
  ['<label for="fieldBillingAddress">Dirección de facturación</label>', '<label for="fieldBillingAddress">Billing address</label>'],
  ['placeholder="Calle, número y ciudad"', 'placeholder="Street, number and city"'],
  ['Datos para tu comprobante. No se muestran públicamente.', 'Details for your receipt. They are not shown publicly.'],
  ['Cuando tu pedido esté listo te avisaremos por WhatsApp.', 'We will notify you on WhatsApp when your order is ready.'],
  ['<label>Dirección de entrega</label>', '<label>Delivery address</label>'],
  ['placeholder="Sector, calles, número de casa y referencia..."', 'placeholder="Street, number, apt and delivery notes..."'],
  ['<button class="btn-confirm" id="btnConfirm">Confirmar pedido</button>', '<button class="btn-confirm" id="btnConfirm">Confirm order</button>'],
];
const localize = (tpl, locale) => locale === "en" ? SHELL_EN.reduce((h, [es, en]) => h.replaceAll(es, en), tpl) : tpl;

export function render(tpl, cfg, cfgRaw, theme, engineOrigin = ENGINE_ORIGIN_DEFAULT) {
  tpl = localize(tpl, cfg.locale);
  const primary = cfg.theme_primary || (cfg.theme && cfg.theme.primary) || "#E4801C";
  const accent = cfg.theme_accent || (cfg.theme && cfg.theme.accent) || "#F5B301";
  const store = cfg.store_name || "Catálogo";
  // Fuentes del cliente (cada menú trae su combinación). Fallback: las genéricas del engine.
  const fonts = cfg.fonts
    ? `<link href="${esc(cfg.fonts)}" rel="stylesheet"/>`
    : `<link href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet"/>`;
  return tpl
    .replace("<!--TRACKING_HEAD-->", trackingTags(cfg).head)
    .replace("<!--TRACKING_NOSCRIPT-->", trackingTags(cfg).noscript)
    .replaceAll("<!--ENGINE_ORIGIN-->", esc(engineOrigin))
    .replace("<!--TITLE-->", esc(cfg.site_title || store))
    .replace("<!--OG-->", ogTags(cfg, store))
    .replace("<!--FAVICON-->", esc(cfg.favicon || ""))
    .replace("<!--FONTS-->", fonts)
    .replace("<!--VARS-->", `:root{--primary:${esc(primary)};--accent:${esc(accent)}}`)
    .replace("<!--THEME-->", theme) // CSS bespoke del cliente: se inyecta tal cual (confiable)
    .replace("<!--LOGO-->", esc(cfg.logo || ""))
    .replace("<!--HERO_IMAGE-->", esc(cfg.hero_image || ""))
    .replace("<!--BRAND-->", esc(store))
    .replace("<!--BRANDSUB-->", cfg.brand_sub_html ? sanitizeBrandSub(cfg.brand_sub_html) : esc(cfg.brand_sub || ""))
    .replace("<!--DIVIDER-->", cfg.hero_divider ? '<div class="hero-divider"></div>' : "")
    .replace("<!--KICKER-->", cfg.hero_kicker ? `<p class="hero-kicker">${esc(cfg.hero_kicker)}</p>` : "")
    .replace("<!--HERO-->", cfg.hero_title || "") // hero_title admite HTML (lo pone el operador)
    .replace("<!--SEARCHPH-->", esc(cfg.search_placeholder || (cfg.locale === "en" ? "What are you craving?" : "Busca tu antojo...")))
    .replace("<!--COVERAGE-->", Array.isArray(cfg.location?.sedes) && cfg.location.sedes.some(s => s?.id && Number.isFinite(s.lat) && Number.isFinite(s.lng) && s.radio_km > 0)
      ? `<script src="${esc(engineOrigin)}/geo.js" defer></script>` : '')
    .replace("<!--CONFIG-->", `window.__CONFIG__=${jsonInline(cfgRaw)}`);
}

// Preview al compartir el link (WhatsApp/FB/Telegram leen el HTML inicial, no ejecutan JS).
// og_title corto (marca) > site_title (SEO); og_image (JPG/PNG cuadrado ~630px) > logo.
export function ogTags(cfg, store) {
  const img = cfg.og_image || cfg.logo, desc = cfg.og_description;
  return [
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:title" content="${esc(cfg.og_title || cfg.site_title || store)}"/>`,
    desc && `<meta property="og:description" content="${esc(desc)}"/><meta name="description" content="${esc(desc)}"/>`,
    img && `<meta property="og:image" content="${esc(img)}"/>`,
  ].filter(Boolean).join("");
}

// Las etiquetas se renderizan en el HTML inicial: Pixel Helper las detecta y
// el motor conserva fallback dinámico para catálogos legacy estáticos.
export function trackingTags(cfg) {
  const t = cfg?.tracking || {};
  const meta = validMetaPixelID(t.meta_pixel_id) ? t.meta_pixel_id : "";
  const tiktok = validTikTokPixelID(t.tiktok_pixel_id) ? t.tiktok_pixel_id : "";
  const gtm = validGTMID(t.gtm_container_id) ? t.gtm_container_id : "";
  const head = [];
  const noscript = [];
  if (gtm) {
    const id = JSON.stringify(gtm);
    head.push(`<!-- Google Tag Manager --><script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});w.__craftGtmLoaded=true;var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${id});</script><!-- End Google Tag Manager -->`);
    noscript.push(`<!-- Google Tag Manager (noscript) --><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${esc(gtm)}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript><!-- End Google Tag Manager (noscript) -->`);
  }
  if (meta) {
    const id = JSON.stringify(meta);
    head.push(`<!-- Meta Pixel Code --><script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${id});window.__craftMetaPixelID=${id};</script><!-- End Meta Pixel Code -->`);
    noscript.push(`<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${esc(meta)}&ev=PageView&noscript=1"/></noscript>`);
  }
  if (tiktok) {
    const id = JSON.stringify(tiktok);
    head.push(`<!-- TikTok Pixel Code --><script>!function(w,d,t){w.TiktokAnalyticsObject=t;var q=w[t]=w[t]||[];q.methods=['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];q.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat([].slice.call(arguments,0)))}};for(var i=0;i<q.methods.length;i++)q.setAndDefer(q,q.methods[i]);q.load=function(e){var r='https://analytics.tiktok.com/i18n/pixel/events.js';q._i=q._i||{},q._i[e]=[],q._i[e]._u=r,q._t=q._t||{},q._t[e]=+new Date,q._o=q._o||{},q._o[e]={};var n=d.createElement('script');n.type='text/javascript',n.async=!0,n.src=r+'?sdkid='+e+'&lib='+t;d.getElementsByTagName('script')[0].parentNode.insertBefore(n,d.getElementsByTagName('script')[0])};q.load(${id});w.__craftTikTokPixelID=${id}}(window,document,'ttq');</script><!-- End TikTok Pixel Code -->`);
  }
  return { head: head.join("\n"), noscript: noscript.join("\n") };
}

const validMetaPixelID = (id) => typeof id === "string" && /^\d{5,20}$/.test(id);
const validTikTokPixelID = (id) => typeof id === "string" && /^[A-Za-z0-9]{8,32}$/.test(id);
const validGTMID = (id) => typeof id === "string" && /^GTM-[A-Z0-9]{4,12}$/.test(id);

export function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// esc: escapa para contexto HTML. El config lo edita el operador, pero escapamos por higiene.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Solo permite spans de color usados por la identidad de marca; cualquier otro HTML
// se trata como texto. Así brand_sub_html no se convierte en un bypass de XSS.
export function sanitizeBrandSub(raw) {
  const token = /<span style="color:(#fff|var\(--primary\))">([^<>]*)<\/span>/g;
  const parts = String(raw).split(token);
  if (parts.length === 1 && /[<>]/.test(String(raw))) return esc(raw);
  let html = "";
  for (let i = 0; i < parts.length; i += 3) {
    html += esc(parts[i]);
    if (i + 2 < parts.length) html += `<span style="color:${parts[i + 1]}">${esc(parts[i + 2])}</span>`;
  }
  return html;
}

const jsonType = "application/json;charset=utf-8";
const ok = (type, body) => ({ status: 200, headers: { "content-type": type, "cache-control": "public, max-age=60" }, body });
// HTML del menú: no-cache (revalida siempre) para que la página siempre referencie la versión
// vigente del motor (catalog.js?v=...). Sin esto, un HTML cacheado apunta a un catalog.js viejo
// y el cliente no recibe fixes del motor hasta que expire la caché.
const okHtml = (body) => ({ status: 200, headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache, must-revalidate" }, body });
// Recibo /gracias: contiene el número de pedido y acciones de pago. Nunca se cachea ni se indexa,
// y no filtra el token por Referer al abrir WhatsApp o la pasarela de pago.
const receiptHtml = (body) => ({ status: 200, headers: {
  "content-type": "text/html;charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex, nofollow",
  "x-content-type-options": "nosniff",
}, body });
// Retorno antiguo a "/" con pedido y token: mover al recibo conservando el resultado.
// Solo actúa con ambos parámetros presentes; el resto de query legacy sigue intacto.
export function receiptRedirect(pathname, search) {
  if (pathname !== "/" && pathname !== "/index.html") return null;
  let params;
  try { params = new URLSearchParams(search || ""); } catch { return null; }
  const id = (params.get("pedido") || params.get("order") || params.get("order_id") || "").trim();
  const token = (params.get("token") || params.get("order_token") || "").trim();
  if (!id || !token || id.length > 100 || token.length > 200) return null;
  const query = new URLSearchParams({ pedido: id, token });
  const payment = (params.get("pago") || params.get("payment") || "").trim();
  if (payment) query.set("pago", payment);
  return "/gracias?" + query.toString();
}
const notFound = () => ({ status: 404, headers: {}, body: "No existe" });

// handle: enruta una petición ya parseada → {status, headers, body} (index.js lo envuelve en
// Response). Puro salvo por env.MENUS.get → testeable sin el runtime de CF ni el import de HTML.
export async function handle(url, env, template) {
  const slug = await resolveSlug(url.hostname, env);
  if (!slug) return notFound();

  // Datos JSON (comunes a menú y tienda): el app.js del cliente los baja en runtime.
  if (url.pathname === "/productos.json" || url.pathname === "/config.json") {
    const key = url.pathname === "/config.json" ? "config" : "productos";
    const data = await env.MENUS.get(`${slug}:${key}`);
    return ok(jsonType, data == null ? (key === "productos" ? "[]" : "{}") : data);
  }

  // Tienda bespoke: HTML/CSS/JS autorado (multi-página) servido estático desde {slug}:site.
  // Las imágenes NO pasan por aquí — van al R2 de la cuenta del cliente por URL absoluta.
  const siteRaw = await env.MENUS.get(`${slug}:site`);
  if (siteRaw != null) {
    const file = siteFile(safeParse(siteRaw), url.pathname);
    return file ? ok(file.type, file.body) : notFound();
  }

  // Menú config-driven: render del template único con la config del cliente.
  const cfgRaw = await env.MENUS.get(`${slug}:config`);
  if (cfgRaw == null) return notFound();
  const isReceipt = url.pathname === "/gracias" || url.pathname === "/gracias/";
  // Retorno antiguo a "/?pedido=…&token=…" → /gracias sin pasar por JS (evita flash y
  // conserva el pedido si el cliente recarga). Las rutas legacy siguen redirigiendo a "/".
  if (!isReceipt) {
    const target = receiptRedirect(url.pathname, url.search);
    if (target) return { status: 302, headers: { location: target, "cache-control": "no-store" }, body: "" };
  }
  // El menú vive solo en "/" y el recibo en "/gracias"; cualquier otra ruta, p.ej. URLs viejas de un
  // sitio bespoke (/pages/contacto.html), rompería la carga → 301 a "/" con su query.
  if (!isReceipt && url.pathname !== "/" && url.pathname !== "/index.html") return { status: 301, headers: { location: "/" + url.search }, body: "" };
  const theme = (await env.MENUS.get(`${slug}:theme`)) || "";
  const html = render(template, safeParse(cfgRaw), cfgRaw, theme, env.ENGINE_ORIGIN || undefined);
  return isReceipt ? receiptHtml(html) : okHtml(html);
}

// siteFile: elige el archivo del mapa de la tienda para un pathname, con índice de directorio
// (como Pages): "/" y "/dir/" → …/index.html; "/dir" sin extensión → "/dir/index.html".
export function siteFile(site, pathname) {
  let path = pathname.endsWith("/") ? pathname + "index.html" : pathname;
  if (site[path] == null && !path.slice(1).includes(".")) path += "/index.html";
  const body = site[path];
  return body == null ? null : { body, type: contentType(path) };
}

export function contentType(path) {
  if (path.endsWith(".css")) return "text/css;charset=utf-8";
  if (path.endsWith(".js")) return "application/javascript;charset=utf-8";
  if (path.endsWith(".json")) return jsonType;
  return "text/html;charset=utf-8";
}

// jsonInline: el JSON crudo va dentro de <script>. Neutraliza "</script>" y separadores de línea JS.
export function jsonInline(raw) {
  return raw.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}
