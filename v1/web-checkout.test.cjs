// node --test web-checkout.test.cjs — checkout web rápido: consumidor final por
// defecto, factura obligatoria sobre USD 50, métodos de pago desde
// /api/payment-options, recibo /gracias y sin modo mesa.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/catalog.js','utf8');
const {paymentMethods,invoiceRequired,billingErrorsFor,billingFieldErrors,taxBreakdown,taxRateLabel}=require('./catalog.js');

/* ── helpers puros ───────────────────────────────────────────────────────── */
test('paymentMethods: solo los true, en orden tarjeta → transferencia → efectivo',()=>{
  assert.deepEqual(paymentMethods({cash:true,transfer:true,bendo:true}),['bendo','transfer','cash']);
  assert.deepEqual(paymentMethods({cash:false,transfer:true,bendo:false}),['transfer']);
  assert.deepEqual(paymentMethods({cash:true}),['cash']);
  assert.deepEqual(paymentMethods({cash:1,transfer:'true'}),[]); // solo `true` habilita
  assert.deepEqual(paymentMethods(null),[]);
});

test('invoiceRequired: el límite del SRI es estrictamente mayor a USD 50',()=>{
  assert.equal(invoiceRequired(0),false);
  assert.equal(invoiceRequired(5000),false); // USD 50.00 exactos: consumidor final
  assert.equal(invoiceRequired(5001),true);
});

test('billingErrorsFor: apagado valida nombre/teléfono; encendido exige datos fiscales',()=>{
  const empty={name:'',phone:'',document_type:'',document_number:'',email:'',address:''};
  assert.deepEqual(Object.keys(billingErrorsFor(empty,false)).sort(),['name','phone']);
  assert.deepEqual(Object.keys(billingErrorsFor(empty,true)).sort(),
    ['address','document_number','document_type','email','name','phone']);
  const ok={name:'Ana Pérez',phone:'0991234567',document_type:'cedula',document_number:'0912345678',
    email:'ana@test.com',address:'Av. Siempre Viva 123'};
  assert.deepEqual(billingErrorsFor(ok,true),{});
  assert.deepEqual(billingErrorsFor(ok,false),{});
  assert.ok(billingFieldErrors(ok));
});

