import test from "node:test";
import assert from "node:assert/strict";
import { makeKV } from "./helpers.mjs";
import { walletEnabled, walletSaveUrl, walletSync, walletNotify } from "../src/wallet.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://walletobjects.googleapis.com/walletobjects/v1";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const privateKey = pem("PRIVATE KEY", new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)));
const publicKey = await crypto.subtle.exportKey("spki", pair.publicKey);
let identity = 0;

function env(extra = {}) {
  const client_email = `wallet-test-${++identity}@example.iam.gserviceaccount.com`;
  return { GW_ISSUER_ID: "3388000000023226869", GW_SA_JSON: JSON.stringify({ client_email, private_key: privateKey }), MENUS: makeKV(), ...extra };
}

const cfg = { stamps_goal: 8 };
const customer = { phone: "593991234567", name: "Ana Pérez", stamps: 3 };

test("walletEnabled exige issuer y service account", () => {
  assert.equal(walletEnabled({}), false);
  assert.equal(walletEnabled({ GW_ISSUER_ID: "1", GW_SA_JSON: "{}" }), true);
  assert.equal(walletEnabled({ GW_ISSUER_ID: "x.y", GW_SA_JSON: "{}" }), false);
});

test("Wallet rechaza IDs de clase y objeto inválidos antes de llamar a Google", async () => {
  const e = env();
  await assert.rejects(walletSaveUrl(e, "mal/slug", {}, cfg, customer, []), /Slug de Wallet inválido/);
  await assert.rejects(walletSaveUrl(e, "demo", {}, cfg, { ...customer, phone: "1/x" }, []), /Teléfono de Wallet inválido/);
});

test("walletSaveUrl firma RS256, crea la clase y reutiliza token y hash de KV", async () => {
  const e = env();
  const calls = [];
  await withFetch(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (url === TOKEN_URL) return Response.json({ access_token: "oauth-1", expires_in: 3600 });
    if (String(url).includes("/loyaltyClass/") && !init.method) return new Response("", { status: 404 });
    if (String(url).endsWith("/loyaltyClass") && init.method === "POST") return Response.json({ id: "ok" });
    throw new Error(`request inesperado: ${url}`);
  }, async () => {
    const rewards = Array.from({ length: 7 }, (_, i) => ({ label: `Premio ${i + 1}` }));
    const menu = { store_name: "Café <Norte>", logo: "https://cdn.example/logo.svg?x=1", theme_primary: "rojo" };
    const url = await walletSaveUrl(e, "cafe-norte", menu, cfg, customer, rewards);
    assert.match(url, /^https:\/\/pay\.google\.com\/gp\/v\/save\//);
    const jwt = url.split("/").at(-1);
    assert.equal(await verify(jwt), true);
    const claims = decode(jwt);
    assert.equal(claims.aud, "google");
    assert.equal(claims.typ, "savetowallet");
    assert.deepEqual(claims.origins, []);
    const object = claims.payload.loyaltyObjects[0];
    assert.equal(object.id, "3388000000023226869.cafe-norte_593991234567");
    assert.equal(object.classId, "3388000000023226869.cafe-norte");
    assert.deepEqual(object.loyaltyPoints, { label: "Sellos", balance: { string: "3/8" } });
    assert.deepEqual(object.secondaryLoyaltyPoints, { label: "Premios", balance: { int: 7 } });
    assert.equal(object.barcode.value, "https://cafe-norte.craft-systems.com/club");
    assert.deepEqual(object.linksModuleData.uris.map(x => x.description), ["Ver menú", "Mi club"]);
    assert.deepEqual(object.textModulesData.map(x => x.body), ["Premio 1", "Premio 2", "Premio 3", "Premio 4", "Premio 5"]);

    const oauth = calls.find(x => x.url === TOKEN_URL);
    const form = new URLSearchParams(oauth.init.body);
    assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const assertion = form.get("assertion");
    assert.equal(await verify(assertion), true);
    assert.deepEqual(decode(assertion), {
      iss: JSON.parse(e.GW_SA_JSON).client_email,
      scope: "https://www.googleapis.com/auth/wallet_object.issuer",
      aud: TOKEN_URL,
      iat: decode(assertion).iat,
      exp: decode(assertion).exp,
    });
    assert.equal(decode(assertion).exp - decode(assertion).iat, 3600);

    const create = calls.find(x => x.init.method === "POST" && x.url.endsWith("/loyaltyClass"));
    const klass = JSON.parse(create.init.body);
    assert.equal(klass.issuerName, "Café <Norte>");
    assert.equal(klass.programLogo.sourceUri.uri, "https://media.craft-systems.com/brand/craft-logo.jpeg");
    assert.equal(klass.hexBackgroundColor, "#1a1a1a");
    assert.equal(klass.reviewStatus, "UNDER_REVIEW");
    assert.match(await e.MENUS.get("cafe-norte:wallet_class"), /^[0-9a-f]{64}$/);

    await walletSaveUrl(e, "cafe-norte", menu, cfg, customer, rewards);
    assert.equal(calls.filter(x => x.url === TOKEN_URL).length, 1, "el token se cachea");
    assert.equal(calls.filter(x => x.url.includes("loyaltyClass")).length, 2, "el hash evita consultar otra vez la clase");
  });
});

