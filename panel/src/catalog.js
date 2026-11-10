// Catálogo nativo: D1 es la fuente; KV recibe únicamente la proyección del motor.
import { error, json, noContent } from "./contract.js";

const MAX = { products: 500, categories: 100, groups: 100, options: 50, packagings: 50 };
const own = (o, k) => Object.hasOwn(o, k);
const object = v => v != null && typeof v === "object" && !Array.isArray(v);
const text = (v, max = 120, empty = false) => typeof v === "string" && (empty || v.trim()) && [...v].length <= max;
const id = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v);
const finite = (v, min = 0, max = 1_000_000) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
// Media pública: ruta relativa `/media/<key>` servida por el Worker del cliente,
// URL absoluta del mismo origen público o, solo por compatibilidad de datos ya
// guardados, la media legacy de Craft. Nunca se genera una URL legacy.
const media = v => typeof v === "string" && v.length <= 2048 && (
  /^\/media\/[A-Za-z0-9._/-]+$/.test(v) ||
  /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/media\/[A-Za-z0-9._/-]+$/.test(v) ||
  /^https:\/\/media\.craft-systems\.com\/[A-Za-z0-9._/-]+$/.test(v)
);
const clone = v => JSON.parse(JSON.stringify(v));
const unique = values => new Set(values).size === values.length;
const clipped = (v, max) => [...(typeof v === "string" ? v : "")].slice(0, max).join("");

export function slugify(value) {
  const map = { á:"a",à:"a",â:"a",ä:"a",ã:"a",é:"e",è:"e",ê:"e",ë:"e",í:"i",ì:"i",î:"i",ï:"i",ó:"o",ò:"o",ô:"o",ö:"o",õ:"o",ú:"u",ù:"u",û:"u",ü:"u",ñ:"n",ç:"c",Á:"a",À:"a",Â:"a",Ä:"a",Ã:"a",É:"e",È:"e",Ê:"e",Ë:"e",Í:"i",Ì:"i",Î:"i",Ï:"i",Ó:"o",Ò:"o",Ô:"o",Ö:"o",Õ:"o",Ú:"u",Ù:"u",Û:"u",Ü:"u",Ñ:"n",Ç:"c" };
  let out = "", dash = false;
  for (let ch of String(value).trim()) {
    ch = map[ch] || ch;
    if (/^[a-z0-9]$/.test(ch)) { out += ch; dash = false; }
    else if (/^[A-Z]$/.test(ch)) { out += ch.toLowerCase(); dash = false; }
    else if ((ch === " " || ch === "_" || ch === "-") && !dash) { out += "-"; dash = true; }
  }
  return out.replace(/^-+|-+$/g, "");
}

function problem(campo) { return { ok: false, campo }; }
// Las nuevas se crean con slugify (guiones); las legacy del CRM traen guion bajo y se conservan (cross_sell las referencia).
const catSlug = v => /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(v);
function optionOK(v) {
  if (typeof v === "string") return text(v, 120);
  if (!object(v) || !text(v.name, 120)) return false;
  return (!own(v, "price") || finite(v.price)) && (!own(v, "price_delta") || finite(v.price_delta, -1_000_000)) &&
    (!own(v, "image") || media(v.image)) && (!own(v, "salsas") || Number.isInteger(v.salsas) && v.salsas >= 0 && v.salsas <= 50);
}
function variantOK(v) {
  if (!object(v) || !text(v.name, 120) || !Array.isArray(v.options) || v.options.length > MAX.options || !v.options.every(optionOK)) return false;
  if (own(v, "type") && !["", "option", "price_select", "distribute"].includes(v.type)) return false;
  for (const k of ["pick", "free"]) if (own(v, k) && (!Number.isInteger(v[k]) || v[k] < 0 || v[k] > 50)) return false;
  for (const k of ["item", "repeat"]) if (own(v, k) && !text(v[k], 120, true)) return false;
  return !own(v, "optional") || typeof v.optional === "boolean";
}

