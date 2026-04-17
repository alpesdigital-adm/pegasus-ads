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
    'lead_qualification_rules'
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

-- ── Resumo ───────────────────────────────────────────────────────────────
SELECT tablename,
       CASE WHEN rowsecurity THEN '✓ enabled'
            WHEN forcerowsecurity THEN '✓ forced'
            ELSE '✗ disabled' END AS rls_status
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename NOT LIKE '\_%'
  AND tablename != '__drizzle_migrations'
ORDER BY tablename;
