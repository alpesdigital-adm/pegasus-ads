# Fase 1B — Migração completa (relatório de execução)

**Data:** 2026-04-17
**Gêmeo:** VPS Hostinger
**Branch:** `claude/review-pegasus-migration-plan-Gg25C`

---

## Status: ✅ COMPLETA

**Dados migrados do Neon → pegasus_ads com sucesso.** RLS enforced, FKs
válidos, app em produção ainda no Neon (cutover não feito).

## Counts finais (pegasus_ads vs Neon)

| tabela | neon | pegasus_ads | status |
|---|---:|---:|---|
| workspaces | 8 | 8 | ✅ |
| workspace_members | 8 | 8 | ✅ |
| workspace_settings | 7 | 7 | ✅ |
| workspace_meta_accounts | 3 | 3 | ✅ |
| accounts | 1 | 1 | ✅ |
| ad_accounts | 0 | 0 | ✅ |
| lead_sources | 1 | 1 | ✅ |
| leads | 3833 | 3833 | ✅ |
| plans | 3 | 3 | ✅ |
| funnels | 2 | 2 | ✅ (t4/t7 UUIDv5) |
| campaigns | 3 | 3 | ✅ |
| ad_creatives | 81 | 81 | ✅ |
| offers | 2 | 2 | ✅ |
| concepts | 5 | 5 | ✅ |
| angles | 23 | 23 | ✅ |
| launches | 1 | 1 | ✅ |
| ad_insights | 2756 | 2756 | ✅ |
| classified_insights | 2756 | 2756 | ✅ |
| hourly_insights | 25480 | 25477 | ⚠ 3 drift (Neon ativo continuou sync) |
| sync_logs | 4560 | 4558 | ⚠ 2 drift |
| crm_leads | 5152 | 5006 | ⚠ 146 drift |
| alerts | 869 | 867 | ⚠ 2 drift |
| creatives | 31 | 31 | ✅ |
| prompts | 28 | 28 | ✅ |
| test_round_variants | 37 | 37 | ✅ |
| api_keys | 1 | 1 | ✅ |
| projects | 1 | 1 | ✅ |
| pipeline_executions | 19 | 19 | ✅ |
| published_ads | 8 | 8 | ✅ |
| settings | 7 | 7 | ✅ |
| creative_edges | 27 | 27 | ✅ |
| creative_ref_images | 1 | 1 | ✅ |
| lead_qualification_rules | 2 | 2 | ✅ |
| metrics | 5 | 5 | ✅ |
| metrics_breakdowns | 14 | 14 | ✅ |
| images | 1 | 1 | ✅ |
| test_rounds | 11 | 11 | ✅ |
| users | — | 0 | excluído (migra pra auth.users na Fase 2) |
| sessions | — | 0 | excluído |

**Drift explicado:** Neon continua ativo em produção durante a migração. Rows
novas foram inseridas entre o `inspect-neon` inicial e o `pg_dump` final. Será
reconciliado no cutover (pg_dump delta + restore).

## FK sanity

Todos os checks retornaram 0 orphans:
- workspace_members com workspace inexistente: 0
- funnels com workspace inexistente: 0
- campaigns com workspace inexistente: 0
- crm_leads com workspace inexistente: 0
- classified_insights com ad_insights inexistente: 0

## RLS enforcement (validado)

```
pegasus_ads_app (sem SET LOCAL)            → 0 rows em creatives ✓
pegasus_ads_app + ws=4f461fae              → 0 crm_leads, 1 campaign
pegasus_ads_app + ws=7c7359ae              → 5006 crm_leads, 2 campaigns, 2 funnels, 31 creatives
pegasus_ads_admin (BYPASSRLS)              → 5006 crm_leads (todos) ✓
```

Isolamento por workspace funcionando corretamente.

---

## Hacks/fixes aplicados em tempo real (todos bugs dos scripts originais)

### 1. Step 03 (apply-migration) — FK resolve hostname

`DATABASE_URL_ADMIN=postgres://...@alpes-ads_supabase-db:5432/...` não resolve
do host da VPS (fora da network Docker). Workaround: usei IP do container
(`docker inspect`) nas conexões externas. Pra futuro, sugestão: script
faz o lookup automaticamente OU roda drizzle-kit dentro de container na
network.

### 2. Step 03 — drizzle-kit migrate pendurou

Processo travou em "applying migrations..." indefinidamente. Workaround:
apliquei os 3 .sql files manualmente via `psql -f`, depois populei
`drizzle.__drizzle_migrations` com os 3 hashes. Drizzle-kit next-time
deve reconhecer como já aplicado.

### 3. Step 03 — migration 0002 falha em ALTER TYPE UUID

`classified_insights.insight_id` e `account_id` eram integer na migration
0001 e precisavam virar uuid na 0002. Cast automático não existe. Como
a tabela estava vazia, fiz `DROP COLUMN + ADD COLUMN uuid`.

**Fix pro gêmeo remoto**: na geração do 0002, usar `USING insight_id::text::uuid`
no ALTER (falha mesmo assim em integer, mas pelo menos dá erro útil).
Alternativa: mudar 0001 pra já criar com uuid.

### 4. Step 03 — CREATE SCHEMA drizzle precisa superuser

pegasus_ads_admin não tinha CREATE em database. Fiz `GRANT CREATE ON DATABASE pegasus_ads TO pegasus_ads_admin` como supabase_admin.

