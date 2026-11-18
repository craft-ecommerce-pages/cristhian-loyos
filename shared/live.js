// Avisos en vivo para caja y cocina: WebSocket con reconexión y respaldo lento.
// Se serializa al navegador con String(liveOrders), así que el cuerpo no puede
// depender de imports ni de variables externas.
export function liveOrders(options) {
  const opts = options || {};
  const change = typeof opts.onChange === "function" ? opts.onChange : () => {};
  const status = typeof opts.onStatus === "function" ? opts.onStatus : () => {};
  const sede = opts.sede == null ? "" : String(opts.sede);
  const WS =
    (typeof window !== "undefined" && window.WebSocket) ||
    (typeof WebSocket !== "undefined" ? WebSocket : undefined);
  if (typeof WS !== "function") {
    status("unsupported");
    return { close() {} };
  }
  const BACKOFF = [1000, 2000, 5000, 10000, 30000];
  let socket = null;
  let closed = false;
  let attempt = 0;
  let openedAt = 0;
  let pingTimer = 0;
  let retryTimer = 0;
  let debounceTimer = 0;

  function address() {
    const loc =
      (typeof location !== "undefined" && location) ||
      (typeof window !== "undefined" && window.location) ||
      {};
    return (
      (loc.protocol === "https:" ? "wss:" : "ws:") +
      "//" +
      (loc.host || "") +
      "/panel/api/pos/live?sede_id=" +
      encodeURIComponent(sede)
    );
  }
  // Varios avisos seguidos en menos de 300 ms producen un solo load.
  function signal() {
    if (debounceTimer || closed) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      if (!closed) change();
    }, 300);
  }
  function stopPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = 0;
    }
  }
  function drop() {
    stopPing();
    if (!socket) return;
    try {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    } catch {
      /* el socket ya estaba roto */
    }
    socket = null;
  }
  function reconnect() {
    if (closed) return;
    const wait =
      BACKOFF[Math.min(attempt, BACKOFF.length - 1)] +
      Math.floor(Math.random() * 500);
    attempt += 1;
    retryTimer = setTimeout(open, wait);
  }
  // Cierre o error: se avisa una sola vez y se reintenta con backoff.
  function lost() {
    if (closed) return;
    drop();
    status("offline");
    // Una conexión que duró más de un minuto reinicia el backoff.
    if (openedAt && Date.now() - openedAt > 60000) attempt = 0;
    openedAt = 0;
    reconnect();
  }
  function open() {
    retryTimer = 0;
    if (closed) return;
    let ws;
    try {
      ws = new WS(address());
    } catch {
      lost();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      if (closed) return;
      openedAt = Date.now();
      status("live");
      // Al (re)conectar siempre se pone al día: un aviso pudo perderse.
      change();
      stopPing();
      pingTimer = setInterval(() => {
        try {
          ws.send("ping");
        } catch {
          /* el cierre ya dispara la reconexión */
        }
      }, 45000);
    };
    ws.onmessage = (event) => {
      let data = event && event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (data && data.t === "orders") signal();
    };
    ws.onclose = lost;
    ws.onerror = lost;
  }
  function close() {
    closed = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = 0;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = 0;
    }
    drop();
  }
  open();
  return { close };
}
