// node --test whatsapp.test.cjs — el cliente envía su pedido por WhatsApp desde
// /gracias (wa.me, nunca automático) y "Efectivo en caja" en el checkout web.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/catalog.js','utf8');
const {whatsappNumber,whatsappPaymentState,whatsappOrderAllowed,whatsappOrderMessage,
  whatsappOrderLink,paymentMethods,transferReceiptRequired}=require('./catalog.js');

/* ── helpers puros ───────────────────────────────────────────────────────── */
const CONFIG={store_name:'Munch',whatsapp_number:'593958610812',
  location:{sedes:[{id:'sede-01',nombre:'UIDE',direccion:'Por confirmar'}],telefono_principal:'593958610812'}};

test('whatsappNumber: teléfono del local, con o sin formato, solo 7 a 15 dígitos',()=>{
  assert.equal(whatsappNumber(CONFIG),'593958610812');
  assert.equal(whatsappNumber({location:{telefono_principal:'+593 95 861 0812'}}),'593958610812');
  assert.equal(whatsappNumber({whatsapp_number:'099-123-4567'}),'0991234567');
  // El teléfono principal manda; el whatsapp_number es el respaldo.
  assert.equal(whatsappNumber({location:{telefono_principal:'+593958610812'},whatsapp_number:'0991234567'}),
    '593958610812');
  assert.equal(whatsappNumber({location:{telefono_principal:'123'},whatsapp_number:'0991234567'}),
    '0991234567','si el principal no es válido se usa el respaldo');
  assert.equal(whatsappNumber({whatsapp_number:'123456'}),'','menos de 7 dígitos no sirve');
  assert.equal(whatsappNumber({whatsapp_number:'1234567890123456'}),'','más de 15 dígitos no sirve');
  assert.equal(whatsappNumber({}),'');
  assert.equal(whatsappNumber(null),'');
});

const TRANSFER_UPLOADED={payment_method:'transfer',status:'pending',receipt_uploaded:true};
const TRANSFER_PENDING={payment_method:'transfer',status:'pending',receipt_uploaded:false};
const CARD_PAID={payment_method:'bendo',status:'paid',payment_status:'paid'};
const CARD_PENDING={payment_method:'bendo',status:'pending',payment_status:'pending'};
const CARD_UNKNOWN={payment_method:'bendo',status:'pending',payment_status:'unknown'};
const CARD_REJECTED={payment_method:'bendo',status:'pending',payment_status:'rejected'};
const CASH={payment_method:'cash',status:'pending',payment_status:'pending'};

test('whatsappPaymentState: los cinco estados del contrato',()=>{
  assert.equal(whatsappPaymentState(TRANSFER_UPLOADED),'Transferencia — comprobante subido');
  assert.equal(whatsappPaymentState(TRANSFER_PENDING),'Transferencia — comprobante pendiente');
  assert.equal(whatsappPaymentState(CARD_PAID),'Tarjeta — pago aprobado');
  assert.equal(whatsappPaymentState(CARD_PENDING),'Tarjeta — pago pendiente');
  assert.equal(whatsappPaymentState(CARD_UNKNOWN),'Tarjeta — pago pendiente');
  assert.equal(whatsappPaymentState(CASH),'Efectivo — pago en caja');
});

const ORDER={id:'ord-1',token:'tok-opaco',number:7,total_cents:2450,customer_name:'Ana Pérez',
  items:[{qty:2,name:'Pizza'},{qty:1,name:'Coca-Cola',subtotal_cents:450}],
  billing:{document_type:'cedula',document_number:'0912345678',email:'ana@test.com',
    address:'Av. Siempre Viva 123'}};
const LINK='https://menu.test/gracias?pedido=ord-1&token=tok-opaco';

test('whatsappOrderMessage: líneas, total con IVA y pago para los 3 métodos',()=>{
  const transfer=whatsappOrderMessage({...ORDER,...TRANSFER_UPLOADED},{store_name:'Munch',
    sede_name:'UIDE',link:LINK});
  assert.equal(transfer,[
    'Hola Munch 👋 Te envío mi pedido #000007 · UIDE',
    '2 x Pizza',
    '1 x Coca-Cola',
    'Total: $24.50',
    'Pago: Transferencia — comprobante subido',
    'Nombre: Ana Pérez',
    'Ver pedido: '+LINK,
  ].join('\n'));
  const card=whatsappOrderMessage({...ORDER,...CARD_PAID},{store_name:'Munch',sede_name:'UIDE',link:LINK});
  assert.match(card,/Pago: Tarjeta — pago aprobado/);
  const cash=whatsappOrderMessage({...ORDER,...CASH},{store_name:'Munch',sede_name:'UIDE',link:LINK});
  assert.match(cash,/Pago: Efectivo — pago en caja/);
});

