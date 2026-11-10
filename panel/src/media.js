// Media pública del cliente: `GET /media/<key>` desde el binding R2 `MEDIA`.
// Evita depender de un dominio de media externo: el mismo bucket sirve al panel
// y al menú (workers.dev o dominio propio) con caché inmutable.
const NOT_FOUND = () => new Response("No existe", { status: 404, headers: { "cache-control": "no-store" } });

export async function handleMedia(request, env) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (!env?.MEDIA || typeof env.MEDIA.get !== "function") return NOT_FOUND();
  const pathname = new URL(request.url).pathname;
  let key;
  try { key = decodeURIComponent(pathname.slice("/media/".length)); } catch { return NOT_FOUND(); }
  if (!key || key.startsWith("/") || key.includes("..") || key.length > 512) return NOT_FOUND();
  const object = await env.MEDIA.get(key).catch(() => null);
  if (!object) return NOT_FOUND();
  const meta = object.httpMetadata || object.o?.httpMetadata || {};
  const headers = {
    "content-type": meta.contentType || "application/octet-stream",
    "cache-control": meta.cacheControl || "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  };
  if (object.httpEtag) headers.etag = object.httpEtag;
  else if (object.etag) headers.etag = object.etag;
  const body = request.method === "HEAD" ? null : (object.body ?? object.v ?? null);
  return new Response(body, { status: 200, headers });
}