test("walletSaveUrl actualiza una clase existente solo cuando cambió la marca", async () => {
  const e = env();
  const writes = [];
  const menu = { store_name: "Nuevo Nombre", logo: "https://cdn.example/logo.png", theme_primary: "#123AbC" };
  await withFetch(async (url, init = {}) => {
    if (url === TOKEN_URL) return Response.json({ access_token: "oauth-2", expires_in: 3600 });
    if (!init.method && String(url).includes("/loyaltyClass/")) return Response.json({ issuerName: "Viejo", programName: "Viejo", programLogo: { sourceUri: { uri: "https://old/logo.png" } }, hexBackgroundColor: "#000000" });
    if (init.method === "PUT") { writes.push(JSON.parse(init.body)); return Response.json({ id: "updated" }); }
    throw new Error(`request inesperado: ${url}`);
  }, async () => walletSaveUrl(e, "tienda-1", menu, cfg, customer, []));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].programName, "Nuevo Nombre");
  assert.equal(writes[0].programLogo.sourceUri.uri, "https://cdn.example/logo.png");
  assert.equal(writes[0].hexBackgroundColor, "#123AbC");
});

test("walletSaveUrl no hace PUT si la clase remota ya tiene la misma marca", async () => {
  const e = env();
  let writes = 0;
  const menu = { store_name: "La Casa", logo: "https://cdn.example/logo.jpg", theme_primary: "#abcdef" };
  await withFetch(async (url, init = {}) => {
    if (url === TOKEN_URL) return Response.json({ access_token: "oauth-same", expires_in: 3600 });
    if (!init.method && String(url).includes("/loyaltyClass/")) return Response.json({
      issuerName: "La Casa", programName: "La Casa",
      programLogo: { sourceUri: { uri: "https://cdn.example/logo.jpg" } },
      hexBackgroundColor: "#abcdef",
    });
    writes++;
    return Response.json({});
  }, async () => walletSaveUrl(e, "la-casa", menu, cfg, customer, []));
  assert.equal(writes, 0);
  assert.match(await e.MENUS.get("la-casa:wallet_class"), /^[0-9a-f]{64}$/);
});

test("walletSync envía el objeto completo y nunca lanza ante 404, error o credenciales malas", async () => {
  const e = env();
  const objects = [];
  let status = 404;
  await quietErrors(async () => withFetch(async (url, init = {}) => {
    if (url === TOKEN_URL) return Response.json({ access_token: "oauth-3", expires_in: 3600 });
    if (init.method === "PUT" && String(url).includes("/loyaltyObject/")) {
      objects.push(JSON.parse(init.body));
      return new Response("", { status });
    }
    throw new Error(`request inesperado: ${url}`);
  }, async () => {
    await assert.doesNotReject(walletSync(e, "demo", {}, cfg, customer, [{ label: "Postre" }]));
    status = 500;
    await assert.doesNotReject(walletSync(e, "demo", {}, cfg, customer, []));
    await assert.doesNotReject(walletSync({}, "demo", {}, cfg, customer, []));
  }));
  assert.equal(objects.length, 2);
  assert.equal(objects[0].accountName, "Ana Pérez");
  assert.equal(objects[0].secondaryLoyaltyPoints.balance.int, 1);
});

