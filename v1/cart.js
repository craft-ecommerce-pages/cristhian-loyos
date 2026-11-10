/* craft-catalog-engine — cart.js
 * Carrito headless compartido: estado, persistencia, drawer, checkout WhatsApp (2 pasos opcional).
 * NO renderiza productos ni cards: eso es bespoke de cada tienda. Tras cada cambio emite
 * document dispatch 'cart:change' (detail:{items}) para que la tienda refresque sus botones.
 *
 * Uso en la tienda (tras cargar products/config):
 *   CraftCart.init({ products, config, storageKey:'ay_cart' });
 *   // botón agregar simple:  <button data-add="ID">   |  variante: la tienda llama CraftCart.add(id, variantes, qty)
 *   document.addEventListener('cart:change', refreshMyCards);
 *
 * DOM esperado (todos opcionales salvo el drawer): cartFab/navCartBtn (abrir), cartBadge/navCartBadge,
 * cartOverlay, cartDrawer, cartClose, cartItems, cartTotal, cartItemCount, btnCheckout.
 * Checkout 2 pasos (opt-in, solo si existe #cartStep2): cartStep2, cartBack, cartTitle,
 * fieldName, fieldPhone, fieldAddressWrap+fieldAddress, deliveryToggle(.dtog-btn[data-mode]), btnConfirm.
 */

// ── helpers puros (sin DOM, exportables para test) ─────────────────────────
function variantOptDisplay(o){ return o && typeof o === 'object' ? (o.label || o.name || '') : (o || ''); }

function cartKey(id, v){
  if(!v || !Object.keys(v).length) return String(id);
  return id + ':' + Object.entries(v).sort().map(([k,val]) => k + '=' + variantOptDisplay(val)).join(',');
}

function promoOf(p){
  const pr = Number(p && p.precio_promo) || 0, base = Number(p && p.precio) || 0;
  return (pr > 0 && pr < base) ? pr : null;
}

function resolveVariantPrice(p, variantes){
  if(p && variantes) for(const val of Object.values(variantes))
    if(val && typeof val === 'object' && val.price != null) return Number(val.price);
  return promoOf(p) ?? (Number(p && p.precio) || 0);
}

// locale opcional (config.price_locale/price_decimals): COP '$22.900', PEN 'S/ 22.90'. Sin locale = formato histórico.
function formatPrice(n, currency, locale, decimals){
  if(!locale) return `${currency || '$'}${Number(n).toFixed(2)}`;
  const d = decimals ?? 0;
  return `${currency || '$'}${Number(n).toLocaleString(locale, {minimumFractionDigits:d, maximumFractionDigits:d})}`;
}

const cartTotalQty   = items => items.reduce((s,i) => s + i.qty, 0);
const cartTotalPrice = items => items.reduce((s,i) => s + i.precio * i.qty, 0);

// Arma el texto del pedido para WhatsApp. fields: {name, phone, mode, address}.
function buildOrderMessage(items, config, fields){
  const cur = config.currency || '$';
  const line = i => {
    const vL = i.variantes ? Object.values(i.variantes).map(variantOptDisplay).filter(Boolean).join(' · ') : '';
    return `▸ ${i.nombre}${vL ? ' (' + vL + ')' : ''}\n  ${i.qty} × ${formatPrice(i.precio,cur,config.price_locale,config.price_decimals)} = ${formatPrice(i.qty*i.precio,cur,config.price_locale,config.price_decimals)}`;
  };
  const title = config.order_title || (config.store_name ? `PEDIDO ${config.store_name.toUpperCase()}` : 'PEDIDO');
  let msg = `${config.whatsapp_message || 'Hola! Quiero hacer un pedido:'}\n\n*${title}*\n━━━━━━━━━━━━━━━\n`;
  msg += items.map(line).join('\n') + '\n';
  msg += `━━━━━━━━━━━━━━━\n*TOTAL: ${formatPrice(cartTotalPrice(items),cur,config.price_locale,config.price_decimals)}*\n`;
  if(fields && (fields.name || fields.phone || fields.address)){
    msg += '\n';
    if(fields.mode) msg += `*ENTREGA:* ${fields.mode === 'delivery' ? 'Domicilio' : 'Retiro en local'}\n`;
    if(fields.name)    msg += `*Cliente:* ${fields.name}\n`;
    if(fields.phone)   msg += `*Teléfono:* ${fields.phone}\n`;
    if(fields.address) msg += `*Dirección:* ${fields.address}\n`;
  }
  return msg;
}

