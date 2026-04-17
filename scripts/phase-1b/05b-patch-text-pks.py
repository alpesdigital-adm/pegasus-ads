#!/usr/bin/env python3
"""
Patch complementar ao step 05 do Fase 1B: mapeia text-PK values não-UUID
(funnel-t4, plan_free já foram feitos, mas faltam vários) para UUIDv5
determinístico e substitui globalmente no dump já transformado.

Estratégia:
  1. Parse linha a linha os INSERTs do dump.
  2. Pra cada tabela na lista text_pk_tables, pega o valor do primeiro campo
     (id ou key ou token — conforme schema Neon) e, se não for UUID,
     registra old_id → UUIDv5(namespace, f"{table}:{old_id}").
  3. Gera um mapping global {old_string: new_uuid} e faz find/replace em
     todo o dump (dois passes: aspas simples e sem aspas pra casos raros).
"""

import re
import sys
import uuid

SRC = "/tmp/pegasus-ads-data-transformed.sql"
DST = "/tmp/pegasus-ads-data-final.sql"

NAMESPACE = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")  # NAMESPACE_DNS padrão

UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)

# Tabelas com text PK em Neon, que vira uuid no Drizzle.
# Nome da coluna PK vem primeiro no INSERT (Postgres respeita ordem declarada).
# Pra cada tabela, guardamos o nome da coluna PK (usado pra log/sanity).
TEXT_PK_TABLES = {
    "alerts": "id",
    "api_keys": "id",
    "campaigns": "id",
    "creative_edges": "id",
    "creative_ref_images": "id",
    "creatives": "id",
    "crm_import_mappings": "id",
    "funnels": "id",
    "hypotheses": "id",
    "images": "id",
    "lead_qualification_rules": "id",
    "metrics": "id",
    "metrics_breakdowns": "id",
    "metrics_demographics": "id",
    "pipeline_executions": "id",
    "plans": "id",
    "projects": "id",
    "prompts": "id",
    "published_ads": "id",
    "sessions": "token",
    "settings": "key",
    "test_round_variants": "id",
    "test_rounds": "id",
    "users": "id",
    "visual_elements": "id",
    "workspace_meta_accounts": "id",
    "workspaces": "id",
    "crm_leads": "id",
    # workspace_settings é composto (workspace_id, key) — key é text, workspace_id já é uuid
    "workspace_settings": "key",
}


def split_values(s: str):
    """Split de valores de VALUES (...), respeitando aspas simples e parens."""
    out, buf, in_str, depth = [], [], False, 0
    i = 0
    while i < len(s):
        c = s[i]
        if c == "'":
            # handle '' escape
            if in_str and i + 1 < len(s) and s[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            in_str = not in_str
            buf.append(c)
            i += 1
            continue
        if not in_str:
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
            elif c == "," and depth == 0:
                out.append("".join(buf).strip())
                buf = []
                i += 1
                while i < len(s) and s[i] == " ":
                    i += 1
                continue
        buf.append(c)
        i += 1
    if buf:
        out.append("".join(buf).strip())
    return out


def unquote(val: str) -> str | None:
    """Retorna string interna sem aspas, ou None se não for literal string."""
    if val == "NULL":
        return None
    if val.startswith("'") and val.endswith("'"):
        return val[1:-1].replace("''", "'")
    return None


def main():
    with open(SRC, "r", encoding="utf-8") as f:
        text = f.read()

    # Regex pra capturar INSERTs de tabelas na lista.
    tables_alt = "|".join(re.escape(t) for t in TEXT_PK_TABLES)
    insert_pat = re.compile(
        r'^INSERT INTO public\.(?:")?(' + tables_alt + r')(?:")?\s*\(([^)]+)\)\s*VALUES\s*\((.+)\);$',
        re.MULTILINE,
    )

    mapping: dict[str, str] = {}

    for m in insert_pat.finditer(text):
        table = m.group(1)
        cols_raw = m.group(2)
        vals_raw = m.group(3)
        cols = [c.strip().strip('"') for c in cols_raw.split(",")]
        vals = split_values(vals_raw)
        if len(cols) != len(vals):
            continue
        pk_col = TEXT_PK_TABLES[table]
        if pk_col not in cols:
            continue
        idx = cols.index(pk_col)
        pk_val = unquote(vals[idx])
        if pk_val is None:
            continue
        if UUID_RE.match(pk_val):
            continue  # já é UUID, não precisa mapear
        if pk_val in mapping:
            continue  # já mapeado (um valor pode aparecer em múltiplas tabelas — OK, mesmo UUID)
        new_uuid = str(uuid.uuid5(NAMESPACE, f"{table}:{pk_val}"))
        mapping[pk_val] = new_uuid

    print(f"[patch] {len(mapping)} text-PK values mapeados pra UUIDv5:", file=sys.stderr)
    for old, new in sorted(mapping.items()):
        print(f"  '{old}' -> '{new}'", file=sys.stderr)

    # Substituição global — pra cada old_id, troca literalmente 'old_id' por 'new_uuid'.
    # Ordenamos por tamanho decrescente pra evitar prefix collisions
    # (ex: 'test' vs 'test-foo').
    for old in sorted(mapping, key=len, reverse=True):
        text = text.replace(f"'{old}'", f"'{mapping[old]}'")

    with open(DST, "w", encoding="utf-8") as f:
        f.write(text)

    print(f"[patch] saída: {DST}", file=sys.stderr)


if __name__ == "__main__":
    main()
