-- =============================================================================
-- Migration 0005 — templates table canonical
-- =============================================================================
-- A tabela `templates` foi criada originalmente de forma lazy via
-- `CREATE TABLE IF NOT EXISTS` dentro de /api/templates/route.ts (pattern
-- pré-Fase 1C). Ao migrar a rota para Drizzle na Wave 4, trouxemos o schema
-- para `src/lib/db/schema/intelligence.ts` e criamos esta migration
-- canonical/idempotente.
--
-- Schema alinhado com o que a rota criava:
--  - id: era TEXT PRIMARY KEY, agora uuid (defaultRandom). Migra legados
--    usando ::uuid se possível; inserções novas usam uuid.
--  - source_creative_id: era TEXT, agora uuid FK para creatives.id ON DELETE SET NULL.
--  - dimensions: jsonb.
--  - status: CHECK desativada (legado não é forçado no Drizzle — validação
--    fica na camada de aplicação).
--  - workspace_id: uuid FK para workspaces.
--
-- IF NOT EXISTS em tudo, compatível com ambientes onde a tabela já foi criada
-- pelo route no passado (com colunas TEXT — o gêmeo VPS vai executar um
-- ALTER TYPE manual caso detecte o tipo antigo).
-- =============================================================================

CREATE TABLE IF NOT EXISTS "templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid REFERENCES "workspaces"("id"),
  "name" text NOT NULL,
  "description" text,
  "funnel_key" text NOT NULL,
  "source_creative_id" uuid REFERENCES "creatives"("id") ON DELETE SET NULL,
  "dimensions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "prompt_fragment" text,
  "cpl_validated" double precision,
  "status" text NOT NULL DEFAULT 'active',
  "notes" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_funnel" ON "templates" ("funnel_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_status" ON "templates" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_templates_workspace" ON "templates" ("workspace_id");
--> statement-breakpoint
-- RLS: workspace_isolation policy alinhada com o resto das tabelas multi-tenant
ALTER TABLE "templates" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "workspace_isolation" ON "templates";
--> statement-breakpoint
CREATE POLICY "workspace_isolation" ON "templates"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
