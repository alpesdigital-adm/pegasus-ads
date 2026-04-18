# Staging Queue v2 — Especificação Técnica

**Versão:** 2.0 — 2026-04-18  
**Status:** Proposta (pré-aprovação)  
**Autor:** Claude (análise) + Leandro (decisões)  
**Dependências:** Fase 1 concluída (Drizzle + RLS + Supabase), Fase 5 (Storage)

---

## 1. Problema

O `runPublishPipeline` atual (`src/lib/pipelines/publish.ts`) e os endpoints de publicação (`publish-to-adsets`, `publish-carousel`, `publish-videos`, `publish-external`) executam de forma **síncrona e inline** — cada publicação roda do início ao fim dentro de uma única request HTTP, sem recuperação estruturada de falhas.

### 1.1 Cenários de falha atuais

**P1 — Falha parcial sem retry granular.** Upload do Feed OK, upload do Stories falha por rate-limit da Meta (code 17). O pipeline inteiro falha. Re-execução re-uploada o Feed que já estava OK — desperdício + rate-limit pior. Hoje `publish-to-adsets` e `publish-videos` têm retry com backoff para code 17, mas no nível da chamada HTTP individual, não do pipeline.

**P2 — Long-running + crash.** Publicar 10+ variantes com imagens Feed+Stories pode levar 5-10 minutos. Se o container reiniciar no meio (deploy, OOM, Docker restart), perde contexto. Cleanup manual: descobrir no Meta o que foi criado, reconciliar com o banco.

**P3 — Rate limiting descoordenado.** Cada endpoint faz seu próprio rate limiting (`rateLimit()` com 500ms entre calls, `metaFetch` com retry para code 17). Sem coordenação global: 2 publicações simultâneas em workspaces diferentes podem saturar o rate limit da conta Meta.

**P4 — Visibilidade limitada.** `pipeline_executions.steps` é JSONB — não permite queries SQL sobre status de steps individuais, não tem timeline granular, não permite retry seletivo.

**P5 — Sem reuso estruturado.** Um winner (CPL abaixo da meta) não tem caminho formal para virar template reutilizável. Duplicação é manual via `duplicate-creative` endpoint.

### 1.2 Fluxos de publicação existentes

O Pegasus tem **5 caminhos de publicação**, todos síncronos:

| Endpoint | Fluxo | Steps Meta API |
|---|---|---|
| `POST /api/test-rounds/publish` | Pipeline completo via `runPublishPipeline()` | load_context → verify_pre → upload_images(F+S) → create_labels → create_creative → create_adset → create_ad → verify_post → persist |
| `POST /api/ads/publish-to-adsets` | Publica ads em adsets existentes/clonados | resolve_model_ad → list_adsets → [clone_adset] → upload_images → create_creative → create_ad(×N adsets) |
| `POST /api/ads/publish-carousel` | Publica carrosseis | resolve_model_ad → list_adsets → upload_card_images(×N) → create_carousel_creative → create_ad(×N adsets) |
| `POST /api/ads/publish-videos` | Sobe vídeos e cria ads | [clone_adset] → resolve_model_ad → upload_video(×N) → create_creative(×N) → create_ad(×N) |
| `POST /api/ads/publish-external` | Publica criativos do Google Drive | list_drive_files → download_images → upload_images → create_creative → create_ad(×N adsets) |

**Observação:** Todos compartilham os mesmos building blocks (upload image, create creative, create ad, clone adset) mas cada um reimplementa o rate limiting, error handling e retry separadamente.

---

## 2. Decisões de Design

### D1 — Build completo (opção A)

Construir o sistema de orquestração completo com batches, steps granulares, DAG de dependências e event log. Sem atalhos, sem débito técnico planejado.

**Justificativa:** O custo de construir uma versão simplificada + estabilizá-la + reconstruir depois é comparável ou maior que construir certo de uma vez. A infraestrutura de orquestração será reutilizada pelo import pipeline (Fase 6 do plano de migração) e potencialmente por outros jobs assíncronos futuros.

### D2 — Escopo

| Feature | Incluída | Nota |
|---|---|---|
| `publication_batches` + state machine | ✅ | Central |
| `publication_steps` retriable com status individual | ✅ | Resolve P1, P4 |
| `step_dependencies` (DAG) | ✅ | Paralelização + resolução automática |
| `step_events` (log append-only) | ✅ | Debugging, auditoria, replay |
| Worker com retry + backoff exponencial | ✅ | Resolve P2 |
| Activation Mode (after_all / immediate) | ✅ | Ads PAUSED até batch completo; ativação em lote |
| Pause / Resume mid-publication | ✅ | Pausa entre steps, não interrompe step ativo |
| Publicação agendada (`scheduled_at`) | ✅ | Batch criado como `scheduled`, promovido pelo worker |
| Frontend real-time via Supabase Realtime | ✅ | Zero polling, WebSocket nativo |
| Progresso intra-step (upload vídeo) | ✅ | Events intermediários em `step_events` |
| ETA dinâmico | ✅ | Calculado pela média de duração dos steps concluídos |
| `ad_blueprints` + `blueprint_versions` | ❌ V2 | Feature de negócio, não infraestrutura |
| Worker distribuído (múltiplas instâncias) | ❌ V2 | Single-instance com SKIP LOCKED basta |
| Throttling global cross-workspace | ❌ V2 | Débito aceito (~0.5 dia quando necessário) |
| UI de observabilidade completa | ❌ V2 | MVP: hook `useBatchProgress` + página simples de status |

### D3 — Worker: cron + endpoint HTTP

O worker roda como cron que invoca um endpoint HTTP a cada 60 segundos. O endpoint processa 1 batch por invocação (ou N steps do batch corrente).

**Justificativa:** Padrão já validado em produção (`/api/cron/sync-all`, `/api/cron/collect`). Zero infra nova. Migração para container dedicado não exige reescrita — apenas mudar o trigger de cron para loop infinito.

### D4 — Idempotência: verificação + reconciliation

Cada step, antes de executar uma operação na Meta API, verifica se o resultado já existe (GET antes de POST). Se existe, marca como `succeeded` sem re-executar.

Um job de reconciliação semanal compara state local vs Meta API e corrige divergências (ad existe na Meta mas não no Pegasus, ou vice-versa).

**Risco residual aceito:** ad fantasma no Meta sem registro local. Frequência estimada: <1/mês no volume atual. Coberto pelo reconciliation job.

### D5 — Multi-tenancy: dbAdmin + filtro manual

O worker usa `dbAdmin` (role com BYPASSRLS) e filtra workspace manualmente no código. Não usa `withWorkspace()` porque o worker processa batches de múltiplos workspaces em sequência — setar `app.workspace_id` entre cada batch é possível mas frágil.

Padrão validado no CRM.

### D6 — Activation Mode: ativar ads individualmente ou em lote

Regra de negócio configurável por publicação:

- **`after_all` (default)** — Ads são criados com `status: PAUSED` na Meta. Quando **todos** os ads de **todos** os ad sets do batch estão publicados e persistidos, um step final (`activate_ads`) ativa todos de uma vez. 
- **`immediate`** — Ads são criados com `status: ACTIVE` (comportamento legacy). Cada ad começa a veicular assim que é criado.

**Justificativa:** O modo `after_all` resolve dois problemas:

1. **Cancel mid-batch é seguro.** Se o batch for cancelado no meio, todos os ads criados até então estão PAUSED — zero gasto de budget, zero confusão de teste parcial. O usuário pode retomar (Resume) ou descartar sem cleanup na Meta.
2. **Teste começa limpo.** Todos os ads entram no leilão da Meta no mesmo instante, sem defasagem de aprendizado entre os que foram criados primeiro e os últimos.

O modo `immediate` existe para casos onde o usuário quer que ads comecem a veicular o mais rápido possível (ex: reposição urgente de ads pausados).

O frontend apresenta como: _"Ativar ads na publicação individual ou apenas após publicar todos (recomendado)"_.

---

## 3. Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│  Request HTTP (UI ou API)                                       │
│                                                                  │
│  1. Endpoint recebe pedido de publicação                        │
│  2. Cria batch + steps + dependencies no banco                  │
│  3. Retorna batch_id imediatamente (HTTP 202 Accepted)          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Worker (cron cada 60s → POST /api/cron/process-queue) │     │
│  │                                                         │     │
│  │  1. SELECT batch pendente (FOR UPDATE SKIP LOCKED)      │     │
│  │  2. Resolver DAG: quais steps têm deps satisfeitas?     │     │
│  │  3. Executar steps prontos (com retry + backoff)        │     │
│  │  4. Emitir events para cada transição                   │     │
│  │  5. Atualizar batch state machine                       │     │
│  │  6. Se batch completo → callback                        │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────┐     │
│  │  Postgres (state 100% no banco)                         │     │
│  │                                                         │     │
│  │  publication_batches  — state machine do batch          │     │
│  │  publication_steps    — unidade atômica retriable       │     │
│  │  step_dependencies    — DAG entre steps                 │     │
│  │  step_events          — log append-only                 │     │
│  └────────────────────────────────────────────────────────┘     │
│                                                                  │
│  Polling UI: GET /api/batches/{id}/status                       │
│  → retorna batch status + steps com % progresso                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Schemas Drizzle

