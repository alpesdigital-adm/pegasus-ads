import { createClient, type Client } from "@libsql/client";

let client: Client | null = null;

export function getDb(): Client {
  if (!client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;

    if (!url) {
      // Fallback to local SQLite for development
      client = createClient({ url: "file:local.db" });
    } else {
      client = createClient({ url, authToken });
    }
  }
  return client;
}

export async function initDb() {
  const db = getDb();

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('dra-priscila', 'marca', 'produto', 'referencia')),
      blob_url TEXT NOT NULL,
      thumbnail_url TEXT,
      width INTEGER,
      height INTEGER,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS creatives (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      blob_url TEXT NOT NULL,
      thumbnail_url TEXT,
      prompt TEXT,
      prompt_json TEXT,
      model TEXT DEFAULT 'gemini-2.0-flash-exp',
      width INTEGER,
      height INTEGER,
      parent_id TEXT REFERENCES creatives(id),
      generation INTEGER DEFAULT 0,
      status TEXT DEFAULT 'generated' CHECK(status IN ('generated', 'testing', 'winner', 'killed', 'paused')),
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS creative_edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES creatives(id),
      target_id TEXT NOT NULL REFERENCES creatives(id),
      relationship TEXT DEFAULT 'variation' CHECK(relationship IN ('variation', 'iteration', 'style-transfer', 'remix')),
      variable_isolated TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS creative_ref_images (
      id TEXT PRIMARY KEY,
      creative_id TEXT NOT NULL REFERENCES creatives(id),
      image_id TEXT NOT NULL REFERENCES images(id),
      role TEXT DEFAULT 'reference' CHECK(role IN ('reference', 'style', 'character', 'composition')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id TEXT PRIMARY KEY,
      creative_id TEXT NOT NULL REFERENCES creatives(id),
      date TEXT NOT NULL,
      spend REAL DEFAULT 0,
      impressions INTEGER DEFAULT 0,
      cpm REAL DEFAULT 0,
      ctr REAL DEFAULT 0,
      clicks INTEGER DEFAULT 0,
      cpc REAL DEFAULT 0,
      leads INTEGER DEFAULT 0,
      cpl REAL,
      meta_ad_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(creative_id, date)
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id TEXT PRIMARY KEY,
      creative_id TEXT REFERENCES creatives(id),
      prompt_text TEXT NOT NULL,
      prompt_format TEXT DEFAULT 'text' CHECK(prompt_format IN ('text', 'json', 'markdown')),
      model TEXT,
      reference_image_ids TEXT DEFAULT '[]',
      response_raw TEXT,
      tokens_used INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_creatives_parent ON creatives(parent_id);
    CREATE INDEX IF NOT EXISTS idx_creatives_status ON creatives(status);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON creative_edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON creative_edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_metrics_creative ON metrics(creative_id);
    CREATE INDEX IF NOT EXISTS idx_images_category ON images(category);
  `);

  return db;
}
