#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 0 VPS setup
# =============================================================================
# O QUE FAZ:
#   1. Detecta container Supabase (alpes-ads_supabase-db-1) e superuser
#   2. Detecta pooler (PgBouncer/Supavisor) — informa, não configura
#   3. Cria database `pegasus_ads` (se não existir)
#   4. Cria roles `pegasus_ads_app` (RLS enforced) e `pegasus_ads_admin`
#      (BYPASSRLS), cada um com senha aleatória forte
#   5. Concede privilégios apropriados
#   6. Imprime snippet .env com as connection strings
#
# ONDE RODAR:
#   VPS Hostinger (srv1512423.hstgr.cloud) — `ssh root@187.77.245.144`
#   Requer Docker rodando + container `alpes-ads_supabase-db-1` ativo.
#
# IDEMPOTÊNCIA:
#   Seguro para re-rodar. Detecta se DB/roles já existem e pula criação.
#   Senhas só são geradas se role ainda não existir; caso contrário mantém
#   as senhas já definidas (e NÃO imprime — use o backup guardado).
#
# ROLLBACK (se precisar desfazer):
#   docker exec -i alpes-ads_supabase-db-1 psql -U <super> -d postgres <<SQL
#   REVOKE ALL ON DATABASE pegasus_ads FROM pegasus_ads_app, pegasus_ads_admin;
#   DROP DATABASE IF EXISTS pegasus_ads;
#   DROP ROLE IF EXISTS pegasus_ads_app;
#   DROP ROLE IF EXISTS pegasus_ads_admin;
#   SQL
# =============================================================================

set -euo pipefail

DB_NAME="pegasus_ads"
ROLE_APP="pegasus_ads_app"
ROLE_ADMIN="pegasus_ads_admin"
DB_CONTAINER="alpes-ads_supabase-db-1"
DB_HOST_INTERNAL="alpes-ads_supabase-db"   # hostname dentro da network alpes-ads_supabase_default
DB_PORT_INTERNAL=5432

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[err]\033[0m %s\n' "$*" >&2; }

# -----------------------------------------------------------------------------
# 1. Verificar container e descobrir superuser funcional
# -----------------------------------------------------------------------------
log "Verificando container ${DB_CONTAINER}"
if ! docker ps --format '{{.Names}}' | grep -qx "${DB_CONTAINER}"; then
  err "Container ${DB_CONTAINER} não está rodando."
  docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -i supabase || true
  exit 1
fi
ok "container ativo"

SUPER=""
for candidate in supabase_admin postgres; do
  if docker exec "${DB_CONTAINER}" psql -U "${candidate}" -d postgres -tAc "SELECT 1" >/dev/null 2>&1; then
    SUPER="${candidate}"
    break
  fi
done

if [[ -z "${SUPER}" ]]; then
  err "Não consegui conectar como supabase_admin nem como postgres."
  err "Verifique credenciais do cluster alpes-ads_supabase."
  exit 1
fi
ok "superuser funcional: ${SUPER}"

PSQL=(docker exec -i "${DB_CONTAINER}" psql -U "${SUPER}" -d postgres -v ON_ERROR_STOP=1)
PSQL_DB=(docker exec -i "${DB_CONTAINER}" psql -U "${SUPER}" -d "${DB_NAME}" -v ON_ERROR_STOP=1)

# -----------------------------------------------------------------------------
# 2. Postgres version e extensão pgcrypto (necessária p/ gen_random_uuid em <13)
# -----------------------------------------------------------------------------
PG_VER=$("${PSQL[@]}" -tAc "SHOW server_version")
ok "Postgres ${PG_VER}"

# -----------------------------------------------------------------------------
# 3. Detectar pooler (informativo)
# -----------------------------------------------------------------------------
POOLER=""
for c in alpes-ads_supabase-pgbouncer-1 alpes-ads_supabase-supavisor-1 supabase-pooler-1; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then
    POOLER="$c"
    break
  fi
done
if [[ -n "${POOLER}" ]]; then
  ok "pooler detectado: ${POOLER} — configurar pool na Fase 1"
else
  warn "nenhum pooler (PgBouncer/Supavisor) detectado"
  warn "Fase 0 usa conexão DIRETA ao container (alpes-ads_supabase-db:5432)"
  warn "para Fase 1+, avaliar adicionar Supavisor ao stack ou usar pool do postgres-js"
fi

# -----------------------------------------------------------------------------
# 4. Criar database pegasus_ads (idempotente)
# -----------------------------------------------------------------------------
DB_EXISTS=$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" || true)
if [[ "${DB_EXISTS}" == "1" ]]; then
  ok "database ${DB_NAME} já existe"
else
  log "criando database ${DB_NAME}"
  "${PSQL[@]}" <<SQL
CREATE DATABASE ${DB_NAME} OWNER ${SUPER};
SQL
  ok "database ${DB_NAME} criado"
fi

# Habilitar pgcrypto no database (gen_random_uuid é core em 13+, mas a extensão
# adiciona utilities usadas em seeds/migrations)
"${PSQL_DB[@]}" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto" >/dev/null
ok "extensão pgcrypto garantida em ${DB_NAME}"

# -----------------------------------------------------------------------------
# 5. Criar roles (idempotente — só gera senha se role não existir)
# -----------------------------------------------------------------------------
gen_pw() {
  # 32 chars alfanuméricos — sem caracteres que quebram env-file do Docker
  openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 32
}

role_exists() {
  local role="$1"
  local exists
  exists=$("${PSQL[@]}" -tAc "SELECT 1 FROM pg_roles WHERE rolname = '${role}'" || true)
  [[ "${exists}" == "1" ]]
}

APP_PW=""
ADMIN_PW=""
NEW_APP=0
NEW_ADMIN=0

if role_exists "${ROLE_APP}"; then
  ok "role ${ROLE_APP} já existe (senha preservada)"
else
  APP_PW="$(gen_pw)"
  log "criando role ${ROLE_APP}"
  "${PSQL[@]}" <<SQL
CREATE ROLE ${ROLE_APP} LOGIN PASSWORD '${APP_PW}';
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${ROLE_APP};
SQL
  NEW_APP=1
  ok "role ${ROLE_APP} criada"
fi

if role_exists "${ROLE_ADMIN}"; then
  ok "role ${ROLE_ADMIN} já existe (senha preservada)"
else
  ADMIN_PW="$(gen_pw)"
  log "criando role ${ROLE_ADMIN} (BYPASSRLS)"
  "${PSQL[@]}" <<SQL
CREATE ROLE ${ROLE_ADMIN} LOGIN PASSWORD '${ADMIN_PW}' BYPASSRLS;
GRANT CONNECT ON DATABASE ${DB_NAME} TO ${ROLE_ADMIN};
SQL
  NEW_ADMIN=1
  ok "role ${ROLE_ADMIN} criada"
fi

# -----------------------------------------------------------------------------
# 6. Privilégios no schema public (sempre re-aplica — idempotente)
# -----------------------------------------------------------------------------
log "aplicando privilégios em ${DB_NAME}.public"
"${PSQL_DB[@]}" <<SQL
-- App role: CRUD, sem DDL
GRANT USAGE ON SCHEMA public TO ${ROLE_APP};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE_APP};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_APP};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE_APP};
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE_APP};

