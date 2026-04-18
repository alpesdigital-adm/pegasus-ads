#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 01: Inspeção do Neon
# =============================================================================
# RODAR ONDE: VPS Hostinger (srv1512423.hstgr.cloud), terminal local SSH
# OBJETIVO:
#   1. Conectar no Neon (usando NEON_URL do .env) e listar todas as tabelas
#   2. Capturar schema (\d table) de cada tabela em arquivos separados
#   3. Capturar contagem de linhas (sanity baseline para validar restore)
#   4. Detectar PKs com IDs NÃO-UUID-format (precisam UUIDv5 conversion)
#   5. Extrair schemas das 6 tabelas Creative Intelligence (TD-008):
#      offers, concepts, angles, launches, ad_creatives, classified_insights
#
# OUTPUT: /tmp/pegasus-ads-neon-inspect/
#   - tables.txt        → lista de todas as tabelas
#   - row_counts.tsv    → contagem por tabela
#   - schema_<table>.txt → \d output por tabela
#   - non_uuid_pks.tsv  → tabelas/colunas com IDs não-UUID
#
# DEPOIS DE RODAR: copiar /tmp/pegasus-ads-neon-inspect/* e enviar pra mim
# (próxima sessão) — vou usar para finalizar os schemas Drizzle.
# =============================================================================

set -euo pipefail

OUT=/tmp/pegasus-ads-neon-inspect
mkdir -p "$OUT"

# Pegar NEON_URL do .env do pegasus-ads no VPS
ENV_FILE=/apps/pegasus/.env
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERRO: $ENV_FILE não encontrado." >&2; exit 1
fi

# DATABASE_URL_NEON foi preservado na Fase 0 como fallback
NEON_URL=$(grep -E '^DATABASE_URL_NEON=' "$ENV_FILE" | cut -d= -f2-)
if [[ -z "$NEON_URL" ]]; then
  # fallback: tentar DATABASE_URL antigo se ainda for o Neon
  NEON_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)
fi
if [[ -z "$NEON_URL" ]]; then
  echo "ERRO: nem DATABASE_URL_NEON nem DATABASE_URL achados em $ENV_FILE" >&2
  exit 1
fi
echo "Conectando no Neon: ${NEON_URL//:*@/:***@}"

PSQL=(psql "$NEON_URL" -At -v ON_ERROR_STOP=1)

# ── 1. Listar tabelas ────────────────────────────────────────────────────
echo "[1/5] Listando tabelas..."
"${PSQL[@]}" -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name" \
  > "$OUT/tables.txt"
TABLE_COUNT=$(wc -l < "$OUT/tables.txt")
echo "  → $TABLE_COUNT tabelas encontradas"

# ── 2. Row counts ────────────────────────────────────────────────────────
echo "[2/5] Contando linhas por tabela..."
{
  while IFS= read -r tbl; do
    count=$("${PSQL[@]}" -c "SELECT count(*) FROM \"$tbl\"" 2>/dev/null || echo "ERR")
    printf '%s\t%s\n' "$tbl" "$count"
  done < "$OUT/tables.txt"
} > "$OUT/row_counts.tsv"

# ── 3. Schema dump por tabela ────────────────────────────────────────────
echo "[3/5] Capturando \d de cada tabela..."
while IFS= read -r tbl; do
  psql "$NEON_URL" -c "\d \"$tbl\"" > "$OUT/schema_${tbl}.txt" 2>&1 || true
done < "$OUT/tables.txt"

# ── 4. Schema completo via pg_dump (para referência total) ───────────────
echo "[4/5] pg_dump --schema-only..."
pg_dump "$NEON_URL" --schema-only --no-owner --no-acl > "$OUT/schema_full.sql" 2>&1 || \
  echo "  ⚠️  pg_dump falhou — checar ferramenta instalada"

# ── 5. Detectar PKs não-UUID (precisam UUIDv5 conversion) ────────────────
echo "[5/5] Procurando PKs com IDs não-UUID..."
"${PSQL[@]}" <<'SQL' > "$OUT/non_uuid_pks.tsv" || true
WITH pk_cols AS (
  SELECT
    tc.table_name,
    kcu.column_name,
    c.data_type
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.columns c
    ON kcu.table_name = c.table_name
    AND kcu.column_name = c.column_name
    AND kcu.table_schema = c.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = 'public'
    AND c.data_type IN ('text', 'character varying')
)
SELECT pk.table_name, pk.column_name, pk.data_type
FROM pk_cols pk
ORDER BY pk.table_name;
SQL

echo
echo "====================================================================="
echo " Inspeção concluída — output em $OUT"
echo "====================================================================="
echo
echo "Próximos passos:"
echo "  1. Comprimir e enviar para próxima sessão Claude:"
echo "     tar czf /tmp/pegasus-ads-neon-inspect.tar.gz -C $OUT ."
echo "  2. Especialmente importante: schemas das 6 tabelas Creative"
echo "     Intelligence (TD-008):"
for t in offers concepts angles launches ad_creatives classified_insights; do
  if [[ -f "$OUT/schema_${t}.txt" ]]; then
    echo "       ✓ schema_${t}.txt"
  else
    echo "       ✗ schema_${t}.txt (NÃO existe — investigar)"
  fi
done
echo
echo "  3. Conferir total de tabelas: $TABLE_COUNT"
echo "     (esperado: 28 do db.ts + 6 da Creative Intel = 34)"
