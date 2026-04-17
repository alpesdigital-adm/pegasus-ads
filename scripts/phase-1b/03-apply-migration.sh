#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 03: Aplicar Drizzle migration
# =============================================================================
# RODAR ONDE: VPS Hostinger, dentro de /apps/pegasus
# OBJETIVO: aplicar drizzle/*.sql no database pegasus_ads do Supabase.
#
# PRÉ-REQUISITOS:
#   - DATABASE_URL_ADMIN configurado no .env apontando para pegasus_ads
#     via role pegasus_ads_admin
#
# GOTCHAS CONHECIDOS (fase1b-complete-report.md, fixes #1-#3):
#   - #1: `DATABASE_URL_ADMIN` com hostname `alpes-ads_supabase-db` não
#     resolve a partir do host da VPS. Script detecta e sugere rodar a
#     partir de dentro da network Docker do Supabase.
#   - #2: drizzle-kit migrate às vezes trava. Fallback: aplicar SQLs
#     manualmente via `psql -f`, depois popular __drizzle_migrations.
#   - #3: migration 0002 tem ALTER TYPE integer→uuid em classified_insights
#     que falha em tabela populada. Se estiver aplicando em DB já com
#     dados de migration 0001 aplicada (raro — só acontece no fluxo
#     manual do gêmeo), fazer DROP COLUMN + ADD COLUMN uuid manualmente
#     antes de rodar 0002.
#
# IDEMPOTÊNCIA: drizzle-kit migrate rastreia em drizzle.__drizzle_migrations
# =============================================================================

set -euo pipefail

cd /apps/pegasus

# Verificar branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != claude/* ]]; then
  echo "AVISO: branch atual é '$BRANCH' (esperado claude/...). Continuar? [y/N]"
  read -r REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

# Carrega .env
if [[ ! -f .env ]]; then echo "ERRO: .env não achado" >&2; exit 1; fi
set -a; source .env; set +a
: "${DATABASE_URL_ADMIN:?DATABASE_URL_ADMIN precisa estar em .env}"

# Verificar que migrations existem
if [[ ! -d drizzle ]] || [[ $(ls drizzle/*.sql 2>/dev/null | wc -l) -eq 0 ]]; then
  echo "ERRO: drizzle/*.sql não encontrado." >&2
  exit 1
fi
MIGRATION_COUNT=$(ls drizzle/*.sql | wc -l)
echo "[info] $MIGRATION_COUNT migrations encontradas em drizzle/"

# Detectar hostname do DATABASE_URL_ADMIN — se for hostname de Docker network,
# avisar que drizzle-kit precisa rodar dentro da network (fix #1)
DB_HOST=$(echo "$DATABASE_URL_ADMIN" | sed -E 's|.*@([^:/]+)[:/].*|\1|')
if [[ "$DB_HOST" == *"alpes-ads_supabase"* ]]; then
  echo "[warn] hostname '$DB_HOST' só resolve dentro da network Docker do Supabase."
  echo "[warn] Se drizzle-kit falhar com 'could not translate host name', duas opções:"
  echo "[warn]   A) usar localhost:5432 em vez do hostname (requer porta exposta)"
  echo "[warn]   B) rodar drizzle-kit via docker run --network alpes-ads_supabase_default"
fi

echo
echo "[1/3] Estado do database pegasus_ads (antes):"
docker exec alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads \
  -c "SELECT count(*) AS tables_existing FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'" \
  2>/dev/null || echo "  (não consegui conectar como pegasus_ads_admin — verifique DATABASE_URL_ADMIN)"

echo
echo "[2/3] Aplicando Drizzle migrations..."
read -p "Continuar? [y/N] " -n 1 -r; echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

if ! npx drizzle-kit migrate; then
  echo
  echo "[warn] drizzle-kit migrate falhou (fix #2). Fallback: aplicação manual."
  echo
  read -p "Aplicar .sql files manualmente via docker exec psql? [y/N] " -n 1 -r; echo
  [[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 1; }

  docker exec -i alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads <<'SQL'
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL,
  created_at BIGINT
);
SQL

  for f in drizzle/*.sql; do
    echo "  applying: $f"
    docker exec -i alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads \
      -v ON_ERROR_STOP=1 < "$f" || {
        echo "  ERRO: falha em $f — ver fix #3 no fase1b-complete-report.md"
        exit 1
      }
    # Registra o hash (sha256 do conteúdo) no tracking
    HASH=$(sha256sum "$f" | cut -d' ' -f1)
    docker exec -i alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads -c \
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('$HASH', $(date +%s%3N)) ON CONFLICT DO NOTHING"
  done
fi

echo
echo "[3/3] Estado do database pegasus_ads (depois):"
docker exec alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads -c "\dt" | head -60

echo
echo "====================================================================="
echo " Migrations aplicadas. Próximo: scripts/phase-1b/04-pg-dump-data.sh"
echo "====================================================================="
