// Comprobantes de transferencia: subida pública por token, almacenamiento
// privado en R2, visor autenticado de caja, media pública restringida, datos
// bancarios sin WhatsApp, retiro obligatorio e insignia/alerta en la caja.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { signCajaSession } from "../src/caja.js";
import { normalizeEcPhone, noticeMessage, noticeUrl, isCoarsePointer } from "../src/mesero.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonBody = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});
const cookieRequest = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});

const product = {
  id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "",
  stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [],
  packaging_id: null, packaging_cost: 0,
};

function envFor(overrides = {}) {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza", web_cash: true,
      bank_transfer: {
        bank: "Banco Pichincha", account_type: "Cuenta Transaccional",
        account_number: "2216922010", holder: "Loyos Morán Mathyuz Ismael",
      },
      location: { sedes: [{ id: "centro", nombre: "Centro", direccion: "Calle 1" }, { id: "norte", nombre: "Norte", direccion: "Calle 2" }] },
      ...overrides,
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [product] }), Date.now());
  return env;
}

const webOrder = (overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: "11111111-1111-4111-8111-111111111111",
  items: [{ product_id: "margarita", qty: 1 }],
  customer: { name: "Ana", phone: "0991234567" },
  delivery_mode: "pickup",
  payment_method: "transfer",
  ...overrides,
});