### 4.1 `publication_batches`

```typescript
// src/lib/db/schema/staging-queue.ts

import {
  pgTable, uuid, text, timestamp, jsonb, integer, pgEnum,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces';

export const batchStatusEnum = pgEnum('batch_status', [
  'scheduled',        // Agendado para execução futura (scheduled_at > NOW())
  'pending',          // Criado, aguardando worker
  'running',          // Worker processando steps
  'paused',           // Pausado manualmente ou por prioridade
  'partial_success',  // Alguns steps succeeded, outros failed (após max retries)
  'succeeded',        // Todos os steps succeeded
  'failed',           // Falha irrecuperável (step crítico falhou após max retries)
  'cancelled',        // Cancelado pelo usuário
]);

export const publicationBatches = pgTable('publication_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),

  // Tipo de batch (determina quais steps são criados)
  batchType: text('batch_type', {
    enum: [
      'test_round_publish',   // runPublishPipeline atual
      'publish_to_adsets',    // publish-to-adsets
      'publish_carousel',     // publish-carousel
      'publish_videos',       // publish-videos
      'publish_external',     // publish-external (Drive)
      'import_campaigns',     // Fase 6: import Meta Ads
    ],
  }).notNull(),

  // State machine
  status: batchStatusEnum('status').default('pending').notNull(),

  // Prioridade (menor = mais urgente). Publicação = 10, Import = 50.
  priority: integer('priority').default(10).notNull(),

  // Modo de ativação dos ads na Meta:
  //   'after_all'  (default) — ads são criados com status PAUSED na Meta.
  //       Um step final `activate_ads` ativa todos de uma vez após o batch concluir.
  //       Vantagem: cancel mid-batch não gera ads gastando budget.
  //   'immediate' — ads são criados com status ACTIVE (comportamento legacy).
  activationMode: text('activation_mode', {
    enum: ['after_all', 'immediate'],
  }).default('after_all').notNull(),

  // Contexto do batch (input original da request)
  inputData: jsonb('input_data').default({}).notNull(),

  // Resultado agregado (preenchido ao final)
  outputData: jsonb('output_data').default({}),

  // Referências opcionais ao contexto de negócio
  testRoundId: uuid('test_round_id'),
  importJobId: uuid('import_job_id'),

  // Contadores (preenchidos na criação, atualizados pelo worker)
  stepsTotal: integer('steps_total').default(0).notNull(),
  stepsSucceeded: integer('steps_succeeded').default(0).notNull(),
  stepsFailed: integer('steps_failed').default(0).notNull(),
  stepsSkipped: integer('steps_skipped').default(0).notNull(),

  // Agendamento (se preenchido e status = 'scheduled', worker ignora até scheduled_at <= NOW())
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),

  // Timing
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  estimatedCompletionAt: timestamp('estimated_completion_at', { withTimezone: true }),

  // Error tracking
  errorMessage: text('error_message'),
  errorContext: jsonb('error_context'),

  // Lock: qual worker está processando este batch
  lockedBy: text('locked_by'),
  lockedAt: timestamp('locked_at', { withTimezone: true }),
});
```

### 4.2 `publication_steps`

```typescript
export const stepStatusEnum = pgEnum('step_status', [
  'pending',           // Aguardando deps
  'ready',             // Deps satisfeitas, pronto para executar
  'running',           // Em execução
  'succeeded',         // Concluído com sucesso
  'retryable_failed',  // Falhou, será retentado (attempts < max_attempts)
  'failed',            // Falhou definitivamente (attempts >= max_attempts)
  'skipped',           // Pulado (dep falhou e step não é critical)
  'cancelled',         // Cancelado com o batch
]);

export const publicationSteps = pgTable('publication_steps', {
  id: uuid('id').primaryKey().defaultRandom(),
  batchId: uuid('batch_id').notNull().references(() => publicationBatches.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),

  // Tipo de step (determina qual handler executar)
  stepType: text('step_type', {
    enum: [
      // Upload
      'upload_image',
      'upload_video',
      // Labels
      'create_ad_label',
      // Creative
      'create_creative',
      'create_carousel_creative',
      // Ad Set
      'create_adset',
      'clone_adset',
      // Ad
      'create_ad',
      // Verificação
      'verify_pre_publish',
      'verify_post_publish',
      // Contexto
      'load_context',
      'resolve_model_ad',
      'list_adsets',
      'download_drive_files',
      // Ativação (modo after_all)
      'activate_ads',
      // Persistência
      'persist_results',
      // Import (Fase 6)
      'import_structure',
      'import_image',
      'import_video',
      'import_insights',
    ],
  }).notNull(),

  // Posição no DAG (para ordenação visual)
  ordinal: integer('ordinal').default(0).notNull(),

  // Status
  status: stepStatusEnum('status').default('pending').notNull(),

  // É step crítico? Se falhar, batch inteira falha.
  // Se não-crítico e falhar, batch pode continuar (partial_success).
  isCritical: text('is_critical', { enum: ['true', 'false'] }).default('true').notNull(),

  // Input para o handler (ex: { accountId, imageBuffer, filename })
  inputData: jsonb('input_data').default({}).notNull(),

  // Output do handler (ex: { imageHash, metaCreativeId })
  outputData: jsonb('output_data').default({}),

  // Retry
  attempts: integer('attempts').default(0).notNull(),
  maxAttempts: integer('max_attempts').default(3).notNull(),
  lastError: text('last_error'),
  lastErrorCode: text('last_error_code'), // ex: 'META_RATE_LIMIT', 'META_VALIDATION', 'NETWORK'
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),

  // Meta entity tracking (para idempotência)
  // Se o step criou algo na Meta, o ID fica aqui para verificação
  metaEntityId: text('meta_entity_id'),
  metaEntityType: text('meta_entity_type'), // 'image', 'creative', 'adset', 'ad', 'label', 'video'

  // Timing
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  durationMs: integer('duration_ms'),
});
```

### 4.3 `step_dependencies`

```typescript
export const stepDependencies = pgTable('step_dependencies', {
  id: uuid('id').primaryKey().defaultRandom(),
  stepId: uuid('step_id').notNull().references(() => publicationSteps.id, { onDelete: 'cascade' }),
  dependsOnStepId: uuid('depends_on_step_id').notNull().references(() => publicationSteps.id, { onDelete: 'cascade' }),

  // Qual campo do output da dependência alimenta o input deste step
  // Ex: 'imageHash' → step de upload produz imageHash, step de creative consome
  outputKey: text('output_key'),
  inputKey: text('input_key'),
});
```

### 4.4 `step_events`

```typescript
export const stepEvents = pgTable('step_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  stepId: uuid('step_id').notNull().references(() => publicationSteps.id, { onDelete: 'cascade' }),
  batchId: uuid('batch_id').notNull().references(() => publicationBatches.id, { onDelete: 'cascade' }),

  // Transição
  fromStatus: text('from_status').notNull(),
  toStatus: text('to_status').notNull(),

  // Contexto
  message: text('message'),
  metadata: jsonb('metadata').default({}),

  // Timing
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
```

---

## 5. State Machines

### 5.1 Batch State Machine

```
               ┌────────────┐
               │ scheduled  │ (scheduled_at no futuro)
               └─────┬──────┘
                     │ scheduled_at <= NOW()
                     ▼
               ┌──────────┐
               │ pending  │
               └────┬─────┘
                    │ worker picks up
                    ▼
               ┌──────────┐
         ┌─────│ running  │─────┐
         │     └────┬─────┘     │
         │          │           │
    user cancels    │      all steps done
         │          │           │
         ▼          │           ▼
   ┌───────────┐   │    ┌─────────────────┐
   │ cancelled │   │    │  all succeeded?  │
   └───────────┘   │    └───┬─────────┬────┘
                    │        │ yes     │ no
               pause│        ▼         ▼
                    │  ┌───────────┐ ┌─────────────────┐
                    │  │ succeeded │ │ any succeeded?   │
                    │  └───────────┘ └──┬──────────┬───┘
                    ▼                   │ yes      │ no
              ┌──────────┐              ▼          ▼
              │  paused  │     ┌────────────────┐ ┌────────┐
              └──────────┘     │partial_success │ │ failed │
                               └────────────────┘ └────────┘
```

**Transições válidas:**

| De | Para | Trigger |
|---|---|---|
| `scheduled` | `pending` | `scheduled_at <= NOW()` (cron ou criação sem `scheduled_at`) |
| `scheduled` | `cancelled` | Pedido do usuário (cancelar antes de começar) |
| `pending` | `running` | Worker faz lock no batch |
| `pending` | `cancelled` | Pedido do usuário |
| `running` | `succeeded` | Todos os steps `succeeded` |
| `running` | `partial_success` | Pelo menos 1 step `succeeded` + pelo menos 1 step `failed` |
| `running` | `failed` | Step crítico `failed` (após max retries) |
| `running` | `paused` | Pedido manual via API ou prioridade (import pausa para publicação) |
| `running` | `cancelled` | Pedido do usuário |
| `paused` | `running` | Pedido manual via API ou condição de prioridade liberada |
| `paused` | `cancelled` | Pedido do usuário |

