#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 02: Configurar tenant Supavisor
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO: adicionar tenant `pegasus_ads` no Supavisor do cluster
#           alpes-ads_supabase, expondo pool em transaction mode.
#
# PIPEFAIL FIX (feedback do gêmeo VPS 2026-04-17):
#   Script original quebrava por `set -e -o pipefail` + pipelines com grep
#   que retornavam exit 1 quando não achavam match. Agora: `|| true` em
#   todos os pipelines opcionais + funções declaradas antes das chamadas.
#
# CONFIG DO SUPAVISOR — 3 modos (detectados em ordem):
#   1. Banco de metadados (_supavisor ou similar) com tabela `tenants`
#   2. HTTP API em :4000/api/tenants (JWT-authenticated)
#   3. Arquivo de config (supavisor.exs) — manual only
#
# ENTRADA (env vars):
#   DB_APP_PASSWORD — senha do pegasus_ads_app (do Brain/auto-memory)
#   SUPAVISOR_JWT  — opcional, para HTTP API fallback
# =============================================================================

set -euo pipefail

CONTAINER=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1
TENANT=pegasus_ads
TARGET_DB=pegasus_ads
TARGET_USER=pegasus_ads_app

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

# ─── Funções (declaradas antes do flow principal — fix shellcheck) ──────

print_connection_strings() {
  echo
  echo "====================================================================="
  echo " Connection strings após Supavisor ativo"
  echo "====================================================================="
  echo
  echo "  APP (transaction mode, via pooler):"
  echo "  DATABASE_URL=postgres://${TARGET_USER}.${TENANT}:<senha>@${CONTAINER}:6543/${TARGET_DB}?sslmode=disable"
  echo
  echo "  ADMIN (direto, para drizzle-kit/migrations):"
  echo "  DATABASE_URL_ADMIN=postgres://pegasus_ads_admin:<senha>@${DB_CONTAINER}:5432/${TARGET_DB}?sslmode=disable"
  echo
  echo "  Teste a conexão pooled:"
  echo "  docker run --rm --network alpes-ads_supabase_default postgres:17-alpine \\"
  echo "    psql 'postgres://${TARGET_USER}.${TENANT}:<senha>@${CONTAINER}:6543/${TARGET_DB}?sslmode=disable' \\"
  echo "    -c 'SELECT current_user, current_database(), version()'"
}

configure_via_sql() {
  local tenant_db="$1"
  log "Tenants existentes:"
  docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$tenant_db" -c \
    "SELECT external_id, db_host, db_port, db_database, default_pool_size FROM tenants ORDER BY external_id" \
    || warn "Não consegui ler tabela tenants"

  local exists
  exists=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$tenant_db" -tAc \
    "SELECT 1 FROM tenants WHERE external_id = '$TENANT'" 2>/dev/null || true)
  if [[ "$exists" == "1" ]]; then
    ok "Tenant $TENANT já existe — pulando criação"
    print_connection_strings
    return 0
  fi

  echo
  log "SQL a executar (preview — confirme colunas antes de rodar):"
  cat <<SQL
INSERT INTO tenants (
  external_id, db_host, db_port, db_database, db_user, db_password,
  default_pool_size, default_max_clients,
  ip_version, default_parameter_status, require_user
) VALUES (
  '$TENANT', '$DB_CONTAINER', 5432, '$TARGET_DB', '$TARGET_USER',
  '$DB_APP_PASSWORD', 15, 100, 'auto', '{}'::jsonb, false
) RETURNING id, external_id;
SQL
  echo
  read -p "Executar INSERT? [y/N] " -n 1 -r; echo
  [[ "$REPLY" =~ ^[Yy]$ ]] || { warn "Cancelado."; return 0; }

  docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$tenant_db" -v ON_ERROR_STOP=1 <<SQL
INSERT INTO tenants (
  external_id, db_host, db_port, db_database, db_user, db_password,
  default_pool_size, default_max_clients,
  ip_version, default_parameter_status, require_user
) VALUES (
  '$TENANT', '$DB_CONTAINER', 5432, '$TARGET_DB', '$TARGET_USER',
  '$DB_APP_PASSWORD', 15, 100, 'auto', '{}'::jsonb, false
);
SQL
  ok "Tenant $TENANT criado"
  warn "Restart do Supavisor recomendado: docker restart $CONTAINER"
  print_connection_strings
}

configure_via_http() {
  if [[ -z "${SUPAVISOR_JWT:-}" ]]; then
    err "HTTP API requer SUPAVISOR_JWT env var (JWT de admin do Supavisor)"
    err "Encontrar no env do container:"
    err "  docker exec $CONTAINER env | grep -iE 'JWT|SECRET_KEY'"
    err "Então rodar: SUPAVISOR_JWT='...' DB_APP_PASSWORD='...' bash $0"
    exit 3
  fi

  log "POSTANDO tenant via HTTP API em ${CONTAINER}:4000/api/tenants"
  # Usa docker network interna
  local payload
  payload=$(cat <<JSON
{
  "tenant": {
    "external_id": "$TENANT",
    "db_host": "$DB_CONTAINER",
    "db_port": 5432,
    "db_database": "$TARGET_DB",
    "users": [
      {
        "db_user": "$TARGET_USER",
        "db_password": "$DB_APP_PASSWORD",
        "pool_size": 15,
        "mode_type": "transaction"
      }
    ]
  }
}
JSON
  )

  docker run --rm --network alpes-ads_supabase_default \
    curlimages/curl:latest \
    -sS -X POST "http://${CONTAINER}:4000/api/tenants" \
    -H "Authorization: Bearer $SUPAVISOR_JWT" \
    -H "Content-Type: application/json" \
    -d "$payload" || {
      err "POST falhou. Fallback manual: docs Supavisor self-hosted"
      err "  https://github.com/supabase/supavisor"
      exit 4
    }
  echo
  ok "Tenant criado via HTTP API"
  print_connection_strings
}

# ─── Flow principal ──────────────────────────────────────────────────────

# 0. Pré-checagens
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  err "Container $CONTAINER não está rodando."
  docker ps --format '{{.Names}}' | grep -i supavisor || true
  exit 1
fi
ok "Container $CONTAINER ativo"

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  err "Defina DB_APP_PASSWORD com a senha do user pegasus_ads_app antes de rodar."
  err "  Ex: DB_APP_PASSWORD='senha_do_brain' bash $0"
  exit 1
fi

# 1. Inspeção do container Supavisor
log "Inspecionando Supavisor (env vars relevantes)"
docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
  | { grep -iE "tenant|database|secret|metrics|pool|jwt" || true; } \
  | head -20 > /tmp/supavisor-env.txt || true
cat /tmp/supavisor-env.txt
echo

# 2. Tentar MODO 1 (SQL) — localizar database de tenants
log "Modo 1: procurando database de tenants (SQL)"
TENANT_DB=""
for candidate in _supavisor supabase_supavisor postgres; do
  exists=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '$candidate'" 2>/dev/null || true)
  if [[ "$exists" == "1" ]]; then
    has_tenants=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$candidate" -tAc \
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'tenants'" 2>/dev/null || true)
    if [[ "$has_tenants" == "1" ]]; then
      TENANT_DB="$candidate"
      break
    fi
  fi
done

if [[ -n "$TENANT_DB" ]]; then
  ok "Database de tenants: $TENANT_DB — uso modo SQL"
  configure_via_sql "$TENANT_DB"
else
  warn "Nenhum database com tabela 'tenants' encontrado — tentando HTTP API"
  configure_via_http
fi
