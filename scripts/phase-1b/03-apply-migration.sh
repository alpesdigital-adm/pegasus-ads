#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 03: Aplicar Drizzle migration 0000
# =============================================================================
# RODAR ONDE: VPS Hostinger, dentro de /apps/pegasus
# OBJETIVO: aplicar drizzle/0000_0000_phase_1a_foundation.sql no database
#           pegasus_ads do Supabase, criando todas as 28 tabelas vazias.
#
# PRÉ-REQUISITOS:
#   - Step 01 (inspeção do Neon) concluído — schemas das 6 tabelas Creative
#     Intelligence (TD-008) extraídos
#   - Próxima sessão Claude já adicionou os schemas faltantes E regerou
#     a migration (provavelmente migration 0001)
#   - DATABASE_URL_ADMIN configurado no .env apontando para pegasus_ads
#
# IDEMPOTÊNCIA: drizzle-kit migrate é idempotente (rastreia em __drizzle_migrations)
# =============================================================================

set -euo pipefail

cd /apps/pegasus

# Verificar que estamos na branch correta
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != claude/* ]]; then
  echo "AVISO: branch atual é '$BRANCH' (esperado claude/...). Continuar? [y/N]"
  read -r REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

# Verificar que .env tem DATABASE_URL_ADMIN
if ! grep -q '^DATABASE_URL_ADMIN=' .env; then
  echo "ERRO: DATABASE_URL_ADMIN não está em .env. Configure antes de rodar." >&2
  exit 1
fi

# Verificar que migration 0000 existe
MIGRATION=drizzle/0000_0000_phase_1a_foundation.sql
if [[ ! -f "$MIGRATION" ]]; then
  echo "ERRO: $MIGRATION não encontrado." >&2
  exit 1
fi

echo "[1/3] Verificando estado do database pegasus_ads..."
docker exec alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads \
  -c "SELECT count(*) AS tables_existing FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'"

echo
echo "[2/3] Aplicando Drizzle migration..."
echo "    (drizzle-kit migrate usa DATABASE_URL_ADMIN automaticamente)"
echo
read -p "Continuar? [y/N] " -n 1 -r
echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

# Carrega .env e roda
set -a; source .env; set +a
DATABASE_URL_ADMIN="$DATABASE_URL_ADMIN" npx drizzle-kit migrate

echo
echo "[3/3] Verificando tabelas criadas..."
docker exec alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads -c "\dt"
echo
echo "====================================================================="
echo " Migration aplicada. Database pegasus_ads agora tem o schema Drizzle."
echo "====================================================================="
echo
echo " Próximo: scripts/phase-1b/04-pg-dump-data.sh"
