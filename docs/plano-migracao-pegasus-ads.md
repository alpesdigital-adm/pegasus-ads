# Plano de Migração — Pegasus Ads

**Versão:** 1.5 — 2026-04-18  
**Status:** Fases 0, 1A, 1B + cutover CONCLUÍDOS — Fase 1C em backlog  
**Autor:** Claude (análise) + Leandro (decisões e validação)

**Changelog v1.5 (2026-04-18):**
- Cutover Neon → Supabase executado end-to-end em 2026-04-18 (TD-009)
- Bridge `users` + `sessions` adicionada (decisão pragmática — Fase 2 vai
  substituir por `auth.users` depois). Drop diferido 30 dias pós-Fase 2.
- Schema drift de `users` (4 colunas legacy: account_id, role, is_active,
  last_login_at) consolidado no Drizzle + migration 0004 idempotente
- `classified_insights.insight_id` / `account_id`: FKs especulativas
  removidas (nunca existiram no Neon original) — migration 0003 relaxa
  para nullable sem FK
- `vercel.json` removido (dead weight — VPS ignora; crontab local cobre os
  jobs que Vercel rodava)
- URLs hardcoded `pegasus-ads.vercel.app` → `pegasus.alpesd.com.br` em 5
  arquivos (defaults, footers, docs — runtime usa env vars)

**Changelog v1.4 (2026-04-17):**
- Cluster real verificado: Postgres **15.8** (não 16), superuser `supabase_admin`
- Pooler real detectado: **Supavisor** (não PgBouncer) — todas as referências
  a PgBouncer neste doc foram atualizadas para Supavisor
- Fase 1 subdividida em sub-fases 1A (foundation) / 1B (data migration) /
  1C+ (route migration) por causa do tamanho

---

## 1. Contexto e Objetivos

### 1.1 Situação atual

O Pegasus Ads opera com uma stack fragmentada que dificulta manutenção e integração com o Pegasus CRM:

| Aspecto | Pegasus Ads (atual) | Pegasus CRM (referência) |
|---|---|---|
| **DB** | Neon serverless (`@neondatabase/serverless`) | Supabase self-hosted (Postgres 15.8, Supavisor) |
| **ORM** | Raw SQL, `CREATE TABLE IF NOT EXISTS` imperativo (680 linhas em `db.ts`) | Drizzle ORM 0.45.2, schemas modulares por domínio |
| **Auth** | Custom: bcrypt passwords, session tokens em tabela, cookie `pegasus_session` | Supabase Auth (gotrue compartilhado) |
| **Design System** | CSS custom dark-only (hex), classes `.btn-*`, GSAP, SVG inline | shadcn/ui v4 `base-nova`, Tailwind 4 OKLCH, lucide-react, Zustand theme |
| **Observabilidade** | Zero (console.log) | Pino (com redaction), Prometheus histograms, Sentry |
| **Testes** | Zero (sem vitest, sem CI) | Vitest + jsdom + v8 coverage, GitHub Actions CI |
| **Storage** | `@vercel/blob` | Supabase Storage (mesmo cluster) |

### 1.2 Decisões tomadas

1. **DB Engine:** Migrar Neon → Supabase self-hosted. **Database separado** (`pegasus_ads`) no mesmo cluster Postgres que o CRM (`pegasus_crm`), dentro da instância `alpes-ads_supabase`.
2. **ORM:** Migrar raw SQL → Drizzle ORM com schemas modulares.
3. **Auth:** Migrar custom sessions → Supabase Auth (gotrue compartilhado com CRM).
4. **Design System:** Adotar shadcn/ui `base-nova` + OKLCH + lucide-react do CRM.
5. **Observabilidade:** Portar Pino + Prometheus + Sentry do CRM.
6. **Testes:** Adicionar Vitest + CI/CD.
7. **PKs:** Migrar todas as PKs internas de TEXT para UUID nativo.
8. **RLS:** Implementar Row-Level Security em todas as tabelas multi-tenant.
9. **Arquitetura de publicação:** Integrar o sistema de staging queue (v1.5) às novas tabelas.
10. **Abordagem:** Documento primeiro, dividir em fases, codar depois.

### 1.3 Princípios da migração

- **Zero downtime:** Cada fase deve permitir rollback sem perda de dados.
- **Coesão cross-project:** Estrutura, padrões e tokens visuais devem ser idênticos ao CRM.
- **Incremental:** Nenhuma fase deve exigir migração simultânea de mais de 2 subsistemas.
- **Database separado, auth compartilhado:** O Pegasus Ads terá seu próprio database (`pegasus_ads`) no mesmo cluster Supabase, mas compartilhará o gotrue (auth) com o CRM. Cada projeto acessa apenas seu database via roles e connection strings separadas.

---

## 2. Inventário de Schemas — Estado Atual

### 2.1 Tabelas do `db.ts` (680 linhas, 22 tabelas)

**Domínio: Core / Multi-tenant (6 tabelas)**

| Tabela | PK | Destino na migração |
|---|---|---|
| `users` | `id TEXT` | **Removida** — migra para `auth.users` do Supabase |
| `workspaces` | `id TEXT` | Mantida, vira Drizzle schema |
| `plans` | `id TEXT` | Mantida (com seed via migration) |
| `workspace_members` | `(workspace_id, user_id)` | Mantida, FK aponta para `auth.users` |
| `sessions` | `token TEXT` | **Removida** — Supabase Auth gerencia sessões |
| `api_keys` | `id TEXT` | Mantida (API keys são do Pegasus, não do gotrue) |

