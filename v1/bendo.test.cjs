// node --test bendo.test.cjs — cobro web con tarjeta (Bendo) en el checkout
// nativo y en /gracias. El fetch es simulado: ninguna prueba toca Bendo.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/catalog.js','utf8');
const {orderPaymentLabel,thanksRetryAllowed,paymentStartPath,cardPaymentMethod}=require('./catalog.js');

/* ── helpers puros ───────────────────────────────────────────────────────── */
test('paymentStartPath/cardPaymentMethod: solo tarjeta abre pasarela',()=>{
  assert.equal(paymentStartPath('bendo'),'bendo');
  assert.equal(paymentStartPath('cash'),'');
  assert.equal(paymentStartPath('transfer'),'');
  assert.equal(paymentStartPath('otro'),'');
  assert.equal(cardPaymentMethod('bendo'),true);
  assert.equal(cardPaymentMethod('cash'),false);
  assert.equal(cardPaymentMethod('transfer'),false);
});

test('orderPaymentLabel bendo: textos neutrales y unknown nunca es rechazo',()=>{
  assert.equal(orderPaymentLabel({payment_method:'bendo',status:'pending'}),'Esperando confirmación de la tarjeta');
  assert.equal(orderPaymentLabel({payment_method:'bendo',status:'pending',payment_status:'unknown'}),'Pago con tarjeta en verificación');
  assert.equal(orderPaymentLabel({payment_method:'bendo',status:'pending',payment_status:'failed'}),'El pago con tarjeta no se completó');
  assert.equal(orderPaymentLabel({payment_method:'bendo',status:'pending',payment_status:'rejected'}),'Pago rechazado por la tarjeta');
  assert.equal(orderPaymentLabel({payment_method:'bendo',status:'paid',payment_status:'paid'}),'Pago confirmado con tarjeta');
});

test('thanksRetryAllowed bendo: solo reintenta si el intento falló antes de cobrar',()=>{
  assert.equal(thanksRetryAllowed({payment_method:'bendo',status:'pending',payment_status:'failed'}),true);
  assert.equal(thanksRetryAllowed({payment_method:'bendo',status:'pending',retryable:true}),true);
  assert.equal(thanksRetryAllowed({payment_method:'bendo',status:'pending',payment_status:'unknown'}),false); // no duplicar el cobro
  assert.equal(thanksRetryAllowed({payment_method:'bendo',status:'paid',payment_status:'failed'}),false);
  assert.equal(thanksRetryAllowed({payment_method:'bendo',status:'pending',payment_status:'pending'}),false);
  assert.equal(thanksRetryAllowed({payment_method:'cash',status:'pending',payment_status:'failed'}),false);
});

/* ── DOM mínimo por VM ───────────────────────────────────────────────────── */
class Classes{constructor(...n){this.names=new Set(n);}add(...n){n.forEach(x=>this.names.add(x));}
  remove(...n){n.forEach(x=>this.names.delete(x));}contains(n){return this.names.has(n);}
  toggle(n,y){if(y===undefined)y=!this.names.has(n);y?this.add(n):this.remove(n);return y;}}
