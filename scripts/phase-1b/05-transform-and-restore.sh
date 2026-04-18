#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 05: Transformar IDs e restaurar
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO (tudo num só script, consolidado após execução real — fixes 5/6/7/8/9/10
#           do docs/migration/fase1b-complete-report.md):
#   1. Strip incompatibilidades Postgres 17 (origem) vs 15.8 (destino)
#   2. Strip schemas drizzle/neon_auth residuais e setval() de sequences
#      (tabelas agora usam gen_random_uuid, não mais serial)
#   3. Transform IDs literais (plan_free → UUIDv5) via Python
#   4. Transform integer PKs de 15 tabelas serial → UUID determinístico
#   5. Transform text PKs não-UUID (funnel-t4, settings.key, etc) → UUIDv5
#   6. Restaurar no pegasus_ads via `supabase_admin` (superuser — necessário
#      para `ALTER TABLE ... DISABLE TRIGGER ALL` do dump)
#   7. Re-GRANT para pegasus_ads_app em todas as tabelas recém-criadas
#
# REQUISITO: Python 3.x
# =============================================================================

set -euo pipefail

DUMP=/tmp/pegasus-ads-data-dump.sql
TRANSFORMED=/tmp/pegasus-ads-data-transformed.sql

if [[ ! -f "$DUMP" ]]; then
  echo "ERRO: $DUMP não existe. Rode 04-pg-dump-data.sh primeiro." >&2
  exit 1
fi

if ! command -v python3 >/dev/null; then
  echo "ERRO: python3 não disponível." >&2
  exit 1
fi

# ── Transformação via Python ────────────────────────────────────────────
echo "[1/3] Transformando dump (strip Pg17 + integer→UUID + text-PK UUIDv5)..."
python3 - "$DUMP" "$TRANSFORMED" <<'PYEOF'
import sys, re, uuid

src, dst = sys.argv[1], sys.argv[2]

# ── 1. Literal IDs → UUIDv5 (NAMESPACE_DNS) — para plans seedadas ────────
literal_map = {}
for key in ("plan_free", "plan_pro", "plan_enterprise"):
    literal_map[key] = str(uuid.uuid5(uuid.NAMESPACE_DNS, key))

# ── 2. Tabelas com PK integer/serial — mapping integer→UUID, preserva FKs ──
serial_pk_tables = (
    # Creative Intelligence
    "offers", "concepts", "angles", "launches", "ad_creatives",
    "classified_insights",
    # Legacy + insights
    "ad_accounts", "ad_insights", "hourly_insights", "sync_logs",
    "accounts", "lead_sources", "leads",
    "classification_rules", "saved_views",
)
id_map = {}  # (table, old_id) -> new_uuid

def get_uuid(table, old_id):
    key = (table, str(old_id))
    if key not in id_map:
        id_map[key] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{table}/{old_id}"))
    return id_map[key]

# FK mapping por tabela
fk_columns = {
    "offers":             [("id", "offers")],
    "concepts":           [("id", "concepts"),
                            ("offer_id", "offers")],
    "angles":             [("id", "angles"),
                            ("concept_id", "concepts")],
    "launches":           [("id", "launches")],
    "ad_creatives":       [("id", "ad_creatives"),
                            ("offer_id", "offers"),
                            ("launch_id", "launches"),
                            ("angle_id", "angles")],
    "classified_insights":[("id", "classified_insights"),
                            ("insight_id", "ad_insights"),
                            ("account_id", "ad_accounts")],
    "ad_accounts":        [("id", "ad_accounts")],
    "ad_insights":        [("id", "ad_insights"),
                            ("account_id", "ad_accounts")],
    "hourly_insights":    [("id", "hourly_insights"),
                            ("account_id", "ad_accounts")],
    "sync_logs":          [("id", "sync_logs"),
                            ("account_id", "ad_accounts")],
    "accounts":           [("id", "accounts")],
    "lead_sources":       [("id", "lead_sources"),
                            ("account_id", "accounts")],
    "leads":              [("id", "leads"),
                            ("account_id", "accounts"),
                            ("source_id", "lead_sources")],
    "classification_rules":[("id", "classification_rules")],
    "saved_views":         [("id", "saved_views")],
}

# ── 3. Tabelas com PK text não-UUID (vai virar UUIDv5)
# fix #6: funnels usa 'funnel-t4'/'funnel-t7' literais, settings usa chaves
# como 'google_drive_folder_id', 'test_log_*', etc. Plano v1.4 converte tudo.
text_pk_tables = {
    "alerts": "id", "api_keys": "id", "campaigns": "id",
    "creative_edges": "id", "creative_ref_images": "id", "creatives": "id",
    "crm_import_mappings": "id", "funnels": "id", "hypotheses": "id",
    "images": "id", "lead_qualification_rules": "id", "metrics": "id",
    "metrics_breakdowns": "id", "metrics_demographics": "id",
    "pipeline_executions": "id", "plans": "id", "projects": "id",
    "prompts": "id", "published_ads": "id", "sessions": "token",
    "settings": "key", "test_round_variants": "id", "test_rounds": "id",
    "users": "id", "visual_elements": "id", "workspace_meta_accounts": "id",
    "workspaces": "id", "crm_leads": "id",
    "workspace_settings": "key",
}
text_pk_map = {}  # old_text_value -> new_uuid
UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)

