const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto} = require('node:crypto');
const src = f => fs.readFileSync(__dirname + '/' + f, 'utf8');
// Los objetos creados dentro del vm tienen otro prototipo; comparamos por valor plano.
const plain = v => JSON.parse(JSON.stringify(v));

// DOM falso mínimo: lo justo para tracking.js, order-checkout.js y el wiring de cart.js.
function el(id){
  return {id, h: {}, children: [], style: {setProperty(){}}, classList: {add(){}, remove(){}, toggle(){}}, dataset: {},
    addEventListener(k, f){ this.h[k] = f; }, append(...n){ this.children.push(...n); }, appendChild(n){ this.children.push(n); },
    setAttribute(){}, querySelector: () => null, remove(){}, scrollIntoView(){}};
}
function env({elements = [], fetch, open = () => ({})} = {}){
  const scripts = [], listeners = {}, byId = Object.fromEntries(elements.map(id => [id, el(id)])), storage = new Map();
  const head = {append: s => scripts.push(s), appendChild: s => scripts.push(s)};
  const document = {currentScript: {src: 'https://engine.test/v1/cart.js'}, head, body: el('body'),
    getElementById: id => byId[id] || null, createElement: () => el(), querySelectorAll: () => [],
    querySelector: sel => { const m = /src(\*?)="([^"]+)"/.exec(sel); return m ? scripts.find(s => m[1] ? s.src.includes(m[2]) : s.src === m[2]) || null : null; },
    addEventListener: (k, f) => { listeners[k] = f; }, dispatchEvent(){}};
  const store = {getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k)};
  const ctx = vm.createContext({document, crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout, fetch,
    CustomEvent: class { constructor(t, o){ this.type = t; Object.assign(this, o); } },
    localStorage: store, sessionStorage: store, location: {href: 'https://demo.test/'}, open, URL, Date, JSON, Math});
  ctx.window = ctx;
  return {ctx, scripts, byId, listeners, run: f => vm.runInContext(src(f), ctx)};
}
const IDS = {meta_pixel_id: '123456789012345', tiktok_pixel_id: 'C9ABCDEF12345', gtm_container_id: 'GTM-ABC123'};
const EVENTS = ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase'];
// Eventos emitidos por proveedor, leídos de las colas de los stubs oficiales.
const metaEvents = ctx => plain(ctx.fbq.queue.filter(a => a[0] === 'track').map(a => [...a]));
const tiktokEvents = ctx => plain(ctx.ttq.filter(a => a[0] === 'page' || a[0] === 'track'));
const gtmEvents = ctx => plain(ctx.dataLayer.filter(e => e.craft_event));

test('normalizeConfig: IDs validados por proveedor, GTM solo como ID, moneda ISO con fallback', () => {
  const {ctx, run} = env(); run('tracking.js');
  const T = ctx.CraftTracking;
  assert.deepEqual(plain(T.normalizeConfig({tracking: IDS, currency: '$'})), {...IDS, currency: 'USD'});
  assert.equal(T.normalizeConfig({tracking: {}, currency: 'cop'}).currency, 'COP');
  assert.equal(T.normalizeConfig({tracking: {currency: 'eur'}, currency: 'COP'}).currency, 'EUR');
  const bad = T.normalizeConfig({tracking: {meta_pixel_id: 'abc', tiktok_pixel_id: '"><script>', gtm_container_id: '<script>alert(1)</script>'}});
  assert.deepEqual([bad.meta_pixel_id, bad.tiktok_pixel_id, bad.gtm_container_id], ['', '', '']);
  for(const cfg of [undefined, null, {}, {tracking: null}, {tracking: []}, {tracking: 'GTM-ABC123'}])
    assert.deepEqual(plain(T.normalizeConfig(cfg)), {meta_pixel_id: '', tiktok_pixel_id: '', gtm_container_id: '', currency: 'USD'});
});