test('whatsappOrderMessage: sin datos fiscales (ni cédula, RUC, correo ni dirección)',()=>{
  const message=whatsappOrderMessage({...ORDER,...TRANSFER_UPLOADED},{
    store_name:'Munch',sede_name:'UIDE',link:LINK});
  assert.doesNotMatch(message,/0912345678|cedula|cédula|RUC|ana@test\.com|Siempre Viva/);
  assert.doesNotMatch(message,/0912345678/);
});

test('whatsappOrderMessage: total formateado por el menú y sin sede si falta',()=>{
  const message=whatsappOrderMessage({...ORDER,total_cents:800,...CASH},
    {store_name:'Munch',formatMoney:cents=>'$'+(cents/100).toFixed(2)});
  assert.match(message,/^Hola Munch 👋 Te envío mi pedido #000007$/m);
  assert.match(message,/Total: \$8\.00/);
  assert.doesNotMatch(message,/Ver pedido:/,'sin enlace no se inventa uno');
});

test('whatsappOrderLink: wa.me con el número y el texto codificado',()=>{
  const href=whatsappOrderLink(CONFIG,{...ORDER,...TRANSFER_PENDING},{store_name:'Munch',
    sede_name:'UIDE',link:LINK});
  assert.match(href,/^https:\/\/wa\.me\/593958610812\?text=/);
  const decoded=decodeURIComponent(href.split('?text=')[1]);
  assert.match(decoded,/Pago: Transferencia — comprobante pendiente/);
  assert.match(decoded,/Ver pedido: https:\/\/menu\.test\/gracias\?pedido=ord-1&token=tok-opaco/);
  assert.equal(whatsappOrderLink({},ORDER,{}),'','sin número no hay enlace');
});

test('whatsappOrderAllowed: sin número o con tarjeta rechazada no se ofrece',()=>{
  assert.equal(whatsappOrderAllowed(CARD_PENDING,CONFIG),true);
  assert.equal(whatsappOrderAllowed(CARD_REJECTED,CONFIG),false);
  assert.equal(whatsappOrderAllowed({...CARD_REJECTED,payment_method:'cash'},CONFIG),true,
    'un pedido en efectivo rechazado no existe; el filtro es solo para tarjeta');
  assert.equal(whatsappOrderAllowed(CASH,{whatsapp_number:''}),false);
  // El orden del contrato sigue vigente: tarjeta, transferencia y efectivo.
  assert.deepEqual(paymentMethods({cash:true,transfer:true,bendo:true}),['bendo','transfer','cash']);
  assert.equal(transferReceiptRequired('transfer'),true);
  assert.equal(transferReceiptRequired('cash'),false);
});

/* ── DOM mínimo por VM ───────────────────────────────────────────────────── */
class Classes{constructor(...n){this.names=new Set(n);}add(...n){n.forEach(x=>this.names.add(x));}
  remove(...n){n.forEach(x=>this.names.delete(x));}contains(n){return this.names.has(n);}
  toggle(n,y){if(y===undefined)y=!this.names.has(n);y?this.add(n):this.remove(n);return y;}}
class Element{
  constructor(doc,id='',classes=[]){this.doc=doc;this.id=id;this.children=[];this.parentNode=null;this.style={};
    this.dataset={};this.classList=new Classes(...classes);this.handlers={};this.value='';this.textContent='';this.innerHTML='';
    this.disabled=false;this.hidden=false;this.checked=false;this.type='';this.attributes={};doc.elements.push(this);}
  append(...nodes){nodes.forEach(n=>this.appendChild(n));}
  appendChild(node){node.parentNode=this;this.children.push(node);return node;}
  insertBefore(node,ref){node.parentNode=this;const i=ref?this.children.indexOf(ref):-1;
    if(i<0)this.children.push(node);else this.children.splice(i,0,node);return node;}
  before(node){const p=this.parentNode,i=p.children.indexOf(this);node.parentNode=p;p.children.splice(i,0,node);}
  prepend(node){node.parentNode=this;this.children.unshift(node);}
  remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);
    const i=this.doc.elements.indexOf(this);if(i>=0)this.doc.elements.splice(i,1);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];}
  focus(){this.focused=true;}
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
// El harness no parsea innerHTML: un nodo buscado por id dentro del HTML generado se
// representa con un doble que conserva listeners, atributos y el texto pintado.
const stubFor=(doc,id)=>doc.stubs[id]||(doc.stubs[id]={id,handlers:{},attributes:{},innerHTML:'',
  setAttribute(name,value){this.attributes[name]=String(value);},
  getAttribute(name){return this.attributes[name];},
  addEventListener(name,fn){this.handlers[name]=fn;}});
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
const CART_ONE=[{key:'p1:0=Queso',id:'p1',nombre:'Pizza',precio:8,qty:1,variantes:{0:'Queso'},nota:'Sin cebolla'}];
const TRANSFER={bank:'Banco Pichincha',account_number:'2200123456',holder:'Munch S.A.',account_type:'Ahorros'};

