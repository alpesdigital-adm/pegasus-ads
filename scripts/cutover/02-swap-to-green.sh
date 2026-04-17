#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Cutover / Step 02: Swap primário para green
# =============================================================================
# RODAR ONDE: VPS Hostinger, /apps/pegasus
# OBJETIVO: trocar o tráfego de pegasus.alpesd.com.br (produção) de BLUE
#           (Neon, pegasus-ads) para GREEN (Supabase, pegasus-ads-green).
#           Blue continua rodando em pegasus-blue.alpesd.com.br como
#           rollback fácil.
#
# SEQUÊNCIA:
#   1. Cria DNS para pegasus-blue.alpesd.com.br
#   2. Recria GREEN com labels Traefik para pegasus.alpesd.com.br
#      (+ mantém pegasus-green.alpesd.com.br para acesso direto)
#   3. Recria BLUE com labels Traefik SÓ para pegasus-blue.alpesd.com.br
#      (perde pegasus.alpesd.com.br)
#
# JANELA DE INCERTEZA: ~10-30s onde ambos containers podem responder ao
# domínio primário. Traefik faz round-robin ou pega o mais novo. Como os
# dois são funcionalmente equivalentes neste ponto (green já validado em
# step 01), OK.
#
# ROLLBACK: rodar scripts/cutover/03-rollback-to-blue.sh
# =============================================================================

set -euo pipefail

cd /apps/pegasus

GREEN_CONTAINER=pegasus-ads-green
GREEN_IMAGE=pegasus-ads:green
BLUE_CONTAINER=pegasus-ads
PRIMARY_HOST=pegasus.alpesd.com.br
GREEN_HOST=pegasus-green.alpesd.com.br
BLUE_HOST=pegasus-blue.alpesd.com.br
VPS_IPV4=187.77.245.144
CF_ZONE_ID="b8a1b94d804aabedaa1af8f50e63ab87"

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# ── 0. Confirmações ─────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "$GREEN_CONTAINER"; then
  echo "ERRO: $GREEN_CONTAINER não está rodando. Rode step 01 primeiro." >&2
  exit 1
fi

echo "VAI TROCAR o tráfego de $PRIMARY_HOST de BLUE (Neon) para GREEN (Supabase)."
echo "Blue fica em $BLUE_HOST como rollback (24-48h)."
echo
echo "Pré-checklist:"
echo "  [ ] Green validado em https://$GREEN_HOST (smoke test OK)"
echo "  [ ] Cron jobs do green rodando (/api/cron/sync-all etc.)"
echo "  [ ] Janela de manutenção OK (~30s de ambiguidade)"
echo
read -p "Prosseguir com o swap? [y/N] " -n 1 -r; echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

# ── 1. DNS para pegasus-blue.alpesd.com.br ──────────────────────────────
log "[1/3] Garantindo DNS para $BLUE_HOST"
CF_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- || true)
if [[ -n "$CF_TOKEN" ]]; then
  existing=$(curl -sS -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$BLUE_HOST&type=A" \
    | jq -r '.result[0].id // empty')
  if [[ -z "$existing" ]]; then
    curl -sS -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
      -d "{\"type\":\"A\",\"name\":\"$BLUE_HOST\",\"content\":\"$VPS_IPV4\",\"proxied\":true}" \
      > /dev/null
    ok "DNS A criado para $BLUE_HOST"
  else
    ok "DNS $BLUE_HOST já existe"
  fi
else
  warn "Sem CLOUDFLARE_API_TOKEN. Crie manualmente: $BLUE_HOST A $VPS_IPV4"
  read -p "DNS pronto? [y/N] " -n 1 -r; echo
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

# ── 2. Recriar GREEN com labels para pegasus.alpesd.com.br + green ──────
log "[2/3] Recriando $GREEN_CONTAINER com labels PRIMARY+GREEN"
docker stop "$GREEN_CONTAINER" >/dev/null
docker rm "$GREEN_CONTAINER" >/dev/null

docker run -d \
  --name "$GREEN_CONTAINER" \
  --restart unless-stopped \
  --env-file /apps/pegasus/.env \
  --network easypanel \
  --label traefik.enable=true \
  --label "traefik.http.routers.pegasus-primary-http.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$GREEN_HOST\`)" \
  --label "traefik.http.routers.pegasus-primary-http.entrypoints=http" \
  --label "traefik.http.routers.pegasus-primary-https.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$GREEN_HOST\`)" \
  --label "traefik.http.routers.pegasus-primary-https.entrypoints=https" \
  --label "traefik.http.routers.pegasus-primary-https.tls=true" \
  --label "traefik.http.routers.pegasus-primary-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.pegasus-ads-green.loadbalancer.server.port=3000" \
  "$GREEN_IMAGE"

docker network connect alpes-ads_supabase_default "$GREEN_CONTAINER"
sleep 3
ok "$GREEN_CONTAINER agora serve $PRIMARY_HOST + $GREEN_HOST"

# ── 3. Recriar BLUE com label só pegasus-blue ───────────────────────────
log "[3/3] Recriando $BLUE_CONTAINER com label APENAS $BLUE_HOST"
docker stop "$BLUE_CONTAINER" >/dev/null
docker rm "$BLUE_CONTAINER" >/dev/null

docker run -d \
  --name "$BLUE_CONTAINER" \
  --restart unless-stopped \
  --env-file /apps/pegasus/.env.blue.backup \
  --network easypanel \
  --label traefik.enable=true \
  --label "traefik.http.routers.pegasus-blue-http.rule=Host(\`$BLUE_HOST\`)" \
  --label "traefik.http.routers.pegasus-blue-http.entrypoints=http" \
  --label "traefik.http.routers.pegasus-blue-https.rule=Host(\`$BLUE_HOST\`)" \
  --label "traefik.http.routers.pegasus-blue-https.entrypoints=https" \
  --label "traefik.http.routers.pegasus-blue-https.tls=true" \
  --label "traefik.http.routers.pegasus-blue-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.pegasus-ads-blue.loadbalancer.server.port=3000" \
  pegasus-ads:latest
ok "$BLUE_CONTAINER agora serve apenas $BLUE_HOST (Neon)"

# IMPORTANTE: .env.blue.backup deve ter DATABASE_URL=Neon (original).
# Se não existir, blue vai re-ler o .env atual → Supabase (BUG).
if [[ ! -f .env.blue.backup ]]; then
  warn "⚠️  .env.blue.backup NÃO existe. Blue está lendo .env atual (Supabase)"
  warn "    → blue NÃO é mais fallback para Neon. Crie antes do swap."
  warn "    Recomendação: preservar .env antes do cutover:"
  warn "      cp .env.backup.<timestamp> .env.blue.backup"
fi

echo
echo "====================================================================="
echo " Swap concluído."
echo "====================================================================="
echo
echo "  Produção : https://$PRIMARY_HOST → GREEN (Supabase) ✓"
echo "  Rollback : https://$BLUE_HOST  → BLUE (Neon)"
echo "  Staging  : https://$GREEN_HOST → GREEN (mesma coisa do primário)"
echo
echo "  Smoke test:"
echo "    curl -sI https://$PRIMARY_HOST/api/docs | head -5"
echo
echo "  Monitorar 24-48h. Se tudo OK, remover blue:"
echo "    bash scripts/cutover/04-remove-blue.sh"
echo
echo "  Se quebrar, rollback:"
echo "    bash scripts/cutover/03-rollback-to-blue.sh"
