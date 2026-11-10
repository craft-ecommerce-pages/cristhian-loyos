import { test } from "node:test";
import assert from "node:assert";
import { resolveSlug, render, trackingTags, SHELL_EN, esc, jsonInline, sanitizeBrandSub, handle, siteFile, contentType, ogTags, clubBinding } from "./src/lib.js";

test("/club y subrutas pasan el Request intacto al binding; sin binding sigue el menú", async () => {
  const calls = [];
  const loyalty = { LOYALTY: { fetch: request => { calls.push(request); return Promise.resolve(new Response("club")); } } };
  for (const path of ["/club", "/club/", "/club/api/play"]) {
    const request = new Request(`https://pizza.menu.test${path}`, { method: "POST", headers: { cookie: "club_s=x" }, body: "{}" });
    assert.equal((await clubBinding(request, loyalty)).status, 200);
    assert.equal(calls.at(-1), request);
  }
  assert.equal(clubBinding(new Request("https://pizza.menu.test/clubbing"), loyalty), null);
  assert.equal(clubBinding(new Request("https://pizza.menu.test/club"), env2), null);
  assert.equal((await handle(U("pizza.menu.test", "/club"), env2, "TPL")).status, 301);
});

test("/panel y subrutas van al binding PANEL; /panelx no", async () => {
  const calls = [];
  const env = { PANEL: { fetch: request => { calls.push(request); return Promise.resolve(new Response("panel")); } } };
  for (const path of ["/panel", "/panel/", "/panel/api/me", "/panel/e"]) {
    const request = new Request(`https://pizza.menu.test${path}`);
    assert.equal((await clubBinding(request, env)).status, 200);
    assert.equal(calls.at(-1), request);
  }
  assert.equal(clubBinding(new Request("https://pizza.menu.test/panelx"), env), null);
  assert.equal(clubBinding(new Request("https://pizza.menu.test/club"), env), null);
});

test("/api y /media van al binding PANEL (checkout y media R2); prefijos parecidos no", async () => {
  const calls = [];
  const env = { PANEL: { fetch: request => { calls.push(request); return Promise.resolve(new Response("panel")); } } };
  for (const path of ["/api", "/api/sedes", "/api/orders", "/api/payphone/return", "/media", "/media/panel/pizza/a.webp"]) {
    const request = new Request(`https://pizza.menu.test${path}`);
    assert.equal((await clubBinding(request, env)).status, 200, path);
    assert.equal(calls.at(-1), request, path);
  }
  assert.equal(clubBinding(new Request("https://pizza.menu.test/apix"), env), null);
  assert.equal(clubBinding(new Request("https://pizza.menu.test/mediax/a.webp"), env), null);
});

// Hosts propios mapeados en KV (`domain:{host}` → slug): el Worker no deriva el slug del subdominio.
const env = { MENUS: { get: async (k) => (k === "domain:pedidos.pizza.com" ? "pizzaplanet" : null) } };

// KV con una tienda (demo, tiene :site) y un menú (pizza, solo :config) para probar el ruteo.
const store = { "/index.html": "<h1>home</h1>", "/pages/productos.html": "<h1>cat</h1>", "/assets/app.js": "x" };
const kv = {
  "domain:demo.menu.test": "demo",
  "domain:pizza.menu.test": "pizza",
  "demo:site": JSON.stringify(store),
  "demo:productos": '[{"id":"x"}]',
  "pizza:config": '{"store_name":"Pizza"}',
};
const env2 = { MENUS: { get: async (k) => (k in kv ? kv[k] : null) } };
const U = (host, path = "/") => new URL(`https://${host}${path}`);

test('cobertura carga el selector solo para menús con sedes geolocalizadas',()=>{
  const tpl='<!--COVERAGE--><script><!--CONFIG--></script>';
  assert.ok(!render(tpl,{},'{}','').includes('/geo.js'));
  const cfg={location:{sedes:[{id:'norte',nombre:'Norte',lat:0,lng:0,radio_km:2}]}};
  const result=render(tpl,cfg,JSON.stringify(cfg),'');
  assert.ok(result.includes('/v1/geo.js'));assert.ok(result.includes('"id":"norte"'));
});

