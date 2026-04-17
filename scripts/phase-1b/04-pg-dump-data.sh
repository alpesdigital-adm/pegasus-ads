#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 04: pg_dump dos dados do Neon
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO: dump APENAS dos dados do Neon (schema já está no pegasus_ads via
#           Drizzle migration). Formato INSERT (text) para permitir
#           transformação de IDs antes do restore.
#
# POSTGRES VERSION: Neon roda Postgres 17.x, mas o pg_dump do apt/Ubuntu é
#                   16.x. Usamos `docker run postgres:17-alpine pg_dump` para
#                   evitar "server version mismatch".
#
# OUTPUT: /tmp/pegasus-ads-data-dump.sql (~50k rows esperados)
#
# DEPOIS: rodar 05-transform-and-restore.sh
# =============================================================================

set -euo pipefail

ENV_FILE=/apps/pegasus/.env
NEON_URL=$(grep -E '^DATABASE_URL_NEON=' "$ENV_FILE" | cut -d= -f2-)
[[ -n "$NEON_URL" ]] || NEON_URL=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)

if [[ -z "$NEON_URL" ]]; then
  echo "ERRO: NEON_URL não achado em $ENV_FILE" >&2; exit 1
fi

OUT=/tmp/pegasus-ads-data-dump.sql

# Tabelas que NÃO entram no dump:
# - users e sessions: dados migram para auth.users na Fase 2
# - __drizzle_migrations: gerada pelo drizzle-kit no destino
EXCLUDE_ARGS=(
  --exclude-table-data=public.users
  --exclude-table-data=public.sessions
  --exclude-table-data=public.__drizzle_migrations
)

echo "[1/2] Dumpando dados do Neon via docker postgres:17-alpine..."
echo "      Origem : ${NEON_URL//:*@/:***@}"
echo "      Destino: $OUT (no host, via volume mount)"
echo "      Excluindo: users, sessions, __drizzle_migrations"
echo

# Rodar pg_dump em container com versão correta.
# --network host: acesso outbound ao Neon (via AWS)
# -v /tmp:/tmp: monta /tmp do host para receber o dump
# -i: interativo (para stdin passar erros se houver)
docker run --rm --network host -v /tmp:/tmp postgres:17-alpine \
  pg_dump "$NEON_URL" \
    --data-only \
    --column-inserts \
    --no-owner \
    --no-acl \
    --disable-triggers \
    "${EXCLUDE_ARGS[@]}" \
    -f "$OUT"

LINES=$(wc -l < "$OUT")
SIZE=$(du -h "$OUT" | cut -f1)
echo
echo "[2/2] Dump concluído"
echo "      Arquivo: $OUT"
echo "      Tamanho: $SIZE"
echo "      Linhas : $LINES"
echo

# Sanity quick: contar inserts por tabela
echo "INSERTs por tabela:"
grep -oE 'INSERT INTO public\."?[a-z_]+"?' "$OUT" \
  | sort | uniq -c | sort -rn | head -30
echo
echo "====================================================================="
echo " Próximo: rodar transformação de IDs (UUIDv5 para PKs literais)"
echo " Provavelmente afeta: plans (plan_free, plan_pro, plan_enterprise),"
echo " possivelmente funnels (T4, T7) e settings."
echo " Ver scripts/phase-1b/05-transform-and-restore.sh"
echo "====================================================================="
