// Tiempo real de caja y cocina (CONTRATO 2026-11-18): un Durable Object por sede
// avisa únicamente "algo cambió"; cada pantalla pide la cola por HTTP.
// Sin RPC (`fetch` a pelo) y sin `cloudflare:workers`: los tests corren en Node.
import { error } from "./contract.js";
import { authorizedForSede } from "./orders.js";

const SEDE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTIFY_TIMEOUT_MS = 2000;

// Una instancia por sede: `slug:sede`.
export class OrdersHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Con la API de hibernación, el runtime responde "ping" sin despertar al DO.
    if (typeof globalThis.WebSocketRequestResponsePair === "function" && typeof ctx.setWebSocketAutoResponse === "function") {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/notify") {
      // Sin datos del cliente en el mensaje: solo el tipo y la hora.
      const message = JSON.stringify({ t: "orders", at: Date.now() });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(message); } catch { /* un socket roto no corta el resto */ }
      }
      return new Response(null, { status: 204 });
    }
    if ((request.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);  // hibernación: nunca server.accept()
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(null, { status: 400 });
  }

  async webSocketMessage(ws, msg) {
    if (msg === "ping") ws.send("pong");
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code); } catch { /* ya cerrado */ }
  }

  async webSocketError() {}
}

// Aviso a la sede. Nunca lanza: un fallo del hub no puede romper el cobro; la
// consulta de respaldo de las pantallas recupera lo perdido.
export async function notifyOrders(env, slug, sedeId) {
  try {
    if (!env?.ORDERS_HUB || !sedeId) return;
    const stub = env.ORDERS_HUB.get(env.ORDERS_HUB.idFromName(`${slug}:${sedeId}`));
    const init = { method: "POST" };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function")
      init.signal = AbortSignal.timeout(NOTIFY_TIMEOUT_MS);
    await stub.fetch("https://hub/notify", init);
  } catch { console.warn("tiempo real: no se pudo avisar a la sede"); }
}

// GET /panel/api/pos/live?sede_id=<id> — sesión de dueño o caja (handlePosApi).
export async function handleLive(request, env, site, session) {
  const sedeId = new URL(request.url).searchParams.get("sede_id") || "";
  if (!SEDE_ID.test(sedeId)) return error("sede_requerida", 400);
  if (!await authorizedForSede(env, site.slug, session, sedeId)) return error("sin_permiso", 403);
  // El WebSocket no lo protege CORS: se compara el origen con el host propio.
  const origin = request.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch { /* origen ilegible: se rechaza */ }
    if (!host || host !== new URL(request.url).host) return error("origen_invalido", 403);
  }
  if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") return error("se_requiere_websocket", 426);
  if (!env.ORDERS_HUB || typeof env.ORDERS_HUB.idFromName !== "function") return error("tiempo_real_no_disponible", 503);
  return env.ORDERS_HUB.get(env.ORDERS_HUB.idFromName(`${site.slug}:${sedeId}`)).fetch(request);
}
