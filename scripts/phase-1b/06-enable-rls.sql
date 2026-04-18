-- =============================================================================
-- Pegasus Ads — Fase 1B / Step 06: Habilitar RLS + policies workspace_isolation
-- =============================================================================
-- RODAR COMO: pegasus_ads_admin (BYPASSRLS — para criar policies, não as aplica
--              a si mesmo)
-- COMANDO: docker exec -i alpes-ads_supabase-db-1 \
--            psql -U pegasus_ads_admin -d pegasus_ads -v ON_ERROR_STOP=1 \
--            -f scripts/phase-1b/06-enable-rls.sql
-- IDEMPOTÊNCIA: usa DROP POLICY IF EXISTS antes de CREATE
--
-- IMPORTANTE:
--   - Tabelas SEM workspace_id NÃO ganham policy: plans, settings, prompts,
--     creative_edges (DEPRECATED — vai ganhar workspace_id), creative_ref_images
--     (mesma coisa), users, sessions, api_keys
--   - api_keys TEM workspace_id mas NÃO ganha policy nesta fase porque o auth
--     ainda usa Supabase Auth não-implementado (Fase 2). Ativar policy depois.
--   - Tabelas Creative Intelligence (offers, concepts, angles, launches,
--     ad_creatives) NÃO entram aqui — vão entrar em PR separado quando os
--     schemas Drizzle forem adicionados (TD-008)
-- =============================================================================

DO $$
DECLARE
  tbl TEXT;
  -- Tabelas com workspace_id (a serem RLS-isoladas)
  -- creative_edges e creative_ref_images entram após adicionar workspace_id
  -- redundante (Fase 1A já tem no schema; restore preencherá via UPDATE)
  tables_with_ws TEXT[] := ARRAY[
    'workspaces',          -- isola por id
    'workspace_members',   -- isola por workspace_id
    'workspace_settings',
    'workspace_meta_accounts',
    'images',
    'creatives',
    'metrics',
    'metrics_breakdowns',
    'metrics_demographics',
    'campaigns',
    'funnels',
    'test_rounds',
    'published_ads',
    'pipeline_executions',
    'alerts',
    'visual_elements',
    'hypotheses',
    'crm_leads',
    'lead_qualification_rules',
    -- Creative Intelligence (TD-008, adicionadas na Fase 1B)
    'offers',              -- workspace_id direto
    'launches',            -- workspace_id direto
    'ad_creatives',        -- workspace_id direto
    -- Legacy extras com workspace_id (commit 574a412)
    'projects',            -- workspace_id direto
    'crm_import_mappings'  -- workspace_id direto
    -- concepts: NÃO tem workspace_id (herda de offers via FK)
    -- angles: idem (herda de concepts)
    -- classified_insights: NÃO tem workspace_id próprio — RLS via JOIN
    --   com ad_creatives.ad_name (atribuição). Tratado em bloco separado.
    -- TABELAS GLOBAIS SEM RLS (acesso só via dbAdmin):
    --   plans, settings, prompts, users, sessions, api_keys
    --   ad_accounts, ad_insights, hourly_insights, sync_logs
    --   accounts, lead_sources, leads
    --   classification_rules, saved_views
  ];
  ws_col TEXT;
BEGIN
  FOREACH tbl IN ARRAY tables_with_ws LOOP
    -- workspaces usa "id" como discriminator; demais usam "workspace_id"
    IF tbl = 'workspaces' THEN
      ws_col := 'id';
    ELSE
      ws_col := 'workspace_id';
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (%I::text = current_setting(''app.workspace_id'', true)) '
      'WITH CHECK (%I::text = current_setting(''app.workspace_id'', true))',
      tbl, ws_col, ws_col
    );

    RAISE NOTICE 'RLS ativo em % (discriminator: %)', tbl, ws_col;
  END LOOP;
END $$;

