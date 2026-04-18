#!/usr/bin/env bash
# =============================================================================
# Phase 2 — Supavisor Pooling (TD-002)
# 02-create-tenant-eval.sh — CAMINHO CANONICO (funciona em todas versões)
# =============================================================================
# Usa `/app/bin/supavisor eval` pra chamar Cloak.encrypt + INSERT SQL.
#
# Por que eval e não rpc: rpc depende de Erlang distribution + FQDN
# hostname, quebra em containers com hostname short. eval roda no mesmo
# BEAM do release, zero dependência de distribution.
#
# Por que eval e não AES-GCM em Node: Supavisor usa
# Cloak.Ciphers.AES.GCM com envelope próprio (<<version, tag_len, tag, iv,
# ciphertext+authtag>>), não AES-GCM raw. Fazer isso em Node é viável mas
# frágil (versão do Cloak pode mudar). Deixa o próprio Supavisor gerar.
#
# Pré-reqs (validar com 01-inspect.sh):
#  - Container alpes-ads_supabase-supavisor-1 up
#  - /app/bin/supavisor eval responde
#  - Schema _supavisor moderno em _supabase database
#
# Uso:
#   DB_APP_PASSWORD='senha_do_pegasus_ads_app' bash 02-create-tenant-eval.sh
# =============================================================================

set -euo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1
TENANT=pegasus_ads
TARGET_DB=pegasus_ads
TARGET_USER=pegasus_ads_app
POOL_SIZE=15

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  err "DB_APP_PASSWORD env var obrigatória"
  exit 1
fi

# Idempotência
existing=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d _supabase -tAc \
  "SELECT 1 FROM _supavisor.tenants WHERE external_id = '$TENANT'" 2>/dev/null || true)

if [[ "$existing" == "1" ]]; then
  ok "Tenant $TENANT já existe — pula"
  exit 0
fi

# 1. Cifra senha via Cloak (eval)
log "Cifrando senha via Supavisor.Vault.encrypt (Cloak)"
ENC_HEX=$(docker exec "$SUPAVISOR" /app/bin/supavisor eval "
  password = System.get_env(\"P\") || \"${DB_APP_PASSWORD}\"
  {:ok, ciphertext} = Supavisor.Vault.encrypt(password)
  IO.puts(Base.encode16(ciphertext))
" | tr -d '\r\n' | grep -oE '[0-9A-F]+$')

if [[ -z "$ENC_HEX" || ${#ENC_HEX} -lt 32 ]]; then
  err "Eval não retornou hex válido. Output bruto:"
  docker exec "$SUPAVISOR" /app/bin/supavisor eval "
    {:ok, ciphertext} = Supavisor.Vault.encrypt(\"${DB_APP_PASSWORD}\")
    IO.puts(Base.encode16(ciphertext))
  "
  exit 2
fi

ok "Senha cifrada (length=${#ENC_HEX} hex chars)"

# 2. INSERT SQL — schema moderno com os 3 fixes descobertos
log "Inserindo tenant + user em _supabase._supavisor"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d _supabase -v ON_ERROR_STOP=1 <<SQL
BEGIN;

INSERT INTO _supavisor.tenants (
  id, external_id, db_host, db_port, db_database,
  default_pool_size, default_max_clients,
  ip_version, default_parameter_status, require_user,
  inserted_at, updated_at
) VALUES (
  gen_random_uuid(),
  '${TENANT}', '${DB_CONTAINER}', 5432, '${TARGET_DB}',
  ${POOL_SIZE}, 100,
  'auto', '{}'::jsonb, true,
  NOW(), NOW()
) ON CONFLICT (external_id) DO NOTHING;

INSERT INTO _supavisor.users (
  id, tenant_external_id, db_user, db_user_alias, db_pass_encrypted,
  pool_size, mode_type, is_manager,
  inserted_at, updated_at
) VALUES (
  gen_random_uuid(),
  '${TENANT}',
  '${TARGET_USER}',
  '${TARGET_USER}',
  decode('${ENC_HEX}', 'hex'),
  ${POOL_SIZE}, 'transaction', true,
  NOW(), NOW()
) ON CONFLICT (db_user_alias, tenant_external_id, mode_type) DO UPDATE SET
  db_pass_encrypted = EXCLUDED.db_pass_encrypted,
  pool_size = EXCLUDED.pool_size,
  updated_at = NOW();

COMMIT;
SQL

ok "Tenant + user inseridos"

# 3. Restart pra reloadar cache
log "Reiniciando Supavisor (~5-10s downtime — nobody uses it yet)"
docker restart "$SUPAVISOR"
sleep 8

for i in 1 2 3; do
  if docker exec "$SUPAVISOR" /app/bin/supavisor eval ':ok' >/dev/null 2>&1; then
    ok "Supavisor healthy após restart"
    break
  fi
  [[ $i -eq 3 ]] && { err "Supavisor não voltou após 3 tentativas"; exit 3; }
  sleep 5
done

cat <<EOF

Connection string nova (transaction mode):
  postgres://${TARGET_USER}.${TENANT}:<DB_APP_PASSWORD>@${SUPAVISOR}:6543/${TARGET_DB}?sslmode=disable

Próximo passo: 03-smoke.sh pra validar RLS + connectivity.
EOF
