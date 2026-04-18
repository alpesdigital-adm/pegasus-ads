-- =============================================================================
-- Migration 0010 — TD-007: Staging Queue v2
-- =============================================================================
-- Cria as 4 tabelas da orquestração assíncrona de publicação Meta Ads:
--   - publication_batches  (uma publicação)
--   - publication_steps    (unidade atômica retryable)
--   - step_dependencies    (DAG)
--   - step_events          (log append-only + progresso intra-step)
--
-- + 2 enums (batch_status, step_status)
-- + indexes (worker acquire, DAG resolution, retry promotion)
-- + RLS workspace_isolation nas 3 tabelas que expõem workspace_id
-- + ALTER PUBLICATION supabase_realtime (frontend subscribe via Realtime)
--
-- Spec completa: docs/staging-queue-v2.md
-- Schema Drizzle espelho: src/lib/db/schema/staging-queue.ts
--
-- Idempotente:
--   - CREATE TYPE IF NOT EXISTS via DO block (Postgres não suporta IF NOT
--     EXISTS em CREATE TYPE diretamente)
--   - CREATE TABLE IF NOT EXISTS
--   - CREATE INDEX IF NOT EXISTS
--   - ALTER PUBLICATION ADD TABLE ... IF NOT EXISTS (Postgres 15+)
-- =============================================================================

BEGIN;

-- ─── enums ────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE batch_status AS ENUM (
    'scheduled',
    'pending',
    'running',
    'paused',
    'partial_success',
    'succeeded',
    'failed',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE step_status AS ENUM (
    'pending',
    'ready',
    'running',
    'succeeded',
    'retryable_failed',
    'failed',
    'skipped',
    'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ─── publication_batches ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "publication_batches" (
  "id"                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id"            uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "batch_type"              text NOT NULL,
  "status"                  batch_status NOT NULL DEFAULT 'pending',
  "priority"                integer NOT NULL DEFAULT 10,
  "activation_mode"         text NOT NULL DEFAULT 'after_all',
  "input_data"              jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_data"             jsonb DEFAULT '{}'::jsonb,
  "test_round_id"           uuid,
  "import_job_id"           uuid,
  "steps_total"             integer NOT NULL DEFAULT 0,
  "steps_succeeded"         integer NOT NULL DEFAULT 0,
  "steps_failed"            integer NOT NULL DEFAULT 0,
  "steps_skipped"           integer NOT NULL DEFAULT 0,
  "scheduled_at"            timestamptz,
  "created_at"              timestamptz NOT NULL DEFAULT NOW(),
  "started_at"              timestamptz,
  "completed_at"            timestamptz,
  "estimated_completion_at" timestamptz,
  "error_message"           text,
  "error_context"           jsonb,
  "locked_by"               text,
  "locked_at"               timestamptz,
  CONSTRAINT "chk_pb_batch_type" CHECK (batch_type IN (
    'test_round_publish','publish_to_adsets','publish_carousel',
    'publish_videos','publish_external','import_campaigns'
  )),
  CONSTRAINT "chk_pb_activation_mode" CHECK (activation_mode IN ('after_all','immediate'))
);
--> statement-breakpoint

-- Worker acquire: WHERE status IN ('pending','running') ORDER BY priority, created_at FOR UPDATE SKIP LOCKED
CREATE INDEX IF NOT EXISTS "idx_pb_status_priority_created"
  ON "publication_batches" ("status", "priority", "created_at");
--> statement-breakpoint

-- API list per-workspace
CREATE INDEX IF NOT EXISTS "idx_pb_workspace_status"
  ON "publication_batches" ("workspace_id", "status");
--> statement-breakpoint

-- ─── publication_steps ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "publication_steps" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "batch_id"           uuid NOT NULL REFERENCES "publication_batches"("id") ON DELETE CASCADE,
  "workspace_id"       uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "step_type"          text NOT NULL,
  "ordinal"            integer NOT NULL DEFAULT 0,
  "status"             step_status NOT NULL DEFAULT 'pending',
  "is_critical"        text NOT NULL DEFAULT 'true',
  "input_data"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "output_data"        jsonb DEFAULT '{}'::jsonb,
  "attempts"           integer NOT NULL DEFAULT 0,
  "max_attempts"       integer NOT NULL DEFAULT 3,
  "last_error"         text,
  "last_error_code"    text,
  "next_retry_at"      timestamptz,
  "meta_entity_id"     text,
  "meta_entity_type"   text,
  "created_at"         timestamptz NOT NULL DEFAULT NOW(),
  "started_at"         timestamptz,
  "completed_at"       timestamptz,
  "duration_ms"        integer,
  CONSTRAINT "chk_ps_step_type" CHECK (step_type IN (
    'upload_image','upload_video',
    'create_ad_label',
    'create_creative','create_carousel_creative',
    'create_adset','clone_adset',
    'create_ad',
    'verify_pre_publish','verify_post_publish',
    'load_context','resolve_model_ad','list_adsets','download_drive_files',
    'activate_ads',
    'persist_results',
    'import_structure','import_image','import_video','import_insights'
  )),
  CONSTRAINT "chk_ps_is_critical" CHECK (is_critical IN ('true','false'))
);
--> statement-breakpoint

-- Worker resolveReadySteps
CREATE INDEX IF NOT EXISTS "idx_ps_batch_status"
  ON "publication_steps" ("batch_id", "status");
--> statement-breakpoint

-- activate_ads lista create_ad steps do batch
CREATE INDEX IF NOT EXISTS "idx_ps_batch_step_type"
  ON "publication_steps" ("batch_id", "step_type");