test('taxBreakdown: IVA 15 % por línea con el redondeo del servidor',()=>{
  // 3,00 → 0,45; 0,99 × 3 → 0,45 (44,55 redondeado); 2,49 × 7 → 2,61.
  assert.deepEqual(taxBreakdown([300],{rate_bp:1500,prices_include_tax:false}),
    {subtotal_cents:300,tax_cents:45,total_cents:345,rate_bp:1500});
  assert.deepEqual(taxBreakdown([297,1743],{rate_bp:1500}),{subtotal_cents:2040,tax_cents:306,
    total_cents:2346,rate_bp:1500});
  // Sin tasa o con precios que ya la incluyen no se suma nada.
  assert.equal(taxBreakdown([300],{rate_bp:0,prices_include_tax:false}).tax_cents,0);
  assert.equal(taxBreakdown([300],{rate_bp:1500,prices_include_tax:true}).tax_cents,0);
  assert.equal(taxBreakdown([300],null).total_cents,300);
  assert.equal(taxRateLabel(1500),'15%');
  assert.equal(taxRateLabel(0),'');
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
const CART_ONE=[{key:'p1:0=Queso',id:'p1',nombre:'Pizza',precio:8,qty:1,variantes:{0:'Queso'},nota:'Sin cebolla'}];
const CART_OVER_50=[{key:'p1',id:'p1',nombre:'Pizza',precio:8,qty:7,variantes:{}}];
const TRANSFER={bank:'Banco Pichincha',account_number:'2200123456',holder:'Munch S.A.',account_type:'Ahorros'};

function menu({cart=CART_ONE,paymentOptions={cash:true,transfer:false,bendo:false},transfer=null,
  search='',path='/',fetchImpl}={}){
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
  const options={};
  for(const [value,text,disabled] of [['cash','Efectivo en caja',false],['transfer','Transferencia (validar en caja)',false],
    ['bendo','Tarjeta de crédito o débito (no disponible)',true]]){
    const option=new Element(doc,'');option.tagName='option';
    option.setAttribute('value',value);option.textContent=text;option.disabled=disabled;
    payment.appendChild(option);options[value]=option;
  }
  const notify=add('notifyNote',['notify-note'],stepFooter);
  const thanks=add('thanksPage',['thanks-page']);
  for(const key of ['name','phone','document_type','document_number','email','address']){
    void add('err-'+key,[],billingWrap);
  }
  void docType;void paymentHint;void notify;void thanks;
  const confirm=add('btnConfirm',[],stepFooter),bottom=add('', ['bottom-nav']),wa=add('', ['wa-float']);
  void bottom;void wa;
  const storage=new Map([['menu_cart',JSON.stringify(cart)]]);
  const calls=[],events=[];
  const products=[{id:'p1',nombre:'Pizza',precio:8,categorias:[],variantes:[{name:'Sabor',type:'option',options:['Queso','Peperoni']}]}];
  const baseConfig={store_name:'Food Trucks',locale:'es',currency:'$',whatsapp_number:'593999999999',tracking:{meta_pixel_id:'1'}};
  baseConfig.checkout_orders={enabled:true,api_base:'',poll_ms:5000};
  if(transfer)baseConfig.checkout_orders.transfer=transfer;
  baseConfig.location={sedes:[{id:'sede-01',nombre:'Food truck 1',direccion:'Por confirmar'},
    {id:'sede-02',nombre:'Food truck 2',direccion:'Por confirmar'}]};
  const fetch=async(url,optionsArg)=>{
    if(url==='productos.json')return {ok:true,json:async()=>products};
    if(url==='config.json')return {ok:true,json:async()=>baseConfig};
    if(url==='/api/payment-options')return {ok:true,status:200,json:async()=>paymentOptions};
    calls.push([url,optionsArg]);
    const result=await fetchImpl(url,optionsArg);
    if(result instanceof Error)throw result;
    return {ok:result.ok??true,status:result.status??201,json:async()=>result.body??result};
  };
  // poll_ms=5000 se resuelve al instante; el abort de 15s usa temporizador real.
  const setTimeoutFake=(fn,ms)=>ms===5000?0:setTimeout(fn,ms);
  const ctx=vm.createContext({document:doc,window:null,crypto:webcrypto,AbortController,TextEncoder,URL,URLSearchParams,
    location:{href:'https://menu.test/'+search,pathname:path,search,replace(){},assign(){}},
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
  return {doc,byId,calls,opens:ctx.opens,events,ready,step,stepBody,confirm,storage,payment,option,
    set,fill,checkout:()=>confirm.handlers.click()};
}

const receipt={id:'ord-1',number:7,status:'pending',total_cents:800,currency:'USD',order_token:'tok'};
const statusBody={status:'paid',number:7,total_cents:800,currency:'USD',sede_id:'sede-01',
  payment_method:'cash',payment_status:'paid',items:[{name:'Pizza',qty:1,unit_cents:800,subtotal_cents:800}]};
const handler=async url=>url.startsWith('/api/orders/')?{body:statusBody}:{status:201,body:receipt};

test('consumidor final por defecto: no se envía billing y el interruptor está apagado',async()=>{
  const m=menu({fetchImpl:handler});await m.ready();await m.ready();
  const toggle=m.doc.getElementById('fieldBillingToggle');
  assert.ok(toggle,'existe el interruptor de factura');
  assert.equal(toggle.checked,false);
  assert.equal(m.doc.getElementById('billingFields').hidden,true,'los campos fiscales arrancan ocultos');
  assert.match(m.doc.getElementById('billingConsumerNote').textContent,/Consumidor final/);
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();await m.ready();
  const post=m.calls.find(([url])=>url==='/api/orders');
  assert.ok(post);
  const body=JSON.parse(post[1].body);
  assert.deepEqual(body.customer,{name:'Ana',phone:'0991234567'});
  assert.equal('billing' in body.customer,false);
  assert.equal(body.payment_method,'cash');
});

test('más de USD 50: el interruptor queda encendido y bloqueado con el aviso del SRI',async()=>{
  const m=menu({cart:CART_OVER_50,fetchImpl:handler});await m.ready();await m.ready();
  const toggle=m.doc.getElementById('fieldBillingToggle');
  assert.equal(toggle.checked,true);
  assert.equal(toggle.disabled,true);
  assert.equal(m.doc.getElementById('billingFields').hidden,false);
  const note=m.doc.getElementById('billingRequirementNote');
  assert.equal(note.hidden,false);
  assert.match(note.textContent,/Para compras mayores a \$50 el SRI exige tus datos/);
  assert.equal(m.doc.getElementById('billingConsumerNote').hidden,true);

  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();
  assert.equal(m.calls.some(([url])=>url==='/api/orders'),false,'sin datos fiscales no se envía');
  assert.match(m.doc.getElementById('err-document_number').textContent,/documento/);
  assert.equal(m.doc.getElementById('fieldDocNumber').focused,true);

  m.set('fieldDocNumber','0912345678');m.set('fieldEmail','ana@test.com');
  m.set('fieldBillingAddress','Av. Siempre Viva 123');
  m.checkout();await m.ready();await m.ready();
  const post=m.calls.find(([url])=>url==='/api/orders');
  assert.ok(post);
  const body=JSON.parse(post[1].body);
  assert.deepEqual(body.customer.billing,{document_type:'cedula',document_number:'0912345678',
    email:'ana@test.com',address:'Av. Siempre Viva 123'});
});

test('datos_fiscales_requeridos: enciende el interruptor, enfoca y avisa',async()=>{
  const m=menu({fetchImpl:async()=>({ok:false,status:400,body:{error:'datos_fiscales_requeridos',campo:'billing'}})});
  await m.ready();await m.ready();
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  assert.equal(m.doc.getElementById('fieldBillingToggle').checked,false);
  m.checkout();await m.ready();await m.ready();
  const toggle=m.doc.getElementById('fieldBillingToggle');
  assert.equal(toggle.checked,true,'el interruptor se enciende');
  assert.equal(toggle.disabled,true,'queda bloqueado: el servidor exige factura');
  assert.equal(m.doc.getElementById('billingFields').hidden,false);
  assert.equal(m.doc.getElementById('fieldDocType').focused,true,'enfoca el primer campo fiscal');
  assert.equal(m.doc.getElementById('billingRequirementNote').hidden,false);
  assert.match(m.byId.toast.textContent,/Completa los datos de facturación/);
});

test('efectivo apagado: no aparece y se preselecciona la transferencia',async()=>{
  const m=menu({fetchImpl:handler,transfer:TRANSFER,paymentOptions:{cash:false,transfer:true,bendo:false}});
  await m.ready();await m.ready();
  assert.equal(m.option('cash'),null,'efectivo oculto por defecto');
  assert.equal(m.option('bendo'),null,'tarjeta no habilitada');
  const transferOpt=m.option('transfer');
  assert.ok(transferOpt);
  assert.equal(transferOpt.textContent,'Transferencia bancaria');
  assert.equal(m.payment.value,'transfer');
});

test('preselección: tarjeta (bendo) antes que transferencia',async()=>{
  const m=menu({fetchImpl:handler,transfer:TRANSFER,paymentOptions:{cash:true,transfer:true,bendo:true}});
  await m.ready();await m.ready();
  assert.equal(m.payment.value,'bendo');
});

test('sin métodos de pago: botón desactivado y aviso para pedir en caja',async()=>{
  const m=menu({fetchImpl:handler,paymentOptions:{cash:false,transfer:false,bendo:false}});
  await m.ready();await m.ready();
  assert.equal(m.confirm.disabled,true);
  const message=m.doc.getElementById('paymentUnavailable');
  assert.ok(message);
  assert.equal(message.hidden,false);
  assert.match(message.textContent,/Los pedidos en línea no están disponibles\. Pide directamente en caja\./);
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();
  assert.equal(m.calls.some(([url])=>url==='/api/orders'),false);
  assert.match(m.byId.toast.textContent,/Pide directamente en caja/);
});

test('/gracias: número del pedido grande arriba, luego estado y sede',async()=>{
  const m=menu({fetchImpl:handler});await m.ready();await m.ready();
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();await m.ready();await m.ready();
  const thanks=m.doc.getElementById('thanksPage').innerHTML;
  assert.match(thanks,/class="thanks-number"/);
  assert.match(thanks,/Tu pedido #000007/);
  const number=thanks.indexOf('Tu pedido #000007');
  assert.ok(number>=0);
  assert.ok(number<thanks.indexOf('Pago confirmado en caja'),'el número va antes del estado');
  assert.ok(number<thanks.indexOf('Sede:'),'el número va antes de la sede');
});

test('?mesa= de un QR antiguo se ignora: sin modo mesa y el pedido va como retiro',async()=>{
  const m=menu({fetchImpl:handler,search:'?mesa=4'});await m.ready();await m.ready();
  assert.equal(m.doc.querySelectorAll('.dtog-btn[data-mode="mesa"]').length,0);
  assert.equal(m.doc.getElementById('fieldTable'),null);
  m.doc.getElementById('fieldSede').value='sede-01';
  m.fill();
  m.checkout();await m.ready();await m.ready();
  const post=m.calls.find(([url])=>url==='/api/orders');
  assert.ok(post);
  assert.equal(JSON.parse(post[1].body).delivery_mode,'pickup');
  assert.match(m.doc.getElementById('thanksPage').innerHTML,/Tu pedido #000007/);
});

test('carrito: Subtotal, IVA 15% y Total estimado con la tasa del servidor',async()=>{
  const m=menu({fetchImpl:handler,paymentOptions:{cash:true,transfer:false,bendo:false,
    tax:{rate_bp:1500,prices_include_tax:false}}});
  await m.ready();await m.ready();await m.ready();
  const split=m.doc.getElementById('cartTaxSplit');
  assert.ok(split,'se pinta el desglose del IVA');
  assert.match(split.innerHTML,/Subtotal/);
  assert.match(split.innerHTML,/\$8\.00/);
  assert.match(split.innerHTML,/IVA 15%/);
  assert.match(split.innerHTML,/\$1\.20/);
  // Total = 8,00 + IVA 1,20; la etiqueta avisa que es una estimación.
  assert.equal(m.byId.cartTotal.textContent,'$9.20');
  assert.equal(m.byId.peekTotal.textContent,'$9.20');
  // El texto legal ya no afirma que los precios incluyan IVA.
  assert.equal(source.includes('e incluyen IVA'),false);
});

test('carrito sin tasa configurada: no se inventa IVA y no aparece el desglose',async()=>{
  const m=menu({fetchImpl:handler,paymentOptions:{cash:true,transfer:false,bendo:false,
    tax:{rate_bp:0,prices_include_tax:false}}});
  await m.ready();await m.ready();await m.ready();
  assert.equal(m.doc.getElementById('cartTaxSplit'),null);
  assert.equal(m.byId.cartTotal.textContent,'$8.00');
});