// ── wiring de navegador ────────────────────────────────────────────────────
if(typeof document !== 'undefined'){ (function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { items: [], products: [], config: {}, storageKey: 'craft_cart' };
  const orderScriptURL = new URL('order-checkout.js', document.currentScript.src).href;
  let checkoutBusy = false;
  async function orderCheckout(){
    if(window.CraftOrderCheckout) return window.CraftOrderCheckout;
    await (window.craftOrderLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = orderScriptURL;
      script.onload = resolve; script.onerror = () => { window.craftOrderLoading = null; script.remove(); reject(new Error('No se pudo cargar el registro. Reintenta.')); };
      document.head.append(script);
    }));
    return window.CraftOrderCheckout;
  }
  const geoScriptURL = new URL('geo.js', document.currentScript.src).href;
  // Tracking opt-in: tracking.js se carga solo si config.tracking existe; los eventos previos a la carga se encolan.
  const trackingScriptURL = new URL('tracking.js', document.currentScript.src).href;
  let tracker = null, trackQueue = [];
  const track = (name, detail) => { try { tracker ? tracker.track(name, detail) : trackQueue?.push([name, detail]); } catch(e){} };
  function initTracking(){
    if(!state.config.tracking || typeof state.config.tracking !== 'object'){ trackQueue = null; return; }
    const ready = () => { try { tracker = window.CraftTracking.create(state.config); tracker.track('PageView'); trackQueue.forEach(e => tracker.track(...e)); } catch(e){ tracker = null; } trackQueue = null; };
    if(window.CraftTracking) return ready();
    const s = document.createElement('script'); s.src = trackingScriptURL; s.onload = ready; s.onerror = () => { trackQueue = null; }; document.head.append(s);
  }
  function view(id){
    const p = state.products.find(x => String(x.id) === String(id));
    if(p) track('ViewContent', { contents: [{ id: p.id, nombre: p.nombre, precio: resolveVariantPrice(p) }] });
  }
  let coverage = null;
  const needsCoverage = () => Array.isArray(state.config.location?.sedes) && state.config.location.sedes.some(s => s?.lat != null && s?.lng != null && Number(s.radio_km) > 0);
  function requireCoverage(){
    if(!needsCoverage()) return true;
    if(coverage) return coverage.require();
    toast('No se pudo comprobar la cobertura. Recarga para reintentar.'); return false;
  }
  let toastTimer;

  const cur = () => state.config.currency || '$';
  const fmt = n => formatPrice(n, cur(), state.config.price_locale, state.config.price_decimals);
  const find = key => state.items.find(i => i.key === key);
  const save = () => { try{ localStorage.setItem(state.storageKey, JSON.stringify(state.items)); }catch(e){} };

  function emit(){ document.dispatchEvent(new CustomEvent('cart:change', { detail: { items: state.items } })); }

  function toast(msg){
    const t = $('toast'); if(!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function add(id, variantes, qty){
    const p = state.products.find(x => String(x.id) === String(id));
    if(!p) return;
    qty = qty || 1;
    const key = cartKey(id, variantes), ex = find(key);
    if(ex){ ex.qty += qty; }
    else{
      const imgs = Array.isArray(p.imagenes) && p.imagenes.length ? p.imagenes : [p.imagen || ''];
      state.items.push({ key, id, nombre: p.nombre, precio: resolveVariantPrice(p, variantes), qty, variantes: variantes || {}, imagen: imgs[0] });
    }
    commit(); toast(`${p.nombre} agregado`);
    track('AddToCart', { contents: [{ ...find(key), qty }] });
  }
  function removeOne(key){
    const it = find(key); if(!it) return;
    if(--it.qty <= 0) state.items = state.items.filter(i => i.key !== key);
    commit();
  }
  function del(key){ state.items = state.items.filter(i => i.key !== key); commit(); }
  function commit(){ save(); renderDrawer(); emit(); }
  // Pedido enviado: vaciar el carrito para que al volver al menú no reaparezca.
  function clearCart(){ state.items = []; commit(); }

  function renderDrawer(){
    const qty = cartTotalQty(state.items);
    const badge = v => { const el = $(v); if(el){ el.textContent = qty; el.classList.toggle('show', qty > 0); } };
    badge('cartBadge'); badge('navCartBadge');
    const total = $('cartTotal');     if(total) total.textContent = fmt(cartTotalPrice(state.items));
    const count = $('cartItemCount');  if(count) count.textContent = `${qty} producto${qty !== 1 ? 's' : ''}`;
    const co = $('btnCheckout');       if(co) co.disabled = qty === 0;
    const box = $('cartItems');        if(!box) return;
    if(!state.items.length){ box.innerHTML = '<div class="cart-empty"><p>Tu carrito está vacío</p></div>'; return; }
    box.innerHTML = state.items.map(it => {
      const vL = it.variantes ? Object.values(it.variantes).map(variantOptDisplay).filter(Boolean).join(' · ') : '';
      return `<div class="cart-item">
        <img src="${it.imagen || ''}" alt="${it.nombre}" onerror="this.style.opacity=0"/>
        <div class="cart-item-info">
          <div class="cart-item-name">${it.nombre}</div>
          ${vL ? `<div class="cart-item-detail">${vL}</div>` : ''}
          <div class="cart-item-detail">${it.qty} × ${fmt(it.precio)} = ${fmt(it.qty*it.precio)}</div>
        </div>
        <button class="cart-item-remove" data-key="${it.key}">✕</button>
      </div>`;
    }).join('');
  }

  // drawer open/close + 2 pasos
  const drawer = () => $('cartDrawer');
  function open(){ $('cartOverlay')?.classList.add('open'); drawer()?.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function close(){ $('cartOverlay')?.classList.remove('open'); drawer()?.classList.remove('open'); document.body.style.overflow = ''; step1(); }
  function step1(){
    const s2 = $('cartStep2'); if(!s2) return;
    if($('cartItems')) $('cartItems').style.display = '';
    drawer()?.querySelector('.cart-footer')?.style.setProperty('display', '');
    s2.style.display = 'none';
    if($('cartTitle')) $('cartTitle').textContent = 'Mi carrito';
    if($('cartBack')) $('cartBack').style.display = 'none';
  }
  function step2(){
    if(!state.items.length) return;
    track('InitiateCheckout', { contents: state.items });
    const s2 = $('cartStep2'); if(!s2){ checkout(); return; }  // sin form → checkout directo
    if($('cartItems')) $('cartItems').style.display = 'none';
    drawer()?.querySelector('.cart-footer')?.style.setProperty('display', 'none');
    s2.style.display = 'flex';
    // El motor no trae CSS propio (cada shell pone el suyo): sin declarar la
    // dirección, flex queda en `row` y los campos del paso 2 salen en fila
    // horizontal. catalog.css lo declara; los shells de tienda no.
    s2.style.flexDirection = 'column';
    if($('cartTitle')) $('cartTitle').textContent = 'Datos de entrega';
    if($('cartBack')) $('cartBack').style.display = '';
  }

  async function checkout(){
      if(checkoutBusy) return;
    // Ubicación solo a domicilio, al confirmar (ya elegido el modo).
    if((document.querySelector('.dtog-btn.active')?.dataset.mode || 'delivery') === 'delivery' && !requireCoverage()) return;
    const num = coverage ? coverage.phone() : (state.config.whatsapp_number || '').replace(/\D/g, '');
    if(!num){ alert('Número de WhatsApp no configurado'); return; }
    if(!state.items.length) return;
    let fields = null;
    if($('cartStep2')){
      const name = $('fieldName')?.value.trim() || '';
      const phone = $('fieldPhone')?.value.trim() || '';
      const mode = document.querySelector('.dtog-btn.active')?.dataset.mode || 'delivery';
      const address = mode === 'delivery' ? ($('fieldAddress')?.value.trim() || '') : '';
      if(!name || !phone){ toast('Completa tu nombre y teléfono'); return; }
      if(mode === 'delivery' && !address){ toast('Ingresa tu dirección de entrega'); return; }
      fields = { name, phone, mode, address };
    }
    const payload = {
      token: state.config.catalog_notify_token, store_name: state.config.store_name || 'Tienda',
      items: state.items.map(i => ({ nombre: i.nombre, qty: i.qty, precio: i.precio,
        variant: Object.values(i.variantes || {}).map(variantOptDisplay).join(' / ') || undefined })),
      total: cartTotalPrice(state.items), currency: state.config.currency || '$',
      client_name: fields?.name || '', client_phone: fields?.phone || '', delivery_mode: fields?.mode || 'delivery',
      address: fields?.address || undefined, store_url: location.href,
      latitude: coverage?.coordinates?.lat, longitude: coverage?.coordinates?.lng,
    };
    const msg = buildOrderMessage(state.items, state.config, fields) + (coverage ? coverage.note() : '') + `\n${location.href}`;
      if(state.config.catalog_notify_url && state.config.catalog_notify_token){
        checkoutBusy = true;
        const button = document.getElementById('btnConfirm') || document.getElementById('btnCheckout');
        const label = button?.textContent;
        if(button){ button.disabled = true; button.textContent = 'Registrando pedido…'; }
        try {
          const checkout = await orderCheckout();
          await checkout.submit({url:state.config.catalog_notify_url,payload,phone:num,message:msg,
            container:document.getElementById('cartStep2') || document.getElementById('cartDrawer') || document.body,
            onSuccess: receipt => { track('Purchase', { contents: state.items, value: payload.total, order_id: receipt.id }); trackCheckout(); receipt.reset(); clearCart(); }});
        } catch(error) { toast(error.name === 'AbortError' ? 'La conexión tardó demasiado. Reintenta para recuperar tu número.' : error.message || 'No se pudo registrar el pedido. Reintenta.'); }
        finally { checkoutBusy = false; if(button){ button.disabled = false; button.textContent = label; } }
        return;
      }
    // Sin registro en craft-crm: el "envío" es abrir wa.me; popup bloqueado (null) => sin Purchase.
    if(window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`, '_blank')){ track('Purchase', { contents: state.items, value: payload.total }); trackCheckout(); clearCart(); }
    function trackCheckout(){
    if(window.dataLayer) window.dataLayer.push({ event: 'whatsapp_checkout', ecommerce: {
      value: cartTotalPrice(state.items), currency: 'USD',
      items: state.items.map(i => ({ item_id: i.id, item_name: i.nombre, quantity: i.qty, price: i.precio }))
    }});
    }
  }

  // delegación de eventos genéricos (markup bespoke, handlers genéricos)
  document.addEventListener('click', e => {
    const rm = e.target.closest('.cart-item-remove'); if(rm){ e.stopPropagation(); del(rm.dataset.key); return; }
    const v = e.target.closest('[data-open]'); if(v) view(v.dataset.open); // convención de los shells: [data-open] abre el modal
    const a = e.target.closest('[data-add]'); if(a){ e.preventDefault(); add(a.dataset.add, {}, 1); return; }
    const q = e.target.closest('[data-action]');
    if(q){ e.stopPropagation(); const { action, id, key } = q.dataset;
      if(action === 'inc') add(id, {}, 1); if(action === 'dec' && key) removeOne(key); return; }
  });

  function bind(){
    $('cartFab')?.addEventListener('click', open);
    $('navCartBtn')?.addEventListener('click', open);
    $('cartOverlay')?.addEventListener('click', close);
    $('cartClose')?.addEventListener('click', close);
    $('btnCheckout')?.addEventListener('click', step2);   // sin #cartStep2, step2() cae a checkout directo
    $('cartBack')?.addEventListener('click', step1);
    $('btnConfirm')?.addEventListener('click', checkout);
    $('deliveryToggle')?.addEventListener('click', e => {
      const btn = e.target.closest('.dtog-btn'); if(!btn) return;
      document.querySelectorAll('.dtog-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const wrap = $('fieldAddressWrap');
      if(wrap) wrap.style.display = btn.dataset.mode === 'delivery' ? '' : 'none';
    });
    document.addEventListener('keydown', e => { if(e.key === 'Escape') close(); });
  }

  function init({ products, config, storageKey } = {}){
    state.products = products || [];
    state.config = config || {};
    if(needsCoverage()){
      const ready = () => { coverage = window.CraftGeo.create(state.config, { mount: $('fieldAddressWrap') }); };
      if(window.CraftGeo) ready();
      else{
        const script = document.createElement('script'); script.src = geoScriptURL;
        script.onload = ready; script.onerror = () => toast('No se pudo cargar la ubicación. Recarga para reintentar.');
        document.head.append(script);
      }
    }
    if(storageKey) state.storageKey = storageKey;
    try{ const s = JSON.parse(localStorage.getItem(state.storageKey) || '[]'); if(Array.isArray(s)) state.items = s; }catch(e){}
    // descarta ítems de productos que ya no existen
    state.items = state.items.filter(ci => state.products.find(p => String(p.id) === String(ci.id)));
    bind(); renderDrawer(); emit(); initTracking();
  }

  window.CraftCart = { init, add, removeOne, del, open, close, view, formatPrice: fmt, get items(){ return state.items; } };
})(); }

// export para tests en node (inerte en navegador)
if(typeof module !== 'undefined' && module.exports)
  module.exports = { cartKey, variantOptDisplay, resolveVariantPrice, cartTotalPrice, cartTotalQty, buildOrderMessage, formatPrice, promoOf };
