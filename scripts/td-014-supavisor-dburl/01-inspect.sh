#!/usr/bin/env bash
# =============================================================================
# TD-014 — DATABASE_URL demo no container Supavisor
# 01-inspect.sh — descobre estado atual, identifica user + blast radius
# =============================================================================
# ZERO MUDANÇA. Só reporta. Decisão de rotação depende do output.
#
# Objetivo do TD-014: Supavisor hoje usa credencial DEMO pra acessar seu
# metadata DB interno (_supabase database, onde ficam tenants/users).
# Rede privada limita exposição mas qualquer container na docker network
# ganha admin-level sobre o metadata.
# =============================================================================

set -uo pipefail

SUPAVISOR=alpes-ads_supabase-supavisor-1
DB_CONTAINER=alpes-ads_supabase-db-1

banner() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
ok()     { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn()   { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
info()   { printf '\033[0;36m[info]\033[0m %s\n' "$*"; }

banner "Container status"
docker ps --filter "name=$SUPAVISOR" --format "  {{.Status}}  {{.Names}}"

banner "DATABASE_URL do Supavisor (parseado — senha MASCARADA)"
# Extrai sem ecoar senha
eval "$(docker exec "$SUPAVISOR" sh -c '
  URL="$DATABASE_URL"
  # postgres://USER:PASS@HOST:PORT/DB?params
  echo "export DB_USER=\"$(echo $URL | sed -E "s|^postgres(ql)?://([^:]+):.*|\2|")\""
  echo "export DB_HOST=\"$(echo $URL | sed -E "s|.*@([^:/]+).*|\1|")\""
  echo "export DB_PORT=\"$(echo $URL | sed -E "s|.*@[^:]+:([0-9]+).*|\1|")\""
  echo "export DB_NAME=\"$(echo $URL | sed -E "s|.*/([^?]+).*|\1|")\""
  echo "export DB_PASS_LEN=\"$(echo $URL | sed -E "s|^postgres(ql)?://[^:]+:([^@]+)@.*|\2|" | wc -c)\""
')"

info "user:     $DB_USER"
info "host:port $DB_HOST:$DB_PORT"
info "database: $DB_NAME"
info "password length: $((DB_PASS_LEN - 1))"

# Flag se parecer demo/default
if docker exec "$SUPAVISOR" sh -c 'echo "$DATABASE_URL" | grep -qE "postgres:postgres|root:root|supabase:supabase|admin:admin"'; then
  warn "senha parece PADRÃO/DEMO (usuario:senha igual ao user)"
else
  info "senha não é o pattern óbvio user==pass (ainda pode ser valor demo)"
fi

banner "Quem mais usa essa credencial? (cross-app audit)"
info "Searching docker containers no mesmo cluster..."
docker network inspect alpes-ads_supabase_default --format '{{range .Containers}}{{.Name}}{{"\n"}}{{end}}' 2>/dev/null | sort -u | while read -r c; do
  [[ -z "$c" ]] && continue
  # Busca env vars que usem o mesmo DB_USER:PORT (pode não achar — env var name varia)
  has_url=$(docker exec "$c" sh -c 'env | grep -l "'"$DB_USER"'@'"$DB_HOST"':'"$DB_PORT"'" 2>/dev/null' 2>/dev/null || true)
  has_db=$(docker exec "$c" sh -c 'env | grep -E "^(DATABASE_URL|DB_URL|POSTGRES_URL|SUPABASE_DB_URL)=" 2>/dev/null' 2>/dev/null || true)
  if [[ -n "$has_db" ]]; then
    printf '  %-50s ' "$c"
    # Mostra só o user@host:port da URL (esconde senha)
    echo "$has_db" | sed -E 's|:([^:@]+)@|:***@|' | head -1 | cut -c1-120
  fi
done 2>/dev/null

banner "pg_stat_activity — conexões ativas com este user"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -c \
  "SELECT usename, application_name, client_addr, count(*) as conns
   FROM pg_stat_activity
   WHERE usename = '$DB_USER' OR application_name ILIKE '%supavisor%'
   GROUP BY usename, application_name, client_addr
   ORDER BY conns DESC;" 2>/dev/null || warn "Não consegui ler pg_stat_activity"

banner "Role metadata no Postgres"
docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -tAc \
  "SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolcanlogin
   FROM pg_roles WHERE rolname = '$DB_USER';" 2>/dev/null

if [[ "$DB_USER" == "postgres" || "$DB_USER" == "supabase_admin" ]]; then
  warn "user é SUPERUSER do cluster ($DB_USER)"
  warn "Rotação vai afetar TUDO que usa esse user — CRM, Studio, Realtime, Auth"
  warn "RECOMENDAÇÃO: criar user dedicado 'supavisor_meta' com acesso só ao database _supabase"
  warn "               em vez de rotacionar o postgres/supabase_admin"
fi

banner "Próximos passos"
cat <<EOF

Baseado no output acima:

CASO A — user dedicado (NÃO é postgres/supabase_admin):
  → Rotação isolada, zero impacto em outros apps
  → Rodar 02-rotate.sh

CASO B — user é postgres ou supabase_admin (superuser compartilhado):
  → NÃO ROTACIONAR senha direta — quebra CRM e outros
  → Melhor: criar user dedicado 'supavisor_meta' com permissões só no
    database _supabase, migrar Supavisor pra ele, e DEPOIS podemos
    rotacionar postgres em janela de manutenção coordenada
  → Ver 02-isolate-user.sh (a criar se necessário)

Pendências de coordenação se CASO B:
  - Listar todo container na network que usa postgres/supabase_admin
  - CRM, Studio, Realtime, Auth, Storage precisam ser checados
  - Rotação de superuser exige janela — não fazer sem avisar CRM

EOF
