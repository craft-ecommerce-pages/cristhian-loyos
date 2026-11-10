// node --test mesa.test.cjs — checkout de comandas en el motor, con DOM mínimo real por VM.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(__dirname+'/catalog.js','utf8');

class Classes{
  constructor(...names){this.names=new Set(names);}
  add(...names){names.forEach(n=>this.names.add(n));}
  remove(...names){names.forEach(n=>this.names.delete(n));}
  contains(name){return this.names.has(name);}
  toggle(name,yes){if(yes===undefined)yes=!this.names.has(name);yes?this.add(name):this.remove(name);return yes;}
}
class Element{
  constructor(doc,id='',classes=[]){this.doc=doc;this.id=id;this.children=[];this.parentNode=null;this.style={};
    this.dataset={};this.classList=new Classes(...classes);this.handlers={};this.value='';this.textContent='';this.innerHTML='';
    this.disabled=false;this.type='';this.maxLength=undefined;this.attributes={};doc.elements.push(this);}
  append(...nodes){nodes.forEach(n=>this.appendChild(n));}
  appendChild(node){node.parentNode=this;this.children.push(node);return node;}
  before(node){const p=this.parentNode,i=p.children.indexOf(this);node.parentNode=p;p.children.splice(i,0,node);}
  remove(){if(this.parentNode)this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);}
  addEventListener(name,fn){this.handlers[name]=fn;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  closest(selector){let node=this;while(node){if(matches(node,selector))return node;node=node.parentNode;}return null;}
  querySelector(selector){return descendants(this).find(node=>matches(node,selector))||null;}
  querySelectorAll(selector){return descendants(this).filter(node=>matches(node,selector));}
  scrollIntoView(){}
  set className(value){this.classList=new Classes(...String(value).split(/\s+/).filter(Boolean));}
  get className(){return [...this.classList.names].join(' ');}
}
const descendants=root=>root.children.flatMap(node=>[node,...descendants(node)]);
function matches(node,selector){
  if(selector.startsWith('#'))return node.id===selector.slice(1);
  if(selector==='.dtog-btn.active')return node.classList.contains('dtog-btn')&&node.classList.contains('active');
  if(selector.startsWith('.'))return node.classList.contains(selector.slice(1));
  if(selector==='[id^="fieldX_"]')return node.id.startsWith('fieldX_');
  if(selector==='label')return node.tagName==='label';
  return false;
}
function menu({edge=true,locale='es',mesa=()=>({id:'ord-1',number:7}),open=()=>({})}={}){
  const doc={elements:[],listeners:{},documentElement:{style:{setProperty(){}}},currentScript:{src:'https://engine.test/v1/catalog.js'}};
  doc.body=new Element(doc,'body');doc.head=new Element(doc,'head');
  doc.createElement=tag=>{const e=new Element(doc);e.tagName=tag;return e;};doc.getElementById=id=>doc.elements.find(e=>e.id===id)||null;
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
  const step=add('cartStep2',['cart-step2']);byId.cartDrawer.appendChild(step);
  const stepBody=add('', ['step2-body'],step),stepFooter=add('', ['step2-footer'],step);
  const toggle=add('deliveryToggle',['delivery-toggle'],stepBody);
  const modes={};
  for(const mode of ['delivery','pickup','mesa']){
    const b=add('', ['dtog-btn',...(mode==='delivery'?['active']:[])],toggle);
    b.dataset.mode=mode;modes[mode]=b;
  }
  const field=(id,parent=stepBody)=>{
    const wrap=add('', ['form-field'],parent),label=add('',[],wrap),input=add(id,[],wrap);
    label.tagName='label';return {wrap,label,input};
  };
  const name=field('fieldName'),phone=field('fieldPhone'),address=field('fieldAddressWrap');
  address.wrap.id='fieldAddressWrap';address.input.id='fieldAddress';
  const confirm=add('btnConfirm',[],stepFooter),bottom=add('', ['bottom-nav']),wa=add('', ['wa-float']);
  void bottom;void wa;
  const storage=new Map([['menu_cart',JSON.stringify([{key:'p1',id:'p1',nombre:'Pizza',precio:8,qty:1,variantes:{}}])]]);
  const calls=[],opens=[],events=[];
  const fetch=async(url,options)=>{
    if(url==='productos.json')return {ok:true,json:async()=>[{id:'p1',nombre:'Pizza',precio:8,categorias:[]}]};
    if(url==='config.json')return {ok:true,json:async()=>({store_name:'Demo',whatsapp_number:'593999999999',locale})};
    calls.push([url,options]);
    const result=await mesa(url,options);
    if(result instanceof Error)throw result;
    return {ok:result.ok??true,status:result.status??201,json:async()=>result.body??result};
  };
  const ctx=vm.createContext({document:doc,window:null,crypto:webcrypto,AbortController,TextEncoder,URL,URLSearchParams,
    location:{href:'https://demo.craft-systems.com/'},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v))},
    sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,String(v)),removeItem:k=>storage.delete(k)},
    fetch,open:(...args)=>{opens.push(args);return open(...args);},setTimeout,clearTimeout,requestAnimationFrame:fn=>fn(),
    console:{error(){},log(){}},Date,Math,JSON,Promise});
  ctx.window=ctx;ctx.CraftTracking={create:()=>({track:(name,detail)=>events.push([name,detail])})};
  if(edge)ctx.__CONFIG__={store_name:'Demo',whatsapp_number:'593999999999',locale,tracking:{meta_pixel_id:'1'}};
  vm.runInContext(source,ctx);
  const ready=()=>new Promise(resolve=>setTimeout(resolve,0));
  const choose=mode=>{Object.values(modes).forEach(b=>b.classList.remove('active'));modes[mode].classList.add('active');
    toggle.handlers.click({target:{closest:s=>s==='.dtog-btn'?modes[mode]:null}});};
  return {doc,byId,name,phone,address,modes,calls,opens,events,ready,choose,confirm,checkout:()=>confirm.handlers.click()};
}

