// node cart.test.cjs  — chequea la lógica pura del carrito (sin DOM)
const assert = require('assert');
const { cartKey, resolveVariantPrice, cartTotalPrice, buildOrderMessage, promoOf, formatPrice } = require('./cart.js');

// cartKey: sin variantes = id; con variantes = estable e independiente del orden
assert.strictEqual(cartKey(7, {}), '7');
assert.strictEqual(cartKey(7, { Talla: 'M', Color: 'Azul' }), cartKey(7, { Color: 'Azul', Talla: 'M' }));

// precio: variante con price gana; si no, promo; si no, base
const p = { id: 1, precio: 20, precio_promo: 15 };
assert.strictEqual(promoOf(p), 15);
assert.strictEqual(resolveVariantPrice(p, { Talla: { label: 'L', price: 25 } }), 25);
assert.strictEqual(resolveVariantPrice(p, {}), 15);
assert.strictEqual(resolveVariantPrice({ id: 2, precio: 10 }, {}), 10);

// total
const items = [{ precio: 15, qty: 2 }, { precio: 25, qty: 1 }];
assert.strictEqual(cartTotalPrice(items), 55);

// mensaje: incluye total y, si hay fields, los datos de entrega
const cart = [{ nombre: 'Camisa', precio: 15, qty: 2, variantes: { Talla: 'M' } }];
const cfg = { currency: '$', store_name: 'Atelier', whatsapp_message: 'Hola!' };
const msg = buildOrderMessage(cart, cfg, { name: 'Juan', phone: '099', mode: 'delivery', address: 'Av 1' });
assert(msg.includes('PEDIDO ATELIER'));
assert(msg.includes('*TOTAL: $30.00*'));
assert(msg.includes('Camisa (M)'));
assert(msg.includes('*Cliente:* Juan'));
assert(msg.includes('*Dirección:* Av 1'));
// sin fields: no debe aparecer bloque de entrega
assert(!buildOrderMessage(cart, cfg, null).includes('Cliente:'));

console.log('ok — cart pure logic');

// price_locale opcional: COP sin decimales con punto de miles, PEN con 2 decimales; sin locale = histórico
assert.strictEqual(formatPrice(22900, '$'), '$22900.00');
assert.strictEqual(formatPrice(22900, '$', 'es-CO'), '$22.900');
assert.strictEqual(formatPrice(22.9, 'S/ ', 'es-PE', 2), 'S/ 22.90');
assert.ok(buildOrderMessage([{ nombre: 'Burger', precio: 22900, qty: 2 }], { currency: '$', price_locale: 'es-CO' }).includes('*TOTAL: $45.800*'));
