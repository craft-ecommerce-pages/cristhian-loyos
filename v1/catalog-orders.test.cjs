// node --test catalog-orders.test.cjs — checkout nativo opt-in (config.checkout_orders)
// y helpers puros. Con la clave ausente el menú conserva el checkout legacy por WhatsApp.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/catalog.js','utf8');
const {checkoutOrders,ordersEndpoint,sedeList,sedeFromQuery,defaultSede,orderCartItems,
  orderStatusLabel,orderStatusFinal,nextOrderKey}=require('./catalog.js');

/* ── helpers puros ───────────────────────────────────────────────────────── */
test('checkoutOrders: solo habilita con enabled:true y normaliza poll_ms/api_base',()=>{
  assert.equal(checkoutOrders(undefined),null);
  assert.equal(checkoutOrders({}),null);
  assert.equal(checkoutOrders({checkout_orders:{enabled:false}}),null);
  assert.deepEqual(checkoutOrders({checkout_orders:{enabled:true,api_base:'https://p.test/',poll_ms:10}}),
    {api_base:'https://p.test',poll_ms:5000}); // poll <1000 → 5000
  assert.deepEqual(checkoutOrders({checkout_orders:{enabled:true}}),{api_base:'',poll_ms:5000});
  assert.equal(checkoutOrders({checkout_orders:{enabled:true,poll_ms:90000}}).poll_ms,60000);
  assert.equal(ordersEndpoint({api_base:'https://p.test'},'/api/orders'),'https://p.test/api/orders');
  assert.equal(ordersEndpoint({api_base:''},'api/orders'),'/api/orders');
});