# ── Helpers ──────────────────────────────────────────────────────────────

def split_values(s):
    out, buf, in_str, depth, i = [], [], False, 0, 0
    while i < len(s):
        c = s[i]
        if c == "'":
            if in_str and i+1 < len(s) and s[i+1] == "'":
                buf.append("''"); i += 2; continue
            in_str = not in_str
            buf.append(c); i += 1; continue
        if not in_str:
            if c == '(':   depth += 1
            elif c == ')': depth -= 1
            elif c == ',' and depth == 0:
                out.append("".join(buf).strip()); buf = []
                i += 1
                while i < len(s) and s[i] == ' ': i += 1
                continue
        buf.append(c); i += 1
    if buf: out.append("".join(buf).strip())
    return out

def unquote(val):
    if val == "NULL": return None
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1].replace("''", "'")
    return None

# ── Fase A: strip Pg17 compat artifacts (fix #7/#8/#9) ───────────────────
def strip_compat(text):
    # SET transaction_timeout (Pg17+)
    text = re.sub(r'^SET transaction_timeout.*$', '', text, flags=re.M)
    # psql novo: \restrict / \unrestrict (segurança — irrelevante aqui)
    text = re.sub(r'^\\(?:un)?restrict.*$', '', text, flags=re.M)
    # ALTER TABLE ... DISABLE/ENABLE TRIGGER ALL — só funciona como superuser,
    # e não é necessário porque usamos `SET session_replication_role = replica`
    # ou rodamos como superuser. Deixo remover pra evitar erro.
    text = re.sub(
        r'^ALTER TABLE (?:ONLY )?[^ ]+ (?:DISABLE|ENABLE) TRIGGER ALL;$',
        '', text, flags=re.M,
    )
    # setval em sequences antigas — tabelas agora usam gen_random_uuid, sem seq
    text = re.sub(r"^SELECT pg_catalog\.setval.*$", '', text, flags=re.M)
    text = re.sub(r"^SELECT setval.*$", '', text, flags=re.M)
    # Blocos `-- Data for Name: ... Schema: drizzle` ou `Schema: neon_auth`
    # (fix #9: pg_dump --exclude-schema deveria cobrir mas por garantia)
    text = re.sub(
        r'^--\s*Data for Name: [^\n]*; Schema: (?:drizzle|neon_auth)[\s\S]*?(?=\n--\s*Data for Name:|\Z)',
        '', text, flags=re.M,
    )
    return text

# ── Fase B: coletar PKs antigos antes de qualquer FK lookup ─────────────
def collect_serial_pks(text):
    pat = re.compile(
        r'INSERT INTO public\.(?:")?(' + '|'.join(serial_pk_tables) + r')(?:")? \([^)]*\) VALUES \((\d+),'
    )
    for m in pat.finditer(text):
        get_uuid(m.group(1), m.group(2))