-- Admin role: tudo (DDL incluído — usado por drizzle-kit/migrations)
-- GRANT CREATE ON DATABASE é necessário para drizzle-kit criar schema `drizzle`
-- (fix #4 do fase1b-complete-report — sem isso, migrate falha com permission denied).
GRANT CREATE ON DATABASE ${DB_NAME} TO ${ROLE_ADMIN};
GRANT ALL PRIVILEGES ON SCHEMA public TO ${ROLE_ADMIN};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${ROLE_ADMIN};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_ADMIN};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${ROLE_ADMIN};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${ROLE_ADMIN};
SQL
ok "privilégios aplicados"

# -----------------------------------------------------------------------------
# 7. Resumo final
# -----------------------------------------------------------------------------
echo
echo "====================================================================="
echo " Fase 0 — setup concluído"
echo "====================================================================="
echo
echo "  Container  : ${DB_CONTAINER}"
echo "  Postgres   : ${PG_VER}"
echo "  Superuser  : ${SUPER}"
echo "  Pooler     : ${POOLER:-nenhum (conexão direta)}"
echo "  Database   : ${DB_NAME}"
echo "  Roles      : ${ROLE_APP} (RLS), ${ROLE_ADMIN} (BYPASSRLS)"
echo

if [[ "${NEW_APP}" == 1 || "${NEW_ADMIN}" == 1 ]]; then
  echo "Cole estas linhas no .env do pegasus-ads no VPS (/apps/pegasus/.env):"
  echo "-----------------------------------------------------------------------"
  [[ "${NEW_APP}" == 1 ]] && echo "DATABASE_URL=postgres://${ROLE_APP}:${APP_PW}@${DB_HOST_INTERNAL}:${DB_PORT_INTERNAL}/${DB_NAME}?sslmode=disable"
  [[ "${NEW_ADMIN}" == 1 ]] && echo "DATABASE_URL_ADMIN=postgres://${ROLE_ADMIN}:${ADMIN_PW}@${DB_HOST_INTERNAL}:${DB_PORT_INTERNAL}/${DB_NAME}?sslmode=disable"
  echo "-----------------------------------------------------------------------"
  echo
  echo "⚠️  SALVE AS SENHAS AGORA — não dá para recuperar depois sem resetar."
  echo "⚠️  No VPS, .env NÃO pode ter aspas nos valores."
  echo "⚠️  Para Brain: salve as senhas como memória no projeto infra-vps."
else
  echo "Nenhuma senha nova gerada (roles já existiam). Use as senhas já guardadas."
fi

echo
echo "Próximo passo: Fase 1 (ORM migration) — executar drizzle-kit generate"
echo "                a partir dos schemas ./src/lib/db/schema/*"
