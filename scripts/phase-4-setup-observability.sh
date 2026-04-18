#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 4 / Observability setup
# =============================================================================
# Sobe Prometheus + Grafana na VPS, configura scrape do /api/metrics via
# bearer token, DNS grafana.alpesd.com.br e dashboard inicial.
#
# Idempotente: re-rodar atualiza config sem quebrar o que já subiu.
# Cuidado com admin pass — só gera novo se /root/.grafana-admin-pass não
# existir. Apagar o arquivo e rodar de novo pra rotacionar.
#
# Pré-requisitos em /apps/pegasus/.env:
#   CLOUDFLARE_API_TOKEN      (pra DNS)
#   PROMETHEUS_SCRAPE_TOKEN   (bearer pro scrape; script gera se faltar)
# =============================================================================

set -euo pipefail

cd /apps/pegasus

# ── Config ──────────────────────────────────────────────────────────────
APP_NETWORK=alpes-ads_supabase_default
TRAEFIK_NETWORK=easypanel
PROM_CONTAINER=pegasus-prometheus
GRAFANA_CONTAINER=pegasus-grafana
GRAFANA_HOST=grafana.alpesd.com.br
VPS_IPV4=187.77.245.144
CF_ZONE_ID="b8a1b94d804aabedaa1af8f50e63ab87"  # alpesd.com.br
PROM_IMAGE=prom/prometheus:latest
GRAFANA_IMAGE=grafana/grafana:latest
GRAFANA_PASS_FILE=/root/.grafana-admin-pass

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f .env ]] || die ".env não encontrado em $(pwd)"

# ── 1. Tokens ───────────────────────────────────────────────────────────
log "[1/6] Validando tokens"

SCRAPE_TOKEN=$(grep -E '^PROMETHEUS_SCRAPE_TOKEN=' .env | cut -d= -f2- || true)
if [[ -z "$SCRAPE_TOKEN" ]]; then
  log "PROMETHEUS_SCRAPE_TOKEN ausente — gerando"
  SCRAPE_TOKEN="$(openssl rand -hex 32)"
  # Append sem estragar o .env existente
  printf '\n# Fase 4 — scrape token do /api/metrics\nPROMETHEUS_SCRAPE_TOKEN=%s\n' "$SCRAPE_TOKEN" >> .env
  ok "PROMETHEUS_SCRAPE_TOKEN gravado em .env"
  warn "ATENÇÃO: green precisa ser rebuildado pra pegar a env nova"
else
  ok "PROMETHEUS_SCRAPE_TOKEN já configurado"
fi