### 5.2 Step State Machine

```
              ┌─────────┐
              │ pending │
              └────┬────┘
                   │ deps satisfied
                   ▼
              ┌─────────┐
              │  ready  │
              └────┬────┘
                   │ worker executes
                   ▼
              ┌─────────┐
         ┌────│ running │────┐
         │    └─────────┘    │
         │                   │
      success             failure
         │                   │
         ▼                   ▼
    ┌───────────┐    ┌──────────────────┐
    │ succeeded │    │ attempts < max?  │
    └───────────┘    └───┬──────────┬───┘
                         │ yes      │ no
                         ▼          ▼
                ┌──────────────┐ ┌────────┐
                │retryable_fail│ │ failed │
                └──────┬───────┘ └────────┘
                       │ retry timer expires
                       ▼
                  ┌─────────┐
                  │  ready  │ (volta para ready)
                  └─────────┘

  Transições laterais:
  - Qualquer estado → cancelled (batch cancelada)
  - pending → skipped (dep falhou + step não-crítico)
```

**Backoff exponencial:**

```typescript
function calculateNextRetry(attempts: number): Date {
  // 5s, 20s, 80s, 320s (max 5 min)
  const baseMs = 5000;
  const delayMs = Math.min(300_000, baseMs * Math.pow(4, attempts));
  return new Date(Date.now() + delayMs);
}
```

---

## 6. DAG Resolution Algorithm

O worker resolve o DAG em cada iteração para determinar quais steps estão prontos para executar.

```typescript
/**
 * Resolve o DAG de dependências e retorna steps prontos para executar.
 *
 * Um step está "ready" quando:
 * 1. Status atual é 'pending'
 * 2. TODAS as dependências têm status 'succeeded'
 * 3. Se alguma dependência tem status 'failed' e o step é não-crítico → marcar como 'skipped'
 * 4. Se alguma dependência tem status 'failed' e o step é crítico → não executar (batch vai falhar)
 *
 * Também resolve retries: steps com status 'retryable_failed'
 * e next_retry_at <= NOW() voltam para 'ready'.
 */
async function resolveReadySteps(batchId: string): Promise<string[]> {
  // 1. Promover retryable_failed → ready (timer expirou)
  await dbAdmin.execute(sql`
    UPDATE publication_steps
    SET status = 'ready', started_at = NULL
    WHERE batch_id = ${batchId}
      AND status = 'retryable_failed'
      AND next_retry_at <= NOW()
  `);

  // 2. Buscar steps pendentes cujas deps estão todas satisfied
  const readySteps = await dbAdmin.execute(sql`
    UPDATE publication_steps ps
    SET status = 'ready'
    WHERE ps.batch_id = ${batchId}
      AND ps.status = 'pending'
      AND NOT EXISTS (
        -- Tem alguma dep que NÃO está succeeded?
        SELECT 1 FROM step_dependencies sd
        JOIN publication_steps dep ON dep.id = sd.depends_on_step_id
        WHERE sd.step_id = ps.id
          AND dep.status NOT IN ('succeeded', 'skipped')
      )
      -- Mas TEM pelo menos uma dep (ou nenhuma dep = root step)
      AND (
        NOT EXISTS (SELECT 1 FROM step_dependencies sd WHERE sd.step_id = ps.id)
        OR EXISTS (
          SELECT 1 FROM step_dependencies sd
          JOIN publication_steps dep ON dep.id = sd.depends_on_step_id
          WHERE sd.step_id = ps.id AND dep.status = 'succeeded'
        )
      )
    RETURNING ps.id
  `);

  // 3. Marcar como skipped: steps cujas deps falharam e são não-críticos
  await dbAdmin.execute(sql`
    UPDATE publication_steps ps
    SET status = 'skipped'
    WHERE ps.batch_id = ${batchId}
      AND ps.status = 'pending'
      AND ps.is_critical = 'false'
      AND EXISTS (
        SELECT 1 FROM step_dependencies sd
        JOIN publication_steps dep ON dep.id = sd.depends_on_step_id
        WHERE sd.step_id = ps.id
          AND dep.status = 'failed'
      )
  `);

  return readySteps.map((r: { id: string }) => r.id);
}
```

### 6.1 Propagação de outputs entre steps

Quando um step completa, seus outputs são disponibilizados para os steps dependentes via `step_dependencies.output_key` → `input_key`.

```typescript
/**
 * Após um step completar com sucesso, propaga seus outputs para
 * os inputs dos steps dependentes.
 */
async function propagateOutputs(completedStepId: string): Promise<void> {
  const deps = await dbAdmin
    .select()
    .from(stepDependencies)
    .where(eq(stepDependencies.dependsOnStepId, completedStepId));

  for (const dep of deps) {
    if (!dep.outputKey || !dep.inputKey) continue;

    // Buscar output do step completado
    const [completedStep] = await dbAdmin
      .select({ outputData: publicationSteps.outputData })
      .from(publicationSteps)
      .where(eq(publicationSteps.id, completedStepId));

    const outputValue = (completedStep.outputData as Record<string, unknown>)?.[dep.outputKey];
    if (outputValue === undefined) continue;

    // Merge no input do step dependente
    await dbAdmin.execute(sql`
      UPDATE publication_steps
      SET input_data = jsonb_set(
        COALESCE(input_data, '{}'::jsonb),
        ${`{${dep.inputKey}}`}::text[],
        ${JSON.stringify(outputValue)}::jsonb
      )
      WHERE id = ${dep.stepId}
    `);
  }
}
```

---

## 7. Worker

### 7.1 Endpoint do worker

```typescript
// POST /api/cron/process-queue
//
// Invocado pelo cron a cada 60 segundos.
// Processa 1 batch por invocação (ou continua batch em andamento).
// Usa dbAdmin (BYPASSRLS) + filtro manual de workspace.

export async function POST(req: NextRequest) {
  // Auth: cron secret
  const cronSecret = req.headers.get('x-cron-secret');
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 0. Promover batches agendados cujo horário chegou
  await promoteScheduledBatches();

  // 1. Buscar batch para processar (prioridade + FIFO)
  const batch = await acquireBatch();
  if (!batch) {
    return NextResponse.json({ status: 'idle', message: 'no pending batches' });
  }

  try {
    // 2. Resolver steps prontos
    const readyStepIds = await resolveReadySteps(batch.id);

    if (readyStepIds.length === 0) {
      // Verificar se batch está completo
      await evaluateBatchCompletion(batch.id);
      return NextResponse.json({ status: 'evaluated', batchId: batch.id });
    }

    // 3. Executar steps prontos (sequencialmente neste MVP)
    let processed = 0;
    for (const stepId of readyStepIds) {
      // 3a. Checar se batch foi pausado/cancelado entre steps
      const freshBatch = await getBatchStatus(batch.id);
      if (freshBatch.status === 'paused' || freshBatch.status === 'cancelled') {
        await releaseBatch(batch.id);
        return NextResponse.json({
          status: freshBatch.status,
          batchId: batch.id,
          stepsProcessed: processed,
          reason: 'batch_interrupted_between_steps',
        });
      }

      await executeStep(stepId, batch.id);
      processed++;

      // Rate limit: pausa entre steps que chamam Meta API
      const step = await getStep(stepId);
      if (isMetaApiStep(step.stepType)) {
        await sleep(2000); // 2s entre chamadas Meta
      }
    }

    // 4. Re-avaliar batch
    await evaluateBatchCompletion(batch.id);

    return NextResponse.json({
      status: 'processed',
      batchId: batch.id,
      stepsProcessed: processed,
    });
  } catch (error) {
    await releaseBatch(batch.id, error);
    throw error;
  }
}
```

### 7.2 Aquisição de batch (lock com SKIP LOCKED)

