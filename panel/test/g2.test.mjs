// G2: función "tarjeta" por plan, cumpleaños/inactivos, CSV de clientes, opiniones,
// carteles imprimibles y fechas sugeridas de campañas (sprint crecimiento).
import test from "node:test";
import assert from "node:assert/strict";
import panel from "../src/index.js";
import { campaignDates, renderPage } from "../src/page.js";
import { makeEnv } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, options = {}) => new Request(`https://${host}${path}`, options);
const jsonRequest = (path, body, { headers = {}, ...options } = {}) => request(path, {
  method: options.method || "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
  ...options,
});
const withSession = (path, cookie, options = {}) => request(path, {
  ...options, headers: { ...(options.headers || {}), cookie },
});
async function session(env) {
  const owner = await panel.fetch(jsonRequest("/admin/pizza/owner", { email: "dueno@pizza.ec" }, {
    headers: { authorization: "Bearer admin-token" },
  }), env, {});
  const credentials = await owner.json();
  const login = await panel.fetch(jsonRequest("/panel/api/login", credentials), env, {});
  return login.headers.get("set-cookie").split(";", 1)[0];
}
const admin = (env, path, options = {}) => panel.fetch(request(path, {
  ...options, headers: { authorization: "Bearer admin-token", ...(options.headers || {}) },
}), env, {});
const setFeatures = (env, body) => admin(env, "/admin/pizza/features", {
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const patchLoyalty = (env, cookie, body) =>
  panel.fetch(jsonRequest("/panel/api/loyalty", body, { method: "PATCH", headers: { cookie } }), env, {});

test("features: sin fila está habilitado y el PUT guarda el estado por slug", async () => {
  const env = makeEnv({
    "pizza:loyalty": { enabled: true, stamps_goal: 9 },
    "pizza:config": { store_name: "Pizza", club: { label: "Únete al club" } },
  });
  let response = await admin(env, "/admin/pizza/features");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { loyalty: true, source: null, updated_at: null });

  response = await setFeatures(env, { loyalty: false, source: "legacy" });
  assert.equal(response.status, 200);
  const off = await response.json();
  assert.equal(off.loyalty, false);
  assert.equal(off.source, "legacy");
  assert.ok(Number(off.updated_at) > 0);
  // Efecto: el club queda apagado y el botón sale del menú; el resto del config no cambia.
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).enabled, false);
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).stamps_goal, 9);
  const config = await env.MENUS.get("pizza:config", "json");
  assert.equal("club" in config, false);
  assert.equal(config.store_name, "Pizza");

  // Una sola fila por slug: el segundo PUT actualiza, no inserta.
  response = await setFeatures(env, { loyalty: false, source: "addon" });
  assert.equal((await response.json()).source, "addon");
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM panel_features").get().n, 1);

  response = await setFeatures(env, { loyalty: true, source: "saas" });
  const restored = await response.json();
  assert.equal(restored.loyalty, true);
  assert.equal(restored.source, "saas");
  assert.ok(restored.updated_at >= off.updated_at);
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).enabled, false, "reactivar no re-enciende el club por su cuenta");

  // Validación y Bearer.
  for (const body of [{}, { loyalty: "sí" }, { loyalty: true, source: "otro" }, null]) {
    response = await setFeatures(env, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, "campo_invalido");
  }
  assert.equal((await panel.fetch(request("/admin/pizza/features"), env, {})).status, 401);
  response = await panel.fetch(jsonRequest("/admin/pizza/features", { loyalty: false }, { method: "PUT" }), env, {});
  assert.equal(response.status, 401);
});

test("Me expone features y el enlace de pago del addon", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  const me = async () => (await panel.fetch(withSession("/panel/api/me", cookie), env, {})).json();

  let data = await me();
  assert.deepEqual(data.features, { loyalty: true });
  // Sin CRM_PAY_URL no se inventa un cobro externo: el panel oculta el botón.
  assert.equal(data.loyalty_pay_url, null);

  env.CRM_PAY_URL = "https://pagos.cliente.ec/";
  assert.equal((await me()).loyalty_pay_url, "https://pagos.cliente.ec/api/v1/billing/pay/loyalty/pizza");
  env.CRM_PAY_URL = "no-es-url";
  assert.equal((await me()).loyalty_pay_url, null);

  await setFeatures(env, { loyalty: false, source: "legacy" });
  data = await me();
  assert.deepEqual(data.features, { loyalty: false });
});

