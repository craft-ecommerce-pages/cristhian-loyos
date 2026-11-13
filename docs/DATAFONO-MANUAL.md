# Cobro con datáfono (registro manual) — contrato

Estado: aprobado por Juan Carlos el 2026-11-13. Respaldo manual mientras no exista integración "POS Mode" con el SmartPOS de Bendo (ver `docs/PAGOS-BENDO.md`, sección final). El cajero cobra en el datáfono de Bendo como siempre y en Munch registra el cobro con el número de autorización impreso en el voucher.

## Decisiones

1. **Mismo proveedor, canal propio.** El pago se guarda como `pos_payments.provider = 'bendo'` con `channel = 'datafono'`; los cobros por link quedan con `channel = 'link'`. Agregar una columna evita reconstruir tablas en producción.
2. **Es un cobro manual:** igual que efectivo y transferencia, exige turno de caja abierto en la sede (`409 caja_cerrada`) y queda asignado a ese turno. No suma al efectivo esperado del arqueo.
3. **Cualquier pedido `pending` o `confirmed`** (web o caja, sin importar el método elegido) puede cobrarse con datáfono. Al cobrarse, `pos_orders.payment_method` pasa a `bendo` (el método real).
4. **Sin doble cobro:** si el pedido tiene un pago Bendo por link en `pending` o `unknown`, responde `409 pago_en_curso` (primero se verifica o se espera el link).
5. **Número de autorización obligatorio:** 4 a 12 caracteres `[A-Za-z0-9]`, guardado en `pos_payments.authorization`. Los últimos 4 dígitos de la tarjeta son opcionales (`^[0-9]{4}$`) y se guardan en `message` como `tarjeta ****1234`; nunca se pide ni se guarda el número completo.

## Datos (migración `0013_pago_canal.sql`, aditiva)

```sql
ALTER TABLE pos_payments ADD COLUMN channel TEXT CHECK (channel IS NULL OR channel IN ('link', 'datafono'));
UPDATE pos_payments SET channel = 'link' WHERE provider = 'bendo' AND channel IS NULL;
```

`panel/src/bendo.js` guarda `channel = 'link'` en los intentos nuevos (en `createPaymentAttempt` vía parámetro opcional o con un `UPDATE` inmediato tras crearlo).

## API

`POST /panel/api/orders/:id/pay-datafono` `{idempotency_key, authorization_code, card_last4?}` con la misma sesión y permisos por sede que `pay-cash`. Respuesta idéntica a `pay-cash` (`200` con el pedido pagado). Idempotente por clave: misma clave → misma respuesta; misma clave con otro proveedor/canal → `409 idempotencia_conflicto`. Errores: `400 autorizacion_invalida`, `400 tarjeta_invalida`, `409 caja_cerrada`, `409 pago_en_curso`, `409 orden_ya_pagada`, `409 estado_invalido`. Misma garantía que efectivo: un solo batch paga el pedido, crea la comanda una vez, escribe el snapshot de líneas y asigna `shift_id`.

## Reportes y cierre

- `turnos.js` agrupa ventas por método de reporte: `datafono` cuando `provider='bendo' AND channel='datafono'`; `bendo` para el resto de Bendo. Orden: `cash`, `transfer`, `datafono`, `bendo`, `payphone`.
- Etiquetas en UI y ticket Z: `cash` "Efectivo", `transfer` "Transferencia", `datafono` "Datáfono", `bendo` "Tarjeta (link)", `payphone` "Payphone (histórico)".
- El listado POS y el detalle muestran "Pago: datáfono · aut. XXXX".

## Interfaz

- Caja del dueño (`panel/src/page.js`) y modo cajero (`panel/src/mesero.js`): en pedidos `pending`/`confirmed`, botón **"Cobrado con datáfono"** que abre un formulario con "Número de autorización" (obligatorio) y "Últimos 4 dígitos" (opcional), con texto de ayuda "Cobra primero en el datáfono y copia el número de autorización del voucher". Confirmar envía la ruta; errores en español (`caja_cerrada` → "Abre la caja de esta sede para cobrar", `pago_en_curso` → "Este pedido tiene un pago con tarjeta en curso. Verifícalo antes de cobrar con datáfono").
- `shared/ticket.js#shiftTicketLines` usa las etiquetas nuevas.

## Partes

| Parte | Archivos |
|---|---|
| G · backend | `panel/migrations/0013_pago_canal.sql`, `panel/src/orders.js` (pago datáfono), `panel/src/bendo.js` (canal `link`), `panel/src/turnos.js` (agrupación), `panel/src/api.js` (ruta `pay-datafono`), `panel/test/datafono.test.mjs` |
| H · interfaz | `panel/src/page.js`, `panel/src/mesero.js`, `shared/ticket.js`, `panel/test/ui-datafono.test.mjs` |
| Ensamblador / QA | integración, prueba de extremo a extremo y QA |
