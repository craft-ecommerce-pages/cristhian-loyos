#!/usr/bin/env bash
# Optimiza imágenes para R2 (recompresión + resize + strip metadata) EN LOCAL (usa ImageMagick).
# Recorre TODO el árbol preservando la estructura relativa (para tiendas con media/, producto/,
# funnel/.../images/, etc.). Raster (jpg/png/webp) → recomprime y solo reemplaza si queda más chico;
# svg/gif/avif → se copian tal cual (passthrough). Preserva nombre y formato → NO rompe URLs/refs.
#
#   optimize-images.sh <src_dir> <dst_dir> [maxedge=1920] [quality=82]
#   dst_dir == src_dir → in-place.
#
# Se usa SOLO al onboardear desde local (tienda/menú nuevo) o para comprimir el lote existente.
# Las ediciones del cliente por la UI van directo a R2 sin pasar por aquí.
set -euo pipefail
SRC="${1:?uso: <src_dir> <dst_dir> [maxedge] [quality]}"; SRC="${SRC%/}"
DST="${2:?falta dst_dir}"; DST="${DST%/}"; MAX="${3:-1920}"; Q="${4:-82}"
command -v magick >/dev/null || { echo "falta ImageMagick (magick)"; exit 1; }

before=0; after=0; opt=0; copied=0
while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"; out="$DST/$rel"; mkdir -p "$(dirname "$out")"
  ext="${f##*.}"; ext="${ext,,}"
  case "$ext" in
    jpg|jpeg|png|webp)
      tmp="$(mktemp --suffix=".$ext")"
      # -resize NxN> solo achica si excede · -strip quita metadata · quality→jpg/webp
      if ! magick "$f" -auto-orient -strip -resize "${MAX}x${MAX}>" -quality "$Q" "$tmp" 2>/dev/null; then
        cp -f "$f" "$out"; rm -f "$tmp"; copied=$((copied+1)); continue
      fi
      os=$(stat -c%s "$f"); ns=$(stat -c%s "$tmp")
      if [ "$ns" -lt "$os" ]; then mv -f "$tmp" "$out"; else cp -f "$f" "$out"; rm -f "$tmp"; ns=$os; fi
      before=$((before+os)); after=$((after+ns)); opt=$((opt+1)) ;;
    *) cp -f "$f" "$out"; copied=$((copied+1)) ;;   # svg/gif/avif: passthrough (no se recomprimen)
  esac
done < <(find "$SRC" \( -path '*/.git' -o -path '*/node_modules' \) -prune -o -type f \
  \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.webp' \
     -o -iname '*.gif' -o -iname '*.svg' -o -iname '*.avif' \) -print0)

pct=0; [ "$before" -gt 0 ] && pct=$(((before-after)*100/before))
echo "optimizadas $opt ($(numfmt --to=iec "$before") → $(numfmt --to=iec "$after"), ${pct}% menos) + $copied copiadas → $DST"