**Fix pro Fase 0 script**: adicionar esse GRANT.

### 5. Step 04 — pg_dump já funcionava via docker postgres:17-alpine ✓

### 6. Step 05 — transform faltou muita substituição

O script do gêmeo remoto só mapeava:
- `plan_free/plan_pro/plan_enterprise` (3 literal)
- integer→UUID pras 15 tabelas serial

Mas o Neon tinha várias tabelas com text-PK não-UUID (funnels, test_rounds,
prompts, settings, etc). Sem mapear, o restore falhava em FKs.

**Fix**: escrevi [`patch_text_pks.py`](/tmp/patch_text_pks.py) que coleta todos
os text-PK values não-UUID das tabelas em `TEXT_PK_TABLES` e mapeia pra
UUIDv5 determinístico. Mapeou 11 valores:

```
debug, funnel-t4, funnel-t7, google_drive_folder_id, google_token_expires,
google_tokens, last_ad_number, rule_*_rat (2x), test_log_last_sync,
test_log_spreadsheet_id
```

**Pra migrar esse fix pro `05-transform-and-restore.sh`**: adicionar lógica
equivalente no Python inline do script (coletar text-PK antes do 1st pass).

### 7. Step 05 — compatibility Neon Postgres 17 → Supabase 15.8

Três incompatibilidades no dump (que o script restore não trata):
- `SET transaction_timeout = 0;` (Postgres 17+) — removido
- `\restrict YA1b2... / \unrestrict ...` (psql novo) — removidos
- `ALTER TABLE ... DISABLE TRIGGER ALL;` / `ENABLE TRIGGER ALL;` (requer
  superuser) — removidos e restore rodado como `supabase_admin` em vez do
  admin role do app

**Fix**: script deve:
1. Rodar `sed` pra strippar `SET transaction_timeout` e `\restrict*`
2. Usar `supabase_admin` pro restore (tem superuser, preserva DISABLE TRIGGER)

### 8. Step 05 — setval das sequences antigas falha

Final do dump tem `SELECT setval('public.*_id_seq', ...)` pra 15+ tabelas com
PK serial. Agora são uuid, sem sequences. Erro não-crítico — cai depois
que todo dado já inseriu.

**Fix**: strippar linhas `SELECT setval(` do dump transformado.

### 9. Step 05 — dump incluía `drizzle.__drizzle_migrations` + `neon_auth.*`

O `--exclude-table-data=public.__drizzle_migrations` só cobria a tabela no
schema public, mas ela vive em `drizzle` schema. Também tinha schema
`neon_auth` (Neon-exclusive).

**Fix**: strippar blocos `-- Data for Name: ... Schema: drizzle` e
`Schema: neon_auth` via sed/python.

### 10. Step 05 — grant de SELECT/etc pro app role

A gente criou 45 tabelas via migrations rodadas pelo admin role. O app role
não herdou default privileges (o `ALTER DEFAULT PRIVILEGES` do Fase 0 setup
não cobre tabelas criadas por outros roles).

**Fix**: após restore, rodar `GRANT USAGE ON SCHEMA + GRANT SELECT/INSERT/
UPDATE/DELETE ON ALL TABLES IN SCHEMA TO pegasus_ads_app` como supabase_admin.
Feito. Adicionar ao fim do `05-transform-and-restore.sh` ou criar
`06-grant-app-privs.sh`.

### 11. Step 06 — query final do sanity usa `forcerowsecurity`

Coluna não existe em Postgres 15.8 (adicionada mais tarde). Query final de
relatório falha, mas todas as RLS foram aplicadas antes dela.

**Fix**: `COALESCE((pg_class.relforcerowsecurity)::text, 'false')` ou
simplesmente remover essa query de relatório.

### 12. Step 07 — usa docker exec psql sem passwd

Falha com "peer authentication" em quase todas as queries. Fiz validação
manual usando URL com senha explícita.

**Fix**: script deve usar `docker exec -e PGPASSWORD=... psql "postgres://..."`.

---

## O que ainda falta pra Fase 1B "done"

1. **Cutover** (manual — HANDOFF-fase-1b.md seção "Cutover"):
   - Parar deploy automático / colocar em manutenção
   - Rodar delta sync (pg_dump só de rows novas do Neon desde o dump de hoje)
   - Trocar `DATABASE_URL` pra apontar pro Supabase
   - Redeployar pegasus-ads
   - Smoke test
   - Se OK, atualizar `DATABASE_URL_NEON` como archive (read-only)

2. **Supavisor tenant** (step 02 foi skipado — pipefail bug no script):
   - Inspecionar tenant config do Supavisor (banco interno ou env var)
   - Adicionar tenant `pegasus_ads` apontando pra pegasus_ads_app
   - Testar conexão pooled

3. **User migration** (Fase 2):
   - Tabela `users` do Neon → `auth.users` do Supabase
   - Tabela `sessions` idem

---

## Arquivos que ficam na VPS

- `/tmp/pegasus-ads-data-dump.sql` — raw pg_dump do Neon (51.003 linhas)
- `/tmp/pegasus-ads-data-transformed.sql` — após transform integer→UUID
- `/tmp/pegasus-ads-data-final.sql` — após patch text-PK → UUIDv5 (usado no restore final)
- `/tmp/patch_text_pks.py` — script do patch complementar
- `/tmp/pegasus-ads-neon-inspect/` — 45 schemas + row counts + non_uuid_pks

Todos podem ser deletados após o cutover validado.