// Validación completa en el borde. Devuelve el campo para conservar el error del panel.
export function validateDoc(doc) {
  if (!object(doc)) return problem("catalog");
  for (const k of ["categories", "packagings", "variant_groups", "products"]) if (!Array.isArray(doc[k])) return problem(k);
  if (doc.categories.length > MAX.categories || doc.packagings.length > MAX.packagings || doc.variant_groups.length > MAX.groups || doc.products.length > MAX.products) return problem("limite");
  const cats = new Set(), packs = new Set(), groups = new Set(), products = new Set();
  for (const c of doc.categories) {
    if (!object(c) || !id(c.slug) || !catSlug(c.slug) || !text(c.name, 120) || cats.has(c.slug)) return problem("categories");
    cats.add(c.slug);
  }
  for (const p of doc.packagings) {
    if (!object(p) || !id(p.id) || !text(p.name, 120) || !finite(p.price) || packs.has(p.id)) return problem("packagings");
    packs.add(p.id);
  }
  for (const g of doc.variant_groups) {
    if (!object(g) || !id(g.id) || !text(g.name, 120) || !["option", "price_select", "distribute"].includes(g.type) || !Array.isArray(g.options) || g.options.length > MAX.options || !g.options.every(optionOK) || groups.has(g.id)) return problem("variant_groups");
    if (!Number.isInteger(g.pick) || g.pick < 0 || g.pick > 50 || (g.type === "distribute" ? g.pick < 1 : g.pick !== 0) || typeof g.optional !== "boolean" || !text(g.item, 120, true)) return problem("variant_groups");
    groups.add(g.id);
  }
  for (const p of doc.products) {
    if (!object(p) || !id(p.id) || products.has(p.id) || !text(p.name, 120) || !["producto", "promocion"].includes(p.type) || !text(p.price, 32, true) || !text(p.promo_price, 32, true) || !text(p.sku, 120, true) || !text(p.description, 1000, true) || !(p.stock === null || Number.isInteger(p.stock) && p.stock >= 0) || typeof p.active !== "boolean" || typeof p.catalog_visible !== "boolean") return problem("products");
    if (!(p.packaging_id === null || packs.has(p.packaging_id)) || !finite(p.packaging_cost) || !Array.isArray(p.images) || p.images.length > 5 || !p.images.every(media) || !Array.isArray(p.categories) || !unique(p.categories) || !p.categories.every(c => cats.has(c)) || !Array.isArray(p.variants) || !p.variants.every(variantOK) || !Array.isArray(p.groups)) return problem("products");
    const assigned = new Set();
    for (const a of p.groups) if (!object(a) || !groups.has(a.group_id) || assigned.has(a.group_id) || !(a.pick_override === null || Number.isInteger(a.pick_override) && a.pick_override >= 0 && a.pick_override <= 50)) return problem("products"); else assigned.add(a.group_id);
    products.add(p.id);
  }
  return { ok: true };
}

