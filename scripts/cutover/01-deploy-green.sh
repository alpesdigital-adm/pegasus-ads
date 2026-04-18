#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Cutover / Step 01: Deploy (ou redeploy) green container
# =============================================================================
# RODAR ONDE: VPS Hostinger, dentro de /apps/pegasus
#
# MODOS (auto-detectados):
#
#   PRE-SWAP  (pré-cutover)
#     Blue serve pegasus.alpesd.com.br (produção em Neon).
#     Script sobe green isolado em pegasus-green.alpesd.com.br (Supabase).
#
#   POST-SWAP (pós-cutover — green é o primário)
#     Green já serve pegasus.alpesd.com.br + pegasus-green.alpesd.com.br via
#     router `pegasus-primary-*`. Script rebuilda a imagem e recria o green
#     PRESERVANDO esses labels (não derruba o swap).
#
# DETECÇÃO: inspeciona labels do container green atual — se existir router
#           `pegasus-primary-*` apontando para pegasus.alpesd.com.br, roda em
#           modo POST-SWAP. Caso contrário, PRE-SWAP.
#
# DNS: cria automático em Cloudflare via API se CLOUDFLARE_API_TOKEN estiver
#      no .env. Se não, instrua o usuário a criar manualmente.
# =============================================================================

set -euo pipefail

cd /apps/pegasus

GREEN_CONTAINER=pegasus-ads-green
GREEN_IMAGE=pegasus-ads:green
GREEN_HOST=pegasus-green.alpesd.com.br
PRIMARY_HOST=pegasus.alpesd.com.br
VPS_IPV4=187.77.245.144
VPS_IPV6=2a02:4780:6e:51b9::1
CF_ZONE_ID="b8a1b94d804aabedaa1af8f50e63ab87"  # alpesd.com.br (Brain memória #59)

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# ── Detectar modo: PRE-SWAP vs POST-SWAP ────────────────────────────────
# POST-SWAP = green está respondendo pelo PRIMARY_HOST via router pegasus-primary-*
CURRENT_PRIMARY_RULE=$(docker inspect "$GREEN_CONTAINER" \
  --format '{{index .Config.Labels "traefik.http.routers.pegasus-primary-https.rule"}}' \
  2>/dev/null || true)

if [[ "$CURRENT_PRIMARY_RULE" == *"$PRIMARY_HOST"* ]]; then
  MODE="post-swap"
  log "Modo detectado: POST-SWAP (green é o primário — recriando com labels pegasus-primary-*)"
else
  MODE="pre-swap"
  log "Modo detectado: PRE-SWAP (green isolado em $GREEN_HOST)"
fi

# ── 0. Pré-checagens ────────────────────────────────────────────────────
[[ -f .env ]] || { echo "ERRO: .env não encontrado" >&2; exit 1; }

# Confirmar DATABASE_URL atual aponta para Supabase (e não Neon ainda)
CURRENT_DB=$(grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2-)
if [[ "$CURRENT_DB" != *"alpes-ads_supabase"* && "$CURRENT_DB" != *"pegasus_ads"* ]]; then
  warn "DATABASE_URL no .env não parece apontar para Supabase:"
  warn "  $CURRENT_DB"
  warn "Green container vai herdar esse valor — abortar?"
  read -p "Continuar mesmo assim? [y/N] " -n 1 -r; echo
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

