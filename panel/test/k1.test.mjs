import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import panel from "../src/index.js";
import { buildEntries, slugify, validateDoc } from "../src/catalog.js";
import { dayOf } from "../src/contract.js";
import { makeCtx, makeEnv, makeLimiter } from "./helpers.mjs";

const host = "pizza.craft-systems.com";
const request = (path, opts = {}) => new Request(`https://${host}${path}`, opts);
const body = (path, value, opts = {}) => request(path, { method: opts.method || "POST", headers: { "content-type":"application/json", ...(opts.headers || {}) }, body: JSON.stringify(value) });
async function owner(env) { const r=await panel.fetch(body("/admin/pizza/owner",{email:"owner@pizza.ec"},{headers:{authorization:"Bearer admin-token"}}),env,{}); return r.json(); }
async function cookie(env) { const r=await panel.fetch(body("/panel/api/login",await owner(env)),env,{}); return r.headers.get("set-cookie").split(";",1)[0]; }
const authed = (path, c, opts={}) => request(path,{...opts,headers:{...(opts.headers||{}),cookie:c}});
const native = () => ({categories:[{slug:"pizzas",name:"Pizzas"}],packagings:[],variant_groups:[],products:[]});
const product = (id="p1") => ({id,name:"Margarita",type:"producto",price:"10.00",promo_price:"",packaging_id:null,packaging_cost:0,sku:"",description:"",stock:null,active:true,catalog_visible:true,images:[],categories:["pizzas"],variants:[],groups:[]});

test("paridad del port Go: precio, imágenes, repeat, NxM, grupos, empaque y filtros", () => {
  const fixture=JSON.parse(readFileSync(new URL("./fixtures/catalog-parity.json",import.meta.url),"utf8"));
  assert.deepEqual(buildEntries(fixture.doc),fixture.products);
  assert.equal(slugify(" Ñandú__Crème! "),"nandu-creme");
  assert.equal(validateDoc(fixture.doc).ok,true);
});

test("bootstrap perezoso desde KV, CRUD nativo y CAS", async () => {
  const env=makeEnv({"pizza:config":{categories:{pizzas:"Pizzas"},category_order:["pizzas"]},"pizza:productos":[{id:"old",nombre:"Vieja",precio:"2",precio_promo:"",categorias:["pizzas"],descripcion:"",stock:null,imagenes:[],variantes:[],sku:""}]}), c=await cookie(env);
  let r=await panel.fetch(authed("/panel/api/catalog",c),env,{}); assert.equal(r.status,200); let catalog=await r.json(); assert.equal(catalog.version,1); assert.equal(catalog.products[0].id,"old");
  const p=product(); r=await panel.fetch(body("/panel/api/products",p,{headers:{cookie:c}}),env,{}); assert.equal(r.status,201); assert.equal(r.headers.get("x-catalog-version"),"2");
  r=await panel.fetch(body("/panel/api/products",{...p,if_version:1},{headers:{cookie:c}}),env,{}); assert.equal(r.status,409); assert.deepEqual(await r.json(),{error:"conflicto"});
  assert.equal((await env.MENUS.get("pizza:productos","json")).length,2);
});

test("bootstrap legacy conserva variantes aplanadas y sanea sin vaciar el catálogo", async () => {
  const legacyVariant={name:"Tamaño",options:[{label:"Grande ($12.00)",price:12,image:"https://media.craft-systems.com/panel/demo/grande.webp"}]};
  const env=makeEnv({"pizza:config":{categories:{pizzas:"Pizzas","Slug inválido":"No entra"},category_order:["pizzas"]},"pizza:productos":[
    {id:"old",nombre:"Vieja",precio:"10",precio_promo:"",categorias:["pizzas"],descripcion:"",stock:null,imagenes:["https://media.craft-systems.com/panel/demo/grande.webp"],variantes:[legacyVariant],sku:""},
    {id:"old",nombre:"Duplicada",precio:"2",precio_promo:"",categorias:[],descripcion:"",stock:null,imagenes:null,variantes:[],sku:""},
  ]}),c=await cookie(env);
  let r=await panel.fetch(authed("/panel/api/catalog",c),env,{}),catalog=await r.json();
  assert.equal(catalog.products.length,2);assert.equal(catalog.products[1].id,"legacy-2");assert.equal(catalog.variant_groups.length,0);
  assert.deepEqual(catalog.products[0].variants[0].options[0],{name:"Grande",price:12,image:"https://media.craft-systems.com/panel/demo/grande.webp"});
  r=await panel.fetch(body("/panel/api/categories/pizzas",{name:"Pizzas y más",if_version:catalog.version},{method:"PUT",headers:{cookie:c}}),env,{});assert.equal(r.status,200);
  assert.deepEqual((await env.MENUS.get("pizza:productos","json"))[0].variantes,[{name:"Tamaño",options:[{label:"Grande ($12.00)",price:12,image:"https://media.craft-systems.com/panel/demo/grande.webp"}]}]);
});

