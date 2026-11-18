// Cliente liveOrders: URL, avisos, debounce, ping, reconexión y respaldo.
import test from "node:test";
import assert from "node:assert/strict";
import { liveOrders } from "../../shared/live.js";
import { renderKitchenPage } from "../src/kitchen.js";
import { renderMeseroPage } from "../src/mesero.js";
import { makeEnv } from "./helpers.mjs";

const site = { slug: "pizza", host: "pizza.craft-systems.com" };

// Navegador mínimo: WebSocket falso que registra instancias y mensajes.
function fakeBrowser(t, { host = "pizza.example", protocol = "https:" } = {}) {
  const sockets = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      sockets.push(this);
    }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const wsDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const locDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "WebSocket", { value: FakeSocket, configurable: true, writable: true });
  Object.defineProperty(globalThis, "location", { value: { protocol, host }, configurable: true, writable: true });
  t.after(() => {
    if (wsDescriptor) Object.defineProperty(globalThis, "WebSocket", wsDescriptor);
    else delete globalThis.WebSocket;
    if (locDescriptor) Object.defineProperty(globalThis, "location", locDescriptor);
    else delete globalThis.location;
  });
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  return { sockets, socket: () => sockets[sockets.length - 1] };
}

test("arma la URL wss con la sede codificada", (t) => {
  const { sockets } = fakeBrowser(t);
  const handle = liveOrders({ sede: "sede 01/ñ", onChange() {}, onStatus() {} });
  assert.equal(sockets.length, 1);
  assert.equal(
    sockets[0].url,
    "wss://pizza.example/panel/api/pos/live?sede_id=" + encodeURIComponent("sede 01/ñ"),
  );
  handle.close();
});

test("al abrir avisa en vivo y pide una actualización", (t) => {
  const { sockets } = fakeBrowser(t);
  const events = [];
  const handle = liveOrders({
    sede: "centro",
    onChange: () => events.push("change"),
    onStatus: (state) => events.push(state),
  });
  sockets[0].onopen({});
  assert.deepEqual(events, ["live", "change"], "primero el estado y luego el load");
  handle.close();
});

test("tres avisos en menos de 300 ms producen una sola actualización", (t) => {
  const { sockets } = fakeBrowser(t);
  let changes = 0;
  const handle = liveOrders({ sede: "centro", onChange: () => changes++ });
  sockets[0].onopen({});
  changes = 0; // descarta el load de la conexión
  for (let i = 0; i < 3; i++) {
    sockets[0].onmessage({ data: '{"t":"orders"}' });
    if (i < 2) t.mock.timers.tick(100);
  }
  assert.equal(changes, 0, "todavía no pasaron los 300 ms");
  t.mock.timers.tick(300);
  assert.equal(changes, 1, "solo un load por la ráfaga");
  sockets[0].onmessage({ data: "pong" });
  t.mock.timers.tick(400);
  assert.equal(changes, 1, "pong se ignora");
  handle.close();
});

test("reconecta con backoff 1, 2, 5, 10 y 30 s", (t) => {
  const { sockets } = fakeBrowser(t);
  const statuses = [];
  const handle = liveOrders({ sede: "centro", onStatus: (state) => statuses.push(state) });
  sockets[0].onopen({});
  for (const base of [1000, 2000, 5000, 10000, 30000, 30000]) {
    sockets[sockets.length - 1].onclose({ code: 1006 });
    assert.equal(statuses.at(-1), "offline");
    const before = sockets.length;
    t.mock.timers.tick(base - 1);
    assert.equal(sockets.length, before, "no reconecta antes de " + base + " ms");
    t.mock.timers.tick(501); // jitter de hasta 500 ms
    assert.equal(sockets.length, before + 1, "reconecta tras " + base + " ms");
  }
  handle.close();
});

test("envía ping cada 45 s mientras está abierto", (t) => {
  const { sockets } = fakeBrowser(t);
  const handle = liveOrders({ sede: "centro" });
  sockets[0].onopen({});
  t.mock.timers.tick(44999);
  assert.deepEqual(sockets[0].sent, []);
  t.mock.timers.tick(1);
  assert.deepEqual(sockets[0].sent, ["ping"]);
  t.mock.timers.tick(45000);
  assert.deepEqual(sockets[0].sent, ["ping", "ping"]);
  handle.close();
});

test("close() cierra el socket y cancela timers y reconexión", (t) => {
  const { sockets } = fakeBrowser(t);
  const handle = liveOrders({ sede: "centro" });
  sockets[0].onopen({});
  handle.close();
  assert.equal(sockets[0].closed, true);
  t.mock.timers.tick(120000);
  assert.equal(sockets.length, 1, "no reconecta tras cerrar");
  assert.deepEqual(sockets[0].sent, [], "tampoco quedan pings");

  // Al caer la conexión la reconexión queda programada: close() la cancela.
  const other = liveOrders({ sede: "centro" });
  const second = sockets[sockets.length - 1];
  second.onclose({ code: 1006 });
  const before = sockets.length;
  other.close();
  t.mock.timers.tick(60000);
  assert.equal(sockets.length, before);
});

test("sin WebSocket avisa unsupported y close() no lanza", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const wsDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
  t.after(() => {
    if (wsDescriptor) Object.defineProperty(globalThis, "WebSocket", wsDescriptor);
    else delete globalThis.WebSocket;
  });
  const statuses = [];
  const handle = liveOrders({ sede: "centro", onStatus: (state) => statuses.push(state) });
  assert.deepEqual(statuses, ["unsupported"]);
  assert.doesNotThrow(() => handle.close());
});

test("String(liveOrders) evaluado con new Function sigue funcionando", (t) => {
  const { sockets } = fakeBrowser(t);
  const factory = new Function("return (" + String(liveOrders) + ");")();
  const statuses = [];
  let changes = 0;
  const handle = factory({
    sede: "centro",
    onChange: () => changes++,
    onStatus: (state) => statuses.push(state),
  });
  sockets[0].onopen({});
  assert.deepEqual(statuses, ["live"]);
  assert.equal(changes, 1);
  assert.match(sockets[0].url, /^wss:\/\/pizza\.example\/panel\/api\/pos\/live\?sede_id=centro$/);
  handle.close();
});

test("cocina y caja incluyen liveOrders y el respaldo de 2 min", async () => {
  const env = makeEnv({ "pizza:config": { store_name: "Pizzería" } });
  const kitchen = await renderKitchenPage(
    new Request("https://pizza.craft-systems.com/panel/cocina"), env, site);
  const caja = await renderMeseroPage(
    new Request("https://pizza.craft-systems.com/panel/mesero"), env, site);
  for (const [name, html] of [["cocina", kitchen], ["caja", caja]]) {
    assert.ok(html.includes("window.__liveOrders"), name + " inyecta liveOrders");
    assert.ok(html.includes("120000"), name + " usa el respaldo de 2 min");
    assert.equal(html.includes("POLL_MS = 10000"), false, name + " sin sondeo de 10 s");
    assert.equal(html.includes("autoprint ? 8000"), false, name + " sin respaldo de 8 s");
    assert.equal(html.includes("se actualiza cada"), false, name + " sin el texto viejo");
  }
  assert.ok(kitchen.includes("kdsLiveState"), "indicador de estado en cocina");
  assert.ok(caja.includes("meseroLiveState"), "indicador de estado en caja");
  assert.ok(caja.indexOf("var __name=") > 0 && caja.indexOf("var __name=") < caja.indexOf('id="meseroLive"'), "shim __name antes de liveOrders en caja");
});
