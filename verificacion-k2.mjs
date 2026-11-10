// Verificación visual local del panel K2: no requiere Worker ni puertos del proyecto.
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { renderPage } from "./panel/src/page.js";
import playwright from "/home/jcadmin/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js";
const { chromium } = playwright;

const doc = {
  version: 7,
  categories: [{ slug: "hamburguesas", name: "Hamburguesas" }, { slug: "bebidas", name: "Bebidas" }],
  packagings: [{ id: "pack-1", name: "Caja biodegradable", price: 0.35, product_ids: ["p1"] }],
  variant_groups: [{ id: "g1", name: "Salsas", type: "distribute", pick: 2, optional: false, item: "Salsa", options: [{ name: "BBQ" }, { name: "Ají", price: 0 }], product_ids: ["p1"] }],
  products: [
    { id: "p1", name: "Craft clásica", type: "producto", price: "8.50", promo_price: "", packaging_id: "pack-1", packaging_cost: 0, sku: "", description: "Carne, queso y vegetales.", stock: null, active: true, catalog_visible: true, images: [], categories: ["hamburguesas"], variants: [{ name: "Término", type: "option", options: [{ name: "Medio" }, { name: "Tres cuartos" }], pick: 0, optional: false }], groups: [{ group_id: "g1", pick_override: null }] },
    { id: "p2", name: "Combo viernes", type: "promocion", price: "12", promo_price: "9.90", packaging_id: null, packaging_cost: 0, sku: "5", description: "Hamburguesa y bebida.", stock: 0, active: true, catalog_visible: true, images: [], categories: ["hamburguesas", "bebidas"], variants: [], groups: [] },
  ],
};
const store = { store_name: "Craft Demo", menu_url: "https://demo.craft-systems.com/", whatsapp_number: "593991234567", hours: { weekly: {} }, location: { sedes: [{ nombre: "Centro", direccion: "Av. Principal 123", lat: -2.18, lng: -79.89, radio_km: 4 }], social: {} }, cross_sell: { categories: ["bebidas"], title: "También te puede gustar", max: 4 } };
const orders = [{ id: "o1", created_at: Date.UTC(2026, 9, 23, 16, 30), total: 18.4, currency: "USD", client_name: "Ana Pérez", client_phone: "593991234567", delivery_mode: "Entrega", address: "Cdla. Kennedy", items: [{ nombre: "Craft clásica", qty: 2, precio: 8.5, variant: "BBQ" }] }];

function json(res, body, status = 200, headers = {}) { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); }
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "https://local.test").pathname;
  if (path === "/panel") return res.end(renderPage({ slug: "demo", host: "demo.craft-systems.com" }));
  if (path === "/panel/api/me") return json(res, { store, loyalty_enabled: false });
  if (path === "/panel/api/catalog") return json(res, doc);
  if (path === "/panel/api/store") return json(res, store);
  if (path === "/panel/api/orders") return json(res, { orders, total: orders.length });
  if (path === "/panel/api/loyalty") return json(res, {}, 404);
  if (path === "/panel/api/stats") return json(res, { totals: { views: 18, orders: 1 }, days: [{ day: "2026-10-22", views: 8, orders: 1 }, { day: "2026-10-23", views: 10, orders: 0 }] });
  return json(res, {});
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await mkdir("./verificacion-k2", { recursive: true });
const browser = await chromium.launch({ executablePath: "/home/jcadmin/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", headless: true });
const screens = ["Productos", "Variantes", "Empaques", "Pedidos", "Resultados", "Mi negocio", "Fidelidad"];
try {
  for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    await page.goto(`http://127.0.0.1:${port}/panel`);
    await page.waitForSelector("text=Productos");
    for (const screen of screens) {
      await page.getByLabel("Secciones del panel").getByRole("button", { name: screen, exact: true }).click();
      await page.waitForTimeout(120);
      await page.screenshot({ path: `./verificacion-k2/${name}-${screen.toLowerCase().replaceAll(" ", "-")}.png`, fullPage: true });
    }
    await page.getByLabel("Secciones del panel").getByRole("button", { name: "Productos", exact: true }).click();
    await page.getByRole("button", { name: /Categorías/ }).click();
    await page.screenshot({ path: `./verificacion-k2/${name}-categorias.png`, fullPage: true });
    await page.getByRole("button", { name: /Promos/ }).click();
    await page.screenshot({ path: `./verificacion-k2/${name}-promos.png`, fullPage: true });
    await page.getByLabel("Opciones de productos").getByRole("button", { name: "Productos", exact: true }).click();
    await page.getByRole("button", { name: "+ Nuevo", exact: true }).click();
    await page.screenshot({ path: `./verificacion-k2/${name}-form-producto.png`, fullPage: true });
    await page.getByLabel("Secciones del panel").getByRole("button", { name: "Variantes", exact: true }).click();
    await page.getByRole("button", { name: "+ Nuevo grupo", exact: true }).click();
    await page.screenshot({ path: `./verificacion-k2/${name}-form-variante.png`, fullPage: true });
    await page.getByLabel("Secciones del panel").getByRole("button", { name: "Empaques", exact: true }).click();
    await page.getByRole("button", { name: "+ Nuevo empaque", exact: true }).click();
    await page.screenshot({ path: `./verificacion-k2/${name}-form-empaque.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