test("validación aplica todos los límites estructurales del contrato", () => {
  const doc={...native(),products:[product()]};
  const invalid=[];
  invalid.push({...doc,products:Array.from({length:501},(_,i)=>({...product(`p${i}`),categories:["pizzas"]}))});
  invalid.push({...doc,categories:Array.from({length:101},(_,i)=>({slug:`c${i}`,name:`C ${i}`})),products:[]});
  invalid.push({...doc,variant_groups:Array.from({length:101},(_,i)=>({id:`g${i}`,name:`G ${i}`,type:"option",options:[],pick:0,optional:false,item:""})),products:[]});
  invalid.push({...doc,packagings:Array.from({length:51},(_,i)=>({id:`e${i}`,name:`E ${i}`,price:0})),products:[]});
  invalid.push({...doc,variant_groups:[{id:"g",name:"G",type:"option",options:Array.from({length:51},(_,i)=>`O ${i}`),pick:0,optional:false,item:""}],products:[]});
  invalid.push({...doc,products:[{...product(),name:"x".repeat(121)}]});
  invalid.push({...doc,products:[{...product(),description:"x".repeat(1001)}]});
  invalid.push({...doc,products:[{...product(),images:Array(6).fill("https://media.craft-systems.com/x.webp")}]});
  invalid.push({...doc,products:[{...product(),images:["https://evil.example/x.webp"]}]});
  invalid.push({...doc,products:[{...product(),categories:["pizzas","pizzas"]}]});
  invalid.push({...doc,variant_groups:[{id:"g",name:"G",type:"option",options:[],pick:1,optional:false,item:""}],products:[]});
  for(const value of invalid)assert.equal(validateDoc(value).ok,false);
  assert.equal(validateDoc(doc).ok,true);
});

test("categorías: slug único, borrar limpia productos y reordenar exige permutación", async () => {
  const env=makeEnv(),c=await cookie(env);
  let r=await panel.fetch(body("/panel/api/categories",{name:"Bebídas"},{headers:{cookie:c}}),env,{}); assert.equal((await r.json()).slug,"bebidas");
  r=await panel.fetch(body("/panel/api/categories",{name:"Bebidas"},{headers:{cookie:c}}),env,{}); assert.equal((await r.json()).slug,"bebidas-2");
  r=await panel.fetch(body("/panel/api/categories",{slugs:["bebidas"]},{method:"PUT",headers:{cookie:c}}),env,{}); assert.equal(r.status,400);
  const doc=(await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json()); const p={...product(),categories:["bebidas"]};
  r=await panel.fetch(body("/panel/api/products",p,{headers:{cookie:c}}),env,{}); assert.equal(r.status,201);
  r=await panel.fetch(authed("/panel/api/categories/bebidas",c,{method:"DELETE",headers:{"content-type":"application/json"}}),env,{});assert.equal(r.status,204);
  const after=await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json();assert.deepEqual(after.products[0].categories,[]);
  r=await panel.fetch(body("/panel/api/categories",{slugs:["bebidas-2"]},{method:"PUT",headers:{cookie:c}}),env,{});assert.equal(r.status,200);
});

test("grupos y empaques asignan product_ids y eliminarlos limpia las referencias", async () => {
  const env=makeEnv(),c=await cookie(env); let r=await panel.fetch(body("/panel/api/categories",{name:"Pizza"},{headers:{cookie:c}}),env,{}); const cat=await r.json();
  r=await panel.fetch(body("/panel/api/products",{...product(),categories:[cat.slug]},{headers:{cookie:c}}),env,{});const p=await r.json();
  r=await panel.fetch(body("/panel/api/variant-groups",{id:"g",name:"Salsa",type:"distribute",options:[{name:"A"}],pick:1,optional:false,item:"Salsa",product_ids:[p.id]},{headers:{cookie:c}}),env,{});assert.deepEqual((await r.json()).product_ids,[p.id]);
  let catalog=await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json();let assigned={...catalog.products[0],groups:[{group_id:"g",pick_override:3}]};
  r=await panel.fetch(body(`/panel/api/products/${p.id}`,{...assigned,if_version:catalog.version},{method:"PUT",headers:{cookie:c}}),env,{});assert.equal(r.status,200);
  catalog=await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json();
  r=await panel.fetch(body("/panel/api/variant-groups/g",{...catalog.variant_groups[0],name:"Salsa nueva",product_ids:[p.id],if_version:catalog.version},{method:"PUT",headers:{cookie:c}}),env,{});assert.equal(r.status,200);
  catalog=await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json();assert.equal(catalog.products[0].groups[0].pick_override,3);
  r=await panel.fetch(body("/panel/api/packagings",{id:"box",name:"Caja",price:0.25,product_ids:[p.id]},{headers:{cookie:c}}),env,{});assert.deepEqual((await r.json()).product_ids,[p.id]);
  assert.equal((await env.MENUS.get("pizza:productos","json"))[0].costo_empaque,0.25);
  await panel.fetch(authed("/panel/api/variant-groups/g",c,{method:"DELETE",headers:{"content-type":"application/json"}}),env,{});await panel.fetch(authed("/panel/api/packagings/box",c,{method:"DELETE",headers:{"content-type":"application/json"}}),env,{});
  const doc=await (await panel.fetch(authed("/panel/api/catalog",c),env,{})).json();assert.deepEqual(doc.products[0].groups,[]);assert.equal(doc.products[0].packaging_id,null);
});