```typescript
async function acquireBatch(): Promise<{ id: string; workspaceId: string } | null> {
  const workerId = `worker-${process.env.HOSTNAME || 'default'}-${Date.now()}`;

  // Prioridade: batches running > pending. Menor priority number = mais urgente.
  // NOTA: 'scheduled' e 'paused' NÃO entram aqui.
  //   - scheduled → promovido para pending por promoteScheduledBatches() antes desta chamada
  //   - paused → só volta para running via API manual (POST /api/batches/{id}/resume)
  const result = await dbAdmin.execute(sql`
    UPDATE publication_batches
    SET locked_by = ${workerId},
        locked_at = NOW(),
        status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
        started_at = CASE WHEN started_at IS NULL THEN NOW() ELSE started_at END
    WHERE id = (
      SELECT id FROM publication_batches
      WHERE status IN ('pending', 'running')
        AND (locked_by IS NULL OR locked_at < NOW() - INTERVAL '5 minutes')
      ORDER BY
        CASE status WHEN 'running' THEN 0 WHEN 'pending' THEN 1 END,
        priority ASC,
        created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, workspace_id
  `);

  return result.length > 0
    ? { id: result[0].id, workspaceId: result[0].workspace_id }
    : null;
}
```

**Lock timeout de 5 minutos:** se um worker crashar segurando o lock, outro worker pode adquirir o batch após 5 minutos. O step que estava rodando fica em `running` — o novo worker detecta isso e trata como `retryable_failed`.

### 7.2.1 Promoção de batches agendados

```typescript
/**
 * Promove batches scheduled → pending quando scheduled_at <= NOW().
 * Executado no início de cada invocação do worker.
 */
async function promoteScheduledBatches(): Promise<number> {
  const result = await dbAdmin.execute(sql`
    UPDATE publication_batches
    SET status = 'pending'
    WHERE status = 'scheduled'
      AND scheduled_at <= NOW()
    RETURNING id
  `);
  return result.length;
}
```

### 7.2.2 Verificação de interrupção entre steps

```typescript
/**
 * Busca status atualizado do batch. Chamado entre steps para
 * detectar pause/cancel solicitado pelo usuário via API.
 */
async function getBatchStatus(batchId: string): Promise<{ status: string }> {
  const [batch] = await dbAdmin
    .select({ status: publicationBatches.status })
    .from(publicationBatches)
    .where(eq(publicationBatches.id, batchId));
  return batch;
}
```

### 7.3 Execução de step

```typescript
async function executeStep(stepId: string, batchId: string): Promise<void> {
  // 1. Marcar como running
  await dbAdmin
    .update(publicationSteps)
    .set({ status: 'running', startedAt: sql`NOW()`, attempts: sql`attempts + 1` })
    .where(eq(publicationSteps.id, stepId));

  await emitEvent(stepId, batchId, 'ready', 'running', 'Step execution started');

  const [step] = await dbAdmin
    .select()
    .from(publicationSteps)
    .where(eq(publicationSteps.id, stepId));

  try {
    // 2. Idempotência: verificar se resultado já existe na Meta
    if (step.metaEntityId && step.metaEntityType) {
      const exists = await verifyMetaEntity(step.metaEntityId, step.metaEntityType, step.workspaceId);
      if (exists) {
        await markStepSucceeded(stepId, batchId, { skippedReason: 'already_exists', metaEntityId: step.metaEntityId });
        return;
      }
    }

    // 3. Executar handler
    const handler = getStepHandler(step.stepType);
    const result = await handler(step.inputData as Record<string, unknown>, step.workspaceId);

    // 4. Salvar resultado + propagar outputs
    await markStepSucceeded(stepId, batchId, result);
    await propagateOutputs(stepId);

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorCode = classifyError(error);

    if (step.attempts >= step.maxAttempts) {
      // Falha definitiva
      await dbAdmin
        .update(publicationSteps)
        .set({
          status: 'failed',
          lastError: errorMsg,
          lastErrorCode: errorCode,
          completedAt: sql`NOW()`,
          durationMs: sql`EXTRACT(EPOCH FROM (NOW() - started_at))::INTEGER * 1000`,
        })
        .where(eq(publicationSteps.id, stepId));
      await emitEvent(stepId, batchId, 'running', 'failed', errorMsg, { errorCode, attempts: step.attempts });
    } else {
      // Retry
      const nextRetry = calculateNextRetry(step.attempts);
      await dbAdmin
        .update(publicationSteps)
        .set({
          status: 'retryable_failed',
          lastError: errorMsg,
          lastErrorCode: errorCode,
          nextRetryAt: nextRetry,
        })
        .where(eq(publicationSteps.id, stepId));
      await emitEvent(stepId, batchId, 'running', 'retryable_failed', errorMsg, {
        errorCode,
        attempts: step.attempts,
        nextRetryAt: nextRetry.toISOString(),
      });
    }
  }
}
```

### 7.4 Classificação de erros

```typescript
function classifyError(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);

  // Meta API errors
  if (msg.includes('code 17') || msg.includes('rate limit'))
    return 'META_RATE_LIMIT';
  if (msg.includes('code 190') || msg.includes('access token'))
    return 'META_AUTH_EXPIRED';
  if (msg.includes('code 100') || msg.includes('Invalid parameter'))
    return 'META_VALIDATION';
  if (msg.includes('code 2') || msg.includes('temporary error'))
    return 'META_TEMPORARY';

  // Network
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('fetch failed'))
    return 'NETWORK';

  // Storage
  if (msg.includes('storage') || msg.includes('bucket'))
    return 'STORAGE';

  return 'UNKNOWN';
}

/**
 * Erros que NÃO devem ser retentados (retry é desperdício):
 */
function isNonRetryable(errorCode: string): boolean {
  return ['META_VALIDATION', 'META_AUTH_EXPIRED'].includes(errorCode);
}
```

### 7.5 Avaliação de conclusão do batch

```typescript
async function evaluateBatchCompletion(batchId: string): Promise<void> {
  const counts = await dbAdmin.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'succeeded') as succeeded,
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) FILTER (WHERE status = 'skipped') as skipped,
      COUNT(*) FILTER (WHERE status IN ('pending', 'ready', 'running', 'retryable_failed')) as active,
      COUNT(*) FILTER (WHERE status = 'failed' AND is_critical = 'true') as critical_failed
    FROM publication_steps
    WHERE batch_id = ${batchId}
  `);

  const c = counts[0];

  // Atualizar contadores
  await dbAdmin
    .update(publicationBatches)
    .set({
      stepsSucceeded: c.succeeded,
      stepsFailed: c.failed,
      stepsSkipped: c.skipped,
    })
    .where(eq(publicationBatches.id, batchId));

  // Determinar status do batch
  if (c.critical_failed > 0) {
    // Step crítico falhou definitivamente → batch failed
    // Cancelar steps pendentes
    await dbAdmin.execute(sql`
      UPDATE publication_steps
      SET status = 'cancelled'
      WHERE batch_id = ${batchId}
        AND status IN ('pending', 'ready')
    `);
    await finalizeBatch(batchId, 'failed');
  } else if (c.active === 0) {
    // Nenhum step ativo
    if (c.failed > 0) {
      await finalizeBatch(batchId, 'partial_success');
    } else {
      await finalizeBatch(batchId, 'succeeded');
    }
  }
  // Se active > 0, batch continua running (worker vai processar na próxima iteração)
}

async function finalizeBatch(batchId: string, status: string): Promise<void> {
  await dbAdmin
    .update(publicationBatches)
    .set({
      status: status as any,
      completedAt: sql`NOW()`,
      lockedBy: null,
      lockedAt: null,
    })
    .where(eq(publicationBatches.id, batchId));
}
```

---

## 8. Step Handlers

Cada `stepType` tem um handler que recebe `inputData` e retorna `outputData`. Os handlers são funções puras (sem side effects no banco local — o worker cuida da persistência).

### 8.1 Registry de handlers

```typescript
type StepHandler = (
  input: Record<string, unknown>,
  workspaceId: string
) => Promise<Record<string, unknown>>;

const stepHandlers: Record<string, StepHandler> = {
  upload_image: handleUploadImage,
  upload_video: handleUploadVideo,
  create_ad_label: handleCreateAdLabel,
  create_creative: handleCreateCreative,
  create_carousel_creative: handleCreateCarouselCreative,
  create_adset: handleCreateAdSet,
  clone_adset: handleCloneAdSet,
  create_ad: handleCreateAd,
  verify_pre_publish: handleVerifyPrePublish,
  verify_post_publish: handleVerifyPostPublish,
  load_context: handleLoadContext,
  resolve_model_ad: handleResolveModelAd,
  list_adsets: handleListAdSets,
  download_drive_files: handleDownloadDriveFiles,
  activate_ads: handleActivateAds,
  persist_results: handlePersistResults,
  // Import (Fase 6)
  import_structure: handleImportStructure,
  import_image: handleImportImage,
  import_video: handleImportVideo,
  import_insights: handleImportInsights,
};

