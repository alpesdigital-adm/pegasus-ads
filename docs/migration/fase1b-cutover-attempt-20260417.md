# Tentativa de cutover — 2026-04-17 (ABORTADA)

**Gêmeo:** Claude na VPS (srv1512423)
**Origem:** instrução do gêmeo remoto após smoke test HTTP básico OK

## Resultado: swap NÃO executado

Blue (`pegasus-ads` → Neon) segue intocado em `pegasus.alpesd.com.br`.
Green (`pegasus-ads-green` → Supabase/pegasus_ads) segue em
`pegasus-green.alpesd.com.br` aguardando fix.

## Bugs encontrados

### Bug #1 — DATABASE_URL hostname sem sufixo Docker (CORRIGIDO)

`.env` tinha `@alpes-ads_supabase-db:5432` (short form). Hostname não
resolve do container green: `EAI_AGAIN` em todos os DB lookups, login
bloqueado.

CRM (`pegasus-crm`) já usava `@alpes-ads_supabase-db-1:...` (com sufixo).

**Fix aplicado:** `sed -i 's|@alpes-ads_supabase-db:|@alpes-ads_supabase-db-1:|g' .env`
para `DATABASE_URL` e `DATABASE_URL_ADMIN`. Container green recriado.
Login fake agora retorna `INVALID_CREDENTIALS` (DB conecta), zero
`EAI_AGAIN` em 30s de logs.

**Pendente:** atualizar `scripts/cutover/01-deploy-green.sh` e
HANDOFF-fase-1b.md para documentar o hostname correto. (Ou migrar para
Supavisor — TD-002 — que teria evitado isso.)

### Bug #2 — sync-all insere literais integer em colunas UUID (BLOQUEADOR)

`/api/cron/sync-all` roda HTTP 200 mas `upserted=0`:

```
column "insight_id" is of type uuid but expression is of type integer
```

Localização: `src/app/api/cron/sync-all/route.ts`

- linha 94: `VALUES (0, ?, ...)` — literal `0` em `insight_id`
- linha 106: `ACCOUNT_ID_NUM = 3601611403432716` bigint literal em
  `account_id`

Schema Fase 1B converteu ambas as colunas para UUID + FK. Código da
aplicação nunca foi atualizado — isso é o que a Fase 1C deveria fazer.

**Impacto:** se swappássemos agora, sync-all continuaria quebrado em
produção, nenhum insight novo entraria, drift (hoje ~506 rows) nunca
recupera. Regressão de produto.

**Fix pro próximo Claude (Fase 1C-style):**
- Opção A: `INSERT INTO ad_insights` primeiro, capturar o UUID gerado,
  usar como `insight_id` do `classified_insights`
- Opção B: relaxar FK (nullable + drop constraint) e usar `NULL`
- Opção C: gerar UUIDv5 determinístico a partir de `(date, ad_id)` e
  inserir nas duas tabelas com o mesmo UUID

`account_id` similar: mapear `act_3601611403432716` → UUID de
`ad_accounts.id` via lookup.

## Counts de drift (pegasus_ads vs Neon, 23:34 UTC)

| tabela | Neon | pegasus_ads | drift |
|---|---:|---:|---:|
| workspaces | 8 | 8 | 0 |
| workspace_members | 8 | 8 | 0 |
| campaigns | 3 | 3 | 0 |
| creatives | 31 | 31 | 0 |
| ad_creatives | 81 | 81 | 0 |
| ad_insights | 2758 | 2756 | -2 |
| classified_insights | 2758 | 2756 | -2 |
| hourly_insights | 25793 | 25477 | -316 |
| sync_logs | 4590 | 4558 | -32 |
| alerts | 875 | 867 | -8 |
| crm_leads | 5152 | 5006 | -146 |

Esperado: drift vai continuar crescendo enquanto blue for primário.

## Estado runtime

- `.env.blue.backup` preservado apontando para Neon (pré-condição do
  swap step 02, caso seja executado depois)
- `.env.backup.1776453687` é o snapshot pré-cutover (blue→Neon)
- `.env.backup.cutover-1776461722` é snapshot do .env logo antes da
  minha correção (contém ainda o hostname errado; não usar)
- Brain memória #172 registrada (project=pegasus-ads, thread=migration,
  kind=incident)
