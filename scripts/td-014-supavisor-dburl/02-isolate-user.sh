#!/usr/bin/env bash
# =============================================================================
# TD-014 — opção SEGURA (CASO B do 01-inspect)
# 02-isolate-user.sh — cria user dedicado 'supavisor_meta' com permissões
# só no database _supabase, migra Supavisor pra ele.
# =============================================================================
# Essa é a abordagem recomendada se 01-inspect mostrar que Supavisor usa
# postgres/supabase_admin (superuser). Rotacionar superuser direto
# quebraria CRM/Studio/Realtime. Melhor isolar.
#
# Fluxo:
#  1. Gera senha forte nova (guarda em /root/.supavisor-meta-password 600)
#  2. CREATE ROLE supavisor_meta LOGIN PASSWORD '<nova>'
#  3. GRANT ALL no database _supabase + schemas _supavisor/_supabase/public
#  4. Atualiza env DATABASE_URL do container Supavisor
#  5. Restart Supavisor (~5-10s downtime — só pooling, CRM não afetado)
#  6. Valida: Supavisor consegue listar tenants via eval
#  7. Reporta pra Leandro conferir antes de considerar fechado
#
# Se quiser também rotacionar a senha do superuser original depois:
# é outra operação (coordenar com CRM em janela separada).
#
# Uso:
#   bash 02-isolate-user.sh
# =============================================================================

set -euo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1
META_DB=_supabase
NEW_USER=supavisor_meta
PW_FILE=/root/.supavisor-meta-password

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

# 1. Pré-check
if ! docker ps --format '{{.Names}}' | grep -qx "$SUPAVISOR"; then
  err "Container $SUPAVISOR não rodando"; exit 1
fi

# 2. Idempotência — se user já existe, pula criação
existing=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = '$NEW_USER'" 2>/dev/null || true)

if [[ "$existing" == "1" ]]; then
  ok "Role $NEW_USER já existe — reusando"
  if [[ ! -f "$PW_FILE" ]]; then
    err "role existe mas senha não está em $PW_FILE — abortando"
    err "Ou deleta a role manualmente e roda de novo, OU restaura a senha no arquivo"
    exit 2
  fi
  NEW_PASS=$(cat "$PW_FILE")
else
  # 3. Gera senha nova forte
  NEW_PASS="supavisor_meta_$(openssl rand -hex 16)"
  umask 077
  echo "$NEW_PASS" > "$PW_FILE"
  chmod 600 "$PW_FILE"
  ok "Senha gerada, salva em $PW_FILE (mode 600)"

  # 4. Cria role
  log "CREATE ROLE $NEW_USER"
  docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE $NEW_USER LOGIN PASSWORD '$NEW_PASS';
-- NÃO é superuser, NÃO pode criar DB, NÃO pode criar role
-- Escopo: apenas metadata DB do Supavisor
GRANT CONNECT ON DATABASE $META_DB TO $NEW_USER;
SQL
  ok "Role criada"
fi

# 5. Permissões no metadata DB (idempotente)
log "Concedendo permissões em $META_DB"
docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$META_DB" -v ON_ERROR_STOP=1 <<SQL
-- Schemas que Supavisor precisa ler/escrever
GRANT USAGE, CREATE ON SCHEMA _supavisor TO $NEW_USER;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA _supavisor TO $NEW_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA _supavisor TO $NEW_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA _supavisor
  GRANT ALL ON TABLES TO $NEW_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA _supavisor
  GRANT ALL ON SEQUENCES TO $NEW_USER;

-- Public schema pode conter extensões (pgcrypto pra gen_random_uuid)
GRANT USAGE ON SCHEMA public TO $NEW_USER;

-- Schema _supabase (se Supavisor usar pra migrations internas)
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = '_supabase') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA _supabase TO $NEW_USER';
    EXECUTE 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA _supabase TO $NEW_USER';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA _supabase GRANT ALL ON TABLES TO $NEW_USER';
  END IF;
END \$\$;
SQL
ok "Permissões aplicadas"

# 6. Valida que user novo consegue conectar + ler tenants
log "Validando connect + SELECT em _supavisor.tenants"
docker run --rm --network alpes-ads_supabase_default \
  -e PGPASSWORD="$NEW_PASS" \
  postgres:17-alpine psql "postgres://$NEW_USER@$DB_CONTAINER:5432/$META_DB" -tAc \
  "SELECT external_id FROM _supavisor.tenants ORDER BY external_id" || {
    err "Validação falhou — user novo não conecta ou não vê tenants"
    err "Checa permissões acima ou pg_hba.conf do container db"
    exit 3
  }
ok "User novo OK — lista tenants igual antes"

# 7. Atualiza env do Supavisor
log "Atualizando DATABASE_URL do container Supavisor"
# Pega DATABASE_URL atual do docker inspect pra preservar outros params
# (ssl, query string, etc) — só substitui user:pass
CURRENT_URL=$(docker exec "$SUPAVISOR" sh -c 'echo $DATABASE_URL')
NEW_URL=$(echo "$CURRENT_URL" | sed -E "s|postgres(ql)?://[^:]+:[^@]+@|postgres\1://$NEW_USER:$NEW_PASS@|")

# O update da env exige recreate. Vamos ver como o container foi subido:
# docker inspect pra achar o run command / compose file
warn "Atualização da env DATABASE_URL EXIGE recreate do container."
warn "Este script PARA aqui — execute manualmente uma das opções abaixo:"
echo
echo "──────────────────────────────────────────────────────────"
echo " OPÇÃO 1 — Se o cluster usa docker-compose (easypanel/stack):"
echo "──────────────────────────────────────────────────────────"
echo "   Edita o compose do serviço supavisor, troca"
echo "     DATABASE_URL=$CURRENT_URL"
echo "   por"
echo "     DATABASE_URL=<ver /root/.supavisor-meta-password>"
echo "   Depois:"
echo "     docker compose -p alpes-ads_supabase up -d supavisor --force-recreate"
echo
echo "──────────────────────────────────────────────────────────"
echo " OPÇÃO 2 — Recreate direto via docker (mantém outras envs):"
echo "──────────────────────────────────────────────────────────"
echo "   # Pega config atual"
echo "   docker inspect $SUPAVISOR > /tmp/supavisor-before.json"
echo "   # Extrai image, envs, ports, volumes, networks..."
echo "   # Recria com DATABASE_URL novo — verifique /root/.supavisor-meta-password"
echo
echo "──────────────────────────────────────────────────────────"
echo " NEW URL template (cola do $PW_FILE):"
echo "──────────────────────────────────────────────────────────"
echo "   postgres://$NEW_USER:<senha_do_arquivo>@$DB_CONTAINER:5432/$META_DB"
echo

cat <<EOF

⚠️  DEPOIS DE RECRIAR o container Supavisor:

1. Aguarde 10-15s + rode health check:
   docker exec $SUPAVISOR /app/bin/supavisor eval ':ok'

2. Confirma que tenants continuam visíveis:
   docker exec -i $DB_CONTAINER psql -U supabase_admin -d $META_DB -c \\
     "SELECT external_id, db_database FROM _supavisor.tenants"

3. Valida que pegasus-ads continua conectando via pooled:
   curl -si https://pegasus.alpesd.com.br/api/docs | head -3

4. Se algo quebrar, ROLLBACK:
   - Restaurar DATABASE_URL original no compose
   - docker compose up -d supavisor --force-recreate
   - A role $NEW_USER fica criada mas não é usada (OK deixar ou DROP)

EOF
