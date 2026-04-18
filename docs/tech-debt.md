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

## TD-013 — Consumers internos que dependiam do fallback TEST_LOG_API_KEY 🔴 open

**Descoberto:** 2026-04-18 (durante remoção do TD-003)
**Dono:** Claude (quando Apps Script voltar a ser priority ou sumir)
**Impacto:** rotas `/api/cron/weekly-report`, `/api/pipeline/run-cycle`,
e `/api/videos/temp/[filename]` fazem self-fetch passando
`process.env.TEST_LOG_API_KEY` como header x-api-key. Com TD-003 fechado,
essas auto-chamadas retornam 401 (a env não é mais aceita como auth).

**Contexto:** são jobs internos que rodavam via Apps Script. Leandro
confirmou que o Apps Script não funciona mais, então essas rotas hoje
estão dead code de fato.

**Como resolver (opções):**
A. **Deletar as rotas** — se Apps Script não volta, podem sumir. Limpa
   também `src/config/apps-script-template.ts`, `scripts/sync_test_log.gs`,
   `src/app/api/setup/test-log-sheet/route.ts`,
   `src/app/api/setup/apps-script/route.ts`.
B. **Refatorar pra chamar a lógica diretamente** — em vez de self-fetch,
   importar a função e chamar. Remove o round-trip HTTP e a dependência
   de auth.
C. **Criar uma api_keys interna** com escopo reduzido e usar ela como
   auth dessas rotas. Mais trabalhoso, só justifica se queremos expor
   esses endpoints externamente.

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

## TD-005 — `settings` global x `workspace_settings` 🔴 open

**Descoberto:** 2026-04-17 (plano v1.3, seção 2.1)
**Dono:** Claude (Fase 5)
**Impacto:** duas tabelas de settings — `settings` (global, key TEXT) e
`workspace_settings` (multi-tenant). A primeira é legado.

**Como resolver:** consolidar em `workspace_settings` adicionando rows com
`workspace_id = NULL` para settings globais OU criar enum `scope` separado.

**Quando:** Fase 5 (cleanup).

---

## TD-007 — Staging Queue v1.5 schemas ausentes 🔴 open

**Descoberto:** 2026-04-17 (Fase 1A da migração)
**Dono:** Leandro (doc de especificação) + Claude (implementação)
**Impacto:** o plano v1.4 referencia tabelas da "Staging Queue v1.5"
(`publication_batches`, `publication_steps`, `step_dependencies`, `step_events`,
`ad_blueprints`, `blueprint_versions`) mas o documento v1.5 com especificação
completa de colunas NÃO está no repo. Sem ele, criar os schemas Drizzle é
chute.

**Contexto:** o plano diz que os schemas devem existir na Fase 1 para evitar
migration adicional depois. Mas criar schemas com colunas especulativas gera
dívida real — a migration final terá que alterar tipo/nome/constraint.

**Como resolver:** finalizar o doc `docs/staging-queue-v1.5.md` com
especificação de colunas ANTES de adicionar os schemas Drizzle. Depois,
adicionar em PR separado (Fase 1E ou Fase 6 antecipada).

**Quando:** antes da Fase 6 ou quando a feature de staging queue for
priorizada (o que vier primeiro).

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

## TD-014 — DATABASE_URL demo no container Supavisor 🔴 open

**Descoberto:** 2026-04-18 (scripts/phase-2-supavisor/01-inspect.sh output)
**Dono:** Claude (janela de rotação geral do cluster)
**Impacto:** o container `alpes-ads_supabase-supavisor-1` tem
`DATABASE_URL` (que o Supavisor usa pra acessar seu próprio metadata DB,
não o DB do tenant) configurado com valor demo (length=84, padrão
`supabase/supavisor`). Só acessível dentro da docker network — não é
exploitable externamente hoje, mas permite acesso administrativo total
ao metadata (tenants, users, connection specs) por qualquer container da
mesma network.

**Contexto:** os segredos críticos (API_JWT_SECRET, SECRET_KEY_BASE,
VAULT_ENC_KEY, METRICS_JWT_SECRET) JÁ foram rotacionados durante TD-006.
DATABASE_URL não entrou naquela rotação porque é credencial de outro
database (Postgres metadata interno do Supavisor).

**Como resolver:**
1. Gerar senha nova pro user que o Supavisor usa (provavelmente
   `postgres` ou `supabase_admin` no database `postgres`)
2. `ALTER USER <user> WITH PASSWORD '<nova>'` no Postgres
3. Atualizar `DATABASE_URL` env var do container Supavisor + restart
4. Conferir que Supavisor reconecta com a nova credencial

**Riscos:**
- Se fizer com tenants ativos no Supavisor, pooling pode ficar unavailable
  durante o restart (~5-10s). Janela pequena mas visível.
- Se o user for `postgres` (super), qualquer outra coisa no cluster que
  use credencial `postgres` quebra também. CRM / Studio / Realtime
  precisam ser verificados.

**Quando:** janela de manutenção coordenada com time CRM. Não é P1 —
rede privada limita a exposição. Pode entrar em backlog de hardening de
cluster junto com TD-002 se rolar pooling bem.