function menu({cart=CART_ONE,paymentOptions={cash:true,transfer:false,bendo:false},transfer=null,
  search='',path='/',fetchImpl,config:overrides={},storage:seed}={}){
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
  const billingWrap=add('billingFields',['billing-fields'],stepBody);billingWrap.hidden=true;
  const docType=add('fieldDocType',[],billingWrap),docNumber=add('fieldDocNumber',[],billingWrap);
  const email=add('fieldEmail',[],billingWrap),billingAddress=add('fieldBillingAddress',[],billingWrap);
  const paymentWrap=add('fieldPaymentWrap',['form-field'],stepBody);
  const payment=add('fieldPayment',[],paymentWrap),paymentHint=add('paymentHint',[],paymentWrap);
  // El template trae efectivo, transferencia y tarjeta (Bendo, deshabilitada).
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
  void docType;void paymentHint;void notify;void thanks;
  const confirm=add('btnConfirm',[],stepFooter),bottom=add('', ['bottom-nav']),wa=add('', ['wa-float']);
  void bottom;void wa;
  const storage=new Map(seed||[['menu_cart',JSON.stringify(cart)]]);
  const calls=[],opens=[],events=[];
  const products=[{id:'p1',nombre:'Pizza',precio:8,categorias:[],variantes:[{name:'Sabor',type:'option',options:['Queso','Peperoni']}]}];
  const baseConfig={store_name:'Munch',locale:'es',currency:'$',whatsapp_number:'593958610812',
    tracking:{meta_pixel_id:'1'}};
  baseConfig.checkout_orders={enabled:true,api_base:'',poll_ms:5000};
  if(transfer)baseConfig.checkout_orders.transfer=transfer;
  baseConfig.location=Object.assign({sedes:[{id:'sede-01',nombre:'UIDE',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2',direccion:'Por confirmar'}],telefono_principal:'593958610812'},
    overrides.location||{});
  Object.assign(baseConfig,Object.fromEntries(Object.entries(overrides).filter(([key])=>key!=='location')));
  const fetch=async(url,optionsArg)=>{
    if(url==='productos.json')return {ok:true,json:async()=>products};
    if(url==='config.json')return {ok:true,json:async()=>baseConfig};
    if(url==='/api/payment-options')return {ok:true,status:200,json:async()=>paymentOptions};
    calls.push([url,optionsArg]);
    const result=await fetchImpl(url,optionsArg);
    if(result instanceof Error)throw result;
    return {ok:result.ok??true,status:result.status??201,json:async()=>result.body??result};
  };
  const setTimeoutFake=(fn,ms)=>ms===5000?0:setTimeout(fn,ms);
  const ctx=vm.createContext({document:doc,window:null,crypto:webcrypto,AbortController,TextEncoder,URL,URLSearchParams,
    location:{href:'https://menu.test/'+search,origin:'https://menu.test',pathname:path,search,replace(){},assign(){}},
    history:{pushState(){},replaceState(){}},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    fetch,open:(...a)=>{ctx.opens.push(a);return {};},setTimeout:setTimeoutFake,clearTimeout,
    setInterval:()=>0,clearInterval(){},requestAnimationFrame:fn=>fn(),
    IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}},
    console:{error(){},log(){}},Date,Math,JSON,Promise});
  ctx.opens=[];
  ctx.window=ctx;ctx.__CONFIG__=baseConfig;ctx.CraftTracking={create:()=>({track:(n,d)=>events.push([n,d])})};
  vm.runInContext(source,ctx);
  const ready=()=>new Promise(resolve=>setTimeout(resolve,0));
  const set=(id,value)=>{const el=doc.getElementById(id);if(el)el.value=value;};
  const fill=()=>{set('fieldName','Ana');set('fieldPhone','0991234567');};
  const option=value=>payment.querySelector(`option[value="${value}"]`);
  const optionValues=()=>payment.children.filter(node=>node.tagName==='option').map(node=>node.attributes.value);
  return {doc,byId,calls,opens:ctx.opens,events,ready,step,stepBody,confirm,storage,payment,paymentHint,
    option,optionValues,set,fill,checkout:()=>confirm.handlers.click()};
}

const receipt={id:'ord-1',number:7,status:'pending',total_cents:1600,currency:'USD',order_token:'tok-opaco'};
const cashStatus={status:'pending',number:7,total_cents:1600,currency:'USD',sede_id:'sede-01',
  payment_method:'cash',payment_status:'pending',items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}]};