test("handle: tienda sirve estático desde {slug}:site (/ → /index.html, query ignorada, 404)", async () => {
  const home = await handle(U("demo.menu.test", "/"), env2, "TPL");
  assert.equal(home.status, 200);
  assert.equal(home.body, "<h1>home</h1>");
  assert.match(home.headers["content-type"], /text\/html/);

  const js = await handle(U("demo.menu.test", "/assets/app.js?v=2"), env2, "TPL");
  assert.match(js.headers["content-type"], /javascript/); // content-type por extensión, query ignorada

  const prod = await handle(U("demo.menu.test", "/productos.json"), env2, "TPL");
  assert.equal(prod.body, '[{"id":"x"}]');

  assert.equal((await handle(U("demo.menu.test", "/nope"), env2, "TPL")).status, 404);
});

test("handle: sin {slug}:site rutea al render del menú", async () => {
  const out = await handle(U("pizza.menu.test", "/"), env2, "<title><!--TITLE--></title>");
  assert.equal(out.status, 200);
  assert.ok(out.body.includes("Pizza"));       // render inyectó store_name
  assert.ok(!out.body.includes("<!--TITLE-->"));
});

test("handle: menú config-driven redirige rutas ≠ / a / (conserva query)", async () => {
  const out = await handle(U("pizza.menu.test", "/pages/contacto.html?mesa=3"), env2, "TPL");
  assert.equal(out.status, 301);
  assert.equal(out.headers.location, "/?mesa=3");
  assert.equal((await handle(U("pizza.menu.test", "/index.html"), env2, "TPL")).status, 200);
});

test("ogTags: og_image > logo, description opcional, escapa", () => {
  const t = ogTags({ og_image: "https://m/x.jpg", logo: "https://m/l.png", og_description: 'a"b' }, "S");
  assert.ok(t.includes('og:image" content="https://m/x.jpg"') && t.includes("a&quot;b"));
  assert.ok(ogTags({ logo: "https://m/l.png" }, "S").includes("l.png"));
  assert.ok(!ogTags({}, "S").includes("og:image"));
  assert.ok(ogTags({ og_title: "NH", site_title: "largo" }, "S").includes('og:title" content="NH"'));
});

test("siteFile / contentType (con índice de directorio)", () => {
  assert.equal(siteFile(store, "/").body, "<h1>home</h1>");
  assert.equal(siteFile(store, "/nope"), null);
  assert.equal(contentType("/a.css"), "text/css;charset=utf-8");
  assert.equal(contentType("/a.js"), "application/javascript;charset=utf-8");
  const nested = { "/funnel/x/index.html": "F" };
  assert.equal(siteFile(nested, "/funnel/x/").body, "F");   // barra final → index.html
  assert.equal(siteFile(nested, "/funnel/x").body, "F");    // sin extensión → /index.html
});

test("resolveSlug: workers.dev por CLIENT_SLUG, host propio por KV, fallback de desarrollo", async () => {
  // workers.dev: no consulta KV, usa el slug del despliegue.
  assert.equal(await resolveSlug("menu.cliente.workers.dev", { CLIENT_SLUG: "zuba" }), "zuba");
  assert.equal(await resolveSlug("menu.cliente.workers.dev", {}), null); // sin CLIENT_SLUG → 404

  // Dominio propio con mapping explícito en KV (precede al fallback).
  assert.equal(await resolveSlug("pedidos.pizza.com", env), "pizzaplanet");
  assert.equal(await resolveSlug("pedidos.pizza.com", { ...env, CLIENT_SLUG: "otro" }), "pizzaplanet");

  // Host enrutado al Worker sin mapping: cae al slug único del cliente.
  assert.equal(await resolveSlug("menu.pizza.com", { ...env, CLIENT_SLUG: "pizza" }), "pizza");

  // Sin CLIENT_SLUG (solo desarrollo/pruebas): primer label si el host tiene subdominio.
  assert.equal(await resolveSlug("pizza.dev.test", {}), "pizza");
  assert.equal(await resolveSlug("otro.com", env), null); // sin subdominio no se inventa slug
  assert.equal(await resolveSlug("otro.com", {}), null);
});