async function createOrder(env, overrides = {}) {
  const response = await panel.fetch(jsonBody("/api/orders", webOrder(overrides)), env, makeCtx());
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function ownerCookie(env) {
  const owner = await panel.fetch(jsonBody("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(jsonBody("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6]);
const PDF = new Uint8Array([...Buffer.from("%PDF-1.4"), 1, 2, 3]);

const upload = (env, id, token, bytes, type = "image/png", headers = {}) => panel.fetch(request(
  `/api/orders/${encodeURIComponent(id)}/receipt${token == null ? "" : `?token=${encodeURIComponent(token)}`}`,
  { method: "POST", headers: { "content-type": type, ...headers }, body: bytes },
), env, makeCtx());

test("media: /media niega cualquier clave private/ y sigue sirviendo la media pública", async () => {
  const env = makeEnv();
  await env.MEDIA.put("private/receipts/pizza/o1/x.png", PNG, {
    httpMetadata: { contentType: "image/png", cacheControl: "private, no-store" },
  });
  await env.MEDIA.put("panel/pizza/products/foto.webp", JPEG, {
    httpMetadata: { contentType: "image/webp" },
  });
  let response = await panel.fetch(request("/media/private/receipts/pizza/o1/x.png"), env, {});
  assert.equal(response.status, 404, "un comprobante nunca se sirve por la ruta pública");
  response = await panel.fetch(request("/media/panel/pizza/products/foto.webp"), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
});

test("subida pública: token, tipo real por magic bytes, tamaño y estado", async () => {
  const env = envFor();
  const order = await createOrder(env);

  let response = await upload(env, order.id, "token-invalido", PNG);
  assert.equal(response.status, 404, "token inválido no revela el pedido");

  response = await upload(env, order.id, order.order_token, PNG, "text/plain");
  assert.equal(response.status, 415);

  response = await upload(env, order.id, order.order_token, new Uint8Array([1, 2, 3, 4]), "image/png");
  assert.equal(response.status, 415, "los magic bytes reales mandan sobre el Content-Type");

  response = await upload(env, order.id, order.order_token, PNG);
  assert.equal(response.status, 201);
  let body = await response.json();
  assert.equal(body.receipt.count, 1);
  assert.ok(Number.isInteger(body.receipt.latest_at));

  const row = env.DB.raw.prepare("SELECT * FROM transfer_receipts WHERE order_id = ?").get(order.id);
  assert.match(row.r2_key, new RegExp(`^private/receipts/pizza/${order.id}/[0-9a-f-]+\\.png$`));
  assert.equal(row.content_type, "image/png");
  assert.equal(row.size_bytes, PNG.byteLength);
  const stored = await env.MEDIA.get(row.r2_key);
  assert.equal(stored.o.httpMetadata.contentType, "image/png");
  assert.equal(stored.o.httpMetadata.cacheControl, "private, no-store");

  // Segunda subida: la vigente es la última, pero se conservan ambas.
  response = await upload(env, order.id, order.order_token, JPEG, "image/jpeg");
  assert.equal(response.status, 201);
  body = await response.json();
  assert.equal(body.receipt.count, 2);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) n FROM transfer_receipts WHERE order_id = ?").get(order.id).n, 2);

  // PDF válido por su firma.
  response = await upload(env, order.id, order.order_token, PDF, "application/pdf");
  assert.equal(response.status, 201);
  assert.equal((await response.json()).receipt.count, 3);
});

test("subida pública: máximo 5 MB (413), solo transferencia pendiente/confirmada (409)", async () => {
  const env = envFor();
  const order = await createOrder(env, { idempotency_key: "22222222-2222-4222-8222-222222222222" });
  const big = new Uint8Array(5 * 1024 * 1024 + 1);
  big.set([0xff, 0xd8, 0xff], 0);
  let response = await upload(env, order.id, order.order_token, big, "image/jpeg");
  assert.equal(response.status, 413);

  const cash = await createOrder(env, {
    idempotency_key: "33333333-3333-4333-8333-333333333333", payment_method: "cash",
  });
  response = await upload(env, cash.id, cash.order_token, PNG);
  assert.equal(response.status, 409, "un pedido en efectivo no recibe comprobante");

  env.DB.raw.prepare("UPDATE pos_orders SET status = 'paid', paid_at = ? WHERE id = ?").run(Date.now(), order.id);
  response = await upload(env, order.id, order.order_token, PNG);
  assert.equal(response.status, 409, "un pedido ya pagado no vuelve a recibir comprobante");
});

test("el pedido lista el comprobante y el estado público marca receipt_uploaded", async () => {
  const env = envFor();
  const order = await createOrder(env);
  const cookie = await ownerCookie(env);

  let response = await panel.fetch(cookieRequest("/panel/api/pos/orders?sede_id=centro", cookie), env, {});
  let listed = (await response.json()).orders.find(item => item.id === order.id);
  assert.equal(listed.receipt, null, "sin subidas no hay resumen");

  await upload(env, order.id, order.order_token, PNG);
  response = await panel.fetch(cookieRequest("/panel/api/pos/orders?sede_id=centro", cookie), env, {});
  listed = (await response.json()).orders.find(item => item.id === order.id);
  assert.equal(listed.receipt.count, 1);
  assert.ok(Number.isInteger(listed.receipt.latest_at));

  const status = await (await panel.fetch(
    request(`/api/orders/${order.id}?token=${order.order_token}`), env, {},
  )).json();
  assert.equal(status.receipt_uploaded, true);
  assert.equal(JSON.stringify(status).includes("r2_key"), false, "la key privada nunca es pública");
});

test("visor de caja: stream inline con permiso de sede, sin permiso 403 y sin sesión 401", async () => {
  const env = envFor();
  const order = await createOrder(env);
  await upload(env, order.id, order.order_token, PNG, "image/png");
  await upload(env, order.id, order.order_token, JPEG, "image/jpeg");

  let response = await panel.fetch(request(`/panel/api/pos/orders/${order.id}/receipt`), env, {});
  assert.equal(response.status, 401);

  const cookie = await ownerCookie(env);
  response = await panel.fetch(cookieRequest(`/panel/api/pos/orders/${order.id}/receipt`, cookie), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg", "por defecto el más reciente");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), JPEG);

  response = await panel.fetch(cookieRequest(`/panel/api/pos/orders/${order.id}/receipt?n=2`, cookie), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);

  response = await panel.fetch(cookieRequest(`/panel/api/pos/orders/${order.id}/receipt?n=9`, cookie), env, {});
  assert.equal(response.status, 404);

  // HEAD: el visor consulta el tipo sin descargar la imagen.
  response = await panel.fetch(cookieRequest(`/panel/api/pos/orders/${order.id}/receipt`, cookie, { method: "HEAD" }), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal((await response.arrayBuffer()).byteLength, 0);

  // Cajero local limitado a otra sede: no puede ver el comprobante.
  env.DB.raw.prepare(
    "INSERT INTO pos_staff (slug, id, name, pin_lookup, pin_hash, sedes, active, created_at, updated_at) " +
    "VALUES ('pizza', 'l_norte', 'Norte', 'x', 'x', '[\"norte\"]', 1, 0, 0)",
  ).run();
  const caja = `caja_s=${await signCajaSession(env, "pizza", "l_norte")}`;
  response = await panel.fetch(cookieRequest(`/panel/api/pos/orders/${order.id}/receipt`, caja), env, {});
  assert.equal(response.status, 403);
});

test("transferInfo ya no exige WhatsApp; el retiro es obligatorio en la web y en la caja", async () => {
  const env = envFor();
  let options = await (await panel.fetch(request("/api/payment-options"), env, {})).json();
  assert.equal(options.transfer, true);
  assert.deepEqual(options.transfer_details, {
    bank: "Banco Pichincha", account_type: "Cuenta Transaccional",
    account_number: "2216922010", holder: "Loyos Morán Mathyuz Ismael",
  });
  assert.equal(JSON.stringify(options).includes("whatsapp"), false);

  let response = await panel.fetch(jsonBody("/api/orders", webOrder({ delivery_mode: "delivery" })), env, makeCtx());
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "modo_entrega_invalido" });

  // La caja siempre usa pickup, aunque el cuerpo diga otra cosa.
  const cookie = await ownerCookie(env);
  response = await panel.fetch(cookieRequest("/panel/api/mesero/orders", cookie, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sede_id: "centro", idempotency_key: "44444444-4444-4444-8444-444444444444",
      items: [{ product_id: "margarita", qty: 1 }], delivery_mode: "delivery", address: "Calle 9",
      payment_method: "cash",
    }),
  }), env, makeCtx());
  assert.equal(response.status, 201, await response.clone().text());
  const created = await response.json();
  const row = env.DB.raw.prepare("SELECT delivery_mode, address FROM pos_orders WHERE id = ?").get(created.id);
  assert.equal(row.delivery_mode, "pickup", "la caja siempre retira en el local");
  assert.equal(row.address, null);
});

