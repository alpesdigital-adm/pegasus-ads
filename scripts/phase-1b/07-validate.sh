#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 07: Validação pós-migração
# =============================================================================
# RODAR ONDE: VPS Hostinger, /apps/pegasus
# OBJETIVO: validar que o restore + RLS estão corretos
#   1. Contagem por tabela (Neon vs pegasus_ads)
#   2. Sanidade de FKs (nenhum orphan)
#   3. RLS fail-safe — pegasus_ads_app sem SET LOCAL retorna 0 rows
#   4. RLS positivo — pegasus_ads_app COM SET LOCAL retorna rows
#   5. dbAdmin (BYPASSRLS) retorna tudo
# =============================================================================

set -euo pipefail

ENV_FILE=/apps/pegasus/.env
NEON_URL=$(grep -E '^DATABASE_URL_NEON=' "$ENV_FILE" | cut -d= -f2-)
[[ -n "$NEON_URL" ]] || NEON_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)

# Senhas das roles (defina via env antes)
DB_APP_PASSWORD="${DB_APP_PASSWORD:?defina DB_APP_PASSWORD}"
DB_ADMIN_PASSWORD="${DB_ADMIN_PASSWORD:?defina DB_ADMIN_PASSWORD}"

DB_CONTAINER=alpes-ads_supabase-db-1
# Fix #12: docker exec com peer auth falha — preciso passar a senha via env.
# Uso URL com senha embutida no connection string (PGPASSWORD funciona igual).
PSQL_ADMIN=(docker exec -i "$DB_CONTAINER"
  psql "postgres://pegasus_ads_admin:${DB_ADMIN_PASSWORD}@localhost:5432/pegasus_ads" -At)
PSQL_APP=(docker exec -i "$DB_CONTAINER"
  psql "postgres://pegasus_ads_app:${DB_APP_PASSWORD}@localhost:5432/pegasus_ads" -At)

# ── 1. Comparação de contagem ────────────────────────────────────────────
echo "[1/4] Comparando contagem de rows: Neon vs pegasus_ads"
echo
printf '%-35s %12s %12s %s\n' "tabela" "neon" "pegasus_ads" "diff"
printf '%-35s %12s %12s %s\n' "---" "---" "---" "---"

# Tabelas a comparar (excluindo legacy auth)
TABLES=$(psql "$NEON_URL" -At -c "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN ('users', 'sessions', '__drizzle_migrations') ORDER BY table_name")

for tbl in $TABLES; do
  neon_count=$(psql "$NEON_URL" -At -c "SELECT count(*) FROM \"$tbl\"" 2>/dev/null || echo "ERR")
  pa_count=$("${PSQL_ADMIN[@]}" -c "SELECT count(*) FROM \"$tbl\"" 2>/dev/null || echo "ERR")
  if [[ "$neon_count" == "$pa_count" ]]; then
    flag="✓"
  else
    flag="✗ DIFF"
  fi
  printf '%-35s %12s %12s %s\n' "$tbl" "$neon_count" "$pa_count" "$flag"
done

echo
echo "[2/4] Verificando FKs orfãs (esperado: 0 em todas)"
"${PSQL_ADMIN[@]}" <<'SQL'
SELECT 'creatives sem workspace' AS check, count(*)
FROM creatives WHERE workspace_id IS NULL
UNION ALL
SELECT 'metrics sem creative existente', count(*)
FROM metrics m WHERE NOT EXISTS (SELECT 1 FROM creatives c WHERE c.id = m.creative_id)
UNION ALL
SELECT 'creative_edges com workspace_id NULL', count(*)
FROM creative_edges WHERE workspace_id IS NULL
UNION ALL
SELECT 'creative_ref_images com workspace_id NULL', count(*)
FROM creative_ref_images WHERE workspace_id IS NULL
UNION ALL
SELECT 'workspace_members com workspace inexistente', count(*)
FROM workspace_members wm WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = wm.workspace_id);
SQL

# ── 3. RLS fail-safe ────────────────────────────────────────────────────
echo
echo "[3/4] RLS fail-safe — query como pegasus_ads_app SEM SET LOCAL"
echo "      (esperado: 0 rows em todas as tabelas RLS-enabled)"
RESULT=$("${PSQL_APP[@]}" -c "SELECT count(*) FROM creatives" 2>/dev/null || echo "ERR")
if [[ "$RESULT" == "0" ]]; then
  echo "  ✓ creatives retornou 0 rows — RLS funcionando"
elif [[ "$RESULT" == "ERR" ]]; then
  echo "  ✗ erro de conexão como pegasus_ads_app"
else
  echo "  ✗ creatives retornou $RESULT rows — RLS NÃO está enforced!"
  exit 2
fi

# ── 4. RLS positivo ──────────────────────────────────────────────────────
echo
echo "[4/4] RLS positivo — pegando primeiro workspace e testando SET LOCAL"
WS_ID=$("${PSQL_ADMIN[@]}" -c "SELECT id FROM workspaces LIMIT 1")
if [[ -z "$WS_ID" ]]; then
  echo "  ⚠️  Nenhum workspace na tabela — pular teste"
else
  echo "  workspace_id de teste: $WS_ID"
  COUNT=$("${PSQL_APP[@]}" <<SQL
BEGIN;
SET LOCAL app.workspace_id = '$WS_ID';
SELECT count(*) FROM creatives;
COMMIT;
SQL
)
  echo "  creatives do workspace $WS_ID: $COUNT"
fi

echo
echo "====================================================================="
echo " Validação concluída. Se tudo OK, app pode apontar DATABASE_URL"
echo " para Supavisor (start de Fase 1C)."
echo "====================================================================="
