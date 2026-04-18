-- =============================================================================
-- Migration 0008 — fecha a Fase 2 (PR 2c): remove sessions + password_hash
-- =============================================================================
-- Após o soak de 48h pós-deploy Fase 2b + validação do SSO via gotrue:
--  - sessions table fica obsoleta (Supabase JWT é stateless)
--  - password_hash sai de public.users (credencial mora em auth.users)
--  - auth_user_id vira NOT NULL (toda profile local referencia um gotrue user)
--
-- Executar em transação — qualquer falha aborta. Pré-requisito: todo user
-- em public.users DEVE ter auth_user_id populado. Se houver NULL, a migração
-- aborta antes do DROP (defensive SELECT no início).
-- =============================================================================

BEGIN;

-- Defensive: se algum user ficou sem auth_user_id, ABORTA.
DO $$
DECLARE
  orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphans FROM users WHERE auth_user_id IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'Migration 0008 aborted: % users sem auth_user_id. Rode scripts/phase-2-migrate-users-to-auth.ts antes.', orphans;
  END IF;
END $$;

--> statement-breakpoint
DROP TABLE IF EXISTS "sessions" CASCADE;
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "password_hash";
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "auth_user_id" SET NOT NULL;

COMMIT;