function getStepHandler(stepType: string): StepHandler {
  const handler = stepHandlers[stepType];
  if (!handler) throw new Error(`No handler for step type: ${stepType}`);
  return handler;
}
```

### 8.2 Exemplo: upload_image handler

```typescript
async function handleUploadImage(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string;
  const imageSource = input.imageSource as string; // 'blob_url' | 'base64' | 'drive'
  const blobUrl = input.blobUrl as string | undefined;
  const base64 = input.base64 as string | undefined;
  const filename = input.filename as string;

  let imageBuffer: Buffer;

  if (imageSource === 'blob_url' && blobUrl) {
    const response = await fetch(blobUrl);
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else if (imageSource === 'base64' && base64) {
    imageBuffer = Buffer.from(base64, 'base64');
  } else {
    throw new Error(`Invalid image source: ${imageSource}`);
  }

  const result = await meta.uploadImage(accountId, imageBuffer, filename, workspaceId);

  return {
    imageHash: result.hash,
    filename,
  };
}
```

### 8.3 Exemplo: create_ad handler (com idempotência + activationMode)

```typescript
async function handleCreateAd(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string;
  const adSetId = input.adSetId as string;
  const creativeId = input.creativeId as string;
  const name = input.name as string;
  const storiesImageHash = input.storiesImageHash as string | undefined;
  // activationMode é injetado no inputData pelo batch creator (vem do batch.activationMode)
  const activationMode = (input.activationMode as string) || 'after_all';

  // Idempotência: verificar se ad com mesmo nome já existe no adset
  const existingAds = await meta.getAdsInAdSet(workspaceId, adSetId, { nameContains: name });
  const existing = existingAds.find((a: any) => a.name === name);
  if (existing) {
    return { adId: existing.id, adName: name, skipped: true, reason: 'already_exists' };
  }

  // Se after_all → cria PAUSED (step activate_ads ativa no final)
  // Se immediate → cria ACTIVE (comportamento legacy)
  const initialStatus = activationMode === 'after_all' ? 'PAUSED' : 'ACTIVE';

  const result = await meta.createAd({
    accountId,
    workspaceId,
    adSetId,
    creativeId,
    name,
    status: initialStatus,
    storiesImageHash,
  });

  return { adId: result.id, adName: name, createdWithStatus: initialStatus };
}
```

### 8.4 Handler: activate_ads (ativação em lote pós-publicação)

```typescript
/**
 * Ativa todos os ads do batch que foram criados como PAUSED.
 * Só executa quando activationMode === 'after_all'.
 *
 * Este step depende de TODOS os create_ad steps do batch.
 * Recebe a lista de ad IDs via propagação de outputs.
 *
 * Se o batch foi cancelado/pausado antes deste step, os ads
 * permanecem PAUSED na Meta — zero gasto, estado limpo.
 */
async function handleActivateAds(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const accountId = input.accountId as string;
  const batchId = input.batchId as string;

  // Buscar todos os ad IDs criados neste batch
  // (propagação 1:1 não serve para N→1, então buscamos diretamente)
  const adSteps = await dbAdmin
    .select({ outputData: publicationSteps.outputData })
    .from(publicationSteps)
    .where(
      and(
        eq(publicationSteps.batchId, batchId),
        eq(publicationSteps.stepType, 'create_ad'),
        eq(publicationSteps.status, 'succeeded'),
      )
    );

  const adIds = adSteps
    .map(s => (s.outputData as Record<string, unknown>)?.adId as string)
    .filter(Boolean);

  if (!adIds || adIds.length === 0) {
    return { activated: 0, reason: 'no_ads_to_activate' };
  }

  const results: { adId: string; success: boolean; error?: string }[] = [];

  for (const adId of adIds) {
    try {
      // Verificar status atual (idempotência: já está ACTIVE?)
      const ad = await meta.getAd(workspaceId, adId);
      if (ad.status === 'ACTIVE') {
        results.push({ adId, success: true });
        continue;
      }

      // Ativar
      await meta.updateAd(workspaceId, adId, { status: 'ACTIVE' });
      results.push({ adId, success: true });

      // Rate limit entre ativações
      await sleep(1000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ adId, success: false, error: msg });
      // Não falha o step inteiro — ativa o máximo possível
      // Ads que falharam podem ser retentados via retry do step
    }
  }

  const activated = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success);

  if (failed.length > 0 && activated === 0) {
    throw new Error(`Failed to activate all ${failed.length} ads: ${failed[0].error}`);
  }

  return {
    activated,
    failed: failed.length,
    failedAdIds: failed.map(f => f.adId),
    results,
  };
}
```

---

## 9. Criação de Batches (API)

### 9.1 Exemplo: migrar `runPublishPipeline` para batch

```typescript
/**
 * Cria um batch de publicação para um test round.
 * Substituí a chamada direta a runPublishPipeline().
 *
 * POST /api/test-rounds/publish → cria batch → retorna 202
 */
async function createTestRoundBatch(
  testRoundId: string,
  workspaceId: string,
  options?: { activationMode?: 'after_all' | 'immediate'; scheduledAt?: Date | null },
): Promise<string> {
  const activationMode = options?.activationMode ?? 'after_all';
  const scheduledAt = options?.scheduledAt ?? null;
  const initialStatus = scheduledAt ? 'scheduled' : 'pending';

  // 1. Carregar contexto
  const { round, variants, adSetTemplate } = await loadPublishContext(testRoundId, workspaceId);
  const variantPairs = groupVariantsByAd(variants);

  // 2. Criar batch
  const [batch] = await dbAdmin
    .insert(publicationBatches)
    .values({
      workspaceId,
      batchType: 'test_round_publish',
      status: initialStatus,
      priority: 10, // publicação = alta prioridade
      activationMode,
      scheduledAt,
      inputData: { testRoundId, campaignId: round.meta_campaign_id, activationMode },
      testRoundId,
      stepsTotal: 0, // será atualizado abaixo
    })
    .returning({ id: publicationBatches.id });

  const batchId = batch.id;
  let ordinal = 0;
  const createAdStepIds: string[] = [];
  const persistStepIds: string[] = [];

  // 3. Step 0: load_context (root, sem dependências)
  const loadCtxStep = await createStep(batchId, workspaceId, 'load_context', ordinal++, {
    testRoundId,
  });

  // 4. Para cada par Feed+Stories
  for (const pair of variantPairs) {
    // Step: verify_pre_publish
    const verifyPreStep = await createStep(batchId, workspaceId, 'verify_pre_publish', ordinal++, {
      adName: pair.adName,
      feedReady: !!pair.feed,
      storiesReady: !!pair.stories,
    });
    await createDependency(verifyPreStep, loadCtxStep);

    // Step: upload_image (Feed)
    let uploadFeedStep: string | null = null;
    if (pair.feed) {
      uploadFeedStep = await createStep(batchId, workspaceId, 'upload_image', ordinal++, {
        accountId: round.meta_account_id,
        imageSource: 'blob_url',
        blobUrl: pair.feed.blobUrl,
        filename: `${pair.adName}F.png`,
        placement: 'feed',
      });
      await createDependency(uploadFeedStep, verifyPreStep);
    }

    // Step: upload_image (Stories)
    let uploadStoriesStep: string | null = null;
    if (pair.stories) {
      uploadStoriesStep = await createStep(batchId, workspaceId, 'upload_image', ordinal++, {
        accountId: round.meta_account_id,
        imageSource: 'blob_url',
        blobUrl: pair.stories.blobUrl,
        filename: `${pair.adName}S.png`,
        placement: 'stories',
      });
      await createDependency(uploadStoriesStep, verifyPreStep);
    }

    // Step: create_ad_label (Feed + Stories) — paralelo com uploads
    const labelFeedStep = await createStep(batchId, workspaceId, 'create_ad_label', ordinal++, {
      accountId: round.meta_account_id,
      labelName: `${pair.adName}_feed`,
    });
    await createDependency(labelFeedStep, verifyPreStep);

    const labelStoriesStep = await createStep(batchId, workspaceId, 'create_ad_label', ordinal++, {
      accountId: round.meta_account_id,
      labelName: `${pair.adName}_stories`,
    });
    await createDependency(labelStoriesStep, verifyPreStep);

    // Step: create_creative (depende de uploads + labels)
    const createCreativeStep = await createStep(batchId, workspaceId, 'create_creative', ordinal++, {
      accountId: round.meta_account_id,
      adName: pair.adName,
      pageId: round.page_id,
      instagramUserId: round.instagram_user_id,
    });
    if (uploadFeedStep) {
      await createDependency(createCreativeStep, uploadFeedStep, 'imageHash', 'feedImageHash');
    }
    if (uploadStoriesStep) {
      await createDependency(createCreativeStep, uploadStoriesStep, 'imageHash', 'storiesImageHash');
    }
    await createDependency(createCreativeStep, labelFeedStep, 'labelId', 'feedLabelId');
    await createDependency(createCreativeStep, labelStoriesStep, 'labelId', 'storiesLabelId');

    // Step: create_adset (depende de load_context para template)
    const createAdsetStep = await createStep(batchId, workspaceId, 'create_adset', ordinal++, {
      accountId: round.meta_account_id,
      campaignId: round.meta_campaign_id,
      adSetTemplate,
    });
    await createDependency(createAdsetStep, loadCtxStep);

    // Step: create_ad (depende de creative + adset)
    // Recebe activationMode para decidir se cria ACTIVE ou PAUSED
    const createAdStep = await createStep(batchId, workspaceId, 'create_ad', ordinal++, {
      accountId: round.meta_account_id,
      adName: pair.adName,
      activationMode,
    });
    await createDependency(createAdStep, createCreativeStep, 'creativeId', 'creativeId');
    await createDependency(createAdStep, createAdsetStep, 'adSetId', 'adSetId');

    // Coletar step IDs de create_ad para o activate_ads final
    createAdStepIds.push(createAdStep);

    // Step: persist_results (depende de create_ad)
    const persistStep = await createStep(batchId, workspaceId, 'persist_results', ordinal++, {
      adName: pair.adName,
      variantIds: [pair.feed?.variantId, pair.stories?.variantId].filter(Boolean),
      creativeIds: [pair.feed?.creativeId, pair.stories?.creativeId].filter(Boolean),
      testRoundId,
    });
    await createDependency(persistStep, createAdStep, 'adId', 'metaAdId');

    persistStepIds.push(persistStep);
  }

  // Step: activate_ads (só no modo after_all)
  // Depende de TODOS os create_ad steps. Ativa todos os ads de uma vez.
  if (activationMode === 'after_all') {
    const activateStep = await createStep(batchId, workspaceId, 'activate_ads', ordinal++, {
      accountId: round.meta_account_id,
    });
    // Depende de todos os persist_results (que já dependem dos create_ad)
    // Isso garante que persist rodou antes de ativar
    for (const persistId of persistStepIds) {
      await createDependency(activateStep, persistId);
    }
    // Coletar ad IDs: cada create_ad propaga 'adId' → activate_ads recebe como 'adIds' (array)
    // NOTA: a propagação de outputs é 1:1 (outputKey → inputKey).
    // Para agregar N ad IDs em 1 array, o activate_ads handler busca
    // diretamente os outputs de todos os create_ad steps do batch:
    //   SELECT output_data->'adId' FROM publication_steps
    //   WHERE batch_id = ? AND step_type = 'create_ad' AND status = 'succeeded'
  }

  // Step final: verify_post_publish
  // (depende de activate_ads se after_all, ou de todos os persist_results se immediate)

  // 5. Atualizar stepsTotal
  const countResult = await dbAdmin.execute(sql`
    SELECT COUNT(*) as total FROM publication_steps WHERE batch_id = ${batchId}
  `);
  await dbAdmin
    .update(publicationBatches)
    .set({ stepsTotal: countResult[0].total })
    .where(eq(publicationBatches.id, batchId));

  return batchId;
}
```

### 9.2 Helpers de criação

```typescript
async function createStep(
  batchId: string,
  workspaceId: string,
  stepType: string,
  ordinal: number,
  inputData: Record<string, unknown>,
  options?: { isCritical?: boolean; maxAttempts?: number },
): Promise<string> {
  const [step] = await dbAdmin
    .insert(publicationSteps)
    .values({
      batchId,
      workspaceId,
      stepType,
      ordinal,
      inputData,
      isCritical: (options?.isCritical ?? true) ? 'true' : 'false',
      maxAttempts: options?.maxAttempts ?? 3,
    })
    .returning({ id: publicationSteps.id });
  return step.id;
}