function blankDoc() { return { categories: [], packagings: [], variant_groups: [], products: [] }; }
function docOf(row) { try { const doc = JSON.parse(row.doc); return validateDoc(doc).ok ? doc : blankDoc(); } catch { return blankDoc(); } }
function fromKV(products, config) {
  const categories = Object.entries(object(config.categories) ? config.categories : {}).filter(([slug, name]) => id(slug) && catSlug(slug) && text(String(name), 120)).slice(0, MAX.categories).map(([slug, name]) => ({ slug, name: String(name) }));
  const bySlug = new Map(categories.map(c => [c.slug, c]));
  const order = Array.isArray(config.category_order) ? config.category_order : [];
  categories.sort((a, b) => { const ai = order.indexOf(a.slug), bi = order.indexOf(b.slug); return (ai < 0 ? 1e6 : ai) - (bi < 0 ? 1e6 : bi) || a.name.localeCompare(b.name); });
  const list = Array.isArray(products) ? products.slice(0, MAX.products) : [], used = new Set();
  return { categories, packagings: [], variant_groups: [], products: list.map((p, i) => {
    let productID = id(p?.id) && !used.has(p.id) ? p.id : `legacy-${i + 1}`;
    while (used.has(productID)) productID += "-2";
    used.add(productID);
    return {
    id: productID, name: text(p?.nombre, 120) ? p.nombre : "Producto", type: p?.tipo === "promocion" ? "promocion" : "producto",
    price: clipped(String(p?.precio ?? ""), 32), promo_price: clipped(String(p?.precio_promo ?? ""), 32), packaging_id: null, packaging_cost: finite(Number(p?.costo_empaque)) ? Number(p.costo_empaque) : 0,
    sku: clipped(p?.sku, 120), description: clipped(p?.descripcion, 1000), stock: Number.isInteger(p?.stock) && p.stock >= 0 ? p.stock : null,
    active: true, catalog_visible: true, images: Array.isArray(p?.imagenes) ? p.imagenes.filter(media).slice(0, 5) : [], categories: Array.isArray(p?.categorias) ? [...new Set(p.categorias.filter(c => bySlug.has(c)))] : [], variants: legacyVariants(p?.variantes), groups: [],
  }; }) };
}

function legacyVariants(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(object).map(v => {
    const inferredPrice = v.type === "price_select" || (Array.isArray(v.options) && v.options.some(o => object(o) && typeof o.price === "number"));
    const options = (Array.isArray(v.options) ? v.options : []).slice(0, MAX.options).map(o => {
      if (!object(o)) return String(o);
      const out = { ...o, name: String(o.name ?? o.label ?? "") };
      if (inferredPrice && typeof out.price === "number") {
        const suffix = ` ($${out.price.toFixed(2)})`;
        if (out.name.endsWith(suffix)) out.name = out.name.slice(0, -suffix.length);
      }
      delete out.label;
      return out;
    }).filter(optionOK);
    return { ...v, type: inferredPrice ? "price_select" : (v.type || "option"), options };
  }).filter(variantOK);
}

async function kvDoc(env, slug) {
  const [products, config] = await Promise.all([kv(env, `${slug}:productos`, []), kv(env, `${slug}:config`, {})]);
  const doc = fromKV(products, config);
  // Datos legacy imperfectos no impiden abrir el panel: se conserva la parte segura.
  return validateDoc(doc).ok ? doc : blankDoc();
}

// Solo lectura, sin bootstrap en D1 (la demo nunca escribe).
export async function peek(env, slug) {
  const row = await env.DB.prepare("SELECT doc, version FROM catalogs WHERE slug = ?").bind(slug).first();
  return row ? { doc: docOf(row), version: Number(row.version) } : { doc: await kvDoc(env, slug), version: 1 };
}

export async function load(env, slug) {
  let row = await env.DB.prepare("SELECT doc, version FROM catalogs WHERE slug = ?").bind(slug).first();
  if (!row) {
    const doc = await kvDoc(env, slug);
    try { await env.DB.prepare("INSERT INTO catalogs (slug, doc, version, updated_at) VALUES (?, ?, 1, ?)").bind(slug, JSON.stringify(doc), Date.now()).run(); }
    catch { /* otro request ganó el bootstrap */ }
    row = await env.DB.prepare("SELECT doc, version FROM catalogs WHERE slug = ?").bind(slug).first();
  }
  return { doc: docOf(row), version: Number(row.version) };
}

export async function publish(env, slug, doc) {
  const entries = buildEntries(doc);
  const config = await kv(env, `${slug}:config`, {});
  config.categories = Object.fromEntries(doc.categories.map(c => [c.slug, c.name]));
  config.category_order = doc.categories.map(c => c.slug);
  config.packaging = { enabled: true, mode: "per_product", label: "Empaque" };
  await env.MENUS.put(`${slug}:productos`, JSON.stringify(entries));
  await env.MENUS.put(`${slug}:config`, JSON.stringify(config));
  return entries;
}

