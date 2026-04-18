# Débitos Técnicos — Pegasus Ads

Registro de pendências conhecidas que não bloqueiam o trabalho atual mas
precisam ser endereçadas. Atualize o status ao resolver cada item (não apague
— mantenha a trilha).

| Estado | Significado |
|---|---|
| 🔴 open | Ainda não tratado |
| 🟡 in-progress | Em andamento |
| 🟢 done | Resolvido (manter aqui por histórico, só para linha do tempo) |

---

## TD-011 — /api/attribution removida 🟢 done

**Descoberto:** 2026-04-18 (Fase 1C Wave 2 — auditoria pelo gêmeo VPS)
**Atualizado:** 2026-04-18 (removida na Wave 7 — decisão de produto)
**Dono:** Leandro (decisão) + Claude (implementação)
**Impacto:** rota removida do repo. A avaliação do cowork (Claude do CRM,
que era o único consumidor externo potencial) revelou que:
- `live_metrics` ficava zerado para campanhas atuais (coeficientes
  hardcoded do T4, sem query real em dados ativos)
- `top_creatives_by_cpl` retornava vazio
- O modelo era **projeção estática com coeficientes fixos**, não
  atribuição de verdade
- `/api/campaigns/[id]/drill` já cobre 100% do uso acionável

**Estado final:**
- ✅ `src/app/api/attribution/route.ts` deletada
- ✅ Entrada no OpenAPI (`/api/docs`) removida
- ✅ Coeficientes T4 validados (CPL R$32,77, conv. rates, multi-ebook
  effect) preservados em `docs/business/t4-attribution-coefficients.md`
  como inteligência de negócio pra projeção/reconstrução futura

**Reconstrução futura:** se virar prioridade ter atribuição real, construir
feature nova que cruze Neon (UTM) com CRM (matrícula) por email/cpf, com
janela rolante — não remendar a rota antiga.

---

## TD-009 — Cutover Neon → Supabase concluído 🟢 done

**Descoberto:** 2026-04-17 (Fase 1B prep)
**Atualizado:** 2026-04-18 (cutover validado e em produção)
**Dono:** Claude + gêmeo VPS
**Impacto:** Cutover end-to-end concluído em 2026-04-18.

**Estado final:**
- `pegasus.alpesd.com.br` → green container → `pegasus_ads` (Supabase self-hosted)
- `pegasus-blue.alpesd.com.br` → blue container → Neon (rollback 24-48h)
- `pegasus-green.alpesd.com.br` → green (acesso direto staging)
- Login validado e2e: cookie do Neon migrado pra pegasus_ads, /api/auth/me 200
- Sync-all rodando: 168 upserts, 88 kills, 35 alerts no primeiro POST
- 4 colunas legacy de `users` (account_id, role, is_active, last_login_at)
  consolidadas no schema Drizzle + migration 0004 idempotente

**Pendência menor:** remoção do blue DIFERIDA para o final do plano de
migração (decisão 2026-04-18 pós-Fase 1C validada). Blue permanece como
rede de segurança durante Fases 2-5 — custo marginal (container idle +
Neon free tier), benefício real se alguma fase futura introduzir
regressão. Rodar `scripts/cutover/04-remove-blue.sh` só após Fase 5.

---

## TD-001 — Remover integração Vercel do repo 🟢 done

