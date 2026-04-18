#!/usr/bin/env bash
# =============================================================================
# TD-006 — Rotação do JWT secret do cluster alpes-ads_supabase
# =============================================================================
# Executa as etapas 1-8 do plano em docs/migration/td-006-gotrue-rotation-plan.md
#
# Requisitos: rodar no VPS como root. Depende de:
#   - node (>= 14) pra assinar JWTs
#   - jq, openssl, docker, docker compose, python3
#
# Flags:
#   --dry-run     só imprime o que seria feito
#   --skip-grep   pula pre-flight check de hardcoded secret
#
# Saída:
#   - Credenciais novas no stdout ao final (guardar — NÃO ficam em log)
#   - Backup da .env em $ENV_FILE.backup-td006-<timestamp>
# =============================================================================

set -euo pipefail

DRY_RUN=0
SKIP_GREP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-grep) SKIP_GREP=1 ;;
    *) echo "arg desconhecido: $arg" >&2; exit 1 ;;
  esac
done

COMPOSE_DIR="/etc/easypanel/projects/alpes-ads/supabase/code/supabase/code"
ENV_FILE="$COMPOSE_DIR/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN_SCRIPT="$SCRIPT_DIR/generate-supabase-jwts.js"
BACKUP="$ENV_FILE.backup-td006-$(date +%Y%m%d-%H%M%S)"

# Containers a recriar. Kong fica separado (stop antes, start depois).
JWT_CONSUMERS=(auth rest storage realtime functions supavisor)

log() { echo "[$(date +%H:%M:%S)] $*"; }
run() {
  if [[ $DRY_RUN -eq 1 ]]; then echo "DRY: $*"; else eval "$@"; fi
}

echo "═══════════════════════════════════════════════════"
echo "  TD-006 — Rotação do JWT secret (cluster alpes-ads)"
echo "  Dry-run: $([[ $DRY_RUN -eq 1 ]] && echo SIM || echo NÃO)"
echo "═══════════════════════════════════════════════════"
echo

# --- 1/8 pre-flight ---------------------------------------------------------
log "1/8 Pré-flight"
for bin in node jq openssl docker python3; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "  ✗ dependência ausente: $bin" >&2
    exit 1
  fi
done
[[ -f "$ENV_FILE" ]] || { echo "  ✗ $ENV_FILE não existe" >&2; exit 1; }
[[ -f "$GEN_SCRIPT" ]] || { echo "  ✗ $GEN_SCRIPT não existe" >&2; exit 1; }
( cd "$COMPOSE_DIR" && docker compose version >/dev/null 2>&1 ) || {
  echo "  ✗ docker compose não funciona em $COMPOSE_DIR" >&2; exit 1; }
log "  ✓ Dependências OK, .env encontrado"

if [[ $SKIP_GREP -eq 0 ]]; then
  HITS=$(grep -rlI 'your-super-secret-jwt-token' /apps/ /etc/easypanel/ 2>/dev/null \
    | grep -Ev '(\.env(\.example)?|\.backup-td006|docs/(tech-debt|migration))' || true)
  if [[ -n "$HITS" ]]; then
    echo "  ✗ Demo secret encontrado em arquivos não-ignoráveis:" >&2
    echo "$HITS" >&2
    echo "  → Resolver antes de rotacionar, ou rodar com --skip-grep." >&2
    exit 1
  fi
  log "  ✓ Sem hardcode residual em /apps ou /etc/easypanel"
fi

# --- 2/8 gerar novos secrets -----------------------------------------------
log "2/8 Gerando JWT_SECRET + anon + service_role"
NEW_JWT_SECRET=$(openssl rand -hex 32)
if [[ $DRY_RUN -eq 1 ]]; then
  NEW_ANON_KEY="DRY_RUN_ANON"
  NEW_SERVICE_ROLE_KEY="DRY_RUN_SVC"
else
  GEN_OUT=$(NEW_JWT_SECRET="$NEW_JWT_SECRET" node "$GEN_SCRIPT")
  NEW_ANON_KEY=$(echo "$GEN_OUT" | jq -r .anon)
  NEW_SERVICE_ROLE_KEY=$(echo "$GEN_OUT" | jq -r .service_role)
  [[ -n "$NEW_ANON_KEY" && -n "$NEW_SERVICE_ROLE_KEY" ]] || {
    echo "  ✗ Geração de JWT falhou" >&2; exit 1; }
fi
log "  ✓ Secrets gerados (JWT_SECRET len=${#NEW_JWT_SECRET}, anon len=${#NEW_ANON_KEY}, svc len=${#NEW_SERVICE_ROLE_KEY})"