test("walletNotify limita concurrencia, reintenta cuota como TEXT y cuenta 404/error", async () => {
  const e = env();
  const phones = Array.from({ length: 10 }, (_, i) => `5939900000${String(i).padStart(2, "0")}`);
  let active = 0, maximum = 0, tokens = 0;
  const messages = new Map();
  const attempts = new Map();
  const result = await quietErrors(async () => withFetch(async (url, init = {}) => {
    if (url === TOKEN_URL) { tokens++; return Response.json({ access_token: "oauth-4", expires_in: 3600 }); }
    const phone = decodeURIComponent(String(url).match(/_(\d+)\/addMessage$/)?.[1] || "");
    active++;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 8));
    active--;
    const message = JSON.parse(init.body).message;
    messages.set(phone, [...(messages.get(phone) || []), message]);
    const n = (attempts.get(phone) || 0) + 1;
    attempts.set(phone, n);
    if (phone === phones[0] && n === 1) return new Response('{"error":{"status":"QuotaExceeded"}}', { status: 403 });
    if (phone === phones[1]) return new Response("", { status: 404 });
    if (phone === phones[2]) throw new Error("socket cerrado");
    if (phone === phones[3] && n === 1) return new Response("", { status: 429 });
    return Response.json({ ok: true });
  }, () => walletNotify(e, "demo", phones, { title: "Hoy", body: "Premio doble" })));

  assert.deepEqual(result, { sent: 8, failed: 2 });
  assert.ok(maximum <= 6, `concurrencia observada: ${maximum}`);
  assert.equal(tokens, 1, "las llamadas concurrentes comparten la renovación OAuth");
  assert.deepEqual(messages.get(phones[0]).map(x => x.messageType), ["TEXT_AND_NOTIFY", "TEXT"]);
  assert.equal(messages.get(phones[0])[0].id, messages.get(phones[0])[1].id);
  assert.deepEqual(messages.get(phones[3]).map(x => x.messageType), ["TEXT_AND_NOTIFY", "TEXT"]);
  assert.equal(messages.get(phones[4])[0].header, "Hoy");
  assert.equal(messages.get(phones[4])[0].body, "Premio doble");
  assert.equal(new Set([...messages.values()].flat().filter(x => x.messageType === "TEXT_AND_NOTIFY").map(x => x.id)).size, phones.length);
});

test("OAuth renueva tokens que ya están dentro del margen de cinco minutos", async () => {
  const e = env();
  let tokens = 0;
  await quietErrors(async () => withFetch(async (url, init = {}) => {
    if (url === TOKEN_URL) return Response.json({ access_token: `short-${++tokens}`, expires_in: 300 });
    if (init.method === "PUT") return new Response("", { status: 404 });
    throw new Error(`request inesperado: ${url}`);
  }, async () => {
    await walletSync(e, "demo", {}, cfg, customer, []);
    await walletSync(e, "demo", {}, cfg, customer, []);
  }));
  assert.equal(tokens, 2);
});

test("respuesta OAuth inválida se rechaza al guardar y se absorbe al sincronizar/notificar", async () => {
  const e = env();
  await quietErrors(async () => withFetch(async url => {
    assert.equal(url, TOKEN_URL);
    return Response.json({ expires_in: 3600 });
  }, async () => {
    await assert.rejects(walletSaveUrl(e, "demo", {}, cfg, customer, []), /Respuesta OAuth inválida/);
    await assert.doesNotReject(walletSync(e, "demo", {}, cfg, customer, []));
    assert.deepEqual(await walletNotify(e, "demo", [customer.phone], { title: "a", body: "b" }), { sent: 0, failed: 1 });
  }));
});

async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}

async function quietErrors(run) {
  const original = console.error;
  console.error = () => {};
  try { return await run(); }
  finally { console.error = original; }
}

function pem(label, bytes) {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

function decode(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
}

async function verify(jwt) {
  const [header, claims, signature] = jwt.split(".");
  const key = await crypto.subtle.importKey("spki", publicKey, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signature, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
}

test("la clase lleva merchantLocations de las sedes con coordenadas (máx. 10) y cambiarlas re-sincroniza", async () => {
  const { loyaltyClassForTest } = await import("../src/wallet.js");
  const sedes = Array.from({ length: 12 }, (_, i) => ({ nombre: `S${i}`, lat: -0.1 - i / 100, lng: -78.4 }));
  const klass = loyaltyClassForTest({ GW_ISSUER_ID: "1" }, "s", { store_name: "S", location: { sedes: [{ nombre: "sin" }, ...sedes] } });
  assert.equal(klass.merchantLocations.length, 10);
  assert.deepEqual(klass.merchantLocations[0], { latitude: -0.1, longitude: -78.4 });
  assert.deepEqual(loyaltyClassForTest({ GW_ISSUER_ID: "1" }, "s", {}).merchantLocations, []);
});
