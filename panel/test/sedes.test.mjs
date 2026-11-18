// Sedes: /api/sedes solo activas, alta con id automático, sincronización con KV,
// baja de la última sede activa (409) y reactivación.
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { makeEnv } from "./helpers.mjs";

const host = "munch.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, method, headers = {}) => request(path, {
  method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

async function ownerCookie(env) {
  const created = await panel.fetch(request("/admin/munch/owner", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-token" },
    body: JSON.stringify({ email: "dueno@munch.ec" }),
  }), env, {});
  assert.equal(created.status, 200);
  const credentials = await created.json();
  const login = await panel.fetch(jsonRequest("/panel/api/login", credentials, "POST"), env, {});
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie").split(";", 1)[0];
}

const SEDES = [
  { id: "sede-01", nombre: "UIDE", direccion: "Por confirmar", universidad: "UIDE", activa: true },
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `sede-0${i + 2}`, nombre: `Food truck ${i + 2}`, direccion: "Por confirmar", universidad: "", activa: false,
  })),
];
const CONFIG = {
  store_name: "Munch", whatsapp_number: "593958610812",
  bank_transfer: { bank: "Banco Pichincha", account_number: "2216922010", holder: "Titular" },
  location: { telefono_principal: "593958610812", sedes: SEDES, out_of_coverage_message: "Elige tu sede." },
};

const idsOf = sedes => sedes.map(sede => sede.id).sort();

async function publicSedes(env) {
  const response = await panel.fetch(request("/api/sedes"), env, {});
  assert.equal(response.status, 200);
  return (await response.json()).sedes;
}

async function panelSedes(env, cookie) {
  const response = await panel.fetch(request("/panel/api/sedes", { headers: { cookie } }), env, {});
  assert.equal(response.status, 200);
  return (await response.json()).sedes;
}

test("GET /api/sedes (público) y el selector del panel devuelven solo activas", async () => {
  const env = makeEnv({ "munch:config": CONFIG });
  const cookie = await ownerCookie(env);
  const publicList = await publicSedes(env);
  assert.deepEqual(idsOf(publicList), ["sede-01"]);
  assert.equal(publicList[0].nombre, "UIDE");
  assert.equal(publicList[0].universidad, "UIDE");
  assert.equal(publicList.every(sede => sede.activa === true), true);
  const panelList = await panelSedes(env, cookie);
  assert.deepEqual(idsOf(panelList), ["sede-01"], "caja, cocina y reportes no ven sedes dadas de baja");
});

test("PUT /panel/api/sedes agrega con id siguiente y sincroniza KV sin pisar otras claves", async () => {
  const env = makeEnv({ "munch:config": structuredClone(CONFIG) });
  const cookie = await ownerCookie(env);
  const body = {
    sedes: [
      ...SEDES,
      { nombre: "Isla patio", direccion: "", universidad: "Patio de comidas", activa: true },
    ],
  };
  const response = await panel.fetch(jsonRequest("/panel/api/sedes", body, "PUT", { cookie }), env, {});
  assert.equal(response.status, 200, await response.clone().text());
  const saved = (await response.json()).sedes;
  const created = saved.find(sede => sede.nombre === "Isla patio");
  assert.equal(created.id, "sede-07", "el servidor asigna el siguiente id libre");
  assert.equal(created.activa, true);
  assert.deepEqual(idsOf(saved), ["sede-01", "sede-02", "sede-03", "sede-04", "sede-05", "sede-06", "sede-07"]);

  const kv = await env.MENUS.get("munch:config", "json");
  assert.equal(kv.store_name, "Munch", "no pisa otras claves del menú");
  assert.equal(kv.whatsapp_number, "593958610812");
  assert.deepEqual(kv.bank_transfer, CONFIG.bank_transfer);
  assert.equal(kv.location.telefono_principal, "593958610812");
  assert.deepEqual(idsOf(kv.location.sedes), ["sede-01", "sede-02", "sede-03", "sede-04", "sede-05", "sede-06", "sede-07"]);
  const kvNew = kv.location.sedes.find(sede => sede.id === "sede-07");
  assert.deepEqual(kvNew, { id: "sede-07", nombre: "Isla patio", direccion: "", universidad: "Patio de comidas", activa: true });

  // El id recién creado ya aparece en el menú/selectores: solo activas, sin reutilizar IDs.
  assert.deepEqual(idsOf(await publicSedes(env)), ["sede-01", "sede-07"]);
});

test("no se puede dar de baja la última sede activa: 409 ultima_sede_activa", async () => {
  const env = makeEnv({ "munch:config": structuredClone(CONFIG) });
  const cookie = await ownerCookie(env);
  const before = await env.MENUS.get("munch:config", "json");
  const response = await panel.fetch(jsonRequest("/panel/api/sedes", {
    sedes: [{ ...SEDES[0], activa: false }],
  }, "PUT", { cookie }), env, {});
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "ultima_sede_activa" });
  const rows = env.DB.raw.prepare("SELECT id, activa FROM pos_sedes WHERE slug = ? ORDER BY id").all("munch");
  assert.equal(rows.find(row => row.id === "sede-01").activa, 1, "la sede activa no cambia");
  assert.deepEqual(await env.MENUS.get("munch:config", "json"), before, "KV tampoco cambia");
});

test("reactivar una sede dada de baja la devuelve al menú y a los selectores", async () => {
  const env = makeEnv({ "munch:config": structuredClone(CONFIG) });
  const cookie = await ownerCookie(env);
  const response = await panel.fetch(jsonRequest("/panel/api/sedes", {
    sedes: [{ id: "sede-02", nombre: "Food truck 2", direccion: "Por confirmar", universidad: "", activa: true }],
  }, "PUT", { cookie }), env, {});
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(idsOf(await publicSedes(env)), ["sede-01", "sede-02"]);
  const kv = await env.MENUS.get("munch:config", "json");
  assert.equal(kv.location.sedes.find(sede => sede.id === "sede-02").activa, true);
  assert.equal(kv.location.sedes.find(sede => sede.id === "sede-03").activa, false, "las demás no cambian");

  // Con dos activas ya se puede dar de baja una.
  const baja = await panel.fetch(jsonRequest("/panel/api/sedes", {
    sedes: [{ ...SEDES[0], activa: false }],
  }, "PUT", { cookie }), env, {});
  assert.equal(baja.status, 200, await baja.clone().text());
  assert.deepEqual(idsOf(await publicSedes(env)), ["sede-02"]);
});
