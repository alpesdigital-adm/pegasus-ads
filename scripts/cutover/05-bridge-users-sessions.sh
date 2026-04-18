#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Cutover bridge: migrar users + sessions Neon → pegasus_ads
# =============================================================================
# RODAR ONDE: VPS Hostinger, /apps/pegasus
# CONTEXTO: Fase 1B excluiu users/sessions do dump (plano original era Fase 2
#           migrar para auth.users do gotrue). Mas o cutover de hoje
#           (2026-04-17) revelou que sem users em pegasus_ads, login quebra
#           imediatamente após swap.
#
# DECISÃO: migrar users+sessions como BRIDGE até Fase 2 ser implementada.
#          PKs já são UUID-format no Neon → cast direto para uuid no destino,
#          sem necessidade de UUIDv5 mapping. bcrypt hashes funcionam como-is.
#
# RISCO: BAIXO. Tabelas vazias em pegasus_ads, FK loose (workspace_members.user_id
#        sem .references explícito), workspace_id já existe (mesma string UUID).
# =============================================================================

set -euo pipefail
cd /apps/pegasus

ENV_FILE=/apps/pegasus/.env
NEON_URL=$(grep -E '^DATABASE_URL_NEON=' "$ENV_FILE" | cut -d= -f2-)
[[ -n "$NEON_URL" ]] || { echo "ERRO: DATABASE_URL_NEON não está em .env" >&2; exit 1; }

DUMP=/tmp/users-sessions-bridge-dump.sql
FINAL=/tmp/users-sessions-bridge-final.sql

log() { printf '\033[1;34m[%s]\033[0m %s\n' "$(date +%H:%M:%S)" "$*"; }
ok()  { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

# ── 0. Alinhar schema: Neon users tem 4 colunas que Drizzle omitiu ──────
# (account_id, role, is_active, last_login_at). Fase 2 vai substituir por
# auth.users, então ALTER direto é aceitável para a bridge.
log "[0/4] Adicionando colunas legacy em users (idempotente via IF NOT EXISTS)"
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_id integer,
  ADD COLUMN IF NOT EXISTS role varchar(20) NOT NULL DEFAULT 'viewer',
  ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz;
SQL
ok "users alinhado com schema do Neon"

# ── 1. Dump users + sessions do Neon ────────────────────────────────────
log "[1/4] Dumping users + sessions do Neon (postgres:17-alpine)"
docker run --rm --network host -v /tmp:/tmp postgres:17-alpine \
  pg_dump "$NEON_URL" \
    --data-only --column-inserts --no-owner --no-acl --disable-triggers \
    --table=public.users --table=public.sessions \
    -f "$DUMP"
ok "dump em $DUMP ($(wc -l < $DUMP) linhas)"

# ── 2. Strip Pg17 compat (mesmo set do step 05) ─────────────────────────
log "[2/4] Strip Pg17 incompat (transaction_timeout, restrict, DISABLE TRIGGER, setval)"
python3 - "$DUMP" "$FINAL" <<'PYEOF'
import sys, re
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f: text = f.read()
text = re.sub(r'^SET transaction_timeout.*$', '', text, flags=re.M)
text = re.sub(r'^\\(?:un)?restrict.*$', '', text, flags=re.M)
text = re.sub(r'^ALTER TABLE (?:ONLY )?[^ ]+ (?:DISABLE|ENABLE) TRIGGER ALL;$', '', text, flags=re.M)
text = re.sub(r"^SELECT pg_catalog\.setval.*$", '', text, flags=re.M)
text = re.sub(r"^SELECT setval.*$", '', text, flags=re.M)
with open(dst, 'w') as f: f.write(text)
PYEOF
ok "limpo em $FINAL"

# ── 3. Restore como supabase_admin (preserva DISABLE TRIGGER residual) ──
log "[3/4] Restore em pegasus_ads (users primeiro, depois sessions — pg_dump respeita ordem)"

# Pré-cleanup: se já tiver dados (re-run), TRUNCATE
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads <<'SQL'
TRUNCATE sessions CASCADE;
TRUNCATE users CASCADE;
SQL

docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads \
  -v ON_ERROR_STOP=1 < "$FINAL"
ok "restore completo"

# ── 4. GRANT (caso step 0 do Fase 0 não tenha aplicado nessas tabelas) ──
log "[4/4] GRANT em users + sessions para pegasus_ads_app"
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON users TO pegasus_ads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO pegasus_ads_app;
SQL

# ── Verificação final ───────────────────────────────────────────────────
echo
echo "====================================================================="
echo " Bridge users+sessions concluído. Counts finais:"
echo "====================================================================="
ADMIN_PASS=$(grep -E '^DATABASE_URL_ADMIN=' "$ENV_FILE" | cut -d= -f2- | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
docker exec -e PGPASSWORD="$ADMIN_PASS" alpes-ads_supabase-db-1 \
  psql -U pegasus_ads_admin -d pegasus_ads -h 127.0.0.1 -c \
  "SELECT 'users' AS tbl, count(*) FROM users
   UNION ALL
   SELECT 'sessions', count(*) FROM sessions
   UNION ALL
   SELECT 'sessions_active', count(*) FROM sessions WHERE expires_at > NOW()
   ORDER BY tbl"

echo
echo " Próximo: testar login no green:"
echo "   1. https://pegasus-green.alpesd.com.br/login (browser)"
echo "   2. Ou continuar no swap: pegasus.alpesd.com.br já está apontando para green."
echo
echo " Atenção: Fase 2 (Supabase Auth via gotrue) ainda é o destino final."
echo " Esse bridge é temporário — desfeito quando auth.users substituir users."
