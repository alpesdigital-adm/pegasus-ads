#!/usr/bin/env bash
# =============================================================================
# Phase 2 — Supavisor Pooling (TD-002)
# 04-cutover.sh — swap DATABASE_URL do green pra Supavisor
# =============================================================================
# Faz backup do .env atual, atualiza DATABASE_URL + DATABASE_URL_ADMIN,
# rebuilds green, monitora 60s. Reverter é trivial (restaura backup + rebuild).
#
# DATABASE_URL      → Supavisor:6543 (pooled, transaction mode, role app)
# DATABASE_URL_ADMIN → direto:5432   (BYPASSRLS, migrations, role admin)
#
# Uso:
#   DB_APP_PASSWORD='senha' DB_ADMIN_PASSWORD='senha' bash 04-cutover.sh
# =============================================================================

set -euo pipefail

ENV_FILE=/apps/pegasus/.env
SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_DIRECT=alpes-ads_supabase-db-1
TENANT=pegasus_ads

if [[ -z "${DB_APP_PASSWORD:-}" || -z "${DB_ADMIN_PASSWORD:-}" ]]; then
  echo "Preciso de: DB_APP_PASSWORD (pegasus_ads_app) + DB_ADMIN_PASSWORD (pegasus_ads_admin)" >&2
  exit 1
fi

ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# 1. Backup
BACKUP="$ENV_FILE.pre-supavisor-$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
ok "Backup salvo em $BACKUP"

# 2. Constrói novas URLs
NEW_APP="postgres://pegasus_ads_app.${TENANT}:${DB_APP_PASSWORD}@${SUPAVISOR}:6543/pegasus_ads?sslmode=disable"
NEW_ADMIN="postgres://pegasus_ads_admin:${DB_ADMIN_PASSWORD}@${DB_DIRECT}:5432/pegasus_ads?sslmode=disable"

# 3. Swap DATABASE_URL (cria se não existe) — usa python pra escapar chars especiais
python3 - "$ENV_FILE" "$NEW_APP" "$NEW_ADMIN" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
app_url = sys.argv[2]
admin_url = sys.argv[3]

content = path.read_text()
def upsert(var, val, body):
    pattern = re.compile(rf'^{re.escape(var)}=.*$', re.MULTILINE)
    if pattern.search(body):
        return pattern.sub(f'{var}={val}', body)
    return body.rstrip() + f'\n{var}={val}\n'

content = upsert("DATABASE_URL", app_url, content)
content = upsert("DATABASE_URL_ADMIN", admin_url, content)
path.write_text(content)
print("[ok] .env atualizado")
PY

# 4. Rebuild green
ok "Rebuildando pegasus-ads-green"
cd /apps/pegasus
bash scripts/cutover/01-deploy-green.sh

# 5. Monitor inicial
ok "Container up — monitorando 60s"
sleep 15
for i in 1 2 3 4; do
  status=$(curl -s -o /dev/null -w "%{http_code}" https://pegasus.alpesd.com.br/api/docs || echo "000")
  printf "  t=%ds  /api/docs → %s\n" "$((i*15))" "$status"
  [[ "$status" == "200" ]] || warn "status não-200 em t=$((i*15))s"
  sleep 15
done

# 6. Smoke final: login + endpoint autenticado
ok "Smoke: login + /api/auth/me"
echo "(manual) executa via cURL com cookie de teste"

cat <<EOF

Cutover feito. DATABASE_URL antiga está em:
  $BACKUP

Rollback (se algo quebrar):
  cp $BACKUP $ENV_FILE
  bash scripts/cutover/01-deploy-green.sh
EOF