test('edge + mesa envía a /panel/o/mesa, no abre WhatsApp y confirma el número',async()=>{
  const m=menu();await m.ready();m.choose('mesa');m.name.input.value='Ana';m.checkout();await m.ready();
  assert.equal(m.calls.length,1);assert.equal(m.calls[0][0],'/panel/o/mesa');assert.deepEqual(JSON.parse(m.calls[0][1].body),{
    order_id:JSON.parse(m.calls[0][1].body).order_id,items:[{nombre:'Pizza',qty:1,precio:8}],total:8,currency:'$',client_name:'Ana'});
  assert.match(JSON.parse(m.calls[0][1].body).order_id,/^[0-9a-f-]{36}$/);assert.deepEqual(m.opens,[]);
  assert.equal(m.doc.getElementById('tableOrderReceipt').children[0].textContent,'Pedido #7 enviado');
  assert.equal(m.events.at(-1)[0],'Purchase');assert.equal(m.events.at(-1)[1].order_id,'ord-1');
});

test('el teléfono es opcional solo en mesa',async()=>{
  const m=menu();await m.ready();assert.ok(m.doc.getElementById('fieldTable'));
  assert.equal(m.doc.getElementById('fieldTable').maxLength,10);
  m.choose('mesa');assert.equal(m.phone.label.textContent,'Teléfono (opcional)');assert.ok(m.doc.getElementById('fieldTable'));
  m.name.input.value='Ana';m.checkout();await m.ready();assert.equal(m.calls.length,1);
  const n=menu();await n.ready();n.name.input.value='Ana';n.checkout();await n.ready();assert.equal(n.calls.length,0);
});

test('403 mesas_apagadas vuelve a WhatsApp y otros errores no lo abren',async()=>{
  const fallback=menu({mesa:async()=>({status:403,body:{error:'mesas_apagadas'}})});await fallback.ready();fallback.choose('mesa');
  fallback.name.input.value='Ana';fallback.phone.input.value='099';fallback.checkout();await fallback.ready();
  assert.equal(fallback.opens.length,1);assert.match(fallback.opens[0][0],/^https:\/\/wa\.me\//);
  const failed=menu({mesa:async()=>new Error('red')});await failed.ready();failed.choose('mesa');failed.name.input.value='Ana';
  failed.checkout();await failed.ready();assert.equal(failed.opens.length,0);
  assert.match(failed.byId.toast.textContent,/No se pudo enviar/);
  const noPhone=menu({mesa:async()=>({status:403,body:{error:'mesas_apagadas'}})});
  await noPhone.ready();noPhone.choose('mesa');noPhone.name.input.value='Ana';
  noPhone.checkout();await noPhone.ready();assert.equal(noPhone.opens.length,0);
  assert.match(noPhone.byId.toast.textContent,/Completa tu nombre y teléfono/);
});

test('reintento de mesa reutiliza order_id mientras el carrito no cambia',async()=>{
  let tries=0;
  const m=menu({mesa:async()=>++tries===1?new Error('red'):{id:'ord-2',number:8}});
  await m.ready();m.choose('mesa');m.name.input.value='Ana';
  m.checkout();await m.ready();m.checkout();await m.ready();
  assert.equal(JSON.parse(m.calls[0][1].body).order_id,JSON.parse(m.calls[1][1].body).order_id);
});

test('legacy no crea el campo ni llama al endpoint de mesa',async()=>{
  const m=menu({edge:false});await m.ready();m.choose('mesa');m.name.input.value='Ana';
  m.phone.input.value='099';m.checkout();await m.ready();
  assert.equal(m.doc.getElementById('fieldTable'),null);assert.equal(m.calls.some(([url])=>url==='/panel/o/mesa'),false);
  assert.equal(m.opens.length,1);
});

test('inglés traduce los textos nuevos de mesa',async()=>{
  const m=menu({locale:'en'});await m.ready();m.choose('mesa');m.name.input.value='Ana';m.checkout();await m.ready();
  assert.equal(m.doc.getElementById('fieldTable').parentNode.children[0].textContent,'Table number (optional)');
  assert.equal(m.doc.getElementById('tableOrderReceipt').children[0].textContent,'Order #7 sent');
  assert.equal(m.doc.getElementById('tableOrderReceipt').children[1].textContent,'Let your server know you have already placed your order');
  m.choose('pickup');assert.equal(m.phone.label.textContent,'Phone');
});

test('solo 200/201 con recibo válido confirman una comanda',async()=>{
  const m=menu({mesa:async()=>({status:202,body:{id:'en-cola',number:9}})});
  await m.ready();m.choose('mesa');m.name.input.value='Ana';m.checkout();await m.ready();
  assert.equal(m.doc.getElementById('tableOrderReceipt'),null);
  assert.equal(m.opens.length,0);
  assert.match(m.byId.toast.textContent,/No se pudo enviar/);
});