test('buildPayload: contents desde ítems del carrito, value, campos del producto y order_id', () => {
  const {ctx, run} = env(); run('tracking.js');
  const p = ctx.CraftTracking.buildPayload('AddToCart', {contents: [{id: 7, nombre: 'Pizza', precio: 5, qty: 2, key: '7', variantes: {}}], order_id: 99}, {currency: 'USD'}, 'evt-1');
  assert.deepEqual(plain(p), {event_name: 'AddToCart', event_id: 'evt-1', currency: 'USD', value: 10,
    contents: [{product_id: '7', name: 'Pizza', price: 5, quantity: 2}], product_id: '7', name: 'Pizza', price: 5, quantity: 2, order_id: '99'});
  const cart = ctx.CraftTracking.buildPayload('Purchase', {contents: [{id: 1, precio: 5, qty: 1}, {id: 2, precio: 3, qty: 2}], value: 12.5}, {currency: 'USD'}, 'x');
  assert.equal(cart.value, 12.5); // value explícito (incluye empaque) gana sobre la suma
  assert.equal(cart.product_id, undefined); // multi-ítem: sin campos de producto único
});

test('sin config o config inválida: no carga proveedores ni lanza', () => {
  for(const cfg of [{}, {tracking: {}}, {tracking: {meta_pixel_id: 'x', gtm_container_id: 'nope'}}]){
    const {ctx, scripts, run} = env(); run('tracking.js');
    const t = ctx.CraftTracking.create(cfg);
    assert.doesNotThrow(() => EVENTS.forEach(e => t.track(e, {contents: [{id: 1}]})));
    assert.equal(scripts.length, 0);
    assert.deepEqual([ctx.fbq, ctx.ttq, ctx.dataLayer], [undefined, undefined, undefined]);
  }
});

