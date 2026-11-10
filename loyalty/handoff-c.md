# Handoff — workstream C (página `/club` + banner en el menú)

Estado: **terminado y en verde** (`node --test loyalty/test/`, `node --test v1/`, `node --test worker/lib.test.mjs`).
Rama `feat/loyalty-c`. No se tocó el contrato (`contract.js`), ni `api.js`, ni `wallet.js`, ni `craft-crm`, ni el repo principal.

## Qué hice

### `loyalty/src/page.js` — página pública del club

`renderPage(menuCfg, cfg)` devuelve el HTML completo con CSS y JS inline (sin librerías ni requests externos
más allá de las Google Fonts que ya trae el menú):

- **SSR**: marca del menú (logo, `store_name`, `theme_primary`/`theme_accent`, `fonts`, favicon), login
  (nombre + WhatsApp), chips de juegos y premios, footer con `terms` y `window.__CLUB__` con el `program`
  del contrato (misma forma que `Me.program`) para pintar el login sin sesión.
- **Runtime vanilla**: `/club/api/me` al arrancar; si 401 queda el login SSR.
  - **Inicio**: tarjeta visual `stamps/stamps_goal` (máx. 40 círculos), texto "N de M sellos", premio por
    completar tarjeta, botón **Jugar** o **Vuelve pronto** + cuenta regresiva hasta `next_play_at`
    (repinta cada 15 s y recarga `/me` al llegar a cero), premios activos (con **Canjear**) y usados/vencidos,
    botón **Guardar en Google Wallet** solo si `me.wallet_url`, y enlace **Ver menú** → `/`.
  - **Elegir juego** si `program.games` tiene más de uno.
  - **Ruleta** en canvas: segmentos de `program.segments`, colores de la marca, 5 vueltas y freno exacto en
    `result.segment_index` (helper `wheelStopAngle`).
  - **Raspadita** en canvas: se borra con el dedo (pointer events), revela automáticamente al 50 % medido
    por píxeles (`revealPercent`) y tiene botón **Revelar** para teclado/accesibilidad. El texto del premio
    no está en el DOM hasta el resultado.
  - **Resultado**: confeti CSS si ganó; premio; **Canjear ahora** / **Guardar para después**; bloque aparte
    **¿Te gustó? Déjanos tu reseña** solo si `review_url` (nunca como condición, ni siquiera al perder).
  - **Jugar**: pide `navigator.geolocation` solo con `geo_required`; manda `lat/lng`; si no hay permiso o el
    servidor responde `sin_ubicacion`/`pin_invalido` muestra la pantalla "Pídele al mesero el PIN…" y
    reintenta `POST /play` con `pin`; `fuera_de_rango` explica y ofrece el PIN; `cooldown` (429) avisa y
    vuelve al inicio con cuenta regresiva.
  - **Canje**: modal "Muestra esta pantalla al mesero" + PIN de 4 dígitos → `POST /redeem`; muestra
    `attempts_left`; maneja 409 (`ya_canjeado`/`vencido`/`sin_pin`) y 423 (`bloqueado`).
  - Logout → `POST /logout` y recarga `/club`. Cualquier 401 que no sea el `GET /me` inicial recarga la
    página (sesión vencida a mitad de jugada/canje).
- **Copy**: español neutro con tuteo (test que prohíbe voseo).
- **Seguridad**: todo texto del cliente se escapa (`esc`) en SSR y en el runtime; URLs de logo/favicon/fonts
  pasan por `safeUrl` (solo `https://` o ruta absoluta del sitio); colores solo hex (si no, default). El JSON
  embebido neutraliza `<` para no romper el `<script>`.

### `v1/catalog.js` + `v1/catalog.css` — banner del club (opt-in)

`config.club = {label?}` (objeto) agrega un botón flotante `🎁 <label | "Juega y gana">` → `/club`.
Sin la clave no se crea nada (menú byte-idéntico en comportamiento). El label se pinta con `textContent`
(nunca HTML). `cart.js` no se tocó.

Para poder testear la lógica pura en Node, `catalog.js` quedó con un guard `typeof document !== "undefined"`
alrededor del IIFE y `module.exports = { clubBanner }`; en el navegador se comporta igual que antes.

## Decisiones

1. **Una sola copia del código cliente**: los helpers puros (`esc`, `wheelStopAngle`, `revealPercent`,
   `remainingText`) se definen una vez en `page.js` y se inyectan al navegador con `String(fn)`; el runtime
   completo se inyecta igual. Evita duplicar la copia "servidor" y la "navegador" y permite que los tests
   evalúen exactamente el código que corre en el teléfono.
