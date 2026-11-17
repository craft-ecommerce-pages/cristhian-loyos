# Menú: jerarquía de categorías y fotos

Estado: vigente desde 2026-11-17. Aplica al menú público de Munch (`worker` + KV/R2 del cliente).

## Estructura

El menú tiene dos niveles, definidos en `data/config.json`:

1. **Grupo (primer selector)**: `category_groups.items` con `slug`, `name`, `emoji` y `categories`.
   Pregunta visible: `category_groups.question` («¿Qué buscas hoy?»).
   - Sushi → categorías `sushi-*`
   - Fast Food → `fastfood-*` (incluye postres)
   - Comida Tradicional → `tradicional-*`
2. **Categoría (barra de chips)**: `categories` + `category_order`. Al elegir un grupo, la barra
   muestra solo sus categorías y el catálogo se filtra a ese grupo. Sin grupo (o tocando «Todo») se
   ve la carta completa con las 16 categorías.

Los productos conservan una sola categoría visible (`categories`) y una categoría de reporte inmutable
(`report_category`: `sushi`, `fastfood`, `tradicional`, `postres`). Los reportes de ventas usan
`report_category`, no la jerarquía visual.

### Categorías vigentes (16)

| Slug | Nombre visible | Emoji |
|---|---|---|
| `sushi-entradas` | Sushi · Entradas | 🥟 |
| `sushi-rollos` | Sushi · Rollos (fríos, especiales, makis y tempurizados) | 🍣 |
| `sushi-sashimi` | Sushi · Sashimi | 🐟 |
| `sushi-arroces` | Sushi · Arroces | 🍙 |
| `sushi-sopas` | Sushi · Sopas y ramen | 🍜 |
| `sushi-combos` | Sushi · Combos estudiantes | 🍱 |
| `sushi-extras` | Sushi · Extras | 🧂 |
| `fastfood-hamburguesas` | Fast food · Hamburguesas | 🍔 |
| `fastfood-papas-carnes` | Fast food · Papas y carnes | 🍟 |
| `fastfood-alitas` | Fast food · Alitas | 🍗 |
| `fastfood-combos` | Fast food · Combos | 🥡 |
| `fastfood-postres` | Fast food · Postres | 🍰 |
| `tradicional-desayunos` | Tradicional · Desayunos | 🍳 |
| `tradicional-almuerzos` | Tradicional · Almuerzos | 🍛 |
| `tradicional-papas-patacones` | Tradicional · Papas y patacones | 🥔 |
| `tradicional-arroces` | Tradicional · Arroces | 🍚 |

Regla: cada categoría debe llevar un emoji **distinto** en el nombre (`config.categories`). El motor
usa el emoji líder como icono del chip y de la sección. La barra de grupo es la única que puede
repetir el emoji de su familia.

## Cómo editar

1. Cambiar nombres/emojis u orden: `data/config.json` → `categories` y `category_order`.
2. Cambiar grupos o la pregunta: `data/config.json` → `category_groups`.
3. Cambiar la categoría de un producto: `scripts/catalog-build.mjs` (fuente) y regenerar:
   `node scripts/catalog-build.mjs && node scripts/catalog-media.mjs && node scripts/catalog-import.mjs`
   - `catalog-build` reescribe `data/media-map.json` con el mapa base; `catalog-media` vuelve a enlazar
     las fotos reales. No editar `data/*.json` a mano si se va a regenerar.
   - `catalog-media` **conserva** las fotos ya aprobadas en `media/products/`. Solo `--refresh`
     las reescribe desde las fuentes (úsalo únicamente si cambió la foto de origen).
4. Publicar (requiere autorización de producción):
   - `node scripts/publish-catalog.mjs` (plan, sin credenciales) y `--apply` para KV + D1.
   - `node scripts/sync-media.mjs --backup` y luego `node scripts/sync-media.mjs` para subir fotos a R2.

## Fotos de rolls

Los productos «N bocados» deben mostrar exactamente N piezas contables en la foto. Reglas:

- Cada producto tiene archivo propio `media/products/<product_id>.webp`; nunca compartir la foto
  entre la porción de 5 y la de 10.
- Las piezas se ven completas, sin apilar ni tapar.
- Formato WebP cuadrado 1200×1200 para que la tarjeta no recorte producto.
- La receta de la imagen sale de `description` en `data/catalog.json`.

El informe de la corrección de fotos del 2026-11-17 está en `.ops/qa-visual/informe-imagenes.md`.
