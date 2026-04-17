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

## TD-001 — Remover integração Vercel do repo 🔴 open

**Descoberto:** 2026-04-17 (PR #1 da migração)
**Dono:** Leandro (requer acesso admin ao repo GitHub)
**Impacto:** todo PR falha no check "Vercel" com `Account is blocked.`
— ruído visual, não bloqueia merge mas mascara falhas reais de CI quando
a Fase 4 adicionar GitHub Actions.

**Contexto:** o Vercel foi descontinuado quando a stack migrou para VPS
Hostinger (Brain memória #8, #29). A integração GitHub↔Vercel continuou
configurada e segue tentando deployar em cada push, falhando com conta
bloqueada.

**Como resolver:**
1. `Settings → Integrations` no repo `alpesdigital-adm/pegasus-ads`
2. Desinstalar a Vercel GitHub App (ou remover só este repo do escopo)
3. Confirmar que `vercel.json` ainda é necessário (ver se Docker build usa algo)
   — se não, remover também

**Quando:** antes da Fase 4 do plano de migração (quando CI entrar), para
não confundir falha real de CI com ruído residual.

---

## TD-002 — Configurar Supavisor no pegasus_ads 🟡 in-progress

**Descoberto:** 2026-04-17 (Fase 0 da migração)
**Atualizado:** 2026-04-17 (após execução VPS — Supavisor detectado)
**Dono:** Claude (Fase 1)
**Impacto:** o cluster já tem Supavisor (`alpes-ads_supabase-supavisor-1`),
mas o `.env` do pegasus-ads hoje aponta conexão direta ao Postgres
(`alpes-ads_supabase-db:5432`). Falta configurar o Supavisor para o
novo database `pegasus_ads` e trocar o `DATABASE_URL` para passar pelo
pooler em transaction mode (ganho de multiplexing).

**Contexto:** o plano v1.3 (seção 4.1) assumia PgBouncer em porta 6543.
Na verdade o stack usa **Supavisor** (Supabase moderno), que faz o
mesmo papel em outra porta/config. `DATABASE_URL_ADMIN` continua em
conexão direta (drizzle-kit + migrations não devem passar pelo pooler).

**Como resolver:**
1. Dentro de `alpes-ads_supabase-supavisor-1`, adicionar tenant
   `pegasus_ads` (confere como o CRM fez — provavelmente via env
   `POOLER_TENANT_ID` ou config file)
2. Atualizar o plano v1.4 trocando "PgBouncer" por "Supavisor" nas
   seções 4.1 / 4.3 / 5.8
3. Trocar `DATABASE_URL` do pegasus-ads para a URL via Supavisor
4. Validar que `SET LOCAL app.workspace_id` funciona no transaction
   mode do Supavisor (ponto de atenção da seção 5.8 do plano)

**Quando:** antes da Fase 1 cair em produção.

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

## TD-004 — Tabelas `users` e `sessions` obsoletas 🔴 open

**Descoberto:** 2026-04-17 (plano v1.3, seção 6.7)
**Dono:** Claude (Fase 5)
**Impacto:** duas tabelas cujos dados foram migrados para `auth.users`
do Supabase na Fase 2 mas ainda existem no DB como backup.

**Como resolver:** `DROP TABLE users, sessions` após 30 dias de Fase 2
estabilizada sem regressões de auth.

**Quando:** 30 dias após Fase 2.

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

## TD-008 — Tabelas Creative Intelligence fora do db.ts 🔴 open

**Descoberto:** 2026-04-17 (Fase 1A — Brain memória #108/#109)
**Dono:** Claude (Fase 1A follow-up)
**Impacto:** 5 tabelas adicionais (`offers`, `concepts`, `angles`, `launches`,
`ad_creatives`) + `classified_insights` foram criadas no Neon em 2026-04-12
via SQL direto, FORA do `initDb()` em `src/lib/db.ts`. Por isso, os schemas
Drizzle criados na Fase 1A NÃO incluem elas. A migration 0000 vai gerar um
banco Supabase com schema INCOMPLETO comparado ao Neon atual.

**Contexto:** tabelas usadas por `/insights` (memória #110) e `/api/cron/sync-all`.
Referências em `classified_insights` (BIGINT account_id, unique date+ad_id),
`offers` (workspace_id, key, name, offer_type, cpl_target), etc.

**Como resolver:**
1. Conectar no Neon (do VPS) e rodar `\d <tabela>` em cada uma para extrair
   o schema exato
2. Criar `src/lib/db/schema/creative-intelligence.ts` + adicionar
   `classified-insights.ts` (ou merger em metrics.ts)
3. Regenerar migration Drizzle
4. Commit como PR de correção (pre-Fase 1B)

**Quando:** ANTES da Fase 1B (pg_dump / restore) — senão o restore vai falhar
em FKs ou deixar dados órfãos.

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
