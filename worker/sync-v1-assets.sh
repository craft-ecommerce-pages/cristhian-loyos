#!/usr/bin/env bash
# Sincroniza la copia fijada de los assets del motor que publica el Worker de menú.
# Workers Assets sirve worker/assets/v1/*; el repo v1/ es la fuente canónica del motor.
# Se ejecuta en craft-dev/local, antes de desplegar. No se ejecuta en GitHub Actions.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES=(catalog.js catalog.css geo.js)

for f in "${FILES[@]}"; do
  [[ -f "$ROOT/v1/$f" ]] || { echo "falta v1/$f" >&2; exit 1; }
  cp "$ROOT/v1/$f" "$ROOT/worker/assets/v1/$f"
done

echo "Assets /v1 sincronizados en worker/assets/v1:"
sha256sum "$ROOT/worker/assets/v1/catalog.js" "$ROOT/worker/assets/v1/catalog.css" "$ROOT/worker/assets/v1/geo.js"