-- ── test_round_variants: RLS via JOIN com test_rounds ───────────────────
-- Não tem workspace_id próprio. Policy usa subquery.
ALTER TABLE test_round_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE test_round_variants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON test_round_variants;
CREATE POLICY workspace_isolation ON test_round_variants
  USING (
    EXISTS (
      SELECT 1 FROM test_rounds r
      WHERE r.id = test_round_variants.test_round_id
        AND r.workspace_id::text = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM test_rounds r
      WHERE r.id = test_round_variants.test_round_id
        AND r.workspace_id::text = current_setting('app.workspace_id', true)
    )
  );

-- ── creative_edges + creative_ref_images: workspace_id redundante ───────
-- Fase 1A já criou colunas com defaultRandom(); aqui populamos a partir do
-- creative associado (criando relação) e habilitamos RLS direto via WS.

UPDATE creative_edges ce
SET workspace_id = c.workspace_id
FROM creatives c
WHERE ce.workspace_id IS NULL
  AND c.id = ce.source_id;

UPDATE creative_ref_images cr
SET workspace_id = c.workspace_id
FROM creatives c
WHERE cr.workspace_id IS NULL
  AND c.id = cr.creative_id;

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['creative_edges', 'creative_ref_images'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY workspace_isolation ON %I '
      'USING (workspace_id::text = current_setting(''app.workspace_id'', true)) '
      'WITH CHECK (workspace_id::text = current_setting(''app.workspace_id'', true))',
      tbl
    );
    RAISE NOTICE 'RLS ativo em % (workspace_id redundante)', tbl;
  END LOOP;
END $$;

-- ── concepts + angles: RLS via JOIN com offers ───────────────────────
-- Tabelas Creative Intelligence sem workspace_id direto. Policy faz lookup
-- pelo offers associado.

ALTER TABLE concepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON concepts;
CREATE POLICY workspace_isolation ON concepts
  USING (
    EXISTS (
      SELECT 1 FROM offers o
      WHERE o.id = concepts.offer_id
        AND o.workspace_id::text = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM offers o
      WHERE o.id = concepts.offer_id
        AND o.workspace_id::text = current_setting('app.workspace_id', true)
    )
  );

ALTER TABLE angles ENABLE ROW LEVEL SECURITY;
ALTER TABLE angles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON angles;
CREATE POLICY workspace_isolation ON angles
  USING (
    EXISTS (
      SELECT 1 FROM concepts c
      JOIN offers o ON o.id = c.offer_id
      WHERE c.id = angles.concept_id
        AND o.workspace_id::text = current_setting('app.workspace_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM concepts c
      JOIN offers o ON o.id = c.offer_id
      WHERE c.id = angles.concept_id
        AND o.workspace_id::text = current_setting('app.workspace_id', true)
    )
  );

-- ── classified_insights: RLS via JOIN com ad_creatives ──────────────────
-- Sem workspace_id próprio. Atribuição via ad_name (UTM).
-- IMPORTANTE: rows sem ad_creatives correspondente ficam INVISÍVEIS — pode
-- ser problema se sync-all popular insights antes de ad_creatives existir.
-- AÇÃO: avaliar se devemos usar dbAdmin para sync-all (BYPASSRLS) — provável SIM.

ALTER TABLE classified_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE classified_insights FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON classified_insights;
CREATE POLICY workspace_isolation ON classified_insights
  USING (
    EXISTS (
      SELECT 1 FROM ad_creatives ac
      WHERE ac.ad_name = classified_insights.ad_name
        AND ac.workspace_id::text = current_setting('app.workspace_id', true)
    )
  );
-- Sem WITH CHECK — INSERTs vêm de cron com dbAdmin (BYPASSRLS).

-- ── Resumo ───────────────────────────────────────────────────────────────
-- Fix #11: `forcerowsecurity` na pg_tables só existe em Pg16+. No Pg15.8
-- (cluster atual do Supabase self-hosted) precisamos ler de pg_class.
SELECT c.relname AS tablename,
       CASE WHEN c.relrowsecurity AND c.relforcerowsecurity THEN '✓ enabled + forced'
            WHEN c.relrowsecurity                          THEN '✓ enabled'
            ELSE '✗ disabled' END AS rls_status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname NOT LIKE '\_%'
  AND c.relname != '__drizzle_migrations'
ORDER BY c.relname;