test("render usa /v1 local (Workers Assets) y no depende de craft-catalog-engine.pages.dev", async () => {
  const { readFileSync } = await import("node:fs");
  const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  const out = render(tpl, { store_name: "S" }, '{"store_name":"S"}', "");
  assert.ok(out.includes('href="/v1/catalog.css"'));
  assert.ok(out.includes('src="/v1/catalog.js'));
  assert.ok(!out.includes("craft-catalog-engine.pages.dev"));
  const custom = render(tpl, { store_name: "S" }, "{}", "", "https://cdn.cliente.test/v1");
  assert.ok(custom.includes('href="https://cdn.cliente.test/v1/catalog.css"'));
  assert.ok(custom.includes('src="https://cdn.cliente.test/v1/catalog.js'));
});

test("assets /v1 publicados por el Worker coinciden con v1/ (fuente canónica)", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["catalog.js", "catalog.css", "geo.js"]) {
    const src = readFileSync(new URL(`../v1/${f}`, import.meta.url));
    const copy = readFileSync(new URL(`./assets/v1/${f}`, import.meta.url));
    assert.ok(src.equals(copy), `worker/assets/v1/${f} desincronizado; ejecuta worker/sync-v1-assets.sh`);
  }
});

test("render inyecta tokens/config y escapa XSS", () => {
  const tpl = "<title><!--TITLE--></title><style><!--VARS--></style><style><!--THEME--></style><img src='<!--LOGO-->'><script><!--CONFIG--></script>";
  const cfg = { store_name: 'A"><script>x</script>', theme_primary: "#111", logo: "https://media.craft-systems.com/l.png" };
  const raw = JSON.stringify(cfg);
  const out = render(tpl, cfg, raw, "body{color:red}");
  assert.ok(out.includes("--primary:#111"));
  assert.ok(out.includes("body{color:red}")); // theme inline
  assert.ok(out.includes("window.__CONFIG__="));
  assert.ok(!out.includes("<title>A\"><script>x")); // el título escapado, no rompe el head
});

test("trackingTags emite etiquetas estándar y descarta IDs inválidos", () => {
  const tags = trackingTags({ tracking: { meta_pixel_id: "1216337266007176", tiktok_pixel_id: "D0HCDTBC77U0QQJ0ADPG", gtm_container_id: "GTM-WJDC95F" } });
  assert.match(tags.head, /connect\.facebook\.net\/en_US\/fbevents\.js/);
  assert.match(tags.head, /analytics\.tiktok\.com\/i18n\/pixel\/events\.js/);
  assert.match(tags.head, /googletagmanager\.com\/gtm\.js/);
  assert.match(tags.noscript, /googletagmanager\.com\/ns\.html\?id=GTM-WJDC95F/);
  assert.equal(trackingTags({ tracking: { meta_pixel_id: '<script>', gtm_container_id: 'GTM-<bad>' } }).head, "");
});

test("jsonInline neutraliza cierre de script", () => {
  assert.ok(!jsonInline('{"x":"</script>"}').includes("</script>"));
});

test("esc", () => {
  assert.equal(esc('<b>"&'), "&lt;b&gt;&quot;&amp;");
});

test("sanitizeBrandSub permite solo spans de color de marca", () => {
  assert.equal(
    sanitizeBrandSub('<span style="color:#fff">Más</span> <span style="color:var(--primary)">Sabor.</span>'),
    '<span style="color:#fff">Más</span> <span style="color:var(--primary)">Sabor.</span>',
  );
  assert.equal(sanitizeBrandSub('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});

test("SHELL_EN: cada texto existe en template.html y locale en traduce el shell; sin locale no cambia", async () => {
  const { readFileSync } = await import("node:fs");
  const tpl = readFileSync(new URL("./template.html", import.meta.url), "utf8");
  for (const [es] of SHELL_EN) assert.ok(tpl.includes(es), `falta en template: ${es}`);
  const cfg = { store_name: "S" };
  assert.equal(render(tpl, cfg, "{}", ""), render(tpl, { ...cfg, locale: "es" }, "{}", ""));
  const en = render(tpl, { ...cfg, locale: "en" }, "{}", "");
  assert.match(en, /<html lang="en">/);
  for (const w of ["Tu Pedido", "Realizar pedido", "Retiro en local", "Ver mi carrito", "Confirmar pedido"]) assert.ok(!en.includes(w), w);
});
