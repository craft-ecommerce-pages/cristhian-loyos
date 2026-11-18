// STUB del contrato (/home/jcadmin/proyectos/clientes/munch/.ops/2026-11-18-tiempo-real/CONTRATO.md). Tarea 1 lo implementa.
export class OrdersHub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch() { return new Response(null, { status: 400 }); }
}
export async function notifyOrders(env, slug, sedeId) {}
export async function handleLive(request, env, site, session) {
  return new Response(JSON.stringify({ error: "tiempo_real_no_disponible" }), { status: 503 });
}
