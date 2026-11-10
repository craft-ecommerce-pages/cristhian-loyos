/* Coordenadas del cliente solo en memoria; núcleo compartido por menú y carrito. */
(function(root){
  'use strict';
  const validCoordinates=(lat,lng)=>Number.isFinite(lat)&&Number.isFinite(lng)&&Math.abs(lat)<=90&&Math.abs(lng)<=180;
  const hasCoverage=s=>s&&typeof s.id==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.id)&&validCoordinates(s.lat,s.lng)&&Number.isFinite(s.radio_km)&&s.radio_km>0;
  function nearest(lat,lng,sedes){
    if(!validCoordinates(lat,lng))return null;
    let result=null,best=Infinity;
    const rad=Math.PI/180;
    for(const s of sedes){
      if(!hasCoverage(s))continue;
      const a=Math.sin((s.lat-lat)*rad/2)**2+Math.cos(lat*rad)*Math.cos(s.lat*rad)*Math.sin((s.lng-lng)*rad/2)**2;
      const d=6371*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,a))));
      if(d<=s.radio_km&&d<best){result=s;best=d;}
    }
    return result;
  }
  let leaflet;
  function loadLeaflet(){
    if(root.L)return Promise.resolve(root.L);
    if(leaflet)return leaflet;
    leaflet=new Promise((resolve,reject)=>{
      const css=document.createElement('link'),script=document.createElement('script');
      css.rel='stylesheet';css.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';css.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';css.crossOrigin='anonymous';
      script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';script.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';script.crossOrigin='anonymous';
      let ready=0;
      const timer=setTimeout(fail,15000);
      function fail(){clearTimeout(timer);css.remove();script.remove();leaflet=null;reject(new Error('No se pudo cargar el mapa'));}
      function loaded(){if(++ready===2){clearTimeout(timer);resolve(root.L);}}
      css.onload=loaded;script.onload=loaded;css.onerror=fail;script.onerror=fail;document.head.append(css,script);
    });
    return leaflet;
  }
  function create(config,{onChange=()=>{},openOnStart=false,mount=null}={}){
    const loc=config.location||{},sedes=Array.isArray(loc.sedes)?loc.sedes:[],enabled=sedes.some(hasCoverage);
    let active=null,point=null,attempted=false,map=null,pin=null,candidate=null,request=0;
    const outside=loc.out_of_coverage_message||'Aún no cubrimos tu zona 😔';
    const note=()=>active&&point?`\n*Sede:* ${active.nombre}\n*Dirección de la sede:* ${active.direccion||''}\n📍 Ubicación del cliente: https://maps.google.com/?q=${point.lat},${point.lng}\n[Sede:${active.id};ubicacion:${point.lat},${point.lng}]\n`:'';
    const api={enabled,get active(){return active;},get coordinates(){return point;},note,
      phone:()=>((active&&active.telefono)||config.whatsapp_number||'').replace(/\D/g,''),require:()=>!enabled||!!active,show:()=>{},select};
    function select(lat,lng){
      request++;attempted=true;point=validCoordinates(lat,lng)?{lat,lng}:null;active=point?nearest(lat,lng,sedes):null;
      if(enabled)refresh();onChange(active,point);return active;
    }
    if(!enabled)return api;
    if(!document.getElementById('sedeStyles')){
      const style=document.createElement('style');style.id='sedeStyles';
      style.textContent='.sede-selector{margin:16px auto;padding:16px;max-width:800px;border:1px solid var(--border,#ddd);border-radius:16px;background:var(--surface,#fff);color:var(--text,#222)}.sede-selector p{margin:0 0 10px}.sede-actions{display:flex;flex-wrap:wrap;gap:8px}.sede-selector button,.sede-dialog button{padding:12px 16px;border:1px solid var(--border,#aaa);border-radius:10px;background:var(--surface,#fff);color:var(--text,#222);cursor:pointer;font:inherit}.sede-dialog{width:min(94vw,560px);max-height:90dvh;overflow:auto;padding:22px;border:0;border-radius:20px;background:var(--surface,#fff);color:var(--text,#222);box-sizing:border-box}.sede-dialog::backdrop{background:#0009}.sede-dialog h2{margin:0 0 12px}.sede-dialog p{margin:12px 0;line-height:1.5}.sede-map{height:320px;margin:12px 0;border-radius:12px}.sede-dialog button:disabled{opacity:.5}.sede-dialog .sede-confirm{background:var(--primary,#dc791b);color:#fff}.sede-privacy{font-size:12px;opacity:.8}.sede-inline{margin:10px 0 0;padding:12px;max-width:none}.sede-inline .sede-pick{width:100%}';
      document.head.append(style);
    }
    function el(tag,text,cls){const n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;}
    function button(text,fn){const n=el('button',text);n.type='button';n.addEventListener('click',fn);return n;}
    let panel=document.getElementById('sedeSelector');
    if(!panel){panel=el('section');panel.id='sedeSelector';const hero=document.querySelector('.hero');if(mount)mount.append(panel);else if(hero)hero.after(panel);else document.body.prepend(panel);}
    panel.className=mount?'sede-selector sede-inline':'sede-selector';panel.replaceChildren();
    const summary=el('p');summary.setAttribute('aria-live','polite');const pick=button('',()=>show());pick.className='sede-pick';panel.append(summary,pick);
    const dialog=el('dialog',null,'sede-dialog');dialog.setAttribute('aria-labelledby','sedeTitle');
    const title=el('h2','Encuentra tu sede más cercana');title.id='sedeTitle';
    const status=el('p','Indica dónde quieres recibir tu pedido.');status.setAttribute('role','status');
    const actions=el('div',null,'sede-actions');
    const locate=button('Usar mi ubicación',()=>{
      if(!navigator.geolocation){status.textContent='Tu navegador no permite detectar la ubicación. Puedes marcarla en el mapa.';return;}
      const ticket=++request;locate.disabled=true;status.textContent='Buscando tu ubicación…';
      navigator.geolocation.getCurrentPosition(position=>{
        locate.disabled=false;if(ticket!==request)return;
        if(select(position.coords.latitude,position.coords.longitude))dialog.close();
      },()=>{locate.disabled=false;if(ticket===request)status.textContent='No pudimos obtener tu ubicación. Permite el acceso o marca el punto en el mapa.';},
      {enableHighAccuracy:true,timeout:12000,maximumAge:0});
    });
    const mapButton=button('Marcar en el mapa',async()=>{
      request++;locate.disabled=false;mapButton.disabled=true;
      try{
        const L=await loadLeaflet();mapBox.hidden=false;confirm.hidden=false;
        if(!map){
          const first=sedes.find(hasCoverage),center=point||{lat:first.lat,lng:first.lng};map=L.map(mapBox).setView([center.lat,center.lng],13);
          L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,referrerPolicy:'strict-origin-when-cross-origin',attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(map);
          for(const s of sedes.filter(hasCoverage))L.circle([s.lat,s.lng],{radius:s.radio_km*1000,color:'#16865b',fillOpacity:.06}).addTo(map);
          map.on('click',e=>{
            candidate={lat:e.latlng.lat,lng:((e.latlng.lng+180)%360+360)%360-180};
            if(pin)pin.setLatLng(candidate);else pin=L.marker(candidate).addTo(map);
            confirm.disabled=false;const s=nearest(candidate.lat,candidate.lng,sedes);status.textContent=s?`Te atiende Sede ${s.nombre}. Confirma este punto de entrega.`:outside;
          });
        }
        requestAnimationFrame(()=>map.invalidateSize());status.textContent='Toca el mapa para marcar el punto de entrega y confírmalo.';
      }catch{status.textContent='No se pudo cargar el mapa. Reintenta o usa tu ubicación.';}finally{mapButton.disabled=false;}
    });
    actions.append(locate,mapButton);
    const mapBox=el('div',null,'sede-map');mapBox.hidden=true;
    const confirm=button('Confirmar punto de entrega',()=>{if(candidate&&select(candidate.lat,candidate.lng))dialog.close();});confirm.className='sede-confirm';confirm.disabled=true;confirm.hidden=true;
    dialog.append(title,status,actions,el('p','Usamos tu ubicación para comprobar la entrega. Al pedir, se incluye en WhatsApp. El mapa carga imágenes de OpenStreetMap.','sede-privacy'),mapBox,confirm,button('Cerrar',()=>dialog.close()));
    document.body.append(dialog);dialog.addEventListener('close',()=>{request++;locate.disabled=false;});
    function refresh(){summary.textContent=active?`✅ Ubicación marcada · te atiende ${active.nombre}`:attempted?outside:'Marca tu ubicación para confirmar que llegamos a tu zona.';status.textContent=summary.textContent;pick.textContent=active?'Cambiar ubicación':'📍 Marcar ubicación de entrega';}
    function show(){if(!dialog.open)dialog.showModal();if(map)requestAnimationFrame(()=>map.invalidateSize());}
    api.show=show;api.require=()=>{if(active)return true;show();return false;};refresh();if(openOnStart)show();return api;
  }
  const exported={validCoordinates,hasCoverage,nearest,create};
  if(typeof module!=='undefined'&&module.exports)module.exports=exported;else root.CraftGeo=exported;
})(typeof window!=='undefined'?window:globalThis);