**Descoberto:** 2026-04-17 (PR #1 da migração)
**Atualizado:** 2026-04-18 (Leandro removeu projeto pegasus-ads do Vercel)
**Dono:** Leandro (ação no UI)
**Impacto:** PRs ainda podem ter o check "Vercel" aparecendo (Vercel App
segue instalado na org por causa do projeto `grclub`), mas pegasus-ads
não está mais linkado — não falha mais com `Account is blocked`. Fase 4
pode adicionar GitHub Actions sem ruído.

**Estado final:**
- ✅ `vercel.json` removido
- ✅ URLs hardcoded `pegasus-ads.vercel.app` → `pegasus.alpesd.com.br`
  em 5 arquivos (apps-script-template, google-drive fallback,
  reports/weekly footer, /api/docs spec, setup/apps-script doc)
- ✅ Projeto pegasus-ads removido do Vercel (2026-04-18 — Leandro)
- ⏸️ Vercel GitHub App permanece instalada na org por conta do projeto
  `grclub`. Isso é OK — só afeta o repo `grclub`, não o `pegasus-ads`.

**Quando:** antes da Fase 4 do plano de migração (quando CI entrar), para
não confundir falha real de CI com ruído residual.

---

## TD-002 — Supavisor pooling ativo 🟢 done

**Descoberto:** 2026-04-17 (Fase 0 da migração)
**Atualizado:** 2026-04-18 (cutover executado pós-Fase 2 — fundação
direito antes do telhado, decisão do Leandro)
**Dono:** Claude (implementação) + Leandro (autorização)
**Impacto:** pegasus-ads passa a conectar no Postgres via Supavisor em
transaction mode (porta 6543). Ganho imediato: multiplexing de conexões,
app pool de 10 no postgres-js serve N requests concorrentes sem abrir
novas conexões reais ao banco.

**Estado final:**
- ✅ Tenant `pegasus_ads` em `_supabase._supavisor.tenants`
- ✅ User `pegasus_ads_app` com db_pass_encrypted (formato Cloak correto)
- ✅ `DATABASE_URL` = Supavisor :6543 (pooled, transaction mode)
- ✅ `DATABASE_URL_ADMIN` = direto :5432 (BYPASSRLS, migrations)
- ✅ Smoke 5/5: connectivity, prepare:false, SET LOCAL persiste na
  transação, SET LOCAL não vaza entre transações, RLS end-to-end
- ✅ Rotas withWorkspace() retornando dados reais via pool

**pg_stat_activity pós-cutover:**
```
pegasus_ads_app    | Supavisor             | 1  ← app via pool
pegasus_ads_app    | Supavisor auth_query  | 1  ← gatekeeper
pegasus_ads_admin  | postgres.js           | 1  ← admin direto
```

**Aprendizados documentados em `scripts/phase-2-supavisor/`:**
- `eval` é caminho canonical (não sofre do issue de FQDN do `rpc`)
- Encryption do Supavisor usa envelope Cloak próprio
  (`<<version:1, tag_len:1, tag:N, iv:12, ct+auth_tag:N>>`), NÃO AES-GCM
  raw — script Node deprecated com warning
- Schema moderno (Supavisor 2.7.4): `tenants.id`/`users.id` sem default
  (gen_random_uuid explícito), `db_user_alias` NOT NULL, UNIQUE em
  `(db_user_alias, tenant_external_id, mode_type)`, `require_user=true`
  evita exigir `auth_query`
- `SET LOCAL` funciona em transaction mode — verificado empiricamente,
  conexão Postgres é dedicada BEGIN→COMMIT

**TDs relacionados que continuam abertos:**
- TD-014 — DATABASE_URL demo no container Supavisor (credencial do
  metadata DB interno, não afeta pooling)

---

## TD-003 — `TEST_LOG_API_KEY` legacy 🟢 done

**Descoberto:** 2026-04-17 (plano v1.3, seção 6.6)
**Atualizado:** 2026-04-18 (Apps Script parou de funcionar, Leandro
autorizou remoção antecipada — escopo original era 90d pós-Fase 2)
**Dono:** Claude
**Impacto:** removido. Fallback `if (apiKey === process.env.TEST_LOG_API_KEY)`
em `src/lib/auth.ts` `authenticate()` foi eliminado junto com o mock
`user_id: "legacy"`. Agora só `api_keys` table (hash, revoke, per-workspace).

**Estado final:**
- ✅ Bloco `TEST_LOG_API_KEY` removido de `src/lib/auth.ts`
- ✅ Imports mortos (workspaces, workspaceMetaAccounts, desc, sql) limpos
- ✅ OpenAPI spec `ApiKeyAuth` removido
- ⚠️ Env `TEST_LOG_API_KEY` ainda pode estar setada em `.env` do prod —
  pode ser removida sem impacto (nenhum código lê pra autenticar). Os
  consumers internos que ainda referenciam (ver TD-013) usam APENAS pra
  gerar payload do Apps Script (template), não pra validar requests.

---

## TD-013 — Apps Script ecosystem removido 🟢 done

**Descoberto:** 2026-04-18 (durante remoção do TD-003)
**Atualizado:** 2026-04-18 (opção A executada — delete total)
**Dono:** Claude
**Impacto:** resolvido via deleção completa do ecossistema Apps Script.
Leandro confirmou que o Apps Script não funciona mais e não vai voltar.

**Deletados (6 arquivos + 3 diretórios):**
- `src/app/api/setup/test-log-sheet/route.ts`
- `src/app/api/setup/apps-script/route.ts` + dir `setup/`
- `src/app/api/cron/weekly-report/route.ts` + dir
- `src/app/api/pipeline/run-cycle/route.ts` + dir `pipeline/`
- `src/config/apps-script-template.ts`
- `scripts/sync_test_log.gs`

**Editados (parcial):**
- `src/app/api/videos/temp/[filename]/route.ts`: DELETE handler removido
  (usava TEST_LOG_API_KEY); GET preservado (Meta API precisa, público)
- `src/components/Header.tsx`: `TestLogButton` (componente + JSX mount)
  removido; `AlertCounts`/`AlertRow` interfaces que estavam no meio
  preservadas
- `src/app/api/docs/route.ts`: entry OpenAPI de `/api/pipeline/run-cycle`
  removida
- 4 routes com comentário obsoleto atualizados (`publish-external`,
  `publish-carousel`, `drive/list-creatives`, `videos/upload-temp`) pra
  refletir que auth real é via api_keys + cookie Supabase

**Não tocado (fora do escopo):**
- `mcp-server/` — sub-projeto separado, provavelmente dead também mas
  não vale a pena mexer sem confirmar
- Referências em docs (`plano-migracao`, `api-reference`, `fase1c-route-audit`)
  — ficam como trilha histórica, não geram bugs

**Quando:** quando decidir o futuro do ecossistema Apps Script — sumir,
reviver, ou substituir por outra ferramenta de sync.

---

## TD-004 — Tabelas `users` e `sessions` obsoletas 🟢 done

**Descoberto:** 2026-04-17 (plano v1.3, seção 6.7)
**Atualizado:** 2026-04-18 (Fase 2 PR 2c — sessions dropado, password_hash
removido, users vira profile local)
**Dono:** Claude
**Impacto:** resolvido. Migração completa pra Supabase gotrue (auth.users).
public.users continua como profile local (name, avatar_url, auth_user_id
NOT NULL), mas credencial mora em auth.users. sessions table foi dropada
junto com o path scrypt/bcrypt de login.

**Estado final (migration 0008):**
- ✅ `DROP TABLE sessions CASCADE`
- ✅ `ALTER TABLE users DROP COLUMN password_hash`
- ✅ `ALTER TABLE users ALTER COLUMN auth_user_id SET NOT NULL`
- ✅ bcryptjs removido do package.json
- ✅ `/api/auth/login` só Supabase (sem fallback scrypt)
- ✅ `/api/workspaces/switch` usa cookie `pegasus_workspace_id` em vez de
  atualizar sessions.workspace_id

**Cleanup de Neon:** o Neon blue ainda tem as tabelas antigas (bridge
step 05). Quando rodar `scripts/cutover/04-remove-blue.sh` (pós-Fase 5),
Neon inteiro some — leva as tabelas junto.

---

## TD-005 — `settings` global dropada 🟢 done

**Descoberto:** 2026-04-17 (plano v1.3, seção 2.1)
**Atualizado:** 2026-04-18 (migration 0009 aplicada em prod pelo gêmeo VPS, 19:56)
**Dono:** Claude
**Impacto:** resolvido. Tabela `settings` global foi dropada —
auditoria mostrou que tinha só 2 classes de uso:
  1. `last_ad_number` (override manual do NamingService) → movido
     pra `workspace_settings` (faz mais sentido ser per-workspace:
     numeração já é escopada por RLS em creatives/published_ads).
  2. `apps_script_id`, `test_log_*` → órfãs após TD-013 (Apps Script
     ecosystem deletado), sem readers.

**Estado final:**
- ✅ Migration 0009 — move `last_ad_number` pro `workspace_settings`
  do workspace mais antigo + `DROP TABLE settings CASCADE` (inclui
  as órfãs do Apps Script)
- ✅ `src/lib/creative-naming.ts` — usa `getWorkspaceSetting` em
  vez de query na tabela global
- ✅ `/api/settings` — operando em `workspace_settings` via
  withWorkspace/RLS. API contract passou a ser per-workspace
  (zero frontend caller afetado — auditoria confirmou que a page
  `/settings` só gerencia Meta accounts, não usa esse endpoint).
- ✅ Schema `settings` removido de `src/lib/db/schema/prompts.ts`
- ✅ Aplicado em prod 2026-04-18 19:56 (gêmeo VPS): BEGIN/COMMIT,
  hash registrado em `drizzle.__drizzle_migrations`. Na prática não
  havia `last_ad_number` pra migrar (schema já estava limpo — só
  órfãs do Apps Script). Green rebuildado + smoke: `/api/docs` 200,
  `/api/settings` 401 sem cookie (roteando OK), logs limpos.

**Sem schema `scope` enum nem `workspace_id NULL`** — abordagem rejeitada.
A única key realmente global (`last_ad_number`) acabou sendo
conceitualmente per-workspace mesmo. Não sobrou nenhum caso legítimo
pra setting global, então não faz sentido preservar a complexidade.

**Gotcha operacional (migrations futuras):** gravar o hash em
`drizzle.__drizzle_migrations` exige `-U supabase_admin` (superuser).
`-U postgres` falha com `permission denied for table __drizzle_migrations`
— a table é owned por `pegasus_ads_admin` e `postgres` não tem grants.
Atualizar snippet de apply pra usar `supabase_admin` por default.

---

## TD-007 — Staging Queue — spec v2 aprovada 🟡 in-progress

**Descoberto:** 2026-04-17 (Fase 1A da migração)
**Atualizado:** 2026-04-18 (decisão de produto do Leandro + spec commitada)
**Dono:** Leandro (decisões tomadas) + Claude (implementação)
**Impacto:** bloqueio de especificação resolvido. Leandro escolheu
**opção A (Build completo)** rejeitando Simplify porque custo de manter
versão capenga + rebuild futuro é maior que fazer certo de uma vez.

**Spec aprovada:** `docs/staging-queue-v2.md` (commit 82fcfb0, 1994 linhas)

**Decisões de design (D1-D6):**
- D1: Build completo — 4 tabelas, DAG, state machines, event log
- D2: MVP com full DAG, sem blueprints, sem worker distribuído, sem
  throttling global cross-workspace
- D3: Worker cron+HTTP (pattern validado em `sync-all`/`collect`)
- D4: Idempotência por verificação (GET antes de POST) + reconciliation
  job semanal
- D5: `dbAdmin` (BYPASSRLS) + filtro manual de workspace (pattern CRM)
- D6: Activation Mode — ads criados PAUSED (default `after_all`),
  ativados em lote no final. Modo `immediate` disponível pra reposição
  urgente.

**Arquitetura (4 tabelas):**
- `publication_batches` — state machine scheduled→pending→running→paused→
  succeeded/failed/partial_success/cancelled
- `publication_steps` — unidade atômica retriable, 8 estados, backoff
  5s→320s
- `step_dependencies` — DAG com propagação de outputs (outputKey→inputKey)
- `step_events` — append-only log pra debug/auditoria/progresso

**Features completas do MVP:**
- Pause/Resume mid-publication (entre steps)
- Publicação agendada (`scheduled_at` promovido pelo worker)
- Frontend real-time via Supabase Realtime (3 channels)
- Progresso intra-step pra upload de vídeo
- ETA dinâmico por média de step duration
- 16+ step handlers
- Migração incremental via feature flag `USE_STAGING_QUEUE`
- Cancel seguro (after_all deixa ads PAUSED, zero spend)

**Estimativa:** 12-15 dias de implementação.

**Débitos aceitos (fora do MVP):**
- Sem throttling global cross-workspace (0.5 dia quando necessário)
- Sem two-phase commit (coberto por reconciliation)
- Sem blueprints (`ad_blueprints`/`blueprint_versions` — 3 dias quando
  virar prioridade de negócio)

**Quando implementar:** próxima fase de engenharia. Leandro priorizou
como fundação pra import pipeline (Fase 6 do plano v1.4).

---

## TD-008 — Tabelas Creative Intelligence fora do db.ts 🟢 done

**Descoberto:** 2026-04-17 (Fase 1A — Brain memória #108/#109)
**Atualizado:** 2026-04-17 (Fase 1B executada end-to-end — relatório em
`docs/migration/fase1b-complete-report.md`)
**Dono:** Claude (Fase 1B)
**Impacto:** 6 tabelas adicionais (`offers`, `concepts`, `angles`, `launches`,
`ad_creatives`, `classified_insights`) foram criadas no Neon em 2026-04-12
via SQL direto, FORA do `initDb()` em `src/lib/db.ts`. Essas tabelas FORAM
adicionadas aos schemas Drizzle na Fase 1B prep
(`docs/migration/fase1b-ci-schemas.md` → `src/lib/db/schema/creative-intelligence.ts`
+ `classified-insights.ts` + migration `drizzle/0001_*`).

**Status:**
- ✓ Schemas extraídos (gêmeo VPS, commits c37e0ea + 574a412)
- ✓ Schemas Drizzle adicionados — 17 tabelas novas no total:
  - CI core (5): offers, concepts, angles, launches, ad_creatives
  - CI adjacente (1): classified_insights
  - Meta insights (4): ad_accounts, ad_insights, hourly_insights, sync_logs
  - Legacy lead capture (3): accounts, lead_sources, leads
  - Workspace extras (2): projects, crm_import_mappings
  - Global misc (2): classification_rules, saved_views
- ✓ Migration 0001 (6 CI tables) + 0002 (11 tables adicionais) geradas
- ✓ FKs resolvidas: classified_insights.insight_id → ad_insights,
  classified_insights.account_id → ad_accounts (antes eram int/bigint sem FK)
- ✓ Step 04 atualizado (docker postgres:17-alpine — Neon é 17.8 / apt é 16.x)
- ✓ Step 05 Python: mapping para 15 tabelas com PK serial +  preserva FKs
  (accounts → lead_sources → leads cadeia, ad_accounts → insights/sync_logs)
- ✓ Step 06 RLS: projects + crm_import_mappings (workspace_id direto)
- ✓ Handoff report do gêmeo em docs/migration/fase1b-inspect-report.md
- 🟢 TD-008 RESOLVIDO — todas as tabelas do Neon estão nos schemas Drizzle.
  Pronto para Fase 1B steps 03-07 sem perda de dados.

---

## TD-006 — gotrue JWT secret rotacionado 🟢 done

**Descoberto:** 2026-04-15 (Brain memória #149, TD-001 do CRM)
**Atualizado:** 2026-04-18 (rotação executada pelo cowork CRM)
**Dono:** Time CRM (execução) + Leandro (coordenação)
**Impacto:** Vulnerabilidade resolvida. Cluster não tem mais secret demo
público. Fase 2 (Supabase Auth no pegasus-ads) destravada.

**Estado final:**
- ✅ `GOTRUE_JWT_SECRET` rotacionado (novo valor, guardado em gerenciador
  de senhas — nunca em repo, chat, ou logs)
- ✅ `ANON_KEY` e `SERVICE_ROLE_KEY` regenerados com issuer `alpes-ads` +
  expiração ~10 anos
- ✅ 7 containers do cluster `alpes-ads_supabase` rotacionados e healthy
- ✅ Auth endpoint valida 200 com nova anon
- ✅ CRM `.env` + bundle atualizados; 85 refresh_tokens antigos deletados
- ✅ Scripts de rotação commitados em
  `scripts/td-006-*` (generate, rotate, update-crm-env) para replay futuro

**Descoberta colateral (fix já em prod):** o `Dockerfile` do CRM tinha o
JWT demo hardcoded como `ARG default`, e `deploy.sh` nunca baked o real
ANON_KEY via `--build-arg`. Funcionava por sorte (CRM usa auth
server-side, não browser supabase-js). Corrigido em `scripts/deploy.sh`
com `NEXT_PUBLIC_SUPABASE_*` como build-arg + `ANON_HASH` no `BUILD_ID`
pra invalidar cache em rotações futuras.

**Implicações para pegasus-ads (Fase 2):**
- Quando migrar pra Supabase Auth, usar o novo `GOTRUE_JWT_SECRET`
  (mesmo cluster, compartilhado com CRM)
- Bakear `NEXT_PUBLIC_SUPABASE_ANON_KEY` corretamente via build-arg
  (espelhar o fix do CRM no `deploy.sh` do pegasus-ads)

---

## TD-014 — DATABASE_URL demo no container Supavisor 🟢 done

**Descoberto:** 2026-04-18 (scripts/phase-2-supavisor/01-inspect.sh output)
**Atualizado:** 2026-04-18 (isolation strategy executada, ~10s downtime)
**Dono:** Claude (implementação) + Leandro (autorização)
**Impacto:** resolvido via user dedicado em vez de rotação direta.
Supavisor não usa mais superuser pra acessar metadata DB.

**Estado final:**
- ✅ Role `supavisor_meta` (LOGIN, NÃO-superuser, NÃO-createdb, NÃO-createrole)
- ✅ GRANTs escopados em `_supabase` + schemas `_supavisor` + `public`
- ✅ `DATABASE_URL` do container Supavisor aponta pra `supavisor_meta`
- ✅ Smoke 5/5: eval, tenants visíveis, /api/docs 200, login 401 (rota
  roteando ok), pool do pegasus-ads funcionando, RLS via pool, logs green
- ✅ `supabase_admin` sumiu do pool — migration limpa
- ✅ Senha em `/root/.supavisor-meta-password` (mode 600)
- ✅ Backups preservados (`.env.pre-td014-*` + `docker-compose.override.yml.pre-td014-*`)

**Abordagem:** escolhido isolation (CASO B do inspect) porque Supavisor
estava usando `supabase_admin` (superuser cluster-wide). Rotação direta
quebraria CRM/Studio/Realtime — isolar via role dedicada é
least-privilege sem coordenação cross-app.

**Efeito colateral operacional (cluster management — documentar):**
`docker compose up -d supavisor --force-recreate` recriou também
`db + vector + realtime` por conta de envs interpoladas cross-service
via easypanel. Downtime real ~10s, cluster healthy rápido. Mudanças
futuras em env do Supabase stack via easypanel devem prever esse
side-effect em janela de maintenance.

**Peer review — follow-ups endereçados (2026-04-18):**

1. ✅ **GRANT `CREATE ON SCHEMA _supavisor` removido** via
   `scripts/td-014-supavisor-dburl/03-tighten-grants.sh`.
   Runtime Supavisor só escreve rows. Antes de `docker pull supabase/
   supavisor:NEW`, re-grant temporário pra deixar migrations rodarem.

2. ✅ **Escopo de `_supabase` reduzido**. Leandro confirmou que o schema
   está VAZIO (as 5 tables do metadata ficam em `_supavisor.*`).
   Mantido só USAGE + DEFAULT PRIVILEGES (cobre futuras tables sem
   GRANT ALL imediato).

3. ✅ **Healthcheck estrutural** em `/api/health` (commit ao fechar).
   Valida connectivity via pool + SET LOCAL em transaction mode.
   Retorna 503 se algo quebrar. Pode ser apontado por uptime monitor
   externo. Cron diário sync-all continua valendo como canário implícito.

4. ✅ **Política de rotação documentada** em
   `docs/operations/cluster-runbook.md`. Triggers: 180d, mudança de
   SSH access no VPS, suspeita de comprometimento, `docker cp` de
   `.env` pra fora, janela anual. Inclui runbook passo-a-passo.

**Rollback disponível (não recomendado, mas documentado):**
```bash
cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
cp .env.pre-td014-* .env
cp docker-compose.override.yml.pre-td014-* docker-compose.override.yml
docker compose -p alpes-ads_supabase up -d supavisor --force-recreate
# opcional: DROP ROLE supavisor_meta
```

---

## TD-015 — Realtime do cluster Supabase não wired pro DB `pegasus_ads` 🔴 open

**Descoberto:** 2026-04-18 (gêmeo VPS tentando aplicar migration 0010 da
Staging Queue v2)
**Dono:** decisão pendente (Leandro + arquitetura do cluster)
**Impacto:** frontend do Pegasus Ads não consegue receber eventos Realtime
do banco `pegasus_ads`. Consequência prática no curto prazo: os 3 canais
Realtime planejados pela Staging Queue v2 (`batch-{id}`, `steps-{id}`,
`events-{id}`) não funcionam até TD-015 ser endereçado. Worker opera
via cron independente, então não é bloqueante pra Fase 1/2 da queue,
mas **bloqueia Fase 4** (frontend real-time de progresso).

**Descoberta técnica:**
- `pg_publication` em `pegasus_ads` está vazio — publication
  `supabase_realtime` existe apenas no DB `postgres` do cluster.
- Container `alpes-ads_supabase-realtime-1` tem `DB_NAME=postgres`, ou
  seja, escuta WAL só do DB legacy — não enxerga mudanças em
  `pegasus_ads` nem em outros DBs que venhamos a criar.

**Mitigação imediata aplicada (migration 0010):**
- `ALTER PUBLICATION supabase_realtime ADD TABLE …` virou guard
  condicional com `IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname
  = 'supabase_realtime')`. No DB `pegasus_ads` isso loga NOTICE e pula —
  migration aplica limpo, nada fica plantado meia-pronto.
- Ao endereçar TD-015, uma migration nova adiciona as 3 tabelas à
  publication (`publication_batches`, `publication_steps`, `step_events`)
  — `step_dependencies` fica fora (topologia estática do DAG).

**Caminhos possíveis (decidir com calma):**
1. **Container Realtime dedicado pro pegasus_ads** (novo
   `alpes-ads_supabase-realtime-pegasus`): isolamento forte, custo
   modesto (um container extra). Próximo do pattern que o Supabase
   hosted usa em multi-project.
2. **Multi-tenant no container atual** (Realtime v2 com múltiplos
   tenants): menos container, mais config. Requer validar se a versão
   do Realtime no cluster suporta e se o CRM (que usa o DB `postgres`)
   não quebra no meio do caminho.
3. **Trocar DB_NAME do container atual pra `pegasus_ads`**: quebra
   qualquer dependência Realtime do CRM/`postgres`. Auditar antes.

**Quando:** antes da Fase 4 da Staging Queue v2 (frontend real-time).
Fases 1-3 podem seguir sem Realtime (UI cai em fallback polling ou
simplesmente não mostra progresso granular até TD-015 fechar).
