-- =============================================================================
-- Migration 0003 — relax classified_insights FKs
-- =============================================================================
-- Contexto: FKs insight_id → ad_insights e account_id → ad_accounts foram
-- declaradas no schema Drizzle mas NUNCA CRIADAS em runtime (gêmeo VPS fez
-- DROP+ADD COLUMN durante migration 0002 manual, perdendo-as).
-- Também remove NOT NULL de insight_id (route legacy passa NULL agora).
--
-- IF EXISTS nos DROPs porque no pegasus_ads atual as FKs não existem.
-- Em qualquer banco limpo (0000+0001+0002 aplicadas em sequência), elas
-- existiriam — então o IF EXISTS é idempotente, não mascara.
-- =============================================================================

ALTER TABLE "classified_insights" DROP CONSTRAINT IF EXISTS "classified_insights_insight_id_ad_insights_id_fk";
--> statement-breakpoint
ALTER TABLE "classified_insights" DROP CONSTRAINT IF EXISTS "classified_insights_account_id_ad_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "classified_insights" ALTER COLUMN "insight_id" DROP NOT NULL;
