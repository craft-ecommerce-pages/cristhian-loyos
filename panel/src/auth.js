// A1: contraseñas (PBKDF2), sesión por cookie HMAC, tokens de reset. Firmas fijas.
import { PBKDF2_ITERATIONS, RESET_TTL_MS, SESSION_COOKIE } from "./contract.js";

const encoder = new TextEncoder();
const bytes = value => new Uint8Array(value);
const b64url = value => {
  let text = "";
  for (const byte of bytes(value)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const fromB64url = value => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const text = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(text, c => c.charCodeAt(0));
  } catch { return null; }
};

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const match = /^pbkdf2\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(String(stored || ""));
  if (!match || Number(match[1]) !== PBKDF2_ITERATIONS) return false;
  const salt = fromB64url(match[2]), expected = fromB64url(match[3]);
  if (!salt || !expected || salt.length !== 16 || expected.length !== 32) return false;
  return timingEqual(expected, await pbkdf2(password, salt, PBKDF2_ITERATIONS));
}

// → valor de cookie `<b64url(email)>.<pwd_ver>.<hmac>`
export async function signSession(env, slug, email, pwdVer) {
  const encodedEmail = b64url(encoder.encode(email));
  const version = String(Number(pwdVer));
  return `${encodedEmail}.${version}.${await hmac(env, `${slug}:${email}:${version}`)}`;
}

// → {email, pwd_ver} | null (valida HMAC, slug y pwd_ver contra D1)
export async function readSession(request, env, slug) {
  const raw = cookie(request.headers.get("cookie"), SESSION_COOKIE);
  const match = /^([A-Za-z0-9_-]+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(raw || "");
  if (!match) return null;
  const decoded = fromB64url(match[1]);
  if (!decoded) return null;
  let email;
  try { email = new TextDecoder("utf-8", { fatal: true }).decode(decoded); } catch { return null; }
  if (!email || !Number.isSafeInteger(Number(match[2]))) return null;
  const signature = await hmac(env, `${slug}:${email}:${match[2]}`);
  if (!timingEqual(encoder.encode(match[3]), encoder.encode(signature))) return null;
  const user = await env.DB.prepare("SELECT email, pwd_ver FROM panel_users WHERE slug = ?").bind(slug).first();
  if (!user || !timingEqual(encoder.encode(email), encoder.encode(user.email)) || Number(user.pwd_ver) !== Number(match[2])) return null;
  return { email: user.email, pwd_ver: Number(user.pwd_ver) };
}

export function generatePassword() {
  // Sin caracteres visualmente ambiguos para poder dictarla por WhatsApp.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const random = crypto.getRandomValues(new Uint8Array(10));
  return [...random].map(byte => alphabet[byte % alphabet.length]).join("");
}

export async function createResetToken(env, slug) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const expires_at = Date.now() + RESET_TTL_MS;
  await env.DB.prepare("INSERT INTO panel_resets (token_hash, slug, expires_at, used_at) VALUES (?, ?, ?, NULL)")
    .bind(await sha256hex(token), slug, expires_at).run();
  return { token, expires_at };
}

export async function sha256hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function timingEqual(left, right) {
  const a = left instanceof Uint8Array ? left : encoder.encode(String(left ?? ""));
  const b = right instanceof Uint8Array ? right : encoder.encode(String(right ?? ""));
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}

function cookie(header, name) {
  return (header || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

async function hmac(env, value) {
  const secret = typeof env.SESSION_SECRET === "string" ? env.SESSION_SECRET : "";
  if (!secret) throw new Error("SESSION_SECRET no configurado");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}