def collect_text_pks(text):
    # Scaneia INSERTs de tabelas com text PK e mapeia valores não-UUID.
    tables_alt = '|'.join(re.escape(t) for t in text_pk_tables)
    insert_pat = re.compile(
        r'^INSERT INTO public\.(?:")?(' + tables_alt + r')(?:")?\s*\(([^)]+)\)\s*VALUES\s*\((.+)\);$',
        re.M,
    )
    for m in insert_pat.finditer(text):
        table, cols_raw, vals_raw = m.group(1), m.group(2), m.group(3)
        cols = [c.strip().strip('"') for c in cols_raw.split(',')]
        vals = split_values(vals_raw)
        if len(cols) != len(vals): continue
        pk_col = text_pk_tables[table]
        if pk_col not in cols: continue
        pk_val = unquote(vals[cols.index(pk_col)])
        if pk_val is None: continue
        if UUID_RE.match(pk_val): continue
        if pk_val in text_pk_map: continue
        text_pk_map[pk_val] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{table}:{pk_val}"))

# ── Fase C: reescreve INSERTs de tabelas com PK serial (integer→UUID) ───
def transform_serial_inserts(text):
    out = []
    insert_pat = re.compile(
        r'^INSERT INTO public\.(?:")?(' + '|'.join(serial_pk_tables) + r')(?:")? \(([^)]+)\) VALUES \((.+)\);$'
    )
    for line in text.splitlines(keepends=True):
        m = insert_pat.match(line.rstrip())
        if not m:
            out.append(line); continue
        table, cols_raw, vals_raw = m.group(1), m.group(2), m.group(3)
        cols = [c.strip().strip('"') for c in cols_raw.split(',')]
        vals = split_values(vals_raw)
        if len(cols) != len(vals):
            out.append(line); continue
        col_to_table = dict(fk_columns.get(table, []))
        new_vals = []
        for col, val in zip(cols, vals):
            if col in col_to_table and val.strip() != "NULL":
                clean = val.strip().strip("'")
                if UUID_RE.match(clean):
                    new_vals.append(f"'{clean}'")
                else:
                    new_vals.append(f"'{get_uuid(col_to_table[col], clean)}'")
            else:
                new_vals.append(val)
        out.append(f'INSERT INTO public."{table}" ({cols_raw}) VALUES ({", ".join(new_vals)});\n')
    return "".join(out)

# ── Main ────────────────────────────────────────────────────────────────
with open(src) as f:
    text = f.read()

text = strip_compat(text)
print("  ✓ Pg17 compat stripped", file=sys.stderr)

collect_serial_pks(text)
collect_text_pks(text)
print(f"  ✓ mapping: {len(id_map)} serial-PK + {len(text_pk_map)} text-PK + {len(literal_map)} literal", file=sys.stderr)

# 1. Literal substitutions (plan_*)
for old, new in literal_map.items():
    n = text.count(f"'{old}'")
    text = text.replace(f"'{old}'", f"'{new}'")
    print(f"    literal '{old}' → '{new}' ({n} ocorrências)", file=sys.stderr)

# 2. Text-PK substitutions globais (funnel-t4, settings.key, etc)
# Ordem por tamanho decrescente evita colisão de prefixos.
for old in sorted(text_pk_map, key=len, reverse=True):
    text = text.replace(f"'{old}'", f"'{text_pk_map[old]}'")

# 3. Serial PK integer → UUID rewrite
text = transform_serial_inserts(text)
print(f"  ✓ serial rewrite: {sum(1 for k in id_map)} ids mapeados", file=sys.stderr)

with open(dst, 'w') as f:
    f.write(text)
print(f"  output: {dst}", file=sys.stderr)
PYEOF

# ── [2/3] Restaurar no pegasus_ads ───────────────────────────────────────
echo
echo "[2/3] Restaurando no pegasus_ads..."
echo "      Usando supabase_admin (fix #7 — superuser necessário para"
echo "      ALTER TABLE ... DISABLE TRIGGER do dump)"
echo
read -p "Confirmar restore (TRUNCATE CASCADE + reinsert)? [y/N] " -n 1 -r
echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

# TRUNCATE primeiro (idempotente)
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads <<'SQL'
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

docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads \
  -v ON_ERROR_STOP=1 < "$TRANSFORMED"

# ── [3/3] Re-GRANT para app role (fix #10) ──────────────────────────────
echo
echo "[3/3] Re-GRANT em todas as tabelas para pegasus_ads_app..."
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d pegasus_ads <<'SQL'
GRANT USAGE ON SCHEMA public TO pegasus_ads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pegasus_ads_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pegasus_ads_app;
SQL

echo
echo "====================================================================="
echo " Restore + GRANT concluídos. Validar com scripts/phase-1b/07-validate.sh"
echo "====================================================================="
