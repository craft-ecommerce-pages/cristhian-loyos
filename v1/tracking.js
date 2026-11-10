/* craft-catalog-engine — tracking.js
 * Capa única y opt-in de medición (Meta Pixel, TikTok Pixel, GTM). La cargan catalog.js/cart.js
 * de forma diferida SOLO si config.tracking es un objeto. Bloque soportado en config.json / KV:
 *   "tracking": {
 *     "meta_pixel_id":   "123456789012345",  // solo dígitos
 *     "tiktok_pixel_id": "C9ABCDEF12345",     // alfanumérico
 *     "gtm_container_id": "GTM-ABC123",       // solo el ID: nunca se ejecuta HTML/snippets
 *     "currency":        "USD"                // ISO 4217; default: config.currency si es ISO, "$" => USD
 *   }
 * IDs ausentes o inválidos => ese proveedor no se carga. Sin bloque => cero requests extra.
 * Eventos: PageView, ViewContent, AddToCart, InitiateCheckout, Purchase (event_id para dedup).
 */
(function(root){
  'use strict';
  const PATTERNS = { meta_pixel_id: /^\d{5,20}$/, tiktok_pixel_id: /^[A-Z0-9]{8,32}$/i, gtm_container_id: /^GTM-[A-Z0-9]{4,12}$/i };
  const TIKTOK_SRC = 'https://analytics.tiktok.com/i18n/pixel/events.js';
  const GTM_NAMES = { PageView: 'page_view', ViewContent: 'view_item', AddToCart: 'add_to_cart', InitiateCheckout: 'begin_checkout', Purchase: 'purchase' };
  const inited = new Set(); // proveedor:id ya inicializado en esta página (evita duplicados)

  function normalizeConfig(cfg){
    const t = cfg && typeof cfg.tracking === 'object' && !Array.isArray(cfg.tracking) && cfg.tracking || {};
    const out = {};
    for(const k of ['meta_pixel_id', 'tiktok_pixel_id']){ const v = typeof t[k] === 'string' ? t[k].trim() : ''; out[k] = PATTERNS[k].test(v) ? v : ''; }
    const gtm = typeof (t.gtm_container_id || t.gtm_id) === 'string' ? (t.gtm_container_id || t.gtm_id).trim().toUpperCase() : '';
    out.gtm_container_id = PATTERNS.gtm_container_id.test(gtm) ? gtm : '';
    const iso = v => typeof v === 'string' && /^[A-Z]{3}$/i.test(v.trim()) ? v.trim().toUpperCase() : '';
    out.currency = iso(t.currency) || iso(cfg && cfg.currency) || 'USD';
    return out;
  }

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  // contents acepta ítems del carrito tal cual ({id,nombre,precio,qty}) o ya normalizados.
  function buildPayload(name, detail, tc, eventId){
    detail = detail || {};
    const contents = (Array.isArray(detail.contents) ? detail.contents : []).map(i => ({
      product_id: String(i.product_id ?? i.id ?? ''), name: String(i.name ?? i.nombre ?? ''),
      price: num(i.price ?? i.precio), quantity: num(i.quantity ?? i.qty) || 1,
    })).filter(i => i.product_id);
    const one = contents.length === 1 ? contents[0] : {};
    const p = { event_name: name, event_id: eventId, currency: tc.currency,
      value: detail.value != null ? num(detail.value) : contents.reduce((s, i) => s + i.price * i.quantity, 0), contents };
    if(one.product_id) Object.assign(p, one);
    if(detail.order_id != null && detail.order_id !== '') p.order_id = String(detail.order_id);
    return p;
  }

  function addScript(src){
    const d = root.document;
    if(!d || d.querySelector('script[src="' + src + '"]')) return;
    const s = d.createElement('script'); s.async = true; s.src = src; d.head.appendChild(s);
  }
  // Stubs oficiales (encolan hasta que carga el SDK). Solo se crean si el shell no trajo el suyo.
  function loadMeta(id){
    if(root.__craftMetaPixelID === id) return;
    if(!root.fbq){
      const n = root.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if(!root._fbq) root._fbq = n; n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      addScript('https://connect.facebook.net/en_US/fbevents.js');
    }
    root.fbq('init', id);
    root.__craftMetaPixelID = id;
  }
  function loadTikTok(id){
    if(root.__craftTikTokPixelID === id) return;
    const ttq = root.ttq = root.ttq || [];
    if(!ttq.methods){
      root.TiktokAnalyticsObject = 'ttq';
      ttq.methods = ['page','track','identify','instances','debug','on','off','once','ready','alias','group','enableCookie','disableCookie','holdConsent','revokeConsent','grantConsent'];
      ttq.setAndDefer = (t, e) => { t[e] = function(){ t.push([e].concat(Array.prototype.slice.call(arguments))); }; };
      ttq.methods.forEach(m => ttq.setAndDefer(ttq, m));
      ttq.instance = t => { const e = ttq._i[t] || []; ttq.methods.forEach(m => ttq.setAndDefer(e, m)); return e; };
    }
    ttq._i = ttq._i || {}; ttq._t = ttq._t || {}; ttq._o = ttq._o || {};
    if(!ttq._i[id]){ ttq._i[id] = []; ttq._i[id]._u = TIKTOK_SRC; ttq._t[id] = +new Date(); ttq._o[id] = {}; }
    addScript(TIKTOK_SRC + '?sdkid=' + encodeURIComponent(id) + '&lib=ttq');
    root.__craftTikTokPixelID = id;
  }
  function loadGTM(id){
    root.dataLayer = root.dataLayer || [];
    if(root.__craftGtmLoaded || !root.document || root.document.querySelector('script[src*="gtm.js?id=' + id + '"]')) return;
    root.__craftGtmLoaded = true;
    root.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    addScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(id));
  }

  const newId = () => { try { return root.crypto.randomUUID(); } catch(e){ return 'craft-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } };
  const safe = fn => { try { fn(); } catch(e){} };

  function create(cfg){
    const tc = normalizeConfig(cfg), seen = new Set();
    [['meta_pixel_id', loadMeta], ['tiktok_pixel_id', loadTikTok], ['gtm_container_id', loadGTM]].forEach(([k, load]) => {
      const key = k + ':' + tc[k];
      if(tc[k] && !inited.has(key)){ inited.add(key); safe(() => load(tc[k])); }
    });
    function track(name, detail){
      if(!GTM_NAMES[name]) return null;
	  if(name === 'PageView' && root.__craftPageViewEventID) return root.__craftPageViewEventID;
      // Purchase con order_id => event_id determinista: un reintento que recupera el mismo pedido no duplica.
      const id = String(detail && detail.event_id || (name === 'Purchase' && detail && detail.order_id ? 'purchase-' + detail.order_id : newId()));
      if(seen.has(id)) return id;
      seen.add(id);
	  if(name === 'PageView') root.__craftPageViewEventID = id;
      const p = buildPayload(name, detail, tc, id);
      if(tc.meta_pixel_id && typeof root.fbq === 'function') safe(() => root.fbq('track', name, name === 'PageView' ? {} : {
        content_type: 'product', content_ids: p.contents.map(i => i.product_id), content_name: p.name,
        contents: p.contents.map(i => ({ id: i.product_id, quantity: i.quantity, item_price: i.price })),
        num_items: p.contents.reduce((s, i) => s + i.quantity, 0), value: p.value, currency: p.currency, order_id: p.order_id,
      }, { eventID: id }));
      if(tc.tiktok_pixel_id && root.ttq) safe(() => name === 'PageView' ? root.ttq.page() : root.ttq.track(name, {
        content_type: 'product', contents: p.contents.map(i => ({ content_id: i.product_id, content_name: i.name, quantity: i.quantity, price: i.price })),
        value: p.value, currency: p.currency, order_id: p.order_id,
      }, { event_id: id }));
      if(tc.gtm_container_id && root.dataLayer){
        const ecommerce = { transaction_id: p.order_id, value: p.value, currency: p.currency,
          items: p.contents.map(i => ({ item_id: i.product_id, item_name: i.name, price: i.price, quantity: i.quantity })) };
        if(name !== 'PageView') root.dataLayer.push({ ecommerce: null }); // recomendado por GA4 entre eventos ecommerce
        root.dataLayer.push({ event: GTM_NAMES[name], craft_event: name, event_id: id, craft: p, ...(name === 'PageView' ? {} : { ecommerce }) });
      }
      return id;
    }
    return { track, config: tc };
  }

  root.CraftTracking = { create, normalizeConfig, buildPayload };
  if(typeof module !== 'undefined') module.exports = root.CraftTracking;
})(typeof window !== 'undefined' ? window : globalThis);