async function createDependency(
  stepId: string,
  dependsOnStepId: string,
  outputKey?: string,
  inputKey?: string,
): Promise<void> {
  await dbAdmin
    .insert(stepDependencies)
    .values({ stepId, dependsOnStepId, outputKey, inputKey });
}
```

---

## 10. API Endpoints

### 10.1 Status do batch

```
GET /api/batches/{id}/status

Response:
{
  "batch": {
    "id": "uuid",
    "status": "running",
    "batchType": "test_round_publish",
    "priority": 10,
    "stepsTotal": 12,
    "stepsSucceeded": 7,
    "stepsFailed": 0,
    "stepsSkipped": 0,
    "progressPercent": 58,
    "createdAt": "...",
    "startedAt": "...",
    "estimatedCompletionAt": "..."
  },
  "steps": [
    {
      "id": "uuid",
      "stepType": "upload_image",
      "status": "succeeded",
      "ordinal": 2,
      "attempts": 1,
      "durationMs": 2340,
      "metaEntityId": "abc123",
      "metaEntityType": "image"
    },
    {
      "id": "uuid",
      "stepType": "create_creative",
      "status": "running",
      "ordinal": 5,
      "attempts": 1
    }
  ]
}
```

### 10.2 Cancelar batch

```
POST /api/batches/{id}/cancel

Response:
{ "status": "cancelled", "stepsAffected": 5 }
```

### 10.3 Retry batch (re-executar steps falhados)

```
POST /api/batches/{id}/retry

Efeito: steps com status 'failed' voltam para 'pending' com attempts resetado.
Response:
{ "status": "running", "stepsRetried": 2 }
```

### 10.4 Frontend Progress Contract (Supabase Realtime)

O frontend consome atualizações de progresso via **Supabase Realtime** — sem polling, sem SSE custom. O Supabase já está no stack e expõe WebSocket nativo para changes em tabelas com Realtime habilitado.

#### 10.4.1 Habilitação

Habilitar Realtime nas tabelas `publication_batches`, `publication_steps` e `step_events` via Supabase Dashboard (ou migration SQL):

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE publication_batches;
ALTER PUBLICATION supabase_realtime ADD TABLE publication_steps;
ALTER PUBLICATION supabase_realtime ADD TABLE step_events;
```

#### 10.4.2 Subscription no frontend