test("store valida cobertura, tarifa, sugeridos y conserva claves de sede", async () => {
  const env=makeEnv({"pizza:config":{categories:{p:"P"},location:{sedes:[{nombre:"A",direccion:"Vieja",agent_id:"x"}]}}}),c=await cookie(env);
  let r=await panel.fetch(body("/panel/api/store",{location:{sedes:[{nombre:"A",direccion:"Nueva",lat:-1,lng:-78,radio_km:2,telefono:"099"}],map_embed:"https://www.google.com/maps/embed?x",out_of_coverage_message:"Fuera",social:{instagram:"https://instagram.com/x"}},delivery_fee:1.25,cross_sell:{categories:["p"],title:"Sugeridos",max:3},search_placeholder:"Busca"},{method:"PATCH",headers:{cookie:c}}),env,{});assert.equal(r.status,200);const cfg=await r.json();assert.equal(cfg.location.sedes[0].agent_id,"x");assert.equal(cfg.delivery_fee,1.25);
  r=await panel.fetch(body("/panel/api/store",{location:{sedes:[{nombre:"A",direccion:"B",lat:1}]}},{method:"PATCH",headers:{cookie:c}}),env,{});assert.equal(r.status,400);
});

test("/panel/o siempre 204, limita, registra pedido y contador; orders pagina", async () => {
  const env=makeEnv(),ctx=makeCtx(), valid={items:[{nombre:"Pizza",qty:1,precio:10,variant:"Grande"}],total:10,currency:"USD",client_name:"Ana",client_phone:"099",delivery_mode:"delivery",address:"Calle",order_id:"ord-1"};
  let r=await panel.fetch(body("/panel/o",valid),env,ctx);assert.equal(r.status,204);await ctx.settle();assert.equal(env.DB.raw.prepare("SELECT count(*) AS n FROM orders").get().n,1);assert.equal(env.DB.raw.prepare("SELECT orders FROM events_daily WHERE slug=? AND day=?").get("pizza",dayOf(Date.now())).orders,1);
  const c=await cookie(env);r=await panel.fetch(authed("/panel/api/orders?limit=50",c),env,{});assert.equal((await r.json()).total,1);
  env.LOGIN_LIMITER=makeLimiter(true);r=await panel.fetch(body("/panel/o",valid),env,ctx);assert.equal(r.status,204);await ctx.settle();assert.equal(env.DB.raw.prepare("SELECT count(*) AS n FROM orders").get().n,1);
  r=await panel.fetch(request("/panel/o",{method:"POST",headers:{"content-length":"17000"},body:"x"}),env,ctx);assert.equal(r.status,204);
  const unicode={...valid,order_id:"utf8",items:Array.from({length:50},(_,i)=>({nombre:"é".repeat(200),qty:1,precio:i}))};
  r=await panel.fetch(body("/panel/o",unicode),env,ctx);assert.equal(r.status,204);await ctx.settle();assert.equal(env.DB.raw.prepare("SELECT count(*) AS n FROM orders").get().n,1);
  r=await panel.fetch(authed("/panel/api/orders?limit=51",c),env,{});assert.equal(r.status,400);
});

test("admin catálogo exige Bearer y reemplaza documento", async () => {
  const env=makeEnv(),doc={...native(),products:[product()]};let r=await panel.fetch(body("/admin/pizza/catalog",doc,{method:"PUT"}),env,{});assert.equal(r.status,401);
  r=await panel.fetch(body("/admin/pizza/catalog",doc,{method:"PUT",headers:{authorization:"Bearer admin-token"}}),env,{});assert.equal(r.status,200);assert.equal((await r.json()).products.length,1);
  r=await panel.fetch(request("/admin/pizza/catalog",{headers:{authorization:"Bearer admin-token"}}),env,{});assert.equal((await r.json()).products[0].name,"Margarita");
});

test("acepta categorías legacy con guion bajo y las conserva", async () => {
  const { validateDoc } = await import("../src/catalog.js");
  const doc = { categories: [{ slug: "combos_pollo", name: "Combos" }], packagings: [], variant_groups: [], products: [] };
  assert.equal(validateDoc(doc).ok, true);
  assert.equal(validateDoc({ ...doc, categories: [{ slug: "Combos Pollo", name: "x" }] }).ok, false);
});
