import { Pool } from "@neondatabase/serverless";

// Interface compatible with existing routes
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DbClient {
  execute(query: string | { sql: string; args?: unknown[] }): Promise<QueryResult>;
}

function getConnectionString(): string {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) {
    throw new Error("DATABASE_URL or POSTGRES_URL environment variable is required");
  }
  return url;
}

// Convert ? placeholders to $1, $2, ... for Postgres
function convertPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function createClient(): DbClient {
  return {
    async execute(query: string | { sql: string; args?: unknown[] }): Promise<QueryResult> {
      let queryText: string;
      let params: unknown[] = [];

      if (typeof query === "string") {
        queryText = convertPlaceholders(query);
      } else {
        queryText = convertPlaceholders(query.sql);
        params = query.args || [];
      }

      const pool = new Pool({ connectionString: getConnectionString() });
      try {
        const result = await pool.query(queryText, params);
        return {
          rows: result.rows as Record<string, unknown>[],
          rowCount: result.rowCount ?? result.rows.length,
        };
      } finally {
        // End pool to avoid connection leaks in serverless
        await pool.end();
      }
    },
  };
}

let client: DbClient | null = null;

export function getDb(): DbClient {
  if (!client) {
    client = createClient();
  }
  return client;
}

export async function initDb(): Promise<DbClient> {
  const db = getDb();
  const pool = new Pool({ connectionString: getConnectionString() });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS images (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('dra-priscila', 'marca', 'produto', 'referencia')),
        blob_url TEXT NOT NULL,
        thumbnail_url TEXT,
        width INTEGER,
        height INTEGER,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS creatives (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        blob_url TEXT NOT NULL,
        thumbnail_url TEXT,
        prompt TEXT,
        prompt_json TEXT,
        model TEXT DEFAULT 'gemini-2.5-flash-image',
        width INTEGER,
        height INTEGER,
        parent_id TEXT REFERENCES creatives(id),
        generation INTEGER DEFAULT 0,
        status TEXT DEFAULT 'generated' CHECK(status IN ('generated', 'testing', 'winner', 'killed', 'paused')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS creative_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES creatives(id),
        target_id TEXT NOT NULL REFERENCES creatives(id),
        relationship TEXT DEFAULT 'variation' CHECK(relationship IN ('variation', 'iteration', 'style-transfer', 'remix')),
        variable_isolated TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS creative_ref_images (
        id TEXT PRIMARY KEY,
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        image_id TEXT NOT NULL REFERENCES images(id),
        role TEXT DEFAULT 'reference' CHECK(role IN ('reference', 'style', 'character', 'composition')),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        date TEXT NOT NULL,
        spend DOUBLE PRECISION DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        cpm DOUBLE PRECISION DEFAULT 0,
        ctr DOUBLE PRECISION DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        cpc DOUBLE PRECISION DEFAULT 0,
        leads INTEGER DEFAULT 0,
        cpl DOUBLE PRECISION,
        meta_ad_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(creative_id, date)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        creative_id TEXT REFERENCES creatives(id),
        prompt_text TEXT NOT NULL,
        prompt_format TEXT DEFAULT 'text' CHECK(prompt_format IN ('text', 'json', 'markdown')),
        model TEXT,
        reference_image_ids JSONB DEFAULT '[]',
        response_raw TEXT,
        tokens_used INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Delivery 1: Test Automation tables ──

    await pool.query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        meta_campaign_id TEXT NOT NULL,
        meta_account_id TEXT NOT NULL,
        pixel_id TEXT,
        page_id TEXT,
        instagram_user_id TEXT,
        objective TEXT DEFAULT 'OUTCOME_LEADS',
        cpl_target DOUBLE PRECISION,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'archived')),
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_rounds (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL REFERENCES campaigns(id),
        control_creative_id TEXT NOT NULL REFERENCES creatives(id),
        variable_type TEXT NOT NULL,
        variable_value TEXT,
        round_number INTEGER NOT NULL DEFAULT 1,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'generating', 'reviewing', 'publishing', 'live', 'analyzing', 'decided', 'failed')),
        ai_prompt_used TEXT,
        ai_verification JSONB DEFAULT '{}',
        decided_at TIMESTAMPTZ,
        decision TEXT CHECK(decision IN ('winner', 'loser', 'inconclusive')),
        decision_reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS test_round_variants (
        id TEXT PRIMARY KEY,
        test_round_id TEXT NOT NULL REFERENCES test_rounds(id),
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        role TEXT NOT NULL DEFAULT 'variant' CHECK(role IN ('control', 'variant')),
        placement TEXT CHECK(placement IN ('feed', 'stories', 'both')),
        meta_ad_id TEXT,
        meta_adset_id TEXT,
        meta_creative_id TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'generated', 'verified', 'published', 'live', 'paused', 'killed')),
        verification_result JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS published_ads (
        id TEXT PRIMARY KEY,
        variant_id TEXT NOT NULL REFERENCES test_round_variants(id),
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        meta_ad_id TEXT NOT NULL,
        meta_adset_id TEXT NOT NULL,
        meta_creative_id TEXT NOT NULL,
        meta_image_hash TEXT,
        ad_name TEXT NOT NULL,
        adset_name TEXT NOT NULL,
        placement TEXT NOT NULL CHECK(placement IN ('feed', 'stories')),
        status TEXT DEFAULT 'pending_review' CHECK(status IN ('pending_review', 'active', 'paused', 'rejected', 'deleted')),
        drive_file_id TEXT,
        drive_file_name TEXT,
        published_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pipeline_executions (
        id TEXT PRIMARY KEY,
        test_round_id TEXT REFERENCES test_rounds(id),
        pipeline_type TEXT NOT NULL CHECK(pipeline_type IN ('generate', 'publish', 'analyze', 'kill')),
        status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'cancelled')),
        input_data JSONB DEFAULT '{}',
        output_data JSONB DEFAULT '{}',
        error_message TEXT,
        steps JSONB DEFAULT '[]',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        duration_ms INTEGER
      )
    `);

    // ── Tarefa 2.2: Breakdowns por posicionamento ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metrics_breakdowns (
        id TEXT PRIMARY KEY,
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        date TEXT NOT NULL,
        publisher_platform TEXT NOT NULL DEFAULT '',
        platform_position TEXT NOT NULL DEFAULT '',
        spend DOUBLE PRECISION DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        cpm DOUBLE PRECISION DEFAULT 0,
        ctr DOUBLE PRECISION DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        cpc DOUBLE PRECISION DEFAULT 0,
        leads INTEGER DEFAULT 0,
        cpl DOUBLE PRECISION,
        meta_ad_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(creative_id, date, publisher_platform, platform_position)
      )
    `);

    // ── Tarefa 3.2: is_control na tabela creatives ──
    await pool.query(`
      ALTER TABLE creatives
      ADD COLUMN IF NOT EXISTS is_control BOOLEAN DEFAULT FALSE
    `);
    // Inicializar: o primeiro AD com generation=0 que tenha métricas vira o controle
    // (somente se nenhum criativo já tem is_control=true)
    await pool.query(`
      UPDATE creatives
      SET is_control = TRUE
      WHERE id IN (
        SELECT c.id FROM creatives c
        JOIN metrics m ON m.creative_id = c.id
        WHERE c.generation = 0
        GROUP BY c.id
        HAVING SUM(m.leads) > 0
        ORDER BY c.created_at ASC
        LIMIT 2
      )
      AND NOT EXISTS (SELECT 1 FROM creatives WHERE is_control = TRUE)
    `);

    // ── Tarefa 2.8: LPV (Landing Page Views) na tabela metrics ──
    await pool.query(`
      ALTER TABLE metrics
      ADD COLUMN IF NOT EXISTS landing_page_views INTEGER DEFAULT 0
    `);

    // ── Tarefa 2.3: Breakdowns demográficos (idade × gênero) ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS metrics_demographics (
        id TEXT PRIMARY KEY,
        creative_id TEXT NOT NULL REFERENCES creatives(id),
        date TEXT NOT NULL,
        age TEXT NOT NULL DEFAULT '',
        gender TEXT NOT NULL DEFAULT '',
        spend DOUBLE PRECISION DEFAULT 0,
        impressions INTEGER DEFAULT 0,
        cpm DOUBLE PRECISION DEFAULT 0,
        ctr DOUBLE PRECISION DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        cpc DOUBLE PRECISION DEFAULT 0,
        leads INTEGER DEFAULT 0,
        cpl DOUBLE PRECISION,
        meta_ad_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(creative_id, date, age, gender)
      )
    `);

    // ── Tarefa 2.9: Alertas de anomalia ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        creative_id TEXT REFERENCES creatives(id),
        campaign_key TEXT,
        date TEXT NOT NULL,
        level TEXT NOT NULL,
        rule_name TEXT,
        message TEXT NOT NULL,
        spend DOUBLE PRECISION,
        cpl DOUBLE PRECISION,
        cpl_target DOUBLE PRECISION,
        resolved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Tarefa 1.7: Galeria de variáveis visuais ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visual_elements (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL,
        dimension TEXT NOT NULL CHECK(dimension IN ('hero', 'ebook', 'copy', 'palette', 'style', 'layout')),
        name TEXT NOT NULL,
        description TEXT,
        active_in_meta BOOLEAN DEFAULT FALSE,
        priority INTEGER DEFAULT 5,
        funnel_key TEXT,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, funnel_key)
      )
    `);

    // ── Tarefa 3.3: Hipóteses geradas por IA ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        campaign_key TEXT NOT NULL,
        variable_dimension TEXT NOT NULL,
        variable_code TEXT,
        hypothesis TEXT NOT NULL,
        rationale TEXT,
        priority INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_test', 'validated', 'discarded')),
        source_creative_ids JSONB DEFAULT '[]',
        ai_model TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── Tarefa 4.3: Multi-funil ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS funnels (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        prefix TEXT NOT NULL,
        ebook_title TEXT,
        cpl_target DOUBLE PRECISION,
        meta_campaign_id TEXT,
        meta_account_id TEXT,
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Coluna funnel_key em creatives (detectada automaticamente do nome)
    await pool.query(`
      ALTER TABLE creatives
      ADD COLUMN IF NOT EXISTS funnel_key TEXT
    `);
    // Retrocompatibilidade: inferir funnel_key pelo prefixo do nome
    await pool.query(`
      UPDATE creatives
      SET funnel_key = CASE
        WHEN name ILIKE 'T4EBMX%' THEN 'T4'
        WHEN name ILIKE 'T7EBMX%' THEN 'T7'
        ELSE NULL
      END
      WHERE funnel_key IS NULL
    `);
    // Seed inicial de funnels se vazio
    await pool.query(`
      INSERT INTO funnels (id, key, name, prefix, ebook_title, cpl_target)
      VALUES
        ('funnel-t4', 'T4', 'Turma 4 — Minoxidil', 'T4EBMX', 'Minoxidil: do tópico ao sublingual', 32.77),
        ('funnel-t7', 'T7', 'Turma 7 — RAT Academy', 'T7EBMX', 'RAT Academy', 25.00)
      ON CONFLICT (key) DO NOTHING
    `);

    // Índices para novas tabelas
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visual_elements_dimension ON visual_elements(dimension)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_visual_elements_funnel ON visual_elements(funnel_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_hypotheses_campaign ON hypotheses(campaign_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_funnel ON creatives(funnel_key)`);

    // ── Indexes: existing tables ──
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_control ON creatives(is_control) WHERE is_control = TRUE`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_parent ON creatives(parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_status ON creatives(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_source ON creative_edges(source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_target ON creative_edges(target_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_creative ON metrics(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_images_category ON images(category)`);

    // ── Indexes: new tables ──
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_meta ON campaigns(meta_campaign_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_rounds_campaign ON test_rounds(campaign_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_rounds_status ON test_rounds(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_round_variants_round ON test_round_variants(test_round_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_test_round_variants_creative ON test_round_variants(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_published_ads_variant ON published_ads(variant_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_published_ads_meta ON published_ads(meta_ad_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_executions_round ON pipeline_executions(test_round_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pipeline_executions_status ON pipeline_executions(status)`);

    // Índices metrics_breakdowns
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_breakdowns_creative ON metrics_breakdowns(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_breakdowns_date ON metrics_breakdowns(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_breakdowns_platform ON metrics_breakdowns(publisher_platform)`);

    // Índices metrics_demographics
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_demographics_creative ON metrics_demographics(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_demographics_date ON metrics_demographics(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_demographics_age ON metrics_demographics(age)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_demographics_gender ON metrics_demographics(gender)`);

    // Índices alerts
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_creative ON alerts(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_date ON alerts(date)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alerts_resolved ON alerts(resolved)`);
  } finally {
    await pool.end();
  }

  return db;
}
