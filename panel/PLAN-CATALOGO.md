# Sprint "Catálogo completo en el panel edge" — contrato

Objetivo: el dueño de un menú edge (`{slug}.craft-systems.com/panel`) administra TODO lo que hoy
ofrece la vertical `catalog` de craft-crm, salvo lo propio del CRM (Agente IA, detección/etiquetas,
Effi, WooCommerce, costo, agente por sede, tipografías, píxeles).

## Arquitectura (decidida con el operador)

- **D1 `craft-panel` es la fuente de verdad del catálogo** (un documento JSON por slug).
- Cada escritura del panel → valida → guarda en D1 (CAS por `version`) → **publica** a KV
  (`{slug}:productos` completo + claves de catálogo en `{slug}:config`).
- El Worker `craft-menus` **solo lee KV**; nunca toca D1. Menús sin cambios = cero escrituras.
- `{slug}:config` (marca, horario, sedes, envío…) sigue viviendo en KV: es un solo documento y ya
  se edita in-place vía `PATCH /store` (no hay desnormalización que justifique D1).
- Pedidos web: el motor manda una copia al panel (`POST /panel/o`) → tabla D1 `orders`.
  El POST al CRM (`catalog_notify_url`) sigue igual.

## Workstreams

| ID | Agente | Repo / worktree | Archivos que toca |
|---|---|---|---|
| K1 | codex gpt-5.6-terra | craft-catalog-engine `wt/cat-k1` (rama `feat/cat-k1`) | `panel/migrations/0002_catalog.sql`, `panel/src/catalog.js` (nuevo), `panel/src/orders.js` (nuevo), `panel/src/api.js`, `panel/src/admin.js`, `panel/src/index.js` (solo ruta `/panel/o`), `panel/test/k1.test.mjs` |
| K2 | codex gpt-5.6-terra | craft-catalog-engine `wt/cat-k2` (rama `feat/cat-k2`) | `panel/src/page.js`, `panel/test/a2.test.mjs` (solo ampliar) |
| K3 | codex gpt-5.6-terra | craft-crm `wt/crm-cat-k3` (rama `feat/cat-k3`) | `internal/catalogsync/export.go` (nuevo) + test, `internal/menusaas/deliver.go`, `internal/menusaas/panel.go` |
| K4 | deepseek-flash (opencode) | craft-catalog-engine `wt/cat-k4` (rama `feat/cat-k4`) | `v1/catalog.js` (solo `panelCount`/beacon de pedido) + test del motor si existe |
| ENS | codex gpt-5.6-sol | `wt/panel-int` + `wt/crm-menu-saas` | merge + paridad + QA |

Nadie toca archivos de otro workstream. Si necesitas algo del contrato, anótalo en tu HANDOFF.

## Documento de catálogo (D1) — `CatalogDoc`

Forma NATIVA del CRM (la misma que exporta K3), no la forma aplanada de KV:

```js
{
  categories: [{ slug, name }],                 // orden del array = orden del menú
  packagings: [{ id, name, price }],            // price: number ≥ 0
  variant_groups: [{                            // grupos reutilizables
    id, name,
    type: "option" | "price_select" | "distribute",
    options: [{ name, price?, image? }],        // price absoluto (price_select); image = URL pública
    pick: int,                                  // distribute: "elige hasta N" (≥1); otros: 0
    optional: bool, item: string
  }],
  products: [{
    id, name,
    type: "producto" | "promocion",
    price: "12.50", promo_price: "",            // strings como el CRM ("" = sin precio)
    packaging_id: string | null,                // → packagings[].id
    packaging_cost: number,                     // legacy si no hay packaging_id (0 normalmente)
    sku: "",                                    // en promos: días getDay "1,2,5" ("" = todos)
    description: "", stock: int | null,         // null = ilimitado, 0 = agotado
    active: bool, catalog_visible: bool,        // solo active && catalog_visible se publican
    images: [url],                              // URLs públicas (media.craft-systems.com)
    categories: [slug],
    variants: [{ name, type, options: [{name, price?, image?} | string],
                 pick?, free?, item?, repeat?, optional? }],   // variantes PROPIAS (crudas)
    groups: [{ group_id, pick_override: int | null }]          // orden del array = position
  }]
}
```

Tabla: `catalogs(slug TEXT PRIMARY KEY, doc TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL)`.
Escritura: `UPDATE … SET doc=?, version=version+1 WHERE slug=? AND version=?` → si 0 filas: 409 `conflicto`.

**Bootstrap perezoso** (menús sin import): si no hay fila para el slug, se arma el doc desde KV
(`{slug}:productos` → products con `variants` = sus `variantes` tal cual, sin groups/packagings;
`config.categories`+`category_order` → categories) y se guarda versión 1. Nunca falla por KV vacío.