2. **Login SSR + runtime**: el formulario sale en el HTML (primer paint útil, marca visible, sin flash de
   pantalla vacía) y el runtime solo se encarga de la sesión. Al cerrar sesión se recarga `/club`.
3. **Pre-chequeo de geo en el cliente**: con `geo_required` se pide ubicación antes de `POST /play` (mejor
   UX y menos escrituras); el servidor sigue siendo la autoridad y sus 403 se manejan igual.
4. **PIN también desde `fuera_de_rango`**: el contrato permite `via='pin'` sin importar coordenadas; ofrecer
   ese camino al cliente que está en el local con GPS impreciso evita visitas perdidas.
5. **Wallet desde `me.wallet_url`**: la página no decide si Wallet está disponible, solo pinta el botón si
   `/me` lo devuelve (workstream B/A). Si es `null`, no aparece.
6. **El premio no se filtra antes de tiempo**: la raspadita no lleva el label en el HTML; el resultado se
   pinta después de la animación/revelado.
7. **Banner abajo a la izquierda**, espejo de la burbuja de WhatsApp (derecha), y sube cuando aparece el
   `cart-peek` (selector de hermanos, sin `:has`).

## Supuestos sobre la API (workstream A)

- `POST /login` y `GET /me` devuelven **`Me`** como cuerpo (no `{me: ...}`), con `program` idéntico al del
  contrato (`store_name, logo, theme_primary, theme_accent, games, segments[{id,label}], stamps_goal,
  stamps_reward_label, cooldown_hours, review_url, terms, geo_required`).
- `POST /play` → `{result: {segment_index, won, prize:{id,label}|null, reward_id, card_completed,
  stamps_reward_id}, me}`.
- `POST /redeem` → `{reward, me}`; errores con `error` y, para PIN, `attempts_left`.
- `next_play_at` en epoch ms.
- `GET /logout` no se usa; `POST /logout` → 204.
- La API se consume con rutas absolutas `/club/api/*` y cookies del mismo origen (sin CORS).

## Cómo probar

```bash
cd /home/jcadmin/proyectos/dev/craft-catalog-engine-wt/loyalty-c
node --test loyalty/test/page.test.mjs   # 19 tests: SSR, escape, helpers, runtime con DOM falso
node --test loyalty/test/                # suite del worker (incluye contrato)
node --test v1/                          # motor (incluye club.test.cjs)
node v1/club.test.cjs                    # banner puro
```

El test de runtime levanta los scripts reales del HTML en `node:vm` sobre un DOM mínimo (sin dependencias) y
cubre: inicio, jugar con geo → resultado, cooldown 429, PIN por permiso denegado, fuera de rango, canje con
PIN incorrecto + canje OK, login (error y éxito), logout y sesión vencida a mitad de flujo (recarga).

QA manual (cuando el integrador cablee el service binding / `wrangler dev --local`):
`/club` sin cookie → login; con cookie → tarjeta; jugar con y sin geo; PIN; canjear; `/me` 401;
menú sin `config.club` → sin banner.

## Riesgos / pendientes

- **Sin E2E de navegador real**: canvas, transición CSS de la ruleta, `getImageData` de la raspadita y
  geolocalización están simulados en los tests (lógica sí cubierta). Validar en teléfono antes de producción.
- **Costo de la raspadita**: lee `getImageData` del canvas completo cada 150 ms mientras se rasca; en
  teléfonos muy lentos puede notarse. Si molesta, bajar a muestreo por zonas o threshold.
- **Nombres de juego**: el mapa `Ruleta`/`Raspadita` está duplicado (SSR y runtime) a propósito para no
  agrandar `__CLUB__`; si se agrega un juego, tocar ambos.
- **`normalizeConfig` se aplica de nuevo** en `programOf` (idempotente, barato) para que `renderPage` no
  dependa de que el llamador ya haya normalizado.
- **i18n**: la página es solo español (el contrato no define `locale` para el club). Si se quiere inglés,
  hace falta un diccionario como el del motor y un campo en la config.
- **Banner**: aparece en todos los menús con `config.club` aunque el club esté apagado (`enabled:false` →
  el Worker responde 404). El sync de craft-crm debería escribir/borrar `config.club` a la par de
  `{slug}:loyalty`; eso es responsabilidad del integrador/CRM.
- **Wallet**: el botón es un `<a>` directo a `me.wallet_url`; si B devuelve una URL absoluta también
  funciona, pero no se valida el origen (se escapa el atributo).