export async function save(env, slug, doc, ifVersion) {
  const check = validateDoc(doc); if (!check.ok) return { error: check.campo, status: 400 };
  const current = await load(env, slug);
  const expected = ifVersion == null ? current.version : Number(ifVersion);
  if (!Number.isInteger(expected) || expected !== current.version) return { error: "conflicto", status: 409 };
  const result = await env.DB.prepare("UPDATE catalogs SET doc = ?, version = version + 1, updated_at = ? WHERE slug = ? AND version = ?").bind(JSON.stringify(doc), Date.now(), slug, expected).run();
  if (!result.meta.changes) return { error: "conflicto", status: 409 };
  const version = expected + 1;
  await publish(env, slug, doc);
  return { doc, version };
}

// Port literal de buildEntries/processVariants: grupos se anexan después de las propias.
export function buildEntries(input) {
  const doc = Array.isArray(input) ? { ...blankDoc(), products: input } : input;
  const groupById = new Map((doc?.variant_groups || []).map(g => [g.id, g]));
  const packById = new Map((doc?.packagings || []).map(p => [p.id, p]));
  return (doc?.products || []).filter(p => p.active && p.catalog_visible).map(p => {
    const refs = Object.fromEntries((p.images || []).map(url => [url, url]));
    const variants = [...(p.variants || []), ...(p.groups || []).map(a => {
      const g = clone(groupById.get(a.group_id)); if (a.pick_override != null) g.pick = a.pick_override; return g;
    })];
    // Go conserva el slice nil cuando no hay media y json.Marshal lo publica como null.
    const entry = { id: p.id, slug: slugify(p.name), nombre: p.name, precio: p.price, precio_promo: p.promo_price, categorias: p.categories, descripcion: p.description, stock: p.stock, imagenes: p.images.length ? p.images : null, variantes: processVariants(variants, p.price, refs), sku: p.sku };
    if (p.type === "promocion") entry.tipo = "promocion";
    const cost = p.packaging_id ? Number(packById.get(p.packaging_id)?.price) : Number(p.packaging_cost);
    if (Number.isFinite(cost) && cost > 0) entry.costo_empaque = cost;
    return entry;
  });
}
function processVariants(variants, baseText, refs) {
  const base = Number.parseFloat(baseText) || 0;
  return variants.map(v => {
    const out = { name: v.name, options: [], ...(v.repeat ? { repeat: v.repeat } : {}), ...(v.pick ? { pick: v.pick } : {}), ...(v.free ? { free: v.free } : {}), ...(v.item ? { item: v.item } : {}), ...(v.optional ? { optional: true } : {}) };
    if (v.type !== "price_select") {
      out.options = v.options.map(o => {
        if (!object(o)) return String(o);
        const label = String(o.name); const image = refs[o.image]; return image ? { label, image } : label;
      });
      if (v.type) out.type = v.type;
      return out;
    }
    out.options = v.options.filter(object).map(o => {
      let price = typeof o.price === "number" ? o.price : base + (Number(o.price_delta) || 0);
      if (typeof o.price === "number" && o.price === 0) price = base;
      const value = { label: `${String(o.name)} ($${price.toFixed(2)})`, price };
      if (typeof o.salsas === "number") value.salsas = o.salsas;
      if (refs[o.image]) value.image = refs[o.image];
      return value;
    });
    return out;
  });
}

