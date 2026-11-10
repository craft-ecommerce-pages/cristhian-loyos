import { cardUrl, sedesWithCoords } from "./contract.js";
// Google Wallet: OAuth/JWT y REST sin dependencias. Todos los IDs se derivan del tenant y el teléfono.
const API = "https://walletobjects.googleapis.com/walletobjects/v1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAVE_URL = "https://pay.google.com/gp/v/save/";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";
const FALLBACK_LOGO = "https://media.craft-systems.com/brand/craft-logo.jpeg";
const tokenCache = new Map();

// true si hay credenciales (env.GW_ISSUER_ID + secret env.GW_SA_JSON).
export function walletEnabled(env) {
  return Boolean(/^\d+$/.test(String(env?.GW_ISSUER_ID || "")) && env?.GW_SA_JSON);
}

// URL "Guardar en Google Wallet". La clase queda sincronizada antes de emitir el JWT de guardado.
export async function walletSaveUrl(env, slug, menuCfg, cfg, customer, activeRewards) {
  const auth = credentials(env);
  objectId(env, slug, customer?.phone); // validar antes de cualquier request externo
  await ensureClass(env, auth, slug, menuCfg);
  const object = loyaltyObject(env, slug, cfg, customer, activeRewards);
  const now = Math.floor(Date.now() / 1000);
  const jwt = await signJwt(auth, {
    iss: auth.clientEmail,
    aud: "google",
    typ: "savetowallet",
    iat: now,
    origins: [],
    payload: { loyaltyObjects: [object] },
  });
  return SAVE_URL + jwt;
}

// Actualiza un pase ya guardado. Un 404 significa que el cliente todavía no materializó el objeto.
export async function walletSync(env, slug, menuCfg, cfg, customer, activeRewards) {
  try {
    const auth = credentials(env);
    const object = loyaltyObject(env, slug, cfg, customer, activeRewards);
    const res = await googleFetch(auth, `${API}/loyaltyObject/${encodeURIComponent(object.id)}`, {
      method: "PUT",
      body: JSON.stringify(object),
    });
    if (res.status !== 404 && !res.ok) throw new Error(`Google Wallet respondió ${res.status}`);
  } catch (error) {
    console.error("Google Wallet: no se pudo sincronizar el pase", safeError(error));
  }
}

// Envía pushes con un máximo de seis subrequests simultáneos. La cuota de push degrada a mensaje silencioso.
export async function walletNotify(env, slug, phones, { title, body }) {
  let auth;
  try {
    auth = credentials(env);
  } catch (error) {
    console.error("Google Wallet: credenciales inválidas al enviar campaña", safeError(error));
    return { sent: 0, failed: phones.length };
  }
  let sent = 0, failed = 0, cursor = 0;
  const worker = async () => {
    while (cursor < phones.length) {
      const phone = phones[cursor++];
      const id = `campaign-${Date.now()}-${crypto.randomUUID()}`;
      try {
        const url = `${API}/loyaltyObject/${encodeURIComponent(objectId(env, slug, phone))}/addMessage`;
        let res = await addMessage(auth, url, title, body, id, "TEXT_AND_NOTIFY");
        if (await quotaExceeded(res)) res = await addMessage(auth, url, title, body, id, "TEXT");
        if (res.ok) sent++;
        else failed++;
      } catch (error) {
        failed++;
        console.error("Google Wallet: no se pudo enviar un mensaje", safeError(error));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, phones.length) }, worker));
  return { sent, failed };
}

async function ensureClass(env, auth, slug, menuCfg) {
  const value = loyaltyClass(env, slug, menuCfg);
  const hash = await sha256hex(JSON.stringify(value));
  const key = `${slug}:wallet_class`;
  if (await env.MENUS.get(key) === hash) return;

  const url = `${API}/loyaltyClass/${encodeURIComponent(value.id)}`;
  const current = await googleFetch(auth, url);
  let res;
  if (current.status === 404) {
    res = await googleFetch(auth, `${API}/loyaltyClass`, { method: "POST", body: JSON.stringify(value) });
  } else if (!current.ok) {
    throw new Error(`Google Wallet respondió ${current.status} al consultar la clase`);
  } else {
    const remote = await jsonObject(current, "clase");
    if (!sameBrand(remote, value)) res = await googleFetch(auth, url, { method: "PUT", body: JSON.stringify(value) });
  }
  if (res && !res.ok) throw new Error(`Google Wallet respondió ${res.status} al guardar la clase`);
  await env.MENUS.put(key, hash);
}

function loyaltyClass(env, slug, menuCfg) {
  const name = nonEmpty(menuCfg?.store_name, "Craft Systems");
  return {
    id: classId(env, slug),
    issuerName: name,
    programName: name,
    programLogo: { sourceUri: { uri: validLogo(menuCfg?.logo) } },
    hexBackgroundColor: validColor(menuCfg?.theme_primary),
    // Aviso por cercanía: Google decide radio, texto y si lo muestra (máx. 10 por clase).
    merchantLocations: sedesWithCoords(menuCfg).slice(0, 10).map(x => ({ latitude: x.lat, longitude: x.lng })),
    reviewStatus: "UNDER_REVIEW",
  };
}

