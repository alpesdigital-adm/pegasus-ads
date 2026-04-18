#!/usr/bin/env bash
# =============================================================================
# Phase 2 — Supavisor Pooling (TD-002)
# 01-inspect.sh — descobre estado atual, decide caminho de setup
# =============================================================================
# Output guia qual script executar no próximo passo. Não muda nada.
# =============================================================================

set -uo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1

banner() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()     { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
info()   { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }

banner "Supavisor — inspeção de estado"

# 1. Container health
if docker ps --format '{{.Names}}' | grep -qx "$SUPAVISOR"; then
  ok "Container $SUPAVISOR rodando"
  docker ps --filter "name=$SUPAVISOR" --format "  {{.Status}}"
else
  warn "Container $SUPAVISOR NÃO está rodando"
  docker ps -a --format '{{.Names}} {{.Status}}' | grep -i supavisor || true
  exit 2
fi

# 2. Version
banner "Versão do Supavisor"
docker exec "$SUPAVISOR" sh -c 'cat /app/VERSION 2>/dev/null || ls /app/ | head -10' || true

# 3. Env vars críticas (mascaradas — só indicam presença)
banner "Env vars críticas (presença, não valores)"
for var in API_JWT_SECRET SECRET_KEY_BASE VAULT_ENC_KEY DATABASE_URL POOL_HOST POOL_PORT REGION METRICS_JWT_SECRET; do
  val=$(docker exec "$SUPAVISOR" sh -c "printenv $var 2>/dev/null" || true)
  if [[ -n "$val" ]]; then
    len=${#val}
    # Flag se parecer com valor demo/público
    if [[ "$val" == *"super-secret"* || "$val" == *"change-me"* || "$val" == *"demo"* ]]; then
      warn "$var setada (length=$len) — VALOR DEMO DETECTADO"
    else
      ok "$var setada (length=$len)"
    fi
  else
    warn "$var ausente"
  fi
done

# 4. RPC disponível (caminho feliz pra criar tenant)
banner "RPC disponível? (elixir — cria tenant sem mexer em SQL)"
if docker exec "$SUPAVISOR" sh -c 'test -x /app/bin/supavisor' 2>/dev/null; then
  ok "/app/bin/supavisor existe — RPC é opção viável"
  echo "  Exemplo de uso:"
  echo "    docker exec $SUPAVISOR /app/bin/supavisor rpc 'IO.puts(Application.spec(:supavisor, :vsn))'"
else
  warn "/app/bin/supavisor não encontrado — fallback pra SQL direto"
fi

# 5. Schema do tenants table
banner "Schema de tenants (moderno vs legado)"
for db in _supabase _supavisor postgres; do
  schema=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$db" -tAc \
    "SELECT table_schema FROM information_schema.tables WHERE table_name = 'tenants' ORDER BY CASE table_schema WHEN '_supavisor' THEN 0 ELSE 1 END LIMIT 1" 2>/dev/null || true)
  if [[ -n "$schema" ]]; then
    ok "tenants em $db.$schema"
    # Detecta schema legado (db_user inline) vs moderno (users separado + bytea)
    legacy_cols=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$db" -tAc \
      "SELECT column_name FROM information_schema.columns WHERE table_schema='$schema' AND table_name='tenants' AND column_name IN ('db_user','db_password')" 2>/dev/null || true)
    if [[ -n "$legacy_cols" ]]; then
      info "Schema LEGADO (db_user/db_password inline em tenants)"
    else
      info "Schema MODERNO (users separado com db_pass_encrypted bytea — requer AES-GCM ou RPC)"
    fi
    echo
    echo "  Tenants existentes:"
    docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$db" -c \
      "SELECT external_id, db_host, db_database FROM $schema.tenants ORDER BY external_id" 2>/dev/null || true
    break
  fi
done

# 6. Pegasus_ads tenant já existe?
banner "Tenant pegasus_ads já configurado?"
existing=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d _supabase -tAc \
  "SELECT 1 FROM _supavisor.tenants WHERE external_id = 'pegasus_ads'" 2>/dev/null || true)
if [[ "$existing" == "1" ]]; then
  ok "Tenant pegasus_ads EXISTE — setup já feito, pula pro smoke test (03-smoke.sh)"
else
  info "Tenant pegasus_ads NÃO existe — precisa rodar 02-create-tenant.sh"
fi

# 7. DATABASE_URL atual do green
banner "DATABASE_URL atual do pegasus-green"
green=$(docker exec pegasus-ads-green printenv DATABASE_URL 2>/dev/null || true)
if [[ -n "$green" ]]; then
  # Extrai só host:porta (esconde credenciais)
  host_port=$(echo "$green" | sed -E 's#.*@([^/]+)/.*#\1#')
  info "Green conecta em: $host_port"
  if [[ "$host_port" == *"6543"* ]]; then
    warn "Já está usando porta 6543 — Supavisor pode já estar ativo?"
  else
    info "Usa porta 5432 (direto no Postgres) — cutover vai trocar pra 6543"
  fi
else
  warn "Não consegui ler DATABASE_URL do green"
fi

banner "Próximos passos"
cat <<EOF

Com base no output acima:

1. Se algum "VALOR DEMO DETECTADO" acima em API_JWT_SECRET / SECRET_KEY_BASE
   / VAULT_ENC_KEY → rotacionar ANTES de criar tenant (TD-002 passo 1).
   Script: 02-rotate-supavisor-secrets.sh (TODO — criar com mesmo pattern de
   TD-006; coordenar com CRM porque são shared cluster-wide).

2. Se schema MODERNO + RPC viável → rodar 02-create-tenant-rpc.sh
   (caminho feliz, encryption via Elixir interno).

3. Se schema MODERNO sem RPC → rodar 02-create-tenant-sql.sh
   (extrai VAULT_ENC_KEY, cifra senha com AES-GCM via Node, INSERT manual).

4. Se tenant pegasus_ads JÁ existe → pula direto pro 03-smoke.sh.

5. Após smoke passar → 04-cutover.sh swapa DATABASE_URL no green.
EOF
