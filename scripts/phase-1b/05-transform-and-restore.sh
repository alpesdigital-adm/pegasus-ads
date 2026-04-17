#!/usr/bin/env bash
# =============================================================================
# Pegasus Ads — Fase 1B / Step 05: Transformar IDs e restaurar
# =============================================================================
# RODAR ONDE: VPS Hostinger
# OBJETIVO:
#   1. Transformar IDs literais (plan_free, plan_pro, plan_enterprise) →
#      UUIDv5 determinístico
#   2. Transformar IDs integer das 6 tabelas Creative Intelligence
#      (offers, concepts, angles, launches, ad_creatives, classified_insights)
#      → UUID novo, mantendo coerência de FKs
#   3. Restaurar dump transformado no pegasus_ads
#
# REQUISITO: Python 3.x (vem por default em Ubuntu 24.04)
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

# ── Transformação via Python (mais robusto que sed para integer→UUID) ───
echo "[1/2] Transformando dump..."
python3 - "$DUMP" "$TRANSFORMED" <<'PYEOF'
import sys, re, uuid

src, dst = sys.argv[1], sys.argv[2]

# 1. Literal IDs → UUIDv5 (NAMESPACE_DNS) — para tabela `plans` seedada
literal_map = {}
for key in ("plan_free", "plan_pro", "plan_enterprise"):
    literal_map[key] = str(uuid.uuid5(uuid.NAMESPACE_DNS, key))

# 2. Tabelas com PK integer/serial — mapping integer→UUID, preserva FKs
# Todas as tabelas descobertas na Fase 1B (inspect report + CI handoff).
serial_pk_tables = (
    # Creative Intelligence (handoff c37e0ea)
    "offers", "concepts", "angles", "launches", "ad_creatives",
    "classified_insights",
    # Legacy + insights (inspect report 574a412)
    "ad_accounts", "ad_insights", "hourly_insights", "sync_logs",
    "accounts", "lead_sources", "leads",
    "classification_rules", "saved_views",
)
id_map = {}  # (table, old_id) -> new_uuid

def get_uuid(table, old_id):
    key = (table, str(old_id))
    if key not in id_map:
        # UUIDv5 estável (re-run gera mesmo UUID)
        id_map[key] = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{table}/{old_id}"))
    return id_map[key]

def first_pass_collect(text):
    """Pré-coleta todos os PKs antigos para garantir mapping antes de FKs"""
    # INSERT INTO public."ad_creatives" (id, ...) VALUES (1, ...)
    pat = re.compile(
        r'INSERT INTO public\.(?:")?(' + '|'.join(serial_pk_tables) + r')(?:")? \([^)]*\) VALUES \((\d+),'
    )
    for m in pat.finditer(text):
        get_uuid(m.group(1), m.group(2))

def transform_serial_inserts(text):
    """
    Reescreve INSERTs nas tabelas com PK serial:
    - PK integer → UUID
    - FK integer → UUID (lookup no mapping)
    """
    # (column, target_table) — (id, self) é implícito (sempre convertido)
    fk_columns = {
        # Creative Intelligence
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
        # Insights
        "ad_accounts":        [("id", "ad_accounts")],
        "ad_insights":        [("id", "ad_insights"),
                                ("account_id", "ad_accounts")],
        "hourly_insights":    [("id", "hourly_insights"),
                                ("account_id", "ad_accounts")],
        "sync_logs":          [("id", "sync_logs"),
                                ("account_id", "ad_accounts")],
        # Legacy lead capture
        "accounts":           [("id", "accounts")],
        "lead_sources":       [("id", "lead_sources"),
                                ("account_id", "accounts")],
        "leads":              [("id", "leads"),
                                ("account_id", "accounts"),
                                ("source_id", "lead_sources")],
        # Misc
        "classification_rules":[("id", "classification_rules")],
        "saved_views":         [("id", "saved_views")],
    }
    out_lines = []
    insert_pat = re.compile(
        r'^INSERT INTO public\.(?:")?(' + '|'.join(serial_pk_tables) + r')(?:")? \(([^)]+)\) VALUES \((.+)\);$'
    )
    for line in text.splitlines(keepends=True):
        m = insert_pat.match(line.rstrip())
        if not m:
            out_lines.append(line)
            continue
        table, cols_raw, vals_raw = m.group(1), m.group(2), m.group(3)
        cols = [c.strip().strip('"') for c in cols_raw.split(",")]
        # split values (respeitando aspas)
        vals = split_values(vals_raw)
        if len(cols) != len(vals):
            out_lines.append(line)  # malformado, deixa
            continue
        col_to_table = dict(fk_columns.get(table, []))
        new_vals = []
        for col, val in zip(cols, vals):
            if col in col_to_table and val.strip() != "NULL":
                target = col_to_table[col]
                clean = val.strip()
                # Pode vir como inteiro (1) ou como '1' (raro pra ints)
                clean = clean.strip("'")
                # Se já é UUID-format, passa direto (mantém o valor original)
                if re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', clean, re.I):
                    new_vals.append(f"'{clean}'")
                else:
                    new_vals.append(f"'{get_uuid(target, clean)}'")
            else:
                new_vals.append(val)
        out_lines.append(
            f'INSERT INTO public."{table}" ({cols_raw}) VALUES ({", ".join(new_vals)});\n'
        )
    return "".join(out_lines)

def split_values(s):
    """Split values em INSERT respeitando aspas e parens internos."""
    out, buf, in_str, depth = [], [], False, 0
    i = 0
    while i < len(s):
        c = s[i]
        if c == "'" and (i == 0 or s[i-1] != '\\'):
            # Toggle ou escape ''
            if in_str and i+1 < len(s) and s[i+1] == "'":
                buf.append("''"); i += 2; continue
            in_str = not in_str
            buf.append(c); i += 1; continue
        if not in_str:
            if c == '(':
                depth += 1
            elif c == ')':
                depth -= 1
            elif c == ',' and depth == 0:
                out.append("".join(buf)); buf = []; i += 1
                # skip space after comma
                while i < len(s) and s[i] == ' ': i += 1
                continue
        buf.append(c); i += 1
    if buf:
        out.append("".join(buf))
    return out

# ── Main ──
with open(src) as f:
    text = f.read()

# Pre-collect (mapping precisa estar pronto antes de qualquer FK lookup)
first_pass_collect(text)

# 1. Literal substitutions (plan_*)
for old, new in literal_map.items():
    count_before = text.count(f"'{old}'")
    text = text.replace(f"'{old}'", f"'{new}'")
    print(f"  literal: '{old}' → '{new}' ({count_before} occurrences)", file=sys.stderr)

# 2. Serial PK integer → UUID rewrite (15 tables)
text = transform_serial_inserts(text)
print(f"  Serial PK mapping size: {len(id_map)} (table, old_id) pairs", file=sys.stderr)
for tbl in serial_pk_tables:
    n = sum(1 for k in id_map if k[0] == tbl)
    print(f"    {tbl}: {n} rows", file=sys.stderr)

with open(dst, "w") as f:
    f.write(text)
print(f"  output: {dst}", file=sys.stderr)
PYEOF

echo
echo "[2/2] Restaurando no pegasus_ads (TRUNCATE CASCADE + restore)..."
read -p "Confirmar restore (apaga dados existentes em pegasus_ads)? [y/N] " -n 1 -r
echo
[[ "$REPLY" =~ ^[Yy]$ ]] || { echo "Cancelado."; exit 0; }

# TRUNCATE primeiro
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
echo " Restore concluído. Validar com scripts/phase-1b/07-validate.sh"
echo "====================================================================="