--> statement-breakpoint

-- Promoção retryable_failed → ready quando next_retry_at <= NOW()
CREATE INDEX IF NOT EXISTS "idx_ps_status_next_retry"
  ON "publication_steps" ("status", "next_retry_at")
  WHERE "next_retry_at" IS NOT NULL;
--> statement-breakpoint

-- ─── step_dependencies ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "step_dependencies" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "step_id"             uuid NOT NULL REFERENCES "publication_steps"("id") ON DELETE CASCADE,
  "depends_on_step_id"  uuid NOT NULL REFERENCES "publication_steps"("id") ON DELETE CASCADE,
  "output_key"          text,
  "input_key"           text,
  CONSTRAINT "chk_sd_no_self" CHECK (step_id <> depends_on_step_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sd_step"
  ON "step_dependencies" ("step_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_sd_depends_on"
  ON "step_dependencies" ("depends_on_step_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sd_step_depends_on"
  ON "step_dependencies" ("step_id", "depends_on_step_id");
--> statement-breakpoint

-- ─── step_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "step_events" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "step_id"       uuid NOT NULL REFERENCES "publication_steps"("id") ON DELETE CASCADE,
  "batch_id"      uuid NOT NULL REFERENCES "publication_batches"("id") ON DELETE CASCADE,
  "workspace_id"  uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "from_status"   text NOT NULL,
  "to_status"     text NOT NULL,
  "message"       text,
  "metadata"      jsonb DEFAULT '{}'::jsonb,
  "created_at"    timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_se_batch_created"
  ON "step_events" ("batch_id", "created_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_se_step"
  ON "step_events" ("step_id");
--> statement-breakpoint

-- ─── RLS ──────────────────────────────────────────────────────────────────
-- Padrão: workspace_id::text = current_setting('app.workspace_id', true)
-- Worker usa dbAdmin (BYPASSRLS) + filtro manual de workspace (pattern CRM).
-- APIs/frontend usam withWorkspace() → SET LOCAL → RLS aplica.
-- step_dependencies NÃO tem RLS: só worker/admin acessa, frontend não lê.

ALTER TABLE "publication_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "publication_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_isolation" ON "publication_batches";
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "publication_batches"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint

ALTER TABLE "publication_steps" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "publication_steps" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_isolation" ON "publication_steps";
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "publication_steps"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint

ALTER TABLE "step_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "step_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_isolation" ON "step_events";
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "step_events"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
--> statement-breakpoint

-- ─── Realtime publication ─────────────────────────────────────────────────
-- Frontend subscribe em 3 canais:
--   batch-{batchId}    → UPDATE em publication_batches
--   steps-{batchId}    → UPDATE em publication_steps
--   events-{batchId}   → INSERT em step_events (progresso intra-step)
--
-- step_dependencies NÃO entra no realtime (topologia do DAG é estática
-- após criação do batch).
--
-- GUARD CONDICIONAL (descoberta 2026-04-18 pelo gêmeo VPS): a publication
-- `supabase_realtime` existe HOJE apenas no DB `postgres` do cluster; o
-- container alpes-ads_supabase-realtime-1 aponta pra DB_NAME=postgres, não
-- pegasus_ads. Consequência: mesmo se criássemos a publication aqui, ela
-- ficaria órfã (acumulando WAL sem consumer). Débito nomeado como TD-015
-- no docs/tech-debt.md.
--
-- Por isso cada bloco abaixo verifica se a publication existe neste DB
-- antes de ADD TABLE. Quando o Realtime for wireado pro pegasus_ads (via
-- container dedicado, multi-tenant no container atual, ou outra abordagem),
-- uma migration futura adiciona as 3 tables à publication — sem bloquear
-- a Staging Queue de entrar em produção agora. Worker opera via cron,
-- independente de Realtime.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE publication_batches;
  ELSE
    RAISE NOTICE 'supabase_realtime não existe neste DB — publication_batches fica fora do Realtime até TD-015 ser endereçado';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE publication_steps;
  ELSE
    RAISE NOTICE 'supabase_realtime não existe neste DB — publication_steps fica fora do Realtime até TD-015 ser endereçado';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE step_events;
  ELSE
    RAISE NOTICE 'supabase_realtime não existe neste DB — step_events fica fora do Realtime até TD-015 ser endereçado';
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint

-- ─── Owner + grants pro role pegasus_ads_app ─────────────────────────────
-- Migration roda via `-U supabase_admin` (gotcha do TD-005); precisamos:
--   1. Realinhar owner pra pegasus_ads_admin (alinha com pattern da
--      migration 0006). Isso garante que DEFAULT PRIVILEGES existentes
--      em favor de pegasus_ads_app disparem em alterações futuras.
--   2. GRANT explícito pro app user (não-owner, sem BYPASSRLS).

ALTER TABLE "publication_batches" OWNER TO "pegasus_ads_admin";
--> statement-breakpoint
ALTER TABLE "publication_steps"   OWNER TO "pegasus_ads_admin";
--> statement-breakpoint
ALTER TABLE "step_dependencies"   OWNER TO "pegasus_ads_admin";
--> statement-breakpoint
ALTER TABLE "step_events"         OWNER TO "pegasus_ads_admin";
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "publication_batches" TO "pegasus_ads_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "publication_steps"    TO "pegasus_ads_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "step_dependencies"    TO "pegasus_ads_app";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "step_events"          TO "pegasus_ads_app";
--> statement-breakpoint

COMMIT;
