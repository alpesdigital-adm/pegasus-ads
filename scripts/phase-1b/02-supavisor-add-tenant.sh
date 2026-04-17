#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 02: Configurar tenant Supavisor
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO: adicionar tenant `pegasus_ads` ao container
#           alpes-ads_supabase-supavisor-1, expondo conexão pooled.
#
# IMPORTANTE: Supavisor é configurado via inserts no DB interno do próprio
#             Supavisor (database `_supavisor`). Este script DETECTA a config
#             atual primeiro — Não cria sem antes mostrar o estado.
#
# ENTRADA: senha de pegasus_ads_app (do Brain ou auto-memory).
#          Setar via env DB_APP_PASSWORD antes de rodar.
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

# ── 0. Pré-checagens ─────────────────────────────────────────────────────
if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  err "Container $CONTAINER não está rodando."
  docker ps --format '{{.Names}}' | grep -i supavisor
  exit 1
fi
ok "Container $CONTAINER ativo"

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  err "Defina DB_APP_PASSWORD com a senha do user pegasus_ads_app antes de rodar."
  err "  Ex: DB_APP_PASSWORD='senha_do_brain' bash $0"
  exit 1
fi

# ── 1. Inspecionar como o tenant do CRM (pegasus_crm) está configurado ───
# (memória Brain #149 mostra que CRM tem tenant — copiar mesmo padrão)
log "Inspecionando configuração atual do Supavisor"

# Variáveis de env do container — mostram modo de configuração (DB ou file)
docker inspect "$CONTAINER" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -iE "tenant|database|secret|metrics" | head -20 \
  > /tmp/supavisor-env.txt
cat /tmp/supavisor-env.txt
echo

# Tentar listar tenants — Supavisor expõe API HTTP em :4000 ou :4040
SUPAVISOR_PORT=$(docker port "$CONTAINER" 2>/dev/null | grep -oE '[0-9]+/tcp' | head -1 | cut -d/ -f1)
ok "Supavisor port (interna): ${SUPAVISOR_PORT:-desconhecida}"

# ── 2. Localizar database de tenants do Supavisor ────────────────────────
# Supavisor cria tabelas (`tenants`, `users`) em um database (default
# `_supavisor` ou usa o postgres principal). Inspeciona via psql:
log "Procurando database de tenants do Supavisor"
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

if [[ -z "$TENANT_DB" ]]; then
  err "Não encontrei o database de tenants do Supavisor."
  err "Provavelmente o tenant é configurado via env vars no container."
  err ""
  err "Inspeção manual necessária:"
  err "  docker exec $CONTAINER cat /app/etc/supavisor.exs 2>/dev/null"
  err "  docker exec $CONTAINER env | grep -iE 'TENANT|DB'"
  err ""
  err "PARE aqui e me chame para investigar com você."
  exit 2
fi
ok "Database de tenants: $TENANT_DB"

# ── 3. Listar tenants existentes ─────────────────────────────────────────
log "Tenants atualmente configurados:"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$TENANT_DB" -c \
  "SELECT external_id, db_host, db_port, db_database, default_pool_size FROM tenants ORDER BY external_id" \
  || warn "Não consegui ler tabela tenants"

# Verificar se pegasus_ads já existe
EXISTS=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$TENANT_DB" -tAc \
  "SELECT 1 FROM tenants WHERE external_id = '$TENANT'" 2>/dev/null || true)
if [[ "$EXISTS" == "1" ]]; then
  ok "Tenant $TENANT já existe — pulando criação"
else
  log "Criando tenant $TENANT (NÃO automático — preview SQL primeiro)"
  cat <<SQL
-- Cole no psql se aprovar:
INSERT INTO tenants (
  external_id, db_host, db_port, db_database, db_user, db_password,
  default_pool_size, default_max_clients,
  ip_version, default_parameter_status, require_user
) VALUES (
  '$TENANT',
  '$DB_CONTAINER',  -- hostname dentro da network alpes-ads_supabase_default
  5432,
  '$TARGET_DB',
  '$TARGET_USER',
  '$DB_APP_PASSWORD',  -- senha do pegasus_ads_app
  15,                  -- pool_size por client (ajuste depois)
  100,                 -- max_clients
  'auto',
  '{}'::jsonb,
  false                -- false = pool_user pode ser qualquer (não fixo)
) RETURNING id, external_id;
SQL
  warn "Não executei INSERT automaticamente — confirme schema da tabela tenants"
  warn "primeiro (colunas podem variar entre versões do Supavisor)."
  warn ""
  warn "Após confirmar, executar manualmente o INSERT acima e depois reiniciar:"
  warn "  docker restart $CONTAINER"
fi

# ── 4. Connection string final esperada ─────────────────────────────────
echo
echo "====================================================================="
echo " Connection string esperada (após tenant configurado):"
echo "====================================================================="
echo
echo "  Host pooler  : $CONTAINER (porta 6543 — transaction mode)"
echo "  Username     : ${TARGET_USER}.${TENANT}  (formato Supavisor: user.tenant)"
echo "  Database     : $TARGET_DB"
echo "  SSL          : disable (intra-network)"
echo
echo "  Para .env do pegasus-ads, atualizar DATABASE_URL para:"
echo "  DATABASE_URL=postgres://${TARGET_USER}.${TENANT}:<senha>@${CONTAINER}:6543/${TARGET_DB}?sslmode=disable"
echo
echo "  DATABASE_URL_ADMIN continua em conexão direta (drizzle-kit, migrations):"
echo "  DATABASE_URL_ADMIN=postgres://pegasus_ads_admin:<senha>@${DB_CONTAINER}:5432/${TARGET_DB}?sslmode=disable"
