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

    // ── Indexes: existing tables ──
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
  } finally {
    await pool.end();
  }

  return db;
}
