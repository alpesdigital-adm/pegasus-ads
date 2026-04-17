# HANDOFF — Fase 1B (Pegasus Ads migration)

**Para:** Claude Code rodando dentro da VPS (srv1512423.hstgr.cloud)
**De:** Claude Code remoto (sandbox sem acesso outbound TCP, exceto Brain API)
**Branch:** `claude/review-pegasus-migration-plan-Gg25C`
**Data:** 2026-04-17
**Pré-requisito:** Fase 0 + Fase 1A já concluídas (PR #1)

---

## O que é a Fase 1B

Migração de DADOS (Neon → pegasus_ads) + RLS + tenant Supavisor. Ainda **não**
toca nas 84 rotas API (isso é Fase 1C+, vem em PRs pequenos depois).

Ao final desta fase, o pegasus_ads tem:
- Schema Drizzle aplicado (todas tabelas com PK UUID)
- Dados restaurados do Neon (com IDs literais convertidos via UUIDv5 determinístico)
- RLS enforced em todas as tabelas multi-tenant
- Tenant `pegasus_ads` configurado no Supavisor

A aplicação em produção CONTINUA no Neon (DATABASE_URL aponta para Neon).
O cutover acontece no fim da Fase 1B, depois da validação completa.

---

## Por que existe este handoff (e por que sub-fases)

Fase 1 do plano é gigante (3-5 dias originalmente). Subdividi em:
- **1A — Foundation** (já está no PR #1): schemas Drizzle + dual client +
  legacy adapter. Sem efeito runtime.
- **1B — Data migration** (ESTA fase): infra de DB + dados + RLS. Cutover de
  DATABASE_URL no final.
- **1C+ — Route migration**: gradual, route por route, raw SQL → Drizzle +
  `withWorkspace()`. PRs pequenos, paralelizáveis.

O Claude remoto não tem acesso a Docker/psql/SSH, então preparei tudo turnkey.

---

## Sequência (rodar nesta ordem)

Cada script é idempotente (safe pra re-rodar) ou tem confirmação interativa
antes de aplicar mudança destrutiva.

### Pré-checklist
- [ ] Você está num shell SSH na VPS (`ssh root@187.77.245.144`)
- [ ] `cd /apps/pegasus`
- [ ] `git fetch origin && git checkout claude/review-pegasus-migration-plan-Gg25C && git pull`
- [ ] `.env` tem `DATABASE_URL_NEON` (Neon antigo) + `DATABASE_URL_ADMIN`
      (pegasus_ads_admin) — Fase 0 deixou tudo configurado
- [ ] Você tem `DB_APP_PASSWORD` e `DB_ADMIN_PASSWORD` à mão (do auto-memory
      ou Brain memória #171). NÃO commitar essas senhas em lugar nenhum.

### Step 01 — Inspecionar Neon (BLOQUEADOR pra steps 03+)

```bash
bash scripts/phase-1b/01-inspect-neon.sh
```

Output em `/tmp/pegasus-ads-neon-inspect/`. Inclui:
- Schema (`\d`) de cada tabela
- Row counts (baseline para validar restore)
- PKs não-UUID (precisam UUIDv5 conversion)
- `pg_dump --schema-only` completo
- **CRÍTICO**: schemas das 6 tabelas Creative Intelligence (TD-008):
  `offers`, `concepts`, `angles`, `launches`, `ad_creatives`, `classified_insights`

**Depois de rodar, faça:**
```bash
tar czf /tmp/pegasus-ads-neon-inspect.tar.gz -C /tmp/pegasus-ads-neon-inspect .
# Cole o conteúdo do schema_offers.txt, schema_concepts.txt, etc. na próxima
# sessão Claude (ou compartilhe o tarball). O Claude usa para:
#   - Adicionar schemas Drizzle das 6 tabelas em src/lib/db/schema/creative-intelligence.ts
#   - Regenerar migration drizzle/0001_*.sql
```

⚠️ **PARE AQUI.** Não rode steps 03+ até o Claude regenerar a migration com
as 6 tabelas faltantes incluídas. Rodar antes vai aplicar migration
incompleta e o restore (step 05) vai falhar nas 6 tabelas.

### Step 02 — Configurar tenant Supavisor (paralelo, pode rodar quando quiser)

```bash
DB_APP_PASSWORD='senha_do_brain' bash scripts/phase-1b/02-supavisor-add-tenant.sh
```

Detecta como o Supavisor está configurado no stack `alpes-ads_supabase`,
mostra tenants existentes, e gera o INSERT SQL pra adicionar `pegasus_ads`.
**NÃO executa o INSERT automaticamente** — confirma colunas da tabela
`tenants` primeiro (varia entre versões do Supavisor). Após confirmar,
executa o INSERT manualmente e reinicia o container Supavisor.

Output esperado: connection string final pra `DATABASE_URL` via Supavisor
em transaction mode (porta 6543).

### Step 03 — Aplicar Drizzle migration

```bash
bash scripts/phase-1b/03-apply-migration.sh
```

Aplica `drizzle/0000_0000_phase_1a_foundation.sql` no `pegasus_ads`. Cria
todas as 28 tabelas vazias com PKs UUID.

**Pré-requisito:** se Step 01 revelou tabelas Creative Intelligence, o Claude
já regerou a migration (provavelmente `drizzle/0001_creative_intel.sql`) —
o `drizzle-kit migrate` aplica todas as pendentes automaticamente.

### Step 04 — pg_dump dos dados do Neon

```bash
bash scripts/phase-1b/04-pg-dump-data.sh
```

Dump data-only com `--column-inserts` (formato INSERT INTO) para permitir
transformação textual antes do restore. Exclui: `users`, `sessions`,
`__drizzle_migrations`. Output em `/tmp/pegasus-ads-data-dump.sql`.

### Step 05 — Transformar IDs literais e restaurar

```bash
bash scripts/phase-1b/05-transform-and-restore.sh
```

Aplica UUIDv5 (NAMESPACE_DNS) em IDs não-UUID conhecidos
(`plan_free`, `plan_pro`, `plan_enterprise`). Se Step 01 detectou OUTROS IDs
literais (em `non_uuid_pks.tsv`), **adicionar ao ID_MAP do script** antes de
rodar.

Faz `TRUNCATE CASCADE` no `pegasus_ads` antes do restore (idempotente).

### Step 06 — Habilitar RLS + policies

```bash
docker exec -i alpes-ads_supabase-db-1 \
  psql -U pegasus_ads_admin -d pegasus_ads -v ON_ERROR_STOP=1 \
  -f scripts/phase-1b/06-enable-rls.sql
```

Habilita RLS + cria `workspace_isolation` policy em todas as tabelas
multi-tenant. Inclui:
- Tabelas com `workspace_id` direto (19 tabelas)
- `test_round_variants` via JOIN com `test_rounds`
- `creative_edges` + `creative_ref_images` via `workspace_id` redundante
  (preenchido por UPDATE a partir do creative associado)

Saída final: lista de todas as tabelas com status RLS.

### Step 07 — Validação

```bash
DB_APP_PASSWORD=... DB_ADMIN_PASSWORD=... bash scripts/phase-1b/07-validate.sh
```

Faz 4 checks:
1. Contagem de rows: Neon vs pegasus_ads (esperado: igual exceto users/sessions)
2. FKs orfãs (esperado: 0 em todas)
3. RLS fail-safe: `pegasus_ads_app` SEM `SET LOCAL` retorna 0 rows
4. RLS positivo: `pegasus_ads_app` COM `SET LOCAL` retorna rows do workspace

Se tudo OK → **proceder ao cutover**.

---

## Cutover (final da Fase 1B)

**Janela de manutenção sugerida:** ~30 min, fora de horário comercial.

```bash
# 1. Atualizar /apps/pegasus/.env
#    DATABASE_URL → apontar para o pegasus_ads via Supavisor
#    Exemplo:
#    DATABASE_URL=postgres://pegasus_ads_app.pegasus_ads:<senha>@alpes-ads_supabase-supavisor-1:6543/pegasus_ads?sslmode=disable
#    DATABASE_URL_ADMIN continua direto (já está)
#    DATABASE_URL_NEON mantido como referência por 7 dias

# 2. Conectar pegasus-ads container na network do Supabase
#    (sem isso o hostname alpes-ads_supabase-* não resolve)
docker network connect alpes-ads_supabase_default pegasus-ads

# 3. Restart do app
docker restart pegasus-ads

# 4. Smoke test
curl -s https://pegasus.alpesd.com.br/api/health
# Testar 3-5 rotas críticas: /api/workspaces, /api/creatives, /api/insights
```

**Rollback se algo quebrar (em segundos):**
```bash
# Reverter .env: DATABASE_URL → Neon original
sed -i 's|^DATABASE_URL=postgres://.*pegasus_ads.*$|DATABASE_URL=$(grep DATABASE_URL_NEON .env | cut -d= -f2-)|' .env
docker restart pegasus-ads
```

---

## Validação pós-cutover (durante 24h)

- [ ] Crons rodando (kill rules, sync-all) — verificar logs
- [ ] Login funciona (continua usando Neon `users` por enquanto — só na Fase 2
      migra pro Supabase Auth)
- [ ] Métricas continuam sendo coletadas (sync-all)
- [ ] Geração de criativo via /api/generate funciona
- [ ] Publicação na Meta via /api/ads/publish-to-adsets funciona

Qualquer regressão → reverter via rollback acima e reportar pro próximo
Claude.

---

## Bloqueios conhecidos antes de começar

1. **TD-008**: 6 tabelas Creative Intelligence não estão nos schemas Drizzle.
   Step 01 precisa rodar primeiro pra extrair schemas; depois Claude precisa
   adicionar os arquivos `creative-intelligence.ts` e regenerar migration.
   **NÃO rodar Step 03+ antes disso.**

2. **TD-002 / Step 02**: a config exata de tenant do Supavisor depende da
   versão. Script preview o INSERT mas não executa — você confirma colunas
   primeiro.

3. **TD-006**: gotrue com JWT secret demo público — bloqueador P0 ANTES da
   Fase 2, mas não da Fase 1B. Só anotar.

---

## Após Fase 1B concluída

Atualizar Brain com memória de conclusão:

```bash
curl -X POST https://brain.alpesd.com.br/memory \
  -H "Authorization: Bearer brain-api-2026-secure-token" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "pegasus-ads",
    "thread": "migration",
    "kind": "fact",
    "title": "Fase 1B concluída — pegasus_ads em produção",
    "content": "Cutover de Neon → pegasus_ads (Supabase self-hosted) executado em <DATA>. Steps 01-07 OK. RLS enforced em <N> tabelas. Cron <X> jobs rodando contra novo DB. Senhas/conn strings em auto-memory + Brain #171. Próximo: Fase 1C+ (migração gradual das 84 rotas para Drizzle + withWorkspace).",
    "tags": ["migration", "fase-1b", "cutover", "pegasus_ads", "supabase"]
  }'
```

Atualizar `docs/tech-debt.md`:
- TD-002 → 🟢 done (Supavisor tenant configurado)
- TD-008 → 🟢 done se as 6 tabelas foram migradas

E abrir issue separado para tracking da Fase 1C (84 rotas).