CF_TOKEN=$(grep -E '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- || true)
[[ -n "$CF_TOKEN" ]] || warn "CLOUDFLARE_API_TOKEN ausente — DNS manual"

# ── 2. DNS ──────────────────────────────────────────────────────────────
log "[2/6] DNS $GRAFANA_HOST"
if [[ -n "$CF_TOKEN" ]]; then
  existing=$(curl -sS -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records?name=$GRAFANA_HOST&type=A" \
    | jq -r '.result[0].id // empty')
  if [[ -z "$existing" ]]; then
    curl -sS -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
      "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
      -d "{\"type\":\"A\",\"name\":\"$GRAFANA_HOST\",\"content\":\"$VPS_IPV4\",\"proxied\":true}" \
      | jq '.success' > /dev/null
    ok "DNS A criado: $GRAFANA_HOST → $VPS_IPV4 (proxied)"
  else
    ok "DNS A já existe"
  fi
else
  warn "Configure manualmente: $GRAFANA_HOST A $VPS_IPV4 (proxied)"
  read -rp "Configurado? [y/N] " -n 1; echo
  [[ "$REPLY" =~ ^[Yy]$ ]] || die "cancelado"
fi

# ── 3. Prometheus config + scrape token file ────────────────────────────
log "[3/6] Prometheus config"
PROM_CONF_DIR=/apps/pegasus/infra/prometheus
install -d -m 755 "$PROM_CONF_DIR"
cp "$PROM_CONF_DIR/prometheus.yml.tpl" "$PROM_CONF_DIR/prometheus.yml"
printf '%s' "$SCRAPE_TOKEN" > "$PROM_CONF_DIR/scrape-token"
chmod 600 "$PROM_CONF_DIR/scrape-token"
ok "prometheus.yml + scrape-token prontos"

# ── 4. Prometheus container ─────────────────────────────────────────────
log "[4/6] Subindo $PROM_CONTAINER"
docker stop "$PROM_CONTAINER" 2>/dev/null || true
docker rm "$PROM_CONTAINER" 2>/dev/null || true

docker run -d \
  --name "$PROM_CONTAINER" \
  --restart unless-stopped \
  --network "$APP_NETWORK" \
  -v "$PROM_CONF_DIR/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$PROM_CONF_DIR/scrape-token:/etc/prometheus/scrape-token:ro" \
  -v "pegasus-prometheus-data:/prometheus" \
  "$PROM_IMAGE" \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --storage.tsdb.retention.time=30d \
  --web.enable-lifecycle > /dev/null
ok "$PROM_CONTAINER rodando (sem exposição externa — só Grafana acessa)"

# ── 5. Grafana admin pass ───────────────────────────────────────────────
log "[5/6] Grafana admin pass"
if [[ -f "$GRAFANA_PASS_FILE" ]]; then
  GRAFANA_PASS=$(cat "$GRAFANA_PASS_FILE")
  ok "Reaproveitando senha de $GRAFANA_PASS_FILE"
else
  GRAFANA_PASS="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-20)"
  printf '%s' "$GRAFANA_PASS" > "$GRAFANA_PASS_FILE"
  chmod 600 "$GRAFANA_PASS_FILE"
  ok "Senha nova salva em $GRAFANA_PASS_FILE (mode 600)"
fi

# ── 6. Grafana container ────────────────────────────────────────────────
log "[6/6] Subindo $GRAFANA_CONTAINER"
docker stop "$GRAFANA_CONTAINER" 2>/dev/null || true
docker rm "$GRAFANA_CONTAINER" 2>/dev/null || true

GRAFANA_PROV=/apps/pegasus/infra/grafana/provisioning
GRAFANA_DASH=/apps/pegasus/infra/grafana/dashboards

docker run -d \
  --name "$GRAFANA_CONTAINER" \
  --restart unless-stopped \
  --network "$TRAEFIK_NETWORK" \
  -e "GF_SECURITY_ADMIN_PASSWORD=$GRAFANA_PASS" \
  -e "GF_SECURITY_ADMIN_USER=admin" \
  -e "GF_SERVER_ROOT_URL=https://$GRAFANA_HOST" \
  -e "GF_USERS_ALLOW_SIGN_UP=false" \
  -e "GF_ANALYTICS_REPORTING_ENABLED=false" \
  -v "$GRAFANA_PROV:/etc/grafana/provisioning:ro" \
  -v "$GRAFANA_DASH:/var/lib/grafana/dashboards:ro" \
  -v "pegasus-grafana-data:/var/lib/grafana" \
  --label traefik.enable=true \
  --label traefik.docker.network=easypanel \
  --label "traefik.http.routers.pegasus-grafana-http.rule=Host(\`$GRAFANA_HOST\`)" \
  --label "traefik.http.routers.pegasus-grafana-http.entrypoints=http" \
  --label "traefik.http.routers.pegasus-grafana-https.rule=Host(\`$GRAFANA_HOST\`)" \
  --label "traefik.http.routers.pegasus-grafana-https.entrypoints=https" \
  --label "traefik.http.routers.pegasus-grafana-https.tls=true" \
  --label "traefik.http.routers.pegasus-grafana-https.tls.certresolver=letsencrypt" \
  --label "traefik.http.services.pegasus-grafana.loadbalancer.server.port=3000" \
  "$GRAFANA_IMAGE" > /dev/null

# Attacha na mesma network do Prometheus pra Grafana conseguir scrape
docker network connect "$APP_NETWORK" "$GRAFANA_CONTAINER" 2>/dev/null || true
ok "$GRAFANA_CONTAINER rodando"

sleep 3
docker ps --filter "name=pegasus-prometheus" --filter "name=pegasus-grafana" \
  --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

cat <<EOF

=====================================================================
 Fase 4 — observability up
=====================================================================

 Grafana:      https://$GRAFANA_HOST
   user:       admin
   pass:       (cat $GRAFANA_PASS_FILE)

 Prometheus:   http://$PROM_CONTAINER:9090 (interno — sem ingress)

 Dashboard inicial: "Pegasus Ads — Overview" (folder: Pegasus Ads)

 Próximos passos:
   1. Rebuild green pra picar o PROMETHEUS_SCRAPE_TOKEN novo:
        bash scripts/cutover/01-deploy-green.sh
   2. Validar scrape:
        docker exec $PROM_CONTAINER wget -qO- http://localhost:9090/api/v1/targets | jq '.data.activeTargets[] | {job: .labels.job, health, lastError}'
   3. Abrir Grafana e checar que o dashboard tem dados

 Rollback:
   docker rm -f $PROM_CONTAINER $GRAFANA_CONTAINER
   docker volume rm pegasus-prometheus-data pegasus-grafana-data
EOF
