// Tiempo real: avisos por cambio de pedido. Aquí se comprueba que orders.js llama
// a `notifyOrders` justo después de cada escritura real en `pos_orders`/`pos_comandas`
// y que las repeticiones idempotentes no despiertan ninguna pantalla.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import panel from "../src/index.js";
import { handleBendoMock, handleBendoReturn, startPublicBendo } from "../src/bendo.js";
import { makeCtx, makeEnv } from "./helpers.mjs";

// En esta rama `realtime.js` puede seguir siendo el stub de la tarea 1: sin avisos
// reales no hay nada que medir. El ensamblador corre estos tests contra la implementación.
const realtimeStub = readFileSync(new URL("../src/realtime.js", import.meta.url), "utf8").includes("STUB");

const host = "pizza.craft-systems.com";
const site = { slug: "pizza", host };
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const body = (path, value, options = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...(options.headers || {}) },
  body: JSON.stringify(value),
});

const margarita = { id: "margarita", name: "Margarita", type: "producto", price: "8.50", promo_price: "", sku: "", description: "", stock: null, active: true, catalog_visible: true, images: [], categories: [], variants: [], groups: [], packaging_id: null, packaging_cost: 0 };

// Binding ORDERS_HUB falso: solo la interfaz del contrato (idFromName + get(id).fetch).
function makeHub({ throws = false } = {}) {
  const sent = [];
  return {
    sent,
    idFromName(name) { return { name }; },
    get(stub) {
      return {
        fetch: async (url, init = {}) => {
          if (throws) throw new Error("hub caído");
          sent.push({ name: stub.name, url: String(url), method: init.method || "GET" });
          return new Response(null, { status: 204 });
        },
      };
    },
  };
}

function envConHub(options = {}) {
  const env = makeEnv({
    "pizza:config": {
      currency: "USD", store_name: "Pizza",
      // El autopedido cobra en efectivo en caja: así se prueban todos los cobros.
      web_cash: true,
      location: { sedes: [{ nombre: "Centro", direccion: "Calle 1" }, { nombre: "Norte", direccion: "Calle 2" }] },
    },
  });
  env.CLIENT_SLUG = "pizza";
  env.ORDERS_HUB = makeHub(options);
  env.DB.raw.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)")
    .run("pizza", JSON.stringify({ categories: [], packagings: [], variant_groups: [], products: [margarita] }), Date.now());
  return { env, hub: env.ORDERS_HUB };
}

