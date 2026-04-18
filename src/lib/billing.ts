/**
 * MIGRADO NA FASE 1C (Wave 7 libs):
 *  - getDb() → dbAdmin (queries cross-tenant para plans + counts por workspace)
 *  - Queries tipadas via Drizzle
 *
 * plans é tabela global (sem workspace_id) — dbAdmin é a escolha correta.
 * Counts por workspace usam dbAdmin com filtro explícito (evita travessia
 * RLS para manter a função callable de contextos sem transação aberta).
 */
import { dbAdmin } from "./db";
import {
  plans,
  workspaces,
  creatives,
  campaigns,
  workspaceMetaAccounts,
  workspaceMembers,
  apiKeys,
} from "./db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

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

  const rows = await dbAdmin
    .select()
    .from(plans)
    .where(eq(plans.name, planName))
    .limit(1);

  if (rows.length === 0) {
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

  const row = rows[0];
  const limits: PlanLimits = {
    max_creatives: row.maxCreatives,
    max_campaigns: row.maxCampaigns,
    max_meta_accounts: row.maxMetaAccounts,
    max_members: row.maxMembers,
    max_api_keys: row.maxApiKeys,
    ai_generations_per_month: row.aiGenerationsPerMonth,
    price_cents: row.priceCents,
    plan_name: row.name,
    display_name: row.displayName,
  };

  planCache.set(planName, limits);
  return limits;
}

export type Resource = "creatives" | "campaigns" | "meta_accounts" | "members" | "api_keys";

const RESOURCE_LIMIT_MAP: Record<Resource, keyof PlanLimits> = {
  creatives: "max_creatives",
  campaigns: "max_campaigns",
  meta_accounts: "max_meta_accounts",
  members: "max_members",
  api_keys: "max_api_keys",
};

async function countResource(workspaceId: string, resource: Resource): Promise<number> {
  const wsFilter = (col: ReturnType<typeof eq>) => col;

  switch (resource) {
    case "creatives": {
      const [r] = await dbAdmin
        .select({ cnt: sql<number>`COUNT(*)::int` })
        .from(creatives)
        .where(wsFilter(eq(creatives.workspaceId, workspaceId)));
      return Number(r?.cnt ?? 0);
    }
    case "campaigns": {
      const [r] = await dbAdmin
        .select({ cnt: sql<number>`COUNT(*)::int` })
        .from(campaigns)
        .where(wsFilter(eq(campaigns.workspaceId, workspaceId)));
      return Number(r?.cnt ?? 0);
    }
    case "meta_accounts": {
      const [r] = await dbAdmin
        .select({ cnt: sql<number>`COUNT(*)::int` })
        .from(workspaceMetaAccounts)
        .where(wsFilter(eq(workspaceMetaAccounts.workspaceId, workspaceId)));
      return Number(r?.cnt ?? 0);
    }
    case "members": {
      const [r] = await dbAdmin
        .select({ cnt: sql<number>`COUNT(*)::int` })
        .from(workspaceMembers)
        .where(wsFilter(eq(workspaceMembers.workspaceId, workspaceId)));
      return Number(r?.cnt ?? 0);
    }
    case "api_keys": {
      const [r] = await dbAdmin
        .select({ cnt: sql<number>`COUNT(*)::int` })
        .from(apiKeys)
        .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)));
      return Number(r?.cnt ?? 0);
    }
  }
}

export async function checkLimit(
  workspaceId: string,
  resource: Resource,
): Promise<{ allowed: boolean; current: number; limit: number; plan: string }> {
  const wsRows = await dbAdmin
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const plan = wsRows[0]?.plan || "free";
  const limits = await getPlanLimits(plan);
  const current = await countResource(workspaceId, resource);
  const limit = limits[RESOURCE_LIMIT_MAP[resource]] as number;

  return { allowed: current < limit, current, limit, plan };
}

export async function getWorkspaceUsage(workspaceId: string): Promise<{
  plan: PlanLimits;
  usage: Record<Resource, { current: number; limit: number }>;
}> {
  const wsRows = await dbAdmin
    .select({ plan: workspaces.plan })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);

  const planName = wsRows[0]?.plan || "free";
  const plan = await getPlanLimits(planName);

  const resources: Resource[] = ["creatives", "campaigns", "meta_accounts", "members", "api_keys"];
  const usage: Record<string, { current: number; limit: number }> = {};
  for (const resource of resources) {
    const result = await checkLimit(workspaceId, resource);
    usage[resource] = { current: result.current, limit: result.limit };
  }

  return { plan, usage: usage as Record<Resource, { current: number; limit: number }> };
}