export async function handleCatalog(request, env, site, path) {
  const parsed = path.split("/");
  if (request.method === "GET" && path === "catalog") { const x = await load(env, site.slug); return json({ version: x.version, ...x.doc }); }
  if (request.method === "GET" && path === "products") { const x = await load(env, site.slug); return json(x.doc.products, 200, { "x-catalog-version": String(x.version) }); }
  if (path === "products" && request.method === "POST") return mutate(request, env, site.slug, (doc, body) => {
    const p = { ...body, id: crypto.randomUUID() }; delete p.if_version;
    doc.products.push(p); const check = validateDoc(doc);
    return check.ok ? { value: p, created: true } : invalid(check.campo);
  });
  if (parsed[0] === "products" && parsed.length === 2 && ["PUT", "DELETE"].includes(request.method)) return productRoute(request, env, site.slug, decode(parsed[1]));
  if (path === "categories") return categoriesRoute(request, env, site.slug);
  if (parsed[0] === "categories" && parsed.length === 2 && ["PUT", "DELETE"].includes(request.method)) return categoryRoute(request, env, site.slug, decode(parsed[1]));
  if (path === "variant-groups" || parsed[0] === "variant-groups") return relatedRoute(request, env, site.slug, "variant_groups", parsed[1]);
  if (path === "packagings" || parsed[0] === "packagings") return relatedRoute(request, env, site.slug, "packagings", parsed[1]);
  return null;
}
async function requestBody(request) { try { const b = await request.json(); return object(b) ? b : null; } catch { return null; } }
async function mutate(request, env, slug, fn) {
  const body = await requestBody(request); if (!body && request.method !== "DELETE") return error("json_invalido", 400);
  const current = await load(env, slug); const next = clone(current.doc); const outcome = await fn(next, body);
  if (outcome?.error) return error(outcome.error, outcome.status || 400, outcome.campo ? { campo: outcome.campo } : {});
  const saved = await save(env, slug, next, body?.if_version);
  if (saved.error) return error(saved.error, saved.status);
  await notifyCRM(env, slug);
  return outcome?.empty ? noContent({ "x-catalog-version": String(saved.version) }) : json(outcome?.value, outcome?.created ? 201 : 200, { "x-catalog-version": String(saved.version) });
}
function invalid(campo = "products") { return { error: "campo_invalido", campo }; }
async function productRoute(request, env, slug, pid) {
  if (!pid) return error("no_existe", 404);
  if (request.method === "DELETE") return mutate(request, env, slug, doc => { const i = doc.products.findIndex(p => p.id === pid); if (i < 0) return { error:"no_existe", status:404 }; doc.products.splice(i,1); return { empty:true }; });
  return mutate(request, env, slug, (doc, body) => { const i = doc.products.findIndex(p => p.id === pid); if (i < 0) return { error:"no_existe", status:404 }; if (body.id && body.id !== pid) return invalid(); const { if_version, ...product } = body; doc.products[i] = { ...product, id: pid }; const check = validateDoc(doc); return check.ok ? { value: doc.products[i] } : invalid(check.campo); });
}
async function categoriesRoute(request, env, slug) {
  if (request.method === "POST") return mutate(request, env, slug, (doc, body) => { if (!text(body.name,120)) return invalid("name"); const base=(slugify(body.name)||"categoria").slice(0,120); let s=base,n=2; while(doc.categories.some(c=>c.slug===s)){const suffix=`-${n++}`;s=base.slice(0,120-suffix.length)+suffix;} const value={slug:s,name:body.name.trim()}; doc.categories.push(value); return { value, created:true }; });
  if (request.method === "PUT") return mutate(request, env, slug, (doc, body) => { if (!Array.isArray(body.slugs) || body.slugs.length !== doc.categories.length || new Set(body.slugs).size !== doc.categories.length || body.slugs.some(s=>!doc.categories.some(c=>c.slug===s))) return invalid("slugs"); doc.categories.sort((a,b)=>body.slugs.indexOf(a.slug)-body.slugs.indexOf(b.slug)); return {value:doc.categories}; });
  return null;
}
async function categoryRoute(request, env, slug, category) {
  if (!category) return error("no_existe",404);
  if (request.method === "DELETE") return mutate(request,env,slug,doc=>{const i=doc.categories.findIndex(c=>c.slug===category);if(i<0)return{error:"no_existe",status:404};doc.categories.splice(i,1);doc.products.forEach(p=>p.categories=p.categories.filter(s=>s!==category));return{empty:true};});
  return mutate(request,env,slug,(doc,body)=>{const c=doc.categories.find(c=>c.slug===category);if(!c)return{error:"no_existe",status:404};if(!text(body.name,120))return invalid("name");c.name=body.name.trim();return{value:c};});
}
async function relatedRoute(request, env, slug, key, rawId) {
  const pid = rawId && decode(rawId), singular = key === "variant_groups" ? "group_id" : "packaging_id";
  if (request.method === "POST" && !pid) return mutate(request,env,slug,(doc,body)=>{
    const x={...body}; delete x.product_ids; delete x.if_version; x.id=x.id || crypto.randomUUID(); if(doc[key].some(v=>v.id===x.id))return invalid(key); doc[key].push(x); const r=assign(doc,key,x.id,body.product_ids,singular); if(r)return invalid("product_ids"); const check=validateDoc(doc); return check.ok?{value:related(doc,key,x.id,singular),created:true}:invalid(check.campo);
  });
  if (!pid || !["PUT","DELETE"].includes(request.method)) return null;
  if(request.method==="DELETE")return mutate(request,env,slug,doc=>{const i=doc[key].findIndex(x=>x.id===pid);if(i<0)return{error:"no_existe",status:404};doc[key].splice(i,1);doc.products.forEach(p=>{if(key==="variant_groups")p.groups=p.groups.filter(g=>g.group_id!==pid);else if(p.packaging_id===pid)p.packaging_id=null;});return{empty:true};});
  return mutate(request,env,slug,(doc,body)=>{const i=doc[key].findIndex(x=>x.id===pid);if(i<0)return{error:"no_existe",status:404};const x={...body,id:pid};delete x.product_ids;delete x.if_version;doc[key][i]=x;const r=assign(doc,key,pid,body.product_ids,singular);if(r)return invalid("product_ids");const check=validateDoc(doc);return check.ok?{value:related(doc,key,pid,singular)}:invalid(check.campo);});
}
function assign(doc,key,id,ids,singular) { if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(pid=>!doc.products.some(p=>p.id===pid))) return true; for(const p of doc.products){const on=ids.includes(p.id);if(key==="variant_groups"){const old=p.groups.find(g=>g.group_id===id);if(on&&!old)p.groups.push({group_id:id,pick_override:null});if(!on&&old)p.groups=p.groups.filter(g=>g.group_id!==id);}else if(on)p.packaging_id=id;else if(p.packaging_id===id)p.packaging_id=null;} }
function related(doc,key,id,singular){const x=clone(doc[key].find(x=>x.id===id));return {...x,product_ids:doc.products.filter(p=>key==="variant_groups"?p.groups.some(g=>g.group_id===id):p.packaging_id===id).map(p=>p.id)};}
// Espejo con el CRM: avisa que el dueño cambió el catálogo; el CRM decide si ese menú está espejado
// y lo trae con GET /admin/{slug}/catalog. Los PUT del CRM entran por admin.js y no avisan (sin eco).
async function notifyCRM(env, slug) {
  if (!env.CRM_HOOK_URL || !env.ADMIN_TOKEN) return;
  try { await fetch(env.CRM_HOOK_URL, { method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ slug }), signal: AbortSignal.timeout(3000) }); }
  catch { /* el guardado del panel no depende del CRM */ }
}
async function kv(env,key,fallback){try{const v=await env.MENUS.get(key,"json");return Array.isArray(fallback) ? (Array.isArray(v) ? v : fallback) : (object(v) ? v : fallback);}catch{return fallback;}}
function decode(v){try{return decodeURIComponent(v);}catch{return null;}}