```typescript
import { supabase } from '@/lib/supabase-client';
import { useEffect, useState, useCallback } from 'react';

interface BatchProgress {
  batchId: string;
  status: string;
  stepsTotal: number;
  stepsSucceeded: number;
  stepsFailed: number;
  stepsSkipped: number;
  progressPercent: number;
  estimatedCompletionAt: string | null;
}

interface StepProgress {
  id: string;
  stepType: string;
  status: string;
  ordinal: number;
  attempts: number;
  maxAttempts: number;
  durationMs: number | null;
  lastError: string | null;
  lastErrorCode: string | null;
  nextRetryAt: string | null;
  metaEntityId: string | null;
  metaEntityType: string | null;
  // Progresso intra-step (para uploads de vídeo)
  progressData: { bytesUploaded?: number; totalBytes?: number; percent?: number } | null;
}

function useBatchProgress(batchId: string) {
  const [batch, setBatch] = useState<BatchProgress | null>(null);
  const [steps, setSteps] = useState<StepProgress[]>([]);

  useEffect(() => {
    // 1. Fetch inicial (estado atual)
    fetchBatchStatus(batchId).then(({ batch, steps }) => {
      setBatch(batch);
      setSteps(steps);
    });

    // 2. Subscribe a mudanças no batch
    const batchChannel = supabase
      .channel(`batch-${batchId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'publication_batches',
          filter: `id=eq.${batchId}`,
        },
        (payload) => {
          const row = payload.new;
          setBatch({
            batchId: row.id,
            status: row.status,
            stepsTotal: row.steps_total,
            stepsSucceeded: row.steps_succeeded,
            stepsFailed: row.steps_failed,
            stepsSkipped: row.steps_skipped,
            progressPercent: row.steps_total > 0
              ? Math.round(((row.steps_succeeded + row.steps_failed + row.steps_skipped) / row.steps_total) * 100)
              : 0,
            estimatedCompletionAt: row.estimated_completion_at,
          });
        }
      )
      .subscribe();

    // 3. Subscribe a mudanças nos steps deste batch
    const stepsChannel = supabase
      .channel(`steps-${batchId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'publication_steps',
          filter: `batch_id=eq.${batchId}`,
        },
        (payload) => {
          const row = payload.new;
          setSteps((prev) =>
            prev.map((s) =>
              s.id === row.id
                ? {
                    ...s,
                    status: row.status,
                    attempts: row.attempts,
                    durationMs: row.duration_ms,
                    lastError: row.last_error,
                    lastErrorCode: row.last_error_code,
                    nextRetryAt: row.next_retry_at,
                    metaEntityId: row.meta_entity_id,
                    metaEntityType: row.meta_entity_type,
                  }
                : s
            )
          );
        }
      )
      .subscribe();

    // 4. Subscribe a events (para progresso intra-step de vídeos)
    const eventsChannel = supabase
      .channel(`events-${batchId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'step_events',
          filter: `batch_id=eq.${batchId}`,
        },
        (payload) => {
          const row = payload.new;
          // Eventos de progresso intra-step (upload_progress)
          if (row.to_status === 'running' && row.metadata?.type === 'upload_progress') {
            setSteps((prev) =>
              prev.map((s) =>
                s.id === row.step_id
                  ? { ...s, progressData: row.metadata }
                  : s
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(batchChannel);
      supabase.removeChannel(stepsChannel);
      supabase.removeChannel(eventsChannel);
    };
  }, [batchId]);

  return { batch, steps };
}
```

#### 10.4.3 Mapeamento visual de estados

| Status do Step | Ícone | Cor | Texto |
|---|---|---|---|
| `pending` | `○` | cinza | "Aguardando" |
| `ready` | `◉` | azul | "Pronto" |
| `running` | spinner | azul animado | "Executando..." |
| `running` + progressData | spinner + % | azul animado | "Upload 45% (1.2MB/2.7MB)" |
| `succeeded` | `✓` | verde | "Concluído em 2.3s" |
| `retryable_failed` | `↻` | amarelo | "Retry em 18s (2/3)" |
| `failed` | `✕` | vermelho | "Falho: Rate limit" |
| `skipped` | `—` | cinza riscado | "Pulado (dep falhou)" |
| `cancelled` | `⊘` | cinza | "Cancelado" |

**Mapeamento de `lastErrorCode` para mensagem amigável:**

```typescript
const errorMessages: Record<string, string> = {
  META_RATE_LIMIT:  'Meta API sobrecarregada — aguardando retry automático',
  META_AUTH_EXPIRED: 'Token Meta expirado — reautenticação necessária',
  META_VALIDATION:  'Dados inválidos — verificar configuração do criativo',
  META_TEMPORARY:   'Erro temporário na Meta — retry automático',
  NETWORK:          'Falha de rede — retry automático',
  STORAGE:          'Erro no armazenamento de imagem',
  UNKNOWN:          'Erro inesperado — verificar logs',
};
```

#### 10.4.4 Progresso intra-step (upload de vídeo)

Uploads de vídeo podem levar 30-120s dependendo do tamanho. O handler `upload_video` emite eventos intermediários na `step_events` durante o upload, permitindo que o frontend mostre uma barra de progresso granular dentro do step.

**Handler com emissão de progresso:**

```typescript
async function handleUploadVideo(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const { fileUrl, filename, stepId, batchId } = input as {
    fileUrl: string; filename: string; stepId: string; batchId: string;
  };

  // Calcular tamanho total (HEAD request)
  const headRes = await fetch(fileUrl, { method: 'HEAD' });
  const totalBytes = parseInt(headRes.headers.get('content-length') || '0', 10);

  // Upload via Meta resumable upload API
  const uploadSessionId = await startResumableUpload(workspaceId, totalBytes, filename);

  let bytesUploaded = 0;
  const chunkSize = 4 * 1024 * 1024; // 4MB chunks

  while (bytesUploaded < totalBytes) {
    const end = Math.min(bytesUploaded + chunkSize, totalBytes);
    const chunk = await fetchRange(fileUrl, bytesUploaded, end);

    await uploadChunk(uploadSessionId, chunk, bytesUploaded, end, totalBytes);
    bytesUploaded = end;

    // Emitir evento de progresso (Supabase Realtime entrega ao frontend)
    await emitEvent(stepId, batchId, 'running', 'running', 'Upload progress', {
      type: 'upload_progress',
      bytesUploaded,
      totalBytes,
      percent: Math.round((bytesUploaded / totalBytes) * 100),
    });
  }

  const videoId = await finishResumableUpload(uploadSessionId);
  return { videoId, filename };
}
```

**Por que usar `step_events` e não um campo no step?** O Realtime do Supabase dispara em qualquer INSERT ou UPDATE. Mas atualizar `publication_steps` 10-20 vezes durante um upload poluiria o histórico da tabela principal. `step_events` é append-only e desenhada exatamente para isso — cada evento de progresso é um INSERT novo que o frontend consome via subscription e descarta após renderizar.

**Fallback para steps sem progresso intra-step:** steps que completam em <5s (upload_image, create_creative, create_ad) não emitem eventos intermediários — o spinner genérico é suficiente. O frontend lida com isso: se `progressData` é null, mostra spinner; se presente, mostra barra de progresso com percentual.

#### 10.4.5 ETA (tempo estimado de conclusão)

O worker calcula `estimated_completion_at` com base na média de duração dos steps já concluídos:

```typescript
async function updateETA(batchId: string): Promise<void> {
  const stats = await dbAdmin.execute(sql`
    SELECT
      AVG(duration_ms) FILTER (WHERE status = 'succeeded') as avg_duration_ms,
      COUNT(*) FILTER (WHERE status IN ('pending', 'ready', 'running', 'retryable_failed')) as remaining
    FROM publication_steps
    WHERE batch_id = ${batchId}
  `);

  const { avg_duration_ms, remaining } = stats[0];
  if (!avg_duration_ms || remaining === 0) return;

  const etaMs = avg_duration_ms * remaining;
  await dbAdmin
    .update(publicationBatches)
    .set({ estimatedCompletionAt: sql`NOW() + INTERVAL '${sql.raw(String(Math.ceil(etaMs / 1000)))} seconds'` })
    .where(eq(publicationBatches.id, batchId));
}
```

Chamado no `evaluateBatchCompletion()` para atualizar a cada ciclo do worker.

### 10.5 Pause / Resume (interrupção mid-publication)

Sim, a publicação pode ser pausada no meio. O mecanismo funciona em dois níveis:

#### 10.5.1 Pausa via API

```
POST /api/batches/{id}/pause

Response:
{
  "status": "paused",
  "stepsCompleted": 5,
  "stepsRemaining": 7,
  "currentStep": "create_creative",    // step que estava running (finaliza antes de pausar)
  "resumeAvailable": true
}
```

**O que acontece:**
1. O endpoint seta `status = 'paused'` no batch.
2. O worker, entre cada step, faz `getBatchStatus()` (seção 7.2.2). Se detecta `paused`, para de processar steps e libera o lock.
3. O step que estava em `running` no momento da pausa **completa normalmente** — não é interrompido no meio. A pausa só toma efeito **entre steps**, nunca dentro de um step. Isso evita estado inconsistente na Meta API (ex: creative criado mas ad não).
4. Steps `pending` e `ready` permanecem nesses estados, prontos para retomar.

**Granularidade:** a pausa é entre steps, não entre chamadas HTTP. Para um batch com 12 steps, se a pausa chega quando o step 5 está rodando, o step 5 completa (2-5s) e o step 6 não inicia.

#### 10.5.2 Resume via API

```
POST /api/batches/{id}/resume

Response:
{
  "status": "running",
  "stepsRemaining": 7,
  "nextStep": "create_adset"
}
```

**Implementação:**

```typescript
// POST /api/batches/{id}/resume
export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const batchId = params.id;

  // Verificar que batch existe, pertence ao workspace, e está pausado
  const [batch] = await withWorkspace(auth.workspace_id, async (tx) => {
    return tx.select().from(publicationBatches)
      .where(eq(publicationBatches.id, batchId))
      .limit(1);
  });

  if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
  if (batch.status !== 'paused') {
    return NextResponse.json(
      { error: `Batch status is '${batch.status}', expected 'paused'` },
      { status: 400 }
    );
  }

  // Voltar para running (worker vai pegar no próximo ciclo)
  await dbAdmin
    .update(publicationBatches)
    .set({ status: 'running', lockedBy: null, lockedAt: null })
    .where(eq(publicationBatches.id, batchId));

  const remaining = await dbAdmin.execute(sql`
    SELECT COUNT(*) as count FROM publication_steps
    WHERE batch_id = ${batchId} AND status IN ('pending', 'ready', 'retryable_failed')
  `);

  return NextResponse.json({
    status: 'running',
    stepsRemaining: remaining[0].count,
  });
}
```

#### 10.5.3 Cenários de uso

| Cenário | Ação do usuário | Comportamento |
|---|---|---|
| "Quero revisar antes de continuar" | Pause → inspecionar steps concluídos → Resume | Steps completados ficam; resume continua do ponto |
| "Errei o targeting, preciso corrigir" | Pause → ajustar config → Retry failed ou Cancel | Cancel descarta pendentes; pode criar novo batch |
| "Meta deu rate limit global" | Pause → esperar 15min → Resume | Melhor que deixar retries esgotar |
| "Deploy vai reiniciar o container" | Nada (automático) | Lock timeout 5min → worker reassume batch |

### 10.6 Publicação Agendada

O campo `scheduled_at` na tabela `publication_batches` habilita agendamento nativo. Quando preenchido, o batch é criado com `status = 'scheduled'` e o worker não o processa até que `scheduled_at <= NOW()`.

#### 10.6.1 Criação de batch agendado

```typescript
// POST /api/test-rounds/publish (com agendamento)
// Body: { test_round_id: string, scheduled_at?: string }

if (USE_STAGING_QUEUE) {
  const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;

  const batchId = await createTestRoundBatch(
    testRoundId,
    workspaceId,
    scheduledAt,   // null = execução imediata (status: pending)
  );

  return NextResponse.json({
    batchId,
    status: scheduledAt ? 'scheduled' : 'queued',
    scheduledAt: scheduledAt?.toISOString() || null,
  }, { status: 202 });
}
```

```typescript
async function createTestRoundBatch(
  testRoundId: string,
  workspaceId: string,
  scheduledAt: Date | null,
): Promise<string> {
  const initialStatus = scheduledAt ? 'scheduled' : 'pending';

  const [batch] = await dbAdmin
    .insert(publicationBatches)
    .values({
      workspaceId,
      batchType: 'test_round_publish',
      status: initialStatus,
      scheduledAt,
      testRoundId,
      inputData: { testRoundId },
      stepsTotal: 0, // preenchido ao criar steps
    })
    .returning({ id: publicationBatches.id });

  // Criar steps + deps (mesmo fluxo de antes)
  await createTestRoundSteps(batch.id, testRoundId, workspaceId);

  return batch.id;
}
```

#### 10.6.2 Cancelar/reagendar batch agendado

```
POST /api/batches/{id}/cancel         → cancela (funciona para scheduled)
PATCH /api/batches/{id}/schedule      → reagenda

PATCH body: { "scheduled_at": "2026-04-19T08:00:00Z" }
Response: { "status": "scheduled", "scheduledAt": "2026-04-19T08:00:00Z" }
```

```typescript
// PATCH /api/batches/{id}/schedule
// Só funciona para batches em status 'scheduled' ou 'pending'
if (!['scheduled', 'pending'].includes(batch.status)) {
  return NextResponse.json(
    { error: `Cannot reschedule batch in status '${batch.status}'` },
    { status: 400 }
  );
}

await dbAdmin
  .update(publicationBatches)
  .set({
    scheduledAt: new Date(body.scheduled_at),
    status: 'scheduled',
  })
  .where(eq(publicationBatches.id, batchId));
