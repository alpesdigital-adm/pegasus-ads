#!/usr/bin/env bash
# =============================================================================
# TD-007 — Staging Queue v2
# setup-cron.sh — instala/atualiza cron job do worker tick (idempotente)
# =============================================================================
# Versiona o setup operacional que hoje vive na crontab + /etc/logrotate.d.
# Roda seguro várias vezes — o próprio script remove linha antiga antes de
# inserir, e o logrotate config é sobrescrito.
#
# O que faz:
#   1. Garante que /root/.pegasus-cron-secret existe (gera se faltar — 32-byte
#      hex) e que o mesmo valor está no /apps/pegasus/.env
#   2. Instala cron `* * * * *` que chama POST /api/cron/process-queue
#      com Bearer token, loga com timestamp ISO8601 em
#      /var/log/pegasus-queue-worker.log
#   3. Cria /etc/logrotate.d/pegasus-queue-worker (daily, 14 rotations,
#      compress + delaycompress, su root root)
#
# Formato de log gerado por cada tick:
#   2026-04-18T20:30:00+00:00 {"status":"idle","promotedScheduled":0}
#
# Pré-requisitos:
#   - green container rodando e servindo /api/cron/process-queue
#   - /apps/pegasus/.env existe
#
# Uso:
#   sudo bash setup-cron.sh
# =============================================================================

set -euo pipefail

SECRET_FILE=/root/.pegasus-cron-secret
ENV_FILE=/apps/pegasus/.env
LOG_FILE=/var/log/pegasus-queue-worker.log
LOGROTATE_FILE=/etc/logrotate.d/pegasus-queue-worker
CRON_MARKER='api/cron/process-queue'
ENDPOINT='https://pegasus.alpesd.com.br/api/cron/process-queue'

ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

[[ $EUID -eq 0 ]] || { echo "Precisa rodar como root"; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE não existe"; exit 1; }

# 1. CRON_SECRET — gera se faltar, sincroniza com .env
log "Verificando CRON_SECRET"
if [[ ! -s "$SECRET_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  ok "Gerado $SECRET_FILE (novo secret)"
else
  ok "$SECRET_FILE já existe — reusando"
fi

SECRET=$(cat "$SECRET_FILE")

# Sincroniza .env (adiciona/atualiza CRON_SECRET)
if grep -q '^CRON_SECRET=' "$ENV_FILE"; then
  EXISTING=$(grep '^CRON_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  if [[ "$EXISTING" != "$SECRET" ]]; then
    warn ".env tem CRON_SECRET diferente — atualizando pra bater com $SECRET_FILE"
    cp "$ENV_FILE" "${ENV_FILE}.pre-cron-setup-$(date +%Y%m%d-%H%M%S)"
    python3 - "$ENV_FILE" "$SECRET" <<'PY'
import sys, re, pathlib
p = pathlib.Path(sys.argv[1])
c = p.read_text()
c = re.sub(r'^CRON_SECRET=.*$', f'CRON_SECRET={sys.argv[2]}', c, flags=re.MULTILINE)
p.write_text(c)
PY
    ok ".env atualizado (rebuilde o green: bash scripts/cutover/01-deploy-green.sh)"
  else
    ok ".env já contém o mesmo CRON_SECRET"
  fi
else
  printf '\n# Staging Queue v2 + sync-all cron auth\nCRON_SECRET=%s\n' "$SECRET" >> "$ENV_FILE"
  ok ".env: CRON_SECRET adicionado (rebuilde o green)"
fi

# 2. Crontab — remove linha antiga + adiciona a nova
log "Instalando cron job"
# Nota: crontab interpreta % como quebra de stdin (man 5 crontab). Escapar
# com \% pro printf receber o literal %s. Sem isso, o comando cai silencioso
# e vira no-op (observado 2026-04-18 durante setup inicial).
NEW_LINE='* * * * * { printf "\%s " "$(date --iso-8601=seconds)"; curl -sf --max-time 120 -X POST -H "Authorization: Bearer $(cat '"$SECRET_FILE"')" '"$ENDPOINT"'; echo; } >> '"$LOG_FILE"' 2>&1'

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
crontab -l 2>/dev/null | grep -vF "$CRON_MARKER" > "$TMP" || true
echo "$NEW_LINE" >> "$TMP"
crontab "$TMP"
ok "Cron instalado: tick a cada 60s"

# 3. Log file + logrotate
log "Configurando log + logrotate"
touch "$LOG_FILE"
chmod 640 "$LOG_FILE"
chown root:root "$LOG_FILE"

cat > "$LOGROTATE_FILE" <<'EOF'
/var/log/pegasus-queue-worker.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 640 root root
    sharedscripts
    su root root
}
EOF
chmod 644 "$LOGROTATE_FILE"
ok "Logrotate: $LOGROTATE_FILE"

# Valida sintaxe do logrotate (dry-run)
if logrotate -d "$LOGROTATE_FILE" >/dev/null 2>&1; then
  ok "Logrotate config válida"
else
  warn "Logrotate reportou issues — rode: logrotate -d $LOGROTATE_FILE"
fi

echo
echo "──────────────────────────────────────────────────────────"
echo " Validação manual (aguarde 60-90s depois rode):"
echo "   tail -5 $LOG_FILE"
echo
echo " Esperado (uma linha por tick):"
echo '   2026-04-18T20:30:00+00:00 {"status":"idle","promotedScheduled":0}'
echo "──────────────────────────────────────────────────────────"