class Element{
  constructor(doc,id='',classes=[]){this.doc=doc;this.id=id;this.children=[];this.parentNode=null;this.style={};
    this.dataset={};this.classList=new Classes(...classes);this.handlers={};this.value='';this.textContent='';this.innerHTML='';
    this.disabled=false;this.hidden=false;this.type='';this.attributes={};doc.elements.push(this);}
  append(...nodes){nodes.forEach(n=>this.appendChild(n));}
  appendChild(node){node.parentNode=this;this.children.push(node);return node;}
  before(node){const p=this.parentNode,i=p.children.indexOf(this);node.parentNode=p;p.children.splice(i,0,node);}
  prepend(node){node.parentNode=this;this.children.unshift(node);}
  remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);
    const i=this.doc.elements.indexOf(this);if(i>=0)this.doc.elements.splice(i,1);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  focus(){this.focused=true;}
  select(){this.selected=true;}
  click(){this.clicked=true;this.doc.clicks.push(this);}
  closest(selector){let node=this;while(node){if(matches(node,selector))return node;node=node.parentNode;}return null;}
  querySelector(selector){
    const found=descendants(this).find(node=>matches(node,selector));
    if(found) return found;
    const id=selector.startsWith('#')?selector.slice(1):'';
    if(!id||!String(this.innerHTML||'').includes('id="'+id+'"')) return null;
    return stubFor(this.doc,id);
  }
  querySelectorAll(selector){return descendants(this).filter(node=>matches(node,selector));}
  scrollIntoView(){}
  set className(value){this.classList=new Classes(...String(value).split(/\s+/).filter(Boolean));}
  get className(){return [...this.classList.names].join(' ');}
}
const descendants=root=>root.children.flatMap(node=>[node,...descendants(node)]);
// El harness no parsea innerHTML: un nodo buscado por id dentro de HTML generado se
// representa con un doble que solo conserva los listeners.
const stubFor=(doc,id)=>doc.stubs[id]||(doc.stubs[id]={id,handlers:{},addEventListener(name,fn){this.handlers[name]=fn;}});
function matchesSimple(node,selector){
  const modeSel=selector.match(/^\.([\w-]+)\[data-mode="([^"]+)"\]$/);
  if(modeSel)return node.classList.contains(modeSel[1])&&node.dataset.mode===modeSel[2];
  const attrSel=selector.match(/^(\w+)\[(\w+)="([^"]*)"\]$/);
  if(attrSel)return node.tagName===attrSel[1]&&node.attributes[attrSel[2]]===attrSel[3];
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
function menu({fetchImpl,search='',path='/',bendo=false,storage:seed}={}){
  const doc={elements:[],listeners:{},clicks:[],stubs:{},documentElement:{style:{setProperty(){}}},currentScript:{src:'https://engine.test/v1/catalog.js'}};
  doc.body=new Element(doc,'body');doc.head=new Element(doc,'head');
  doc.createElement=tag=>{const e=new Element(doc);e.tagName=tag;return e;};
  doc.getElementById=id=>doc.elements.find(e=>e.id===id)||null;
  doc.querySelector=selector=>{
    const found=doc.elements.find(e=>matches(e,selector));
    if(found) return found;
    const id=selector.startsWith('#')?selector.slice(1):'';
    if(!id) return null;
    return doc.elements.some(e=>String(e.innerHTML||'').includes('id="'+id+'"'))?stubFor(doc,id):null;
  };
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
  const billingWrap=add('billingFields',['billing-fields'],stepBody);
  const docType=add('fieldDocType',[],billingWrap),docNumber=add('fieldDocNumber',[],billingWrap);
  const email=add('fieldEmail',[],billingWrap),billingAddress=add('fieldBillingAddress',[],billingWrap);
  const paymentWrap=add('fieldPaymentWrap',['form-field'],stepBody);
  const payment=add('fieldPayment',[],paymentWrap),paymentHint=add('paymentHint',[],paymentWrap);
  // El template trae efectivo, transferencia y tarjeta (Bendo, deshabilitada).
  // Aquí se prueba que catalog.js la habilita según payment-options.
  for(const [value,text,disabled] of [['cash','Efectivo en caja',false],['transfer','Transferencia (validar en caja)',false],
    ['bendo','Tarjeta de crédito o débito (no disponible)',true]]){
    const option=new Element(doc,'');option.tagName='option';
    option.setAttribute('value',value);option.textContent=text;option.disabled=disabled;
    payment.appendChild(option);
  }
  const notify=add('notifyNote',['notify-note'],stepFooter);
  const thanks=add('thanksPage',['thanks-page']);
  for(const key of ['name','phone','document_type','document_number','email','address']){
    void add('err-'+key,[],billingWrap);
  }
  void paymentHint;void notify;void thanks;void docType;
  const confirm=add('btnConfirm',[],stepFooter),bottom=add('', ['bottom-nav']),wa=add('', ['wa-float']);
  void bottom;void wa;
  const storage=new Map(seed||[['menu_cart',JSON.stringify([{key:'p1:0=Queso',id:'p1',nombre:'Pizza',precio:8,qty:2,variantes:{0:'Queso'},nota:'Sin cebolla'}])]]);
  const calls=[],opens=[],events=[];
  const products=[{id:'p1',nombre:'Pizza',precio:8,categorias:[],variantes:[{name:'Sabor',type:'option',options:['Queso','Peperoni']}]}];
  const baseConfig={store_name:'Food Trucks',locale:'es',currency:'$',whatsapp_number:'593999999999',tracking:{meta_pixel_id:'1'}};
  baseConfig.checkout_orders={enabled:true,api_base:'',poll_ms:5000};
  baseConfig.location={sedes:[{id:'sede-01',nombre:'Food truck 1',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2',direccion:'Por confirmar'}]};
  const fetch=async(url,options)=>{
    if(url==='productos.json')return {ok:true,json:async()=>products};
    if(url==='config.json')return {ok:true,json:async()=>baseConfig};
    if(url==='/api/payment-options')return {ok:true,status:200,json:async()=>({cash:true,transfer:true,bendo})};
    calls.push([url,options]);
    const result=await fetchImpl(url,options);
    if(result instanceof Error)throw result;
    return {ok:result.ok??true,status:result.status??201,json:async()=>result.body??result};
  };
  // poll_ms=1000 se resuelve al instante; el timeout de abort (15s) usa temporizador real (no dispara).
  const setTimeoutFake=(fn,ms)=>ms===5000?0:setTimeout(fn,ms);
  const ctx=vm.createContext({document:doc,window:null,crypto:webcrypto,AbortController,TextEncoder,URL,URLSearchParams,
    location:{href:'https://menu.test/'+search,pathname:path,search,replace(){},assign(){}},
    history:{pushState(){},replaceState(){}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    fetch,open:(...a)=>{opens.push(a);return {};},setTimeout:setTimeoutFake,clearTimeout,requestAnimationFrame:fn=>fn(),
    console:{error(){},log(){}},Date,Math,JSON,Promise});
  ctx.window=ctx;ctx.__CONFIG__=baseConfig;ctx.CraftTracking={create:()=>({track:(n,d)=>events.push([n,d])})};
  vm.runInContext(source,ctx);
  const ready=()=>new Promise(resolve=>setTimeout(resolve,0));
  const option=value=>payment.querySelector(`option[value="${value}"]`);
  return {doc,byId,calls,opens,events,ready,step,stepBody,confirm,storage,payment,option,
    checkout:()=>confirm.handlers.click()};
}

const receipt={id:'ord-1',number:7,status:'pending',total_cents:1600,currency:'USD',order_token:'tok'};
const bendoPayment={order_id:'ord-1',payment_id:'REF123456789012',payment_url:'https://checkout.bendo.test/p/abc',
  status:'confirmed',total_cents:1600};
const statusBody=(overrides={})=>({status:'pending',number:7,total_cents:1600,currency:'USD',sede_id:'sede-01',
  payment_method:'bendo',payment_status:'pending',items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}],
  ...overrides});

function fillBilling(m,overrides={}){
  const set=(id,value)=>{const el=m.doc.getElementById(id);if(el)el.value=value;};
  set('fieldName','Ana');set('fieldPhone','0991234567');
  set('fieldDocNumber','0912345678');set('fieldEmail','ana@test.com');
  set('fieldBillingAddress','Av. Siempre Viva 123');
  Object.entries(overrides).forEach(([id,value])=>set(id,value));
}

test('payment-options.bendo habilita "Tarjeta de crédito o débito" en el checkout',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),bendo:true});await m.ready();await m.ready();
  const option=m.option('bendo');
  assert.ok(option,'la opción bendo existe en el select');
  assert.equal(option.disabled,false);
  assert.equal(option.textContent,'Tarjeta de crédito o débito');
});

