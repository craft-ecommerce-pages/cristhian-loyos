const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {webcrypto} = require('node:crypto');
const source = fs.readFileSync(__dirname + '/order-checkout.js', 'utf8');
function setup(fetch, storage = new Map()) {
  const element = () => ({style:{},children:[],setAttribute(){},append(...nodes){this.children.push(...nodes)},addEventListener(name,fn){this[name]=fn},remove(){this.removed=true}});
  const context = {crypto:webcrypto,TextEncoder,AbortController,setTimeout,clearTimeout,fetch,
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    document:{getElementById(){return null},createElement:element}};
  vm.runInNewContext(source,context);
  return {api:context.CraftOrderCheckout,storage,element};
}
const payload = {token:'public-token',items:[{nombre:'Producto',qty:1,precio:5}],total:5,client_name:'Nombre privado'};
const receipt = {id:'c0f72d7c-399e-42cb-a6bc-f75bc6b1cf14',order_number:128};
const ok = () => ({ok:true,status:200,json:async()=>receipt});
test('respuesta perdida: reintento y recarga conservan la clave sin almacenar datos personales',async()=>{
  const calls=[];
  const fetch=async(u,o)=>{calls.push(JSON.parse(o.body));if(calls.length===1)throw Error('desconexión');return ok()};
  let env=setup(fetch);
  await assert.rejects(env.api.register('/orders',payload));
  await env.api.register('/orders',payload);
  env=setup(fetch,env.storage);
  await env.api.register('/orders',payload);
  assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
  assert.equal(calls[1].idempotency_key,calls[2].idempotency_key);
  assert(!JSON.stringify([...env.storage]).includes('Nombre privado'));
  await env.api.register('/orders',{...payload,total:6});
  assert.notEqual(calls[2].idempotency_key,calls[3].idempotency_key);
});
test('no confirma respuestas vacías, errores, números inválidos ni conflictos',async()=>{
  for(const response of [{ok:true,status:200,json:async()=>null},{ok:false,status:503,json:async()=>({})},{ok:false,status:409,json:async()=>({})},{ok:true,status:200,json:async()=>({...receipt,order_number:-1})}]){
    const {api,element}=setup(async()=>response);const container=element();
    await assert.rejects(api.submit({url:'/orders',payload,phone:'099',message:'Pedido',container}));
    assert.equal(container.children.length,0);
  }
});
test('doble clic registra una vez, muestra el número y lo incluye en WhatsApp; nuevo pedido usa otra clave',async()=>{
  let resolve;const pending=new Promise(r=>resolve=r);const calls=[];
  const {api,element}=setup(async(u,o)=>{calls.push(JSON.parse(o.body));await pending;return ok()});
  const container=element(), args={url:'/orders',payload,phone:'+593 999',message:'Producto <script>',container};
  const first=api.submit(args);await api.submit(args);
  assert.equal(container.children.length,0);
  resolve();await first;
  assert.equal(calls.length,1);
  const box=container.children[0];assert.equal(box.children[0].textContent,'Pedido #000128 registrado');
  assert(new URL(box.children[2].href).searchParams.get('text').includes('*Pedido #000128*'));
  box.children[3].click();
  await api.submit(args);
  assert.notEqual(calls[0].idempotency_key,calls[1].idempotency_key);
});
