# Informe de integración de media — Munch

Fecha: 2026-11-11 · Worktree: `munch-wt-integrador` · Rama: `agent/munch-integrador-20261110`

## Resumen

- IDs evaluados: **28**.
- IDs aplicados y verificados en catálogo/KV/media: **26**.
- IDs en bloqueo (conservan la foto anterior): **2**.
- Fuente de verdad: `media/generated/` + `media/generated/manifest.json`; publicación local en `media/products/<id>.webp`; proyecciones en `data/catalog.json`, `data/kv/productos.json` y `data/media-map.json`.
- Los hashes de origen y publicado **no coinciden por diseño**: `catalog-media.mjs` reencoda a WebP 1200 px de ancho y calidad 82. Se conservan ambos para trazabilidad.

## IDs aplicados

| ID | Rama | Fuente generada | SHA-256 origen | Publicado | SHA-256 publicado | URL en catálogo/KV |
|---|---|---|---|---|---|---|
| `sushi-combo-10` | sushi | `media/generated/sushi-combo-10-v2.webp` | `4303ef3d4cffb7bff945c2b151c3dcdf7aa2254d7790f6b311c04486642ee822` | `media/products/sushi-combo-10.webp` | `cfd70270c7a43eb4cab7c7854bc48e870a88171e04ec6ec9978f76d96ca56b3f` | `/media/panel/cristhian-loyos/products/sushi-combo-10.webp` |
| `sushi-combo-15` | sushi | `media/generated/sushi-combo-15-v2.webp` | `42ee4178c4acb1c9cb480935d75eeca2c7893c3d041fc8e0c088449bb060f63a` | `media/products/sushi-combo-15.webp` | `8f7d8170435675782909fc78bad24cdc9af873ffb898495d384a8d778d4c23fb` | `/media/panel/cristhian-loyos/products/sushi-combo-15.webp` |
| `sushi-combo-20` | sushi | `media/generated/sushi-combo-20-v2.webp` | `f6103c42eac38c6a845f64a62a8540e47fa64ad7d40bc9e9e4bba90f2ea4b698` | `media/products/sushi-combo-20.webp` | `15f4fe41645918639a2c55282c804ad914b8a024454bf05847bf134ece42a95e` | `/media/panel/cristhian-loyos/products/sushi-combo-20.webp` |
| `sushi-combo-30` | sushi | `media/generated/sushi-combo-30-v2.webp` | `bde5a1adf7d4c885e2da53de5c80a07966f374be88b3dcff79a09b6f77a59b08` | `media/products/sushi-combo-30.webp` | `70d420a4b9ea2a86cd840defba1be5996edd3fde664a2a705ab6fa51bbf5b57a` | `/media/panel/cristhian-loyos/products/sushi-combo-30.webp` |
| `sushi-combo-40` | sushi | `media/generated/sushi-combo-40-v2.webp` | `26d5bf40eeb2d3f50bb5884771b3096b0744e00c7b727e74d8de74772233814a` | `media/products/sushi-combo-40.webp` | `31deb4bad84c853ae1017f71161f3f819ae89278a727e4d6c779718b91df6fee` | `/media/panel/cristhian-loyos/products/sushi-combo-40.webp` |
| `sushi-combo-50` | sushi | `media/generated/sushi-combo-50-v2.webp` | `fdb9c1f0d54b718a12f663cde79368f285e0eddcfc2e01bd5af3ed31cfde8df5` | `media/products/sushi-combo-50.webp` | `62912d1887c5f32a313537a1db72570f8a532bc93a4325ac7cbdafb3cb4b3ff2` | `/media/panel/cristhian-loyos/products/sushi-combo-50.webp` |
| `tradicional-majado-camaron` | resto | `media/generated/tradicional-majado-camaron-v2.webp` | `a5e297a6775c3acc0cdc84348dd043e397350fc2eb1fbe28a0a7503a9dc48ea6` | `media/products/tradicional-majado-camaron.webp` | `1e021dbb9e80e8806fbe6aea01870eda54c74d47fa49453e54aa943ea6f151cc` | `/media/panel/cristhian-loyos/products/tradicional-majado-camaron.webp` |
| `tradicional-bolon-mixto` | resto | `media/generated/tradicional-bolon-mixto-v2.webp` | `90e131beae511fe9756df17a1b43833f2cf5380e9e35f4ed3fe5fad3435ac966` | `media/products/tradicional-bolon-mixto.webp` | `50d99102ac76952e0f55c7a1dbe6580effdc356cf7feb718ef20e35cf03a9ee3` | `/media/panel/cristhian-loyos/products/tradicional-bolon-mixto.webp` |
| `tradicional-tortillas-camaron` | resto | `media/generated/tradicional-tortillas-camaron-v2.webp` | `04c6524cec3867b397c9e12db4d4c7075cba8209757ed44c6307128d07901d7e` | `media/products/tradicional-tortillas-camaron.webp` | `97c84e4dd3fc1ba125287a884243675a6c783ec304cd2d78179487a11b81bfb9` | `/media/panel/cristhian-loyos/products/tradicional-tortillas-camaron.webp` |
| `tradicional-arroz-moro-ceviche-mixto` | resto | `media/generated/tradicional-arroz-moro-ceviche-mixto-v2.webp` | `4e756273513e2efc934b040908c3d13ba587efe950055ed92996d64c9c602112` | `media/products/tradicional-arroz-moro-ceviche-mixto.webp` | `21b975bf8fd0118c440b7a1f09d1f2fb7d3949f40816ec0542d09ecce8ed0c2e` | `/media/panel/cristhian-loyos/products/tradicional-arroz-moro-ceviche-mixto.webp` |
| `tradicional-majado-huevo` | pendiente-a | `media/generated/tradicional-majado-huevo-v3.webp` | `f4e521d3bf9f99205a116b830b4cbfc0f391ae0b5bc1ec45c42a03cdf26b1254` | `media/products/tradicional-majado-huevo.webp` | `33cc4394ddac9664d20bedd8dd30cd049b2da245f3673d6757936feef8d70420` | `/media/panel/cristhian-loyos/products/tradicional-majado-huevo.webp` |
| `tradicional-majado-queso` | pendiente-a | `media/generated/tradicional-majado-queso-v3.webp` | `6e5c09c8fbfa5c0d7dd56068c7bb99a80ad5f8130855e384e33c18d93c007c3b` | `media/products/tradicional-majado-queso.webp` | `e5976a06ecbd24e6be673135617c171c54b7773644e60dd281a2a821d6833c98` | `/media/panel/cristhian-loyos/products/tradicional-majado-queso.webp` |
| `tradicional-majado-chicharron` | pendiente-a | `media/generated/tradicional-majado-chicharron-v3.webp` | `85a43200396b511aea26965808b94a48279aebbf7d8da4681fb1e03487a17aa4` | `media/products/tradicional-majado-chicharron.webp` | `5048f475a8249fc1f8f3bdf4a08257491faed1af8ba3da7d896f718218547290` | `/media/panel/cristhian-loyos/products/tradicional-majado-chicharron.webp` |
| `tradicional-majado-ceviche` | pendiente-a | `media/generated/tradicional-majado-ceviche-v3.webp` | `e51a80b97be79038e0a0560e291bd30f252ebbbc059ec171bf2fd38f45d33499` | `media/products/tradicional-majado-ceviche.webp` | `05ac43f4faa4427f5ed4156216e9a56c15b70653824afafffbed17ca95c97240` | `/media/panel/cristhian-loyos/products/tradicional-majado-ceviche.webp` |
| `tradicional-bolon-camaron` | pendiente-a | `media/generated/tradicional-bolon-camaron-v3.webp` | `da87c975d9d7c5de2101c4b450c4ce43bee8c9a85198f4986e35156c821e78c1` | `media/products/tradicional-bolon-camaron.webp` | `a8cb5f4535ab1f4377c28a709ae8d521c2696126c416cc2e8c4b018ebf39caf8` | `/media/panel/cristhian-loyos/products/tradicional-bolon-camaron.webp` |
| `tradicional-bolon-chicharron` | pendiente-a | `media/generated/tradicional-bolon-chicharron-v3.webp` | `dd786a0569344707576d00ee3e27c6ae39f7ff115012050e84873641fc8f4607` | `media/products/tradicional-bolon-chicharron.webp` | `5e9bbae1bb33f7ed4733e9074781f46047abf37762add6d8e915b8b2637421c8` | `/media/panel/cristhian-loyos/products/tradicional-bolon-chicharron.webp` |
| `tradicional-bolon-queso` | pendiente-a | `media/generated/tradicional-bolon-queso-v3.webp` | `2971bb58b4fd74f07a8374aa517450d23118028a38015d7181146ffc6884d983` | `media/products/tradicional-bolon-queso.webp` | `34287ebd70e48063bed22afca24d8919bcf9ac5b5d5d4643c86a1d82af87359a` | `/media/panel/cristhian-loyos/products/tradicional-bolon-queso.webp` |
| `tradicional-tortillas-carne` | pendiente-a | `media/generated/tradicional-tortillas-carne-v3.webp` | `8aed7d45b6a9a49cac1832c0c3f5d73b84d4dd9db1d4c5cc2e1ee8d6dd344248` | `media/products/tradicional-tortillas-carne.webp` | `baf25eeb839e2ab023a9ce20900490fad06a6f6999cab365a1d1dadab887a6ce` | `/media/panel/cristhian-loyos/products/tradicional-tortillas-carne.webp` |
| `tradicional-tortillas-arroz-estofado` | pendiente-a | `media/generated/tradicional-tortillas-arroz-estofado-v3.webp` | `2a2dbdf74765164e61e52711d7f56a15f4130b83eca5d9357bb103246f9afb6c` | `media/products/tradicional-tortillas-arroz-estofado.webp` | `87a5b8063f9617c145596a53809110387926e6efe5f74ab57f4b9a1a52683c75` | `/media/panel/cristhian-loyos/products/tradicional-tortillas-arroz-estofado.webp` |
| `tradicional-papas-queso-pollo` | pendiente-b | `media/generated/tradicional-papas-queso-pollo-v3.webp` | `a21474d2a31f41c6a50422ea2fe9577ee5a617bc73aeb5c4e950befb55cc4d20` | `media/products/tradicional-papas-queso-pollo.webp` | `1a7656613e1efeba9ae11fad2d1117ec03373a1b031b632a82d28dd85657e229` | `/media/panel/cristhian-loyos/products/tradicional-papas-queso-pollo.webp` |
| `tradicional-patacones-solos-ensalada` | pendiente-b | `media/generated/tradicional-patacones-solos-ensalada-v3.webp` | `a529172de84bdfdf4fa8a84a521d0e01db4ae3f1ddbb73c416094dbc212f6a7e` | `media/products/tradicional-patacones-solos-ensalada.webp` | `4036adda0effbb5790c0d9f3f9c6d4bcc0c6974758f47603dd72755512985f2c` | `/media/panel/cristhian-loyos/products/tradicional-patacones-solos-ensalada.webp` |
| `tradicional-papa-rellena-camaron` | pendiente-b | `media/generated/tradicional-papa-rellena-camaron-v3.webp` | `4c153cab9bf2bee278671eaf6357659f45856b1f0fb78af798a057a6f35aff25` | `media/products/tradicional-papa-rellena-camaron.webp` | `60e4cce14e8755929f13f4f4a3d5f5b61fe885e4b4a5c37453ff07663bcc2cc3` | `/media/panel/cristhian-loyos/products/tradicional-papa-rellena-camaron.webp` |
| `tradicional-papa-rellena-carne` | pendiente-b | `media/generated/tradicional-papa-rellena-carne-v3.webp` | `bcd533af17e4434576705b005f5f97867ca3a0fa6d1a63db33631e80b2d4e722` | `media/products/tradicional-papa-rellena-carne.webp` | `7585c3d437be41d549e67f13e76d44fe1e66b3d180b25a75e9a5f54d7a14fc8e` | `/media/panel/cristhian-loyos/products/tradicional-papa-rellena-carne.webp` |
| `tradicional-arroz-moro-ceviche-camaron` | pendiente-b | `media/generated/tradicional-arroz-moro-ceviche-camaron-v3.webp` | `4e1605bf42a9be5412c7cbf141cd92eb88d53ae6ab5e1f627d86f0d028c87831` | `media/products/tradicional-arroz-moro-ceviche-camaron.webp` | `0695a6627e11d85c704656c93cc73cb9fcda8ed2efed6d042391c25fb1024390` | `/media/panel/cristhian-loyos/products/tradicional-arroz-moro-ceviche-camaron.webp` |
| `tradicional-arroz-moro-ceviche-pescado` | pendiente-b | `media/generated/tradicional-arroz-moro-ceviche-pescado-v3.webp` | `20d48a48d35486810cbbfa6d335da1ab0fea5e868fc6ba5321482424a7ed4cde` | `media/products/tradicional-arroz-moro-ceviche-pescado.webp` | `8d0b844ac06bce7fa76854d6121bcc17bc0a3dfad317aec3a9fffaeef573f2e2` | `/media/panel/cristhian-loyos/products/tradicional-arroz-moro-ceviche-pescado.webp` |
| `tradicional-arroz-moro-huevo` | pendiente-b | `media/generated/tradicional-arroz-moro-huevo-v3.webp` | `40e17400b0c005afd1b997b688f3abd5ed0af341e794850048f95aba5d4acc1c` | `media/products/tradicional-arroz-moro-huevo.webp` | `ff84b1096768617b03716c91b9544bb56277c572df82e75fff0e571b2f042f76` | `/media/panel/cristhian-loyos/products/tradicional-arroz-moro-huevo.webp` |