**Domínio: Meta Accounts (2 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `workspace_meta_accounts` | `id TEXT` | Mantida. `token_encrypted` deve migrar para vault ou env. |
| `workspace_settings` | `(workspace_id, key)` | Mantida como está. |

**Domínio: Criativos (4 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `images` | `id TEXT` | `blob_url` aponta para Vercel Blob → migrar referências para Supabase Storage. |
| `creatives` | `id TEXT` | Colunas adicionadas via ALTER: `is_control`, `funnel_key`, `workspace_id`. Consolidar. Adicionar: `origin` (generated\|imported), `meta_creative_spec` (JSONB), `instagram_permalink` (TEXT). |
| `creative_edges` | `id TEXT` | Sem alteração estrutural. |
| `creative_ref_images` | `id TEXT` | Sem alteração estrutural. |

**Domínio: Métricas (3 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `metrics` | `id TEXT` | Coluna `landing_page_views` adicionada via ALTER. Consolidar. |
| `metrics_breakdowns` | `id TEXT` | Posicionamento (plataforma × position). |
| `metrics_demographics` | `id TEXT` | Idade × gênero. |

**Domínio: Testes e Publicação (5 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `campaigns` | `id TEXT` | Sem alteração. |
| `ad_sets` | **NOVA** | Tabela de primeira classe para ad sets. Targeting, budget, optimization_goal, bid_strategy. |
| `test_rounds` | `id TEXT` | Estado de testes A/B. |
| `test_round_variants` | `id TEXT` | Variantes de teste. |
| `published_ads` | `id TEXT` | Ads publicados na Meta. |

**Domínio: Inteligência e Operação (5 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `pipeline_executions` | `id TEXT` | Execuções de pipeline (generate/publish/analyze/kill). |
| `visual_elements` | `id TEXT` | Galeria de variáveis visuais por dimensão. |
| `hypotheses` | `id TEXT` | Hipóteses de teste geradas por IA. |
| `funnels` | `id TEXT` | Multi-funil (T4, T7, etc). |
| `alerts` | `id TEXT` | Alertas de anomalia. |

**Domínio: CRM Leads (2 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `crm_leads` | `(workspace_id, crm_id)` | Leads importados do CRM para enriquecimento de métricas. |
| `lead_qualification_rules` | `id TEXT` | Regras de qualificação por projeto. |

**Domínio: Config legado (2 tabelas)**

| Tabela | PK | Notas |
|---|---|---|
| `prompts` | `id TEXT` | Histórico de prompts de geração. |
| `settings` | `key TEXT` | Settings globais (não multi-tenant). Avaliar merge com `workspace_settings`. |

### 2.2 Tabelas novas (staging queue v1.5)

As tabelas abaixo são definidas na arquitetura staging queue (documento v1.5) e devem ser incluídas como schemas Drizzle desde a fase de ORM:

| Tabela | Domínio | Notas |
|---|---|---|
| `publication_batches` | Staging | Batch de publicação com state machine |
| `publication_steps` | Staging | Steps individuais (upload, creative, ad) |
| `step_dependencies` | Staging | Grafo DAG de dependências entre steps |
| `step_events` | Staging | Event log append-only |
| `ad_blueprints` | Reference | Templates versionados de ads validados |
| `blueprint_versions` | Reference | Versionamento de blueprints |

---

## 3. Mapeamento de Schemas Drizzle

### 3.1 Organização de arquivos

Seguindo o padrão do CRM (barrel export):

```
src/lib/db/
├── index.ts              # db + dbAdmin (dual client)
├── migrate.ts            # Drizzle migration runner
└── schema/
    ├── index.ts           # Barrel re-export
    ├── workspaces.ts      # workspaces, plans, workspace_members, workspace_settings
    ├── api-keys.ts        # api_keys
    ├── meta-accounts.ts   # workspace_meta_accounts
    ├── creatives.ts       # images, creatives, creative_edges, creative_ref_images
    ├── metrics.ts         # metrics, metrics_breakdowns, metrics_demographics
    ├── campaigns.ts       # campaigns, ad_sets, funnels
    ├── testing.ts         # test_rounds, test_round_variants
    ├── publishing.ts      # published_ads, publication_batches, publication_steps,
    │                      # step_dependencies, step_events
    ├── imports.ts         # import_jobs, import_job_items
    ├── blueprints.ts      # ad_blueprints, blueprint_versions
    ├── intelligence.ts    # visual_elements, hypotheses, alerts
    ├── crm.ts             # crm_leads, lead_qualification_rules
    ├── pipelines.ts       # pipeline_executions
    └── prompts.ts         # prompts, settings (legado)
```

### 3.2 Exemplo de schema Drizzle — `workspaces.ts`

```typescript
import { pgTable, uuid, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';

export const planEnum = pgEnum('plan_tier', ['free', 'pro', 'enterprise']);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),  // gen_random_uuid()
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: planEnum('plan').default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),  // FK para auth.users (Supabase, UUID nativo)
  role: text('role', { enum: ['owner', 'admin', 'member'] }).notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (t) => [
  { primaryKey: { columns: [t.workspaceId, t.userId] } },
]);
```

**Nota:** `defaultRandom()` usa `gen_random_uuid()` do Postgres 14+ — geração no banco, sem depender da aplicação. Para IDs externos (Meta, Google), o tipo continua `text()`.

### 3.3 Migração de PKs: TEXT → UUID nativo

**Decisão (v1.1):** Migrar TODAS as PKs internas de `TEXT` para `UUID` nativo do Postgres.

**Justificativa:** O sistema tem ~1 mês de operação e ~50k rows. Os dados existentes são replicáveis (métricas vêm da Meta API, criativos podem ser regenerados). Daqui a 6 meses, com 5+ projetos novos e milhões de rows em métricas e CRM leads, essa migração seria um projeto inteiro com risco real de corrupção de FKs. **O momento é agora.**

**Benefícios concretos:**

1. **Performance:** UUID nativo = 16 bytes fixos em B-tree. TEXT variável = overhead de TOAST, comparação byte-a-byte mais lenta. Em tabelas de métricas com milhões de rows e JOINs frequentes, a diferença é mensurável.
2. **Consistência:** CRM já usa UUID nativo. Unifica o padrão cross-project.
3. **Ecossistema:** Supabase, Drizzle, e RLS assumem UUID. Menos friction em tudo.
4. **gen_random_uuid():** Geração no banco (Postgres 14+), sem depender da aplicação.

**O que migra para UUID:**

Todas as PKs internas: `workspaces.id`, `plans.id`, `workspace_members.*_id`, `api_keys.id`, `workspace_meta_accounts.id`, `images.id`, `creatives.id`, `creative_edges.id`, `creative_ref_images.id`, `metrics.id`, `campaigns.id`, `test_rounds.id`, `test_round_variants.id`, `published_ads.id`, `pipeline_executions.id`, `visual_elements.id`, `hypotheses.id`, `funnels.id`, `alerts.id`, `crm_leads.crm_id`, `lead_qualification_rules.id`, `prompts.id`, `publication_batches.id`, `publication_steps.id`, `ad_blueprints.id`, `blueprint_versions.id`.

**O que NÃO migra (continua TEXT):**

IDs externos que não controlamos:
- `meta_campaign_id`, `meta_account_id`, `meta_ad_id`, `meta_adset_id`, `meta_creative_id`, `meta_image_hash` — IDs da Meta API
- `pixel_id`, `page_id`, `instagram_user_id` — IDs da Meta
- `google_id`, `drive_file_id` — IDs do Google
- `key_hash`, `key_prefix` — hashes de API keys
- `token_encrypted`, `oauth_tokens` — tokens criptografados
- `utm_*`, `fbclid` — UTMs de tracking

**Estratégia de migração:**

Como estamos fazendo pg_dump → database novo, os schemas Drizzle já nascem com `uuid` desde o início. O script de importação converte os IDs antigos:

```typescript
// Script de conversão durante import
import { v5 as uuidv5 } from 'uuid';

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

// Converte TEXT id antigo para UUID determinístico (reproduzível)
function migrateId(oldId: string): string {
  // Se já é UUID válido, manter
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oldId)) {
    return oldId;
  }
  // Gera UUID v5 determinístico a partir do ID antigo
  return uuidv5(oldId, NAMESPACE);
}
```

**Por que UUIDv5 e não UUIDv4 aleatório:** UUIDv5 é determinístico — o mesmo `oldId` sempre gera o mesmo UUID. Isso permite rodar o script múltiplas vezes sem quebrar FKs, e permite referenciar IDs antigos em logs/debug.

---

## 4. Migração de Database Engine

### 4.1 Topologia

```
┌─────────────────────────────────────────┐
│     VPS — alpes-ads_supabase cluster    │
│                                          │
│  ┌─────────────────────────────────┐    │
│  │  Postgres 16 (porta 5432)       │    │
│  │                                  │    │
│  │  database: pegasus_crm  ←─ CRM  │    │
│  │  database: pegasus_ads  ←─ ADS  │    │ ← NOVO
│  │                                  │    │
│  │  auth (gotrue) ←─ compartilhado  │    │
│  └──────────┬───────────────────────┘    │
│             │                            │
│  ┌──────────▼───────────────────────┐    │
│  │  Supavisor (porta configurável)  │    │
│  │  pool_mode = transaction         │    │
│  └──────────────────────────────────┘    │
│                                          │
│  ┌──────────────────────────────────┐    │
│  │  gotrue (Auth) — compartilhado   │    │
│  │  auth.users, auth.sessions, etc  │    │
│  └──────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

### 4.2 Passos de criação

```sql
-- 1. Criar database separado
CREATE DATABASE pegasus_ads OWNER supabase_admin;

-- 2. Criar role da aplicação
CREATE ROLE pegasus_ads_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE pegasus_ads TO pegasus_ads_app;

-- 3. Dentro de pegasus_ads:
\c pegasus_ads
GRANT USAGE ON SCHEMA public TO pegasus_ads_app;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pegasus_ads_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pegasus_ads_app;

-- 4. Supavisor: adicionar tenant pegasus_ads
-- Executar no container alpes-ads_supabase-supavisor-1:
-- (endpoint de tenants via API HTTP ou SQL direto no _supavisor db)
-- ver scripts/phase-1b-supavisor-tenant.sh
```

### 4.3 Connection string

```
# Direto (para migrations)
DATABASE_URL=postgresql://pegasus_ads_app:***@localhost:5432/pegasus_ads

# Via Supavisor (para aplicação — transaction mode)
DATABASE_URL=postgresql://pegasus_ads_app.pegasus_ads:***@alpes-ads_supabase-supavisor:6543/pegasus_ads
```

### 4.4 Dual client (padrão CRM, com RLS)

```typescript
// src/lib/db/index.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

// App client — RLS enforced
// Usa role pegasus_ads_app (com RLS policies ativas)
// O workspace_id é injetado via SET LOCAL em cada transação
const appConnection = postgres(process.env.DATABASE_URL!, {
  prepare: false,  // Supavisor transaction mode
  max: 10,
});
export const db = drizzle(appConnection, { schema });

// Admin client — BYPASSRLS
// Usa role pegasus_ads_admin (BYPASSRLS) para:
// - System ops (crons, migrations, seed)
// - Cross-workspace queries (relatórios, admin panel)
// - Operações que não têm contexto de workspace
const adminConnection = postgres(process.env.DATABASE_URL_ADMIN!, {
  prepare: false,
  max: 3,
});
export const dbAdmin = drizzle(adminConnection, { schema });

// Helper: executa query com RLS scoped ao workspace
export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: typeof db) => Promise<T>
): Promise<T> {
  return db.transaction(async (tx) => {
    // SET LOCAL só vale dentro da transação
    await tx.execute(sql`SET LOCAL app.workspace_id = ${workspaceId}`);
    return fn(tx as typeof db);
  });
}
```

### 4.5 Migração de dados

**Estratégia: pg_dump + pg_restore seletivo.**

```bash
# 1. Dump do Neon (schema + data)
pg_dump $NEON_URL --no-owner --no-acl --format=custom -f pegasus_ads_dump.backup

# 2. Restore no novo database
pg_restore -d pegasus_ads -U supabase_admin --no-owner pegasus_ads_dump.backup

# 3. Verificação
psql pegasus_ads -c "SELECT tablename, n_live_tup FROM pg_stat_user_tables ORDER BY tablename;"
```

**Tabelas que NÃO migram:**

- `users` → dados migram para `auth.users` (ver seção 5)
- `sessions` → descartadas (Supabase Auth gerencia)

### 4.6 Rollback

Se a migração falhar antes do cutover:

1. A aplicação continua apontando para Neon (env `DATABASE_URL` original).
2. O database `pegasus_ads` no Supabase pode ser dropado sem afetar o CRM.
3. Nenhum dado foi alterado no Neon.

---

## 5. Row-Level Security (RLS)

### 5.1 Por que RLS

O Pegasus Ads é multi-tenant — 6 clientes hoje, 11+ em 6 meses. Atualmente, **cada uma das 84 rotas API** é responsável por filtrar `WHERE workspace_id = ?` manualmente. Isso é:

1. **Frágil:** Basta esquecer o filtro em 1 das 84 rotas e os dados de um cliente vazam para outro.
2. **Custoso em code review:** Todo PR precisa auditar se o WHERE está presente.
3. **Verboso:** Cada query repete o mesmo filtro.

Com RLS, o Postgres **recusa retornar rows** de outro workspace independente da query. A segurança multi-tenant sai do código da aplicação (84 pontos de falha) e vai para o banco (1 ponto de configuração por tabela).

**Benefício adicional:** Menos código nas rotas. O `WHERE workspace_id = ?` desaparece de todas as queries — o Postgres injeta o filtro automaticamente. Delegamos a responsabilidade para o Supabase/Postgres gerenciar.

### 5.2 Arquitetura RLS

```
┌─────────────────────────────────────────────────────────┐
│  Request HTTP                                           │
│                                                         │
│  1. Middleware extrai workspace_id (session ou API key)  │
│  2. Route handler chama withWorkspace(workspaceId, ...)  │
│  3. withWorkspace() faz SET LOCAL app.workspace_id       │
│  4. Todas as queries dentro da transação são filtradas   │
│     automaticamente pelo RLS policy                      │
│                                                         │
│  ┌───────────────────────────────────────────┐          │
│  │  Postgres (RLS ativo)                     │          │
│  │                                            │          │
│  │  current_setting('app.workspace_id')       │          │
│  │  ↓                                         │          │
│  │  Policy: workspace_id = current_setting()  │          │
│  │  ↓                                         │          │
│  │  Rows filtradas automaticamente            │          │
│  └───────────────────────────────────────────┘          │
│                                                         │
│  Exceções (usam dbAdmin, BYPASSRLS):                    │
│  - Crons (métricas, kill rules) — cross-workspace       │
│  - Admin panel — relatórios agregados                    │
│  - Migrations e seeds                                    │
└─────────────────────────────────────────────────────────┘
```

### 5.3 Roles no Postgres

```sql
-- Role da aplicação (RLS enforced)
CREATE ROLE pegasus_ads_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE pegasus_ads TO pegasus_ads_app;
GRANT USAGE ON SCHEMA public TO pegasus_ads_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pegasus_ads_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pegasus_ads_app;

-- Role admin (BYPASSRLS para system ops)
CREATE ROLE pegasus_ads_admin LOGIN PASSWORD '...' BYPASSRLS;
GRANT CONNECT ON DATABASE pegasus_ads TO pegasus_ads_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO pegasus_ads_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO pegasus_ads_admin;
```

### 5.4 Policies RLS

**Policy padrão** — aplicada a TODAS as tabelas que têm `workspace_id`:

```sql
-- Template (repetido para cada tabela com workspace_id)
ALTER TABLE creatives ENABLE ROW LEVEL SECURITY;
ALTER TABLE creatives FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_isolation ON creatives
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
```

**Tabelas com RLS (19 tabelas):**

`workspaces`, `workspace_members`, `workspace_settings`, `workspace_meta_accounts`, `api_keys`, `images`, `creatives`, `creative_edges`¹, `creative_ref_images`¹, `metrics`, `metrics_breakdowns`, `metrics_demographics`, `campaigns`, `funnels`, `test_rounds`, `test_round_variants`, `published_ads`, `pipeline_executions`, `alerts`, `visual_elements`, `hypotheses`, `crm_leads`, `lead_qualification_rules`, `publication_batches`, `publication_steps`

¹ `creative_edges` e `creative_ref_images` não têm `workspace_id` próprio — o RLS é enforced via JOIN com `creatives`. Alternativa: adicionar `workspace_id` redundante nessas tabelas para evitar o JOIN no policy. **Recomendação: adicionar `workspace_id` redundante** — é mais performante e mais simples.

**Tabelas SEM RLS (3 tabelas):**

- `plans` — dados globais (seed), não são multi-tenant
- `settings` — config global legada (será mergeada com `workspace_settings`)
- `prompts` — histórico de prompts (avaliar se deve ganhar `workspace_id`)

### 5.5 Helper `withWorkspace`

```typescript
// Uso nas rotas API
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // Todas as queries dentro deste bloco são automaticamente
  // filtradas pelo workspace do usuário autenticado
  return withWorkspace(auth.workspace_id, async (db) => {
    // Não precisa de WHERE workspace_id = ? aqui!
    const creatives = await db
      .select()
      .from(creativesTable)
      .where(eq(creativesTable.status, 'generated'));

    return NextResponse.json(creatives);
  });
}
```

**Antes (sem RLS):**
```typescript
const creatives = await db.select().from(creativesTable)
  .where(and(
    eq(creativesTable.workspaceId, auth.workspace_id),  // fácil de esquecer
    eq(creativesTable.status, 'generated')
  ));
```

**Depois (com RLS):**
```typescript
return withWorkspace(auth.workspace_id, async (db) => {
  const creatives = await db.select().from(creativesTable)
    .where(eq(creativesTable.status, 'generated'));
  // workspace_id filtrado automaticamente pelo Postgres
});
```

### 5.6 Crons e system ops (dbAdmin)

Operações que precisam de acesso cross-workspace usam `dbAdmin` (role com BYPASSRLS):

```typescript
// Cron de kill rules — precisa avaliar TODOS os workspaces
import { dbAdmin } from '@/lib/db';

export async function runKillRules() {
  // dbAdmin bypassa RLS — acessa todas as rows
  const activeAds = await dbAdmin
    .select()
    .from(publishedAdsTable)
    .where(eq(publishedAdsTable.status, 'active'));

  // ...
}
```

### 5.7 Migration script para habilitar RLS

```sql
-- Script único: habilita RLS + cria policy em todas as tabelas com workspace_id
DO $$
DECLARE
  tbl TEXT;
  tables_with_ws TEXT[] := ARRAY[
    'workspaces', 'workspace_members', 'workspace_settings',
    'workspace_meta_accounts', 'api_keys', 'images', 'creatives',
    'metrics', 'metrics_breakdowns', 'metrics_demographics',
    'campaigns', 'funnels', 'test_rounds', 'test_round_variants',
    'published_ads', 'pipeline_executions', 'alerts',
    'visual_elements', 'hypotheses', 'crm_leads',
    'lead_qualification_rules', 'publication_batches', 'publication_steps',
    'creative_edges', 'creative_ref_images'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables_with_ws LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I
        USING (workspace_id::text = current_setting(''app.workspace_id'', true))
        WITH CHECK (workspace_id::text = current_setting(''app.workspace_id'', true))',
      tbl
    );
  END LOOP;
END $$;
```

### 5.8 Contraditório: RLS + Supavisor transaction mode

**Problema potencial:** `SET LOCAL` só persiste dentro de uma transação. Com Supavisor em `transaction mode`, cada statement pode ir para uma conexão diferente. Se a query não estiver dentro de uma transação explícita, o `SET LOCAL` se perde.

**Solução:** O helper `withWorkspace()` usa `db.transaction()` que garante que o `SET LOCAL` e todas as queries subsequentes rodam na mesma conexão. **PONTO DE ATENÇÃO v1.4:** a premissa de que "CRM validou esse padrão com o mesmo pooler" precisa ser re-confirmada, porque o CRM em prod ainda usa conexão direta (não passa pelo Supavisor). Validação empírica é pré-requisito da Fase 1B.

**Ponto de atenção:** Queries fora de `withWorkspace()` usando a role `pegasus_ads_app` receberão **zero rows** (porque `app.workspace_id` não está setado e o policy retorna false). Isso é uma feature, não um bug — funciona como fail-safe.

---

## 6. Migração de Auth

### 6.1 Estado atual

```
Pegasus Ads:
  users (id, email, name, password_hash, google_id)
  sessions (token, user_id, workspace_id, expires_at)
  → Cookie: pegasus_session (httpOnly, 30 dias)
  → API: x-api-key header (SHA-256 hash em api_keys)
  → Legacy: TEST_LOG_API_KEY env var
```

### 6.2 Estado alvo

```
Supabase Auth (gotrue compartilhado):
  auth.users (id UUID, email, encrypted_password, ...)
  auth.sessions (gerenciadas automaticamente)
  → Cookie: sb-*-auth-token (gerenciado por @supabase/ssr)
  → API Keys: Mantidas na tabela api_keys do Pegasus (não migram para gotrue)
  → Legacy: TEST_LOG_API_KEY mantida temporariamente
```

### 6.3 Migração de usuários existentes

**Problema:** Os user IDs do Pegasus são `TEXT` (gerados pela aplicação). Os IDs do Supabase Auth são `UUID`. Toda tabela que referencia `user_id` precisa ser atualizada.

**Estratégia:**

1. Para cada user no Pegasus, criar conta no Supabase Auth via Admin API (`supabase.auth.admin.createUser`).
2. Mapear `old_id → new_uuid` numa tabela temporária.
3. Atualizar `workspace_members.user_id` e `api_keys.user_id` com os novos UUIDs.
4. Remover tabelas `users` e `sessions`.

```typescript
// Script de migração
const userMapping = new Map<string, string>(); // old_id → supabase_uuid

for (const user of existingUsers) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: user.email,
    password: undefined,  // Force password reset on first login
    email_confirm: true,
    user_metadata: {
      name: user.name,
      avatar_url: user.avatar_url,
      migrated_from: 'pegasus_ads',
      old_id: user.id,
    },
  });
  if (data.user) {
    userMapping.set(user.id, data.user.id);
  }
}

