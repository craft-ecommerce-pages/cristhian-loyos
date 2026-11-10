const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(`${__dirname}/catalog.js`, 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const pricing = section('function parsePrice(p){', 'const getImages=') +
  section('function getEffectivePrice(p,variantes){', 'function formatPrice(n){');
const context = {
  comboInfo: () => null,
  getOptionKey: o => typeof o === 'object' ? o.label : o,
  getOptionPrice: o => typeof o === 'object' && typeof o.price === 'number' ? o.price : null,
  getOptionDelta: () => 0,
};
vm.runInNewContext(`${pricing}\nthis.prices={parsePrice,promoPrice,basePrice,getEffectivePrice};`, context);
const { promoPrice, basePrice, getEffectivePrice } = context.prices;

test('precio promocional válido es el importe cobrado; sin oferta se conserva el precio normal', () => {
  const pizza = { precio: '12.00', precio_promo: '9', variantes: [] };
  assert.equal(basePrice(pizza), 9);
  assert.equal(getEffectivePrice(pizza), 9);
  assert.equal(getEffectivePrice({ ...pizza, precio_promo: '' }), 12);
  assert.equal(promoPrice({ ...pizza, precio_promo: '0' }), null);
  assert.equal(promoPrice({ ...pizza, precio_promo: '15' }), null);
  assert.equal(promoPrice({ ...pizza, precio_promo: 'texto' }), null);
});

test('una variante con precio absoluto conserva su importe; una sin precio propio usa la oferta', () => {
  const pizza = { precio: '12.00', precio_promo: '9', variantes: [{ options: [{ label: 'Normal' }, { label: 'Grande', price: 15 }] }] };
  assert.equal(getEffectivePrice(pizza, { 0: 'Normal' }), 9);
  assert.equal(getEffectivePrice(pizza, { 0: 'Grande' }), 15);
});

test('la tarjeta destaca la oferta y tacha el precio normal', () => {
  const cardSource = section('function cardHTML(p,i){', 'function actionHTML(p,inCartQty,hasVariants,stock){');
  const render = vm.runInNewContext(`${pricing}\n${cardSource}\ncardHTML`, {
    ...context,
    cartItems: [], config: {}, getImages: () => [], getStockInfo: () => ({ badge: '' }),
    catIcon: () => '', badgeCat: () => '', isFav: () => false, t: x => x,
    formatPrice: n => `$${n.toFixed(2)}`, actionHTML: () => '',
  });
  const html = render({ id: 'pizza', nombre: 'Pizza Familiar', precio: '12.00', precio_promo: '9', categorias: [] }, 0);
  assert.match(html, /class="card-price">\$9\.00<\/span>/);
  assert.match(html, /class="card-promo">\$12\.00<\/span>/);
});
