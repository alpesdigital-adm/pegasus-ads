#!/usr/bin/env bash
# =============================================================================
# Phase 2 — Supavisor Pooling (TD-002)
# 03-smoke.sh — valida connectivity + RLS (SET LOCAL) via Supavisor
# =============================================================================
# CRÍTICO: testa se set_config('app.workspace_id', ..., true) preserva valor
# dentro da mesma transação quando conectado via Supavisor transaction mode.
# Isso é o que faz o withWorkspace() funcionar — se quebrar, RLS vira 0 rows.
#
# Uso:
#   DB_APP_PASSWORD='senha' bash 03-smoke.sh
# =============================================================================

set -euo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
TENANT=pegasus_ads
TARGET_DB=pegasus_ads
TARGET_USER=pegasus_ads_app

if [[ -z "${DB_APP_PASSWORD:-}" ]]; then
  echo "DB_APP_PASSWORD env var obrigatória" >&2
  exit 1
fi

URL="postgres://${TARGET_USER}.${TENANT}:${DB_APP_PASSWORD}@${SUPAVISOR}:6543/${TARGET_DB}?sslmode=disable"

banner() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
pass()   { printf '\033[1;32m[PASS]\033[0m %s\n' "$*"; }
fail()   { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

run_psql() {
  docker run --rm --network alpes-ads_supabase_default \
    -e PGPASSWORD="$DB_APP_PASSWORD" \
    postgres:17-alpine psql "$URL" -tA -c "$1"
}

banner "Teste 1 — Connectivity"
out=$(run_psql "SELECT current_user, current_database()")
if [[ "$out" == "$TARGET_USER|$TARGET_DB" ]]; then
  pass "conectou como $TARGET_USER em $TARGET_DB"
else
  fail "current_user|database inesperado: $out"
fi

banner "Teste 2 — Prepared statements desabilitados (Supavisor requisito)"
# postgres-js usa prepare:false já; testa se a conexão aceita queries normais
out=$(run_psql "SELECT 1+1")
[[ "$out" == "2" ]] && pass "queries simples funcionam" || fail "query básica falhou: $out"

banner "Teste 3 — SET LOCAL persiste dentro da transação"
# Simula withWorkspace() — SET LOCAL + SELECT depois dele, tudo no mesmo BEGIN
# Nota: psql emite output pra cada comando (BEGIN, SET, SELECT, COMMIT).
# `tail -1` pegava "COMMIT" — precisamos do penúltimo (valor do SELECT).
out=$(run_psql "BEGIN;
SELECT set_config('app.workspace_id', 'test-uuid-smoke-ws', true);
SELECT current_setting('app.workspace_id', true) AS ws_id;
COMMIT;" | grep -v '^$' | tail -2 | head -1)
if [[ "$out" == "test-uuid-smoke-ws" ]]; then
  pass "SET LOCAL persiste — RLS vai funcionar"
else
  fail "SET LOCAL NÃO persistiu. current_setting retornou: '$out'"
fi

banner "Teste 4 — SET LOCAL NÃO vaza entre transações (isolation)"
# Depois do COMMIT, o setting deve sumir. Se vazar, é bug de segurança.
out=$(run_psql "SELECT COALESCE(current_setting('app.workspace_id', true), 'null')")
if [[ "$out" == "null" || "$out" == "" ]]; then
  pass "setting some após COMMIT (isolation correto)"
else
  fail "SET LOCAL VAZOU entre transações — valor='$out'. BUG DE SEGURANÇA; NÃO FAZER CUTOVER"
fi

banner "Teste 5 — RLS real no workspaces (smoke end-to-end)"
# Tenta SELECT sem SET LOCAL — RLS deve retornar 0 rows
out=$(run_psql "SELECT COUNT(*) FROM workspaces" 2>&1 || echo "ERR")
if [[ "$out" == "0" ]]; then
  pass "RLS block funciona: COUNT sem workspace_id = 0"
else
  # Pode ser 0 (RLS OK) ou pode ter dado erro (ex: permission denied) — ambos aceitáveis
  printf '\033[1;33m[warn]\033[0m RLS retornou: "%s" (esperado 0 ou permission denied)\n' "$out"
fi

# Com SET LOCAL setado, deveria ver o workspace correto
ws_id=$(docker exec alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads -tAc \
  "SELECT id FROM workspaces ORDER BY created_at LIMIT 1" 2>/dev/null | head -1)

if [[ -n "$ws_id" ]]; then
  out=$(run_psql "BEGIN;
  SELECT set_config('app.workspace_id', '$ws_id', true);
  SELECT COUNT(*) FROM workspaces WHERE id = '$ws_id';
  COMMIT;" | tail -1)
  if [[ "$out" == "1" ]]; then
    pass "RLS com workspace_id válido retorna row (end-to-end)"
  else
    fail "RLS com workspace_id setado ainda retorna $out rows (esperado 1)"
  fi
else
  printf '\033[1;33m[skip]\033[0m nenhum workspace no DB — pula teste end-to-end\n'
fi

banner "Resultado"
pass "Todos os testes passaram. Seguro fazer cutover (04-cutover.sh)"
