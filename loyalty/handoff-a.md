# Handoff A — API del cliente y admin

## Qué se implementó

- API cliente completa en `src/api.js`: login/upsert, cookie HMAC ligada al slug, logout, `Me`, jugada con cooldown y presencia geo/PIN/nogeo, sorteo ponderado con stock, emisión transaccional de premios y tarjeta de sellos, canje con bloqueo tras cinco fallos y entrada a Google Wallet.
- API admin completa: autenticación Bearer, estadísticas con días agrupados en UTC-5, listado/búsqueda/detalle de clientes, campañas de Wallet y listado de las últimas campañas.
- `pickSegment(segs, rand)` puro y exportado para probar el sorteo sin red ni aleatoriedad real.
- Respuestas privadas con `Cache-Control: no-store` y `X-Content-Type-Options: nosniff`; cookies `HttpOnly`, `Secure` y `SameSite=Lax`; SQL siempre parametrizado y comparaciones de secretos/PIN de tiempo constante respecto del valor esperado.
- Suite `test/api.test.mjs` sobre D1 real en memoria: 15 casos agrupados y 20 tests totales al sumar el contrato existente.

## Decisiones de interpretación

- Un nombre de más de 60 caracteres se recorta a 60 puntos de código, como pide “máx. 60 caracteres, recortar”; no se rechaza.
- Si todos los premios tienen stock agotado y `lose_weight=0`, la jugada válida devuelve `segment_index: -1`, `won: false` y suma el sello. No existe un segmento visible de derrota en ese caso.
- El stock cuenta todos los premios emitidos históricamente, incluidos canjeados y vencidos, porque el contrato define `stock` como máximo emitido total.
- En estadísticas, `customers`, `returning_customers` y `cards_completed` son acumulados; `new_customers`, `plays`, `rewards_issued` y `rewards_redeemed` respetan `days`. Un premio emitido antes del período pero canjeado dentro del período sí cuenta como canjeado.
- `by_day` incluye únicamente días con altas o jugadas y usa fecha calendario UTC-5.
- Las recompensas vencidas se calculan al leer; no se muta su `status` persistido, conforme a la migración.

## Cómo probar

Desde la raíz del worktree:

```bash
node --test loyalty/test/
```

Resultado al entregar: 20 tests, 20 aprobados.

## Integración con workstream B

`api.js` importa exclusivamente `walletEnabled`, `walletSaveUrl`, `walletSync` y `walletNotify` con las firmas acordadas. En esta rama, el stub hace que una campaña registre cada destinatario como fallido; el test deja explícita esa simulación. Tras fusionar B deben repetirse todos los tests para confirmar el comportamiento con el doble de `fetch` de Wallet.

## Riesgos y pendientes para QA

- El contrato no incorpora rate limiting para login/admin ni retención/borrado de nombre, teléfono y geolocalización. Conviene cubrir ambos controles en infraestructura o en una fase posterior de privacidad; no se amplió el esquema fuera del workstream.
- Cooldown y disponibilidad de stock se leen antes del `DB.batch`, exactamente como prescribe el plan. Dos solicitudes realmente simultáneas podrían superar el cooldown o el último cupo; QA/integración debe decidir si la fase siguiente requiere serialización adicional en D1.
- La ruta Wallet se probó en el caso deshabilitado. El redirect exitoso y los efectos externos quedan cubiertos por el workstream B con Google simulado, sin red real.
- No existe manifiesto ni lockfile npm en este worktree; no hubo dependencias que instalar ni auditoría de paquetes aplicable.
