#!/usr/bin/env bash
# =============================================================================
# TD-014 — follow-ups #1 + #2 da peer review
# 03-tighten-grants.sh — reduz escopo da role supavisor_meta
# =============================================================================
# Baseado na informação do Leandro (2026-04-18): schema _supabase está
# VAZIO (todas as 5 tabelas do metadata ficam em _supavisor.*). Portanto:
#
# Fix #2: GRANT ALL em _supabase é desnecessário (schema vazio).
#         Mantemos só USAGE e GRANT em DEFAULT PRIVILEGES pra cobrir
#         futuras tables (ex: se imagem nova do Supavisor criar algo lá).
#
# Fix #1: REVOKE CREATE em _supavisor — em runtime Supavisor só escreve
#         rows em tables existentes, não precisa criar schemas/tables.
#         Cuidado: isso quebra UPGRADE da imagem do Supavisor (nova
#         versão pode ter migrations pendentes). Pre-upgrade: re-grant
#         temporário, deixa migration rodar, revoke de novo.
#
# Uso:
#   bash 03-tighten-grants.sh
#
# Idempotente. Safe pra re-rodar.
# =============================================================================

set -euo pipefail

DB_CONTAINER=alpes-ads_supabase-db-1
META_DB=_supabase
ROLE=supavisor_meta

log()  { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# Pré-check: role existe
existing=$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname = '$ROLE'" 2>/dev/null || true)
if [[ "$existing" != "1" ]]; then
  echo "Role $ROLE não existe — rodou 02-isolate-user.sh primeiro?" >&2
  exit 1
fi

log "Auditoria — privilégios atuais de $ROLE em $META_DB"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$META_DB" -c \
  "SELECT n.nspname AS schema, c.relname AS table,
          array_agg(p.privilege_type ORDER BY p.privilege_type) AS privs
   FROM pg_namespace n
   JOIN pg_class c ON c.relnamespace = n.oid
   LEFT JOIN information_schema.table_privileges p
     ON p.table_schema = n.nspname
    AND p.table_name = c.relname
    AND p.grantee = '$ROLE'
   WHERE n.nspname IN ('_supavisor','_supabase','public')
     AND c.relkind = 'r'
   GROUP BY n.nspname, c.relname
   ORDER BY n.nspname, c.relname;" 2>/dev/null || true

echo

log "Fix #1: REVOKE CREATE ON SCHEMA _supavisor"
log "Fix #2: REVOKE privilégios tables em _supabase (schema vazio hoje)"

docker exec -i "$DB_CONTAINER" psql -U supabase_admin -d "$META_DB" -v ON_ERROR_STOP=1 <<SQL
-- ============ Fix #1: _supavisor schema ============
-- Runtime só precisa de USAGE. CREATE era pra migration-on-boot, mas em
-- runtime normal Supavisor não cria objetos novos.
--
-- ⚠️ Antes de 'docker pull supabase/supavisor:NEW' + recreate:
--   GRANT CREATE ON SCHEMA _supavisor TO supavisor_meta;
-- Deixa migration rodar.
-- Depois:
--   REVOKE CREATE ON SCHEMA _supavisor FROM supavisor_meta;
REVOKE CREATE ON SCHEMA _supavisor FROM $ROLE;

-- ============ Fix #2: _supabase schema ============
-- Schema está vazio hoje. REVOKE ALL PRIVILEGES em tables (que não
-- existem), manter só USAGE + DEFAULT PRIVILEGES pra cobrir caso
-- imagem futura crie tables lá.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA $META_DB FROM $ROLE;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA $META_DB FROM $ROLE;

-- Mantém USAGE (precisa pra resolver nomes no schema) + DEFAULT
-- PRIVILEGES (cobertura preventiva)
GRANT USAGE ON SCHEMA $META_DB TO $ROLE;

ALTER DEFAULT PRIVILEGES IN SCHEMA $META_DB
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $ROLE;
ALTER DEFAULT PRIVILEGES IN SCHEMA $META_DB
  GRANT USAGE ON SEQUENCES TO $ROLE;
SQL

ok "GRANTs tightened"

echo

log "Auditoria pós-fix — privilégios de $ROLE"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d "$META_DB" -c \
  "SELECT n.nspname AS schema, c.relname AS table,
          array_agg(p.privilege_type ORDER BY p.privilege_type) AS privs
   FROM pg_namespace n
   JOIN pg_class c ON c.relnamespace = n.oid
   LEFT JOIN information_schema.table_privileges p
     ON p.table_schema = n.nspname
    AND p.table_name = c.relname
    AND p.grantee = '$ROLE'
   WHERE n.nspname IN ('_supavisor','_supabase','public')
     AND c.relkind = 'r'
   GROUP BY n.nspname, c.relname
   ORDER BY n.nspname, c.relname;" 2>/dev/null || true

echo

log "Smoke — Supavisor continua funcionando?"
if docker exec alpes-ads_supabase-supavisor-1 /app/bin/supavisor eval ':ok' >/dev/null 2>&1; then
  ok "Supavisor eval ok"
else
  warn "Supavisor eval falhou — investigar logs"
  docker logs alpes-ads_supabase-supavisor-1 --tail 20 2>&1 | head -30
fi

cat <<EOF

Próximo smoke (externo):
  curl -si https://pegasus.alpesd.com.br/api/health | head -5

Antes de qualquer UPGRADE da imagem do Supavisor:
  docker exec -i $DB_CONTAINER psql -U supabase_admin -d $META_DB -c \\
    "GRANT CREATE ON SCHEMA _supavisor TO $ROLE;"
  # depois do upgrade + migration, re-rodar este script pra revoke.
EOF