test("aviso de WhatsApp: normalización EC, mensaje, web.whatsapp.com vs wa.me y pointer coarse", () => {
  assert.equal(normalizeEcPhone("0991234567"), "593991234567");
  assert.equal(normalizeEcPhone("+593 99 123 4567"), "593991234567");
  assert.equal(normalizeEcPhone("991234567"), "593991234567");
  assert.equal(normalizeEcPhone("593991234567"), "593991234567");
  assert.equal(normalizeEcPhone("022345678"), "", "los fijos no generan enlace");
  assert.equal(normalizeEcPhone("12345"), "");
  assert.equal(normalizeEcPhone(""), "");

  const message = noticeMessage({ name: "Ana", number: "#31", sede: "Centro" });
  assert.equal(message, "Hola Ana, tu pedido #31 está listo. Retíralo en Centro. ¡Gracias por tu compra en Munch!");
  assert.doesNotMatch(message, /RUC|cédula|correo|dirección/i);

  const desktop = noticeUrl({ phone: "593991234567", message, desktop: true });
  assert.match(desktop, /^https:\/\/web\.whatsapp\.com\/send\?phone=593991234567&text=/);
  const mobile = noticeUrl({ phone: "593991234567", message, desktop: false });
  assert.match(mobile, /^https:\/\/wa\.me\/593991234567\?text=/);

  assert.equal(isCoarsePointer({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(isCoarsePointer({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, () => ({ matches: false })), false);
  assert.equal(isCoarsePointer({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, () => ({ matches: true })), true);
});
