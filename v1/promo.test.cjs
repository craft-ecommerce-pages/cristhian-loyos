// node promo.test.cjs — chequea el filtro de oferta por día (misma lógica que promoActiveToday en catalog.js)
const assert = require('assert');

// réplica pura de promoActiveToday(p) para test sin DOM
const activeOn = (sku, today) => {
  const raw = (sku || '').trim();
  if (!raw) return true;
  return raw.split(',').map(s => parseInt(s, 10)).includes(today);
};

// sku vacío → siempre visible (retrocompat otros catálogos)
assert.strictEqual(activeOn('', 3), true);
assert.strictEqual(activeOn(undefined, 0), true);
// día único: visible solo ese día
assert.strictEqual(activeOn('3', 3), true);   // miércoles
assert.strictEqual(activeOn('3', 4), false);  // jueves → oculta
// varios días (ej. jueves con 3 promos comparten día, o una promo activa 2 días)
assert.strictEqual(activeOn('5,6', 6), true);
assert.strictEqual(activeOn('5,6', 0), false);
// domingo = 0
assert.strictEqual(activeOn('0', 0), true);

// --- ícono/label de categoría desde el emoji líder del nombre (misma lógica que catIcon/catLabel) ---
const leadingEmoji = str => {
  const m = (str || '').match(/^\s*(\p{Extended_Pictographic}(?:[️‍\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic})*)/u);
  return m ? m[1].trim() : '';
};
const catLabel = name => { const e = leadingEmoji(name); return e ? (name || '').replace(e, '').trim() : (name || ''); };

assert.strictEqual(leadingEmoji('🧀 Bites'), '🧀');
assert.strictEqual(catLabel('🧀 Bites'), 'Bites');
assert.strictEqual(leadingEmoji('🍽️ Almuerzos'), '🍽️');   // emoji con variation selector
assert.strictEqual(catLabel('🍽️ Almuerzos'), 'Almuerzos');
assert.strictEqual(leadingEmoji('Sin Emoji'), '');          // sin emoji → keyword match / name tal cual
assert.strictEqual(catLabel('Sin Emoji'), 'Sin Emoji');

// --- total de un grupo de distribución: pick>0 gana; si no, número del nombre; si no, 1 (misma lógica que distGroup) ---
const distTotal = (groupName, pick = 0) => { if (pick > 0) return pick; const m = String(groupName || '').match(/\d+/); return m ? +m[0] : 1; };
assert.strictEqual(distTotal('Elige tus 3 sabores'), 3);        // legacy inline BW: total del nombre
assert.strictEqual(distTotal('Elige 2 sabores'), 2);
assert.strictEqual(distTotal('Sabores'), 1);
assert.strictEqual(distTotal('Elige tus salsas', 5), 5);        // grupo reutilizable: pick gana al nombre sin dígito
assert.strictEqual(distTotal('Elige tus 3 sabores', 5), 5);     // pick gana aunque el nombre tenga dígito

// --- precio promo NxM: suma de elegidas menos las `free` más baratas (misma lógica que comboTotal) ---
const comboTotal = (labels, options, free) => {
  const priceOf = l => { const o = options.find(o => o.label === l); return o ? (o.price || 0) : 0; };
  const prices = labels.filter(Boolean).map(priceOf).sort((a, b) => a - b);
  return prices.slice(free).reduce((s, x) => s + x, 0);
};
const cocteles = [
  { label: 'MOSCOW MULE ($8.99)', price: 8.99 },
  { label: 'BULLDOG ($8.99)', price: 8.99 },
  { label: 'MARGARITA ($7.49)', price: 7.49 },
];
// 3x2 (free=1): 3 iguales → paga 2
assert.strictEqual(comboTotal(['MOSCOW MULE ($8.99)', 'BULLDOG ($8.99)', 'MOSCOW MULE ($8.99)'], cocteles, 1), 17.98);
// 3x2 con una más barata → la barata (7.49) sale gratis, cobra las dos de 8.99
assert.strictEqual(comboTotal(['MOSCOW MULE ($8.99)', 'BULLDOG ($8.99)', 'MARGARITA ($7.49)'], cocteles, 1), 17.98);
// parcial (2 de 3 elegidas) → resta la más barata de las elegidas hasta ahora
assert.strictEqual(comboTotal(['MOSCOW MULE ($8.99)', 'MARGARITA ($7.49)', undefined], cocteles, 1), 8.99);
// vacío → 0
assert.strictEqual(comboTotal([undefined, undefined, undefined], cocteles, 1), 0);

// --- empaque con categorías exentas (misma lógica que packagingFee) ---
const packagingFee = (p, cartItems, products) => {
  if (!p || !p.enabled) return 0;
  const cost = +p.cost || 0; if (cost <= 0) return 0;
  const exempt = new Set(p.exempt_categories || []);
  const billable = exempt.size ? cartItems.filter(i => {
    const prod = products.find(x => String(x.id) === String(i.id));
    return !prod || (prod.categorias || []).every(c => !exempt.has(c));
  }) : cartItems;
  if (!billable.length) return 0;
  return p.mode === 'per_unit' ? cost * billable.reduce((s, i) => s + i.qty, 0) : cost;
};
const prods = [
  { id: 1, categorias: ['alitas'] },
  { id: 2, categorias: ['bebidas'] },
  { id: 3, categorias: ['pizzas'] },
];
const cart = [{ id: 1, qty: 3 }, { id: 2, qty: 2 }, { id: 3, qty: 1 }]; // 4 no-bebida + 2 bebida
// per_unit sin exención → cuenta todas las unidades (6)
assert.strictEqual(packagingFee({ enabled: true, cost: 0.25, mode: 'per_unit' }, cart, prods), 1.5);
// per_unit con bebidas exentas → solo 4 unidades pagan
assert.strictEqual(packagingFee({ enabled: true, cost: 0.25, mode: 'per_unit', exempt_categories: ['bebidas'] }, cart, prods), 1.0);
// per_order con ítems que pagan → flat una vez
assert.strictEqual(packagingFee({ enabled: true, cost: 0.5, mode: 'per_order', exempt_categories: ['bebidas'] }, cart, prods), 0.5);
// carrito solo de exentos → 0 (ni siquiera el flat per_order)
assert.strictEqual(packagingFee({ enabled: true, cost: 0.5, mode: 'per_order', exempt_categories: ['bebidas'] }, [{ id: 2, qty: 3 }], prods), 0);
// deshabilitado → 0
assert.strictEqual(packagingFee({ enabled: false, cost: 0.25, mode: 'per_unit' }, cart, prods), 0);

console.log('ok — promo day filter + category emoji + dist total + combo NxM price + packaging exempt');