test('múltiples proveedores: carga cada SDK una vez y emite todos los eventos con el mismo event_id', () => {
  const {ctx, scripts, run} = env(); run('tracking.js');
  const t = ctx.CraftTracking.create({tracking: IDS, currency: '$'});
  ctx.CraftTracking.create({tracking: IDS}); // re-init: sin scripts ni init duplicados
  assert.deepEqual(scripts.map(s => s.src), ['https://connect.facebook.net/en_US/fbevents.js',
    'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=C9ABCDEF12345&lib=ttq', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123']);
  assert.equal(ctx.fbq.queue.filter(a => a[0] === 'init').length, 1);
  assert.equal(typeof ctx.ttq.track, 'function'); // stub oficial: encola hasta que carga el SDK

  const item = {id: 'p1', nombre: 'Pizza', precio: 5, qty: 2};
  const ids = EVENTS.map(e => t.track(e, e === 'PageView' ? undefined : {contents: [item], order_id: e === 'Purchase' ? 'ord-9' : undefined}));
  assert.equal(ids[4], 'purchase-ord-9');
  assert.deepEqual(metaEvents(ctx).map(a => [a[1], a[3].eventID]), EVENTS.map((e, i) => [e, ids[i]]));
  assert.deepEqual(tiktokEvents(ctx).map(a => a[0] === 'page' ? 'page' : a[1]), ['page', 'ViewContent', 'AddToCart', 'InitiateCheckout', 'Purchase']);
  assert.deepEqual(tiktokEvents(ctx).slice(1).map(a => a[3].event_id), ids.slice(1));
  assert.deepEqual(gtmEvents(ctx).map(e => [e.event, e.event_id]),
    [['page_view', ids[0]], ['view_item', ids[1]], ['add_to_cart', ids[2]], ['begin_checkout', ids[3]], ['purchase', ids[4]]]);

  const [, , , , metaPurchase] = metaEvents(ctx);
  assert.deepEqual(plain(metaPurchase[2]), {content_type: 'product', content_ids: ['p1'], content_name: 'Pizza',
    contents: [{id: 'p1', quantity: 2, item_price: 5}], num_items: 2, value: 10, currency: 'USD', order_id: 'ord-9'});
  assert.deepEqual(plain(gtmEvents(ctx)[4].ecommerce), {transaction_id: 'ord-9', value: 10, currency: 'USD',
    items: [{item_id: 'p1', item_name: 'Pizza', price: 5, quantity: 2}]});
});

test('dedup: un Purchase del mismo order_id (reintento que recupera el pedido) no se re-emite', () => {
  const {ctx, run} = env(); run('tracking.js');
  const t = ctx.CraftTracking.create({tracking: {meta_pixel_id: IDS.meta_pixel_id}});
  t.track('Purchase', {order_id: 'A', contents: []});
  t.track('Purchase', {order_id: 'A', contents: []});
  t.track('Unknown', {});
  assert.equal(metaEvents(ctx).length, 1);
});

test('dedup: dos motores en la misma página emiten un solo PageView', () => {
  const {ctx, run} = env(); run('tracking.js');
  const a = ctx.CraftTracking.create({tracking: IDS});
  const b = ctx.CraftTracking.create({tracking: IDS});
  assert.equal(a.track('PageView'), b.track('PageView'));
  assert.deepEqual(metaEvents(ctx).map(a => a[1]), ['PageView']);
  assert.deepEqual(tiktokEvents(ctx).map(a => a[0]), ['page']);
  assert.deepEqual(gtmEvents(ctx).map(e => e.event), ['page_view']);
});

test('respeta un pixel/GTM ya presente en el shell: no inyecta scripts duplicados', () => {
  const calls = [];
  const {ctx, scripts, run} = env();
  ctx.fbq = (...a) => calls.push(a);
  scripts.push({src: 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123'});
  run('tracking.js');
  ctx.CraftTracking.create({tracking: {meta_pixel_id: IDS.meta_pixel_id, gtm_container_id: IDS.gtm_container_id}}).track('PageView');
  assert.equal(scripts.length, 1);
  assert.deepEqual(calls.map(c => c[0] + ':' + c[1]), ['init:' + IDS.meta_pixel_id, 'track:PageView']);
});

test('order-checkout: onSuccess solo tras registro confirmado y su fallo no rompe el pedido', async () => {
  let ok = false;
  const {ctx, run} = env({fetch: async () => ok ? {ok: true, status: 200, json: async () => ({id: 'abc', order_number: 5})} : {ok: false, status: 503, json: async () => ({})}});
  run('order-checkout.js');
  const hits = [];
  const containers = [];
  const args = onSuccess => { const container = el(); containers.push(container); return {url: '/o', payload: {token: 't', items: [], total: 5}, phone: '099', message: 'm', container, onSuccess}; };
  await assert.rejects(ctx.CraftOrderCheckout.submit(args(r => hits.push(r))));
  assert.equal(hits.length, 0);
  ok = true;
  await ctx.CraftOrderCheckout.submit(args(r => hits.push(r)));
  assert.equal(hits[0].id, 'abc');
  assert.match(decodeURIComponent(containers[1].children[0].children[2].href), /^https:\/\/wa.me\/099\?text=\*Pedido #000005\*\nm$/); // sin UUID: el CRM resuelve por nº + teléfono
  const receipt = await ctx.CraftOrderCheckout.submit(args(() => { throw new Error('pixel roto'); }));
  assert.equal(receipt.order_number, 5);
});

// Integración real del motor de tiendas (cart.js) — flujo de craft-store-studio.
function store({tracking = IDS, notify = true, fetch, open} = {}){
  const e = env({elements: ['btnCheckout', 'btnConfirm', 'cartDrawer'], fetch, open});
  e.run('tracking.js'); e.run('order-checkout.js'); e.run('cart.js');
  const config = {currency: '$', whatsapp_number: '593999999999', tracking,
    ...(notify ? {catalog_notify_url: 'https://crm.test/notify', catalog_notify_token: 'tok'} : {})};
  e.ctx.CraftCart.init({products: [{id: 'p1', nombre: 'Hoodie', precio: '59.90', precio_promo: '47.90'}], config});
  e.click = sel => e.listeners.click({target: {closest: s => s === sel[0] ? {dataset: sel[1]} : null}, preventDefault(){}, stopPropagation(){}});
  e.checkout = async () => { e.byId.btnCheckout.h.click(); await new Promise(r => setTimeout(r, 20)); };
  return e;
}
const names = ctx => metaEvents(ctx).map(a => a[1]);

test('cart.js: emite PageView, ViewContent, AddToCart, InitiateCheckout y Purchase con order_id tras registro exitoso', async () => {
  const {ctx, click, checkout} = store({fetch: async () => ({ok: true, status: 200, json: async () => ({id: 'ord-uuid', order_number: 12})})});
  click(['[data-open]', {open: 'p1'}]);
  click(['[data-add]', {add: 'p1'}]);
  await checkout();
  assert.deepEqual(names(ctx), EVENTS);
  const purchase = metaEvents(ctx)[4];
  assert.equal(purchase[3].eventID, 'purchase-ord-uuid');
  assert.deepEqual(plain(purchase[2].contents), [{id: 'p1', quantity: 1, item_price: 47.9}]);
  assert.equal(purchase[2].value, 47.9);
  assert.equal(gtmEvents(ctx).at(-1).ecommerce.transaction_id, 'ord-uuid');
  assert.ok(ctx.dataLayer.some(e => e.event === 'whatsapp_checkout')); // push legacy intacto
});

test('cart.js: registro fallido en craft-crm => sin Purchase', async () => {
  const {ctx, click, checkout} = store({fetch: async () => ({ok: false, status: 500, json: async () => null})});
  click(['[data-add]', {add: 'p1'}]);
  await checkout();
  assert.deepEqual(names(ctx), ['PageView', 'AddToCart', 'InitiateCheckout']);
});

test('cart.js sin craft-crm: Purchase solo si wa.me abrió (popup bloqueado => nada)', async () => {
  const blocked = store({notify: false, open: () => null});
  blocked.click(['[data-add]', {add: 'p1'}]);
  await blocked.checkout();
  assert.ok(!names(blocked.ctx).includes('Purchase'));
  const opened = store({notify: false, open: () => ({})});
  opened.click(['[data-add]', {add: 'p1'}]);
  await opened.checkout();
  assert.equal(names(opened.ctx).at(-1), 'Purchase');
});

test('cart.js legacy sin bloque tracking: no carga tracking.js ni terceros y el checkout sigue igual', async () => {
  const e = env({elements: ['btnCheckout'], open: () => ({})});
  e.run('cart.js'); // sin CraftTracking precargado: un bloque tracking dispararía la carga de tracking.js
  e.ctx.CraftCart.init({products: [{id: 'p1', nombre: 'X', precio: 5}], config: {whatsapp_number: '593999999999'}});
  e.listeners.click({target: {closest: s => s === '[data-add]' ? {dataset: {add: 'p1'}} : null}, preventDefault(){}});
  e.byId.btnCheckout.h.click();
  assert.equal(e.scripts.length, 0);
  assert.equal(e.ctx.fbq, undefined);
});

test('cart.js con bloque tracking: carga tracking.js diferido y vacía la cola al cargar', () => {
  const e = env({elements: []});
  e.run('cart.js');
  e.ctx.CraftCart.init({products: [{id: 'p1', nombre: 'X', precio: 5}], config: {tracking: {meta_pixel_id: IDS.meta_pixel_id}}});
  assert.deepEqual(e.scripts.map(s => s.src), ['https://engine.test/v1/tracking.js']);
  e.ctx.CraftCart.view('p1'); // antes de que cargue => encolado
  e.run('tracking.js'); e.scripts[0].onload();
  assert.deepEqual(names(e.ctx), ['PageView', 'ViewContent']);
});