```

#### 10.6.3 Cenários de uso

| Cenário | Implementação |
|---|---|
| "Publicar amanhã às 8h" | `scheduled_at = '2026-04-19T08:00:00-03:00'` |
| "Agendar para segunda, início do horário comercial" | `scheduled_at = '2026-04-21T09:00:00-03:00'` |
| "Preparar batch agora, publicar quando eu mandar" | Criar como `scheduled` com `scheduled_at` futuro distante → PATCH para agora quando pronto |
| "Cancelar agendamento" | POST cancel (batch nunca executou, zero cleanup) |

**Nota sobre timezone:** o frontend envia `scheduled_at` com timezone explícito (ex: `-03:00` para BRT). O banco armazena em UTC. O worker compara com `NOW()` do Postgres (UTC). O frontend converte de volta para timezone local na exibição.

---

## 11. Reconciliation Job

```
POST /api/cron/reconcile-meta
Frequência: Semanal (domingo 3h UTC)
```

O job de reconciliação compara o state local com a Meta API:

1. Para cada batch `succeeded` dos últimos 7 dias:
   - GET ads criados via Meta API
   - Comparar com `publication_steps` que têm `metaEntityType = 'ad'`
   - Flag divergências: ad existe na Meta mas não localmente (fantasma) ou vice-versa
2. Para ads fantasma: criar registro em `published_ads` com `origin = 'reconciled'`
3. Para ads locais sem correspondência na Meta: marcar como `status = 'missing_in_meta'`
4. Emitir alerta se divergências > 0

---

## 12. Migração dos Endpoints Existentes

A migração é incremental. Cada endpoint ganha uma versão "batch" que cria o batch em vez de executar inline. Um feature flag controla qual path é usado.

### 12.1 Ordem de migração

| Endpoint | Prioridade | Complexidade | Nota |
|---|---|---|---|
| `test-rounds/publish` | 1 | Alta | Pipeline mais complexo, mais value |
| `ads/publish-to-adsets` | 2 | Média | Endpoint mais usado no dia-a-dia |
| `ads/publish-videos` | 3 | Média | Similar a publish-to-adsets |
| `ads/publish-carousel` | 4 | Média | Variação com cards |
| `ads/publish-external` | 5 | Baixa | Menos usado, Drive integration |

### 12.2 Feature flag

```typescript
// Período de transição: ambos os paths disponíveis
const USE_STAGING_QUEUE = process.env.USE_STAGING_QUEUE === 'true';

// POST /api/test-rounds/publish
if (USE_STAGING_QUEUE) {
  const batchId = await createTestRoundBatch(testRoundId, workspaceId);
  return NextResponse.json({ batchId, status: 'queued' }, { status: 202 });
} else {
  // Path legacy síncrono
  const result = await runPublishPipeline({ testRoundId, workspaceId });
  return NextResponse.json(result, { status: 200 });
}
```

### 12.3 Backward compatibility

- Endpoints legados continuam retornando `200` com resultado completo (síncrono)
- Novos endpoints retornam `202 Accepted` com `batchId` + `status` + `scheduledAt`
- UI usa `useBatchProgress(batchId)` (seção 10.4.2) para acompanhar em real-time via Supabase Realtime — sem polling HTTP
- Endpoints aceitam `scheduled_at` opcional no body para agendamento (seção 10.6)
- Novos endpoints de controle: pause, resume, schedule (seções 10.5, 10.6)

---

## 13. Integração com Import Pipeline (Fase 6)

A Staging Queue é a infraestrutura que o import pipeline da Fase 6 vai usar. Os step types `import_structure`, `import_image`, `import_video`, `import_insights` já estão declarados no registry.

O batch type `import_campaigns` usa prioridade 50 (inferior a publicação = 10), garantindo que imports pausam automaticamente quando há publicações pendentes (o worker pega o batch de menor `priority` primeiro).

O rate limiting adaptativo da Fase 6 (janela 4h, floor 30s) é implementado no nível do handler de cada step de import, não no worker — o worker só respeita o `sleep` entre steps.

---

## 14. Estimativa de Implementação

| Fase | Trabalho | Dias |
|---|---|---|
| Schemas Drizzle + migration | 4 tabelas + indexes + Realtime enable | 0.5 |
| Worker core (acquire, execute, DAG resolution, events) | Endpoint + helpers + pause check + schedule promote | 2 |
| Step handlers (extrair dos endpoints atuais) | 15+ handlers (incl. upload_video com progresso) | 2-3 |
| Migrar `test-rounds/publish` para batch | Primeiro endpoint | 1 |
| Migrar demais endpoints | 4 endpoints | 2-3 |
| Reconciliation job | Cron semanal | 0.5 |
| API de status + cancel + retry + pause + resume + schedule | 6 endpoints | 1 |
| Frontend progress hook (`useBatchProgress`) | Supabase Realtime subscription + UI de steps | 1-1.5 |
| Testes | Handlers + DAG + state machine + pause/resume | 1-2 |
| **Total** | | **12-15 dias** |

---

## 15. Contraditório

### "10-13 dias é muito para o volume atual"

FATO: o volume atual (1-3 publicações/dia) não justifica a complexidade isoladamente. Mas a Staging Queue serve de fundação para o import pipeline (Fase 6, 3-5 dias adicionais que usam a mesma infra). O custo total (Queue + Import) é menor que construir dois sistemas separados.

### "DAG é overengineering — ordem linear basta"

HIPÓTESE FORTE: para o `runPublishPipeline` atual, sim — os steps são quase lineares. Mas `publish-to-adsets` publica N ads em N adsets (N×N matrix), e o import pipeline processa centenas de entidades em paralelo. O DAG evita serialização desnecessária nesses cenários sem custo adicional nos cenários simples (DAG linear = lista).

### "after_all adiciona latência — ads ficam PAUSED esperando o último"

FATO: se o batch tem 3 ad sets × 5 ads = 15 create_ad steps + uploads + creatives, o tempo total pode ser 3-5 minutos. Com `immediate`, o primeiro ad começa a veicular em ~30s. Com `after_all`, todos esperam ~5 minutos. Para a RAT Academy com testes de criativos, esses 5 minutos são irrelevantes — o teste roda por dias. Para cenários de reposição urgente (ad pausado pelo kill rule, precisa de substituto imediato), `immediate` é o modo certo. Por isso a opção é configurável por publicação.

### "SKIP LOCKED não escala para múltiplos workers"

FATO para volume muito alto (>1000 batches/hora). Para o volume projetado (<100 batches/dia), single-instance com SKIP LOCKED é mais que suficiente. A promoção para múltiplos workers é trocar o cron por containers com loop infinito — zero mudança no código de aquisição.

### "Steps como tabela geram muitas rows"

HIPÓTESE FORTE: um test round com 5 variantes gera ~40 steps. 100 test rounds/mês = 4000 rows/mês em `publication_steps`. Em 1 ano = ~50k rows. Trivial para Postgres. `step_events` cresce mais (3-5× steps), mas é append-only e pode ser particionado por mês se necessário.

---

## 16. Débitos aceitos

| Débito | Severidade | Custo futuro |
|---|---|---|
| Sem throttling global cross-workspace | Baixa (hoje 2 workspaces ativos) | 0.5 dia |
| Sem two-phase commit (idempotência por verificação) | Baixa (<1 fantasma/mês) | Coberto por reconciliation |
| Sem blueprints (feature, não infra) | Nenhuma | 3 dias quando necessário |

---

## 17. Checklist de Validação

- [ ] 4 tabelas criadas com migration Drizzle + Realtime habilitado
- [ ] Worker processa batch pending → succeeded com DAG de 3+ steps
- [ ] Step falha → retryable_failed → retry com backoff → succeeded
- [ ] Step crítico falha definitivamente → batch failed + steps pendentes cancelled
- [ ] Step não-crítico falha → batch partial_success
- [ ] Lock timeout: worker B adquire batch abandonado por worker A
- [ ] Idempotência: re-execução de step não cria duplicata na Meta
- [ ] Events: toda transição de step gera registro em step_events
- [ ] Propagação de outputs: imageHash de upload aparece no input de create_creative
- [ ] `test-rounds/publish` funciona via batch (feature flag)
- [ ] Reconciliation job detecta ad fantasma
- [ ] Cancel: batch cancelled → steps pendentes cancelled
- [ ] Retry: batch failed → retry → steps falhados voltam para pending
- [ ] Prioridade: publicação (10) é processada antes de import (50)
- [ ] **Pause/Resume:** batch running → paused (entre steps) → resume → running
- [ ] **Pause não interrompe step ativo:** step em running completa antes da pausa tomar efeito
- [ ] **Scheduled:** batch scheduled → pending (quando scheduled_at <= NOW()) → running
- [ ] **Reschedule:** batch scheduled/pending pode ser reagendado via PATCH
- [ ] **Cancel scheduled:** batch scheduled pode ser cancelado sem side effects
- [ ] **Supabase Realtime:** frontend recebe updates de batch/steps sem polling
- [ ] **Progresso intra-step:** upload_video emite eventos de progresso via step_events
- [ ] **ETA:** estimated_completion_at atualizado a cada ciclo do worker
- [ ] **Activation after_all:** create_ad cria ads com PAUSED; activate_ads ativa todos no final
- [ ] **Activation immediate:** create_ad cria ads com ACTIVE (sem step activate_ads)
- [ ] **Cancel + after_all:** cancel mid-batch deixa ads PAUSED na Meta (zero spend)
- [ ] **Activation mode no frontend:** opção configurável por publicação, default after_all