# ── 1. DNS — criar registro A/AAAA para pegasus-green.alpesd.com.br ─────
# (só em PRE-SWAP; em POST-SWAP o DNS já existe há tempos)
if [[ "$MODE" == "pre-swap" ]]; then
  log "[1/4] Configurando DNS para $GREEN_HOST"
  CF_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- || true)
  if [[ -z "$CF_TOKEN" ]]; then
    warn "CLOUDFLARE_API_TOKEN não está em .env — criar DNS manualmente:"
    warn "  $GREEN_HOST A $VPS_IPV4 (proxied)"
    read -p "DNS criado? [y/N] " -n 1 -r; echo
    [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
  else
    # Idempotente: cria A record se não existir
    existing=$(curl -sS -H "Authorization: Bearer $CF_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$GREEN_HOST&type=A" \
      | jq -r '.result[0].id // empty')
    if [[ -z "$existing" ]]; then
      curl -sS -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
        "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
        -d "{\"type\":\"A\",\"name\":\"$GREEN_HOST\",\"content\":\"$VPS_IPV4\",\"proxied\":true}" \
        | jq '.success'
      ok "DNS A criado para $GREEN_HOST"
    else
      ok "DNS A já existe para $GREEN_HOST"
    fi
  fi
else
  log "[1/4] Skip DNS (POST-SWAP — $PRIMARY_HOST e $GREEN_HOST já configurados)"
fi

# ── 2. Build da imagem :green ───────────────────────────────────────────
log "[2/4] Build da imagem $GREEN_IMAGE"
docker build -t "$GREEN_IMAGE" .
ok "imagem $GREEN_IMAGE pronta"

# ── 3. Stop + remove green anterior (se houver) ─────────────────────────
docker stop "$GREEN_CONTAINER" 2>/dev/null || true
docker rm "$GREEN_CONTAINER" 2>/dev/null || true

# ── 4. Deploy green ─────────────────────────────────────────────────────
log "[4/4] Subindo container $GREEN_CONTAINER (modo $MODE)"

# Labels conforme o modo detectado.
# PRE-SWAP: router pegasus-green-* isolado em $GREEN_HOST.
# POST-SWAP: router pegasus-primary-* servindo $PRIMARY_HOST + $GREEN_HOST
#            (idêntico ao que 02-swap-to-green.sh aplica).
if [[ "$MODE" == "post-swap" ]]; then
  docker run -d \
    --name "$GREEN_CONTAINER" \
    --restart unless-stopped \
    --env-file /apps/pegasus/.env \
    --network easypanel \
    --label traefik.enable=true \
    --label traefik.docker.network=easypanel \
    --label "traefik.http.routers.pegasus-primary-http.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$GREEN_HOST\`)" \
    --label "traefik.http.routers.pegasus-primary-http.entrypoints=http" \
    --label "traefik.http.routers.pegasus-primary-https.rule=Host(\`$PRIMARY_HOST\`) || Host(\`$GREEN_HOST\`)" \
    --label "traefik.http.routers.pegasus-primary-https.entrypoints=https" \
    --label "traefik.http.routers.pegasus-primary-https.tls=true" \
    --label "traefik.http.routers.pegasus-primary-https.tls.certresolver=letsencrypt" \
    --label "traefik.http.services.pegasus-ads-green.loadbalancer.server.port=3000" \
    "$GREEN_IMAGE"
else
  docker run -d \
    --name "$GREEN_CONTAINER" \
    --restart unless-stopped \
    --env-file /apps/pegasus/.env \
    --network easypanel \
    --label traefik.enable=true \
    --label traefik.docker.network=easypanel \
    --label "traefik.http.routers.pegasus-green-http.rule=Host(\`$GREEN_HOST\`)" \
    --label "traefik.http.routers.pegasus-green-http.entrypoints=http" \
    --label "traefik.http.routers.pegasus-green-https.rule=Host(\`$GREEN_HOST\`)" \
    --label "traefik.http.routers.pegasus-green-https.entrypoints=https" \
    --label "traefik.http.routers.pegasus-green-https.tls=true" \
    --label "traefik.http.routers.pegasus-green-https.tls.certresolver=letsencrypt" \
    --label "traefik.http.services.pegasus-ads-green.loadbalancer.server.port=3000" \
    "$GREEN_IMAGE"
fi

# Adiciona à network do Supabase (necessária para resolver alpes-ads_supabase-db)
docker network connect alpes-ads_supabase_default "$GREEN_CONTAINER"

sleep 5
ok "$GREEN_CONTAINER rodando"
docker ps --filter "name=$GREEN_CONTAINER" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

echo
echo "====================================================================="
if [[ "$MODE" == "post-swap" ]]; then
  echo " Green redeployed em modo POST-SWAP."
  echo " Serve $PRIMARY_HOST (produção) + $GREEN_HOST (acesso direto)."
  echo "====================================================================="
  echo
  echo " Smoke test:"
  echo "   curl -sI https://$PRIMARY_HOST/api/docs | head -5"
  echo "   curl -sI https://$GREEN_HOST/api/docs | head -5"
  echo
  echo " Se algo quebrar: rollback com scripts/cutover/03-rollback-to-blue.sh"
else
  echo " Green deployado. Blue (pegasus-ads) intocado — continua no Neon."
  echo "====================================================================="
  echo
  echo " Testar green:"
  echo "   curl -sI https://$GREEN_HOST/api/docs | head -5"
  echo "   Abrir https://$GREEN_HOST no browser"
  echo
  echo " Smoke test sugerido (fazer como user real):"
  echo "   - login / workspace switch"
  echo "   - /campaigns (lista de campanhas)"
  echo "   - /insights (grid hierárquico — depende de ad_creatives)"
  echo "   - /creatives (geração e lista)"
  echo "   - /api/cron/sync-all (POST manual — verificar que pega dados novos"
  echo "     direto do Meta + salva no pegasus_ads)"
  echo
  echo " Quando estiver confiante: bash scripts/cutover/02-swap-to-green.sh"
  echo " Se algo quebrar: nada a fazer — green isolado, blue intocado."
fi
echo
echo " Monitor:"
echo "   docker logs -f $GREEN_CONTAINER"
