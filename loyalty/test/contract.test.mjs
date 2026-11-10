import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConfig, normalizePhone, segments, distanceM, sedesWithCoords } from "../src/contract.js";
import { makeD1 } from "./helpers.mjs";

test("normalizePhone: EC local, internacional y basura", () => {
  assert.equal(normalizePhone("099 123 4567"), "593991234567");
  assert.equal(normalizePhone("+57 300 123 4567", "57"), "573001234567");
  assert.equal(normalizePhone("3001234567", "57"), "573001234567");
  assert.equal(normalizePhone("593991234567"), "593991234567");
  assert.equal(normalizePhone("123"), null);
  assert.equal(normalizePhone(null), null);
});

test("normalizeConfig: defaults y filtrado de premios inválidos", () => {
  const c = normalizeConfig({ enabled: true, games: ["wheel", "pinball"], prizes: [{ id: "cafe", label: "Café", weight: 10, stock: "5" }, { id: "Mal id", label: "x", weight: 1 }, { id: "z", label: "", weight: 1 }, { id: "__stamps", label: "x", weight: 1 }] });
  assert.deepEqual(c.games, ["wheel"]);
  assert.deepEqual(c.prizes, [{ id: "cafe", label: "Café", weight: 10, stock: 5, expires_days: null }]);
  assert.equal(c.stamps_goal, 8);
  assert.equal(c.cooldown_hours, 12);
  assert.equal(normalizeConfig(null).enabled, false);
  assert.deepEqual(normalizeConfig({}).games, ["wheel", "scratch"]);
});

test("segments: 'Sigue participando' al final solo si lose_weight > 0", () => {
  const c = normalizeConfig({ prizes: [{ id: "a", label: "A", weight: 1 }] });
  assert.deepEqual(segments(c).map(s => s.id), ["a", null]);
  assert.deepEqual(segments({ ...c, lose_weight: 0 }).map(s => s.id), ["a"]);
});

test("geo: distancia y sedes válidas", () => {
  assert.ok(Math.abs(distanceM(-0.18, -78.48, -0.181, -78.48) - 111) < 2);
  assert.equal(sedesWithCoords({ location: { sedes: [{ lat: 1, lng: 2 }, { lat: "x", lng: 2 }, {}] } }).length, 1);
});

test("migraciones aplican y el shim D1 responde", async () => {
  const db = makeD1();
  await db.prepare("INSERT INTO customers (slug, phone, created_at) VALUES (?, ?, ?)").bind("demo", "593991234567", 1).run();
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM customers WHERE slug = ?").bind("demo").first("n"), 1);
});