async function ownerCookie(env) {
  const owner = await panel.fetch(body("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const login = await panel.fetch(body("/panel/api/login", await owner.json()), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const webOrder = (overrides = {}) => ({
  sede_id: "centro",
  idempotency_key: "11111111-1111-4111-8111-111111111111",
  items: [{ product_id: "margarita", qty: 2 }],
  customer: {
    name: "Ana", phone: "0991234567",
    billing: { document_type: "cedula", document_number: "1712345678", email: "ana@example.com", address: "Av. 1" },
  },
  delivery_mode: "pickup",
  ...overrides,
});
// Desde 0012, efectivo y transferencia exigen un turno abierto en la sede.
const openShift = (env, sede = "centro") => env.DB.raw.prepare(
  "INSERT INTO pos_shifts (id, slug, sede_id, opened_by, opened_at, opening_float_cents, open_key) " +
  "VALUES (?, ?, ?, 'test', ?, 0, ?)",
).run(`turno-${sede}`, "pizza", sede, Date.now(), `turno-${sede}`);

// Un aviso = una entrega al binding para la sede exacta, con la URL del contrato.
async function avisa(hub, sede, action) {
  const before = hub.sent.length;
  const response = await action();
  assert.deepEqual(hub.sent.slice(before), [{ name: sede, url: "https://hub/notify", method: "POST" }]);
  return response;
}
async function sinAviso(hub, action) {
  const before = hub.sent.length;
  const response = await action();
  assert.equal(hub.sent.length, before, "la repetición idempotente no avisa");
  return response;
}

test("cada cambio de un pedido avisa una sola vez a su sede", { skip: realtimeStub }, async () => {
  const { env, hub } = envConHub();
  const ctx = makeCtx(), cookie = await ownerCookie(env);

  // Alta desde la web.
  const created = await (await avisa(hub, "pizza:centro",
    () => panel.fetch(body("/api/orders", webOrder()), env, ctx))).json();
  // Misma idempotency_key: devuelve el mismo pedido y no avisa otra vez.
  const retry = await sinAviso(hub, () => panel.fetch(body("/api/orders", webOrder()), env, ctx));
  assert.equal((await retry.json()).id, created.id);

  // Edición, confirmación, cobro en efectivo, listo y acuse de impresión.
  await avisa(hub, "pizza:centro", () => panel.fetch(body(`/panel/api/mesero/orders/${created.id}`, {
    note: "Sin hielo",
  }, { method: "PUT", headers: { cookie } }), env, ctx));
  await avisa(hub, "pizza:centro",
    () => panel.fetch(body(`/panel/api/orders/${created.id}/confirm`, {}, { headers: { cookie } }), env, ctx));
  // Confirmar dos veces no cambia la fila: sin aviso.
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/orders/${created.id}/confirm`, {}, { headers: { cookie } }), env, ctx));

  openShift(env);
  await avisa(hub, "pizza:centro",
    () => panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-aviso-001" }, { headers: { cookie } }), env, ctx));
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, { idempotency_key: "cash-aviso-001" }, { headers: { cookie } }), env, ctx));

  await avisa(hub, "pizza:centro",
    () => panel.fetch(body(`/panel/api/orders/${created.id}/ready`, {}, { headers: { cookie } }), env, ctx));
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/orders/${created.id}/ready`, {}, { headers: { cookie } }), env, ctx));

  await avisa(hub, "pizza:centro", () => panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, {
    idempotency_key: "print-aviso-01",
  }, { headers: { cookie } }), env, ctx));
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/kitchen/orders/${created.id}/print`, {
    idempotency_key: "print-aviso-01",
  }, { headers: { cookie } }), env, ctx));
});

test("caja, transferencia y rechazo avisan a la sede del pedido", { skip: realtimeStub }, async () => {
  const { env, hub } = envConHub();
  const ctx = makeCtx(), cookie = await ownerCookie(env);

  // Alta desde la caja del local.
  await avisa(hub, "pizza:centro", () => panel.fetch(body("/panel/api/mesero/orders", {
    sede_id: "centro", idempotency_key: "caja-aviso-0001", items: [{ product_id: "margarita", qty: 1 }],
  }, { headers: { cookie } }), env, ctx));

  // Otra sede: el aviso lleva la sede del pedido, no la de la sesión del dueño.
  const norte = await (await avisa(hub, "pizza:norte", () => panel.fetch(body("/api/orders", webOrder({
    sede_id: "norte", idempotency_key: "norte-aviso-0001", payment_method: "transfer",
  })), env, ctx))).json();
  openShift(env, "norte");
  await avisa(hub, "pizza:norte", () => panel.fetch(body(`/panel/api/orders/${norte.id}/pay-transfer`, {
    idempotency_key: "tr-aviso-0001",
  }, { headers: { cookie } }), env, ctx));
  // Confirmar la transferencia otra vez tampoco avisa.
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/orders/${norte.id}/pay-transfer`, {
    idempotency_key: "tr-aviso-0001",
  }, { headers: { cookie } }), env, ctx));

  const rechazado = await (await avisa(hub, "pizza:centro",
    () => panel.fetch(body("/api/orders", webOrder({ idempotency_key: "rechazo-aviso-01" })), env, ctx))).json();
  await avisa(hub, "pizza:centro",
    () => panel.fetch(body(`/panel/api/orders/${rechazado.id}/reject`, {}, { headers: { cookie } }), env, ctx));
  await sinAviso(hub, () => panel.fetch(body(`/panel/api/orders/${rechazado.id}/reject`, {}, { headers: { cookie } }), env, ctx));
});

test("cobro con tarjeta: aprobado y rechazado avisan una vez", { skip: realtimeStub }, async () => {
  const { env, hub } = envConHub();
  env.BENDO_MODE = "mock";
  const ctx = makeCtx();
  const tarjeta = async (key, pago) => {
    const created = await (await avisa(hub, "pizza:centro", () => panel.fetch(body("/api/orders", webOrder({
      idempotency_key: key, payment_method: "bendo",
    })), env, ctx))).json();
    const started = await (await startPublicBendo(request(`/api/orders/${created.id}/bendo`), env, site, created.id, {
      order_token: created.order_token, idempotency_key: pago,
    })).json();
    return started.payment_id;
  };

  const aprobado = await tarjeta("tarjeta-0001-abcd", "pago-tarjeta-0001");
  await handleBendoMock(request(`/api/bendo/mock?p=${aprobado}&resultado=aprobado`), env);
  await avisa(hub, "pizza:centro",
    () => handleBendoReturn(request(`/api/bendo/return?p=${aprobado}&format=json`), env, site));
  await sinAviso(hub, () => handleBendoReturn(request(`/api/bendo/return?p=${aprobado}&format=json`), env, site));

  const rechazado = await tarjeta("tarjeta-0002-abcd", "pago-tarjeta-0002");
  await handleBendoMock(request(`/api/bendo/mock?p=${rechazado}&resultado=rechazado`), env);
  await avisa(hub, "pizza:centro",
    () => handleBendoReturn(request(`/api/bendo/return?p=${rechazado}&format=json`), env, site));
  await sinAviso(hub, () => handleBendoReturn(request(`/api/bendo/return?p=${rechazado}&format=json`), env, site));
});

test("un binding que falla nunca rompe la operación que avisa", async () => {
  const { env } = envConHub({ throws: true });
  const ctx = makeCtx(), cookie = await ownerCookie(env);
  const created = await (await panel.fetch(body("/api/orders", webOrder()), env, ctx)).json();
  openShift(env);
  const response = await panel.fetch(body(`/panel/api/orders/${created.id}/pay-cash`, {
    idempotency_key: "cash-fallo-001",
  }, { headers: { cookie } }), env, ctx);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).order.status, "paid");
  assert.equal(env.DB.raw.prepare("SELECT status FROM pos_orders WHERE id = ?").get(created.id).status, "paid");
});