test('sedeList/sedeFromQuery/defaultSede: ids válidos, prioridad QR→guardada→única',()=>{
  const config={location:{sedes:[
    {id:'sede-01',nombre:' Food truck 1 ',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2'},
    {id:'bad id',nombre:'Mala'},
    {id:'sede-03',nombre:'Apagada',activa:false},
  ]}};
  assert.deepEqual(sedeList(config),[
    {id:'sede-01',nombre:'Food truck 1',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2',direccion:''},
  ]);
  assert.equal(sedeFromQuery(config,'?sede=sede-02'),'sede-02');
  assert.equal(sedeFromQuery(config,'?sede=no-existe'),'');
  assert.equal(sedeFromQuery(config,''),'');
  assert.equal(defaultSede(sedeList(config),'sede-02','sede-99'),'sede-02');
  assert.equal(defaultSede(sedeList(config),'','sede-99'),'');
  assert.equal(defaultSede([{id:'solo'}],'',''),'solo');
});

test('orderCartItems: manda variant_id solo si el label existe y recorta la nota',()=>{
  const catalog=[{id:'p1',variantes:[{name:'Sabor',options:['Queso','Peperoni']}]},
    {id:'p2',variantes:[{name:'Salsa',options:[{label:'BBQ ($1.00)'}]}]}];
  assert.deepEqual(orderCartItems([{id:'p1',qty:2,variantes:{0:'Queso'},nota:'Sin cebolla'}],catalog),
    [{product_id:'p1',qty:2,variant_id:'Queso',note:'Sin cebolla'}]);
  assert.deepEqual(orderCartItems([{id:'p1',qty:1,variantes:{0:'Invención'}}],catalog),[{product_id:'p1',qty:1}]);
  assert.deepEqual(orderCartItems([{id:'p2',qty:1,variantes:{0:'BBQ ($1.00)'}}],catalog),
    [{product_id:'p2',qty:1,variant_id:'BBQ ($1.00)'}]);
  assert.deepEqual(orderCartItems([{id:'p1',qty:0}],catalog),[]);
});

test('orderStatusLabel/Final y nextOrderKey idempotente',()=>{
  assert.equal(orderStatusLabel('paid'),'Pagado. ¡Buen provecho!');
  assert.equal(orderStatusFinal('paid'),true);
  assert.equal(orderStatusFinal('confirmed'),false);
  assert.equal(nextOrderKey({fingerprint:'a',key:'abcdefgh'},'a','nuevo-00000000'),'abcdefgh');
  assert.equal(nextOrderKey({fingerprint:'b',key:'abcdefgh'},'a','nuevo-00000000'),'nuevo-00000000');
  assert.equal(nextOrderKey({fingerprint:'a',key:'corto'},'a','nuevo-00000000'),'nuevo-00000000');
});

/* ── DOM mínimo por VM ───────────────────────────────────────────────────── */
class Classes{constructor(...n){this.names=new Set(n);}add(...n){n.forEach(x=>this.names.add(x));}
  remove(...n){n.forEach(x=>this.names.delete(x));}contains(n){return this.names.has(n);}
  toggle(n,y){if(y===undefined)y=!this.names.has(n);y?this.add(n):this.remove(n);return y;}}
class Element{
  constructor(doc,id='',classes=[]){this.doc=doc;this.id=id;this.children=[];this.parentNode=null;this.style={};
    this.dataset={};this.classList=new Classes(...classes);this.handlers={};this.value='';this.textContent='';this.innerHTML='';
    this.disabled=false;this.type='';this.maxLength=undefined;this.attributes={};doc.elements.push(this);}
  append(...nodes){nodes.forEach(n=>this.appendChild(n));}
  appendChild(node){node.parentNode=this;this.children.push(node);return node;}
  before(node){const p=this.parentNode,i=p.children.indexOf(this);node.parentNode=p;p.children.splice(i,0,node);}
  prepend(node){node.parentNode=this;this.children.unshift(node);}
  remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);
    const i=this.doc.elements.indexOf(this);if(i>=0)this.doc.elements.splice(i,1);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  focus(){this.focused=true;}
  closest(selector){let node=this;while(node){if(matches(node,selector))return node;node=node.parentNode;}return null;}
  querySelector(selector){return descendants(this).find(node=>matches(node,selector))||null;}
  querySelectorAll(selector){return descendants(this).filter(node=>matches(node,selector));}
  scrollIntoView(){}
  set className(value){this.classList=new Classes(...String(value).split(/\s+/).filter(Boolean));}
  get className(){return [...this.classList.names].join(' ');}
}
const descendants=root=>root.children.flatMap(node=>[node,...descendants(node)]);
function matchesSimple(node,selector){
  const modeSel=selector.match(/^\.([\w-]+)\[data-mode="([^"]+)"\]$/);
  if(modeSel)return node.classList.contains(modeSel[1])&&node.dataset.mode===modeSel[2];
  if(selector==='[id^="fieldX_"]')return node.id.startsWith('fieldX_');
  if(selector.startsWith('.'))return selector.slice(1).split('.').every(cls=>node.classList.contains(cls));
  if(selector.startsWith('#'))return node.id===selector.slice(1);
  return node.tagName===selector;
}
function ancestor(node,selector){let p=node.parentNode;while(p){if(matchesSimple(p,selector))return true;p=p.parentNode;}return false;}
function matches(node,selector){
  if(selector==='#cartStep2 .step2-body')return node.classList.contains('step2-body')&&ancestor(node,'#cartStep2');
  return matchesSimple(node,selector);
}
function menu({checkout=true,fetchImpl,search='' }={}){
  const doc={elements:[],listeners:{},documentElement:{style:{setProperty(){}}},currentScript:{src:'https://engine.test/v1/catalog.js'}};
  doc.body=new Element(doc,'body');doc.head=new Element(doc,'head');
  doc.createElement=tag=>{const e=new Element(doc);e.tagName=tag;return e;};
  doc.getElementById=id=>doc.elements.find(e=>e.id===id)||null;
  doc.querySelector=selector=>doc.elements.find(e=>matches(e,selector))||null;
  doc.querySelectorAll=selector=>doc.elements.filter(e=>matches(e,selector));
  doc.addEventListener=(name,fn)=>{doc.listeners[name]=fn;};
  const add=(id,classes=[],parent=doc.body)=>{const e=new Element(doc,id,classes);parent.appendChild(e);return e;};
  const ids=['catalog','searchInput','cartOverlay','cartDrawer','cartClose','cartItems','cartTotal','cartItemCount',
    'btnCheckout','toast','modalOverlay','modalClose','modalFav','sliderTrack','sliderPrev','sliderNext','sliderDots',
    'modalDetail','sliderWrap','navBadge','cartPeek','peekCount','peekTotal','cartBack','cartTitle','footerText','brandName',
    'brandLogo','heroTitle','heroNotice','catStrip','legalOverlay','legalTitle','legalBody','legalClose'];
  const byId=Object.fromEntries(ids.map(id=>[id,add(id)]));
  const cartFooter=add('', ['cart-footer']);byId.cartDrawer.appendChild(cartFooter);
  const step=add('cartStep2',['cart-step2'],byId.cartDrawer);
  const stepBody=add('', ['step2-body'],step),stepFooter=add('', ['step2-footer'],step);
  const toggle=add('deliveryToggle',['delivery-toggle'],stepBody);
  for(const mode of ['delivery','pickup','mesa']){const b=add('', ['dtog-btn',...(mode==='delivery'?['active']:[])],toggle);b.dataset.mode=mode;}
  const field=(id,parent=stepBody)=>{const wrap=add('', ['form-field'],parent),label=add('',[],wrap);label.tagName='label';
    const input=add(id,[],wrap);return {wrap,label,input};};
  const name=field('fieldName'),phone=field('fieldPhone'),address=field('fieldAddressWrap');
  address.wrap.id='fieldAddressWrap';address.input.id='fieldAddress';
  const confirm=add('btnConfirm',[],stepFooter),bottom=add('', ['bottom-nav']),wa=add('', ['wa-float']);
  void bottom;void wa;
  const storage=new Map([['menu_cart',JSON.stringify([{key:'p1:0=Queso',id:'p1',nombre:'Pizza',precio:8,qty:2,variantes:{0:'Queso'},nota:'Sin cebolla'}])]]);
  const calls=[],opens=[],events=[];
  const products=[{id:'p1',nombre:'Pizza',precio:8,categorias:[],variantes:[{name:'Sabor',type:'option',options:['Queso','Peperoni']}]}];
  const baseConfig={store_name:'Food Trucks',locale:'es',currency:'$',whatsapp_number:'593999999999',tracking:{meta_pixel_id:'1'}};
  if(checkout)baseConfig.checkout_orders={enabled:true,api_base:'',poll_ms:1000};
  baseConfig.location={sedes:[{id:'sede-01',nombre:'Food truck 1',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2',direccion:'Por confirmar'}]};
  const fetch=async(url,options)=>{
    if(url==='productos.json')return {ok:true,json:async()=>products};
    if(url==='config.json')return {ok:true,json:async()=>baseConfig};
    if(url==='/api/payment-options')return {ok:true,status:200,json:async()=>({cash:true,transfer:true,payphone:false})};
    calls.push([url,options]);
    const result=await fetchImpl(url,options);
    if(result instanceof Error)throw result;
    return {ok:result.ok??true,status:result.status??201,json:async()=>result.body??result};
  };
  // poll_ms=1000 se resuelve al instante; el timeout de abort (15s) usa temporizador real (no dispara).
  const setTimeoutFake=(fn,ms)=>ms===1000?queueMicrotask(fn):setTimeout(fn,ms);
  const ctx=vm.createContext({document:doc,window:null,crypto:webcrypto,AbortController,TextEncoder,URL,URLSearchParams,
    location:{href:'https://menu.test/'+search,search},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    fetch,open:(...a)=>{opens.push(a);return {};},setTimeout:setTimeoutFake,clearTimeout,requestAnimationFrame:fn=>fn(),
    console:{error(){},log(){}},Date,Math,JSON,Promise});
  ctx.window=ctx;ctx.__CONFIG__=baseConfig;ctx.CraftTracking={create:()=>({track:(n,d)=>events.push([n,d])})};
  vm.runInContext(source,ctx);
  const ready=()=>new Promise(resolve=>setTimeout(resolve,0));
  return {doc,byId,calls,opens,events,ready,step,stepBody,confirm,checkout:()=>confirm.handlers.click()};
}

const receipt={id:'ord-1',number:7,status:'pending',total_cents:1600,currency:'USD',order_token:'tok'};
const handler=async url=>url.startsWith('/api/orders/')?{body:{status:'paid'}}:{status:201,body:receipt};

test('checkout nativo: sede + POST /api/orders + recibo + polling, sin WhatsApp',async()=>{
  const m=menu({fetchImpl:handler});await m.ready();
  assert.equal(m.opens.length,0);
  assert.equal(m.doc.querySelectorAll('.dtog-btn[data-mode="mesa"]').length,0); // sin Mesa en web
  assert.equal(m.doc.getElementById('fieldSede').value,''); // seis sedes: exige elegir
  m.doc.getElementById('fieldSede').value='sede-02';
  m.doc.getElementById('fieldName').value='Ana';m.doc.getElementById('fieldPhone').value='0991234567';
  m.checkout();await m.ready();await m.ready();
  const post=m.calls.find(([url])=>url==='/api/orders');
  assert.ok(post);
  const body=JSON.parse(post[1].body);
  assert.equal(body.sede_id,'sede-02');assert.deepEqual(body.items,[{product_id:'p1',qty:2,variant_id:'Queso',note:'Sin cebolla'}]);
  assert.deepEqual(body.customer,{name:'Ana',phone:'0991234567'});
  assert.match(body.idempotency_key,/^[A-Za-z0-9_.:-]{8,100}$/);
  assert.equal(m.opens.length,0); // nunca abre WhatsApp
  assert.equal(m.doc.getElementById('webOrderReceipt').children[0].textContent,'Pedido #000007 recibido');
  assert.match(m.doc.getElementById('webOrderStatus').textContent,/Pagado/);
  assert.equal(m.events.at(-1)[0],'Purchase');
});

test('sede del QR (?sede=) preselecciona y se envía',async()=>{
  const m=menu({fetchImpl:handler,search:'?sede=sede-01'});await m.ready();
  assert.equal(m.doc.getElementById('fieldSede'),null);
  m.doc.getElementById('fieldName').value='Ana';m.doc.getElementById('fieldPhone').value='099';
  m.checkout();await m.ready();await m.ready();
  assert.equal(JSON.parse(m.calls[0][1].body).sede_id,'sede-01');
});

test('sin sede: no llama a la API y avisa',async()=>{
  const m=menu({fetchImpl:handler});await m.ready();
  m.doc.getElementById('fieldName').value='Ana';m.doc.getElementById('fieldPhone').value='099';
  m.checkout();await m.ready();
  assert.equal(m.calls.some(([url])=>url==='/api/orders'),false);
  assert.match(m.byId.toast.textContent,/Selecciona tu food truck/);
});

test('reintento reutiliza idempotency_key mientras el pedido no cambie',async()=>{
  let tries=0;
  const m=menu({fetchImpl:async url=>url.startsWith('/api/orders/')?{body:{status:'paid'}}:(++tries===1?new Error('red'):{status:201,body:receipt})});
  await m.ready();m.doc.getElementById('fieldSede').value='sede-01';
  m.doc.getElementById('fieldName').value='Ana';m.doc.getElementById('fieldPhone').value='099';
  m.checkout();await m.ready();await m.ready();
  m.checkout();await m.ready();await m.ready();
  const posts=m.calls.filter(([url])=>url==='/api/orders').map(([,o])=>JSON.parse(o.body).idempotency_key);
  assert.equal(posts.length,2);assert.equal(posts[0],posts[1]);
});

test('legacy (sin checkout_orders) sigue abriendo WhatsApp y no llama a /api/orders',async()=>{
  const m=menu({checkout:false,fetchImpl:handler});await m.ready();
  assert.equal(m.doc.getElementById('fieldSede'),null);
  m.doc.getElementById('fieldName').value='Ana';m.doc.getElementById('fieldPhone').value='099';
  m.doc.querySelector('.dtog-btn[data-mode="pickup"]').classList.add('active');
  m.doc.querySelector('.dtog-btn[data-mode="delivery"]').classList.remove('active');
  m.checkout();await m.ready();
  assert.equal(m.calls.some(([url])=>url==='/api/orders'),false);
  assert.equal(m.opens.length,1);assert.match(m.opens[0][0],/^https:\/\/wa\.me\//);
});
