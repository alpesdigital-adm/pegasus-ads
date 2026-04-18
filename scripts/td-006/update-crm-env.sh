#!/usr/bin/env bash
# =============================================================================
# TD-006 — Atualiza /apps/pegasus-crm/.env com as novas ANON_KEY/SERVICE_KEY
# e redeploya o CRM. Rodar DEPOIS de rotate-jwt.sh, no VPS como root.
#
# Uso:
#   NEW_ANON_KEY=... NEW_SERVICE_ROLE_KEY=... bash update-crm-env.sh
# =============================================================================

set -euo pipefail

CRM_DIR="/apps/pegasus-crm"
ENV_FILE="$CRM_DIR/.env"
BACKUP="$ENV_FILE.backup-td006-$(date +%Y%m%d-%H%M%S)"

[[ -n "${NEW_ANON_KEY:-}" ]] || { echo "NEW_ANON_KEY obrigatório" >&2; exit 1; }
[[ -n "${NEW_SERVICE_ROLE_KEY:-}" ]] || { echo "NEW_SERVICE_ROLE_KEY obrigatório" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || { echo "$ENV_FILE não encontrado" >&2; exit 1; }

echo "→ Backup $ENV_FILE → $BACKUP"
cp "$ENV_FILE" "$BACKUP"

echo "→ Atualizando .env"
python3 - <<PYEOF
import re
path = "$ENV_FILE"
with open(path) as f: env = f.read()
def sub(k, v):
    global env
    if not re.search(rf'(?m)^{re.escape(k)}=', env):
        print(f"AVISO: {k} não existe no .env, adicionando")
        env = env.rstrip() + f'\n{k}={v}\n'
    else:
        env = re.sub(rf'(?m)^{re.escape(k)}=.*$', f'{k}={v}', env)
sub('NEXT_PUBLIC_SUPABASE_ANON_KEY', '$NEW_ANON_KEY')
sub('SUPABASE_SERVICE_ROLE_KEY', '$NEW_SERVICE_ROLE_KEY')
with open(path, 'w') as f: f.write(env)
PYEOF
echo "  ✓ atualizado"

echo "→ Deploy (rebuild + recreate container)"
cd "$CRM_DIR" && bash scripts/deploy.sh

echo
echo "✅ CRM redeployado. Validar login em https://crm.alpesd.com.br"
echo "   Backup: $BACKUP"
