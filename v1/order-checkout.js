/* Registro compartido por menús y tiendas. Solo conserva referencias y hashes en esta pestaña. */
(function(root){
  'use strict';
  const attempts = new Map();
  let busy = false;
  async function digest(value){
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function register(url, payload){
    const storageKey = 'craft_order:' + await digest(url + payload.token);
    const fingerprint = await digest(JSON.stringify(payload));
    let attempt = attempts.get(storageKey);
    if(!attempt) try { attempt = JSON.parse(sessionStorage.getItem(storageKey)); } catch {}
    if(!attempt || attempt.fingerprint !== fingerprint || typeof attempt.key !== 'string'){
      attempt = { fingerprint, key: crypto.randomUUID() };
    }
    attempts.set(storageKey, attempt);
    try { sessionStorage.setItem(storageKey, JSON.stringify(attempt)); } catch {}
    // Revalidar también una confirmación guardada: el servidor es la fuente de verdad.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, idempotency_key: attempt.key }), signal: controller.signal });
      const receipt = await response.json().catch(() => null);
      if(!response.ok || !receipt || !Number.isSafeInteger(receipt.order_number) || receipt.order_number < 1 || typeof receipt.id !== 'string'){
        throw new Error(response.status === 409 ? 'Este intento pertenece a otro pedido. Revisa el carrito antes de continuar.' : 'No se pudo confirmar el registro. Reintenta para recuperar tu número de pedido.');
      }
      return { ...receipt, reset(){ attempts.delete(storageKey); try { sessionStorage.removeItem(storageKey); } catch {} } };
    } finally { clearTimeout(timeout); }
  }
  // t = traductor del motor (catalog.js, opt-in por config.locale); sin t, español con {0} interpolado.
  const fmt = (s, ...a) => s.replace(/\{(\d)\}/g, (_, i) => a[i]);
  function waLink(phone, label, receipt, message, t = fmt){
    return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(`${t('*Pedido {0}*', label)}\n${message}`)}`;
  }
  // Pestaña puente: hay que abrirla DURANTE el gesto del usuario. Si se abriera después del
  // `await` del registro, el navegador la bloquea como popup y el cliente quedaría obligado a
  // un clic extra ("Continuar por WhatsApp"), que es justo la fricción que se elimina.
  function openBridge(t = fmt){
    let w = null;
    try { w = root.open('about:blank', '_blank'); } catch {}
    if(!w) return null;
    try {
      const opening = t('Abriendo WhatsApp…');
      w.document.write('<!doctype html><meta charset="utf-8"><title>' + opening + '</title>' +
        '<body style="margin:0;display:grid;place-items:center;height:100vh;background:#fff;' +
        'color:#555;font:600 15px system-ui,sans-serif">' + opening + '</body>');
      w.document.close();
    } catch {}
    return w;
  }
  function goTo(tab, href){
    if(tab){ // pestaña puente ya autorizada por el gesto: nadie bloquea esta redirección
      try { tab.location.replace(href); return true; } catch {}
      try { tab.location.href = href; return true; } catch {}
    }
    try { root.location.href = href; return true; } catch {}
    return false;
  }
  async function submit({url, payload, phone, message, container, onSuccess, t = fmt}){
    if(busy) return;
    busy = true;
    document.getElementById('craftOrderReceipt')?.remove();
    const tab = openBridge(t);
    try {
      const receipt = await register(url, payload);
      const label = '#' + String(receipt.order_number).padStart(6, '0');
      const href = waLink(phone, label, receipt, message, t);
      // Sin clics extra: el pedido ya está registrado y se sigue directo a WhatsApp con el
      // nº y el UUID inyectados en el mensaje.
      goTo(tab, href);
      // Recibo compacto: queda como comprobante del nº si el cliente vuelve al menú y como
      // respaldo navegable si el navegador hubiera bloqueado la apertura.
      const box = document.createElement('section'); box.id = 'craftOrderReceipt';
      box.setAttribute('role', 'status'); box.style.cssText = 'padding:16px;margin:12px 0;border:1px solid currentColor;border-radius:12px;display:grid;gap:12px';
      const title = document.createElement('strong'); title.textContent = t('Pedido {0} registrado', label);
      const note = document.createElement('span'); note.textContent = t('Te llevamos a WhatsApp para coordinar tu pedido. Si no se abrió, usa el botón.');
      const link = document.createElement('a'); link.className = 'btn btn-primary'; link.textContent = t('Continuar por WhatsApp');
      link.href = href; link.target = '_blank'; link.rel = 'noopener';
      const next = document.createElement('button'); next.type = 'button'; next.className = 'btn'; next.textContent = t('Crear otro pedido');
      next.addEventListener('click', () => { receipt.reset(); box.remove(); });
      box.append(title, note, link, next); container.append(box); box.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      try { onSuccess?.(receipt); } catch {} // solo tras registro confirmado; un fallo del callback no rompe el pedido
      return receipt;
    } catch (error) {
      try { tab?.close(); } catch {} // no dejar una pestaña en blanco si el registro falló
      throw error;
    } finally { busy = false; }
  }
  root.CraftOrderCheckout = { register, submit };
  if(typeof module !== 'undefined') module.exports = root.CraftOrderCheckout;
})(typeof window !== 'undefined' ? window : globalThis);