function orderRecord(overrides={}){
  return {id:'ord-1',token:'tok-opaco',number:7,status:'pending',total_cents:1600,currency:'USD',
    payment_method:'cash',sede_id:'sede-01',customer_name:'Ana',
    items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}],payment_status:'pending',created_at:1,
    ...overrides};
}
const thanksHarness=(record,status={},config={})=>menu({path:'/gracias',search:'?pedido=ord-1&token=tok-opaco',
  fetchImpl:async()=>({body:status}),config,
  storage:[['munch_order:ord-1',JSON.stringify(record)]]});

test('/gracias efectivo: CTA de WhatsApp, texto de caja con el número y aviso pequeño',async()=>{
  const m=thanksHarness(orderRecord(),cashStatus);
  await m.ready();await m.ready();await m.ready();
  const html=m.doc.getElementById('thanksPage').innerHTML;
  assert.match(html,/Enviar mi pedido por WhatsApp/);
  assert.match(html,/Así el local recibe tu pedido al instante\./);
  assert.match(html,/Acércate a caja con tu número #000007 para pagar\./);
  assert.match(html,/Retira tu pedido en el local con este número\./);
  assert.match(html,/Tu pedido #000007/,'se mantiene el número grande');
  const href=html.match(/id="thanksWhatsapp" href="([^"]+)"/)[1].replace(/&#38;|&amp;/g,'&');
  assert.match(href,/^https:\/\/wa\.me\/593958610812\?text=/);
  const message=decodeURIComponent(href.split('?text=')[1]);
  assert.match(message,/Pago: Efectivo — pago en caja/);
  assert.match(message,/Total: \$16/);
  assert.match(message,/Nombre: Ana/);
  assert.doesNotMatch(message,/0912345678|ana@test|Siempre Viva/,'la URL no arrastra datos fiscales');
});

test('/gracias: el clic marca "Enviado ✓ (reenviar)" y rehace el texto con el estado vigente',async()=>{
  const state={status:'pending',number:7,total_cents:1600,currency:'USD',sede_id:'sede-01',
    payment_method:'bendo',payment_status:'pending',
    items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}]};
  const m=menu({path:'/gracias',search:'?pedido=ord-1&token=tok-opaco',
    fetchImpl:async()=>({body:{...state}}),
    storage:[['munch_order:ord-1',JSON.stringify(orderRecord({payment_method:'bendo',payment_status:'pending'}))]]});
  await m.ready();await m.ready();await m.ready();
  const btn=m.doc.stubs.thanksWhatsapp;
  assert.ok(btn,'el CTA existe');
  btn.handlers.click({currentTarget:btn,preventDefault(){}});
  assert.match(btn.innerHTML,/Enviado ✓ \(reenviar\)/);
  assert.match(decodeURIComponent(btn.attributes.href.split('?text=')[1]),/Tarjeta — pago pendiente/);
  // Tras actualizar el estado, el re-pintado conserva el texto de reenvío.
  m.doc.stubs.thanksRefresh.handlers.click();
  await m.ready();await m.ready();
  assert.match(m.doc.getElementById('thanksPage').innerHTML,/Enviado ✓ \(reenviar\)/);
  // Un segundo clic reconstruye el texto con el estado actual del pedido.
  state.status='paid';state.payment_status='paid';
  m.doc.stubs.thanksRefresh.handlers.click();
  await m.ready();await m.ready();
  btn.handlers.click({currentTarget:btn,preventDefault(){}});
  assert.match(decodeURIComponent(btn.attributes.href.split('?text=')[1]),/Tarjeta — pago aprobado/);
});

