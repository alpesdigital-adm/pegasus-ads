-- =============================================================================
-- Migration 0009 — TD-005: consolidar settings global em workspace_settings
-- =============================================================================
-- Tabela `settings` (key TEXT primária, sem workspace_id) era legado. Tinha
-- só 2 classes de uso:
--   1. `last_ad_number` — fallback pro NamingService. Deveria ser
--      per-workspace (numeração de ads é escopada por workspace via RLS).
--   2. `apps_script_id`, `test_log_spreadsheet_id`, `test_log_last_sync` —
--      órfãs após remoção do Apps Script ecosystem (TD-013). Sem readers.
--
-- Esta migration move (1) pro workspace_settings do workspace mais antigo
-- e dropa as órfãs + a tabela global.
--
-- Idempotente: se settings não existe, DROP TABLE IF EXISTS não erra.
-- Se last_ad_number não existe em settings, INSERT SELECT retorna zero rows.
-- =============================================================================

BEGIN;

-- 1. Migra last_ad_number pra workspace_settings (workspace mais antigo)
DO $$
DECLARE
  v_workspace_id uuid;
  v_value text;
BEGIN
  -- Pega primeiro workspace (ordem de created_at)
  SELECT id INTO v_workspace_id FROM workspaces ORDER BY created_at LIMIT 1;

  IF v_workspace_id IS NULL THEN
    RAISE NOTICE 'Nenhum workspace existe — skip migração last_ad_number';
  ELSE
    -- Pega valor atual se existir
    SELECT value INTO v_value FROM settings WHERE key = 'last_ad_number';

    IF v_value IS NOT NULL THEN
      INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
      VALUES (v_workspace_id, 'last_ad_number', v_value, NOW())
      ON CONFLICT (workspace_id, key) DO NOTHING;
      RAISE NOTICE 'Migrado last_ad_number=% pra workspace %', v_value, v_workspace_id;
    ELSE
      RAISE NOTICE 'last_ad_number não existia em settings — skip';
    END IF;
  END IF;
END $$;

-- 2. Drop tabela settings (inclui as órfãs do Apps Script)
DROP TABLE IF EXISTS settings CASCADE;

COMMIT;
