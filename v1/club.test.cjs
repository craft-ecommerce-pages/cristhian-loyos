// node club.test.cjs — banner del club de fidelización en el motor (lógica pura, sin DOM).
// Con config.club ausente la función devuelve null y el menú no agrega nada (retrocompatible).
const assert = require('assert');
const { clubBanner } = require('./catalog.js');

// sin la clave o con valores que no son objeto → sin banner
assert.strictEqual(clubBanner(undefined), null);
assert.strictEqual(clubBanner(null), null);
assert.strictEqual(clubBanner('Juega'), null);
assert.strictEqual(clubBanner([]), null);
assert.strictEqual(clubBanner(true), null);

// objeto (incluso vacío) → botón a /club con el label por defecto
assert.deepStrictEqual(clubBanner({}), { label: 'Juega y gana', href: '/club' });
assert.deepStrictEqual(clubBanner({ label: 'Gana café' }), { label: 'Gana café', href: '/club' });

// label vacío, no-string o con espacios → default; largo → recorte (se pinta con textContent)
assert.strictEqual(clubBanner({ label: '   ' }).label, 'Juega y gana');
assert.strictEqual(clubBanner({ label: 123 }).label, 'Juega y gana');
assert.strictEqual(clubBanner({ label: '  Gana postres  ' }).label, 'Gana postres');
assert.strictEqual(clubBanner({ label: 'x'.repeat(120) }).label.length, 40);

// claves ajenas al contrato no cambian el comportamiento ni mutan el config
const cfg = { club: { label: 'Gana', color: 'red' } };
assert.deepStrictEqual(clubBanner(cfg.club), { label: 'Gana', href: '/club' });
assert.deepStrictEqual(cfg, { club: { label: 'Gana', color: 'red' } });
assert.strictEqual(clubBanner({ enabled: false }).href, '/club'); // `enabled` no es del contrato del club

console.log('ok — club banner');