test("PATCH /loyalty con enabled:true sin la función responde 402 y no escribe", async () => {
  const env = makeEnv({ "pizza:loyalty": { enabled: false, stamps_goal: 9 }, "pizza:config": { club: { label: "Juega" } } });
  const cookie = await session(env);
  await setFeatures(env, { loyalty: false, source: "legacy" });
  const before = await env.MENUS.get("pizza:loyalty"), configBefore = await env.MENUS.get("pizza:config");

  let response = await patchLoyalty(env, cookie, { enabled: true, stamps_goal: 10 });
  assert.equal(response.status, 402);
  assert.deepEqual(await response.json(), { error: "plan_requerido" });
  assert.equal(await env.MENUS.get("pizza:loyalty"), before, "no escribe config del club");
  assert.equal(await env.MENUS.get("pizza:config"), configBefore, "no toca el menú");

  // Guardar el resto del club (sin encenderlo) sí funciona.
  response = await patchLoyalty(env, cookie, { enabled: false, stamps_goal: 10 });
  assert.equal(response.status, 200);
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).stamps_goal, 10);

  await setFeatures(env, { loyalty: true, source: "addon" });
  response = await patchLoyalty(env, cookie, { enabled: true });
  assert.equal(response.status, 200);
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).enabled, true);
});

test("cumpleaños e inactivos: defaults, validación y persistencia", async () => {
  const env = makeEnv({ "pizza:config": {} }), cookie = await session(env);
  let data = await (await panel.fetch(withSession("/panel/api/loyalty", cookie), env, {})).json();
  assert.deepEqual(data.birthday, { enabled: false, label: "Regalo de cumpleaños", expires_days: 14 });
  assert.deepEqual(data.winback, { enabled: false, days: 30, label: "Un premio de bienvenida", expires_days: 14 });

  let response = await patchLoyalty(env, cookie, {
    birthday: { enabled: true, label: "Postre gratis", expires_days: 10 },
    winback: { enabled: true, days: 21, label: "Café gratis", expires_days: 7 },
  });
  assert.equal(response.status, 200);
  const saved = await env.MENUS.get("pizza:loyalty", "json");
  assert.deepEqual(saved.birthday, { enabled: true, label: "Postre gratis", expires_days: 10 });
  assert.deepEqual(saved.winback, { enabled: true, days: 21, label: "Café gratis", expires_days: 7 });

  // Un guardado que no manda las claves las conserva.
  await patchLoyalty(env, cookie, { stamps_goal: 5 });
  assert.equal((await env.MENUS.get("pizza:loyalty", "json")).birthday.enabled, true);

  // Etiqueta vacía u omitida ⇒ default; el resto de los campos se normaliza.
  await patchLoyalty(env, cookie, { birthday: { enabled: false, label: "  " } });
  assert.deepEqual((await env.MENUS.get("pizza:loyalty", "json")).birthday,
    { enabled: false, label: "Regalo de cumpleaños", expires_days: 14 });
  await patchLoyalty(env, cookie, { winback: { enabled: true, days: 14 } });
  assert.deepEqual((await env.MENUS.get("pizza:loyalty", "json")).winback,
    { enabled: true, days: 14, label: "Un premio de bienvenida", expires_days: 14 });

  const invalid = [
    ["birthday", { enabled: "sí" }],
    ["birthday", { enabled: true, label: "x".repeat(61) }],
    ["birthday", { enabled: true, expires_days: 0 }],
    ["birthday", { enabled: true, expires_days: 14.5 }],
    ["birthday", { enabled: true, extra: 1 }],
    ["birthday", []],
    ["winback", { enabled: true, days: 13 }],
    ["winback", { enabled: true, days: "30" }],
    ["winback", { enabled: true, expires_days: 366 }],
    ["winback", { enabled: false, label: 42 }],
  ];
  for (const [campo, value] of invalid) {
    response = await patchLoyalty(env, cookie, { [campo]: value });
    assert.equal(response.status, 400, `${campo}: ${JSON.stringify(value)}`);
    assert.deepEqual(await response.json(), { error: "campo_invalido", campo });
  }
});

test("customers.csv se descarga como CSV con el Bearer interno", async () => {
  const env = makeEnv({ "pizza:config": {} }), seen = [];
  const csv = "\ufeffNombre,WhatsApp,Visitas\nAna,593991234567,4\n";
  env.LOYALTY = { fetch: async (url, init) => {
    seen.push({ url, init });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8" } });
  } };
  const cookie = await session(env);
  const response = await panel.fetch(withSession("/panel/api/loyalty/customers.csv", cookie), env, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="clientes-pizza.csv"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  // El BOM viaja en los bytes (Response.text() lo descarta al decodificar).
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes), csv);
  assert.deepEqual(seen.map(call => call.url), ["https://loyalty/admin/pizza/customers.csv"]);
  assert.equal(seen[0].init.headers.get("authorization"), "Bearer loy-token");

  // Sin sesión no se descarga nada.
  assert.equal((await panel.fetch(request("/panel/api/loyalty/customers.csv"), env, {})).status, 401);
  // Sin binding o con error del club ⇒ 503.
  delete env.LOYALTY;
  assert.equal((await panel.fetch(withSession("/panel/api/loyalty/customers.csv", cookie), env, {})).status, 503);
  env.LOYALTY = { fetch: async () => new Response("no", { status: 500 }) };
  const failed = await panel.fetch(withSession("/panel/api/loyalty/customers.csv", cookie), env, {});
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "club_no_disponible" });
});

