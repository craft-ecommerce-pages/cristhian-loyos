// node --test beacon.test.cjs — conteo del panel desde el motor: SOLO menús edge (window.__CONFIG__).
// Legacy (Pages, config.json) = cero requests nuevos; cualquier fallo del beacon es silencioso.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {panelCount, panelOrder} = require('./catalog.js');

// Ventana falsa: navigator con sendBeacon que captura (url, body) y sessionStorage en memoria.
function fakeWindow({config = {store_name: 'Demo'}, beacon = true, stored} = {}){
  const sent = [], store = new Map(stored ? [['craft_v', stored]] : []);
  const win = {
    sessionStorage: {getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v))},
    navigator: beacon === true ? {sendBeacon: (url, body) => (sent.push([url, body]), true)} : beacon,
  };
  if(config) win.__CONFIG__ = config;
  return {win, sent, store};
}

test('sin __CONFIG__ (menú legacy) no se manda nada', () => {
  const {win, sent} = fakeWindow({config: null});
  assert.equal(panelCount(win, 'view'), false);
  assert.equal(panelCount(win, 'order'), false);
  assert.deepEqual(sent, []);
  // window inexistente o tipo desconocido tampoco rompe
  assert.equal(panelCount(undefined, 'view'), false);
  assert.equal(panelCount(win, 'purchase'), false);
});

test('menú edge: view una vez por sesión, order en cada compra', () => {
  const {win, sent, store} = fakeWindow();
  assert.equal(panelCount(win, 'view'), true);
  assert.equal(panelCount(win, 'view'), false);          // sessionStorage 'craft_v' ya marcado
  assert.equal(panelCount(win, 'order'), true);
  assert.equal(panelCount(win, 'order'), true);          // los pedidos no se deduplican
  assert.deepEqual(sent, [['/panel/e', '{"t":"view"}'], ['/panel/e', '{"t":"order"}'], ['/panel/e', '{"t":"order"}']]);
  assert.equal(store.get('craft_v'), '1');
});

test('sesión ya contada (pestaña recargada) no repite el view', () => {
  const {win, sent} = fakeWindow({stored: '1'});
  assert.equal(panelCount(win, 'view'), false);
  assert.deepEqual(sent, []);
});

test('sin sendBeacon, con sendBeacon que lanza o con storage bloqueado: nunca lanza', () => {
  for(const beacon of [false, {}, 'no', {sendBeacon: () => { throw new Error('bloqueado'); }}, {sendBeacon: () => false}]){
    const {win, sent} = fakeWindow({beacon});
    assert.doesNotThrow(() => panelCount(win, 'view'));
    assert.doesNotThrow(() => panelCount(win, 'order'));
  }
  // sendBeacon devuelve false (cola llena): se reporta false, sin excepción
  assert.equal(panelCount(fakeWindow({beacon: {sendBeacon: () => false}}).win, 'order'), false);
  // sessionStorage bloqueado (modo privado): el view se manda igual, degradando la deduplicación
  const {win, sent} = fakeWindow();
  win.sessionStorage = {getItem(){ throw new Error('bloqueado'); }, setItem(){ throw new Error('bloqueado'); }};
  assert.equal(panelCount(win, 'view'), true);
  assert.deepEqual(sent, [['/panel/e', '{"t":"view"}']]);
});

// ── Pedido web a /panel/o (K4) ──
// Payload real del checkout: el beacon del panel NO debe llevar token ni store_url.
const PAYLOAD = {
  token: 'secreto', store_name: 'Demo',
  items: [{nombre: 'Pizza', qty: 2, precio: 5, variant: 'Grande'}],
  total: 12, currency: '$', client_name: 'Ana', client_phone: '0999999999',
  delivery_mode: 'delivery', address: 'Calle 1',
  store_url: 'https://demo.craft-systems.com/', latitude: -0.2, longitude: -78.5,
};

// Ventana con Blob falso (captura las partes) y fetch que registra las llamadas.
function orderWindow({config = {store_name: 'Demo'}, beacon = true} = {}){
  const sent = [], fetched = [];
  const win = {
    navigator: beacon === true ? {sendBeacon: (url, body) => (sent.push([url, body]), true)} : beacon,
    Blob: class { constructor(parts, opts){ this.parts = parts; this.opts = opts; } },
    fetch: (...args) => (fetched.push(args), Promise.resolve()),
  };
  if(config) win.__CONFIG__ = config;
  return {win, sent, fetched};
}
const jsonOf = blob => JSON.parse(blob.parts[0]);

test('panelOrder sin __CONFIG__ (menú legacy) no manda nada', () => {
  const {win, sent, fetched} = orderWindow({config: null});
  assert.equal(panelOrder(win, PAYLOAD, 'r1'), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(fetched, []);
  assert.equal(panelOrder(undefined, PAYLOAD), false);
  assert.equal(panelOrder(fakeWindow().win, null), false);
});

test('panelOrder edge: sendBeacon a /panel/o con el payload sin token/store_url', () => {
  const {win, sent, fetched} = orderWindow();
  assert.equal(panelOrder(win, PAYLOAD, 'r1'), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], '/panel/o');
  assert.equal(sent[0][1].opts.type, 'application/json');
  assert.deepEqual(jsonOf(sent[0][1]), {
    items: PAYLOAD.items, total: 12, currency: '$', client_name: 'Ana',
    client_phone: '0999999999', delivery_mode: 'delivery', address: 'Calle 1', order_id: 'r1',
  });
  assert.deepEqual(fetched, []);
});

test('panelOrder sin order_id (solo WhatsApp) y retiro sin dirección: claves omitidas', () => {
  const {win, sent} = orderWindow();
  assert.equal(panelOrder(win, {...PAYLOAD, address: undefined}), true);
  const body = jsonOf(sent[0][1]);
  assert.equal('order_id' in body, false);
  assert.equal('address' in body, false);
  assert.equal('token' in body || 'store_url' in body || 'latitude' in body, false);
});

test('panelOrder sin sendBeacon: fetch keepalive a /panel/o', () => {
  const {win, sent, fetched} = orderWindow({beacon: false});
  assert.equal(panelOrder(win, PAYLOAD, 'r2'), true);
  assert.deepEqual(sent, []);
  assert.equal(fetched.length, 1);
  const [url, opts] = fetched[0];
  assert.equal(url, '/panel/o');
  assert.equal(opts.method, 'POST');
  assert.equal(opts.keepalive, true);
  assert.equal(opts.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(opts.body).order_id, 'r2');
});

test('panelOrder nunca lanza: beacon roto, sendBeacon false o sin transporte', () => {
  for(const beacon of [false, {}, 'no', {sendBeacon: () => { throw new Error('bloqueado'); }}, {sendBeacon: () => false}]){
    const {win} = orderWindow({beacon});
    assert.doesNotThrow(() => panelOrder(win, PAYLOAD));
  }
  // sendBeacon devuelve false (cola llena): el pedido no sale, sin excepción
  assert.equal(panelOrder(orderWindow({beacon: {sendBeacon: () => false}}).win, PAYLOAD), false);
  // ni beacon ni fetch (navegador viejo): false silencioso
  const {win} = orderWindow({beacon: false});
  win.fetch = undefined;
  assert.equal(panelOrder(win, PAYLOAD), false);
});
