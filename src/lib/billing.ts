import { getDb } from "./db";

export interface PlanLimits {
  max_creatives: number;
  max_campaigns: number;
  max_meta_accounts: number;
  max_members: number;
  max_api_keys: number;
  ai_generations_per_month: number;
  price_cents: number;
  plan_name: string;
  display_name: string;
}

const planCache = new Map<string, PlanLimits>();

export async function getPlanLimits(planName: string): Promise<PlanLimits> {
  const cached = planCache.get(planName);
  if (cached) return cached;

  const db = getDb();
  const result = await db.execute({
    sql: "SELECT * FROM plans WHERE name = ?",
    args: [planName],
  });

  if (result.rows.length === 0) {
    // Default free limits
    return {
      max_creatives: 50,
      max_campaigns: 3,
      max_meta_accounts: 1,
      max_members: 1,
      max_api_keys: 2,
      ai_generations_per_month: 20,
      price_cents: 0,
      plan_name: "free",
      display_name: "Free",
    };
  }

  const row = result.rows[0];
  const limits: PlanLimits = {
    max_creatives: row.max_creatives as number,
    max_campaigns: row.max_campaigns as number,
    max_meta_accounts: row.max_meta_accounts as number,
    max_members: row.max_members as number,
    max_api_keys: row.max_api_keys as number,
    ai_generations_per_month: row.ai_generations_per_month as number,
    price_cents: row.price_cents as number,
    plan_name: row.name as string,
    display_name: row.display_name as string,
  };

  planCache.set(planName, limits);
  return limits;
}

export type Resource = "creatives" | "campaigns" | "meta_accounts" | "members" | "api_keys";

const RESOURCE_TABLE_MAP: Record<Resource, { table: string; column: string }> = {
  creatives: { table: "creatives", column: "workspace_id" },
  campaigns: { table: "campaigns", column: "workspace_id" },
  meta_accounts: { table: "workspace_meta_accounts", column: "workspace_id" },
  members: { table: "workspace_members", column: "workspace_id" },
  api_keys: { table: "api_keys", column: "workspace_id" },
};

const RESOURCE_LIMIT_MAP: Record<Resource, keyof PlanLimits> = {
  creatives: "max_creatives",
  campaigns: "max_campaigns",
  meta_accounts: "max_meta_accounts",
  members: "max_members",
  api_keys: "max_api_keys",
};

export async function checkLimit(
  workspaceId: string,
  resource: Resource
): Promise<{ allowed: boolean; current: number; limit: number; plan: string }> {
  const db = getDb();

  // Get workspace plan
  const wsResult = await db.execute({
    sql: "SELECT plan FROM workspaces WHERE id = ?",
    args: [workspaceId],
  });
  const plan = (wsResult.rows[0]?.plan as string) || "free";
  const limits = await getPlanLimits(plan);

  // Count current usage
  const { table, column } = RESOURCE_TABLE_MAP[resource];
  const revokedClause = resource === "api_keys" ? " AND revoked_at IS NULL" : "";
  const countResult = await db.execute({
    sql: `SELECT COUNT(*) as cnt FROM ${table} WHERE ${column} = ?${revokedClause}`,
    args: [workspaceId],
  });
  const current = Number(countResult.rows[0]?.cnt ?? 0);
  const limit = limits[RESOURCE_LIMIT_MAP[resource]] as number;

  return {
    allowed: current < limit,
    current,
    limit,
    plan,
  };
}

export async function getWorkspaceUsage(workspaceId: string): Promise<{
  plan: PlanLimits;
  usage: Record<Resource, { current: number; limit: number }>;
}> {
  const db = getDb();

  const wsResult = await db.execute({
    sql: "SELECT plan FROM workspaces WHERE id = ?",
    args: [workspaceId],
  });
  const planName = (wsResult.rows[0]?.plan as string) || "free";
  const plan = await getPlanLimits(planName);

  const resources: Resource[] = ["creatives", "campaigns", "meta_accounts", "members", "api_keys"];
  const usage: Record<string, { current: number; limit: number }> = {};

  for (const resource of resources) {
    const result = await checkLimit(workspaceId, resource);
    usage[resource] = { current: result.current, limit: result.limit };
  }

  return { plan, usage: usage as Record<Resource, { current: number; limit: number }> };
}
