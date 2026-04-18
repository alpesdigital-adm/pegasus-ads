-- =============================================================================
-- Migration 0006 — realinha ownership/grants de `templates`
-- =============================================================================
-- A migration 0005 foi aplicada em prod usando a role `supabase_admin`
-- (fallback do docker exec pra psql -U postgres) em vez de pegasus_ads_admin.
-- Resultado: tabela criada com owner errado e SEM os GRANTs automáticos pra
-- pegasus_ads_app (as DEFAULT PRIVILEGES só disparam quando o owner default
-- cria a tabela). Sintomatologia: qualquer SELECT/INSERT via withWorkspace()
-- retornaria permission denied.
--
-- Gêmeo VPS corrigiu manualmente em 2026-04-18 — esta migration é o rastro
-- formal (idempotente) pra garantir que ambientes recriados do zero caiam no
-- mesmo estado sem depender de intervenção manual.
-- =============================================================================

ALTER TABLE "templates" OWNER TO "pegasus_ads_admin";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "templates" TO "pegasus_ads_app";
--> statement-breakpoint
-- templates não tem colunas SERIAL/IDENTITY (id é uuid defaultRandom), mas
-- mantemos o GRANT USAGE em sequences pro caso de ALTER futuro.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO "pegasus_ads_app";
