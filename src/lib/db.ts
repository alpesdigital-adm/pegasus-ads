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

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_parent ON creatives(parent_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_creatives_status ON creatives(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_source ON creative_edges(source_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_edges_target ON creative_edges(target_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_metrics_creative ON metrics(creative_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_images_category ON images(category)`);
  } finally {
    await pool.end();
  }

  return db;
}
