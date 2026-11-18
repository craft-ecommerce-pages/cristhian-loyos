// Datos del repo = producción: UIDE activa, sedes 02–06 dadas de baja y la config
// del menú coherente con data/sedes.json y la proyección KV.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = file => JSON.parse(readFileSync(new URL(`../../data/${file}`, import.meta.url), "utf8"));
const config = read("config.json");
const sedes = read("sedes.json");
const kv = read("kv/config.json");

test("data/sedes.json y config.location.sedes: UIDE activa y 02–06 dadas de baja", () => {
  const list = sedes.sedes;
  assert.equal(list.length, 6);
  assert.deepEqual(list.map(sede => sede.id), ["sede-01", "sede-02", "sede-03", "sede-04", "sede-05", "sede-06"]);
  assert.deepEqual(list[0], { id: "sede-01", nombre: "UIDE", direccion: "Por confirmar", universidad: "UIDE", activa: true });
  for (const sede of list.slice(1)) {
    assert.equal(sede.activa, false, `${sede.id} dada de baja`);
    assert.equal(sede.nombre, `Food truck ${Number(sede.id.slice(-2))}`);
  }
  assert.deepEqual(config.location.sedes, list, "el panel/menú leen la misma lista");
  assert.deepEqual(sedes.qr, { parametro: "sede", ejemplo: "/?sede=sede-01" });
});

test("contacto y transferencia de producción en data/config.json", () => {
  assert.equal(config.whatsapp_number, "593958610812");
  assert.equal(config.location.telefono_principal, "593958610812");
  assert.equal(config.bank_transfer.bank, "Banco Pichincha");
  assert.equal(config.bank_transfer.account_number, "2216922010");
  assert.equal(config.packaging.enabled, true, "sigue habiendo empaque");
});

test("data/kv/config.json es la proyección exacta de data/config.json", () => {
  assert.deepEqual(kv, config, "catalog-import no debe divergir de la config");
  assert.equal(kv.location.sedes.filter(sede => sede.activa).length, 1);
});
