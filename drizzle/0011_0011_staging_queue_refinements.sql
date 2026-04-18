-- =============================================================================
-- Migration 0011 — TD-007 Fase 2 refinements
-- =============================================================================
-- Refinamentos descobertos na peer review da regra de finalizeBatch:
--
-- 1. step_events.step_id agora NULLABLE. Motivação: finalizeBatch emite
--    evento "meta" de batch-level (transição test_rounds.status → live/failed
--    com racional), que não pertence a um step específico. Alternativas
--    rejeitadas: tabela batch_events separada (mais complexidade) ou
--    FK sentinela (viola integridade referencial).
--
-- 2. test_rounds.published_at adicionado. Marca quando o batch finalizou
--    com status 'live' (ads ativos na Meta). Distinto de updated_at
--    (usado em toda transição) e decided_at (winner/loser/inconclusive).
--    Nullable porque rounds em draft/reviewing/failed nunca publicam.
--
-- Idempotente (IF NOT EXISTS, ALTER COLUMN é OK rodar 2x).
-- =============================================================================

BEGIN;

-- 1. Tornar step_events.step_id nullable
ALTER TABLE "step_events"
  ALTER COLUMN "step_id" DROP NOT NULL;
--> statement-breakpoint

-- 2. Adicionar test_rounds.published_at
ALTER TABLE "test_rounds"
  ADD COLUMN IF NOT EXISTS "published_at" timestamptz;
--> statement-breakpoint

COMMIT;