test('sin bendo en payment-options la opción queda visible pero deshabilitada',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),bendo:false});await m.ready();await m.ready();
  const option=m.option('bendo');
  assert.ok(option);
  assert.equal(option.disabled,true);
  assert.equal(option.textContent,'Tarjeta de crédito o débito (no disponible)');
});

test('checkout con bendo crea el pedido, inicia el pago y redirige al payment_url',async()=>{
  const m=menu({fetchImpl:async url=>url.startsWith('/api/orders/')?{body:bendoPayment}:{status:201,body:receipt},bendo:true});
  await m.ready();await m.ready();
  m.doc.getElementById('fieldSede').value='sede-01';
  fillBilling(m);
  m.payment.value='bendo';
  m.checkout();await m.ready();await m.ready();await m.ready();
  const created=m.calls.find(([url])=>url==='/api/orders');
  assert.ok(created,'se crea el pedido web');
  assert.equal(JSON.parse(created[1].body).payment_method,'bendo');
  const pay=m.calls.find(([url])=>url==='/api/orders/ord-1/bendo');
  assert.ok(pay,'se inicia el cobro con la ruta bendo');
  const payBody=JSON.parse(pay[1].body);
  assert.equal(payBody.order_token,'tok');
  assert.match(payBody.idempotency_key,/^[A-Za-z0-9_.:-]{8,100}$/);
  assert.deepEqual(m.calls.filter(([url])=>url.startsWith('/api/orders/')).map(([url])=>url),['/api/orders/ord-1/bendo'],
    'solo inicia el cobro con la ruta bendo');
  assert.equal(m.doc.clicks.length,1,'redirige con un enlace');
  assert.equal(m.doc.clicks[0].href,'https://checkout.bendo.test/p/abc');
  const stored=JSON.parse(m.storage.get('munch_order:ord-1'));
  assert.equal(stored.payment_method,'bendo');
});

