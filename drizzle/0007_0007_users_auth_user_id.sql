-- =============================================================================
-- Migration 0007 — users.auth_user_id (liga profile local a auth.users gotrue)
-- =============================================================================
-- Fase 2 migra autenticação pra Supabase Auth (gotrue). Cada usuário em
-- public.users passa a ter um correspondente em auth.users (gerenciado pelo
-- gotrue). O elo é feito via a coluna `auth_user_id`.
--
-- Estratégia:
--  - `auth_user_id` é UUID nullable + UNIQUE. Durante a migração os usuários
--    existentes têm NULL até o script `phase-2-migrate-users-to-auth.ts`
--    criar os correspondentes via service_role e fazer o UPDATE.
--  - Depois da migração estável + 30 dias (Fase 2c), `auth_user_id` vira
--    NOT NULL e `password_hash` é removido.
--  - FK pra auth.users fica opcional agora — o schema auth é gerenciado pelo
--    gotrue, não pelo nosso Drizzle. Usar FK lógica via convenção.
-- =============================================================================

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "auth_user_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_auth_user_id" ON "users" ("auth_user_id")
  WHERE "auth_user_id" IS NOT NULL;