## Publicación a KV — `publish(env, slug, doc)` (K1, port de craft-crm)

Port fiel de `craft-crm/internal/catalogsync/service.go` (`buildEntries`, `processVariants`,
`mergeConfig` parte categorías) + `image.go` (`slugify`) + `db.go` (`loadProducts`: filtro y orden,
grupos reutilizables anexados DESPUÉS de las variantes propias, `COALESCE(m.pick_override, g.pick)`,
`costo_empaque` = precio del packaging o `packaging_cost`).

- `{slug}:productos` = `[productEntry]` con claves `id, slug, nombre, tipo, precio, precio_promo,
  costo_empaque, categorias, descripcion, stock, imagenes, variantes, sku` (mismo shape que Go).
- `{slug}:config` = merge sobre lo existente: `categories` (map slug→name), `category_order`,
  `packaging: {enabled:true, mode:"per_product", label:"Empaque"}`. No toca otras claves.
- Orden de escritura: primero productos, luego config.
- Paridad obligatoria: test con fixture (`panel/test/fixtures/catalog-parity.json`: doc de entrada +
  productos esperados) que cubre price_select con price 0/absoluto/price_delta, option con imagen,
  distribute con pick_override, repeat/salsas, NxM pick/free/item, optional, promo con días,
  packaging_id y legacy packaging_cost, producto inactivo/no visible excluido.

## API del panel (sesión de dueño, mismas reglas de CSRF/JSON que hoy)

| Método y ruta | Cuerpo | Respuesta |
|---|---|---|
| `GET /panel/api/catalog` | — | `{ version, ...CatalogDoc }` |
| `POST /panel/api/products` | product sin `id` | 201 product |
| `PUT /panel/api/products/{id}` | product completo | 200 product |
| `DELETE /panel/api/products/{id}` | — | 204 |
| `POST /panel/api/categories` | `{name}` (slug = slugify, único con sufijo -2, -3…) | 201 category |
| `PUT /panel/api/categories/{slug}` | `{name}` (el slug no cambia) | 200 |
| `DELETE /panel/api/categories/{slug}` | — (se quita de los productos) | 204 |
| `PUT /panel/api/categories` | `{slugs:[…]}` (permutación exacta) | 200 categories |
| `POST/PUT/DELETE /panel/api/variant-groups[/{id}]` | group + `product_ids:[…]` (asigna/desasigna, conserva `pick_override` existente) | group con `product_ids` |
| `POST/PUT/DELETE /panel/api/packagings[/{id}]` | `{name, price, product_ids}` (asigna `packaging_id`; borrar lo quita de productos) | packaging con `product_ids` |
| `GET /panel/api/orders?offset=&limit=` | — (limit ≤ 50, más nuevos primero) | `{ orders:[…], total }` |
| `GET/PATCH /panel/api/store` | igual que hoy + campos nuevos (abajo) | config |

Todas las mutaciones de catálogo aceptan `if_version` opcional (si viene y no coincide → 409).
Respuestas de mutación incluyen `version` nueva en el header `x-catalog-version`.
Límites: 500 productos, 100 categorías, 100 grupos, 50 opciones por grupo, 50 packagings,
nombres ≤ 120, descripción ≤ 1000, ≤ 5 imágenes (solo `MEDIA_ORIGIN/…`). Errores `campo_invalido`
con `{campo}` como hoy. `GET/PUT /products` viejo (`{categories, products}` desde KV) se reemplaza:
`GET /panel/api/products` queda como alias de `catalog.products` para no romper.

**STORE_FIELDS nuevos** (validación estricta, en `{slug}:config`):
- `location`: `{ sedes:[{nombre, direccion, telefono?, lat?, lng?, radio_km?}], telefono_principal,
  map_embed (https://www.google.com/maps/embed… o ""), out_of_coverage_message (≤300),
  social:{facebook?, instagram?, tiktok?} (https URLs) }` — lat/lng/radio_km van juntos o ninguno;
  conservar claves desconocidas de cada sede existente (p. ej. `agent_id`) al editar por índice.
- `delivery_fee`: number 0–1000 (2 decimales).
- `cross_sell`: `{ categories:[slug existente], title (≤60), max (1–12) }`.
- `search_placeholder` (≤60). (Ya existen: whatsapp_number, hours, hero_title, brand_sub, logo.)

## Admin (Bearer ADMIN_TOKEN, lo llama craft-crm)

- `PUT /admin/{slug}/catalog` cuerpo `CatalogDoc` → valida igual que el panel, reemplaza el doc
  (version+1), publica a KV. Respuesta `{ version, products, categories }`. Idempotente.