// Update FKs
for (const [oldId, newId] of userMapping) {
  await db.execute(sql`UPDATE workspace_members SET user_id = ${newId} WHERE user_id = ${oldId}`);
  await db.execute(sql`UPDATE api_keys SET user_id = ${newId} WHERE user_id = ${oldId}`);
}
```

**Contraditório:** Forçar password reset pode causar atrito. Alternativa: usar `bcrypt` já existente — se o hash format for compatível com gotrue (`$2a$` ou `$2b$`), é possível importar diretamente via `supabase.auth.admin.createUser({ password_hash })`. Verificar se gotrue aceita o format antes de decidir.

### 6.4 Middleware (padrão CRM)

```typescript
// src/middleware.ts
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (cookies) => {
          cookies.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    }
  );

  // Refresh session (critical for server components)
  await supabase.auth.getUser();

  return response;
}
```

### 6.5 Auth helpers (padrão CRM)

```typescript
// src/lib/auth/helpers.ts
export async function requireAuth(): Promise<AuthContext> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Discover workspace membership
  const membership = await dbAdmin
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, user.id))
    .limit(1);

  if (!membership.length) redirect('/onboarding');

  return {
    user_id: user.id,
    workspace_id: membership[0].workspaceId,
    role: membership[0].role,
    auth_method: 'session',
  };
}
```

### 6.6 API Key auth (mantida)

O sistema de API keys (`api_keys` table, header `x-api-key`) é específico do Pegasus e não migra para gotrue. O fluxo de autenticação fica:

1. Tentar Supabase session (cookie).
2. Se não, tentar `x-api-key` header (tabela `api_keys`).
3. Se não, tentar `TEST_LOG_API_KEY` env (legacy, deprecar em 90 dias).

### 6.7 Rollback

- O middleware antigo (`pegasus_session` cookie) pode ser reativado alterando uma env flag.
- Tabelas `users` e `sessions` ficam como backup por 30 dias antes de serem dropadas.

---

## 7. Migração de Design System

### 7.1 Estado atual

- **CSS custom:** 162 linhas em `globals.css` com variáveis hex (`--bg-primary: #06090f`, etc).
- **Componentes custom:** `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.glass`, `.glow-blue`.
- **GSAP:** Animações em sidebar e nav (hover effects, transitions).
- **Ícones:** SVG inline hardcoded no Sidebar.tsx (~454 linhas).
- **Tema:** Dark-only, sem toggle.

