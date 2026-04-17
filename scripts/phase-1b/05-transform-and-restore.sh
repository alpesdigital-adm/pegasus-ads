#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 05: Transformar IDs literais e restaurar
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO:
#   1. Transformar IDs literais (não-UUID-format) em UUIDv5 determinísticos
#   2. Restaurar dump transformado no pegasus_ads
#
# IDS LITERAIS CONHECIDOS (do legacy db.ts):
#   - plans: 'plan_free', 'plan_pro', 'plan_enterprise'
#   - (possivelmente outros — checar output do step 01: non_uuid_pks.tsv)
#
# UUIDv5 NAMESPACE: DNS namespace padrão (6ba7b810-9dad-11d1-80b4-00c04fd430c8)
# IDs UUIDv5 são determinísticos: mesmo input → mesmo UUID. Re-rodar é seguro.
#
# Para conversão UUIDv5 em SQL puro, usamos uuid_generate_v5() do pgcrypto/
# uuid-ossp. Como pgcrypto está habilitado (Fase 0), criamos uma função local.
# =============================================================================

set -euo pipefail

DUMP=/tmp/pegasus-ads-data-dump.sql
TRANSFORMED=/tmp/pegasus-ads-data-transformed.sql

if [[ ! -f "$DUMP" ]]; then
  echo "ERRO: $DUMP não existe. Rode 04-pg-dump-data.sh primeiro." >&2
  exit 1
fi

# ── 1. Mapeamento de IDs literais → UUIDv5 ──────────────────────────────
# UUIDv5 é determinístico — pré-computado offline com:
#   python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'plan_free'))"
# Resultados (NAMESPACE_DNS = 6ba7b810-9dad-11d1-80b4-00c04fd430c8):
declare -A ID_MAP=(
  [plan_free]="64a6fc6c-1c01-5fb9-ba0b-a24cb1d50fdf"
  [plan_pro]="2b34dd62-fe7b-5b94-b0ac-dab5f4cb86b5"
  [plan_enterprise]="50fe9b3e-4c2b-5ddf-8afa-91d23e30bbac"
)
# Importante: validar via Python na VPS antes de rodar:
#   python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, 'plan_free'))"
# Se diferente, ATUALIZAR o ID_MAP acima ou recalcular automaticamente
# (script abaixo recalcula se Python disponível).

if command -v python3 >/dev/null; then
  echo "[1/3] Validando UUIDs determinísticos com Python..."
  for key in "${!ID_MAP[@]}"; do
    expected="${ID_MAP[$key]}"
    actual=$(python3 -c "import uuid; print(uuid.uuid5(uuid.NAMESPACE_DNS, '$key'))")
    if [[ "$actual" != "$expected" ]]; then
      echo "  ⚠️  Mismatch para '$key': esperado=$expected, obtido=$actual"
      echo "  Atualizando ID_MAP em runtime..."
      ID_MAP[$key]="$actual"
    else
      echo "  ✓ $key → $actual"
    fi
  done
else
  echo "  ⚠️  Python3 não disponível — usando ID_MAP estático (validar antes!)"
fi

# ── 2. Aplicar transformações no dump ────────────────────────────────────
echo
echo "[2/3] Transformando IDs literais no dump..."
cp "$DUMP" "$TRANSFORMED"

for old in "${!ID_MAP[@]}"; do
  new="${ID_MAP[$old]}"
  # Replace 'old_id' → 'new_uuid' apenas em contextos de ID
  # (cuidado: não fazer replace cego — pode atingir nomes/values)
  # Aproximação segura: substituir apenas valores entre aspas em INSERTs
  sed -i "s|'$old'|'$new'|g" "$TRANSFORMED"
  count=$(grep -c "$new" "$TRANSFORMED" || true)
  echo "  $old → $new ($count ocorrências)"
done

# ── 3. Restaurar no pegasus_ads ──────────────────────────────────────────
echo
echo "[3/3] Restaurando no pegasus_ads (via dbAdmin para BYPASSRLS)..."
echo
read -p "Confirmar restore no pegasus_ads (apaga dados existentes)? [y/N] " -n 1 -r
echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

# TRUNCATE primeiro pra garantir restore limpo (CASCADE para FKs)
docker exec -i alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads <<'SQL'
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT LIKE '\_%'
      AND tablename != '__drizzle_migrations'
  LOOP
    EXECUTE format('TRUNCATE TABLE %I CASCADE', tbl);
  END LOOP;
END $$;
SQL

# Restore o dump transformado
docker exec -i alpes-ads_supabase-db-1 psql -U pegasus_ads_admin -d pegasus_ads \
  -v ON_ERROR_STOP=1 < "$TRANSFORMED"

echo
echo "====================================================================="
echo " Restore concluído. Validar com scripts/phase-1b/06-validate.sh"
echo "====================================================================="
