#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Cutover / Step 03: Rollback para blue
# =============================================================================
# OBJETIVO: reverter o swap do step 02. Blue volta a ser pegasus.alpesd.com.br
#           (Neon). Green fica acessível em pegasus-green.alpesd.com.br.
#
# USO: rodar quando green mostrar regressão em produção.
# =============================================================================

set -euo pipefail
cd /apps/pegasus

GREEN_CONTAINER=pegasus-ads-green
GREEN_IMAGE=pegasus-ads:green
BLUE_CONTAINER=pegasus-ads
PRIMARY_HOST=pegasus.alpesd.com.br
GREEN_HOST=pegasus-green.alpesd.com.br
BLUE_HOST=pegasus-blue.alpesd.com.br

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

echo "VAI REVERTER $PRIMARY_HOST: GREEN → BLUE (Neon)."
read -p "Prosseguir? [y/N] " -n 1 -r; echo
[[ "$REPLY" =~ ^[Yy]$ ]] || exit 0

# ── 1. Recriar BLUE com label PRIMARY+BLUE ──────────────────────────────
log "[1/2] $BLUE_CONTAINER volta para $PRIMARY_HOST + $BLUE_HOST"
docker stop "$BLUE_CONTAINER" 2>/dev/null || true
docker rm "$BLUE_CONTAINER" 2>/dev/null || true

# Usa .env.blue.backup (Neon) se existir, senão .env atual
ENV_FILE=/apps/pegasus/.env.blue.backup
[[ -f "$ENV_FILE" ]] || ENV_FILE=/apps/pegasus/.env

docker run -d \
  --name "$BLUE_CONTAINER" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  --network easypanel \
  --label traefik.enable=true \
  --label "traefik.http.routers.pegasus-primary-http.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$BLUE_HOST\`)" \
  --label "traefik.http.routers.pegasus-primary-http.entrypoints=http" \
  --label "traefik.http.routers.pegasus-primary-https.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$BLUE_HOST\`)" \
  --label "traefik.http.routers.pegasus-primary-https.entrypoints=https" \
  --label "traefik.http.routers.pegasus-primary-https.tls=true" \
  --label "traefik.http.routers.pegasus-primary-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.pegasus-ads-blue.loadbalancer.server.port=3000" \
  pegasus-ads:latest
ok "$BLUE_CONTAINER serve $PRIMARY_HOST + $BLUE_HOST"

# ── 2. Recriar GREEN com label SÓ green ─────────────────────────────────
log "[2/2] $GREEN_CONTAINER volta para só $GREEN_HOST"
docker stop "$GREEN_CONTAINER" >/dev/null
docker rm "$GREEN_CONTAINER" >/dev/null

docker run -d \
  --name "$GREEN_CONTAINER" \
  --restart unless-stopped \
  --env-file /apps/pegasus/.env \
  --network easypanel \
  --label traefik.enable=true \
  --label "traefik.http.routers.pegasus-green-http.rule=Host(\`$GREEN_HOST\`)" \
  --label "traefik.http.routers.pegasus-green-http.entrypoints=http" \
  --label "traefik.http.routers.pegasus-green-https.rule=Host(\`$GREEN_HOST\`)" \
  --label "traefik.http.routers.pegasus-green-https.entrypoints=https" \
  --label "traefik.http.routers.pegasus-green-https.tls=true" \
  --label "traefik.http.routers.pegasus-green-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.pegasus-ads-green.loadbalancer.server.port=3000" \
  "$GREEN_IMAGE"
docker network connect alpes-ads_supabase_default "$GREEN_CONTAINER"
ok "$GREEN_CONTAINER serve apenas $GREEN_HOST"

echo
echo "====================================================================="
echo " Rollback concluído. $PRIMARY_HOST de volta para BLUE (Neon)."
echo "====================================================================="
