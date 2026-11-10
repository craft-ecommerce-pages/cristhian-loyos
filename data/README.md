# Carta unificada — Cristhian Loyos (seis food trucks)

Fuente canónica de contenido: `data/catalog.json` (documento nativo del panel) y `data/config.json`.
Este directorio se genera con scripts locales; **no** se despliega ni se escribe en KV/D1/R2 desde aquí.

## Contenido

| Archivo | Uso |
|---|---|
| `catalog.json` | Documento nativo del panel (`categories`, `products`, `variants`, media). |
| `config.json` | Config pública del menú, sedes, tema y flag `checkout_orders`. |
| `sedes.json` | IDs estables de sede y contrato del QR (`?sede=`). |
| `media-map.json` | Relación archivo de media → productos; se reescribe al ejecutar `catalog-media`. |
| `kv/productos.json` | Proyección `buildEntries` para KV `<slug>:productos`. |
| `kv/config.json` | Copia para KV `<slug>:config` (misma forma que `config.json`). |

Regenerar:

```bash
node scripts/catalog-build.mjs     # catálogo/config/sedes (precios y textos)
node scripts/catalog-media.mjs     # copia/optimiza media y enlaza fotos existentes
node scripts/catalog-import.mjs    # valida contrato del panel y emite data/kv/*
```

## Criterios aplicados

- **112 productos** en 19 subcategorías visibles, agrupadas en cuatro categorías de reporte:
  `sushi` 58, `fastfood` 12, `postres` 12, `tradicional` 30.
- **Precios**: se guardan como texto `"0.00"` (forma del CRM/panel) y salen de la carta del cliente.
  No se inventó ningún precio. Los importes de origen se trabajan en centavos enteros.
- **Tamaños 5/10 bocados**: son productos separados, no variantes con precio. Así el servidor
  recalcula el importe desde `product_id` sin confiar en el navegador. Las variantes solo expresan
  sabores o picante y **no** llevan precio.
- **Duplicados**: las dos cartas de Arizona Patisserie (imágenes 02 y 05) se unificaron en 12 postres
  únicos; los combos estudiantiles de 10–50 bocados quedaron como seis productos.
- **Sedes**: `sede-01` … `sede-06`, nombre genérico `Food truck N`, dirección `Por confirmar`,
  `universidad` vacía. No se inventaron campus ni marcas.
- **Marca**: Munch, confirmada por Juan Carlos. La portada usa la imagen oficial proporcionada.
- **Sin datos personales**: no se copiaron RUC, correos, teléfonos ni capturas de documentos fuente.

## Checkout nativo (opt-in)

`config.checkout_orders = { enabled: true, api_base: "", poll_ms: 5000 }`.

- Con la clave, `v1/catalog.js` pide la sede por `?sede=` o selector, envía `POST /api/orders`,
  muestra el número de pedido y consulta el estado por polling. **No abre WhatsApp.**
- Sin la clave (o `enabled:false`) el menú conserva el checkout legacy por WhatsApp/CRM sin cambios.
- `api_base` vacío = mismo origen: el Worker de menú debe exponer `/api/*` (service binding al panel).
  Si se usa otro host hay que resolver CORS; no se asumió.
- La sede se guarda en `sessionStorage` para reintentos; la clave de idempotencia se reutiliza
  mientras sede, ítems y cliente no cambien.

## Media

- Origen por defecto: `/media/panel/cristhian-loyos/products/<archivo>.webp`, servido desde R2 por
  el Worker del cliente. `MEDIA_ORIGIN` permite añadir un dominio del cliente al regenerar la carta.
- Fotos usadas: extraídas del docx de desayunos/almuerzos, del banco de imágenes y del lote generado
  por el agente de imágenes (`media/generated/`, marcado “verificar fidelidad”). **No** se usaron
  recortes de cartas compuestas como foto de producto.
- Faltantes exactos y fotos aproximadas: `.ops/imagenes-faltantes.md` (112/112 con foto; 0 pendientes).
- Si se agrega `media/products/<product_id>.webp`, `catalog-media` lo enlaza automáticamente; también
  consume `media/generated/manifest.json`.

## Incertidumbres pendientes de confirmar

1. **Sedes reales**: nombres, direcciones y universidades de los seis food trucks.
2. **Precios estudiantiles**: la carta Munch/Arizona indica precios “ESTUDIANTES presentando carnet”.
   Se cargaron esos importes; falta confirmar si el público general paga otro valor.
3. **Arizona Patisserie**: la carta dice “Menú Exclusivo Universidad Internacional” / “Decanos y
   Alumnos UIDE”. No se incluyó universidad, correo ni dato personal; confirmar alcance del menú.
4. **Postres**: se reportan como `postres`, separados de `fastfood`, y el reporte reconcilia las cuatro categorías.
5. **Rollo Dragón**: la carta solo lista 5 bocados ($5.10); no se creó una porción de 10.
6. **Combos**: el contenido exacto de los combos de alitas/hamburguesa no está detallado en la carta;
   las descripciones son conservadoras.
7. **Fotos compartidas**: majado, bolón, tortillas, papa rellena y arroz moro usan una sola foto para
   varias variantes; reemplazar cuando el cliente entregue fotos individuales.