## Bloqueos

### `tradicional-tortillas-mixta`

- Estado: **BLOQUEO** (no se declara QA visual completo para este ID).
- Foto vigente conservada: `/media/panel/cristhian-loyos/products/tortillas.webp`.
- Motivo: Generada, no aplicada: la descripción “mixta” no confirma la composición real; se conserva la foto compartida anterior hasta validación de Juan Carlos.
- Acción requerida: confirmar composición/rellenos con Juan Carlos antes de generar o publicar una foto propia.

### `tradicional-papa-mixta`

- Estado: **BLOQUEO** (no se declara QA visual completo para este ID).
- Foto vigente conservada: `/media/panel/cristhian-loyos/products/papa-rellena.webp`.
- Motivo: Sin foto: la descripción no define los rellenos de “mixta”; no se generó ni se publicó una imagen inventada.
- Acción requerida: confirmar composición/rellenos con Juan Carlos antes de generar o publicar una foto propia.

## Verificación de archivos y proyecciones

- Los archivos publicados de los IDs aplicados existen en `media/products/`.
- `data/catalog.json` y `data/kv/productos.json` apuntan a `/media/panel/cristhian-loyos/products/<id>.webp` para todos los IDs aplicados.
- `data/media-map.json` y `media/generated/manifest.json` fueron regenerados por `scripts/catalog-media.mjs`.
- Los dos IDs bloqueados conservan su URL anterior (`tortillas.webp` y `papa-rellena.webp`) en catálogo y KV.

## Reproducibilidad

```bash
node scripts/catalog-media.mjs   # reencoda y regenera media/products, catalog.json, media-map
node scripts/catalog-import.mjs  # regenera data/kv/productos.json
worker/sync-v1-assets.sh          # publica el motor v1 en worker/assets/v1
```