### 7.2 Estado alvo (espelhado do CRM)

- **shadcn/ui v4** com style `base-nova`, baseColor `neutral`, Tailwind 4 CSS vars.
- **OKLCH color system** com Light + Dark + System themes.
- **lucide-react** para ícones.
- **Zustand** para tema e sidebar state.
- **Sem GSAP** — transições via Tailwind `transition-*` e CSS.

### 7.3 components.json (do CRM, para o Ads)

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-nova",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

### 7.4 Plano de substituição de componentes

| Componente Ads (atual) | Substituto shadcn | Ação |
|---|---|---|
| `.btn` / `.btn-primary` | `<Button variant="default">` | Remover CSS custom, usar cva variants |
| `.btn-ghost` | `<Button variant="ghost">` | Direto |
| `.btn-danger` | `<Button variant="destructive">` | Direto |
| `<input>` styles em CSS | `<Input>` shadcn | Instalar componente |
| Custom modal (se existir) | `<Dialog>` / `<AlertDialog>` | Instalar componente |
| Custom dropdown | `<DropdownMenu>` | Instalar componente |
| Custom select | `<Select>` | Instalar componente |
| Custom tabs | `<Tabs>` | Instalar componente |
| SVG inline icons | `lucide-react` | Mapear ícone por ícone |
| GSAP sidebar | `sidebar-transition` CSS + Zustand | Remover dep GSAP |
| GSAP nav hover | `hover:bg-*` Tailwind | Remover dep GSAP |
| Dark-only theme | OKLCH Light/Dark/System | Copiar `globals.css` do CRM |
| Custom toast | `<Toaster>` (sonner) | Instalar |

### 7.5 globals.css alvo

A ser copiada do CRM com as seguintes adaptações:
- Accent color: manter azul Pegasus (`--accent: oklch(0.62 0.22 264)` ≈ `#3b82f6`) em vez do amber do CRM.
- Sidebar tokens: manter largura e comportamento do Pegasus.

### 7.6 Rollback

- CSS custom fica no git history.
- Feature flag `USE_SHADCN=true|false` pode controlar qual Sidebar/Header renderiza durante a transição.

---

## 8. Observabilidade

### 8.1 Pino logger (do CRM)

```typescript
// src/lib/observability/logger.ts
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['password', 'password_hash', 'token', 'api_key', '*.authorization', '*.cookie'],
    censor: '[REDACTED]',
  },
  transport: process.env.NODE_ENV === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
```

### 8.2 Prometheus metrics (do CRM)

```typescript
// src/lib/observability/metrics.ts
import { Registry, Histogram, Counter } from 'prom-client';

export const registry = new Registry();

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5],
  registers: [registry],
});

export const metaApiDuration = new Histogram({
  name: 'meta_api_duration_seconds',
  help: 'Duration of Meta API calls in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Duration of background jobs',
  labelNames: ['job_type', 'status'],
  registers: [registry],
});
```

Histograma `metaApiDuration` é novo (específico do Ads, não existe no CRM) — essencial para monitorar latência e rate limits da Meta API.

### 8.3 Sentry

```bash
npx @sentry/wizard@latest -i nextjs
```

Config idêntica ao CRM, com `dsn` do projeto Pegasus Ads.

### 8.4 Rollback

Observabilidade é aditiva — não quebra funcionalidade existente. Sem necessidade de rollback.

---

## 9. Testes e CI/CD

