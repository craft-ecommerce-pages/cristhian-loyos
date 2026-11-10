// Encoder QR propio (byte mode, ECC M, versiones 1-10), compartido por el panel y el club.
// Autocontenido: se inyecta al navegador serializando la función (String(qrMatrix)).

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(String(text ?? ""));
  // [total de codewords, EC por bloque, codewords de datos por bloque] para ECC M.
  const T = [null,
    [26, 10, [16]],
    [44, 16, [28]],
    [70, 26, [44]],
    [100, 18, [32, 32]],
    [134, 24, [43, 43]],
    [172, 16, [27, 27, 27, 27]],
    [196, 18, [31, 31, 31, 31]],
    [242, 22, [38, 38, 39, 39]],
    [292, 22, [36, 36, 36, 37, 37]],
    [346, 26, [43, 43, 43, 43, 44]],
  ];
  let ver = 0, dataCw = 0;
  for (let v = 1; v <= 10; v++) {
    const cap = T[v][2].reduce((a, b) => a + b, 0);
    if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap * 8) { ver = v; dataCw = cap; break; }
  }
  if (!ver) throw new Error("texto demasiado largo");

  // Bits: modo byte (0100), longitud, datos, terminador y relleno.
  const bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(4, 4);
  push(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  for (let i = 0; i < 4 && bits.length < dataCw * 8; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const cws = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    cws.push(b);
  }
  for (let i = 0; cws.length < dataCw; i++) cws.push(i % 2 ? 0x11 : 0xec);

  // GF(256) y Reed-Solomon.
  const EXP = new Array(512), LOG = new Array(256).fill(0);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const ecLen = T[ver][1], gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
    gen.splice(0, gen.length, ...next);
  }
  const ecc = data => {
    const res = new Array(ecLen).fill(0);
    for (const b of data) {
      const factor = b ^ res[0];
      res.shift();
      res.push(0);
      for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i + 1], factor);
    }
    return res;
  };

  // Bloques y entrelazado.
  const sizes = T[ver][2], blocks = [], eccs = [];
  for (let i = 0, p = 0; i < sizes.length; i++) {
    const b = cws.slice(p, p + sizes[i]);
    p += sizes[i];
    blocks.push(b);
    eccs.push(ecc(b));
  }
  const out = [];
  for (let i = 0; i < Math.max(...sizes); i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of eccs) out.push(e[i]);

  // Matriz y módulos de función.
  const size = 17 + 4 * ver;
  const mod = Array.from({ length: size }, () => new Array(size).fill(0));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => {
    if (x >= 0 && y >= 0 && x < size && y < size) { mod[y][x] = v ? 1 : 0; fn[y][x] = true; }
  };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const align = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] }[ver] || [];
  for (const cx of align) for (const cy of align) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const placeFormat = (m, mask) => {
    const data = mask; // ECC M = 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((data << 10) | rem) ^ 0x5412;
    const bit = i => (fbits >>> i) & 1;
    const put = (x, y, v) => { m[y][x] = v ? 1 : 0; };
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, 1); // módulo oscuro
  };
  placeFormat(mod, 0);
  // Reserva las celdas de formato para que el zigzag de datos no las pise.
  for (let i = 0; i <= 5; i++) fn[i][8] = true;
  fn[7][8] = fn[8][8] = fn[8][7] = true;
  for (let i = 9; i < 15; i++) fn[8][14 - i] = true;
  for (let i = 0; i < 8; i++) fn[8][size - 1 - i] = true;
  for (let i = 8; i < 15; i++) fn[size - 15 + i][8] = true;
  fn[size - 8][8] = true;
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = (vbits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b); set(c, a, b);
    }
  }

  // Colocación en zigzag desde la esquina inferior derecha, salteando la columna 6.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && i < out.length * 8) { mod[y][x] = (out[i >>> 3] >>> (7 - (i & 7))) & 1; i++; }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
  ];
  const penalty = m => {
    let p = 0;
    const runScore = line => {
      let sc = 0, run = 0, prev = -1;
      for (const v of line) {
        if (v === prev) run++;
        else { if (run >= 5) sc += 3 + run - 5; run = 1; prev = v; }
      }
      return run >= 5 ? sc + 3 + run - 5 : sc;
    };
    for (let y = 0; y < size; y++) p += runScore(m[y]);
    for (let x = 0; x < size; x++) p += runScore(m.map(r => r[x]));
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    const P = [1, 0, 1, 1, 1, 0, 1];
    const scan = line => {
      let sc = 0;
      for (let i = 0; i + 7 <= line.length; i++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (line[i + k] !== P[k]) { ok = false; break; }
        if (!ok) continue;
        const before = i >= 4 && !line[i - 1] && !line[i - 2] && !line[i - 3] && !line[i - 4];
        const after = i + 11 <= line.length && !line[i + 7] && !line[i + 8] && !line[i + 9] && !line[i + 10];
        if (before || after) sc += 40;
      }
      return sc;
    };
    for (let y = 0; y < size; y++) p += scan(m[y]);
    for (let x = 0; x < size; x++) p += scan(m.map(r => r[x]));
    let dark = 0;
    for (const row of m) for (const v of row) dark += v;
    p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
    return p;
  };

  // Se prueban las 8 máscaras y se elige la de menor penalización.
  let best = null, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = mod.map(r => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] ^= 1;
    placeFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return best;
}