function loyaltyObject(env, slug, cfg, customer, activeRewards) {
  const rewards = Array.isArray(activeRewards) ? activeRewards : [];
  const origin = `https://${slug}.craft-systems.com`;
  // El QR del pase abre la tarjeta del cliente; el mesero lo escanea desde el modo caja.
  const code = typeof customer?.card_code === "string" ? customer.card_code : "";
  return {
    id: objectId(env, slug, customer.phone),
    classId: classId(env, slug),
    state: "ACTIVE",
    accountId: String(customer.phone),
    accountName: nonEmpty(customer.name, String(customer.phone)),
    loyaltyPoints: { label: "Sellos", balance: { string: `${customer.stamps}/${cfg.stamps_goal}` } },
    secondaryLoyaltyPoints: { label: "Premios", balance: { int: rewards.length } },
    barcode: code
      ? { type: "QR_CODE", value: cardUrl(slug, code), alternateText: code }
      : { type: "QR_CODE", value: `${origin}/club` }, // pases viejos sin código: se actualizan al sincronizar
    linksModuleData: { uris: [
      { id: "menu", uri: `${origin}/`, description: "Ver menú" },
      { id: "club", uri: `${origin}/club`, description: "Mi club" },
    ] },
    textModulesData: rewards.slice(0, 5).map((reward, i) => ({ id: `reward_${i + 1}`, header: "Premio activo", body: nonEmpty(reward?.label, "Premio") })),
  };
}

function classId(env, slug) {
  if (!/^[a-z0-9-]{1,63}$/.test(slug)) throw new Error("Slug de Wallet inválido");
  return `${env.GW_ISSUER_ID}.${slug}`;
}

function objectId(env, slug, phone) {
  if (!/^\d{10,15}$/.test(String(phone))) throw new Error("Teléfono de Wallet inválido");
  return `${classId(env, slug)}_${phone}`;
}

function credentials(env) {
  if (!walletEnabled(env)) throw new Error("Google Wallet no está configurado");
  let raw;
  try { raw = JSON.parse(env.GW_SA_JSON); } catch { throw new Error("GW_SA_JSON no es JSON válido"); }
  if (!raw || typeof raw.client_email !== "string" || !raw.client_email || typeof raw.private_key !== "string" || !raw.private_key)
    throw new Error("GW_SA_JSON no contiene client_email/private_key");
  return { clientEmail: raw.client_email, privateKey: raw.private_key };
}

async function accessToken(auth) {
  const cacheKey = `${auth.clientEmail}\n${auth.privateKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 300_000) return cached.token;
  if (cached?.pending) return cached.pending;
  const pending = requestToken(auth).then(value => {
    tokenCache.set(cacheKey, value);
    return value.token;
  }, error => {
    tokenCache.delete(cacheKey);
    throw error;
  });
  tokenCache.set(cacheKey, { pending, expiresAt: 0 });
  return pending;
}

async function requestToken(auth) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt(auth, { iss: auth.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`OAuth de Google respondió ${res.status}`);
  const data = await jsonObject(res, "token OAuth");
  if (typeof data.access_token !== "string" || !data.access_token || !Number.isFinite(Number(data.expires_in)))
    throw new Error("Respuesta OAuth inválida");
  const expiresIn = Math.max(0, Number(data.expires_in));
  return { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
}

async function googleFetch(auth, url, init = {}) {
  const token = await accessToken(auth);
  return fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
}

async function addMessage(auth, url, title, body, id, messageType) {
  return googleFetch(auth, url, {
    method: "POST",
    body: JSON.stringify({ message: { header: title, body, messageType, id } }),
  });
}

async function quotaExceeded(res) {
  if (res.status === 429) return true;
  if (res.ok || res.status === 404) return false;
  try { return (await res.clone().text()).includes("QuotaExceeded"); } catch { return false; }
}

async function signJwt(auth, payload) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify(payload));
  const input = `${header}.${claims}`;
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(auth.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

function pemBytes(pem) {
  const value = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
  if (!value) throw new Error("private_key no es PKCS8 válido");
  try { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  catch { throw new Error("private_key no es PKCS8 válido"); }
}

function base64url(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function sha256hex(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function jsonObject(res, label) {
  let value;
  try { value = await res.json(); } catch { throw new Error(`Respuesta de ${label} inválida`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Respuesta de ${label} inválida`);
  return value;
}

function sameBrand(remote, local) {
  return remote?.issuerName === local.issuerName && remote?.programName === local.programName &&
    remote?.programLogo?.sourceUri?.uri === local.programLogo.sourceUri.uri &&
    remote?.hexBackgroundColor === local.hexBackgroundColor &&
    JSON.stringify(remote?.merchantLocations || []) === JSON.stringify(local.merchantLocations);
}

function validLogo(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !/\.(?:svg|webp)$/i.test(url.pathname) ? url.href : FALLBACK_LOGO;
  } catch { return FALLBACK_LOGO; }
}

function validColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : "#1a1a1a";
}

function nonEmpty(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function safeError(error) {
  return error instanceof Error ? error.message : "error desconocido";
}
export const loyaltyClassForTest = loyaltyClass; // solo tests