### 9.1 Vitest (do CRM)

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/schema/**'],
    },
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

### 9.2 GitHub Actions CI

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npx tsc --noEmit
      - run: npx vitest run --coverage
      - run: npm run build
```

### 9.3 Prioridade de testes

1. **Meta Adapter (ACL):** Testes unitários com mocks da Meta API — validar parsing de respostas, classificação de erros, rate limit handling.
2. **State Machine:** Testes de transições válidas e inválidas.
3. **Auth helpers:** Testes de `requireAuth`, API key validation.
4. **Kill rules:** Lógica de decisão com dados de teste.

### 9.4 Rollback

Aditivo — não quebra funcionalidade existente.

---

## 10. Dependências a Adicionar / Remover

### 9.1 Adicionar

```json
{
  "dependencies": {
    "@supabase/ssr": "^0.7",
    "@supabase/supabase-js": "^2.49",
    "drizzle-orm": "^0.45",
    "postgres": "^3.4",
    "pino": "^9",
    "prom-client": "^15",
    "@sentry/nextjs": "^9",
    "lucide-react": "^0.500",
    "sonner": "^2",
    "class-variance-authority": "^0.7",
    "clsx": "^2",
    "tailwind-merge": "^3",
    "zod": "^4"
  },
  "devDependencies": {
    "drizzle-kit": "^0.31",
    "vitest": "^3",
    "@vitejs/plugin-react": "^4",
    "jsdom": "^26",
    "pino-pretty": "^13",
    "@types/node": "^22"
  }
}
```

### 9.2 Remover

```json
{
  "remove": {
    "@neondatabase/serverless": "substituído por postgres (driver)",
    "@vercel/blob": "substituído por Supabase Storage",
    "gsap": "substituído por Tailwind transitions",
    "bcrypt": "substituído por Supabase Auth (gotrue)"
  }
}
```

---

## 11. Storage (Vercel Blob → Supabase Storage)

### 10.1 Contexto

O Pegasus usa `@vercel/blob` para armazenar imagens geradas. Com a saída do Vercel (2026-04-10), os blobs existentes ainda estão acessíveis mas a dependência deve ser removida.

### 10.2 Estratégia

1. Criar bucket `pegasus-ads-images` no Supabase Storage (mesmo cluster).
2. Script de migração: download de cada `blob_url` → upload para Supabase Storage → update da referência no banco.
3. Manter `blob_url` original como `legacy_blob_url` por 60 dias.
4. Novos uploads vão direto para Supabase Storage.

### 10.3 Rollback

URLs do Vercel Blob continuam funcionando (enquanto a conta existir). O campo `legacy_blob_url` permite reverter.

---

## 12. Integração com Staging Queue (v1.5)

### 11.1 Novas tabelas no schema Drizzle

As tabelas da arquitetura de staging queue (v1.5) já devem ser criadas como schemas Drizzle desde a Fase 2 (ORM):

- `publication_batches` → `src/lib/db/schema/publishing.ts`
- `publication_steps` → `src/lib/db/schema/publishing.ts`
- `step_dependencies` → `src/lib/db/schema/publishing.ts`
- `step_events` → `src/lib/db/schema/publishing.ts`
- `ad_blueprints` → `src/lib/db/schema/blueprints.ts`
- `blueprint_versions` → `src/lib/db/schema/blueprints.ts`

### 11.2 Sequência

A implementação da staging queue (Saga, ACL, State Machine, Worker) é um projeto de feature, não de migração. Mas os schemas devem existir desde a fase de ORM para evitar migration adicional depois.

A feature em si será implementada APÓS as fases de migração, quando a base estiver estável em Drizzle + Supabase.

---

## 13. Importação de Campanhas do Meta Ads

### 13.1 Objetivo

Permitir importar campanhas, ad sets, ads, criativos e insights do Meta Ads Manager para o Pegasus. Isso dá visibilidade sobre tudo que está rodando (não apenas o que o Pegasus criou) e permite usar ads existentes como modelo (Ad Blueprint) para novas publicações.

### 13.2 Fluxo do usuário

```
┌─────────────────────────────────────────────────────────┐
│  1. Usuário clica em "Importar Campanhas"               │
│                                                         │
│  2. Modal/página de importação:                         │
│     ┌─────────────────────────────────────────────┐     │
│     │  Conta Meta: [dropdown das contas do WS]    │     │
│     │                                              │     │
│     │  Janela de criação: [últimos __ dias]        │     │
│     │                      (default: 30, max: 540) │     │
│     │                                              │     │
│     │  Filtro de nome: [__________________]        │     │
│     │    (campanha CONTÉM este texto)               │     │
│     │                                              │     │
│     │  Janela de insights: [últimos __ dias]       │     │
│     │                       (default: 7)           │     │
│     │                                              │     │
│     │  [Buscar campanhas]                          │     │
│     └─────────────────────────────────────────────┘     │
│                                                         │
│  3. Preview das campanhas encontradas:                  │
│     ┌─────────────────────────────────────────────┐     │
│     │  ☑ RAT T7 — Ebook Capilar (5 ad sets, 23   │     │
│     │    ads)                                      │     │
│     │  ☑ RAT T7 — Interesse (3 ad sets, 12 ads)  │     │
│     │  ☐ Teste interno (1 ad set, 2 ads)          │     │
│     │                                              │     │
│     │  Total: 8 ad sets, 35 ads                    │     │
│     │  Estimativa: ~2h para importação completa    │     │
│     │                                              │     │
│     │  [Importar selecionadas]                     │     │
│     └─────────────────────────────────────────────┘     │
│                                                         │
│  4. Job assíncrono inicia. Progress bar na UI.          │
│     Estágio 1/4: Estrutura ████████████████ 100%        │
│     Estágio 2/4: Imagens   ████████░░░░░░░  52%        │
│     Estágio 3/4: Vídeos    ░░░░░░░░░░░░░░░   0%        │
│     Estágio 4/4: Insights  ░░░░░░░░░░░░░░░   0%        │
└─────────────────────────────────────────────────────────┘
```

### 13.3 Pipeline de importação — 4 estágios

A importação é um job assíncrono com 4 estágios sequenciais. Cada estágio tem prioridade inferior à publicação de novos ads (o worker checa se há jobs de publicação pendentes antes de processar o próximo item de importação).

#### Regras globais

- **Ordem:** Sempre do mais recente para o mais antigo (`created_time DESC`). Os ads mais recentes têm mais valor operacional — se a importação for interrompida, os mais relevantes já foram processados.
- **Janela máxima:** 540 dias. Hardcoded no backend — a UI valida, mas o backend também rejeita valores > 540. Razão: a Meta pode não retornar dados confiáveis de campanhas muito antigas, e o volume de chamadas fica impraticável.

#### Estágio 1 — Estrutura (rápido, minutos)

Chamadas leves à Meta API. Intervalo padrão de 2 segundos entre chamadas.

```
1.1  GET /{account_id}/campaigns
       ?filtering=[{field:"name", operator:"CONTAIN", value:"{filtro}"}]
       &time_range={"since":"{data_inicio}","until":"{hoje}"}
       &fields=id,name,objective,status,created_time,
               daily_budget,lifetime_budget,
               bid_strategy,buying_type
     → Upsert em `campaigns` (by meta_campaign_id)

1.2  Para cada campanha:
     GET /{campaign_id}/adsets
       &fields=id,name,status,targeting,
               optimization_goal,billing_event,
               bid_amount,daily_budget,lifetime_budget,
               promoted_object,attribution_spec,
               created_time
     → Upsert em `ad_sets` (by meta_adset_id)

1.3  Para cada ad set:
     GET /{adset_id}/ads
       &fields=id,name,status,creative{id,name,
               title,body,image_hash,image_url,
               video_id,thumbnail_url,
               object_story_spec,asset_feed_spec,
               call_to_action_type,url_tags},
               preview_shareable_link,
               created_time
     → Upsert em `creatives` (origin='imported', by meta_ad_id)
     → Upsert em `published_ads` (link entre ad set e creative)
```

**Ao final do estágio 1:** o Pegasus conhece toda a estrutura. O inventário de assets (quantas imagens, quantos vídeos) é calculado para dimensionar os estágios seguintes.

#### Estágio 2 — Imagens (lento, adaptativo)

Download das imagens dos criativos e upload para Supabase Storage.

```
Para cada creative com image_url e sem blob_url local:
  2.1  GET image_url (download)
  2.2  Upload para Supabase Storage (bucket pegasus-ads-images)
  2.3  Update creative.blob_url com URL do Supabase
  
  Intervalo: calculado adaptativamente (seção 13.4)
```

#### Estágio 3 — Vídeos (lento, adaptativo)

Download dos vídeos e upload para Supabase Storage.

```
Para cada creative com video_id e sem video_blob_url local:
  3.1  GET /{video_id}?fields=source (URL de download)
  3.2  Download do vídeo
  3.3  Upload para Supabase Storage (bucket pegasus-ads-videos)
  3.4  Update creative.video_blob_url com URL do Supabase

  Intervalo: calculado adaptativamente (seção 13.4)
  Floor: 60 segundos (vídeos são pesados)
```

#### Estágio 4 — Insights (lento, adaptativo)

Métricas por ad, usando a mesma janela de dias definida pelo usuário.

```
Para cada ad importado:
  4.1  GET /{ad_id}/insights
         ?time_range={"since":"{data_inicio}","until":"{hoje}"}
         &time_increment=1  (diário)
         &fields=spend,impressions,cpm,ctr,clicks,cpc,
                 actions,cost_per_action_type
  4.2  Parse actions[] para extrair leads (action_type='lead')
  4.3  Upsert em `metrics` (by creative_id + date)
  4.4  GET com breakdown=publisher_platform,platform_position
  4.5  Upsert em `metrics_breakdowns`

  Intervalo: calculado adaptativamente (seção 13.4)
```

### 13.4 Rate limiting adaptativo — janela de 4 horas

O rate limiting não usa intervalo fixo. Após o estágio 1 (estrutura), o sistema conhece o inventário total e calcula o intervalo ideal para distribuir as chamadas em ~4 horas.

```typescript
interface ImportThrottleConfig {
  targetDurationSeconds: 4 * 60 * 60;  // 4 horas
  minIntervalSeconds: 30;               // floor: nunca menos que 30s
  maxIntervalSeconds: 300;              // ceiling: nunca mais que 5 min
  videoMinIntervalSeconds: 60;           // vídeos: floor mais alto
}

function calculateInterval(
  totalCalls: number,
  config: ImportThrottleConfig,
  isVideo: boolean = false
): number {
  const rawInterval = config.targetDurationSeconds / totalCalls;
  const floor = isVideo ? config.videoMinIntervalSeconds : config.minIntervalSeconds;
  
  return Math.min(
    config.maxIntervalSeconds,
    Math.max(floor, Math.round(rawInterval))
  );
}

// Exemplos:
// 47 imagens:  14400 / 47 = 306s (~5 min) → usa 300s (ceiling)
// 200 insights: 14400 / 200 = 72s → usa 72s
// 500 insights: 14400 / 500 = 28.8s → usa 30s (floor), total ~4.2h
// 10 vídeos:  14400 / 10 = 1440s → usa 300s (ceiling), total ~50 min
```

**Comportamento quando excede 4 horas:** Se o volume é grande (>480 chamadas com floor de 30s = 4h), o job simplesmente leva mais tempo. A janela de 4h é um *target*, não um deadline rígido. O constraint real é o floor de 30s — garantia de que não estressamos o rate limit.

**Prioridade vs. publicação:** Antes de cada chamada de importação, o worker verifica se há jobs de publicação pendentes. Se houver, a importação entra em pausa até que os jobs de publicação terminem. Publicar é sempre mais urgente que importar histórico.

```typescript
async function importWithPriority(item: ImportItem): Promise<void> {
  // Pausa se há publicação pendente
  while (await hasPendingPublicationJobs()) {
    logger.info('Import paused — publication job has priority');
    await sleep(60_000);  // Re-check a cada 1 min
  }
  
  // Executa a chamada de importação
  await processImportItem(item);
  
  // Espera o intervalo calculado
  await sleep(item.intervalMs);
}
```

### 13.5 Schema: tabela `ad_sets` (nova)

```typescript
// src/lib/db/schema/campaigns.ts

export const adSets = pgTable('ad_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  
  // Meta IDs
  metaAdsetId: text('meta_adset_id').notNull(),
  metaAccountId: text('meta_account_id').notNull(),
  
  // Config
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'paused', 'deleted', 'archived'] }).default('active'),
  optimizationGoal: text('optimization_goal'),       // LEAD_GENERATION, REACH, etc.
  billingEvent: text('billing_event'),               // IMPRESSIONS, CLICKS, etc.
  bidStrategy: text('bid_strategy'),                 // LOWEST_COST_WITHOUT_CAP, etc.
  bidAmount: integer('bid_amount'),                  // Em centavos
  dailyBudget: integer('daily_budget'),              // Em centavos
  lifetimeBudget: integer('lifetime_budget'),        // Em centavos
  
  // Targeting (JSON completo do Meta)
  targeting: jsonb('targeting').default({}),
  
  // Promoted object
  promotedObject: jsonb('promoted_object').default({}),
  
  // Attribution
  attributionSpec: jsonb('attribution_spec').default({}),
  
  // Origin
  origin: text('origin', { enum: ['created', 'imported'] }).default('created'),
  
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  metaCreatedTime: timestamp('meta_created_time', { withTimezone: true }),
}, (t) => [
  uniqueIndex('idx_adsets_meta').on(t.workspaceId, t.metaAdsetId),
]);
```

### 13.6 Schema: alterações em `creatives`

```typescript
// Colunas adicionadas à tabela creatives

origin: text('origin', { enum: ['generated', 'imported'] }).default('generated'),

// Creative spec completo importado do Meta (apenas para origin='imported')
metaCreativeSpec: jsonb('meta_creative_spec'),

// Preview do ad no Instagram (link direto para a publicação)
instagramPermalink: text('instagram_permalink'),

// URL da imagem de preview do Meta (thumbnail rápido)
metaPreviewUrl: text('meta_preview_url'),

// Blob URL do vídeo no Supabase Storage (se vídeo)
videoBlobUrl: text('video_blob_url'),
```

### 13.7 Schema: `import_jobs` e `import_job_items`

```typescript
// src/lib/db/schema/imports.ts

export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  metaAccountId: text('meta_account_id').notNull(),
  
  // Filtros do usuário
  filterNameContains: text('filter_name_contains'),
  filterDaysWindow: integer('filter_days_window').notNull().default(30),  // max: 540
  insightsDaysWindow: integer('insights_days_window').notNull().default(7),  // mesma janela do filtro
  
  // Estágio atual
  stage: text('stage', {
    enum: ['pending', 'structure', 'images', 'videos', 'insights', 'completed', 'failed', 'cancelled']
  }).default('pending'),
  
  // Inventário (preenchido após estágio 1)
  campaignsFound: integer('campaigns_found').default(0),
  adSetsFound: integer('ad_sets_found').default(0),
  adsFound: integer('ads_found').default(0),
  totalImages: integer('total_images').default(0),
  totalVideos: integer('total_videos').default(0),
  totalInsightCalls: integer('total_insight_calls').default(0),
  
  // Intervalo calculado (seção 13.4)
  imageIntervalSeconds: integer('image_interval_seconds'),
  videoIntervalSeconds: integer('video_interval_seconds'),
  insightIntervalSeconds: integer('insight_interval_seconds'),
  
  // Progress
  itemsProcessed: integer('items_processed').default(0),
  itemsTotal: integer('items_total').default(0),
  
  // Timing
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  estimatedCompletionAt: timestamp('estimated_completion_at', { withTimezone: true }),
  
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const importJobItems = pgTable('import_job_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => importJobs.id, { onDelete: 'cascade' }),
  
  // O que importar
  itemType: text('item_type', {
    enum: ['campaign', 'adset', 'ad', 'image', 'video', 'insights']
  }).notNull(),
  metaEntityId: text('meta_entity_id').notNull(),
  
  // Status
  status: text('status', {
    enum: ['pending', 'processing', 'completed', 'failed', 'skipped']
  }).default('pending'),
  
  // Resultado
  localEntityId: uuid('local_entity_id'),  // ID no Pegasus após import
  errorMessage: text('error_message'),
  rawResponse: jsonb('raw_response'),
  
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
```

### 13.8 Instagram Permalink

Para obter o link direto da publicação no Instagram (não o preview do Ad Manager), usamos a Instagram Graph API:

```typescript
// Buscar permalink do post no Instagram
// O ad precisa ter sido publicado como post (não dark post)

// 1. Do ad object, extrair o instagram_post_id
// GET /{ad_id}?fields=creative{effective_instagram_media_id}

// 2. Com o media_id, buscar o permalink
// GET /{media_id}?fields=permalink,media_url,media_type,timestamp
// → permalink = "https://www.instagram.com/p/ABC123/"

async function getInstagramPermalink(
  adId: string,
  accessToken: string
): Promise<string | null> {
  // Step 1: Get effective_instagram_media_id from ad's creative
  const adResponse = await metaAdapter.getAdCreativeDetails(adId, [
    'creative{effective_instagram_media_id}'
  ]);
  
  const mediaId = adResponse.data?.creative?.effective_instagram_media_id;
  if (!mediaId) return null;  // Dark post ou não publicado no IG
  
  // Step 2: Get permalink from Instagram Graph API
  const mediaResponse = await fetch(
    `https://graph.facebook.com/v22.0/${mediaId}?fields=permalink&access_token=${accessToken}`
  );
  const media = await mediaResponse.json();
  
  return media.permalink || null;  
  // Ex: "https://www.instagram.com/p/DAx8y2345/"
}
```

**Na UI:** O campo `instagram_permalink` aparece como um botão/ícone do Instagram ao lado do creative. Ao clicar, abre em nova aba o post real no Instagram — a publicação como o público vê, não o preview técnico do Ad Manager.

**Limitação:** Dark posts (ads que não aparecem no feed do perfil) não têm `effective_instagram_media_id`. Nesses casos, o campo fica null e a UI mostra o `preview_shareable_link` do Meta como fallback.

### 13.9 Extração de prompt por IA (reverse prompt)

Para criativos importados (que não têm prompt de geração), a UI oferece um botão "Extrair prompt" que:

1. Envia a imagem do criativo para um modelo de visão (Gemini)
2. O modelo analisa a imagem e gera um prompt que permitiria recriar algo visualmente similar
3. O prompt extraído é salvo no campo `prompt` do creative

```typescript
// Endpoint: POST /api/creatives/{id}/extract-prompt

async function extractPrompt(creativeId: string): Promise<string> {
  const creative = await getCreative(creativeId);
  
  // Baixar imagem do Supabase Storage
  const imageBuffer = await downloadImage(creative.blobUrl);
  
  // Enviar para Gemini com prompt de extração
  const response = await gemini.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: 'image/png',
            data: imageBuffer.toString('base64'),
          }
        },
        {
          text: `Analise esta imagem de anúncio e gere um prompt detalhado que permitiria 
recriar uma imagem visualmente similar usando um modelo de geração de imagem.

O prompt deve incluir:
- Descrição da composição (layout, posicionamento dos elementos)
- Estilo visual (cores dominantes, paleta, contraste, iluminação)
- Elementos textuais (posição e estilo do texto, mas NÃO o conteúdo do texto)
- Elementos fotográficos (tipo de foto, ângulo, enquadramento)
- Background e overlays
- Tom geral (profissional, médico, urgente, educacional, etc.)

Formato: prompt em inglês, direto, sem introduções. Apenas o prompt.`
        }
      ]
    }]
  });
  
  const extractedPrompt = response.text();
  
  // Salvar no creative
  await db.update(creatives)
    .set({
      prompt: extractedPrompt,
      metadata: sql`jsonb_set(
        COALESCE(metadata, '{}'),
        '{prompt_extraction}',
        ${JSON.stringify({
          model: 'gemini-2.5-flash',
          extracted_at: new Date().toISOString(),
          source: 'reverse_engineering'
        })}
      )`
    })
    .where(eq(creatives.id, creativeId));
  
  return extractedPrompt;
}
```

**Na UI:**

```
┌─────────────────────────────────────────────────┐
│  AD042F — Ebook Capilar (importado)             │
│  ┌─────────────┐                                │
│  │             │  Status: active                 │
│  │  [imagem]   │  CPL: R$ 18,42                 │
│  │             │  Origem: importado              │
│  │             │                                 │
│  └─────────────┘                                │
│                                                  │
│  Prompt: (nenhum — criativo importado)           │
│  [🔍 Extrair prompt]  [📱 Ver no Instagram]     │
│                                                  │
│  Após extração:                                  │
│  Prompt: "Professional medical advertisement     │
│  with split layout: left side features a         │
│  confident female doctor in white coat..."       │
│  [✏️ Editar prompt]  [🔄 Re-extrair]            │
└─────────────────────────────────────────────────┘
```

### 13.10 Deduplicação e re-importação

Toda importação usa **upsert by meta_id**:

```typescript
// Campaigns: upsert by (workspace_id, meta_campaign_id)
// Ad sets:   upsert by (workspace_id, meta_adset_id)
// Ads:       upsert by (workspace_id, meta_ad_id)
// Metrics:   upsert by (creative_id, date)
// Breakdowns: upsert by (creative_id, date, publisher_platform, platform_position)
```

Re-importar uma campanha que já existe atualiza os campos (nome, status, targeting, budget) sem criar duplicatas. Métricas são somadas/atualizadas por data.

**Criativos já no Pegasus:** Se um ad importado tem o mesmo `meta_ad_id` que um ad já criado pelo Pegasus, o sistema detecta e faz merge — mantém o `origin='generated'` e complementa com dados do Meta que faltavam (como `instagram_permalink`).

### 13.11 Integração com Ad Blueprints

Criativos importados com boa performance podem ser promovidos a Ad Blueprint:

```
Creative importado (CPL < meta)
  → Botão "Criar Blueprint" na UI
  → Extrai story_spec_template do meta_creative_spec
  → Extrai targeting do ad_set associado
  → Gera ad_blueprint com version 1
  → Blueprint disponível para novas publicações via staging queue
```

Isso fecha o ciclo: **importar → analisar → promover a blueprint → replicar em novas campanhas**.

---

## 14. Fases de Execução

### FASE 0 — Preparação (1 dia)

**Objetivo:** Infraestrutura de database e tooling sem alterar a aplicação.

- [ ] Criar database `pegasus_ads` no cluster Supabase
- [ ] Criar roles `pegasus_ads_app` (RLS enforced) e `pegasus_ads_admin` (BYPASSRLS)
- [x] ~~Configurar PgBouncer para o novo database~~ → substituído por "Configurar tenant Supavisor" (Fase 1B — ver TD-002)
- [ ] Configurar Drizzle Kit (`drizzle.config.ts`)
- [ ] Instalar dependências novas (`drizzle-orm`, `postgres`, `drizzle-kit`)
- [ ] Gerar migration inicial (`drizzle-kit generate`) a partir dos schemas Drizzle
- [ ] Testar conexão e migration em ambiente de staging

**Risco:** Baixo. Nada muda na aplicação rodando.
**Rollback:** Dropar database `pegasus_ads`.

### FASE 1 — ORM + UUID Migration (3-5 dias)

**Objetivo:** Substituir `@neondatabase/serverless` por Drizzle + `postgres` driver, com PKs UUID nativas.

- [ ] Criar `src/lib/db/index.ts` com dual client (db + dbAdmin) e helper `withWorkspace()`
- [ ] Criar todos os schema files Drizzle com `uuid().primaryKey().defaultRandom()` (seção 3.1)
- [ ] Incluir schemas da staging queue v1.5
- [ ] `pg_dump` do Neon → script de conversão TEXT→UUID (UUIDv5 determinístico) → `pg_restore` no Supabase
- [ ] Validar integridade referencial pós-conversão (contagem de rows, FKs, orphans)
- [ ] Adicionar `workspace_id` em `creative_edges` e `creative_ref_images` (redundante, para RLS)
- [ ] Habilitar RLS + criar policies `workspace_isolation` em todas as tabelas com `workspace_id` (seção 5.7)
- [ ] Adaptar `getDb()` para retornar Drizzle client (manter interface `execute()` como adapter temporário)
- [ ] Migrar rotas API uma a uma (84 route files): raw SQL → Drizzle queries + `withWorkspace()` (remover WHERE workspace_id manual)
- [ ] Migrar crons e system ops para usar `dbAdmin` (BYPASSRLS)
- [ ] Validar cada rota migrada com teste manual
- [ ] Remover `@neondatabase/serverless` do `package.json`

**Risco:** Alto — afeta todas as 84 rotas API + conversão de PKs + RLS. Mitigação: UUIDv5 determinístico permite re-rodar conversão; `withWorkspace()` simplifica cada rota; queries sem contexto retornam zero rows (fail-safe).
**Rollback:** Reverter env `DATABASE_URL` para Neon (dados originais intactos). Database `pegasus_ads` pode ser recriado do zero.

### FASE 2 — Auth (2-3 dias)

**Objetivo:** Migrar de custom sessions para Supabase Auth.

- [ ] Instalar `@supabase/ssr` e `@supabase/supabase-js`
- [ ] Migrar usuários existentes para `auth.users` (script seção 6.3)
- [ ] Atualizar FKs (`workspace_members.user_id`, `api_keys.user_id`)
- [ ] Substituir middleware (seção 6.4)
- [ ] Substituir `requireAuth()` + integrar com `withWorkspace()` (seção 6.5)
- [ ] Atualizar login/register pages para usar Supabase Auth UI ou custom form com `supabase.auth.signInWithPassword`
- [ ] Manter API key auth como fallback (seção 6.6)
- [ ] Testar login, logout, session refresh, workspace switch
- [ ] Remover `bcrypt` do `package.json`
- [ ] Marcar tabelas `users` e `sessions` como deprecated (manter 30 dias)

**Risco:** Médio — afeta fluxo de login. Mitigação: feature flag para alternar entre auth systems.
**Rollback:** Reativar middleware antigo via env flag.

### FASE 3 — Design System (3-5 dias)

**Objetivo:** Substituir CSS custom + GSAP por shadcn/ui + OKLCH + lucide.

- [ ] Instalar shadcn/ui (`npx shadcn@latest init`)
- [ ] Copiar `components.json` do CRM (seção 7.3)
- [ ] Substituir `globals.css` por OKLCH theme (seção 7.5)
- [ ] Instalar componentes shadcn necessários: Button, Input, Select, Dialog, DropdownMenu, Tabs, Card, Badge, Tooltip, Toaster
- [ ] Refatorar Sidebar.tsx: remover GSAP, usar lucide icons, Zustand store
- [ ] Refatorar Header: adicionar theme toggle (Light/Dark/System)
- [ ] Migrar todos os `.btn-*` para `<Button>` shadcn
- [ ] Migrar inputs para `<Input>` shadcn
- [ ] Remover GSAP do `package.json`
- [ ] Validar todas as pages visualmente

**Risco:** Médio — afeta visual de toda a aplicação. Mitigação: feature flag `USE_SHADCN` durante transição.
**Rollback:** Git revert + restaurar `globals.css` e componentes antigos.

### FASE 4 — Observabilidade + Testes (2-3 dias)

**Objetivo:** Adicionar logging estruturado, métricas, error tracking e testes.

- [ ] Portar Pino logger do CRM (seção 8.1)
- [ ] Portar Prometheus metrics do CRM + `metaApiDuration` (seção 8.2)
- [ ] Configurar Sentry (seção 8.3)
- [ ] Configurar Vitest (seção 9.1)
- [ ] Configurar GitHub Actions CI (seção 9.2)
- [ ] Escrever testes prioritários — incluir testes de RLS (seção 9.3)
- [ ] Substituir `console.log` por `logger.*` em todas as rotas

**Risco:** Baixo — aditivo, não quebra funcionalidade.
**Rollback:** Desnecessário.

### FASE 5 — Storage + Cleanup (1-2 dias)

**Objetivo:** Migrar Vercel Blob, remover deps legadas, cleanup final.

- [ ] Criar bucket Supabase Storage
- [ ] Script de migração de blobs (seção 10.2)
- [ ] Atualizar upload endpoints para usar Supabase Storage
- [ ] Remover `@vercel/blob` do `package.json`
- [ ] Dropar tabelas `users` e `sessions` (após 30 dias da Fase 2)
- [ ] Remover `settings` global (merge com `workspace_settings`)
- [ ] Atualizar `CLAUDE.md` do projeto com nova stack
- [ ] Atualizar Docker/deploy config

**Risco:** Baixo.
**Rollback:** URLs Vercel Blob continuam funcionando.

### FASE 6 — Importação de Campanhas Meta Ads (3-5 dias)

**Objetivo:** Implementar a feature de importação de campanhas do Meta Ads Manager (seção 13).

- [ ] Criar tabela `ad_sets` no schema Drizzle
- [ ] Criar tabelas `import_jobs` e `import_job_items`
- [ ] Adicionar colunas em `creatives`: `origin`, `meta_creative_spec`, `instagram_permalink`, `meta_preview_url`, `video_blob_url`
- [ ] Implementar endpoint `POST /api/imports/start` (iniciar job)
- [ ] Implementar endpoint `GET /api/imports/{id}/status` (polling de progresso)
- [ ] Implementar estágio 1 (estrutura): campanhas → ad sets → ads
- [ ] Implementar rate limiting adaptativo (janela 4h, floor 30s)
- [ ] Implementar prioridade (pausar import se há publicação pendente)
- [ ] Implementar estágio 2 (imagens) + estágio 3 (vídeos)
- [ ] Implementar estágio 4 (insights com mesma janela do filtro)
- [ ] Implementar deduplicação por meta_id (upsert)
- [ ] Implementar busca de `instagram_permalink` via Instagram Graph API
- [ ] Implementar endpoint `POST /api/creatives/{id}/extract-prompt` (reverse prompt via Gemini)
- [ ] UI: modal de importação com filtros + preview + progress
- [ ] UI: botão "Ver no Instagram" nos criativos importados
- [ ] UI: botão "Extrair prompt" nos criativos importados
- [ ] UI: botão "Criar Blueprint" para promover creative importado a ad_blueprint

**Risco:** Médio — depende de comportamento da Meta API com volumes grandes. Mitigação: rate limiting adaptativo + prioridade inferior.
**Rollback:** Feature isolada, desabilitar via feature flag.
**Dependências:** Fases 0, 1, 5 (precisa de Drizzle, Storage, e RLS).

---

## 15. Cronograma Estimado

| Fase | Duração estimada | Dependências | Risco |
|---|---|---|---|
| Fase 0 — Preparação | 1 dia | Nenhuma | Baixo |
| Fase 1 — ORM + UUID + RLS | 3-5 dias | Fase 0 | **Alto** |
| Fase 2 — Auth | 2-3 dias | Fase 1 | Médio |
| Fase 3 — Design System | 3-5 dias | Nenhuma (paralelo com Fase 2) | Médio |
| Fase 4 — Observabilidade | 2-3 dias | Fase 1 | Baixo |
| Fase 5 — Storage + Cleanup | 1-2 dias | Fases 2, 3, 4 | Baixo |
| Fase 6 — Importação Meta Ads | 3-5 dias | Fases 0, 1, 5 | Médio |
| **Total** | **15-24 dias úteis** | | |

**Nota:** Fases 2 e 3 podem executar em paralelo (auth e design system são independentes). Fase 4 pode iniciar junto com Fase 2. Fase 6 pode iniciar assim que Fases 1 e 5 estiverem completas. O caminho crítico é: 0 → 1 → 5 → 6 = **8-13 dias**.

---

## 16. Riscos e Mitigações

| Risco | Impacto | Probabilidade | Mitigação |
|---|---|---|---|
| Drizzle incompatível com schemas TEXT PK existentes | Alto | Baixa | Testado — Drizzle suporta TEXT PK nativamente |
| bcrypt hash incompatível com gotrue | Médio | Média | Verificar formato antes; se incompatível, forçar password reset |
| 84 rotas API quebram durante migração ORM | Alto | Média | Adapter `execute()` permite migração gradual; rotas não migradas continuam funcionando |
| GSAP removal quebra animações críticas | Baixo | Baixa | Substituir por `transition-*` Tailwind, que são mais performantes |
| Supavisor `prepare: false` causa regressão em queries complexas | Médio | Média | Pattern parcialmente validado (CRM usa conexão direta ainda); testar queries com CTE e window functions antes da Fase 1B cutover |
| Supabase Storage quota insuficiente | Baixo | Baixa | Storage self-hosted, quota é configurável |

---

## 17. Contraditório e Alternativas Descartadas

### 15.1 "Por que migrar PKs para UUID agora e não depois?"

**Decisão (v1.1): Migrar agora.** O sistema tem ~1 mês de operação, ~50k rows, dados replicáveis. O custo de migração cresce exponencialmente com o volume. Com 5+ projetos novos nos próximos 6 meses e milhões de rows em métricas, essa janela se fecha.

**Argumento contra (descartado):** "Risco de cascata em 22 tabelas com ~50 FKs." — Válido para sistema em produção com dados críticos. Não é o caso atual: estamos fazendo pg_dump → database novo, os schemas Drizzle já nascem com UUID, e UUIDv5 determinístico garante conversão reproduzível.

### 15.2 "Por que implementar RLS agora e não depois?"

**Decisão (v1.2): Implementar RLS agora.** Mesma lógica da migração de PKs — o custo é mínimo agora e cresce com o tempo.

**Argumento decisivo:** São 84 rotas API filtrando `workspace_id` manualmente via WHERE clause. Cada rota é um vetor potencial de vazamento de dados entre tenants. Basta um dev esquecer o WHERE numa query nova e os dados de um cliente vazam para outro. RLS elimina essa classe inteira de bugs na camada do banco — a query pode até esquecer o filtro, mas o Postgres não retorna rows de outro workspace.

**Argumento contra (descartado):** "Exige policies para cada tabela e mudança no flow." — Verdade, mas estamos reescrevendo todas as 84 rotas de raw SQL para Drizzle de qualquer forma (Fase 1). O custo incremental de adicionar RLS durante essa reescrita é marginal comparado a fazer depois.

### 15.3 "Por que database separado e não schema separado?"

**Argumento a favor do schema separado:** Mais fácil de cross-query (JOIN entre CRM e Ads direto).
**Argumento a favor do database separado:** Isolamento total de permissões, backup independente, migration sem risco de afetar o outro projeto, pooler tenant separado (Supavisor), evolução independente de versões/extensions.
**Decisão:** Database separado. Cross-queries entre CRM e Ads podem ser feitas via `dblink` ou Foreign Data Wrappers se necessário no futuro, mas são raras o suficiente para justificar via API.

---

## 18. Checklist de Validação Pós-Migração

- [ ] Todas as 84 rotas API respondem corretamente
- [ ] RLS ativo em todas as tabelas multi-tenant — query sem `withWorkspace()` retorna zero rows
- [ ] Teste de isolamento: workspace A não vê dados do workspace B
- [ ] Crons (kill rules, métricas) funcionam via `dbAdmin` (BYPASSRLS)
- [ ] Login/logout funciona via Supabase Auth
- [ ] API Key auth funciona para chamadas externas
- [ ] Kill rules executam corretamente (cron)
- [ ] Métricas são coletadas (cron)
- [ ] Imagens são exibidas (Supabase Storage)
- [ ] Sidebar renderiza com shadcn + lucide
- [ ] Theme toggle funciona (Light/Dark/System)
- [ ] Testes passam no CI
- [ ] Sentry captura erros
- [ ] Prometheus métricas acessíveis
- [ ] Performance: latência p95 < 200ms nas rotas principais
- [ ] Nenhum `console.log` restante (todos migrados para Pino)
- [ ] `@neondatabase/serverless`, `@vercel/blob`, `gsap`, `bcrypt` removidos do bundle
- [ ] Importação de campanhas funciona: filtro por nome + janela de dias (max 540)
- [ ] Rate limiting adaptativo respeita floor de 30s e janela de 4h
- [ ] Importação pausa quando há jobs de publicação pendentes
- [ ] Ordem de importação: mais recentes primeiro (created_time DESC)
- [ ] Instagram permalink funciona nos criativos importados
- [ ] Extração de prompt via IA gera prompt utilizável
- [ ] Criativos importados podem ser promovidos a Ad Blueprint
- [ ] Re-importação faz upsert sem duplicar dados
