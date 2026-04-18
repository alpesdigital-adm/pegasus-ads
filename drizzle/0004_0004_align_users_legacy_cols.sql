-- =============================================================================
-- Migration 0004 — alinha users com colunas legacy do Neon
-- =============================================================================
-- Descobertas no cutover 2026-04-18 (bridge step 0): users no Neon tinha 4
-- colunas que o schema Drizzle omitia.
--
-- IF NOT EXISTS: o gêmeo VPS já adicionou as colunas direto via ALTER no
-- pegasus_ads — esta migration é canonical/replayable mas não-destrutiva
-- em DBs onde já foi aplicada.
-- =============================================================================

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_id" integer;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role" varchar(20) DEFAULT 'viewer' NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_active" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_login_at" timestamp with time zone;
