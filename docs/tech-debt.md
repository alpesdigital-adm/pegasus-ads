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

## TD-011 — /api/attribution ignora param `campaign_key` 🔴 open

**Descoberto:** 2026-04-18 (Fase 1C Wave 2 — auditoria da rota pelo gêmeo VPS)
**Dono:** Leandro (decisão de produto) + Claude (implementação)
**Impacto:** a rota aceita `?campaign_key=...` na querystring, mas o
SELECT agregado nunca usa esse valor como filtro. Métricas retornadas
são globais (todos os criativos do workspace ≠ killed), não da campanha
específica.

**Contexto:** bug presente desde antes da migração Drizzle. O response
documenta `campaign_key` como identificador da consulta, mas os números
(`total_spend`, `total_leads`) não refletem isso.

**Como resolver:**
1. Sign-off do Leandro sobre a intenção original (era pra filtrar ou não?)
2. Se SIM: adicionar JOIN com campaigns + WHERE c.campaign_key =
   campaign.metaCampaignId (ou equivalente) no aggregate
3. Se NÃO: remover o param do OpenAPI spec + doc + tipo de response pra
   refletir que é global

**Quando:** não é bloqueador. Valor numérico da API pode ter sido
consumido "errado" por dashboards — revisar antes de consertar.

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

## TD-002 — Configurar Supavisor no pegasus_ads 🟡 in-progress (deferred)

**Descoberto:** 2026-04-17 (Fase 0 da migração)
**Atualizado:** 2026-04-18 (pós-cutover: investigação revelou
schema/versão do Supavisor incompatível com o script — deferido)
**Dono:** Claude / Leandro (pós-cutover estabilizado)
**Impacto:** o cluster já tem Supavisor (`alpes-ads_supabase-supavisor-1`),
mas NINGUÉM usa hoje (CRM e Ads ambos em conexão direta porta 5432).
Supavisor seria ganho de multiplexing/pool, não bloqueador.

**Contexto (expandido 2026-04-18):**
- O cluster roda Supavisor moderno: tenants em
  `_supabase._supavisor.tenants` + usuários em `_supavisor.users` com
  `db_pass_encrypted bytea` (AES-GCM via API_JWT_SECRET)
- Script `scripts/phase-1b/02-supavisor-add-tenant.sh` assumia schema
  antigo (colunas `db_user/db_password` inline em tenants) — agora
  detecta o schema moderno e ABORTA com erro claro, em vez de tentar
  INSERT inválido
- HTTP API em `:4000/api/tenants` retorna 404 (esta versão não expõe
  management REST)
- CRM NÃO usa Supavisor (mesmo padrão direto porta 5432) — precedente
  de "viver sem pooling" já está estabelecido
- `API_JWT_SECRET` continua com valor demo público (TD-006 overlap)

**Riscos pendentes:** RLS `SET LOCAL app.workspace_id` pode não
persistir em transaction-mode (precisa validar antes de swapear
DATABASE_URL em prod)

**Como resolver (ordem):**
1. Rotacionar `API_JWT_SECRET` + `SECRET_KEY_BASE` do Supavisor
   (coordenar com time CRM — depende do plano TD-006)
2. Criar tenant via SQL direto em `_supavisor.tenants`
   (require_user=false, sem auth) + row em `_supavisor.users` com
   db_pass_encrypted correto (cifrar com chave derivada do novo
   API_JWT_SECRET — ou usar Supavisor CLI/Elixir shell dentro do
   container: `docker exec ... bin/supavisor rpc ...`)
3. Reiniciar Supavisor, validar conexão pooled com `psql`
4. Testar `SET LOCAL app.workspace_id` + query em RLS scope dentro de
   transaction — confirmar que persiste
5. Trocar `DATABASE_URL` do pegasus-ads para a URL via Supavisor,
   rebuildar green
6. Monitorar 1h — se quebrar, reverter para direto em 30s

**Quando:** depois do cutover estabilizar (monitor 24-48h OK) E
depois de rotacionar segredos demo do cluster (TD-006). Não é P1.

---

## TD-003 — `TEST_LOG_API_KEY` legacy 🔴 open

**Descoberto:** 2026-04-17 (plano v1.3, seção 6.6)
**Dono:** Claude (Fase 2+)
**Impacto:** fallback de auth via env var, fora do sistema de `api_keys`
table. Se a env vazar, dá acesso irrestrito.

**Como resolver:** após Supabase Auth em produção (Fase 2) e todos os
clients migrados, remover o branch `TEST_LOG_API_KEY` do fluxo de auth.

**Quando:** 90 dias após Fase 2 estabilizar.

---

## TD-004 — Tabelas `users` e `sessions` obsoletas 🟡 in-progress

**Descoberto:** 2026-04-17 (plano v1.3, seção 6.7)
**Atualizado:** 2026-04-18 (cutover bridge — `users`/`sessions` migrados para
pegasus_ads via `scripts/cutover/05-bridge-users-sessions.sh` porque sem eles
login quebraria pós-swap; Fase 2 ainda em backlog)
**Dono:** Claude (Fase 5, condicional à Fase 2 estabilizar)
**Impacto:** duas tabelas que agora vivem em DOIS lugares — pegasus_ads
(bridge ativa) e Neon (legado). Ambas continuam idênticas em estrutura. Vão
ser substituídas por `auth.users` (gotrue) na Fase 2.

**Como resolver:** após Fase 2 + 30 dias estável sem regressão, `DROP TABLE
users, sessions` no pegasus_ads (Neon já vai estar desligado nesse ponto).

**Quando:** 30 dias após Fase 2 + cleanup do Neon.

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

## TD-006 — gotrue com JWT secret demo público (herdado do CRM) ⚠️

**Descoberto:** 2026-04-15 (Brain memória #149, TD-001 do CRM)
**Dono:** Leandro + time CRM
**Impacto:** **P0 antes de prod com dados reais.** O `alpes-ads_supabase-auth-1`
está com `GOTRUE_JWT_SECRET=your-super-secret-jwt-token-with-at-least-32-characters-long`
(demo público do tutorial Supabase). Anon/service_role keys também são as
públicas do demo. Qualquer pessoa consegue forjar JWT válido para os dois apps
(CRM e Ads depois da Fase 2).

**Contexto:** herdado do setup inicial do Supabase self-hosted. Quando o Pegasus
Ads adotar Supabase Auth (Fase 2), passa a compartilhar essa vulnerabilidade.

**Como resolver:** coordenar com o time do CRM para rotação do
`GOTRUE_JWT_SECRET` + anon/service_role keys. Rotação invalida sessões — todos
os usuários precisam relogar.

**Quando:** ANTES da Fase 2 do pegasus-ads entrar em prod com dados reais.
Bloqueador P0.
