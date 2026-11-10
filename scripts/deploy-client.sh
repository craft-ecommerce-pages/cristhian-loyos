#!/usr/bin/env bash
# Despliegue del menú + panel en la cuenta Cloudflare del cliente.
#
# Solo despliega: los tests y la sincronización de assets se ejecutan en craft-dev/local.
# No crea recursos (KV, D1, R2, rate limit, dominios). Los IDs llegan por variables/secrets.
# Uso:
#   scripts/deploy-client.sh             # despliegue real (panel → menú)
#   scripts/deploy-client.sh --dry-run   # valida plantillas y empaquetado, sin tocar la cuenta
#
# Variables requeridas (en producción las inyecta .github/workflows/deploy-client.yml):
#   CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
#   CLIENT_SLUG, MENU_WORKER_NAME, PANEL_WORKER_NAME
#   KV_MENUS_ID, D1_DATABASE_NAME, D1_DATABASE_ID, R2_BUCKET_NAME, RATELIMIT_NAMESPACE_ID
# Opcionales:
#   ENGINE_ORIGIN (/v1 por defecto), SESSION_SECRET, ADMIN_TOKEN,
#   WRANGLER_SPEC (wrangler@4.160.0 por defecto), NO_MIGRATIONS=1,
#   MENU_PUBLIC_URL / PANEL_PUBLIC_URL (smoke GET al final)
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="deploy"
[[ "${1:-}" == "--dry-run" ]] && MODE="dry-run"
[[ $# -le 1 ]] || { echo "uso: $0 [--dry-run]" >&2; exit 2; }

log() { printf '[deploy-client] %s\n' "$*"; }
die() { printf '[deploy-client] ERROR: %s\n' "$*" >&2; exit 1; }

need() { [[ -n "${!1:-}" ]] || die "falta la variable $1"; }
check() { [[ "${!1:-}" =~ $2 ]] || die "$1 no tiene el formato esperado ($3)"; }

for v in CLIENT_SLUG MENU_WORKER_NAME PANEL_WORKER_NAME KV_MENUS_ID D1_DATABASE_NAME D1_DATABASE_ID R2_BUCKET_NAME RATELIMIT_NAMESPACE_ID; do
  need "$v"
done
if [[ "$MODE" == "deploy" ]]; then
  need CLOUDFLARE_API_TOKEN
  need CLOUDFLARE_ACCOUNT_ID
fi

check CLIENT_SLUG '^[a-z0-9]+(-[a-z0-9]+)*$' 'minúsculas, números y guiones, tipo "mi-cliente"'
check MENU_WORKER_NAME '^[a-z0-9][a-z0-9-]{0,62}$' 'nombre de Worker'
check PANEL_WORKER_NAME '^[a-z0-9][a-z0-9-]{0,62}$' 'nombre de Worker'
check KV_MENUS_ID '^[a-f0-9]{32}$' 'id de KV namespace'
check D1_DATABASE_ID '^[a-f0-9-]{36}$' 'id de D1'
check D1_DATABASE_NAME '^[a-z0-9][a-z0-9-]{0,62}$' 'nombre de D1'
check R2_BUCKET_NAME '^[a-z0-9][a-z0-9-]{1,61}$' 'nombre de bucket R2'
check RATELIMIT_NAMESPACE_ID '^[0-9]+$' 'id numérico de rate limit namespace'
[[ "$MENU_WORKER_NAME" != "$PANEL_WORKER_NAME" ]] || die "MENU_WORKER_NAME y PANEL_WORKER_NAME deben ser distintos"

export ENGINE_ORIGIN="${ENGINE_ORIGIN:-/v1}"
export MENU_PUBLIC_URL="${MENU_PUBLIC_URL:-}"
check ENGINE_ORIGIN '^(/[A-Za-z0-9._-]+|https://[A-Za-z0-9./_-]+)$' '/v1 o una URL https'

# Los assets del motor se publican desde este Worker; deben coincidir con v1/ (fuente canónica).
for f in catalog.js catalog.css geo.js; do
  [[ -f "$ROOT/worker/assets/v1/$f" ]] || die "falta worker/assets/v1/$f; ejecuta worker/sync-v1-assets.sh"
  cmp -s "$ROOT/v1/$f" "$ROOT/worker/assets/v1/$f" ||
    die "worker/assets/v1/$f no coincide con v1/$f; ejecuta worker/sync-v1-assets.sh y revisa el diff"
done
log "assets /v1 verificados contra v1/"

WRANGLER=(npx --yes "${WRANGLER_SPEC:-wrangler@4.160.0}")
"${WRANGLER[@]}" --version >/dev/null 2>&1 || die "no se pudo ejecutar wrangler (revisa WRANGLER_SPEC/red)"
WVER="$("${WRANGLER[@]}" --version 2>/dev/null | tail -n 1)"
[[ "$WVER" =~ ^4\. ]] || die "se requiere Wrangler 4 (detectado: $WVER)"
log "wrangler $WVER · modo $MODE"

# Renderiza las plantillas versionadas a configuraciones locales (ignoradas por git).
render() {
  local src="$1" dst="$2"
  node --input-type=module -e '
    import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
    import { dirname } from "node:path";
    const [src, dst] = process.argv.slice(1);
    const out = readFileSync(src, "utf8").replace(/\$\{([A-Z0-9_]+)\}/g, (_, k) => {
      const v = process.env[k];
      if (v === undefined) throw new Error(`variable ${k} no definida`);
      if (/[\r\n]/.test(v)) throw new Error(`variable ${k} contiene salto de línea`);
      return v;
    });
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, out);
  ' "$src" "$dst"
  log "config → ${dst#"$ROOT/"}"
}

render "$ROOT/panel/wrangler.toml" "$ROOT/panel/.wrangler/client.toml"
render "$ROOT/worker/wrangler.toml" "$ROOT/worker/.wrangler/client.toml"

PANEL_CFG="$ROOT/panel/.wrangler/client.toml"
MENU_CFG="$ROOT/worker/.wrangler/client.toml"

if [[ "$MODE" == "dry-run" ]]; then
  OUTDIR="$ROOT/.wrangler/dry-run"
  mkdir -p "$OUTDIR"
  "${WRANGLER[@]}" deploy --dry-run --outdir "$OUTDIR/panel" --config "$PANEL_CFG"
  "${WRANGLER[@]}" deploy --dry-run --outdir "$OUTDIR/menu" --config "$MENU_CFG"
  log "dry-run OK: configuración y bundles válidos (sin desplegar)"
  exit 0
fi

# 1) Migraciones D1 (wrangler captura backup automático antes de aplicar; en CI no pregunta).
if [[ "${NO_MIGRATIONS:-0}" != "1" ]]; then
  log "aplicando migraciones D1 de $D1_DATABASE_NAME"
  "${WRANGLER[@]}" d1 migrations apply "$D1_DATABASE_NAME" --remote --config "$PANEL_CFG"
else
  log "migraciones D1 omitidas (NO_MIGRATIONS=1)"
fi

# 2) Panel primero: el menú declara el service binding PANEL y debe existir.
log "desplegando panel ($PANEL_WORKER_NAME)"
"${WRANGLER[@]}" deploy --config "$PANEL_CFG"

# 3) Secrets del panel (solo si se inyectan; los ya configurados persisten entre deploys).
#    Se aplican después del primer deploy porque el Worker debe existir para `secret put`.
put_secret() {
  local name="$1" value="${!1:-}"
  [[ -n "$value" ]] || { log "secret $name sin valor en el entorno: se conserva el existente"; return 0; }
  printf '%s' "$value" | "${WRANGLER[@]}" secret put "$name" --config "$PANEL_CFG" >/dev/null
  log "secret $name actualizado"
}
put_secret SESSION_SECRET
put_secret ADMIN_TOKEN
put_secret PAYPHONE_TOKEN

# 4) Menú con sus assets locales /v1.
log "desplegando menú ($MENU_WORKER_NAME)"
"${WRANGLER[@]}" deploy --config "$MENU_CFG"

# 5) Smoke opcional (sin secretos): home + asset del motor en el menú; /panel en el panel.
smoke() {
  local label="$1" base="${2%/}" path="${3:-/}"
  [[ -n "$base" ]] || return 0
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$base$path" || true)"
  log "smoke $label $path → HTTP ${code:-sin respuesta}"
}
smoke menú "${MENU_PUBLIC_URL:-}" "/"
smoke menú "${MENU_PUBLIC_URL:-}" "/v1/catalog.js"
smoke panel "${PANEL_PUBLIC_URL:-}" "/panel"

log "despliegue completado. Panel: $PANEL_WORKER_NAME · Menú: $MENU_WORKER_NAME"