test('bendo no disponible al crear el pedido: mensaje exacto y sin reintento silencioso',async()=>{
  const m=menu({fetchImpl:async()=>({ok:false,status:503,body:{error:'bendo_no_disponible'}}),bendo:false});
  await m.ready();await m.ready();
  m.doc.getElementById('fieldSede').value='sede-01';
  fillBilling(m);
  m.payment.value='bendo';
  m.checkout();await m.ready();await m.ready();
  assert.equal(m.byId.toast.textContent,'El pago con tarjeta no está disponible ahora. Elige efectivo o transferencia.');
  assert.equal(m.doc.clicks.length,0,'no redirige a ninguna pasarela');
});

test('/gracias bendo pendiente: espera verificación y no ofrece reintento',async()=>{
  const record={id:'ord-1',token:'tok',number:7,status:'pending',total_cents:1600,currency:'USD',
    payment_method:'bendo',sede_id:'sede-01',items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}],
    payment_status:'unknown',created_at:1};
  const m=menu({fetchImpl:async()=>({body:statusBody({payment_status:'unknown'})}),path:'/gracias',
    search:'?pedido=ord-1&token=tok&pago=pendiente',storage:[['munch_order:ord-1',JSON.stringify(record)]]});
  await m.ready();await m.ready();await m.ready();
  const thanks=m.doc.getElementById('thanksPage').innerHTML;
  assert.match(thanks,/Estamos verificando tu pago con tarjeta\. No vuelvas a pagar\./);
  assert.match(thanks,/Pago con tarjeta en verificación/);
  assert.doesNotMatch(thanks,/Reintentar pago con tarjeta/); // unknown nunca se reintenta
  assert.match(thanks,/Tarjeta de crédito o débito/);
});

test('/gracias bendo fallido: reintenta contra la ruta bendo y reabre el link',async()=>{
  const record={id:'ord-1',token:'tok',number:7,status:'pending',total_cents:1600,currency:'USD',
    payment_method:'bendo',sede_id:'sede-01',items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}],
    payment_status:'failed',created_at:1};
  const m=menu({fetchImpl:async url=>url.startsWith('/api/orders/')?{body:bendoPayment}:{status:201,body:receipt},
    path:'/gracias',search:'?pedido=ord-1&token=tok',storage:[['munch_order:ord-1',JSON.stringify(record)]]});
  await m.ready();await m.ready();await m.ready();
  const thanks=m.doc.getElementById('thanksPage').innerHTML;
  assert.match(thanks,/No se completó el pago con tarjeta\. Puedes reintentar\./);
  const retry=m.doc.stubs.thanksRetry;
  assert.ok(retry,'el intento fallido permite reintentar');
  retry.handlers.click();await m.ready();await m.ready();
  const pay=m.calls.find(([url])=>url==='/api/orders/ord-1/bendo');
  assert.ok(pay,'reintenta con el proveedor correcto');
  assert.equal(m.doc.clicks.at(-1).href,'https://checkout.bendo.test/p/abc');
  assert.deepEqual(m.calls.filter(([url])=>url.startsWith('/api/orders/')&&!url.includes('?')).map(([url])=>url),
    ['/api/orders/ord-1/bendo'],'el reintento usa solo la ruta bendo');
});
