// =============================================================================
// Pegasus Ads — DB client (Drizzle + postgres-js)
// =============================================================================
// Padrão replicado do CRM: dual client (db app + dbAdmin), `withWorkspace()`
// helper para RLS scoped ao tenant, e adapter `getDb().execute()` legado para
// manter compatibilidade com as 57 rotas que ainda não foram migradas para
// Drizzle.
// =============================================================================

import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

// =============================================================================
// Connection strings
// =============================================================================

function resolveAppUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL (ou POSTGRES_URL como fallback) é obrigatória.",
    );
  }
  return url;
}

function resolveAdminUrl(): string {
  // Durante Fase 1 (pre-cutover), o ambiente ainda pode não ter DATABASE_URL_ADMIN
  // definida — caímos para DATABASE_URL. Após a Fase 1 estabilizar, tornar
  // DATABASE_URL_ADMIN obrigatória.
  return process.env.DATABASE_URL_ADMIN ?? resolveAppUrl();
}

// =============================================================================
// Drizzle clients (app + admin)
// =============================================================================

// postgres-js options compartilhadas:
// - `prepare: false` → Supavisor/PgBouncer em transaction mode não suporta
//   prepared statements persistentes (plano v1.4 seção 4.4).
// - `max` → tamanho do pool. Durante Fase 1A mantemos admin permissivo porque
//   57 rotas legadas roteiam via dbAdmin até serem migradas.
const postgresOpts = {
  prepare: false as const,
  max: 10,
};

const appConnection: Sql = postgres(resolveAppUrl(), postgresOpts);
const adminConnection: Sql = postgres(resolveAdminUrl(), postgresOpts);

export const db = drizzle(appConnection, { schema });
export const dbAdmin = drizzle(adminConnection, { schema });

export type Db = typeof db;
export type DbAdmin = typeof dbAdmin;

// =============================================================================
// withWorkspace — executa um bloco com RLS escopado ao workspace_id
// =============================================================================
// Todas as queries dentro do callback rodam na mesma transação do Postgres,
// com `app.workspace_id` setado via SET LOCAL. As policies RLS em cada tabela
// filtram automaticamente por workspace.
//
// IMPORTANTE:
//  - O tipo do `tx` é intencionalmente `Db` (não `PgTransaction<...>`) para que
//    chamadas dentro do bloco se pareçam idênticas a chamadas fora. Drizzle
//    garante compatibilidade entre os dois em runtime.
//  - Usa o cliente `db` (role pegasus_ads_app) — RLS enforced. Queries SEM
//    withWorkspace() via `db` retornam zero rows (fail-safe).
//  - Crons e operações cross-workspace usam `dbAdmin` (BYPASSRLS).

export async function withWorkspace<T>(
  workspaceId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.workspace_id = ${workspaceId}`);
    return fn(tx as unknown as Db);
  });
}

// =============================================================================
// Re-exports convenientes
// =============================================================================

export { sql, schema };

// =============================================================================
// Legacy adapter: getDb().execute()
// =============================================================================
// 57 rotas API ainda usam a interface antiga { rows, rowCount } do db.ts sobre
// @neondatabase/serverless. Este adapter mantém a interface mas roda sobre
// postgres-js + dbAdmin (BYPASSRLS). A migração gradual para Drizzle +
// withWorkspace() acontece rota por rota na Fase 1C+.
//
// Por que dbAdmin e não db? As rotas legadas continuam filtrando WHERE
// workspace_id = ? manualmente. Se usássemos a role `pegasus_ads_app`, as
// queries retornariam zero rows (não há SET LOCAL app.workspace_id no
// adapter). Logo, durante a transição, o fail-safe RLS não se aplica à
// interface legada — a segurança continua nos filtros WHERE.

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DbClient {
  execute(
    query: string | { sql: string; args?: unknown[] },
  ): Promise<QueryResult>;
}

// Converte placeholders `?` (legado) para `$1, $2, ...` do Postgres.
function convertPlaceholders(queryText: string): string {
  let i = 0;
  return queryText.replace(/\?/g, () => `$${++i}`);
}

let legacyClient: DbClient | null = null;

export function getDb(): DbClient {
  if (!legacyClient) {
    legacyClient = {
      async execute(query) {
        let text: string;
        let params: unknown[] = [];
        if (typeof query === "string") {
          text = convertPlaceholders(query);
        } else {
          text = convertPlaceholders(query.sql);
          params = query.args ?? [];
        }
        // postgres-js: .unsafe(sql, params) retorna array de rows com .count.
        // Em contraste com @neondatabase/serverless que retornava { rows, rowCount }.
        const rows = (await adminConnection.unsafe(
          text,
          params as (string | number | boolean | Date | null)[],
        )) as unknown as Record<string, unknown>[];
        return {
          rows,
          rowCount: rows.length,
        };
      },
    };
  }
  return legacyClient;
}

// =============================================================================
// initDb — shim de compatibilidade (10 rotas legadas)
// =============================================================================
// O antigo db.ts rodava CREATE TABLE IF NOT EXISTS em boot. Isso foi substituído
// por migrations Drizzle (drizzle-kit generate/push). Esta função continua
// exportada apenas para não quebrar os imports em rotas não migradas — ela
// agora retorna o client legado e não executa DDL.
// TODO (Fase 1C): remover initDb() após migrar as 10 rotas para Drizzle.
export async function initDb(): Promise<DbClient> {
  return getDb();
}
