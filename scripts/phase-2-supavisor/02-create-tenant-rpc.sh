#!/usr/bin/env bash
# =============================================================================
# Phase 2 — Supavisor Pooling (TD-002)
# 02-create-tenant-rpc.sh — cria tenant pegasus_ads via Elixir RPC
# =============================================================================
# CAMINHO FELIZ: usa /app/bin/supavisor rpc pra chamar
# Supavisor.Tenants.create_tenant/1 direto no runtime — encryption da senha
# é tratada internamente, sem precisar mexer com VAULT_ENC_KEY + AES-GCM.
#
# Pré-req: 01-inspect.sh confirmou que RPC está disponível.
#
# Uso:
#   DB_APP_PASSWORD='senha_do_pegasus_ads_app' bash 02-create-tenant-rpc.sh
# =============================================================================

set -euo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1
TENANT=pegasus_ads
TARGET_DB=pegasus_ads
TARGET_USER=pegasus_ads_app
POOL_SIZE=15
MAX_CLIENTS=100

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  err "DB_APP_PASSWORD env var obrigatória (senha do user pegasus_ads_app)"
  err "Recupera do /root/.pegasus-db-passwords ou de onde estiver guardada"
  exit 1
fi

# Idempotência: se tenant já existe, pula
existing=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d _supabase -tAc \
  "SELECT 1 FROM _supavisor.tenants WHERE external_id = '$TENANT'" 2>/dev/null || true)

if [[ "$existing" == "1" ]]; then
  ok "Tenant $TENANT já existe — pulando criação"
  exit 0
fi

log "Criando tenant $TENANT via Elixir RPC"

# Escapa aspas do password pra Elixir binary string
ESC_PASS=$(printf '%s' "$DB_APP_PASSWORD" | sed 's/"/\\"/g')

# RPC roda Elixir dentro do container. A função Supavisor.Tenants.create_tenant
# recebe um map com os campos do tenant + users nested. A encryption do
# db_password vira db_pass_encrypted automaticamente usando VAULT_ENC_KEY.
docker exec -i "$SUPAVISOR" /app/bin/supavisor rpc "$(cat <<ELIXIR
tenant_attrs = %{
  \"external_id\" => \"$TENANT\",
  \"db_host\" => \"$DB_CONTAINER\",
  \"db_port\" => 5432,
  \"db_database\" => \"$TARGET_DB\",
  \"require_user\" => false,
  \"default_pool_size\" => $POOL_SIZE,
  \"default_max_clients\" => $MAX_CLIENTS,
  \"ip_version\" => \"auto\",
  \"default_parameter_status\" => %{},
  \"users\" => [%{
    \"db_user\" => \"$TARGET_USER\",
    \"db_password\" => \"$ESC_PASS\",
    \"pool_size\" => $POOL_SIZE,
    \"mode_type\" => \"transaction\",
    \"is_manager\" => true
  }]
}

case Supavisor.Tenants.create_tenant(tenant_attrs) do
  {:ok, tenant} -> IO.inspect({:ok, tenant.external_id, tenant.id})
  {:error, changeset} -> IO.inspect({:error, changeset.errors})
end
ELIXIR
)"

log "Validando no banco"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d _supabase -c \
  "SELECT t.external_id, t.db_host, t.db_database, u.db_user, u.mode_type, u.pool_size
   FROM _supavisor.tenants t
   LEFT JOIN _supavisor.users u ON u.tenant_external_id = t.external_id
   WHERE t.external_id = '$TENANT'"

ok "Tenant $TENANT criado"

cat <<EOF

Connection string nova (transaction mode):
  postgres://${TARGET_USER}.${TENANT}:<DB_APP_PASSWORD>@${SUPAVISOR}:6543/${TARGET_DB}?sslmode=disable

Próximo passo: 03-smoke.sh pra validar RLS + connectivity.
EOF