test('/gracias sin número válido: no se muestra el botón',async()=>{
  const m=thanksHarness(orderRecord(),cashStatus,
    {whatsapp_number:'',location:{telefono_principal:''}});
  await m.ready();await m.ready();await m.ready();
  const html=m.doc.getElementById('thanksPage').innerHTML;
  assert.doesNotMatch(html,/thanksWhatsapp/);
  assert.doesNotMatch(html,/Enviar mi pedido por WhatsApp/);
  assert.match(html,/Acércate a caja con tu número #000007 para pagar\./,'el recibo sigue completo');
});

test('/gracias con tarjeta rechazada: sin CTA y con reintento de pago',async()=>{
  const rejected={status:'rejected',number:7,total_cents:1600,currency:'USD',sede_id:'sede-01',
    payment_method:'bendo',payment_status:'rejected',retryable:true,
    items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}]};
  const m=thanksHarness(orderRecord({payment_method:'bendo',status:'rejected',payment_status:'rejected',
    retryable:true}),rejected);
  await m.ready();await m.ready();await m.ready();
  const html=m.doc.getElementById('thanksPage').innerHTML;
  assert.doesNotMatch(html,/thanksWhatsapp/);
  assert.doesNotMatch(html,/Enviar mi pedido por WhatsApp/);
  assert.match(html,/Reintentar pago con tarjeta/);
  assert.match(html,/El pago no fue aprobado\./);
});

test('/gracias con transferencia: comprobante subido se informa en el mensaje',async()=>{
  const paid={status:'pending',number:7,total_cents:1600,currency:'USD',sede_id:'sede-01',
    payment_method:'transfer',payment_status:'pending',receipt_uploaded:true,
    items:[{name:'Pizza',qty:2,unit_cents:800,subtotal_cents:1600}]};
  const m=thanksHarness(orderRecord({payment_method:'transfer',receipt_uploaded:true}),paid);
  await m.ready();await m.ready();await m.ready();
  const html=m.doc.getElementById('thanksPage').innerHTML;
  const href=html.match(/id="thanksWhatsapp" href="([^"]+)"/)[1].replace(/&#38;|&amp;/g,'&');
  const message=decodeURIComponent(href.split('?text=')[1]);
  assert.match(message,/Pago: Transferencia — comprobante subido/);
});

test('checkout: "Efectivo en caja" con el aviso de pago al retirar',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),paymentOptions:{cash:true,transfer:false,bendo:false}});
  await m.ready();await m.ready();
  assert.equal(m.option('cash').textContent,'Efectivo en caja');
  assert.equal(m.paymentHint.textContent,'Pagas al retirar en caja. Tu pedido se prepara después de pagar.');
});

test('checkout: opciones en orden tarjeta → transferencia → efectivo en caja',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),transfer:TRANSFER,
    paymentOptions:{cash:true,transfer:true,bendo:true}});
  await m.ready();await m.ready();
  assert.deepEqual(m.optionValues(),['bendo','transfer','cash']);
  assert.equal(m.option('bendo').textContent,'Tarjeta de crédito o débito');
  assert.equal(m.option('transfer').textContent,'Transferencia bancaria');
  assert.equal(m.option('cash').textContent,'Efectivo en caja');
  assert.equal(m.payment.value,'bendo');
});

test('checkout sin tarjeta: transferencia y luego efectivo',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),transfer:TRANSFER,
    paymentOptions:{cash:true,transfer:true,bendo:false}});
  await m.ready();await m.ready();
  assert.deepEqual(m.optionValues(),['transfer','cash']);
  assert.equal(m.payment.value,'transfer');
});

test('checkout: la transferencia sigue exigiendo el comprobante',async()=>{
  const m=menu({fetchImpl:async()=>({body:receipt}),transfer:TRANSFER,
    paymentOptions:{cash:true,transfer:true,bendo:false}});
  await m.ready();await m.ready();
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();await m.ready();
  assert.equal(m.calls.some(([url])=>url==='/api/orders'),false,'sin comprobante no se crea el pedido');
  assert.match(m.byId.toast.textContent,/Sube tu comprobante para pagar por transferencia/);
});