# --- 3/8 backup .env --------------------------------------------------------
log "3/8 Backup .env"
run "cp '$ENV_FILE' '$BACKUP'"
log "  ✓ $BACKUP"

# --- 4/8 update .env --------------------------------------------------------
log "4/8 Atualizando .env com os novos valores"
if [[ $DRY_RUN -eq 0 ]]; then
  python3 - <<PYEOF
import re
path = "$ENV_FILE"
with open(path) as f: env = f.read()
def sub(k, v):
    global env
    if not re.search(rf'(?m)^{re.escape(k)}=', env):
        raise SystemExit(f"chave {k} ausente no .env")
    env = re.sub(rf'(?m)^{re.escape(k)}=.*$', f'{k}={v}', env)
sub('JWT_SECRET', '$NEW_JWT_SECRET')
sub('ANON_KEY', '$NEW_ANON_KEY')
sub('SERVICE_ROLE_KEY', '$NEW_SERVICE_ROLE_KEY')
with open(path, 'w') as f: f.write(env)
PYEOF
fi
log "  ✓ JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY atualizados no .env"

# --- 5/8 parar kong ---------------------------------------------------------
log "5/8 Parando kong (evita tráfego enquanto troca)"
run "docker stop alpes-ads_supabase-kong-1 >/dev/null"
log "  ✓ kong parado"

# --- 6/8 recriar consumers JWT ---------------------------------------------
log "6/8 Recriando containers JWT consumers: ${JWT_CONSUMERS[*]}"
# docker compose relê .env a cada 'up -d'; --force-recreate garante novo env
if [[ $DRY_RUN -eq 0 ]]; then
  (cd "$COMPOSE_DIR" && docker compose up -d --force-recreate --no-deps "${JWT_CONSUMERS[@]}" 2>&1 | tail -20)
fi
log "  ✓ consumers recriados com secret novo"

# --- 7/8 recriar kong ------------------------------------------------------
log "7/8 Recriando kong com ANON_KEY/SERVICE_KEY novas"
if [[ $DRY_RUN -eq 0 ]]; then
  (cd "$COMPOSE_DIR" && docker compose up -d --force-recreate --no-deps kong 2>&1 | tail -5)
fi
log "  ✓ kong up"

# --- 8/8 validar ------------------------------------------------------------
log "8/8 Validando"
if [[ $DRY_RUN -eq 0 ]]; then
  sleep 8  # dar tempo pro kong subir
  HTTP=$(curl -sS -o /dev/null -w '%{http_code}' \
    "https://supabase.alpesd.com.br/auth/v1/settings" \
    -H "apikey: $NEW_ANON_KEY" --max-time 15 || echo "000")
  if [[ "$HTTP" != "200" ]]; then
    echo "  ✗ Auth endpoint retornou $HTTP" >&2
    echo
    echo "ROLLBACK:" >&2
    echo "  cp '$BACKUP' '$ENV_FILE' && \\" >&2
    echo "  (cd '$COMPOSE_DIR' && docker compose up -d --force-recreate ${JWT_CONSUMERS[*]} kong)" >&2
    exit 1
  fi
  log "  ✓ Auth endpoint OK (HTTP 200)"

  # Cleanup de refresh tokens órfãos (todos invalidados pela rotação)
  log "  Limpando auth.refresh_tokens (sessões invalidadas)"
  docker exec alpes-ads_supabase-db-1 \
    psql -U supabase_admin -d postgres -c 'DELETE FROM auth.refresh_tokens;' >/dev/null 2>&1 || true
fi

echo
echo "═══════════════════════════════════════════════════"
echo "  ✅ Rotação concluída"
echo "═══════════════════════════════════════════════════"
echo
echo "Credenciais novas — GUARDAR em gerenciador de senhas:"
echo
echo "  JWT_SECRET: $NEW_JWT_SECRET"
echo
echo "  ANON_KEY: $NEW_ANON_KEY"
echo
echo "  SERVICE_ROLE_KEY: $NEW_SERVICE_ROLE_KEY"
echo
echo "Backup: $BACKUP"
echo
echo "Próximos passos (manuais ou via update-crm-env.sh):"
echo "  1. Atualizar /apps/pegasus-crm/.env:"
echo "       NEXT_PUBLIC_SUPABASE_ANON_KEY=<novo anon>"
echo "       SUPABASE_SERVICE_ROLE_KEY=<novo service>"
echo "  2. cd /apps/pegasus-crm && bash scripts/deploy.sh"
echo "     (rebuild necessário: NEXT_PUBLIC_* estão bakeados no bundle)"
echo "  3. Validar login em https://crm.alpesd.com.br"
echo "═══════════════════════════════════════════════════"