test("feedback es un proxy de solo lectura con limit y offset", async () => {
  const env = makeEnv({ "pizza:config": {} }), seen = [];
  env.LOYALTY = { fetch: async (url, init) => {
    seen.push({ url, init });
    return Response.json({ items: [{ rating: 5, comment: "Rico", name: "Ana", phone: "593991234567", created_at: 1 }], total: 1, avg: 5 });
  } };
  const cookie = await session(env);
  const response = await panel.fetch(withSession("/panel/api/loyalty/feedback?limit=20&offset=0&extra=1", cookie), env, {});
  assert.equal(response.status, 200);
  const feedback = { items: [{ rating: 5, comment: "Rico", name: "Ana", phone: "593991234567", created_at: 1 }], total: 1, avg: 5 };
  assert.deepEqual(await response.json(), feedback);
  assert.deepEqual(seen.map(call => call.url), ["https://loyalty/admin/pizza/feedback?limit=20&offset=0"]);
  assert.equal(seen[0].init.headers.get("authorization"), "Bearer loy-token");
});

test("la migración 0004 crea panel_features (loyalty 0/1 y una fila por slug)", () => {
  const env = makeEnv(), raw = env.DB.raw;
  const sql = "INSERT INTO panel_features (slug, loyalty, source, updated_at) VALUES (?, ?, ?, ?)";
  assert.throws(() => raw.prepare(sql).run("x", 2, "saas", 1), /CHECK/);
  assert.throws(() => raw.prepare(sql).run("x", 1, "saas", null), /NOT NULL/);
  raw.prepare(sql).run("pizza", 1, "saas", 1);
  assert.throws(() => raw.prepare(sql).run("pizza", 0, null, 2), /UNIQUE|PRIMARY/);
  const saved = raw.prepare("SELECT slug, loyalty, source FROM panel_features").get();
  assert.deepEqual({ ...saved }, { slug: "pizza", loyalty: 1, source: "saas" });
});

test("campaignDates devuelve las próximas seis fechas comerciales desde hoy", () => {
  const list = campaignDates(new Date(2026, 9, 23));
  assert.deepEqual(list.map(item => item.title), [
    "Halloween", "Navidad", "Fin de año", "Día de la Pizza", "San Valentín", "Día de la Madre",
  ]);
  assert.deepEqual(list.map(item => item.date), [
    "2026-10-31", "2026-12-25", "2026-12-31", "2027-02-09", "2027-02-14", "2027-05-09",
  ]);
  for (const item of list) {
    assert.ok(item.title.length <= 60, item.title);
    assert.ok(item.body.length <= 500, item.title);
    assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/);
  }

  // Enero: pizza y San Valentín son las siguientes.
  assert.deepEqual(campaignDates(new Date(2027, 0, 1)).slice(0, 3).map(item => item.date), ["2027-02-09", "2027-02-14", "2027-05-09"]);
  // 2.º domingo de mayo (2027-05-09) ya pasó: desde el 10 aparece el Día del Padre (3.er domingo de junio).
  const fromMay = campaignDates(new Date(2027, 4, 10));
  assert.ok(fromMay.some(item => item.title === "Día del Padre" && item.date === "2027-06-20"));
  assert.ok(!fromMay.some(item => item.title === "Día de la Madre" && item.date.startsWith("2027")));
  assert.ok(campaignDates(new Date(NaN)).length === 6, "una fecha inválida cae a hoy");
});

test("la página incluye tarjeta bloqueada, exportación, opiniones, carteles y fechas", () => {
  const html = renderPage({ slug: "demo", host: "demo.craft-systems.com" });
  for (const text of [
    "Activa tu tarjeta de fidelidad por USD 5 al mes", "Activar ahora",
    "Exportar clientes (CSV)", "Opiniones", "Lo que dicen tus clientes", "Promedio",
    "Cumpleaños", "Regalo de cumpleaños", "Clientes inactivos", "Días sin visita",
    "Descargar cartel para la caja", "Descargar cartel para la mesa",
    "Únete a nuestro club", "Pide desde tu celular", "Escanea con la cámara de tu celular",
    "Fechas que se vienen", "Carteles para imprimir",
  ]) assert.ok(html.includes(text), `incluye ${text}`);
  assert.match(html, /loyalty\/customers\.csv/);
  assert.match(html, /plan_requerido/);
  assert.match(html, /me\.loyalty_pay_url/);
  assert.match(html, /const POSTER_W = 1240, POSTER_H = 1748/);
  assert.match(html, /window\.__panelDates/);
  assert.equal(html.includes("http://"), false, "sin http:// literal");
  assert.equal(/innerHTML/.test(html), false, "sin innerHTML");

  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 3, "datos, QR+fechas y runtime");
  for (const src of scripts) assert.doesNotThrow(() => new Function(src));
});
