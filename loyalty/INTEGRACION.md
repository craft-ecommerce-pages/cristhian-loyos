# Integración del club de fidelización

## Ramas y cableado

Se fusionaron con `git merge --no-ff` las ramas `feat/loyalty-a` (API cliente y admin),
`feat/loyalty-b` (Google Wallet) y `feat/loyalty-c` (página `/club` y banner opt-in).
Las tres tenían commits; no hubo conflictos. El Worker `craft-menus` pasa `/club` y
`/club/*` al service binding `LOYALTY` con el `Request` original. Sin binding continúa
el comportamiento anterior del menú o tienda. El banner solo aparece con `config.club`.

## Hallazgos corregidos

1. **Cooldown simultáneo:** la lectura previa a `DB.batch` permitía que dos jugadas
   pasaran el mismo cooldown. La primera escritura del batch ahora comprueba la fecha
   vigente en D1 y revierte toda la transacción si otra jugada se adelantó.
2. **Último cupo simultáneo:** dos jugadas podían elegir el último premio antes de
   insertarlo. El `INSERT` del premio comprueba el stock dentro del batch; si cambió,
   revierte la jugada y responde `409 premio_agotado`. El cliente puede volver a jugar.
   El sorteo usa WebCrypto para que la secuencia no sea predecible desde el navegador.
3. **Tarjeta bajo concurrencia:** los sellos y el premio por tarjeta dependían de un
   valor leído antes del batch. Ahora el umbral se calcula en D1 dentro del batch;
   el premio de sellos se emite una sola vez por tarjeta completada.
4. **PIN de canje simultáneo:** dos fallos podían pisarse y un canje podía cruzarse con
   el quinto fallo o con el vencimiento. Los `UPDATE` de fallo/canje condicionan dueño,
   slug, estado, vencimiento y contador en D1.
5. **Ruleta sin segmentos disponibles:** con todos los premios agotados y peso de
   derrota cero, la API devuelve `segment_index=-1`. La página antes giraba hacia el
   primer premio; ahora presenta directamente el resultado sin premio.
6. **URL de Wallet en HTML privado:** la página aceptaba cualquier `wallet_url` del
   JSON como destino de enlace. Solo acepta la ruta contractual `/club/api/wallet`.
7. **IDs de Wallet:** slug, issuer y teléfono inválidos podían producir IDs rechazados
   por Google; se validan antes de llamadas externas. Un destinatario inválido de
   campaña se cuenta como fallido sin abortar el envío a los demás.
8. **Archivos locales:** `.gitignore` excluye `loyalty/.dev.vars` y `loyalty/.wrangler/`.

La API conserva el aislamiento por `(slug, phone)`: cookies forjadas/de otro slug
dan 401 y premios ajenos dan 404. Los tests cubren geo dentro/fuera/sin coordenadas,
PIN, bloqueo a cinco fallos, canje doble/vencido, tarjeta, admin por slug, límite de
900 destinatarios, JWT RS256, cuota y 404 de Google, escape de HTML y banner opt-in.

## Verificación

Desde la raíz del worktree, con Node 26.11.1:

| Comando | Resultado |
| --- | --- |
| `node --test loyalty/test/` | 52 aprobados, 0 fallidos |
| `node --test v1/` | 24 aprobados, 0 fallidos |
| `node --test worker/lib.test.mjs` | 14 aprobados, 0 fallidos |

## QA HTTP local

Wrangler 4.152.0: `cd loyalty && npx wrangler@4 d1 migrations apply
craft-loyalty --local`, dos claves KV locales `demo:config` y `demo:loyalty` con
`npx wrangler@4 kv key put --local --binding MENUS`, secretos de prueba en
`loyalty/.dev.vars`, y `npx wrangler@4 dev --local --ip 127.0.0.1 --port 8787`.
Se enviaron requests a `127.0.0.1:8787` con `Host: demo.craft-systems.com`.

Pasaron 17 comprobaciones HTTP: HTML `/club`, 401 sin sesión, login, `me`, geo
fuera, sin coordenadas, PIN incorrecto, geo dentro con premio, cooldown, PIN de
canje incorrecto, canje, doble canje, stats, customers, listado y creación de
campañas, y 401 admin sin token. Otra cuenta jugó por PIN y su detalle admin
registró `via=pin`. Un menú `nogeo` sin sedes coordenadas jugó con `via=nogeo`.
No hubo llamadas reales a Google ni Cloudflare; Wallet no se configuró localmente.

## Riesgos abiertos y preparación para producción

- El producto decidió login sin OTP: conocer el teléfono permite entrar a la cuenta
  y ver/canjear sus premios si también se conoce el PIN del local. Antes de abrir a
  clientes reales, decidir si se acepta ese riesgo o agregar verificación de teléfono.
  La cookie HMAC no tiene caducidad firmada; `Max-Age` solo limita al navegador.
- El PIN de presencia admite intentos ilimitados; conviene añadir rate limiting por
  IP/teléfono y rotación operativa. También faltan política de retención/borrado de
  nombre, teléfono y coordenadas de visitas.
- Si el último cupo se agota entre sorteo y batch, la solicitud devuelve 409 y el
  cliente debe repetir la jugada. No se emite premio ni se consume visita en ese caso.
- Wallet se probó con `fetch` simulado. Validar en un issuer de prueba la aprobación
  de clase y los payloads de Google, sobre todo `secondaryLoyaltyPoints` y mensajes.
  No se usaron credenciales reales en esta integración.
- Antes de publicar: crear D1 real y reemplazar `database_id` pendiente en
  `loyalty/wrangler.toml`; configurar `SESSION_SECRET`, `ADMIN_TOKEN` y, si procede,
  `GW_SA_JSON`; desplegar `craft-loyalty` y `craft-menus` con su service binding;
  preparar `demo:loyalty`/`demo:config` equivalentes para un piloto real y sincronizar
  `config.club` desde craft-crm solo cuando el club esté habilitado. Validar en móvil
  la ruleta, raspadita, GPS y el canje en mesa antes de escalar.

No se hizo deploy, push, creación de D1 remota ni acceso a Google/Cloudflare reales.

## Segunda QA (arquitecto, 2026-10-22)

Corregido:

1. **La página se rompía con el Worker compilado** (`__name is not defined`). `page.js` inyecta el runtime
   con `String(fn)` y el bundle de wrangler (esbuild `keepNames`) mete `__name(...)` en esas funciones; en
   los tests de Node no hay bundle, por eso no aparecía. La página define un `__name` nulo antes del runtime.
   Test de regresión en `page.test.mjs`. Se detectó con Chrome headless contra `wrangler dev`.
2. **La raspadita no tenía nada debajo**: se raspaba un fondo vacío y después saltaba al resultado. Ahora
   el resultado del servidor va bajo la capa (se ve aparecer el premio) y el resultado sale 0,9 s después.
3. **PIN adivinable por fuerza bruta**: `/play` aceptaba intentos de PIN ilimitados (10.000 combinaciones);
   con el PIN un cliente canjea sus propios premios sin mesero. Rate limit nativo `PIN_LIMITER`
   (`[[ratelimits]]` en wrangler.toml, 10/min por slug + IP) en play y redeem → `429 demasiados_intentos`.

Verificado con Google real (no simulado): `walletSaveUrl` creó la clase `demo-club` en el issuer en modo demo.

QA visual (Chrome headless móvil 390×844, `wrangler dev --local`): login → tarjeta → elegir juego →
ruleta → resultado y reseña → raspadita → ganó → canje con PIN → "Usado". Sin errores JS.
