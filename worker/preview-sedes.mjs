// Vista local con datos ficticios: node worker/preview-sedes.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { render } from './src/lib.js';

const root = new URL('../', import.meta.url);
const config = {
  store_name: 'Demo · Sedes', hero_title: 'Tu pedido, desde la sede más cercana', whatsapp_number: '593000000000',
  categories: { platos: 'Platos' }, currency: '$',
  location: { out_of_coverage_message: 'Esta dirección está fuera de nuestra cobertura de prueba.', sedes: [
    { id: 'centro', nombre: 'Centro', direccion: 'Centro de Quito', telefono: '593000000001', lat: -0.2202, lng: -78.5123, radio_km: 3 },
    { id: 'norte', nombre: 'Norte', direccion: 'La Carolina, Quito', telefono: '593000000002', lat: -0.1807, lng: -78.4848, radio_km: 3 },
  ] },
};
const products = [{ id: 'demo', nombre: 'Hamburguesa de prueba', precio: 5, categorias: ['platos'], descripcion: 'Producto ficticio para revisar el checkout.' }];
const template = await readFile(new URL('worker/template.html', root), 'utf8');
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:8788');
  const cfg = structuredClone(config);
  if (url.searchParams.has('legacy')) delete cfg.location;
  if (url.searchParams.has('quick')) cfg.wa_order = true;
  try {
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(render(template, cfg, JSON.stringify(cfg), '')); }
    else if (url.pathname === '/productos.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(products)); }
    else if (/^\/v1\/(catalog\.js|catalog\.css|geo\.js)$/.test(url.pathname)) { res.setHeader('content-type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(await readFile(new URL(`worker/assets${url.pathname}`, root))); }
    else { res.writeHead(404); res.end(); }
  } catch { res.writeHead(500); res.end('Error en la vista local'); }
}).listen(8788, '127.0.0.1', () => console.log('Vista local: http://127.0.0.1:8788 · ?quick=1 para wa_order · ?legacy=1 sin cobertura'));