- `GET /admin/{slug}/catalog` → `{ version, ...CatalogDoc }` (soporte).

## Pedidos web

- Motor (K4): en el checkout exitoso, en vez del beacon `{"t":"order"}` manda
  `navigator.sendBeacon("/panel/o", Blob(JSON, application/json))` con
  `{ items:[{nombre,qty,precio,variant?}], total, currency, client_name, client_phone, delivery_mode,
  address?, order_id? }` (reutiliza el `payload` que ya arma, sin `token` ni `store_url`).
  Solo si `window.__CONFIG__` existe (igual que hoy). Las vistas siguen por `/panel/e`.
- Panel (K1): `POST /panel/o` público → siempre 204; valida tamaño (≤ 16 KB), tipos y límites
  (≤ 50 items, textos ≤ 200), rate limit `LOGIN_LIMITER` key `o:{slug}:{ip}`; inserta en
  `orders(id TEXT PK, slug, created_at, total REAL, currency, client_name, client_phone, delivery_mode,
  address, items TEXT)` + índice `(slug, created_at DESC)`; incrementa `events_daily.orders`.
  `/panel/e` con `t:"order"` sigue aceptándose (compatibilidad con motores en caché).

## UI (K2) — mismo sistema visual del rediseño (sidebar, `.table`, `sectioned()`, `.subtabs`, sin pills)

Navegación lateral por grupos: **Menú** (Productos, Variantes, Empaques) · **Ventas** (Pedidos,
Resultados) · **Negocio** (Mi negocio, Fidelidad). En móvil: la misma fila de pestañas subrayadas.

- **Productos** con `.subtabs` Productos · Categorías (n) · Promos (n).
  - Productos: tabla actual + acción rápida "Agotar / Disponible" (stock 0 ↔ null) + estado
    Inactivo/Oculto. Agrupado por categoría (un producto puede salir en varias; "Sin categoría").
  - Categorías: lista tipo tabla con asa ⋮⋮ arrastrable (pointer events) + ↑/↓ por teclado,
    renombrar, eliminar (confirm), "+ Nueva categoría".
  - Promos: tabla de productos `type:"promocion"` con días ("Todos los días" / "Lun, Vie").
- **Formulario de producto** con `sectioned()`: Información (nombre, estado activo, visible en el
  menú, descripción) · Fotos (hasta 5, reordenar, quitar) · Precio (precio, promo, envase `<select>`
  de packagings + "Sin envase") · Categorías (checkboxes, varias) · Stock (Ilimitado / Agotado /
  cantidad) · Variantes propias (editor: nombre, opciones con precio opcional, "elige hasta N"
  (distribute), selectores NxM (pick/free/item), obligatorio/opcional) · Grupos reutilizables
  (checkbox por grupo + "elige hasta" override si es distribute) · Días (solo promo).
- **Variantes**: tabla de grupos (nombre, tipo, opciones, productos) + form por secciones
  (General, Opciones, Productos asignados con buscador).
- **Empaques**: tabla (nombre, precio, productos) + form (nombre, precio, productos asignados).
- **Pedidos**: tabla (fecha/hora EC, cliente, teléfono `wa.me`, entrega, total) + detalle con items.
  Paginación. Vacío: "Aún no hay pedidos desde el menú".
- **Mi negocio**: añadir secciones Envío y cobertura (tarifa fija, por sede: coordenadas
  "lat, lng" + radio km, mensaje fuera de cobertura), Redes y mapa (facebook/instagram/tiktok,
  map_embed), Sugeridos al pedir (cross_sell: categorías, título, máximo), Buscador (placeholder).
- Precios con coma o punto (EC). Todo texto con textContent. Sin dependencias.

## K3 — craft-crm: exportar al entregar

- `catalogsync.ExportCatalog(ctx, pool, businessID) (CatalogDoc, error)`: lee la DB en forma nativa
  (products activos o no, no borrados, orden `position, name`; `product_category_map`;
  `product_categories` por `position, name`; `catalog_variant_groups` no borrados;
  `product_variant_group_map` por `position`; `catalog_packagings` no borrados). Media → URLs con
  `edgeImageURL`; opciones de variantes con imagen por ref → `image` URL (misma lógica que
  `resolveOptImg`). Test con DB de prueba si el repo tiene helper; si no, test de la función pura
  de mapeo.
- `menusaas.Deliver`: tras subir el QR y ANTES de `panelOwnerCreate`, `PUT {PANEL_ADMIN_URL}/admin/{slug}/catalog`
  con el doc (cliente HTTP de `panel.go`, timeout 15 s). Si falla → error y no se crea nada más.
  Solo en la primera entrega (venta `paid`): `regenerate` NO re-exporta (pisaría lo que el dueño ya editó).
