  // Banner del club de fidelización (opt-in): config.club = {label?} → {label, href} o null.
  // Sin la clave el menú queda igual. El label se pinta con textContent (nunca HTML del cliente).
  function clubBanner(club){
    if(!club || typeof club!=='object' || Array.isArray(club)) return null;
    const raw=typeof club.label==='string'?club.label.trim():'';
    return { label:(raw||'Juega y gana').slice(0,40), href:'/club' };
  }
  // Conteo del panel (Menú SaaS): beacon a /panel/e SOLO en menús edge (window.__CONFIG__ presente).
  // 'view' una vez por sesión de navegador (sessionStorage) y 'order' en cada compra. Legacy = cero requests;
  // sin sendBeacon o con storage bloqueado no lanza nada (el conteo es opcional, nunca rompe el menú).
  function panelCount(win,t){
    try{
      if(t!=='view' && t!=='order') return false;
      if(!win || !win.__CONFIG__) return false;
      if(t==='view'){ try{ if(win.sessionStorage.getItem('craft_v')) return false; win.sessionStorage.setItem('craft_v','1'); }catch(e){} }
      const nav=win.navigator, send=nav && nav.sendBeacon;
      return typeof send==='function' && send.call(nav,'/panel/e',JSON.stringify({t}))!==false;
    }catch(e){ return false; }
  }
  // Pedido web al panel (Menú SaaS): copia del checkout a /panel/o SOLO en menús edge (window.__CONFIG__).
  // Reutiliza el payload del CRM sin token ni store_url; sin sendBeacon cae a fetch keepalive.
  // Cualquier fallo es silencioso: el pedido ya salió por WhatsApp/CRM.
  function panelOrder(win,payload,order_id){
    try{
      if(!win || !win.__CONFIG__ || !payload) return false;
      const {items,total,currency,client_name,client_phone,delivery_mode,address}=payload;
      const body={items,total,currency,client_name,client_phone,delivery_mode,address,order_id:order_id||undefined};
      const json=JSON.stringify(body), nav=win.navigator, send=nav && nav.sendBeacon;
      if(typeof send==='function'){
        const BlobCtor=win.Blob || (typeof Blob!=='undefined' ? Blob : null);
        if(BlobCtor) return send.call(nav,'/panel/o',new BlobCtor([json],{type:'application/json'}))!==false;
      }
      const req=win.fetch;
      if(typeof req==='function'){
        req.call(win,'/panel/o',{method:'POST',headers:{'Content-Type':'application/json'},body:json,keepalive:true});
        return true;
      }
      return false;
    }catch(e){ return false; }
  }
  // ── Checkout nativo (opt-in config.checkout_orders) ────────────────────────
  // Sin la clave (o con enabled:false) el menú conserva el checkout legacy por WhatsApp/CRM.
  // Con la clave: sede desde ?sede= o selector, POST /api/orders, recibo visible y polling.
  function checkoutOrders(config){
    const raw=config&&config.checkout_orders;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.enabled!==true) return null;
    const poll=Number(raw.poll_ms);
    return {
      api_base:typeof raw.api_base==='string'?raw.api_base.replace(/\/+$/,''):'',
      poll_ms:Number.isFinite(poll)&&poll>=1000?Math.min(poll,60000):5000,
    };
  }
  function ordersEndpoint(checkout,path){
    if(!checkout) return '';
    const base=checkout.api_base||'';
    return base+(String(path).startsWith('/')?path:'/'+path);
  }
  // Sedes válidas del config; `activa:false` se excluye. IDs estables para el QR.
  function sedeList(config){
    const list=config&&config.location&&Array.isArray(config.location.sedes)?config.location.sedes:[];
    return list.filter(s=>s&&typeof s.id==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(s.id)&&
      typeof s.nombre==='string'&&s.nombre.trim()&&s.activa!==false)
      .map(s=>({id:s.id,nombre:s.nombre.trim(),direccion:typeof s.direccion==='string'?s.direccion.trim():''}));
  }
  function sedeFromQuery(config,search){
    let id='';
    try{ id=new URLSearchParams(search||'').get('sede')||''; }catch(e){ return ''; }
    return sedeList(config).some(s=>s.id===id)?id:'';
  }
  // Prioridad: sede del QR válida → sede guardada en esta pestaña → única sede disponible.
  function defaultSede(sedes,preferred,stored){
    const list=Array.isArray(sedes)?sedes:[];
    if(preferred&&list.some(s=>s.id===preferred)) return preferred;
    if(stored&&list.some(s=>s.id===stored)) return stored;
    return list.length===1?list[0].id:'';
  }
  const orderVariantValue=v=>v&&typeof v==='object'?(typeof v.label==='string'?v.label:(typeof v.name==='string'?v.name:'')):(v==null?'':String(v));
  function orderVariantLabel(variantes){
    if(!variantes||typeof variantes!=='object') return '';
    return Object.values(variantes).map(orderVariantValue).map(s=>s.trim()).filter(Boolean).join(' · ');
  }
  // El servidor recalcula el precio desde product_id; variant_id es el label publicado (no un id).
  // Solo se envía si el label pertenece a una opción del producto; si no, se omite la variante.
  function variantOptionExists(product,label){
    if(!product||!Array.isArray(product.variantes)) return false;
    const want=String(label).trim().toLowerCase();
    for(const group of product.variantes) for(const option of (group&&Array.isArray(group.options)?group.options:[])){
      const raw=orderVariantValue(option).trim().toLowerCase();
      const text=raw.replace(/\s*\(\$[\d.,]+\)\s*$/,'').trim();
      if(raw===want||text===want) return true;
    }
    return false;
  }
  function orderCartItems(items,catalog){
    const byId=new Map((Array.isArray(catalog)?catalog:[]).map(p=>[String(p.id),p]));
    return (Array.isArray(items)?items:[]).map(item=>{
      const qty=Number(item&&item.qty);
      if(!Number.isInteger(qty)||qty<1) return null;
      const line={product_id:String(item.id),qty:Math.min(qty,99)};
      const label=orderVariantLabel(item.variantes);
      if(label&&variantOptionExists(byId.get(String(item.id)),label)) line.variant_id=label;
      if(item.nota) line.note=[...String(item.nota)].slice(0,200).join('');
      return line;
    }).filter(Boolean);
  }
  const ORDER_STATUS_LABEL={
    pending:'Pedido recibido',
    confirmed:'Confirmado; lo están preparando',
    paid:'Pagado. ¡Buen provecho!',
    ready:'Tu pedido está listo',
    rejected:'Pedido rechazado',
  };
  function orderStatusLabel(status){ return ORDER_STATUS_LABEL[status]||'Estado del pedido'; }
  function orderStatusFinal(status){ return status==='paid'||status==='rejected'; }
  // Reintento idempotente: misma clave mientras el cuerpo no cambie; el servidor devuelve el mismo pedido.
  function nextOrderKey(previous,fingerprint,uuid){
    if(previous&&previous.fingerprint===fingerprint&&typeof previous.key==='string'&&
      /^[A-Za-z0-9_.:-]{8,100}$/.test(previous.key)) return previous.key;
    return uuid;
  }
  // ── Recibo /gracias y datos de facturación (helpers puros, testables en Node) ──
  // Datos bancarios SOLO si la config oficial los trae completos y existe un WhatsApp
  // oficial de comprobantes. Nunca hay cuentas por defecto: una config incompleta
  // devuelve null y la transferencia se deshabilita en la UI.
  function transferInfo(config){
    const raw=(config&&config.checkout_orders&&config.checkout_orders.transfer)||
      (config&&config.payments&&config.payments.transfer)||
      (config&&config.bank_transfer)||null;
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.enabled===false) return null;
    const pick=(...keys)=>{
      for(const key of keys){const value=raw[key];if(typeof value==='string'&&value.trim())return value.trim();}
      return '';
    };
    const bank=pick('bank','bank_name','banco');
    const account=pick('account_number','account','numero_cuenta','cuenta');
    const holder=pick('holder','holder_name','titular');
    const wa=String((config&&config.location&&config.location.telefono_principal)||(config&&config.whatsapp_number)||'').replace(/\D/g,'');
    if(!bank||!account||!holder||wa.length<7||wa.length>15) return null;
    return {bank,account,holder,account_type:pick('account_type','tipo_cuenta','type')};
  }
  // Validación UX del contrato fiscal. Devuelve {campo: mensaje}; el servidor sigue siendo la
  // fuente de verdad y valida otra vez longitud/formato antes de persistir.
  function billingFieldErrors(values){
    const v=values||{},errors={};
    const name=String(v.name||'').trim();
    if([...name].length<2) errors.name='Ingresa tu nombre y apellido.';
    const phone=String(v.phone||'').replace(/[^\d]/g,'');
    if(phone.length<7||phone.length>15) errors.phone='Ingresa un teléfono válido (7 a 15 dígitos).';
    const type=String(v.document_type||'');
    if(type!=='cedula'&&type!=='ruc') errors.document_type='Elige el tipo de documento.';
    const document=String(v.document_number||'').replace(/[\s.-]/g,'');
    if(!/^\d+$/.test(document)) errors.document_number='El documento solo puede tener números.';
    else if(type==='cedula'&&document.length!==10) errors.document_number='La cédula debe tener 10 dígitos.';
    else if(type==='ruc'&&document.length!==13) errors.document_number='El RUC debe tener 13 dígitos.';
    else if(type!=='cedula'&&type!=='ruc'&&(document.length<10||document.length>13)) errors.document_number='Ingresa un documento válido.';
    const email=String(v.email||'').trim();
    if(email.length>120||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email='Ingresa un correo electrónico válido.';
    const address=String(v.address||'').trim();
    if([...address].length<5) errors.address='Ingresa la dirección de facturación.';
    else if([...address].length>300) errors.address='La dirección es demasiado larga.';
    return errors;
  }
  // Retorno de la pasarela/recibo: id y token opacos. Acepta los alias nuevos sin perder el
  // contrato existente (?pedido&token&pago). El token NUNCA se registra en analítica.
  function parseOrderReturn(search){
    let params;
    try{params=new URLSearchParams(search||'');}catch(e){return null;}
    const id=(params.get('pedido')||params.get('order')||params.get('order_id')||'').trim();
    const token=(params.get('token')||params.get('order_token')||'').trim();
    if(!id||!token||id.length>100||token.length>200) return null;
    return {id,token,payment:(params.get('pago')||params.get('payment')||'').trim()};
  }
  function derivedPaymentStatus(order){
    const raw=String(order&&order.payment_status||'').toLowerCase();
    if(raw) return raw;
    const status=String(order&&order.status||'');
    return status==='paid'||status==='ready'?'paid':status==='rejected'?'rejected':'pending';
  }
  // Métodos que abren una pasarela de tarjeta (Bendo). Efectivo y
  // transferencia se confirman en caja y nunca redirigen.
  function cardPaymentMethod(method){ return method==='bendo'; }
  // Segmento de la ruta POST /api/orders/:id/<proveedor> para iniciar el cobro.
  function paymentStartPath(method){
    return method==='bendo'?'bendo':'';
  }
  // Etiqueta honesta del pago. `unknown`/timeout nunca se muestra como rechazo.
  // Con Bendo los textos son neutrales: "tarjeta", nunca el nombre del banco. Las
  // filas históricas de tarjeta usan los mismos textos para no romper el recibo.
  function orderPaymentLabel(order){
    const method=String(order&&order.payment_method||'cash');
    const status=String(order&&order.status||'pending');
    const payment=derivedPaymentStatus(order);
    if(status==='rejected') return payment==='rejected'?'Pago rechazado':'Pedido rechazado';
    if(method==='cash') return status==='paid'||status==='ready'?'Pago confirmado en caja':'Pago pendiente en caja';
    if(method==='transfer') return status==='paid'||status==='ready'?'Transferencia verificada':'Pago pendiente de verificación';
    if(payment==='rejected') return 'Pago rechazado por la tarjeta';
    if(payment==='failed') return 'El pago con tarjeta no se completó';
    if(payment==='unknown') return 'Pago con tarjeta en verificación';
    if(payment==='paid'||status==='paid'||status==='ready') return 'Pago confirmado con tarjeta';
    return 'Esperando confirmación de la tarjeta';
  }
  // Reintentar tarjeta solo cuando el intento anterior falló antes de cobrar. Con pago
  // `unknown` o pendiente NO se ofrece: reintentar podría duplicar el cobro.
  function thanksRetryAllowed(order){
    if(!order||!cardPaymentMethod(String(order.payment_method||''))) return false;
    const status=String(order.status||'');
    if(status==='paid'||status==='ready') return false;
    const payment=derivedPaymentStatus(order);
    return payment==='failed'||order.retryable===true;
  }
  function thanksPurchaseEligible(order){
    const status=String(order&&order.status||'');
    return status==='paid'||status==='ready';
  }
  // El polling del recibo termina en estados estables. `paid` sigue consultando para
  // reflejar `ready`; `unknown` sigue pendiente y nunca se asume rechazo.
  function thanksPollFinal(status){ return status==='ready'||status==='rejected'; }
  if(typeof module!=='undefined' && module.exports) module.exports={clubBanner,panelCount,panelOrder,
    checkoutOrders,ordersEndpoint,sedeList,sedeFromQuery,defaultSede,orderVariantLabel,variantOptionExists,
    orderCartItems,orderStatusLabel,orderStatusFinal,nextOrderKey,transferInfo,billingFieldErrors,
    parseOrderReturn,orderPaymentLabel,thanksRetryAllowed,thanksPurchaseEligible,thanksPollFinal,
    cardPaymentMethod,paymentStartPath};

  // El motor solo corre en el navegador: el guard permite testear clubBanner en Node sin DOM.
  if(typeof document!=='undefined') (function(){
    'use strict';

    /* ── STATE ── */
    let cartItems = [];
    // El id del pedido de mesa vive mientras el carrito no cambie: un reintento no crea otra comanda.
    let tableOrderId = null;
    let favs = [];
    let products = [];
    let config = {};
    let coverage = null;
    // i18n opt-in por config.locale. La clave ES el texto en español: sin locale (o "es") t() devuelve
    // el mismo string → menús existentes byte-idénticos. {0},{1}… = argumentos.
    const EN={
      'No se pudo cargar el registro. Reintenta.':'Could not load the order service. Please try again.',
      'No se pudo comprobar la cobertura. Recarga el menú para reintentar.':'Could not check delivery coverage. Reload the menu to try again.',
      'Opción':'Option','Agotado':'Sold out','¡Quedan pocas!':'Only a few left!',
      'Quitado de favoritos':'Removed from favorites','❤ Agregado a favoritos':'❤ Added to favorites',
      'Stock insuficiente':'Not enough stock','Nota (opcional): sin cebolla, huevo revuelto…':'Note (optional): no onion, scrambled eggs…','Nota (opcional): sabor preferido, indicaciones…':'Note (optional): preferred flavor, instructions…','Nota para este producto':'Note for this item','Nota:':'Note:','Agregado al pedido':'Added to your order',
      'Pedido anticipado para la próxima apertura: {0}. Lo despachamos apenas abramos.':'Pre-order for our next opening: {0}. We’ll prepare it as soon as we open.',
      'Todo':'All','Categorías anteriores':'Previous categories','Más categorías':'More categories',
      'Oferta':'Deal','Favorito':'Favorite','Elegir opciones':'Choose options','Agregar':'Add','Ver oferta':'View deal',
      'Tus Favoritos':'Your Favorites','No tienes favoritos aún.':'No favorites yet.',
      'Ofertas':'Deals','No hay ofertas activas ahora mismo.':'No active deals right now.',
      'No se encontraron productos':'No products found','Síguenos':'Follow us','Ubicación':'Location',
      'Juega y gana':'Play & win',
      '📍 Nuestra Ubicación':'📍 Our Location','📅 Haz una reserva':'📅 Make a reservation',
      'Cuéntanos cuándo vienes y te confirmamos por WhatsApp':'Tell us when you’re coming and we’ll confirm on WhatsApp',
      'Sabores':'Flavors','Personaliza':'Customize','— Elige una opción —':'— Choose an option —','Opciones':'Options','Salsa':'Sauce',
      'Reparte {0} — faltan {1}':'Choose {0} — {1} left','Elige {0} {1}s':'Choose {0} {1}s',
      'Selecciona todas las opciones':'Please select all options','Producto agotado':'Sold out',
      '{0} item(s) · {1} producto(s)':'{0} item(s) · {1} product(s)','Empaque':'Packaging','Envío':'Delivery fee',
      'Tu pedido está vacío':'Your order is empty','Quitar':'Remove','¿Algo más?':'Anything else?',
      'Tu Pedido':'Your Order','Estamos cerrados ahora':'We’re closed right now','Datos de entrega':'Your details',
      'WhatsApp no configurado':'WhatsApp is not set up','Completa tu nombre y teléfono':'Please enter your name and phone','Completa: {0}':'Please fill in: {0}',
      '¿En qué food truck?':'Which food truck?','Selecciona tu food truck':'Select your food truck','Selecciona un food truck válido':'Select a valid food truck',
      'Food truck':'Food truck','Total':'Total','Estado del pedido':'Order status','Consultando estado…':'Checking status…','Hacer otro pedido':'Place another order',
      'Muestra este número en tu food truck.':'Show this number at your food truck.',
      'No pudimos consultar el estado. Muestra tu número en el food truck.':'We could not check the status. Show your number at the food truck.',
      'Pedido recibido':'Order received','Confirmado; lo están preparando':'Confirmed; they are preparing it','Pagado. ¡Buen provecho!':'Paid. Enjoy!','Pedido rechazado':'Order rejected','Pedido confirmado':'Order confirmed','Pago confirmado':'Payment confirmed','Tu pedido está listo':'Your order is ready','¡Tu pedido está listo!':'Your order is ready!',
      'Confirmar pedido':'Confirm order','Confirmar pedido por WhatsApp':'Confirm order on WhatsApp',
      'El pago con tarjeta no se completó':'The card payment was not completed',
      'No se completó el pago con tarjeta. Puedes reintentar.':'The card payment was not completed. You can try again.',
      'Tarjeta de crédito o débito':'Credit or debit card','Tarjeta de crédito o débito (no disponible)':'Credit or debit card (unavailable)',
      'Serás dirigido al pago seguro con tarjeta. La confirmación llega al volver.':'You will be redirected to the secure card payment. Confirmation arrives when you return.',
      'No se pudo abrir el pago con tarjeta. Reintenta.':'We could not open the card payment. Try again.',
      'Datos de facturación':'Billing details','Tipo de documento':'Document type','Cédula':'ID card','RUC':'Tax ID (RUC)','Número de documento':'Document number','Correo electrónico':'Email','Dirección de facturación':'Billing address','Estos datos se usan solo para tu comprobante. No se envían por WhatsApp.':'This information is used only for your receipt. It is never sent through WhatsApp.',
      'Te avisaremos por WhatsApp al número que ingresaste cuando tu pedido esté listo.':'We will notify you on WhatsApp at the number you entered when your order is ready.',
      'Revisa los datos de facturación':'Please review your billing details','Ingresa tu nombre y apellido.':'Please enter your full name.','Ingresa un teléfono válido (7 a 15 dígitos).':'Please enter a valid phone number (7 to 15 digits).','Elige el tipo de documento.':'Choose a document type.','El documento solo puede tener números.':'The document can only contain numbers.','La cédula debe tener 10 dígitos.':'The ID card must have 10 digits.','El RUC debe tener 13 dígitos.':'The RUC must have 13 digits.','Ingresa un documento válido.':'Please enter a valid document.','Ingresa un correo electrónico válido.':'Please enter a valid email address.','Ingresa la dirección de facturación.':'Please enter your billing address.','La dirección es demasiado larga.':'The address is too long.',
      'Pago pendiente en caja':'Payment pending at the counter','Pago pendiente de verificación':'Payment pending verification','Pago confirmado en caja':'Payment confirmed at the counter','Transferencia verificada':'Transfer verified',
      'Pago rechazado por la tarjeta':'Payment rejected by the card','Pago con tarjeta en verificación':'Card payment being verified','Pago confirmado con tarjeta':'Payment confirmed with card','Esperando confirmación de la tarjeta':'Waiting for card confirmation',
      'Estamos verificando tu pago con tarjeta. No vuelvas a pagar.':'We are verifying your card payment. Please do not pay again.',
      'Volver al menú':'Back to the menu','Actualizar estado':'Refresh status','Actualizando…':'Refreshing…','Verificando tu pago…':'Verifying your payment…','No pudimos consultar el estado. Reintenta.':'We could not check the status. Try again.','No encontramos este pedido en este dispositivo.':'We could not find this order on this device.','Muestra este número en caja.':'Show this number at the counter.','Envía tu comprobante por WhatsApp':'Send your receipt on WhatsApp','Transferencia no disponible':'Transfer unavailable','La cuenta bancaria aún no está configurada. Paga en efectivo en caja.':'The bank account is not configured yet. Please pay in cash at the counter.','Reintentar pago con tarjeta':'Retry card payment','El pago no fue aprobado. Puedes volver al menú e intentar de nuevo.':'The payment was not approved. You can go back to the menu and try again.','Cuando tu pedido esté listo te avisaremos por WhatsApp al número que registraste.':'When your order is ready we will notify you on WhatsApp at the number you registered.','Tus datos fiscales no se muestran en esta página.':'Your tax details are not shown on this page.','Resumen':'Summary','Sede':'Location','Método de pago':'Payment method','Datos para tu comprobante':'Details for your receipt','Facturación':'Billing','Resumen no disponible. Muestra tu número en caja.':'Summary unavailable. Show your number at the counter.',
      'Datos para tu comprobante. No se muestran públicamente.':'Details for your receipt. They are not shown publicly.',
      'Cuando tu pedido esté listo te avisaremos por WhatsApp.':'We will notify you on WhatsApp when your order is ready.',
      'Banco':'Bank','Tipo de cuenta':'Account type','Cuenta':'Account','Titular':'Account holder',
      'Efectivo en caja':'Cash at the counter','Transferencia bancaria':'Bank transfer',
      'Un producto ya no está disponible. Revisa tu pedido':'An item is no longer available. Please review your order.',
      'Un producto ya no tiene stock. Revisa tu pedido':'An item is out of stock. Please review your order.',
      'Una opción del pedido cambió. Vuelve a elegirla':'An option in your order changed. Please choose it again.',
      'El precio de un producto cambió. Revisa tu pedido':'An item price changed. Please review your order.',
      'El pedido cambió. Revisa el carrito e intenta de nuevo':'The order changed. Review your cart and try again.',
      'Demasiados intentos. Espera un momento':'Too many attempts. Please wait a moment.',
      'Revisa los datos del pedido':'Please review the order details.','El menú no está disponible ahora. Reintenta':'The menu is not available right now. Try again.',
      'No se pudo enviar tu pedido. Reintenta.':'We could not send your order. Try again.','La conexión tardó demasiado. Reintenta.':'The connection took too long. Try again.',
      'Ingresa tu dirección de entrega':'Please enter your delivery address',
      'Número de mesa (opcional)':'Table number (optional)','Teléfono (opcional)':'Phone (optional)','Teléfono':'Phone',
      'Enviando pedido…':'Sending order…','Pedido #{0} enviado':'Order #{0} sent',
      'Avísale a tu mesero que ya hiciste tu pedido':'Let your server know you have already placed your order',
      'Listo':'Done',
      'No se pudo enviar tu pedido. Intenta de nuevo o avísale a tu mesero':
        'We couldn’t send your order. Try again or let your server know',
      '¡Hola! Quiero hacer un pedido:':'Hi! I’d like to place an order:','¡Hola! Quiero pedir:':'Hi! I’d like to order:',
      '*PEDIDO — {0}*':'*ORDER — {0}*','*ENTREGA:*':'*ORDER TYPE:*','Domicilio':'Delivery','Mesa':'Dine-in','Retiro en local':'Pickup',
      '*Cliente:*':'*Customer:*','*Teléfono:*':'*Phone:*','*Dirección:*':'*Address:*','Registrando pedido…':'Placing your order…',
      'La conexión tardó demasiado. Reintenta para recuperar tu número.':'The connection timed out. Try again to recover your order number.',
      'No se pudo registrar el pedido. Reintenta.':'We couldn’t place your order. Please try again.',
      'Este intento pertenece a otro pedido. Revisa el carrito antes de continuar.':'This attempt belongs to another order. Check your cart before continuing.',
      'No se pudo confirmar el registro. Reintenta para recuperar tu número de pedido.':'We couldn’t confirm your order. Try again to recover your order number.',
      'Pedido {0} registrado':'Order {0} placed','*Pedido {0}*':'*Order {0}*','Abriendo WhatsApp…':'Opening WhatsApp…',
      'Te llevamos a WhatsApp para coordinar tu pedido. Si no se abrió, usa el botón.':'We’re taking you to WhatsApp to finish your order. If it didn’t open, use the button.',
      'Continuar por WhatsApp':'Continue on WhatsApp','Crear otro pedido':'Start a new order',
      'Nombre y apellido':'Full name','Tu nombre completo':'Your full name','Tu número de WhatsApp':'Your WhatsApp number',
      'Día':'Day','Hora':'Time','¿Cuántas personas?':'How many people?','¿Celebran algo especial? (opcional)':'Celebrating something? (optional)',
      'Cumpleaños, aniversario…':'Birthday, anniversary…','Confirmar reserva':'Confirm reservation',
      'Completa nombre y WhatsApp':'Please enter your name and WhatsApp','el local':'the restaurant',
      '¡Hola! Quiero hacer una *reserva* en {0}:':'Hi! I’d like to make a *reservation* at {0}:',
      '*Nombre:*':'*Name:*','*Día:*':'*Day:*','*Hora:*':'*Time:*','*Personas:*':'*Guests:*','*Ocasión:*':'*Occasion:*',
      'Estamos cerrados':'We’re closed','Ten mi pedido listo':'Browse the menu','📅 Hacer una reserva':'📅 Make a reservation',
      'Vuelve en nuestro horario de atención.':'Come back during our opening hours.',
      'Puedes explorar el menú y pedir dentro del horario de atención.':'You can browse the menu and order during opening hours.',
      'No se pudo cargar el selector de ubicación. Recarga para reintentar.':'Could not load the location picker. Reload to try again.',
      'Términos y condiciones':'Terms and conditions','Política de privacidad':'Privacy policy',
      'Mín. <strong>{0} unidades</strong>':'Min. <strong>{0} units</strong>','con <strong>{0} días</strong> de anticipación':'<strong>{0} days</strong> in advance',
      'Error cargando catálogo':'Error loading the menu',
      'Domingo':'Sunday','Lunes':'Monday','Martes':'Tuesday','Miércoles':'Wednesday','Jueves':'Thursday','Viernes':'Friday','Sábado':'Saturday'
    };
    const isEN=()=>config.locale==='en';
    const t=(s,...a)=>((isEN()&&EN[s])||s).replace(/\{(\d)\}/g,(_,i)=>a[i]);
  const orderScriptURL = new URL('order-checkout.js', document.currentScript.src).href;
  let checkoutBusy = false;
  async function orderCheckout(){
    if(window.CraftOrderCheckout) return window.CraftOrderCheckout;
    await (window.craftOrderLoading ||= new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = orderScriptURL;
      script.onload = resolve; script.onerror = () => { window.craftOrderLoading = null; script.remove(); reject(new Error(t('No se pudo cargar el registro. Reintenta.'))); };
      document.head.append(script);
    }));
    return window.CraftOrderCheckout;
  }
  // Tracking opt-in: tracking.js se carga solo si config.tracking existe; los eventos previos a la carga se encolan.
  const trackingScriptURL = new URL('tracking.js', document.currentScript.src).href;
  let tracker = null, trackQueue = [];
  const track = (name, detail) => { try { tracker ? tracker.track(name, detail) : trackQueue?.push([name, detail]); } catch(e){} };
  function initTracking(){
    if(!config.tracking || typeof config.tracking !== 'object'){ trackQueue = null; return; }
    const ready = () => { try { tracker = window.CraftTracking.create(config); tracker.track('PageView'); trackQueue.forEach(e => tracker.track(...e)); } catch(e){ tracker = null; } trackQueue = null; };
    if(window.CraftTracking) return ready();
    const s = document.createElement('script'); s.src = trackingScriptURL; s.onload = ready; s.onerror = () => { trackQueue = null; }; document.head.append(s);
  }
    const geoScriptURL=new URL('geo.js',document.currentScript.src).href;
    const needsCoverage=()=>Array.isArray(config.location?.sedes)&&config.location.sedes.some(s=>s?.lat!=null&&s?.lng!=null&&Number(s.radio_km)>0);
    function requireCoverage(){
      if(!needsCoverage())return true;
      if(coverage)return coverage.require();
      showToast(t('No se pudo comprobar la cobertura. Recarga el menú para reintentar.'));return false;
    }
    const orderPhone=()=>coverage?coverage.phone():(config.whatsapp_number||'').replace(/\D/g,'');
    const sedeNote=()=>coverage?coverage.note():'';
    let activeFilter = 'all';   // 'all' | <slug> | '__offers__' | '__favs__'
    let searchQuery = '';
    let categorySlugs = [];
    let activeBrand = '';       // filtro de marca (config.brand_filter): se combina con el chip activo
    let storeClosed = false;    // fuera de horario (config.hours) → bloquea el checkout, no la navegación

    let modalProduct = null, modalQty = 1, modalVariants = {}, modalDist = {}, modalRepeat = {}, modalCombo = {}, modalNote = '', sliderIdx = 0, sliderImages = [];

    /* ── DOM REFS ── */
    const $catalog=document.getElementById('catalog'),$searchInput=document.getElementById('searchInput'),
      $catStrip=document.getElementById('catStrip'),$cartOverlay=document.getElementById('cartOverlay'),
      $cartDrawer=document.getElementById('cartDrawer'),$cartClose=document.getElementById('cartClose'),
      $cartItems=document.getElementById('cartItems'),$cartTotal=document.getElementById('cartTotal'),
      $cartItemCount=document.getElementById('cartItemCount'),$btnCheckout=document.getElementById('btnCheckout'),
      $toast=document.getElementById('toast'),$modalOverlay=document.getElementById('modalOverlay'),
      $modalClose=document.getElementById('modalClose'),$modalFav=document.getElementById('modalFav'),
      $sliderTrack=document.getElementById('sliderTrack'),$sliderPrev=document.getElementById('sliderPrev'),
      $sliderNext=document.getElementById('sliderNext'),$sliderDots=document.getElementById('sliderDots'),
      $modalDetail=document.getElementById('modalDetail'),$navBadge=document.getElementById('navBadge'),
      $cartPeek=document.getElementById('cartPeek'),$peekCount=document.getElementById('peekCount'),
      $peekTotal=document.getElementById('peekTotal');

    /* ── HELPERS ── */
    const normalize=s=>(s||'').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');

    function parsePrice(p){
      if(typeof p.precio==='number') return p.precio;
      const m=(p.precio||'').toString().match(/[\d.]+/);
      return m?parseFloat(m[0]):0;
    }
    function promoPrice(p){
      const promo=Number(p.precio_promo);
      return Number.isFinite(promo)&&promo>0&&promo<parsePrice(p)?promo:null;
    }
    const basePrice=p=>promoPrice(p)??parsePrice(p);
    const getImages=p=>Array.isArray(p.imagenes)&&p.imagenes.length?p.imagenes:(p.imagen?[p.imagen]:[]);
    const getOptionKey=o=>(typeof o==='object'&&o!==null)?(o.label||''):String(o);
    const getOptionDisplay=getOptionKey;
    const getOptionPrice=o=>(typeof o==='object'&&o!==null&&typeof o.price==='number')?o.price:null;
    // Recargo aditivo embebido en el nombre: "... +$1", "... +$0.25". Suma sobre la base.
    const getOptionDelta=o=>{const m=String(getOptionDisplay(o)).match(/\+\s*\$\s*([0-9]+(?:[.,][0-9]+)?)/);return m?parseFloat(m[1].replace(',','.')):0;};
    // Suma de recargos "+$X" de las opciones repartidas (distribute), ponderada por su cantidad.
    const distDeltaOf=(group,counts)=>(group.options||[]).reduce((s,o)=>s+(counts[getOptionKey(o)]||0)*getOptionDelta(o),0);
    // ponytail: alitas/wings con >=8 uds y >1 salsa → repartir cantidad por salsa. Total sale del nombre ("x 8", "x20").
    const unitCount=p=>{const m=(p.nombre||'').match(/x\s*(\d+)/i);return m?+m[1]:0;};
    function distGroup(p){
      // Grupo explícito de distribución (elige N repartibles): total = número en el nombre del grupo.
      const dg=(p.variantes||[]).find(g=>g.type==='distribute'&&Array.isArray(g.options)&&g.options.length>1);
      // total: grupos reutilizables traen `pick` (elige N); los legacy inline lo sacan del nombre ("Elige tus 3").
      if(dg){const m=String(dg.name||'').match(/\d+/);return{group:dg,total:dg.pick>0?dg.pick:(m?+m[0]:1)};}
      // Alitas: total = cantidad en el nombre del producto ("x N"), categoría alitas/wings.
      if(unitCount(p)<8) return null;
      if(!(p.categorias||[]).some(c=>/alit|wing/i.test(c))) return null;
      const g=(p.variantes||[]).find(g=>Array.isArray(g.options)&&g.options.length>1);
      return g?{group:g,total:unitCount(p)}:null;
    }

    // Promo NxM (ej. 3x2): grupo con "pick" selectores; se cobra todo menos las "free" opciones
    // más baratas elegidas. null si el producto no usa el mecanismo (retrocompatible).
    function comboInfo(p){
      if(!Array.isArray(p.variantes)) return null;
      // Excluye distribute: un grupo distribute con pick>0 (ej. "elige N salsas") NO es un combo
      // NxM. Sin esta guarda, effPrice tomaba la rama combo y perdía el recargo de las opciones.
      const gi=p.variantes.findIndex(g=>g&&g.pick>0&&g.type!=='distribute');
      if(gi<0) return null;
      const g=p.variantes[gi];
      const priceOf=lbl=>{const o=(g.options||[]).find(o=>getOptionKey(o)===lbl);return o?(getOptionPrice(o)||0):0;};
      return {gi,g,pick:g.pick,free:g.free||0,item:g.item||t('Opción'),priceOf};
    }
    // Precio 3x2: suma de las elegidas menos las `free` más baratas.
    const comboTotal=(ci,labels)=>{
      const prices=labels.filter(Boolean).map(ci.priceOf).sort((a,b)=>a-b);
      return prices.slice(ci.free).reduce((s,x)=>s+x,0);
    };
    function getEffectivePrice(p,variantes){
      if(!variantes||!Object.keys(variantes).length) return basePrice(p);
      // Selección con precio ya resuelto (ej. distribute con salsas premium) → úsalo tal cual.
      for(const val of Object.values(variantes)) if(val&&typeof val==='object'&&val.price!=null) return Number(val.price);
      const ci=comboInfo(p);
      // pick con opciones sin precio (ej. salsas incluidas) = precio base; con precio = NxM (suma−free).
      if(ci){
        const priced=(ci.g.options||[]).some(o=>getOptionPrice(o)!==null);
        return priced?comboTotal(ci,Array.from({length:ci.pick},(_,k)=>variantes['c'+k])):basePrice(p);
      }
      let absolute=null,delta=0;
      if(Array.isArray(p.variantes)){
        for(let i=0;i<p.variantes.length;i++){
          const sel=variantes[i];
          if(sel===undefined) continue;
          const opt=p.variantes[i].options.find(o=>getOptionKey(o)===sel);
          if(!opt) continue;
          const vp=getOptionPrice(opt);
          if(vp!==null) absolute=vp;      // selector absoluto (ej. Bebidas 1L)
          else delta+=getOptionDelta(opt); // recargo aditivo del combo
        }
      }
      return (absolute!==null?absolute:basePrice(p))+delta;
    }
    function formatPrice(n){
      const c=config.price_symbol||config.currency||'$';
      const d=Math.abs(n)<10?2:(Number.isInteger(n)?0:2);
      if(config.price_locale){const k=config.price_decimals??0;return c+' '+n.toLocaleString(config.price_locale===true?'en-US':config.price_locale,{minimumFractionDigits:k,maximumFractionDigits:k});}
      return c+n.toFixed(d);
    }
    // distribute guarda la variante como objeto {label,price}; extraer el texto o coacciona a "[object Object]".
    const vDisp=x=>(x&&typeof x==='object')?(x.label||x.name||''):(x??'');
    const cartKey=(id,v)=>(!v||!Object.keys(v).length)?String(id):id+':'+Object.entries(v).sort().map(([k,x])=>k+'='+vDisp(x)).join(',');
    const esc=s=>String(s).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
    const variantLabel=v=>(!v||!Object.keys(v).length)?'':Object.entries(v).map(([,x])=>vDisp(x)).filter(Boolean).join(' · ');

    function getStockInfo(p){
      if(p.stock===0) return {badge:t('Agotado'),cls:'sold-out',canAdd:false,maxQty:0};
      if(typeof p.stock==='number'&&p.stock>=1&&p.stock<=3) return {badge:t('¡Quedan pocas!'),cls:'low-stock',canAdd:true,maxQty:p.stock};
      return {badge:null,cls:'',canAdd:true,maxQty:Infinity};
    }
    const badgeCat=()=>config.badge_category||null;
    const isOffer=p=>promoPrice(p)!==null||(badgeCat()&&(p.categorias||[]).includes(badgeCat()));
    const isPromo=p=>p.tipo==='promocion';
    // Oferta activa hoy: sku lleva el/los día(s) de la semana (0=dom..6=sáb, coma-sep). Vacío = siempre.
    // ponytail: reusar sku como día de la promo; migrar a columna promo_days si se necesita SKU real en promos.
    const promoActiveToday=p=>{
      const raw=(p.sku||'').trim();
      if(!raw) return true;
      const today=new Date().getDay();
      return raw.split(',').map(s=>parseInt(s,10)).includes(today);
    };

    // Category → emoji icon (keyword match on slug + visible name)
    const CAT_ICONS=[['hamburg','🍔'],['burger','🍔'],['pizza','🍕'],['pollo','🍗'],['alit','🍗'],['wing','🍗'],
      ['papa','🍟'],['frit','🍟'],['acompa','🍟'],['bebida','🥤'],['refres','🥤'],['gaseosa','🥤'],['jugo','🧃'],
      ['cafe','☕'],['café','☕'],['combo','🍱'],['postre','🍰'],['dulce','🍰'],['helado','🍦'],['ensalada','🥗'],
      ['sushi','🍣'],['taco','🌮'],['burrito','🌯'],['wrap','🌯'],['sandwi','🥪'],['hot dog','🌭'],['hotdog','🌭'],
      ['perro','🌭'],['salchi','🌭'],['nacho','🧀'],['queso','🧀'],['carne','🥩'],['parrilla','🥩'],['asado','🥩'],
      ['pasta','🍝'],['sopa','🍲'],['caldo','🍲'],['marisc','🦐'],['camaron','🦐'],['ceviche','🦐'],['pescado','🐟'],
      ['desayuno','🍳'],['huevo','🍳'],['pan','🥖'],['empana','🥟'],['dona','🍩'],['galleta','🍪'],['pastel','🎂'],
      ['torta','🎂'],['fruta','🍓'],['vega','🥗'],['bowl','🥣'],['arroz','🍚']];
    // Emoji líder de un texto (el que el operador pone en el nombre de la categoría), '' si no hay.
    const leadingEmoji=str=>{
      const m=(str||'').match(/^\s*(\p{Extended_Pictographic}(?:[️‍\u{1F3FB}-\u{1F3FF}]|\p{Extended_Pictographic})*)/u);
      return m?m[1].trim():'';
    };
    // Nombre de categoría sin el emoji líder (para el label del chip / header).
    const catLabel=name=>{const e=leadingEmoji(name);return e?(name||'').replace(e,'').trim():(name||'');};
    function catIcon(slug,name){
      const e=leadingEmoji(name);          // el emoji del nombre manda (control del operador desde el CRM)
      if(e) return e;
      const s=normalize(slug+' '+(name||''));
      for(const [k,ic] of CAT_ICONS) if(s.includes(normalize(k))) return ic;
      return phIcon();
    }
    const phIcon=()=>config.store_mode?'🛍️':'🍽️';

    let toastTimer;
    function showToast(msg){
      $toast.textContent=msg;$toast.classList.add('show');
      clearTimeout(toastTimer);toastTimer=setTimeout(()=>$toast.classList.remove('show'),2200);
    }

    /* ── FAVORITES ── */
    const isFav=id=>favs.includes(String(id));
    function toggleFav(id){
      id=String(id);
      const i=favs.indexOf(id);
      if(i>=0){favs.splice(i,1);showToast(t('Quitado de favoritos'));}
      else{favs.push(id);showToast(t('❤ Agregado a favoritos'));}
      saveFavs();
      document.querySelectorAll(`.fav-btn[data-fav="${id}"]`).forEach(b=>b.classList.toggle('active',isFav(id)));
      if($modalFav.dataset.fav===id){$modalFav.classList.toggle('active',isFav(id));$modalFav.textContent=isFav(id)?'♥':'♡';}
      if(activeFilter==='__favs__') renderCatalog();
    }
    const saveFavs=()=>{try{localStorage.setItem('menu_favs',JSON.stringify(favs));}catch(e){}};
    function loadFavs(){try{const s=JSON.parse(localStorage.getItem('menu_favs')||'[]');if(Array.isArray(s))favs=s.map(String);}catch(e){}}

    /* ── CART LOGIC ── */
    const cartFind=key=>cartItems.find(i=>i.key===key);
    // nota: texto libre del cliente ("Sin cebolla"); misma nota suma qty, nota distinta = línea aparte.
    function cartAdd(id,variantes,qty,nota=''){
      const p=products.find(x=>String(x.id)===String(id));
      if(!p) return;
      const stock=getStockInfo(p),key=cartKey(id,variantes)+(nota?'#'+nota:''),existing=cartFind(key);
      const newQty=cartItems.filter(ci=>String(ci.id)===String(id)).reduce((s,ci)=>s+ci.qty,0)+qty;
      if(newQty>stock.maxQty){showToast(t('Stock insuficiente'));return;}
      if(existing) existing.qty+=qty;
      else cartItems.push({key,id,nombre:p.nombre,precio:getEffectivePrice(p,variantes),qty,variantes:variantes||{},nota,imagen:getImages(p)[0]||''});
      tableOrderId=null;saveCart();updateCartUI();updateCardButtons();showToast(t('Agregado al pedido'));
      track('AddToCart',{contents:[{...cartFind(key),qty}]});
    }
    function cartRemoveOne(key){
      const item=cartFind(key);if(!item) return;
      item.qty--;if(item.qty<=0) cartItems=cartItems.filter(i=>i.key!==key);
      tableOrderId=null;saveCart();updateCartUI();updateCardButtons();
    }
    // Pedido enviado: vaciar el carrito para que al volver al menú no reaparezca.
    function clearCart(){tableOrderId=null;cartItems=[];saveCart();updateCartUI();updateCardButtons();}
    function cartDelete(key){tableOrderId=null;cartItems=cartItems.filter(i=>i.key!==key);saveCart();updateCartUI();updateCardButtons();}
    const saveCart=()=>{try{localStorage.setItem('menu_cart',JSON.stringify(cartItems));}catch(e){}};
    function loadCart(){try{const s=JSON.parse(localStorage.getItem('menu_cart')||'[]');if(Array.isArray(s))cartItems=s;}catch(e){}}
    const cartTotalQty=()=>cartItems.reduce((s,i)=>s+i.qty,0);
    const cartTotalPrice=()=>cartItems.reduce((s,i)=>s+i.precio*i.qty,0);

    /* ── HORARIO Y EMPAQUE (opt-in por config; no-op si faltan) ── */
    // Modo de entrega activo en el checkout (por defecto domicilio; el empaque solo aplica a domicilio).
    const currentMode=()=>checkoutOrders(config)?'pickup':document.querySelector('.dtog-btn.active')?.dataset.mode||'delivery';
    // Costo de empaque: plano por pedido (per_order, default), por unidad (per_unit) o individual
    // por producto (per_product, usa products[].costo_empaque de cada ítem). 0 en retiro o sin config.
    // exempt_categories: ítems cuya categoría esté ahí no pagan empaque (ej. bebidas). Sin la clave = todos pagan.
    function packagingFee(mode){
      const p=config.packaging;
      if(!p||!p.enabled||mode==='mesa') return 0; // envase se cobra en domicilio y retiro; mesa no lleva empaque
      const exempt=new Set(p.exempt_categories||[]);
      const prodOf=i=>products.find(x=>String(x.id)===String(i.id));
      const billable=exempt.size?cartItems.filter(i=>{
        const prod=prodOf(i);
        return !prod||(prod.categorias||[]).every(c=>!exempt.has(c));
      }):cartItems;
      if(!billable.length) return 0;
      if(p.mode==='per_product') // cada producto paga su propio costo_empaque × cantidad
        return billable.reduce((s,i)=>s+(+((prodOf(i)||{}).costo_empaque)||0)*i.qty,0);
      const cost=+p.cost||0; if(cost<=0) return 0;
      return p.mode==='per_unit' ? cost*billable.reduce((s,i)=>s+i.qty,0) : cost;
    }
    // Recargos del pedido [etiqueta, monto]: empaque + envío fijo (config.delivery_fee, solo domicilio; opt-in).
    const orderFees=mode=>[[t((config.packaging&&config.packaging.label)||'Empaque'),packagingFee(mode)],
      [t('Envío'),mode==='delivery'&&cartItems.length?(+config.delivery_fee||0):0]].filter(f=>f[1]>0);
    const feesTotal=mode=>orderFees(mode).reduce((s,f)=>s+f[1],0);
    // Calendario local del negocio; incluye la madrugada perteneciente al día anterior.
    function storeHoursState(h,now=new Date()){
      if(!h||!h.weekly||!Object.keys(h.weekly).length) return {open:true,preorder:false,next:''};
      let parts;
      try{ parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:h.tz||'America/Guayaquil',
        hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(now).map(p=>[p.type,p.value])); }
      catch(e){ return {open:true,preorder:false,next:''}; }
      const midnight=Date.UTC(+parts.year,+parts.month-1,+parts.day),current=midnight+(+parts.hour*60+ +parts.minute)*60000;
      const toMin=s=>{if(!/^\d{2}:\d{2}$/.test(s))return NaN;const [a,b]=s.split(':').map(Number);return a<=24&&b<60&&(a!==24||b===0)?a*60+b:NaN;};
      let open=false,next=Infinity;
      for(let offset=-1;offset<=7;offset++){
        const date=new Date(midnight+offset*86400000);
        for(const r of h.weekly[date.getUTCDay()]||[]){
          if(!Array.isArray(r)||r.length!==2)continue;
          const start=toMin(r[0]);let end=toMin(r[1]);
          if(!Number.isFinite(start)||!Number.isFinite(end)||start===1440)continue;
          if(end<=start)end+=1440;
          const a=+date+start*60000,b=+date+end*60000;
          if(current>=a&&current<b)open=true;
          if(a>current&&a<next)next=a;
        }
      }
      const nextLabel=Number.isFinite(next)?new Intl.DateTimeFormat(isEN()?'en-US':'es-EC',{timeZone:'UTC',weekday:'long',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(next)):'';
      return {open,preorder:!open&&h.allow_preorders===true&&!!nextLabel,next:nextLabel};
    }
    function storeHoursOpen(h){return storeHoursState(h).open;}
    function checkoutBlocked(){const s=storeHoursState(config.hours);return !s.open&&!s.preorder;}
    function preorderNote(){const s=storeHoursState(config.hours);return s.preorder?t('Pedido anticipado para la próxima apertura: {0}. Lo despachamos apenas abramos.',s.next):'';}

    /* ── CATEGORY STRIP ── */
    // Orden: config.category_order primero (el sync lo preserva), luego el resto. El sync
    // regenera config.categories alfabéticamente, así que sin esto Extras saldría antes.
    function orderedCategorySlugs(){
      const catMap=config.categories||{};
      const pref=Array.isArray(config.category_order)?config.category_order:[];
      const rest=Object.keys(catMap).filter(s=>!pref.includes(s));
      return [...pref.filter(s=>s in catMap),...rest];
    }
    function buildCatStrip(){
      const catMap=config.categories||{};
      categorySlugs=orderedCategorySlugs();
      // Opt-in: config.brand_filter={prefix,label} saca las categorías con ese prefijo de los chips
      // a un desplegable de marca entre el buscador y los chips. Sin config = no-op.
      // brand_filter.group_prefix: categorías-sección (p.ej. sistemas de una marca) sin chip propio.
      const bf=config.brand_filter,isBrand=s=>!!(bf&&bf.prefix&&s.startsWith(bf.prefix)),isGroup=s=>!!(bf&&bf.group_prefix&&s.startsWith(bf.group_prefix));
      const brands=categorySlugs.filter(isBrand);
      if(brands.length&&!document.getElementById('brandSelect')){
        $catStrip.insertAdjacentHTML('beforebegin',`<div class="brand-filter"><select id="brandSelect" aria-label="${esc(bf.label||t('Marca'))}"><option value="">${esc(bf.label||t('Todas las marcas'))}</option>${brands.map(s=>`<option value="${esc(s)}">${esc(catLabel(catMap[s]||s))}</option>`).join('')}</select></div>`);
        document.getElementById('brandSelect').addEventListener('change',e=>{activeBrand=e.target.value;renderCatalog();goTop();});
      }
      let html=`<button class="cat-chip active" data-cat="all"><span class="ic">🔥</span><span class="lb">${t('Todo')}</span></button>`;
      categorySlugs.filter(s=>!isBrand(s)&&!isGroup(s)).forEach(slug=>{
        const name=catMap[slug]||slug;
        html+=`<button class="cat-chip" data-cat="${slug}"><span class="ic">${catIcon(slug,name)}</span><span class="lb">${catLabel(name)}</span></button>`;
      });
      $catStrip.innerHTML=html;
      setupCatNav();
    }
    // Flechas del riel de categorías: se muestran SOLO si las categorías no caben
    // (típicamente móvil). Aditivo: en escritorio el riel cabe entero y no cambia nada.
    function setupCatNav(){
      const parent=$catStrip.parentElement;
      if(!parent||parent.classList.contains('cat-rail')) return;
      const rail=document.createElement('div');
      rail.className='cat-rail';
      parent.insertBefore(rail,$catStrip);
      rail.appendChild($catStrip);
      const arrow=(cls,dir,label,pts)=>
        `<button class="cat-nav ${cls}" type="button" aria-label="${label}" data-dir="${dir}">`+
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" `+
        `stroke-linecap="round" stroke-linejoin="round"><polyline points="${pts}"/></svg></button>`;
      rail.insertAdjacentHTML('afterbegin',arrow('prev',-1,t('Categorías anteriores'),'15 18 9 12 15 6'));
      rail.insertAdjacentHTML('beforeend',arrow('next',1,t('Más categorías'),'9 18 15 12 9 6'));
      const prev=rail.querySelector('.cat-nav.prev'),next=rail.querySelector('.cat-nav.next');
      const sync=()=>{
        const max=$catStrip.scrollWidth-$catStrip.clientWidth;
        rail.classList.toggle('cat-nav-on',max>8);
        prev.disabled=$catStrip.scrollLeft<=3;
        next.disabled=$catStrip.scrollLeft>=max-3;
      };
      rail.querySelectorAll('.cat-nav').forEach(b=>b.addEventListener('click',()=>{
        const step=Math.max(160,$catStrip.clientWidth*.7);
        $catStrip.scrollBy({left:+b.dataset.dir*step,behavior:'smooth'});
        setTimeout(sync,380);
      }));
      $catStrip.addEventListener('scroll',sync,{passive:true});
      window.addEventListener('resize',sync);
      sync();
    }
    function setActiveChip(cat){
      $catStrip.querySelectorAll('.cat-chip').forEach(c=>c.classList.toggle('active',c.dataset.cat===cat));
    }

    /* ── CARD TEMPLATE ── */
    function cardHTML(p,i){
      const imgs=getImages(p);
      const inCartQty=cartItems.filter(ci=>String(ci.id)===String(p.id)).reduce((s,ci)=>s+ci.qty,0);
      const hasVariants=Array.isArray(p.variantes)&&p.variantes.length>0;
      const stock=getStockInfo(p);
      const catLabels=config.categories||{};
      const imgHTML=imgs[0]?`<img src="${imgs[0]}" alt="${p.nombre}" loading="lazy"/>`:`<div class="card-img-placeholder">${catIcon((p.categorias||[])[0],p.nombre)}</div>`;
      const promo=promoPrice(p);
      const badgeHTML=(badgeCat()&&(p.categorias||[]).includes(badgeCat()))?`<span class="card-badge">${catLabels[badgeCat()]||badgeCat()}</span>`:(promo!==null?`<span class="card-badge">${t('Oferta')}</span>`:'');
      const stockBadgeHTML=stock.badge?`<span class="card-stock-badge ${stock.cls}">${stock.badge}</span>`:'';
      const imgCountHTML=imgs.length>1?`<span class="card-img-count"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>${imgs.length}</span>`:'';
      const priceDisplay=promo!==null?formatPrice(promo):(config.price_locale?formatPrice(parsePrice(p)):typeof p.precio==='number'?formatPrice(p.precio):(p.precio||''));
      return `
        <div class="card" data-id="${p.id}" style="animation-delay:${i*.04}s">
          <div class="card-img" data-open="${p.id}">
            ${imgHTML}${badgeHTML}${stockBadgeHTML}${imgCountHTML}
            <button class="fav-btn${isFav(p.id)?' active':''}" data-fav="${p.id}" aria-label="${t('Favorito')}">${isFav(p.id)?'♥':'♡'}</button>
          </div>
          <div class="card-body">
            <div class="card-name">${p.nombre}</div>
            ${p.descripcion?`<div class="card-desc">${p.descripcion}</div>`:''}
            <div class="card-foot">
              <div class="card-prices">
                <span class="card-price">${priceDisplay}</span>
                ${promo!==null?`<span class="card-promo">${formatPrice(parsePrice(p))}</span>`:''}
              </div>
              ${actionHTML(p,inCartQty,hasVariants,stock)}
            </div>
          </div>
        </div>`;
    }
    function actionHTML(p,inCartQty,hasVariants,stock){
      if(!hasVariants&&inCartQty>0){
        return `<div class="qty-control">
            <button data-action="dec" data-id="${p.id}" data-key="${esc(cartItems.filter(ci=>String(ci.id)===String(p.id)).pop()?.key??cartKey(p.id,{}))}">−</button>
            <span class="qty-val">${inCartQty}</span>
            <button data-action="inc" data-id="${p.id}" ${!stock.canAdd||inCartQty>=stock.maxQty?'disabled':''}>+</button>
          </div>`;
      }
      if(!hasVariants&&!stock.canAdd) return `<button class="btn-add" disabled>${t('Agotado')}</button>`;
      return `<button class="btn-add icon-only" ${hasVariants?`data-open="${p.id}"`:`data-add="${p.id}"`} aria-label="${hasVariants?t('Elegir opciones'):t('Agregar')}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>`;
    }

    /* ── PROMO BANNER (productos con tipo 'promocion' → banner clickeable → openModal) ── */
    // Aditivo: sin promos devuelve '' y el catálogo se ve idéntico al de siempre.
    function promoBannerHTML(){
      const promos=products.filter(p=>isPromo(p)&&promoActiveToday(p));
      if(!promos.length) return '';
      const full=config.promo_full_image; // arte ya diseñado: imagen entera, sin overlay del motor
      const ctaText=config.promo_cta_text||t('Ver oferta');
      const slides=promos.map(p=>{
        const img=getImages(p)[0]||'';
        if(full&&img) return `<div class="promo-slide full" data-open="${p.id}"><img src="${img}" alt="${p.nombre}" loading="lazy"></div>`;
        return `<div class="promo-slide${img?'':' no-img'}" data-open="${p.id}" ${img?`style="background-image:url('${img}')"`:''}>
          <div class="promo-shade"></div>
          <div class="promo-content">
            <div class="promo-title">${p.nombre}</div>
            <div class="promo-cta">${ctaText} <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="9 18 15 12 9 6"/></svg></div>
          </div>
        </div>`;
      }).join('');
      const dots=promos.length>1?`<div class="promo-dots" id="promoDots">${promos.map((_,i)=>`<button class="promo-dot${i===0?' active':''}" data-pidx="${i}" aria-label="Promo ${i+1}"></button>`).join('')}</div>`:'';
      return `<div class="promo-banner"><div class="promo-track" id="promoTrack">${slides}</div>${dots}</div>`;
    }
    let promoTimer,promoIdx=0;
    function setupPromoBanner(){
      clearInterval(promoTimer);
      const track=document.getElementById('promoTrack');
      if(!track) return;
      const n=track.children.length;promoIdx=0;
      const go=i=>{
        promoIdx=(i+n)%n;
        track.style.transform=`translateX(-${promoIdx*100}%)`;
        document.querySelectorAll('.promo-dot').forEach((d,k)=>d.classList.toggle('active',k===promoIdx));
      };
      document.getElementById('promoDots')?.addEventListener('click',e=>{const d=e.target.closest('.promo-dot');if(d)go(+d.dataset.pidx);});
      let sx=0;
      track.addEventListener('touchstart',e=>sx=e.changedTouches[0].clientX,{passive:true});
      track.addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-sx;if(Math.abs(dx)>40)go(dx<0?promoIdx+1:promoIdx-1);});
      if(n>1) promoTimer=setInterval(()=>go(promoIdx+1),7000);
    }

    /* ── RENDER CATALOG ── */
    function matchSearch(p){
      return !searchQuery||normalize(p.nombre).includes(searchQuery)||normalize(p.descripcion||'').includes(searchQuery);
    }
    function renderFlat(list,title,em,emptyMsg){
      if(!list.length){$catalog.innerHTML=`<div class="empty-state"><span class="em">${em}</span><p>${emptyMsg}</p></div>`;return;}
      $catalog.innerHTML=`<div class="cat-section"><h2 class="cat-header"><span class="em">${em}</span>${title}</h2><div class="grid">${list.map((p,i)=>cardHTML(p,i)).join('')}</div></div>`;
    }
    function renderCatalog(){
      document.body.classList.remove('location-view');
      if(activeFilter==='__favs__'){
        setActiveChip(null);
        renderFlat(products.filter(p=>isFav(p.id)&&matchSearch(p)),t('Tus Favoritos'),'❤️',t('No tienes favoritos aún.'),'Toca el ♡ en cualquier producto para guardarlo.');
        return;
      }
      if(activeFilter==='__offers__'){
        setActiveChip(null);
        // Ofertas: TODAS las promos (el gate de día solo aplica al banner) + productos con precio_promo.
        renderFlat(products.filter(p=>(isPromo(p)||isOffer(p))&&matchSearch(p)),t('Ofertas'),'🏷️',t('No hay ofertas activas ahora mismo.'));
        return;
      }

      const filtered=products.filter(p=>{
        if(isPromo(p)) return false; // promos van solo en el banner, no en el grid
        const matchCat=activeFilter==='all'||(p.categorias||[]).includes(activeFilter);
        const matchBrand=!activeBrand||(p.categorias||[]).includes(activeBrand);
        return matchCat&&matchBrand&&matchSearch(p);
      });
      const groups={};
      // Sección = primera categoría group_prefix si existe; si no, la primera que SEA sección del menú
      // (el sync ordena categorias alfabéticamente: un badge tipo 'chef'/'favorito' quedaba primero y ocultaba el producto).
      const gp=(config.brand_filter||{}).group_prefix,cs=p=>p.categorias||[];
      filtered.forEach(p=>{const c=(gp&&cs(p).find(s=>s.startsWith(gp)))||cs(p).find(s=>categorySlugs.includes(s))||cs(p)[0]||'';(groups[c]=groups[c]||[]).push(p);});

      const catLabels=config.categories||{};
      // Banner de promos: solo en la vista 'all' sin búsqueda (como el hero de la referencia).
      let html=(activeFilter==='all'&&!searchQuery)?promoBannerHTML():'';
      categorySlugs.forEach(cat=>{
        const inCat=groups[cat]||[];
        if(!inCat.length) return;
        html+=`<div class="cat-section" id="cat-${cat}">
          <h2 class="cat-header"><span class="em">${catIcon(cat,catLabels[cat])}</span>${catLabel(catLabels[cat])||cat}</h2>
          <div class="grid">${inCat.map((p,i)=>cardHTML(p,i)).join('')}</div>
        </div>`;
      });
      $catalog.innerHTML=html||`<div class="empty-state"><span class="em">🔍</span><p>${t('No se encontraron productos')}</p></div>`;
      setActiveChip(activeFilter);
      setupPromoBanner();
      setupIntersectionObserver();
    }

    // ¿El negocio ofrece reservas? El motor no lo asume: se activa/desactiva por config
    // (`location.reserva`), igual que el resto de la personalización por cliente. Sin valor
    // explícito: restaurantes sí, tiendas (store_mode) no.
    const reservasActivas=()=>(config.location||{}).reserva??!config.store_mode;
    function renderLocation(){
      document.body.classList.add('location-view');
      if(observer) observer.disconnect();
      const sedes=(config.location&&config.location.sedes)||[];
      const wa=config.location&&config.location.telefono_principal||config.whatsapp_number||'';
      const waNum=wa.replace(/\D/g,'');
      const social=config.social||{};

      const sedeCard=(s,extra='')=>`
        <div class="sede-card${extra}">
          <div class="sede-name">${s.nombre}</div>
          <div class="sede-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1116 0z"/><circle cx="12" cy="10" r="2.5"/></svg>
            <span>${s.direccion}</span>
          </div>
          ${s.telefono?`<div class="sede-row">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.67A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14.92v2z"/></svg>
            <a href="tel:${s.telefono}">${s.telefono}</a>
          </div>`:''}
          ${waNum?`<div class="sede-row">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            <a href="https://wa.me/${waNum}" target="_blank">+${waNum}</a>
          </div>`:''}
        </div>`;

      // Pair into rows; last one centered if odd
      const pairs=[];
      for(let i=0;i<sedes.length;i+=2) pairs.push(sedes.slice(i,i+2));

      const sedesHTML=pairs.map(pair=>{
        if(pair.length===2) return `<div class="sede-card" style="display:contents">${sedeCard(pair[0])}${sedeCard(pair[1])}</div>`;
        return sedeCard(pair[0],' full');
      }).join('');

      // Actually render all as flat grid items
      const allCards=sedes.map((s,i)=>i===sedes.length-1&&sedes.length%2!==0?sedeCard(s,' full'):sedeCard(s)).join('');

      const socialHTML=(social.facebook||social.instagram||social.tiktok)?`
        <div class="social-section">
          <div class="social-title">${t('Síguenos')}</div>
          <div class="social-strip">
            ${social.facebook?`<a class="social-btn" href="${social.facebook}" target="_blank" rel="noopener" aria-label="Facebook">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>
            </a>`:''}
            ${social.instagram?`<a class="social-btn" href="${social.instagram}" target="_blank" rel="noopener" aria-label="Instagram">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>
            </a>`:''}
            ${social.tiktok?`<a class="social-btn" href="${social.tiktok}" target="_blank" rel="noopener" aria-label="TikTok">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.33 6.33 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.27 8.27 0 004.84 1.55V6.8a4.85 4.85 0 01-1.07-.11z"/></svg>
            </a>`:''}
          </div>
        </div>`:'';

      const mapEmbed=config.location&&config.location.map_embed;
      const mapHTML=mapEmbed?`<div class="location-map"><iframe src="${mapEmbed}" style="border:0" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" title="${t('Ubicación')}"></iframe></div>`:'';

      // Copy de la vista de ubicación: SIEMPRE desde config. El motor es el esqueleto y no
      // lleva texto de ningún cliente; los defaults son genéricos y `location_intro` es el
      // campo de marca que escribe el onboarding. Una clave vacía omite el elemento.
      const locCfg=config.location||{};
      const locHeading=locCfg.heading!==undefined?locCfg.heading:t('📍 Nuestra Ubicación');
      const locIntro=locCfg.intro!==undefined?locCfg.intro:(config.location_intro||'');
      const resTitulo=locCfg.reserva_titulo||t('📅 Haz una reserva');
      const resSub=locCfg.reserva_sub||t('Cuéntanos cuándo vienes y te confirmamos por WhatsApp');
      const reservasOn=reservasActivas();

      $catalog.innerHTML=`
        <section class="location-view-wrap">
          <div class="location-heading">
            ${locHeading?`<h2>${locHeading}</h2>`:''}
            ${locIntro?`<p>${locIntro}</p>`:''}
          </div>
          <div class="sedes-grid">${allCards}</div>
          ${mapHTML}
          ${socialHTML}
          ${reservasOn?`<div class="location-reserve">
            <h3 class="reserve-heading">${resTitulo}</h3>
            <p class="reserve-subheading">${resSub}</p>
            ${reservationFormHTML()}
          </div>`:''}
        </section>`;
      const reserveEl=$catalog.querySelector('.location-reserve');
      if(reserveEl) setupReserveForm(reserveEl);
    }

    function updateCardButtons(){
      document.querySelectorAll('.card').forEach(card=>{
        const id=card.dataset.id,p=products.find(x=>String(x.id)===String(id));
        if(!p) return;
        const inCartQty=cartItems.filter(ci=>String(ci.id)===String(id)).reduce((s,ci)=>s+ci.qty,0);
        const hasVariants=Array.isArray(p.variantes)&&p.variantes.length>0;
        const foot=card.querySelector('.card-foot');if(!foot) return;
        const actionEl=foot.querySelector('.btn-add,.qty-control');
        if(actionEl) actionEl.outerHTML=actionHTML(p,inCartQty,hasVariants,getStockInfo(p));
      });
    }

    /* ── INTERSECTION OBSERVER (sync chip while scrolling in 'all') ── */
    let observer;
    function setupIntersectionObserver(){
      if(observer) observer.disconnect();
      if(activeFilter!=='all'&&activeFilter!=='__none__') return;
      observer=new IntersectionObserver(entries=>{
        entries.forEach(e=>{if(e.isIntersecting) setActiveChip(e.target.id.replace('cat-',''));});
      },{rootMargin:'-25% 0px -65% 0px',threshold:0});
      document.querySelectorAll('.cat-section').forEach(s=>observer.observe(s));
    }

    /* ── PRODUCT MODAL ── */
    function openModal(id){
      const p=products.find(x=>String(x.id)===String(id));if(!p) return;
      track('ViewContent',{contents:[{id:p.id,nombre:p.nombre,precio:getEffectivePrice(p)}]});
      modalProduct=p;modalQty=1;modalVariants={};modalDist={};modalRepeat={};modalCombo={};modalNote='';sliderImages=getImages(p);sliderIdx=0;
      $sliderTrack.innerHTML=sliderImages.length
        ?sliderImages.map(src=>`<div class="slider-slide"><img src="${src}" alt="${p.nombre}" loading="lazy"/></div>`).join('')
        :`<div class="slider-slide"><span class="slider-placeholder">${catIcon((p.categorias||[])[0],p.nombre)}</span></div>`;
      $sliderTrack.style.transform='translateX(0)';
      $sliderDots.innerHTML=sliderImages.length>1?sliderImages.map((_,i)=>`<button class="slider-dot${i===0?' active':''}" data-idx="${i}"></button>`).join(''):'';
      $sliderPrev.hidden=$sliderNext.hidden=sliderImages.length<=1;
      $modalFav.dataset.fav=p.id;$modalFav.classList.toggle('active',isFav(p.id));$modalFav.textContent=isFav(p.id)?'♥':'♡';
      renderModalDetail();
      $modalOverlay.classList.add('open');document.body.style.overflow='hidden';
    }
    // Variante-plantilla (repeat) que se clona N veces según la opción de combo elegida.
    // N = "salsas" de la opción seleccionada en cualquier variante no-repeat. null si el
    // producto no usa el mecanismo (retrocompatible: productos normales pasan por aquí sin efecto).
    function repeatInfo(p){
      if(!Array.isArray(p.variantes)) return null;
      const ri=p.variantes.findIndex(v=>v&&v.repeat);
      if(ri<0) return null;
      let n=0;
      for(let i=0;i<p.variantes.length;i++){
        if(i===ri) continue;
        const sel=modalVariants[i];if(sel===undefined) continue;
        const opt=(p.variantes[i].options||[]).find(o=>getOptionKey(o)===sel);
        if(opt&&typeof opt==='object'&&typeof opt.salsas==='number') n=opt.salsas;
      }
      return {ri,n,group:p.variantes[ri]};
    }
    function renderModalDetail(){
      const p=modalProduct;
      const hasVariants=Array.isArray(p.variantes)&&p.variantes.length>0;
      const stock=getStockInfo(p);
      const dist=distGroup(p);
      const distSum=dist?dist.group.options.reduce((s,o)=>s+(modalDist[getOptionKey(o)]||0),0):0;
      const rep=repeatInfo(p);
      if(rep) Object.keys(modalRepeat).forEach(k=>{if(+k>=rep.n) delete modalRepeat[k];}); // recorta si baja N
      const combo=comboInfo(p);
      const comboMap=()=>{const m={};if(combo)for(let k=0;k<combo.pick;k++)if(modalCombo[k])m['c'+k]=modalCombo[k];return m;};
      const staticOK=!hasVariants||p.variantes.every((g,i)=>(rep&&i===rep.ri)||g.optional||modalVariants[i]);
      const repeatOK=!rep||rep.n===0||Array.from({length:rep.n}).every((_,k)=>modalRepeat[k]);
      const comboOK=!combo||Array.from({length:combo.pick}).every((_,k)=>modalCombo[k]);
      const allSelected=!hasVariants||(dist?distSum===dist.total:(combo?comboOK:staticOK&&repeatOK));
      // El combo muestra precio parcial (suma-menos-baratas) según lo ya elegido.
      const effPrice=combo?getEffectivePrice(p,comboMap()):(dist?basePrice(p)+distDeltaOf(dist.group,modalDist):(allSelected?getEffectivePrice(p,modalVariants):basePrice(p)));
      const canAddModal=stock.canAdd&&allSelected;

      let variantHTML='';
      if(dist){
        const glabel=`<div class="variant-glabel">${dist.group.name||t('Sabores')} — ${distSum}/${dist.total}</div>`;
        // Grupos reutilizables (pick>0) → pills (tap +1 repetible, badge ×N, "−" para quitar).
        // distribute legacy inline → steppers (BW intacto hasta migrar).
        if(dist.group.pick>0){
          variantHTML=`<div class="customize-label">${t('Personaliza')}</div>`+
            `<div class="variant-group">${glabel}<div class="variant-options">`+
            dist.group.options.map(opt=>{
              const k=getOptionKey(opt),c=modalDist[k]||0;
              return `<button class="variant-option dist-pill${c>0?' selected':''}" data-dopt="${k}" ${(distSum>=dist.total&&c<=0)?'disabled':''}>`+
                `<span>${getOptionDisplay(opt)}</span>`+
                (c>0?`<span class="dist-badge">×${c}</span><span class="dist-dec" data-dopt="${k}">−</span>`:'')+
              `</button>`;
            }).join('')+`</div></div>`;
        } else {
          variantHTML=`<div class="customize-label">${t('Personaliza')}</div>`+
            `<div class="variant-group">${glabel}`+
            dist.group.options.map(opt=>{
              const k=getOptionKey(opt),c=modalDist[k]||0;
              return `<div class="dist-row"><span class="dist-name">${getOptionDisplay(opt)}</span>
                <div class="modal-qty dist-ctrl">
                  <button class="dist-btn" data-dopt="${k}" data-dd="-1" ${c<=0?'disabled':''}>−</button>
                  <span class="qty-val">${c}</span>
                  <button class="dist-btn" data-dopt="${k}" data-dd="1" ${distSum>=dist.total?'disabled':''}>+</button>
                </div></div>`;
            }).join('')+`</div>`;
        }
      } else if(hasVariants){
        // opt.label already has price embedded (from processVariants price_select) — don't add it again
        const optLabel=opt=>{const d=getOptionDisplay(opt),pr=getOptionPrice(opt);return(pr!==null&&typeof opt==='string')?`${d} (${formatPrice(pr)})`:d;};
        // Renderiza un grupo de opciones: select si >4, botones si no. `attr` cablea el estado
        // (data-group-idx para variantes normales, data-repeat-k para las clonadas).
        const groupHTML=(glabel,attr,options,cur)=>options.length>4
          ?`<div class="variant-group"><div class="variant-glabel">${glabel}</div>
              <select class="variant-select" ${attr}>
                <option value="">${t('— Elige una opción —')}</option>
                ${options.map(opt=>{const k=getOptionKey(opt);return`<option value="${k}"${cur===k?' selected':''}>${optLabel(opt)}</option>`;}).join('')}
              </select></div>`
          :`<div class="variant-group"><div class="variant-glabel">${glabel}</div>
              <div class="variant-options">
                ${options.map(opt=>{const oKey=getOptionKey(opt);return`<button class="variant-option${cur===oKey?' selected':''}" ${attr} data-opt="${oKey}">${optLabel(opt)}</button>`;}).join('')}
              </div></div>`;
        if(combo){
          let comboHTML='';
          for(let k=0;k<combo.pick;k++) comboHTML+=groupHTML(`${combo.item} ${k+1}`,`data-combo-k="${k}"`,combo.g.options,modalCombo[k]||'');
          variantHTML=`<div class="customize-label">${t('Personaliza')}</div>`+comboHTML;
        } else {
        const staticHTML=p.variantes.map((g,idx)=>
          (rep&&idx===rep.ri)?'':groupHTML(g.name||t('Opciones'),`data-group-idx="${idx}"`,g.options,modalVariants[idx]||'')
        ).join('');
        // Selectores clonados de la plantilla (rep.n copias, "Salsa 1..N").
        let repeatHTML='';
        if(rep&&rep.n>0){
          const base=rep.group.name||t('Salsa');
          for(let k=0;k<rep.n;k++) repeatHTML+=groupHTML(`${base} ${k+1}`,`data-repeat-k="${k}"`,rep.group.options,modalRepeat[k]||'');
        }
        variantHTML=`<div class="customize-label">${t('Personaliza')}</div>`+staticHTML+repeatHTML;
        }
      }

      $modalDetail.innerHTML=`
        <div class="modal-name">${p.nombre}</div>
        <div class="modal-prices">
          <div class="modal-price">${formatPrice(effPrice)}</div>
          ${promoPrice(p)!==null&&effPrice===basePrice(p)?`<div class="modal-promo">${formatPrice(parsePrice(p))}</div>`:''}
        </div>
        ${stock.badge?`<div><span class="modal-stock-badge ${stock.cls}">${stock.badge}</span></div>`:''}
        ${p.descripcion?`<div class="modal-desc">${p.descripcion}</div>`:''}
        ${variantHTML}
        ${hasVariants&&!allSelected?`<p class="modal-variant-hint">${dist?t('Reparte {0} — faltan {1}',dist.total,dist.total-distSum):(combo?t('Elige {0} {1}s',combo.pick,combo.item.toLowerCase()):t('Selecciona todas las opciones'))}</p>`:''}
        ${!stock.canAdd&&allSelected?`<p class="modal-stock-hint">${t('Producto agotado')}</p>`:''}
        <div class="form-field"><textarea id="modalNote" rows="2" maxlength="140" aria-label="${t('Nota para este producto')}" placeholder="${t(config.store_mode?'Nota (opcional): sabor preferido, indicaciones…':'Nota (opcional): sin cebolla, huevo revuelto…')}">${esc(modalNote)}</textarea></div>
        <div class="modal-actions">
          <div class="modal-qty">
            <button id="mqDec">−</button>
            <span class="qty-val" id="mqVal">${modalQty}</span>
            <button id="mqInc" ${!stock.canAdd||modalQty>=stock.maxQty?'disabled':''}>+</button>
          </div>
          <button class="btn-modal-add" id="btnModalAdd" ${!canAddModal?'disabled':''}>
            ${stock.canAdd?`${t('Agregar')} · ${formatPrice(effPrice*modalQty)}`:t('Agotado')}
          </button>
        </div>`;

      document.getElementById('modalNote').addEventListener('input',e=>{modalNote=e.target.value;});
      document.getElementById('mqDec').addEventListener('click',()=>{if(modalQty>1){modalQty--;renderModalDetail();}});
      document.getElementById('mqInc').addEventListener('click',()=>{
        if(modalQty>=stock.maxQty){showToast(t('Stock insuficiente'));return;}
        modalQty++;renderModalDetail();
      });
      document.getElementById('btnModalAdd').addEventListener('click',()=>{
        let v=modalVariants;
        if(dist){
          const label=dist.group.options.filter(o=>modalDist[getOptionKey(o)]>0)
            .map(o=>`${getOptionDisplay(o)} x${modalDist[getOptionKey(o)]}`).join(' · ');
          v={[dist.group.name]:{label,price:basePrice(p)+distDeltaOf(dist.group,modalDist)}};
        } else if(rep&&rep.n>0){
          v=Object.assign({},modalVariants);
          const base=rep.group.name||t('Salsa');
          for(let k=0;k<rep.n;k++) v['r'+k]=`${base} ${k+1}: ${modalRepeat[k]}`;
        } else if(combo){
          v={};for(let k=0;k<combo.pick;k++) v['c'+k]=modalCombo[k];
        }
        cartAdd(modalProduct.id,v,modalQty,modalNote.trim());closeModal();
      });
      $modalDetail.querySelectorAll('.dist-pill').forEach(btn=>btn.addEventListener('click',e=>{
        const k=btn.dataset.dopt,cur=modalDist[k]||0;
        if(e.target.closest('.dist-dec')){if(cur>0)modalDist[k]=cur-1;}
        else if(distSum<dist.total)modalDist[k]=cur+1;
        renderModalDetail();
      }));
      $modalDetail.querySelectorAll('.dist-btn').forEach(btn=>btn.addEventListener('click',()=>{
        const k=btn.dataset.dopt,dd=+btn.dataset.dd,next=(modalDist[k]||0)+dd;
        if(next<0||(dd>0&&distSum>=dist.total)) return;
        modalDist[k]=next;renderModalDetail();
      }));
      $modalDetail.querySelectorAll('.variant-option').forEach(btn=>{
        btn.addEventListener('click',()=>{
          if(btn.classList.contains('dist-pill'))return; // pills de distribute: manejadas arriba
          const opt=btn.dataset.opt;
          if(btn.dataset.comboK!==undefined){
            const k=+btn.dataset.comboK;
            if(modalCombo[k]===opt) delete modalCombo[k]; else modalCombo[k]=opt;
            renderModalDetail();return;
          }
          if(btn.dataset.repeatK!==undefined){
            const k=+btn.dataset.repeatK;
            if(modalRepeat[k]===opt) delete modalRepeat[k]; else modalRepeat[k]=opt;
            renderModalDetail();return;
          }
          const idx=+btn.dataset.groupIdx;
          if(modalVariants[idx]===opt) delete modalVariants[idx];
          else{
            modalVariants[idx]=opt;
            const _o=((modalProduct.variantes[idx]||{}).options||[]).find(o=>getOptionKey(o)===opt);
            if(_o&&_o.image){const _i=sliderImages.indexOf(_o.image);if(_i>=0)slideTo(_i);}
          }
          renderModalDetail();
        });
      });
      $modalDetail.querySelectorAll('.variant-select').forEach(sel=>{
        sel.addEventListener('change',()=>{
          if(sel.dataset.comboK!==undefined){
            const k=+sel.dataset.comboK;
            if(sel.value) modalCombo[k]=sel.value; else delete modalCombo[k];
            renderModalDetail();return;
          }
          if(sel.dataset.repeatK!==undefined){
            const k=+sel.dataset.repeatK;
            if(sel.value) modalRepeat[k]=sel.value; else delete modalRepeat[k];
            renderModalDetail();return;
          }
          const idx=+sel.dataset.groupIdx;
          if(sel.value) modalVariants[idx]=sel.value; else delete modalVariants[idx];
          renderModalDetail();
        });
      });
    }
    function closeModal(){$modalOverlay.classList.remove('open');document.body.style.overflow='';modalProduct=null;}

    /* ── SLIDER ── */
    function slideTo(idx){
      if(sliderImages.length<=1) return;
      sliderIdx=Math.max(0,Math.min(idx,sliderImages.length-1));
      $sliderTrack.style.transform=`translateX(-${sliderIdx*100}%)`;
      $sliderDots.querySelectorAll('.slider-dot').forEach((d,i)=>d.classList.toggle('active',i===sliderIdx));
    }
    $sliderPrev.addEventListener('click',e=>{e.stopPropagation();slideTo(sliderIdx-1);});
    $sliderNext.addEventListener('click',e=>{e.stopPropagation();slideTo(sliderIdx+1);});
    $sliderDots.addEventListener('click',e=>{const d=e.target.closest('.slider-dot');if(d) slideTo(Number(d.dataset.idx));});
    let touchStartX=0;
    const $sw=document.getElementById('sliderWrap');
    $sw.addEventListener('touchstart',e=>{touchStartX=e.changedTouches[0].clientX;},{passive:true});
    $sw.addEventListener('touchend',e=>{const dx=e.changedTouches[0].clientX-touchStartX;if(Math.abs(dx)>40) slideTo(dx<0?sliderIdx+1:sliderIdx-1);});

    /* ── CART UI ── */
    function updateCartUI(){
      const qty=cartTotalQty(),fee=feesTotal(currentMode()),total=cartTotalPrice()+fee;
      $navBadge.textContent=qty;$navBadge.classList.toggle('show',qty>0);
      $peekCount.textContent=qty;$peekTotal.textContent=formatPrice(total);
      const sheetOpen=$cartDrawer.classList.contains('open');
      $cartPeek.classList.toggle('show',qty>0&&!sheetOpen);
      $cartTotal.textContent=formatPrice(total);
      $cartItemCount.textContent=t('{0} item(s) · {1} producto(s)',qty,cartItems.length);
      $btnCheckout.disabled=qty===0||storeClosed;

      // Líneas de recargos (empaque/envío) en el footer (creadas al vuelo; el HTML del cliente no las trae).
      let feeLine=document.getElementById('cartFeeLine');
      const footer=$cartTotal.closest('.cart-footer');
      if(fee>0&&qty>0){
        if(!feeLine&&footer){feeLine=document.createElement('div');feeLine.id='cartFeeLine';footer.insertBefore(feeLine,footer.firstChild);}
        if(feeLine) feeLine.innerHTML=orderFees(currentMode()).map(([l,v])=>`<div class="cart-fee"><span>${l}</span><span>${formatPrice(v)}</span></div>`).join('');
      }else if(feeLine){feeLine.remove();}

      renderCrossSell();

      if(!cartItems.length){
        $cartItems.innerHTML=`<div class="cart-empty"><span class="em">🛒</span><p>${t('Tu pedido está vacío')}</p></div>`;
        return;
      }
      $cartItems.innerHTML=cartItems.map(item=>{
        const vLabel=variantLabel(item.variantes);
        return `<div class="cart-item">
          ${item.imagen?`<img src="${item.imagen}" alt="${item.nombre}" loading="lazy"/>`:`<div class="ph">${phIcon()}</div>`}
          <div class="cart-item-info">
            <div class="cart-item-name">${item.nombre}</div>
            ${vLabel?`<div class="cart-item-variant">${vLabel}</div>`:''}
            ${item.nota?`<div class="cart-item-variant">📝 ${esc(item.nota)}</div>`:''}
            <div class="cart-item-detail">${item.qty} × ${formatPrice(item.precio)} = ${formatPrice(item.precio*item.qty)}</div>
          </div>
          <button class="cart-item-remove" data-key="${esc(item.key)}" title="${t('Quitar')}">✕</button>
        </div>`;
      }).join('');
    }

    /* ── CROSS-SELL (opt-in por config.cross_sell; tira de sugeridos en el carrito) ──
       {categories:[slug],title,max}. Muestra productos de esas categorías que no estén ya
       en el carrito ni agotados. Tap: simple → agrega; con variantes → abre el modal. */
    function renderCrossSell(){
      const cfg=config.cross_sell,cats=cfg&&Array.isArray(cfg.categories)?cfg.categories:[];
      let box=document.getElementById('crossSell');
      const footer=$cartTotal.closest('.cart-footer');
      if(!cats.length||!cartItems.length||!footer){ if(box) box.remove(); return; }
      const inCart=new Set(cartItems.map(ci=>String(ci.id)));
      const pool=products.filter(p=>(p.categorias||[]).some(c=>cats.includes(c))&&!inCart.has(String(p.id))&&getStockInfo(p).canAdd);
      const items=pool.slice(0,cfg.max||6);
      if(!items.length){ if(box) box.remove(); return; }
      if(!box){ box=document.createElement('div');box.id='crossSell';box.className='cross-sell';footer.parentNode.insertBefore(box,footer); }
      box.innerHTML=`<div class="cross-sell-title">${cfg.title||t('¿Algo más?')}</div><div class="cross-sell-strip">`+
        items.map(p=>{
          const hasV=Array.isArray(p.variantes)&&p.variantes.length>0,img=getImages(p)[0];
          const price=promoPrice(p)!==null?formatPrice(basePrice(p)):typeof p.precio==='number'?formatPrice(p.precio):(p.precio||'');
          return `<button class="xs-card" ${hasV?`data-open="${p.id}"`:`data-add="${p.id}"`} aria-label="${t('Agregar')} ${p.nombre}">
            ${img?`<img src="${img}" alt="${p.nombre}" loading="lazy"/>`:`<div class="xs-ph">${phIcon()}</div>`}
            <div class="xs-name">${p.nombre}</div>
            <div class="xs-foot"><span class="xs-price">${price}</span><span class="xs-add">+</span></div>
          </button>`;
        }).join('')+`</div>`;
    }
    function openCart(){$cartOverlay.classList.add('open');$cartDrawer.classList.add('open');document.body.style.overflow='hidden';setActiveNav('cart');$cartPeek.classList.remove('show');}
    function closeCart(){clearOrderPoll();$cartOverlay.classList.remove('open');$cartDrawer.classList.remove('open');document.body.style.overflow='';syncNavToFilter();updateCartUI();goToStep1();}

    /* ── CHECKOUT STEPS ── */
    function goToStep1(){
      $cartItems.style.display='';
      document.querySelector('.cart-footer').style.display='';
      const step=document.getElementById('cartStep2');
      step.style.display='none';
      document.getElementById('tableOrderReceipt')?.remove();
      document.getElementById('webOrderReceipt')?.remove();
      clearOrderPoll();
      step.querySelector('.step2-body').style.display='';
      step.querySelector('.step2-footer').style.display='';
      document.getElementById('cartTitle').textContent=t('Tu Pedido');
      document.getElementById('cartBack').style.display='none';
    }
    function goToStep2(){
      if(!cartItems.length) return;
      if(checkoutBlocked()){showToast((config.hours&&config.hours.closed_msg)||t('Estamos cerrados ahora'));return;}
      track('InitiateCheckout',{contents:cartItems});
      $cartItems.style.display='none';
      document.querySelector('.cart-footer').style.display='none';
      const step=document.getElementById('cartStep2');
      step.style.display='flex';
      // Un recibo previo no debe tapar el formulario si el cliente vuelve a pedir.
      document.getElementById('webOrderReceipt')?.remove();
      clearOrderPoll();
      step.querySelector('.step2-body').style.display='';
      step.querySelector('.step2-footer').style.display='';
      document.getElementById('cartTitle').textContent=t('Datos de entrega');
      let notice=document.getElementById('preorderNotice');
      if(!notice){notice=document.createElement('p');notice.id='preorderNotice';step.prepend(notice);}
      notice.textContent=preorderNote();
      document.getElementById('cartBack').style.display='';
      syncTableMode();
    }

    // Solo el shell edge habilita comandas; los índices legacy conservan su checkout sin cambios.
    const tableModeAvailable=()=>!!window.__CONFIG__;
    function syncTableMode(){
      const table=document.getElementById('fieldTable');
      if(!table)return;
      const inTable=currentMode()==='mesa';
      table.closest('.form-field').style.display=inTable?'':'none';
      const phone=document.getElementById('fieldPhone');
      const label=phone.closest('.form-field').querySelector('label');
      label.textContent=inTable?t('Teléfono (opcional)'):t('Teléfono');
    }
    function renderTableField(){
      // Con checkout nativo el pedido web no es de mesa; el mesero conserva su flujo propio.
      if(!tableModeAvailable()||checkoutOrders(config)||document.getElementById('fieldTable'))return;
      const anchor=document.getElementById('fieldAddressWrap');
      const wrap=document.createElement('div');wrap.className='form-field';
      const label=document.createElement('label');label.textContent=t('Número de mesa (opcional)');
      const input=document.createElement('input');input.id='fieldTable';input.type='text';input.maxLength=10;
      input.autocomplete='off';input.setAttribute('aria-label',t('Número de mesa (opcional)'));
      wrap.append(label,input);anchor.before(wrap);
      syncTableMode();
    }
    function tableOrderPayload({name,phone,tableNo,items,total,currency}){
      if(!tableOrderId)tableOrderId=crypto.randomUUID();
      return {order_id:tableOrderId,items,total,currency,client_name:name,
        client_phone:phone||undefined,table_no:tableNo||undefined};
    }
    async function sendTableOrder(payload){
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetch('/panel/o/mesa',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify(payload),signal:controller.signal});
        const receipt=await response.json().catch(()=>null);
        if(response.status===403&&receipt?.error==='mesas_apagadas')return null;
        const accepted=response.status===200||response.status===201;
        if(!accepted||!receipt||!receipt.id||!Number.isSafeInteger(receipt.number)||receipt.number<1)throw new Error('mesa');
        return receipt;
      }finally{clearTimeout(timeout);}
    }
    function showTableReceipt(receipt){
      const step=document.getElementById('cartStep2');
      step.querySelector('.step2-body').style.display='none';
      step.querySelector('.step2-footer').style.display='none';
      const box=document.createElement('section');box.id='tableOrderReceipt';box.setAttribute('role','status');
      const title=document.createElement('strong');title.textContent=t('Pedido #{0} enviado',receipt.number);
      const note=document.createElement('p');note.textContent=t('Avísale a tu mesero que ya hiciste tu pedido');
      const done=document.createElement('button');done.type='button';done.className='btn-next';done.textContent=t('Listo');
      done.addEventListener('click',closeCart);box.append(title,note,done);step.append(box);
    }

    /* ── CAMPOS EXTRA DEL CHECKOUT (opt-in, config.checkout_fields) ── */
    // [{id,label,required?,placeholder?,type?}] → inputs antes de la dirección; el valor viaja solo en el
    // mensaje de WhatsApp. ponytail: sin persistir en craft-crm; agregar al payload si un cliente lo necesita en el CRM.
    function renderExtraFields(){
      const fields=Array.isArray(config.checkout_fields)?config.checkout_fields:[];
      const anchor=document.getElementById('fieldAddressWrap');
      fields.forEach(f=>{
        if(!f||!f.id||!f.label)return;
        const wrap=document.createElement('div');wrap.className='form-field';
        const label=document.createElement('label');label.textContent=f.label+(f.required?' *':'');
        const input=document.createElement('input');input.id='fieldX_'+f.id;input.type=f.type||'text';
        input.placeholder=f.placeholder||'';input.dataset.label=f.label;if(f.required)input.dataset.required='1';
        wrap.append(label,input);anchor.before(wrap);
      });
    }
    function extraFieldValues(){
      const out=[];
      for(const el of document.querySelectorAll('[id^="fieldX_"]')){
        const v=el.value.trim();
        if(!v&&el.dataset.required){showToast(t('Completa: {0}',el.dataset.label));el.focus();return null;}
        if(v)out.push([el.dataset.label,v]);
      }
      return out;
    }

    /* ── CHECKOUT NATIVO (opt-in config.checkout_orders) ── */
    // Pedido web al panel con sede, datos fiscales obligatorios, recibo /gracias y polling.
    // Sin WhatsApp en el flujo de pedido: el local avisa manualmente cuando está listo.
    // El servidor recalcula precios; aquí solo se envían product_id, qty, variante y nota.
    const SEDE_KEY='menu_sede';
    const ORDER_KEY_PREFIX='craft_pos_order:';
    const ORDER_RECORD_PREFIX='munch_order:';
    const LAST_ORDER_KEY='munch_last_order';
    const FIELD_IDS={name:'fieldName',phone:'fieldPhone',document_type:'fieldDocType',
      document_number:'fieldDocNumber',email:'fieldEmail',address:'fieldBillingAddress'};
    let orderPollTimer=null,orderStorageKey='';
    let thanksTimer=null,thanksRecord=null,thanksCheckout=null,thanksBusy=false,thanksError='',thanksBound=false;
    function readSede(){try{return sessionStorage.getItem(SEDE_KEY)||'';}catch(e){return '';}}
    function writeSede(id){try{if(id)sessionStorage.setItem(SEDE_KEY,id);else sessionStorage.removeItem(SEDE_KEY);}catch(e){}}
    function renderSedeField(){
      if(!checkoutOrders(config)) return;
      const sedes=sedeList(config);
      if(sedes.length<2||sedeFromQuery(config,location.search)||document.getElementById('fieldSede')) return;
      const body=document.querySelector('#cartStep2 .step2-body');
      if(!body) return;
      const wrap=document.createElement('div');wrap.className='form-field';
      const label=document.createElement('label');label.textContent=t('¿En qué food truck?');
      const select=document.createElement('select');select.id='fieldSede';
      const blank=document.createElement('option');blank.value='';blank.textContent=t('Selecciona tu food truck');
      select.append(blank);
      sedes.forEach(sede=>{
        const option=document.createElement('option');option.value=sede.id;
        option.textContent=sede.direccion&&sede.direccion!=='Por confirmar'?`${sede.nombre} — ${sede.direccion}`:sede.nombre;
        select.append(option);
      });
      select.value=defaultSede(sedes,sedeFromQuery(config,location.search),readSede());
      select.addEventListener('change',()=>writeSede(select.value));
      wrap.append(label,select);
      const anchor=document.getElementById('fieldName')?.closest('.form-field');
      if(anchor) anchor.before(wrap); else body.prepend(wrap);
    }
    function selectedSede(){
      const sedes=sedeList(config);
      const select=document.getElementById('fieldSede');
      const fixed=sedeFromQuery(config,location.search);
      const value=fixed||(select?select.value:(defaultSede(sedes,'',readSede())||''));
      return sedes.some(sede=>sede.id===value)?value:'';
    }
    async function sha256hex(value){
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
      return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
    }
    // Misma clave de idempotencia mientras sede/items/cliente no cambien; el servidor devuelve el mismo pedido.
    // Solo se guarda el HASH del cuerpo: ni cédula, RUC, correo ni dirección quedan en sessionStorage.
    async function orderKey(fingerprint){
      const hash=await sha256hex(fingerprint);
      orderStorageKey=ORDER_KEY_PREFIX+hash;
      let previous=null;
      try{previous=JSON.parse(sessionStorage.getItem(orderStorageKey));}catch(e){}
      const key=nextOrderKey(previous,hash,crypto.randomUUID());
      try{sessionStorage.setItem(orderStorageKey,JSON.stringify({fingerprint:hash,key}));}catch(e){}
      return key;
    }
    function forgetOrderKey(){try{if(orderStorageKey)sessionStorage.removeItem(orderStorageKey);}catch(e){}orderStorageKey='';}
    function orderErrorMessage(status,code){
      const map={
        sede_requerida:'Selecciona tu food truck',sede_invalida:'Selecciona un food truck válido',
        producto_no_disponible:'Un producto ya no está disponible. Revisa tu pedido',sin_stock:'Un producto ya no tiene stock. Revisa tu pedido',
        variante_no_existe:'Una opción del pedido cambió. Vuelve a elegirla',precio_no_disponible:'El precio de un producto cambió. Revisa tu pedido',
        idempotencia_conflicto:'El pedido cambió. Revisa el carrito e intenta de nuevo',demasiados_pedidos:'Demasiados intentos. Espera un momento',
        pedido_invalido:'Revisa los datos del pedido',metodo_pago_invalido:'Elige un método de pago válido',bendo_no_disponible:'El pago con tarjeta no está disponible ahora. Elige efectivo o transferencia.',catalogo_no_disponible:'El menú no está disponible ahora. Reintenta',solo_retiro:'Este menú solo permite retiro en el local',
        billing_requerido:'Revisa los datos de facturación',documento_invalido:'Revisa el número de documento',correo_invalido:'Revisa el correo electrónico',direccion_invalida:'Revisa la dirección de facturación',telefono_invalido:'Revisa el teléfono',cliente_requerido:'Completa tu nombre y teléfono',
        datos_fiscales_requeridos:'Completa los datos de facturación',datos_fiscales_invalidos:'Revisa los datos de facturación',
      };
      return map[code]||(status===429?'Demasiados intentos. Espera un momento':'No se pudo enviar tu pedido. Reintenta.');
    }
    // El backend es la fuente de verdad y responde con `campo` (p. ej.
    // billing.document_type o customer.phone). Se traduce al campo visible para
    // que el error quede junto al control y el foco vaya al primero inválido.
    function showServerFieldError(code,campo){
      const field=String(campo||'').replace(/^customer\./,'').replace(/^billing\./,'');
      if(!field||!FIELD_IDS[field]) return false;
      const messages={
        name:'Completa tu nombre y apellido.',phone:'Ingresa un teléfono válido (7 a 15 dígitos).',
        document_type:'Elige el tipo de documento.',document_number:'Ingresa un documento válido.',
        email:'Ingresa un correo electrónico válido.',address:'Ingresa la dirección de facturación.',
      };
      return showBillingErrors({[field]:messages[field]||orderErrorMessage(400,code)});
    }
    const orderNumberLabel=number=>Number.isSafeInteger(Number(number))&&Number(number)>0?'#'+String(number).padStart(6,'0'):'';
    function clearOrderPoll(){if(orderPollTimer){clearTimeout(orderPollTimer);orderPollTimer=null;}}

    /* Datos fiscales obligatorios: errores junto al campo y foco en el primero inválido. */
    function setFieldError(key,message){
      const input=document.getElementById(FIELD_IDS[key]);
      const error=document.getElementById('err-'+key);
      if(input){ if(message) input.setAttribute('aria-invalid','true'); else input.removeAttribute('aria-invalid'); }
      if(error) error.textContent=message?t(message):'';
    }
    function showBillingErrors(errors){
      Object.keys(FIELD_IDS).forEach(key=>setFieldError(key,''));
      const keys=Object.keys(errors||{});
      keys.forEach(key=>setFieldError(key,errors[key]));
      if(keys.length) document.getElementById(FIELD_IDS[keys[0]])?.focus();
      return keys.length===0;
    }
    function billingValues(){
      const read=id=>{const el=document.getElementById(id);return el&&typeof el.value==='string'?el.value.trim():'';};
      return {name:read('fieldName'),phone:read('fieldPhone'),document_type:read('fieldDocType')||'cedula',
        document_number:read('fieldDocNumber').replace(/[\s.-]/g,''),email:read('fieldEmail'),address:read('fieldBillingAddress')};
    }
    function wireBillingValidation(){
      Object.keys(FIELD_IDS).forEach(key=>{
        const input=document.getElementById(FIELD_IDS[key]);
        if(!input) return;
        const clear=()=>setFieldError(key,'');
        input.addEventListener('input',clear);
        input.addEventListener('change',clear);
      });
    }

    function updatePaymentHint(){
      const payment=document.getElementById('fieldPayment');
      const hint=document.getElementById('paymentHint');
      if(!payment||!hint) return;
      const transfer=transferInfo(config);
      const hints={
        cash:'Paga en caja; el pedido se prepara después del cobro.',
        transfer:transfer?'Transfiere y envía tu comprobante por WhatsApp. La caja verifica el pago antes de preparar.':'Transferencia no disponible: la cuenta bancaria aún no está configurada.',
        bendo:'Serás dirigido al pago seguro con tarjeta. La confirmación llega al volver.',
      };
      hint.textContent=hints[payment.value]||hints.cash;
    }
    // Opción de pago por método. El template trae efectivo, transferencia y
    // tarjeta (Bendo); esta última se crea aquí si falta, para no depender del HTML.
    function paymentOption(payment,method){
      if(!payment||typeof payment.querySelector!=='function') return null;
      return payment.querySelector(`option[value="${method}"]`)||null;
    }
    function ensurePaymentOption(payment,method){
      const found=paymentOption(payment,method);
      if(found||!payment||typeof document==='undefined') return found;
      const option=document.createElement('option');
      option.setAttribute('value',method);
      option.textContent='';
      payment.append(option);
      return option;
    }
    // El método `bendo` solo se habilita cuando la API pública confirma que hay
    // pasarela disponible; si no, queda visible pero deshabilitado.
    function setBendoOption(payment,available){
      const option=ensurePaymentOption(payment,'bendo');
      if(!option) return null;
      option.disabled=!available;
      option.textContent=t(available?'Tarjeta de crédito o débito':'Tarjeta de crédito o débito (no disponible)');
      return option;
    }
    // UI del checkout nativo: pickup sin toggle, CTA Munch sin WhatsApp, campos fiscales
    // visibles y opciones de pago habilitadas solo con contrato oficial.
    function setupNativeCheckout(checkout){
      document.querySelector('.dtog-btn[data-mode="mesa"]')?.remove();
      document.querySelector('.dtog-btn[data-mode="delivery"]')?.remove();
      const toggle=document.getElementById('deliveryToggle');if(toggle)toggle.style.display='none';
      const pickup=document.querySelector('.dtog-btn[data-mode="pickup"]');
      if(pickup){
        document.querySelectorAll('.dtog-btn').forEach(btn=>btn.classList.remove('active'));
        pickup.classList.add('active');
        const addressWrap=document.getElementById('fieldAddressWrap');
        if(addressWrap) addressWrap.style.display='none';
      }
      renderSedeField();
      const billing=document.getElementById('billingFields');if(billing)billing.hidden=false;
      const note=document.getElementById('notifyNote');if(note)note.hidden=false;
      const confirm=document.getElementById('btnConfirm');
      if(confirm){confirm.classList.remove('btn-whatsapp');confirm.classList.add('btn-confirm');confirm.innerHTML=t('Confirmar pedido');}
      const paymentWrap=document.getElementById('fieldPaymentWrap');if(paymentWrap)paymentWrap.hidden=false;
      const payment=document.getElementById('fieldPayment');
      const transfer=transferInfo(config);
      const transferOpt=payment?.querySelector('option[value="transfer"]');
      if(transferOpt&&!transfer){transferOpt.disabled=true;transferOpt.textContent='Transferencia (no disponible)';}
      else if(transferOpt){transferOpt.textContent='Transferencia bancaria';}
      // Tarjeta Bendo: oculta/deshabilitada por defecto hasta que el servidor confirme.
      setBendoOption(payment,false);
      fetch(ordersEndpoint(checkout,'/api/payment-options'),{cache:'no-store'})
        .then(r=>r.ok?r.json():null).then(options=>{
          setBendoOption(payment,options?.bendo===true);
          // La fuente pública oficial manda: si el servidor entrega detalles
          // bancarios saneados, se usan también en el recibo y en el enlace wa.me.
          if(options?.transfer_details&&typeof options.transfer_details==='object'){
            config.bank_transfer={...(config.bank_transfer||{}),...options.transfer_details};
          }
          if(transferOpt&&(options?.transfer===false||!transferInfo(config))){transferOpt.disabled=true;transferOpt.textContent='Transferencia (no disponible)';}
          else if(transferOpt){transferOpt.disabled=false;transferOpt.textContent='Transferencia bancaria';}
          if(payment&&payment.selectedOptions?.[0]?.disabled) payment.value='cash';
          updatePaymentHint();
        }).catch(()=>{updatePaymentHint();});
      payment?.addEventListener('change',updatePaymentHint);
      updatePaymentHint();
      wireBillingValidation();
    }
    // Menús legacy (sin checkout_orders) conservan su CTA de WhatsApp: el template es neutral
    // para que el checkout nativo nunca prometa WhatsApp antes de que corra el motor.
    function restoreLegacyCta(){
      const button=document.getElementById('btnConfirm');
      if(!button) return;
      const icon=document.getElementById('legacyCtaIcon');
      button.classList.remove('btn-confirm');
      button.classList.add('btn-whatsapp');
      button.innerHTML=(icon?icon.innerHTML:'')+t('Confirmar pedido por WhatsApp');
    }

    /* ── Rastro local del pedido y /gracias ── */
    function receiptLine(item){
      if(!item||typeof item!=='object') return null;
      const name=String(item.name||item.nombre||'').trim();
      const qty=Number(item.qty);
      if(!name||!Number.isInteger(qty)||qty<1) return null;
      const unit=Number(item.unit_cents),sub=Number(item.subtotal_cents);
      return {name:name.slice(0,120),qty,
        ...(Number.isFinite(unit)?{unit_cents:unit}:{}),...(Number.isFinite(sub)?{subtotal_cents:sub}:{}),
        ...(typeof item.variant_id==='string'&&item.variant_id?{variant_id:item.variant_id.slice(0,120)}:{}),
        ...(typeof item.note==='string'&&item.note?{note:item.note.slice(0,200)}:{})};
    }
    function localOrderLines(){
      return cartItems.map(item=>({
        name:item.nombre,qty:item.qty,
        unit_cents:Math.round(Number(item.precio)*100),subtotal_cents:Math.round(Number(item.precio)*Number(item.qty)*100),
        ...(variantLabel(item.variantes)?{variant_id:variantLabel(item.variantes)}:{}),...(item.nota?{note:item.nota}:{}),
      })).map(receiptLine).filter(Boolean);
    }
    function orderRecord(receipt,paymentMethod,sedeId){
      const items=Array.isArray(receipt.items)?receipt.items.map(receiptLine).filter(Boolean):localOrderLines();
      const total=Number(receipt.total_cents);
      return {
        id:receipt.id,token:receipt.order_token,number:Number(receipt.number),status:String(receipt.status||'pending'),
        total_cents:Number.isFinite(total)?total:0,currency:typeof receipt.currency==='string'?receipt.currency:(config.currency||'USD'),
        payment_method:paymentMethod,sede_id:sedeId,items,created_at:Number(receipt.created_at)||Date.now(),
        payment_status:'pending',
      };
    }
    function saveOrderRecord(record){
      if(!record||!record.id) return;
      try{
        sessionStorage.setItem(ORDER_RECORD_PREFIX+record.id,JSON.stringify(record));
        sessionStorage.setItem(LAST_ORDER_KEY,record.id);
      }catch(e){}
    }
    function loadOrderRecord(id){
      try{
        let raw=id?sessionStorage.getItem(ORDER_RECORD_PREFIX+id):null;
        if(!raw){
          const last=sessionStorage.getItem(LAST_ORDER_KEY)||'';
          if(last){
            if(last.charAt(0)==='{') return JSON.parse(last); // compatibilidad con la versión anterior
            raw=sessionStorage.getItem(ORDER_RECORD_PREFIX+last);
            id=last;
          }
        }
        return raw?JSON.parse(raw):null;
      }catch(e){return null;}
    }
    function statusSnapshot(data){
      const out={};
      if(typeof data.status==='string') out.status=data.status;
      if(Number.isSafeInteger(data.number)&&data.number>0) out.number=data.number;
      if(Number.isSafeInteger(data.total_cents)&&data.total_cents>=0) out.total_cents=data.total_cents;
      if(typeof data.currency==='string'&&/^[A-Z]{3}$/.test(data.currency)) out.currency=data.currency;
      if(typeof data.sede_id==='string') out.sede_id=data.sede_id;
      if(['cash','transfer','bendo'].includes(data.payment_method)) out.payment_method=data.payment_method;
      if(['pending','paid','rejected','unknown','failed'].includes(data.payment_status)) out.payment_status=data.payment_status;
      if(typeof data.payment_message==='string') out.payment_message=[...data.payment_message].slice(0,200).join('');
      if(typeof data.retryable==='boolean') out.retryable=data.retryable;
      if(Array.isArray(data.items)) out.items=data.items.slice(0,60).map(receiptLine).filter(Boolean);
      return out;
    }
    function thanksStatusUrl(checkout,record){
      return ordersEndpoint(checkout,`/api/orders/${encodeURIComponent(record.id)}?token=${encodeURIComponent(record.token)}`);
    }
    function syncThanksUrl(record){
      try{
        if(location.pathname.replace(/\/+$/,'')!=='/gracias') return;
        const query=new URLSearchParams({pedido:record.id,token:record.token});
        const returned=parseOrderReturn(location.search);
        if(returned&&returned.payment) query.set('pago',returned.payment);
        history.replaceState(null,'','/gracias?'+query.toString());
      }catch(e){}
    }
    function clearThanksPoll(){if(thanksTimer){clearTimeout(thanksTimer);thanksTimer=null;}}
    function transferWhatsAppNumber(){
      const raw=(config.location&&config.location.telefono_principal)||config.whatsapp_number||'';
      return String(raw).replace(/\D/g,'');
    }
    function transferMessage(record){
      const sede=sedeList(config).find(item=>item.id===record.sede_id);
      const lines=(record.items||[]).map(item=>`${item.qty}x ${item.name}`).join(', ');
      let message=`Hola, envío mi comprobante del pedido ${orderNumberLabel(record.number)}.`;
      if(sede) message+=`\nSede: ${sede.nombre}`;
      if(lines) message+=`\n${lines}`;
      if(Number.isFinite(Number(record.total_cents))) message+=`\nTotal: ${formatPrice(Number(record.total_cents)/100)}`;
      return message;
    }
    function thanksTone(record){
      const status=String(record&&record.status||'pending');
      const payment=derivedPaymentStatus(record);
      if(status==='rejected'||payment==='rejected') return 'bad';
      if(payment==='unknown'||status==='pending'&&cardPaymentMethod(String(record.payment_method||''))) return 'warn';
      if(status==='ready'||status==='paid') return 'ok';
      return 'pending';
    }
    function thanksTitle(record){
      const status=String(record&&record.status||'pending');
      if(status==='ready') return '¡Tu pedido está listo!';
      if(status==='paid') return 'Pago confirmado';
      if(status==='confirmed') return 'Pedido confirmado';
      if(status==='rejected') return 'Pedido rechazado';
      return 'Pedido recibido';
    }
    function trackThanksPurchase(){
      if(!thanksRecord||!thanksPurchaseEligible(thanksRecord)) return;
      const storageKey='munch_tracked:'+thanksRecord.id;
      try{if(sessionStorage.getItem(storageKey)) return;sessionStorage.setItem(storageKey,'1');}catch(e){}
      const contents=(thanksRecord.items||[]).map(item=>({id:item.name,nombre:item.name,
        precio:Number(item.unit_cents||item.subtotal_cents||0)/100,qty:item.qty}));
      track('Purchase',{contents,value:Number(thanksRecord.total_cents||0)/100,order_id:thanksRecord.id});
    }
    function renderThanksMissing(){
      const section=document.getElementById('thanksPage');
      document.body.classList.add('thanks-view');
      if(!section) return;
      section.hidden=false;
      section.innerHTML=`<div class="thanks-shell">
        <div class="thanks-head"><span class="thanks-kicker">${esc(config.store_name||'Munch')}</span>
          <h1 class="thanks-title">${t('No encontramos este pedido en este dispositivo.')}</h1></div>
        <section class="thanks-card"><p class="thanks-muted">${t('Resumen no disponible. Muestra tu número en caja.')}</p></section>
        <div class="thanks-actions"><a class="btn-confirm" href="/">${t('Volver al menú')}</a></div>
      </div>`;
    }
    function renderThanks(){
      const section=document.getElementById('thanksPage');
      if(!section||!thanksRecord) return;
      document.body.classList.add('thanks-view');
      section.hidden=false;
      const record=thanksRecord;
      const sede=sedeList(config).find(item=>item.id===record.sede_id);
      const tone=thanksTone(record);
      const method=String(record.payment_method||'');
      const payment=derivedPaymentStatus(record);
      const total=Number(record.total_cents);
      const lines=(record.items||[]).map(item=>{
        const subtotal=Number(item.subtotal_cents);
        return `<li><span class="thanks-line-name"><strong>${item.qty}×</strong> ${esc(item.name)}${item.variant_id?`<small>${esc(item.variant_id)}</small>`:''}${item.note?`<small>${esc(item.note)}</small>`:''}</span><span>${Number.isFinite(subtotal)?formatPrice(subtotal/100):''}</span></li>`;
      }).join('');
      const methodLabel=method==='bendo'?t('Tarjeta de crédito o débito'):method==='transfer'?t('Transferencia bancaria'):method==='cash'?t('Efectivo en caja'):method?t('Tarjeta de crédito o débito'):'';
      let payHTML='';
      if(method==='cash'){
        payHTML=`<h2>${t('Método de pago')}</h2><p class="thanks-pay-state"><strong>${t(orderPaymentLabel(record))}</strong></p>
          <p class="thanks-muted">${t('Muestra este número en caja.')}</p>`;
      } else if(method==='transfer'){
        const info=transferInfo(config);
        payHTML=`<h2>${t('Método de pago')}</h2><p class="thanks-pay-state"><strong>${t(orderPaymentLabel(record))}</strong></p>`;
        if(info){
          payHTML+=`<dl class="thanks-bank">
            <div><dt>${t('Banco')}</dt><dd>${esc(info.bank)}</dd></div>
            ${info.account_type?`<div><dt>${t('Tipo de cuenta')}</dt><dd>${esc(info.account_type)}</dd></div>`:''}
            <div><dt>${t('Cuenta')}</dt><dd>${esc(info.account)}</dd></div>
            <div><dt>${t('Titular')}</dt><dd>${esc(info.holder)}</dd></div>
          </dl>`;
        } else {
          payHTML+=`<p class="thanks-warn">${t('Transferencia no disponible')}</p>
            <p class="thanks-muted">${t('La cuenta bancaria aún no está configurada. Paga en efectivo en caja.')}</p>`;
        }
      } else if(method){
        // Tarjeta (Bendo y filas históricas): textos neutrales ("tarjeta"), nunca
        // el nombre del banco ni de una pasarela retirada.
        payHTML=`<h2>${t('Método de pago')}</h2><p class="thanks-pay-state"><strong>${t(orderPaymentLabel(record))}</strong></p>`;
        if(record.status==='rejected'||payment==='rejected'){
          payHTML+=`<p class="thanks-warn">${t('El pago no fue aprobado. Puedes volver al menú e intentar de nuevo.')}</p>`;
          if(record.payment_message) payHTML+=`<p class="thanks-muted">${esc(record.payment_message)}</p>`;
        } else if(payment==='unknown'){
          payHTML+=`<p class="thanks-warn">${t('Estamos verificando tu pago con tarjeta. No vuelvas a pagar.')}</p>`;
        } else if(payment==='failed'){
          payHTML+=`<p class="thanks-warn">${t('No se completó el pago con tarjeta. Puedes reintentar.')}</p>`;
        } else if(record.status!=='paid'&&record.status!=='ready'){
          payHTML+=`<p class="thanks-muted">${t('Verificando tu pago…')}</p>`;
        }
      } else {
        payHTML=`<h2>${t('Método de pago')}</h2><p class="thanks-muted">${t('Verificando tu pago…')}</p>`;
      }
      const waNumber=transferWhatsAppNumber();
      const waLink=method==='transfer'&&transferInfo(config)&&waNumber
        ? `https://wa.me/${waNumber}?text=${encodeURIComponent(transferMessage(record))}`:'';
      const retry=thanksRetryAllowed(record);
      section.innerHTML=`<div class="thanks-shell">
        <div class="thanks-head">
          <span class="thanks-kicker">${esc(config.store_name||'Munch')}</span>
          <h1 class="thanks-title">${t(thanksTitle(record))}</h1>
          <p class="thanks-number">${orderNumberLabel(record.number)}</p>
          <span class="thanks-badge ${tone}"${method?'':' hidden'}>${t(orderPaymentLabel(record))}</span>
          ${sede?`<p class="thanks-sede">${t('Sede')}: ${esc(sede.nombre)}</p>`:''}
        </div>
        <section class="thanks-card">
          <h2>${t('Resumen')}</h2>
          ${lines?`<ul class="thanks-lines">${lines}</ul>`:`<p class="thanks-muted">${t('Resumen no disponible. Muestra tu número en caja.')}</p>`}
          <div class="thanks-total"><span>${t('Total')}</span><strong>${Number.isFinite(total)?formatPrice(total/100):''}</strong></div>
          <p class="thanks-muted">${methodLabel}</p>
        </section>
        <section class="thanks-card thanks-payment">${payHTML}</section>
        <div class="thanks-actions">
          <button type="button" class="btn-confirm" id="thanksRefresh">${t('Actualizar estado')}</button>
          ${waLink?`<a class="btn-whatsapp" href="${waLink}" target="_blank" rel="noopener">${t('Envía tu comprobante por WhatsApp')}</a>`:''}
          ${retry?`<button type="button" class="btn-secondary" id="thanksRetry">${t('Reintentar pago con tarjeta')}</button>`:''}
          <a class="btn-secondary" href="/">${t('Volver al menú')}</a>
        </div>
        <p class="thanks-notice">${t('Cuando tu pedido esté listo te avisaremos por WhatsApp al número que registraste.')}</p>
        <p class="thanks-privacy">${t('Tus datos fiscales no se muestran en esta página.')}</p>
        ${thanksError==='notfound'?`<p class="thanks-warn">${t('No pudimos consultar el estado. Reintenta.')}</p>`:''}
      </div>`;
      section.querySelector('#thanksRefresh')?.addEventListener('click',()=>refreshThanks(true));
      section.querySelector('#thanksRetry')?.addEventListener('click',retryThanksPayment);
    }
    function scheduleThanksPoll(){
      clearThanksPoll();
      if(!thanksRecord||!thanksCheckout||thanksError) return;
      if(thanksPollFinal(String(thanksRecord.status||''))) return;
      thanksTimer=setTimeout(()=>refreshThanks(false),thanksCheckout.poll_ms);
    }
    async function refreshThanks(manual){
      if(!thanksRecord||!thanksCheckout||thanksBusy||thanksError==='notfound') return;
      thanksBusy=true;
      const button=document.getElementById('thanksRefresh');
      if(button){button.disabled=true;button.textContent=t('Actualizando…');}
      try{
        const response=await fetch(thanksStatusUrl(thanksCheckout,thanksRecord),{cache:'no-store'});
        if(response.status===404){
          thanksError='notfound';clearThanksPoll();return;
        }
        const data=await response.json().catch(()=>null);
        if(response.ok&&data&&typeof data.status==='string'){
          thanksRecord=Object.assign({},thanksRecord,statusSnapshot(data));
          saveOrderRecord(thanksRecord);
          trackThanksPurchase();
        } else if(manual){
          showToast(t('No pudimos consultar el estado. Reintenta.'));
        }
      }catch(e){
        if(manual) showToast(t('No pudimos consultar el estado. Reintenta.'));
      }finally{
        thanksBusy=false;
        if(button){button.disabled=false;button.textContent=t('Actualizar estado');}
        renderThanks();
        scheduleThanksPoll();
      }
    }
    function openPaymentURL(url){
      const link=document.createElement('a');
      link.href=url;link.referrerPolicy='origin';
      document.body.append(link);link.click();
    }
    async function retryThanksPayment(){
      if(!thanksRecord||!thanksCheckout||thanksBusy) return;
      const provider=paymentStartPath(String(thanksRecord.payment_method||''));
      if(!provider) return;
      thanksBusy=true;
      try{
        const response=await fetch(ordersEndpoint(thanksCheckout,`/api/orders/${encodeURIComponent(thanksRecord.id)}/${provider}`),{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({order_token:thanksRecord.token,idempotency_key:'retry-'+crypto.randomUUID()}),
        });
        const started=await response.json().catch(()=>null);
        if(response.ok&&started&&started.payment_url){
          thanksRecord.payment_status='pending';delete thanksRecord.retryable;saveOrderRecord(thanksRecord);
          openPaymentURL(started.payment_url);return;
        }
        if(response.ok&&started&&started.status==='paid'){
          thanksRecord.status='paid';thanksRecord.payment_status='paid';saveOrderRecord(thanksRecord);
          await refreshThanks(true);return;
        }
        throw new Error(orderErrorMessage(response.status,started&&started.error));
      }catch(error){
        showToast(t((error&&error.message)||'No se pudo abrir el pago con tarjeta. Reintenta.'));
      }finally{
        thanksBusy=false;renderThanks();
      }
    }
    function initThanks(){
      const section=document.getElementById('thanksPage');
      document.body.classList.add('thanks-view');
      if(!section) return;
      section.hidden=false;
      thanksCheckout=checkoutOrders(config);
      const returned=parseOrderReturn(location.search);
      let record=returned?loadOrderRecord(returned.id):loadOrderRecord('');
      if(returned){
        record=Object.assign({},record||{},{id:returned.id,token:returned.token});
        if(returned.payment==='pendiente'&&(!record.payment_status||record.payment_status==='pending')) record.payment_status='unknown';
        if(returned.payment==='rechazado') record.payment_status='rejected';
      }
      if(!record||!record.id||!record.token||!thanksCheckout){renderThanksMissing();return;}
      thanksRecord=record;
      saveOrderRecord(record);
      syncThanksUrl(record);
      document.title=t('Pedido')+' · '+(config.store_name||'Munch');
      renderThanks();
      if(!thanksBound){
        thanksBound=true;
        document.addEventListener('visibilitychange',()=>{
          if(!document.hidden&&thanksRecord&&!thanksPollFinal(String(thanksRecord.status||''))) refreshThanks(false);
        });
      }
      refreshThanks(false);
    }
    function goToThanks(record){
      const query=new URLSearchParams({pedido:record.id,token:record.token});
      const url='/gracias?'+query.toString();
      clearOrderPoll();
      try{closeCart();}catch(e){}
      try{history.pushState(null,'',url);}catch(e){location.assign(url);return;}
      thanksRecord=record;thanksCheckout=checkoutOrders(config);thanksError='';
      syncThanksUrl(record);
      document.title=t('Pedido')+' · '+(config.store_name||'Munch');
      renderThanks();
      try{window.scrollTo(0,0);}catch(e){}
      refreshThanks(false);
    }
    async function submitWebOrder(checkout){
      if(checkoutBusy) return;
      if(checkoutBlocked()){showToast((config.hours&&config.hours.closed_msg)||t('Estamos cerrados ahora'));return;}
      const cargo=billingValues();
      if(!showBillingErrors(billingFieldErrors(cargo))){showToast(t('Revisa los datos de facturación'));return;}
      const mode=currentMode();
      const paymentMethod=document.getElementById('fieldPayment')?.value||'cash';
      if(paymentMethod==='transfer'&&!transferInfo(config)){
        showToast(t('Transferencia no disponible'));return;
      }
      const address=mode==='delivery'?document.getElementById('fieldAddress').value.trim():'';
      if(mode==='delivery'&&!requireCoverage())return;
      if(mode==='delivery'&&!address){showToast(t('Ingresa tu dirección de entrega'));return;}
      const sedeId=selectedSede();
      if(!sedeId){showToast(t('Selecciona tu food truck'));document.getElementById('fieldSede')?.focus();return;}
      const items=orderCartItems(cartItems,products);
      if(!items.length){showToast(t('Tu pedido está vacío'));return;}
      writeSede(sedeId);
      const customer={name:cargo.name,phone:cargo.phone,billing:{
        document_type:cargo.document_type,document_number:cargo.document_number,
        email:cargo.email,address:cargo.address,
      }};
      const fingerprint=JSON.stringify({sede_id:sedeId,items,customer,delivery_mode:mode,payment_method:paymentMethod,address:address||null});
      const key=await orderKey(fingerprint);
      const button=document.getElementById('btnConfirm'),label=button?.textContent;
      checkoutBusy=true;
      if(button){button.disabled=true;button.textContent=t('Enviando pedido…');}
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),15000);
      try{
        const response=await fetch(ordersEndpoint(checkout,'/api/orders'),{
          method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,
          body:JSON.stringify({sede_id:sedeId,items,customer,delivery_mode:mode,payment_method:paymentMethod,
            address:address||undefined,idempotency_key:key}),
        });
        const receipt=await response.json().catch(()=>null);
        const ok=response.status===200||response.status===201;
        if(!ok||!receipt||typeof receipt.id!=='string'||!Number.isSafeInteger(receipt.number)||receipt.number<1||typeof receipt.order_token!=='string'){
          if(response.status===409) forgetOrderKey();
          if(response.status===400) showServerFieldError(receipt&&receipt.error,receipt&&receipt.campo);
          throw new Error(orderErrorMessage(response.status,receipt&&receipt.error));
        }
        const record=orderRecord(receipt,paymentMethod,sedeId);
        forgetOrderKey();
        saveOrderRecord(record);
        const provider=paymentStartPath(paymentMethod);
        if(provider){
          try{
            const pay=await fetch(ordersEndpoint(checkout,`/api/orders/${encodeURIComponent(receipt.id)}/${provider}`),{
              method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({order_token:receipt.order_token,idempotency_key:'web-'+receipt.id}),
            });
            const started=await pay.json().catch(()=>null);
            if(pay.ok&&started?.payment_url){
              clearCart();
              openPaymentURL(started.payment_url);
              return;
            }
            record.status=started&&typeof started.status==='string'?started.status:record.status;
            record.payment_status=started&&started.status==='paid'?'paid':'failed';
            saveOrderRecord(record);
            clearCart();
            goToThanks(record);
            return;
          }catch(e){
            record.payment_status='failed';
            saveOrderRecord(record);
            clearCart();
            goToThanks(record);
            return;
          }
        }
        clearCart();
        goToThanks(record);
      }catch(error){
        showToast(t(error&&error.name==='AbortError'?'La conexión tardó demasiado. Reintenta.':(error&&error.message)||'No se pudo enviar tu pedido. Reintenta.'));
      }finally{
        clearTimeout(timeout);checkoutBusy=false;
        if(button&&!document.body.classList.contains('thanks-view')){button.disabled=false;button.textContent=label;}
      }
    }

    /* ── WHATSAPP CHECKOUT ── */
    async function checkout(){
      if(checkoutBusy) return;
      // Cliente con checkout nativo: sin WhatsApp. Sin la clave, sigue el flujo legacy intacto.
      const nativeCheckout=checkoutOrders(config);
      if(nativeCheckout) return submitWebOrder(nativeCheckout);
      // La ubicación solo se exige a domicilio (retiro/mesa no la necesitan); se pide al confirmar, ya elegido el modo.
      if(currentMode()==='delivery'&&!requireCoverage())return;
      let num=orderPhone();
      const name=document.getElementById('fieldName').value.trim();
      const phone=document.getElementById('fieldPhone').value.trim();
      const mode=currentMode();
      const address=mode==='delivery'?document.getElementById('fieldAddress').value.trim():'';
      const isTable=tableModeAvailable()&&mode==='mesa';
      if(!isTable&&!num){showToast(t('WhatsApp no configurado'));return;}
      if(!name||(!isTable&&!phone)){showToast(t('Completa tu nombre y teléfono'));return;}
      if(mode==='delivery'&&!address){showToast(t('Ingresa tu dirección de entrega'));return;}
      if(checkoutBlocked()){showToast((config.hours&&config.hours.closed_msg)||t('Estamos cerrados ahora'));return;}
      const fees=orderFees(mode),cur=config.currency||'$',store=config.store_name||'Catálogo';
      const total=cartTotalPrice()+feesTotal(mode);

      const notifyItems=cartItems.map(i=>({nombre:i.nombre,qty:i.qty,precio:i.precio,variant:[variantLabel(i.variantes),i.nota&&`${t('Nota:')} ${i.nota}`].filter(Boolean).join(' · ')||undefined}));
      fees.forEach(([nombre,precio])=>notifyItems.push({nombre,qty:1,precio}));
      const payload={ token:config.catalog_notify_token, store_name:store, items:notifyItems,
        total,currency:cur,client_name:name,client_phone:phone,delivery_mode:mode,address:address||undefined,
        store_url:location.href,latitude:coverage?.coordinates?.lat,longitude:coverage?.coordinates?.lng };

      if(isTable){
        const tableNo=document.getElementById('fieldTable').value.trim();
        const button=document.getElementById('btnConfirm');
        const label=button?.textContent;
        checkoutBusy=true;
        if(button){button.disabled=true;button.textContent=t('Enviando pedido…');}
        try{
          const receipt=await sendTableOrder(tableOrderPayload({name,phone,tableNo,items:notifyItems,total,currency:cur}));
          if(receipt){
            track('Purchase',{contents:cartItems,value:total,order_id:receipt.id});
            clearCart();showTableReceipt(receipt);return;
          }
        }catch(e){showToast(t('No se pudo enviar tu pedido. Intenta de nuevo o avísale a tu mesero'));return;}
        finally{checkoutBusy=false;if(button){button.disabled=false;button.textContent=label;}}
        if(!phone){showToast(t('Completa tu nombre y teléfono'));return;}
      }

      if(!num){showToast(t('WhatsApp no configurado'));return;}
      const extras=extraFieldValues();if(!extras)return;

      let msg=`${config.whatsapp_message||t('¡Hola! Quiero hacer un pedido:')}\n\n${t('*PEDIDO — {0}*',store)}\n━━━━━━━━━━━━━━━━━\n`;
      if(preorderNote())msg+=preorderNote()+'\n';
      cartItems.forEach(item=>{
        const vLabel=variantLabel(item.variantes);
        msg+=`▸ ${item.nombre}${vLabel?' ('+vLabel+')':''}\n${item.nota?`  📝 ${item.nota}\n`:''}  ${item.qty} × ${formatPrice(item.precio)} = ${formatPrice(item.precio*item.qty)}\n`;
      });
      fees.forEach(([l,v])=>{msg+=`▸ ${l}\n  ${formatPrice(v)}\n`;});
      msg+=`━━━━━━━━━━━━━━━━━\n*TOTAL: ${config.price_locale?formatPrice(total):cur+total.toFixed(2)}*\n\n`;
      msg+=`${t('*ENTREGA:*')} ${t(mode==='delivery'?'Domicilio':mode==='mesa'?'Mesa':'Retiro en local')}\n`;
      msg+=`${t('*Cliente:*')} ${name}\n${t('*Teléfono:*')} ${phone}\n`;
      if(address) msg+=`${t('*Dirección:*')} ${address}\n`;
      extras.forEach(([l,v])=>{msg+=`*${l}:* ${v}\n`;});
      msg+=sedeNote()+`\n${location.href}`;
      if(config.catalog_notify_url && config.catalog_notify_token){
        checkoutBusy = true;
        const button = document.getElementById('btnConfirm') || document.getElementById('btnCheckout');
        const label = button?.textContent;
        if(button){ button.disabled = true; button.textContent = t('Registrando pedido…'); }
        try {
          const checkout = await orderCheckout();
          await checkout.submit({url:config.catalog_notify_url,payload,phone:num,message:msg,t,
            container:document.getElementById('cartStep2') || document.getElementById('cartDrawer') || document.body,
            onSuccess:receipt=>{track('Purchase',{contents:cartItems,value:total,order_id:receipt.id});panelOrder(window,payload,receipt.id);receipt.reset();clearCart();}});
        } catch(error) { showToast(t(error.name === 'AbortError' ? 'La conexión tardó demasiado. Reintenta para recuperar tu número.' : error.message || 'No se pudo registrar el pedido. Reintenta.')); }
        finally { checkoutBusy = false; if(button){ button.disabled = false; button.textContent = label; } }
        return;
      }
      // Sin registro en craft-crm: el "envío" es abrir wa.me; popup bloqueado (null) => sin Purchase.
      if(window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`,'_blank')){track('Purchase',{contents:cartItems,value:total});panelOrder(window,payload);clearCart();closeCart();}
    }

    /* ── BOTTOM NAV ── */
    function setActiveNav(name){document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.nav===name));}
    function syncNavToFilter(){
      setActiveNav(activeFilter==='__offers__'?'offers':activeFilter==='__location__'?'location':'home');
    }
    function goTop(){window.scrollTo({top:0,behavior:'smooth'});}
    document.querySelector('.bottom-nav').addEventListener('click',e=>{
      const item=e.target.closest('.nav-item');if(!item) return;
      const nav=item.dataset.nav;
      if(nav==='cart'){openCart();return;}
      searchQuery='';$searchInput.value='';
      activeFilter=nav==='offers'?'__offers__':nav==='location'?'__location__':'all';
      setActiveNav(nav);
      if(nav==='location') renderLocation(); else renderCatalog();
      goTop();
    });
    $cartPeek.addEventListener('click',openCart);

    // Vitrina WhatsApp: abre wa.me con el producto prellenado (config.wa_order).
    function waQuick(p){
      if(!requireCoverage())return;
      if(checkoutBlocked()){showToast((config.hours&&config.hours.closed_msg)||t('Estamos cerrados ahora'));return;}
      const num=orderPhone();if(!num)return;
      const price=promoPrice(p)!==null?` — ${formatPrice(basePrice(p))}`:typeof p.precio==='number'?` — ${formatPrice(p.precio)}`:(p.precio?` — ${p.precio}`:'');
      const msg=`${config.whatsapp_message||t('¡Hola! Quiero pedir:')}\n\n• ${p.nombre}${price}`+sedeNote()+'\n'+preorderNote();
      window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`,'_blank');
    }

    /* ── EVENT DELEGATION ── */
    document.addEventListener('click',e=>{
      const favBtn=e.target.closest('[data-fav]');
      if(favBtn){e.stopPropagation();toggleFav(favBtn.dataset.fav);return;}

      // Modo vitrina: cualquier botón de producto abre WhatsApp con ese ítem (sin carrito).
      if(config.wa_order){
        const t=e.target.closest('[data-add],[data-open]');
        if(t){const p=products.find(x=>String(x.id)===String(t.dataset.add||t.dataset.open));if(p)waQuick(p);return;}
      }

      const addTrigger=e.target.closest('[data-add]');
      if(addTrigger&&!e.target.closest('[data-action]')){
        const p=products.find(x=>String(x.id)===String(addTrigger.dataset.add));
        if(p&&getStockInfo(p).canAdd) cartAdd(addTrigger.dataset.add,{},1);
        return;
      }
      const openTrigger=e.target.closest('[data-open]');
      if(openTrigger&&!e.target.closest('[data-action]')){openModal(openTrigger.dataset.open);return;}

      const btn=e.target.closest('[data-action]');
      if(btn){
        const {action,id,key}=btn.dataset;
        if(action==='inc'){const p=products.find(x=>String(x.id)===String(id));if(p&&getStockInfo(p).canAdd) cartAdd(id,{},1);}
        if(action==='dec'&&key) cartRemoveOne(key);
        return;
      }
      const removeBtn=e.target.closest('.cart-item-remove');
      if(removeBtn){cartDelete(removeBtn.dataset.key);return;}
    });

    $catStrip.addEventListener('click',e=>{
      const chip=e.target.closest('.cat-chip');if(!chip) return;
      const cat=chip.dataset.cat;
      searchQuery='';$searchInput.value='';
      activeFilter=cat;setActiveNav('home');renderCatalog();
      if(cat!=='all') requestAnimationFrame(()=>{const s=document.getElementById('cat-'+cat);if(s) s.scrollIntoView({behavior:'smooth'});});
      else goTop();
    });

    $searchInput.addEventListener('input',()=>{
      searchQuery=normalize($searchInput.value);
      if(activeFilter==='__offers__'||activeFilter==='__favs__'){renderCatalog();return;}
      activeFilter='all';setActiveNav('home');renderCatalog();
    });

    $cartOverlay.addEventListener('click',closeCart);
    $cartClose.addEventListener('click',closeCart);
    $btnCheckout.addEventListener('click',goToStep2);
    document.getElementById('cartBack').addEventListener('click',goToStep1);
    document.getElementById('btnConfirm').addEventListener('click',checkout);
    document.getElementById('deliveryToggle').addEventListener('click',e=>{
      const btn=e.target.closest('.dtog-btn');if(!btn) return;
      document.querySelectorAll('.dtog-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('fieldAddressWrap').style.display=btn.dataset.mode==='delivery'?'':'none';
      syncTableMode();
      updateCartUI(); // mesa exime empaque, retiro/mesa eximen envío → recalcula total
    });
    $modalOverlay.addEventListener('click',e=>{if(e.target===$modalOverlay) closeModal();});
    $modalClose.addEventListener('click',closeModal);
    $modalFav.addEventListener('click',()=>toggleFav($modalFav.dataset.fav));
    document.addEventListener('keydown',e=>{
      if(e.key==='Escape'){closeModal();closeCart();}
      if($modalOverlay.classList.contains('open')){
        if(e.key==='ArrowLeft') slideTo(sliderIdx-1);
        if(e.key==='ArrowRight') slideTo(sliderIdx+1);
      }
    });

    /* ── HORARIO CERRADO MODAL + RESERVAS ── */
    function buildTimeSlots(dayIdx){
      const weekly=(config.hours&&config.hours.weekly)||{};
      const ranges=weekly[dayIdx]||[];
      const toMin=s=>{const[a,b]=String(s).split(':');return(+a)*60+(+b||0);};
      const fmt=m=>{const hh=Math.floor(m/60)%24,mm=m%60;return`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;};
      const slots=[];
      ranges.forEach(r=>{let s=toMin(r[0]),e=toMin(r[1]);if(e<=s)e+=1440;for(let t=s;t<e;t+=30)slots.push(fmt(t%1440));});
      if(!slots.length)for(let t=480;t<=1320;t+=30)slots.push(fmt(t)); // ponytail: fallback 08:00-22:00 si no hay config de horario
      return slots;
    }
    function reservationFormHTML(){
      const days=['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'].map(d=>t(d));
      const weekly=(config.hours&&config.hours.weekly)||{};
      const configured=Object.entries(weekly).filter(([,r])=>r&&r.length).map(([d])=>+d);
      const dayOpts=(configured.length?configured:[0,1,2,3,4,5,6]).map(d=>`<option value="${d}">${days[d]}</option>`).join('');
      return `<div class="reserve-form">
        <div class="form-field"><label>${t('Nombre y apellido')}</label>
          <input type="text" class="res-name" placeholder="${t('Tu nombre completo')}" autocomplete="name"/></div>
        <div class="form-field"><label>WhatsApp</label>
          <input type="tel" class="res-phone" placeholder="${t('Tu número de WhatsApp')}" autocomplete="tel"/></div>
        <div class="reserve-row">
          <div class="form-field"><label>${t('Día')}</label><select class="res-day">${dayOpts}</select></div>
          <div class="form-field"><label>${t('Hora')}</label><select class="res-time"></select></div>
        </div>
        <div class="form-field"><label>${t('¿Cuántas personas?')}</label>
          <input type="number" class="res-people" min="1" step="1" value="2" inputmode="numeric"/></div>
        <div class="form-field"><label>${t('¿Celebran algo especial? (opcional)')}</label>
          <input type="text" class="res-occasion" placeholder="${t('Cumpleaños, aniversario…')}"/></div>
        <button class="btn-reserve-submit">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
          ${t('Confirmar reserva')}
        </button>
      </div>`;
    }
    function setupReserveForm(container){
      const dayEl=container.querySelector('.res-day'),timeEl=container.querySelector('.res-time');
      const fillSlots=()=>{const s=buildTimeSlots(+dayEl.value);timeEl.innerHTML=s.map(t=>`<option>${t}</option>`).join('');};
      dayEl.addEventListener('change',fillSlots);fillSlots();
      container.querySelector('.btn-reserve-submit').addEventListener('click',()=>{
        const name=container.querySelector('.res-name').value.trim();
        const phone=container.querySelector('.res-phone').value.trim();
        if(!name||!phone){showToast(t('Completa nombre y WhatsApp'));return;}
        const num=(config.whatsapp_number||'').replace(/\D/g,'');
        if(!num){showToast(t('WhatsApp no configurado'));return;}
        const day=dayEl.options[dayEl.selectedIndex].text,time=timeEl.value;
        const people=(container.querySelector('.res-people').value||'').trim();
        const occasion=container.querySelector('.res-occasion').value.trim();
        const store=config.store_name||t('el local');
        let msg=`${t('¡Hola! Quiero hacer una *reserva* en {0}:',store)}\n\n${t('*Nombre:*')} ${name}\n*WhatsApp:* ${phone}\n${t('*Día:*')} ${day}\n${t('*Hora:*')} ${time}`;
        if(people) msg+=`\n${t('*Personas:*')} ${people}`;
        if(occasion) msg+=`\n${t('*Ocasión:*')} ${occasion}`;
        window.open(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`,'_blank');
      });
    }
    function openClosedModal(){
      if(document.getElementById('closedOverlay')) return;
      const el=document.createElement('div');
      el.id='closedOverlay';el.className='closed-overlay';
      const conReservas=reservasActivas();
      el.innerHTML=`<div class="closed-modal">
        <div class="closed-icon">🌙</div>
        <h2 class="closed-title">${t('Estamos cerrados')}</h2>
        <p class="closed-msg"></p>
        <p class="closed-sub"></p>
        <div class="closed-btns">
          <button class="btn-closed-browse">${t('Ten mi pedido listo')}</button>
          ${conReservas?`<button class="btn-closed-reserve">${t('📅 Hacer una reserva')}</button>`:''}
        </div>
        ${conReservas?`<div class="closed-reserve-wrap" style="display:none">${reservationFormHTML()}</div>`:''}
      </div>`;
      document.body.appendChild(el);
      el.querySelector('.closed-msg').textContent=(config.hours&&config.hours.closed_msg)||t('Vuelve en nuestro horario de atención.');
      el.querySelector('.closed-sub').textContent=preorderNote()||t('Puedes explorar el menú y pedir dentro del horario de atención.');
      el.querySelector('.btn-closed-browse').addEventListener('click',()=>el.classList.remove('open'));
      if(conReservas){
        el.querySelector('.btn-closed-reserve').addEventListener('click',()=>{
          const w=el.querySelector('.closed-reserve-wrap');w.style.display=w.style.display==='none'?'':'none';
        });
        setupReserveForm(el.querySelector('.closed-reserve-wrap'));
      }
      requestAnimationFrame(()=>el.classList.add('open'));
    }

    /* ── INIT ── */
    const isThanksPath=()=>String((typeof location!=='undefined'&&location.pathname)||'').replace(/\/+$/,'')==='/gracias';
    // Tema, marca, fuentes, favicon y footer: común al menú y al recibo /gracias.
    function applyBranding(){
      // Tema: aplica tokens de config.theme (objeto) + claves legacy theme_primary/accent.
      // El esqueleto (catalog.css) consume estas CSS vars; lo que un token no cubra va en theme.css.
      const root=document.documentElement.style;
      const T={primary:'--primary',accent:'--accent',bg:'--bg',surface:'--surface',surface2:'--surface2',
        text:'--text',text2:'--text2',text3:'--text3',border:'--border',radius:'--radius',font:'--font',
        card_blur:'--card-blur',card_alpha:'--card-alpha'};
      const theme={...(config.theme||{})};
      if(config.theme_primary&&theme.primary==null) theme.primary=config.theme_primary;
      if(config.theme_accent&&theme.accent==null) theme.accent=config.theme_accent;
      for(const k in theme){ if(T[k]&&theme[k]!=null&&theme[k]!=='') root.setProperty(T[k],theme[k]); }

      const store=config.store_name||'Catálogo';
      const brandName=document.getElementById('brandName');if(brandName)brandName.textContent=store;
      // Logo desde config (shell genérico del Worker edge). Legacy trae el src en el index → no lo pisa si config.logo está vacío.
      const brandLogo=document.getElementById('brandLogo');
      if(brandLogo&&config.logo) brandLogo.src=config.logo;
      document.title=config.site_title||store;
      const footer=document.getElementById('footerText');
      if(footer) footer.innerHTML=
        `© ${new Date().getFullYear()} <strong>${store}</strong>`+
        `<span class="footer-sep">|</span><a href="#" id="lnkTerms">${t('Términos y condiciones')}</a>`+
        `<span class="footer-sep">|</span><a href="#" id="lnkPrivacy">${t('Política de privacidad')}</a>`+
        `<br><span class="footer-credit">Powered by <a href="https://craft-systems.com" target="_blank" rel="noopener">Craft Systems</a></span>`;
      if(config.hero_title){const heroTitle=document.getElementById('heroTitle');if(heroTitle)heroTitle.innerHTML=config.hero_title;}

      // Personalizaciones opcionales desde config (edge y legacy). Si la clave no está,
      // se respeta lo que traiga el index del cliente (retrocompat). Crea el elemento si falta.
      const heroTitle=document.getElementById('heroTitle');
      const beforeHero=el=>{ if(heroTitle) heroTitle.parentNode.insertBefore(el,heroTitle); };
      if(config.fonts && !document.querySelector(`link[href="${config.fonts}"]`)){
        const l=document.createElement('link'); l.rel='stylesheet'; l.href=config.fonts; document.head.appendChild(l);
      }
      if(config.favicon){
        let ic=document.querySelector('link[rel="icon"]');
        if(!ic){ ic=document.createElement('link'); ic.rel='icon'; document.head.appendChild(ic); }
        ic.href=config.favicon;
      }
      if(config.brand_sub){ const bs=document.querySelector('.brand-sub'); if(bs) bs.textContent=config.brand_sub; }
      if(config.hero_kicker){
        let k=document.querySelector('.hero-kicker');
        if(!k){ k=document.createElement('p'); k.className='hero-kicker'; beforeHero(k); }
        k.textContent=config.hero_kicker;
      }
      if(config.hero_divider && !document.querySelector('.hero-divider')){
        const d=document.createElement('div'); d.className='hero-divider'; beforeHero(d);
      }
      if(config.search_placeholder){ const si=document.getElementById('searchInput'); if(si) si.placeholder=config.search_placeholder; }
    }

    async function init(){
      // Edge (Worker SSR): el config viene inyectado en el HTML → sin fetch, sin flash.
      // Legacy (Pages estático): cae al fetch de config.json. Retrocompatible.
      if(window.__CONFIG__){ config=window.__CONFIG__; if(!isThanksPath()) panelCount(window,'view'); }
      else{ try{const r=await fetch('config.json',{cache:'no-store'});if(r.ok) config=await r.json();}catch(e){} }

      applyBranding();

      // /gracias: recibo por token opaco. No carga catálogo, carrito ni horario.
      if(isThanksPath()){ initThanks(); return; }

      // Retorno antiguo a "/" con pedido/token: mover a /gracias conservando el resultado.
      const returned=parseOrderReturn(location.search);
      if(returned&&checkoutOrders(config)){
        const query=new URLSearchParams({pedido:returned.id,token:returned.token});
        if(returned.payment) query.set('pago',returned.payment);
        location.replace('/gracias?'+query.toString());
        return;
      }

      // Opt-in config.store_mode: tienda (no restaurante) → sin entrega "Mesa", nota e ícono genéricos.
      if(config.store_mode) document.querySelector('.dtog-btn[data-mode="mesa"]')?.remove();
      const nativeCheckout=checkoutOrders(config);
      if(!nativeCheckout) renderExtraFields(); // los campos extra legacy viajan solo por WhatsApp
      renderTableField();
      // Checkout nativo: seis sedes → `?sede=` o selector; sin modo Mesa (lo atiende el mesero).
      if(nativeCheckout) setupNativeCheckout(nativeCheckout);
      else restoreLegacyCta();
      if(needsCoverage()){
        try{
          if(!window.CraftGeo)await new Promise((resolve,reject)=>{
            const script=document.createElement('script');script.src=geoScriptURL;
            script.onload=resolve;script.onerror=reject;document.head.append(script);
          });
          coverage=window.CraftGeo.create(config,{mount:document.getElementById('fieldAddressWrap')});
        }catch{showToast(t('No se pudo cargar el selector de ubicación. Recarga para reintentar.'));}
      }

      // Burbuja de WhatsApp: número dinámico desde config (no hardcodear en el index).
      const waFloat=document.querySelector('.wa-float'),waBubble=(config.whatsapp_number||'').replace(/\D/g,'');
      if(waFloat){
        if(waBubble) waFloat.href=`https://wa.me/${waBubble}?text=${encodeURIComponent(config.whatsapp_message||t('¡Hola! Quiero hacer un pedido:'))}`;
        else waFloat.style.display='none';
        waFloat.addEventListener('click',e=>{
          if(!needsCoverage())return;
          e.preventDefault();if(!requireCoverage())return;
          const num=orderPhone();if(num)window.open(`https://wa.me/${num}?text=${encodeURIComponent((config.whatsapp_message||t('¡Hola! Quiero hacer un pedido:'))+sedeNote())}`,'_blank');
        });
      }

      // Banner del club de fidelización (opt-in config.club = {label?}): botón flotante → /club.
      const club=clubBanner(config.club);
      if(club){
        const a=document.createElement('a');
        a.className='club-float';a.href=club.href;a.textContent='🎁 '+t(club.label);
        document.body.appendChild(a);
      }

      const mu=config.min_units,md=config.min_days_advance;
      if(mu||md){
        const parts=[];
        if(mu) parts.push(t('Mín. <strong>{0} unidades</strong>',mu));
        if(md) parts.push(t('con <strong>{0} días</strong> de anticipación',md));
        const $n=document.getElementById('heroNotice');
        $n.innerHTML=parts.join(', ')+'.';$n.style.display='inline-block';
      }

      // Horario de atención: fuera de hora se bloquea el checkout (se sigue pudiendo navegar).
      storeClosed=!storeHoursOpen(config.hours);
      if(storeClosed) openClosedModal();

      const res=await fetch('productos.json',{cache:'no-store'});
      products=await res.json();
      // El sync de craft-crm hornea "($32900.00)" en las etiquetas price_select: con price_locale se re-formatea.
      if(config.price_locale)products.forEach(p=>(p.variantes||[]).forEach(v=>(v.options||[]).forEach(o=>{
        if(o&&typeof o==='object'&&typeof o.price==='number'&&o.label)o.label=o.label.replace(/\s*\([^()]*\d[^()]*\)\s*$/,` (${formatPrice(o.price)})`);})));
      initTracking();

      buildCatStrip();
      loadCart();loadFavs();
      cartItems=cartItems.filter(ci=>products.find(p=>String(p.id)===String(ci.id)));

      renderCatalog();updateCartUI();

      const preOpen=new URLSearchParams(location.search).get('producto');
      if(preOpen){const p=products.find(x=>x.slug===preOpen||String(x.id)===preOpen);if(p) openModal(p.id);}

      // Legal modal
      document.getElementById('lnkTerms')?.addEventListener('click',e=>{e.preventDefault();openLegal('terms');});
      document.getElementById('lnkPrivacy')?.addEventListener('click',e=>{e.preventDefault();openLegal('privacy');});
      document.getElementById('legalClose')?.addEventListener('click',()=>document.getElementById('legalOverlay').classList.remove('open'));
      document.getElementById('legalOverlay')?.addEventListener('click',e=>{if(e.target===e.currentTarget) e.currentTarget.classList.remove('open');});
    }

    function openLegal(type){
      const overlay=document.getElementById('legalOverlay');
      const title=document.getElementById('legalTitle');
      const body=document.getElementById('legalBody');
      const store=config.store_name||'el local';
      const wa=(config.whatsapp_number||'').replace(/\D/g,'');
      if(isEN()){ // texto legal en inglés completo (no frase a frase): sin IVA ni referencias locales de EC
        const en=config.store_name||'the restaurant';
        title.textContent=t(type==='terms'?'Términos y condiciones':'Política de privacidad');
        body.innerHTML=type==='terms'?`<h4>1. Use of the digital menu</h4>
          <p>This digital menu is an informational tool from ${en} to make ordering through WhatsApp easier. Placing an order means you accept these terms.</p>
          <h4>2. Orders and payment</h4>
          <p>Orders are confirmed only through WhatsApp. Prices are in US dollars (USD); applicable taxes may be added. ${en} may change prices without prior notice.</p>
          <h4>3. Delivery</h4>
          <p>Delivery times are estimates and may vary with demand and distance. Any delivery fee is agreed with you when the order is confirmed.</p>
          <h4>4. Cancellations</h4>
          <p>Once an order is confirmed on WhatsApp, cancellation is subject to the restaurant’s approval. Orders already being prepared cannot be cancelled.</p>
          <h4>5. Availability</h4>
          <p>Products are subject to availability. ${en} cannot guarantee that every item is available at all times.</p>`
          :`<h4>1. Data we collect</h4>
          <p>When you place an order we collect your full name, phone number and delivery address, used only to process and deliver your order.</p>
          <h4>2. How we use it</h4>
          <p>Your personal data is not sold, transferred or shared with third parties outside ${en}, except when required by law.</p>
          <h4>3. WhatsApp</h4>
          <p>Communication happens through WhatsApp. By contacting us you accept WhatsApp’s terms and privacy policy (Meta Platforms, Inc.).</p>
          <h4>4. Cookies</h4>
          <p>This site uses your browser’s localStorage only to remember your cart and favorites. We don’t use tracking or advertising cookies.</p>
          <h4>5. Contact</h4>
          <p>For any question about your data, contact us on WhatsApp${wa?' +'+wa:''}.</p>`;
        overlay.classList.add('open');return;
      }
      if(type==='terms'){
        title.textContent='Términos y condiciones';
        const doc=config.store_mode?'catálogo digital':'menú digital';
        body.innerHTML=`<h4>1. Uso del ${doc}</h4>
          <p>Este ${doc} es una herramienta informativa de ${store} para facilitar la recepción de pedidos a través de WhatsApp. La realización del pedido implica la aceptación de estos términos.</p>
          <h4>2. Pedidos y pagos</h4>
          <p>Los pedidos se confirman únicamente a través de WhatsApp. Los precios están expresados en dólares americanos (USD) e incluyen IVA. ${store} se reserva el derecho de modificar precios sin previo aviso.</p>
          <h4>3. Entrega</h4>
          <p>El tiempo de entrega es estimado y puede variar según la demanda y la distancia. El costo de envío se acordará directamente con el cliente al confirmar el pedido.</p>
          <h4>4. Cancelaciones</h4>
          <p>Una vez confirmado el pedido por WhatsApp, la cancelación queda sujeta a la aprobación ${config.store_mode?'de la tienda. Los pedidos ya despachados':'del local. Los pedidos en proceso de preparación'} no admiten cancelación.</p>
          <h4>5. Disponibilidad</h4>
          <p>La disponibilidad de productos está sujeta al stock ${config.store_mode?'disponible':'del local'}. ${store} no garantiza la disponibilidad de todos los productos en todo momento.</p>`;
      } else {
        title.textContent='Política de privacidad';
        body.innerHTML=`<h4>1. Datos recopilados</h4>
          <p>Al realizar un pedido, recopilamos: nombre completo, número de teléfono y dirección de entrega. Estos datos se utilizan exclusivamente para procesar y entregar tu pedido.</p>
          <h4>2. Uso de los datos</h4>
          <p>Los datos personales proporcionados no serán vendidos, cedidos ni compartidos con terceros ajenos a ${store}, salvo requerimiento legal.</p>
          <h4>3. WhatsApp</h4>
          <p>La comunicación se realiza a través de WhatsApp. Al contactarnos, aceptas los términos y la política de privacidad de WhatsApp (Meta Platforms, Inc.).</p>
          <h4>4. Cookies</h4>
          <p>Este sitio utiliza localStorage del navegador únicamente para recordar el contenido de tu carrito y tus favoritos. No utilizamos cookies de seguimiento ni publicidad.</p>
          <h4>5. Contacto</h4>
          <p>Para cualquier consulta sobre tus datos, contáctanos al WhatsApp${wa?' +'+wa:''}.</p>`;
      }
      overlay.classList.add('open');
    }

    init().catch(err=>{
      console.error(err);
      $catalog.innerHTML=`<div class="empty-state"><span class="em">⚠️</span><p>${t('Error cargando catálogo')}</p></div>`;
    });
  })();
