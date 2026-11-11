# Inventario de media — pendiente-a

Fecha: 2026-11-10. Alcance: `tradicional-majado-*`, `tradicional-bolon-*`, `tradicional-tortillas-*`, excluyendo los tres IDs de estos grupos que ya tenían `-v2` (`tradicional-majado-camaron`, `tradicional-bolon-mixto`, `tradicional-tortillas-camaron`). El cuarto `-v2` del inventario general (`tradicional-arroz-moro-ceviche-mixto`) está fuera de este alcance.

Se buscó primero en el banco local (`media/products/majado.webp`, `bolon.webp`, `tortillas.webp`). Ninguna de las diez fotos locales era exacta: omitía ingredientes o acompañamientos descritos. Se generó una foto por ID con la herramienta integrada `image_gen`; no se usó CLI/API/llave. Todas fueron revisadas en contacto visual, convertidas a WebP con `-strip -quality 82` y guardadas sin sobrescribir.

| ID | Descripción canónica exacta | Foto nueva | Motivo | SHA-256 | Resultado visual |
|---|---|---|---|---|---|
| `tradicional-majado-huevo` | Majado de verde con huevo frito y café. | `media/generated/tradicional-majado-huevo-v3.webp` | Banco `majado.webp` no muestra café y huevo de forma verificable. | `f4e521d3bf9f99205a116b830b4cbfc0f391ae0b5bc1ec45c42a03cdf26b1254` | OK-generada: majado, huevo frito y café visibles; sin texto/logo/manos. |
| `tradicional-majado-queso` | Majado de verde con queso y huevo frito. | `media/generated/tradicional-majado-queso-v3.webp` | Banco no muestra queso y huevo de forma verificable. | `6e5c09c8fbfa5c0d7dd56068c7bb99a80ad5f8130855e384e33c18d93c007c3b` | OK-generada: majado, queso fresco y huevo visibles; sin café ni elementos ajenos. |
| `tradicional-majado-chicharron` | Majado de verde con chicharrón, huevo frito y café. | `media/generated/tradicional-majado-chicharron-v3.webp` | Banco omite chicharrón, café y huevo verificable. | `85a43200396b511aea26965808b94a48279aebbf7d8da4681fb1e03487a17aa4` | OK-generada: majado, chicharrón, huevo y café visibles. |
| `tradicional-majado-ceviche` | Majado de verde con ceviche, huevo frito y café. | `media/generated/tradicional-majado-ceviche-v3.webp` | Banco omite ceviche, café y huevo verificable. | `e51a80b97be79038e0a0560e291bd30f252ebbbc059ec171bf2fd38f45d33499` | OK-generada: majado, ceviche, huevo y café visibles. |
| `tradicional-bolon-camaron` | Bolón de verde con camarón, huevo frito y café. | `media/generated/tradicional-bolon-camaron-v3.webp` | Banco `bolon.webp` omite camarón y café. | `da87c975d9d7c5de2101c4b450c4ce43bee8c9a85198f4986e35156c821e78c1` | OK-generada: bolón, camarones, huevo y café visibles. |
| `tradicional-bolon-chicharron` | Bolón de verde con chicharrón, huevo frito y café. | `media/generated/tradicional-bolon-chicharron-v3.webp` | Banco omite chicharrón y café. | `dd786a0569344707576d00ee3e27c6ae39f7ff115012050e84873641fc8f4607` | OK-generada: bolón, chicharrón, huevo y café visibles. |
| `tradicional-bolon-queso` | Bolón de verde con queso, huevo frito y café. | `media/generated/tradicional-bolon-queso-v3.webp` | Banco omite queso y café. | `2971bb58b4fd74f07a8374aa517450d23118028a38015d7181146ffc6884d983` | OK-generada: bolón, queso, huevo y café visibles. |
| `tradicional-tortillas-carne` | Dos tortillas de verde con porción de carne de pollo o res y huevo frito. | `media/generated/tradicional-tortillas-carne-v3.webp` | Banco no verifica carne ni huevo. | `8aed7d45b6a9a49cac1832c0c3f5d73b84d4dd9db1d4c5cc2e1ee8d6dd344248` | OK-generada: exactamente dos tortillas, pollo, huevo; sin rótulo. |
| `tradicional-tortillas-arroz-estofado` | Dos tortillas de verde con arroz, estofado y huevo frito. | `media/generated/tradicional-tortillas-arroz-estofado-v3.webp` | Banco omite relleno y contiene rótulo. | `2a2dbdf74765164e61e52711d7f56a15f4130b83eca5d9357bb103246f9afb6c` | OK-generada: dos tortillas, arroz, estofado y huevo visibles; sin texto/logo. |
| `tradicional-tortillas-mixta` | Dos tortillas de verde en versión mixta. | `media/generated/tradicional-tortillas-mixta-v3.webp` | Banco no identifica la mezcla y contiene rótulo. | `6116649602c6cb6721c19a0957f05d6308b594a1088144aeec94055821084c92` | OK-generada: dos tortillas, mezcla visible de camarón, queso, chicharrón y huevo; `BLOQUEO` semántico por composición no definida. |

## Bloqueo explícito

`tradicional-tortillas-mixta` tiene descripción ambigua: no define qué significa “mixta”. La foto es una interpretación visual razonable y ya no queda `CONDICIONAL`, pero el integrador debe confirmar la mezcla real antes de publicar. Estado: `BLOQUEO`.

