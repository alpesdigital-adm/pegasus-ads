#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Cutover / Step 04: Remover blue (pós-validação)
# =============================================================================
# OBJETIVO: após 24-48h de green em produção sem regressão, remover o
#           container blue definitivamente. Atualiza deploy.sh para apontar
#           para green como canônico.
#
# RESULTADO FINAL:
#   - pegasus.alpesd.com.br  → GREEN (pegasus-ads-green)
#   - pegasus-green.alpesd.com.br → GREEN (staging/dev access — manter)
#   - pegasus-blue.alpesd.com.br → REMOVIDO (DNS pode ficar, sem rota Traefik)
#
# DEPOIS DESTE SCRIPT:
#   - Próximo `git pull && docker build && bash deploy.sh` vai deployar
#     pegasus-ads-green atualizado (deploy.sh atualizado)
# =============================================================================

set -euo pipefail
cd /apps/pegasus

BLUE_CONTAINER=pegasus-ads
BLUE_HOST=pegasus-blue.alpesd.com.br
CF_ZONE_ID="b8a1b94d804aabedaa1af8f50e63ab87"

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

echo "Remoção FINAL do blue. Não tem rollback simples depois disso."
echo
echo "Pré-checklist (24-48h em prod):"
echo "  [ ] Green estável, sem regressões reportadas"
echo "  [ ] Cron jobs do green executando normalmente"
echo "  [ ] Métricas + leads do período recuperados via refresh/import"
echo "  [ ] Nenhum rollback parcial para blue aconteceu no período"
echo
read -p "Prosseguir com remoção? [y/N] " -n 1 -r; echo
[[ "$REPLY" =~ ^[Yy]$ ]] || exit 0

# ── 1. Stop + remove blue container ─────────────────────────────────────
log "[1/3] Removendo $BLUE_CONTAINER"
if docker ps -a --format '{{.Names}}' | grep -qx "$BLUE_CONTAINER"; then
  docker stop "$BLUE_CONTAINER" 2>/dev/null || true
  docker rm "$BLUE_CONTAINER" 2>/dev/null || true
  ok "$BLUE_CONTAINER removido"
else
  ok "$BLUE_CONTAINER já não existe"
fi

# ── 2. Cleanup DNS pegasus-blue (opcional — registro fica se não remover) ─
log "[2/3] Removendo DNS de $BLUE_HOST (opcional)"
CF_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- || true)
if [[ -n "$CF_TOKEN" ]]; then
  read -p "Remover também o DNS de $BLUE_HOST? [y/N] " -n 1 -r; echo
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    rec_id=$(curl -sS -H "Authorization: Bearer $CF_TOKEN" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$BLUE_HOST" \
      | jq -r '.result[0].id // empty')
    if [[ -n "$rec_id" ]]; then
      curl -sS -X DELETE -H "Authorization: Bearer $CF_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records/$rec_id" >/dev/null
      ok "DNS removido"
    fi
  else
    warn "DNS de $BLUE_HOST preservado"
  fi
fi

# ── 3. Atualizar deploy.sh para apontar para green como canônico ────────
log "[3/3] Atualizando deploy.sh"
# Nova estratégia: deploy.sh recria o container green com labels PRIMARY.
# Usuário futuro faz: git pull && docker build && bash deploy.sh
# e pegasus-ads-green é reconstruído com a imagem mais recente.

cat > deploy.sh <<'EOF'
#!/bin/bash
# Deploy pegasus-ads-green com DB em Supabase (cutover concluído 2026-04).
# Blue (Neon) foi removido. Apenas green existe agora.
set -euo pipefail

NAME=pegasus-ads-green
IMAGE=pegasus-ads:green
PRIMARY_HOST=pegasus.alpesd.com.br
GREEN_HOST=pegasus-green.alpesd.com.br

/usr/bin/docker stop $NAME 2>/dev/null || true
/usr/bin/docker rm $NAME 2>/dev/null || true

/usr/bin/docker run -d \
  --name $NAME \
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
  $IMAGE

/usr/bin/docker network connect alpes-ads_supabase_default $NAME
echo "Deploy OK: https://$PRIMARY_HOST"
EOF
chmod +x deploy.sh
ok "deploy.sh atualizado"

echo
echo "====================================================================="
echo " Cutover finalizado. Pegasus-ads rodando em Supabase exclusivamente."
echo "====================================================================="
echo
echo "  Container: pegasus-ads-green (pode ser renomeado depois para"
echo "             pegasus-ads se preferir — sem urgência)"
echo "  Imagem   : pegasus-ads:green (idem — próximo build pode ser :latest)"
echo "  Deploy   : cd /apps/pegasus && git pull && docker build -t pegasus-ads:green . && bash deploy.sh"
echo
echo "  Também atualizar:"
echo "  - CLAUDE.md do projeto: \"stack: Supabase self-hosted (não mais Neon)\""
echo "  - Brain: memória de conclusão do cutover"
echo "  - Tech-debt: TD-003 (TEST_LOG_API_KEY legacy), TD-004 (DROP users/sessions)"
