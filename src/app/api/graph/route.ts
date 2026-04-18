/**
 * GET /api/graph
 *
 * Retorna o grafo de ADs (não criativos individuais).
 * Cada nó = 1 AD (ex: T7EBMX-AD014), agrupando Feed + Stories.
 * A imagem exibida é a do Feed (1:1), com referência à versão Stories.
 *
 * Query params:
 *   cpl_target = número (padrão: T7_0003_RAT.cplTarget = 25)
 *
 * Agrupamento: nome base sem sufixo F/S e sem extensão.
 *   "T7EBMX-AD014F.png" → base "T7EBMX-AD014"
 *   "T7EBMX-AD014S.png" → base "T7EBMX-AD014"
 *
 * MIGRADO NA FASE 1C (Wave 5):
 *  - getDb() → withWorkspace (RLS escopa creatives + metrics + creative_edges)
 *  - 2 queries em sql`` (creatives com agregados + edges com JOIN)
 *  - Filtros workspace_id manuais removidos (RLS cobre — edges via creative FK)
 */
import { NextRequest, NextResponse } from "next/server";
import { withWorkspace } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import type { GraphData, GraphNode, GraphEdge } from "@/lib/types";
import { evaluateKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";
import { sql } from "drizzle-orm";

export const runtime = "nodejs";

function getAdBaseName(creativeName: string): string {
  let name = creativeName.replace(/\.\w+$/, "");
  name = name.replace(/[FS]$/, "");
  return name;
}

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = req.nextUrl;
    const cplTarget = parseFloat(searchParams.get("cpl_target") || String(DEFAULT_CPL_TARGET));

    const { creativeRows, edgeRows } = await withWorkspace(
      auth.workspace_id,
      async (tx) => {
        const cr = await tx.execute(sql`
          SELECT c.*,
            (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) AS total_spend,
            (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) AS total_impressions,
            (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) AS total_clicks,
            (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) AS total_leads,
            (SELECT COALESCE(SUM(m.landing_page_views), 0) FROM metrics m WHERE m.creative_id = c.id) AS total_lpv,
            (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) AS avg_cpm,
            (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) AS avg_ctr,
            (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) AS avg_cpc,
            (SELECT COUNT(DISTINCT m.date) FROM metrics m WHERE m.creative_id = c.id) AS days_count
          FROM creatives c
          ORDER BY c.generation ASC, c.created_at ASC
        `);

        // creative_edges RLS via workspace_id próprio (Fase 1B preencheu coluna)
        const ed = await tx.execute(sql`
          SELECT id, source_id, target_id, relationship, variable_isolated, created_at
          FROM creative_edges
          ORDER BY created_at ASC
        `);

        return {
          creativeRows: cr as unknown as Array<Record<string, unknown>>,
          edgeRows: ed as unknown as Array<Record<string, unknown>>,
        };
      },
    );

    // ── Agrupar criativos por AD (base name) ──
    const adGroups: Record<string, {
      feed?: Record<string, unknown>;
      stories?: Record<string, unknown>;
    }> = {};

    for (const row of creativeRows) {
      const name = row.name as string;
      const baseName = getAdBaseName(name);
      if (!adGroups[baseName]) adGroups[baseName] = {};

      const isFeed = name.replace(/\.\w+$/, "").endsWith("F") ||
        (row.width === 1080 && row.height === 1080);
      const isStories = name.replace(/\.\w+$/, "").endsWith("S") ||
        (row.width === 1080 && row.height === 1920);

      if (isStories) {
        adGroups[baseName].stories = row;
      } else if (isFeed) {
        adGroups[baseName].feed = row;
      } else {
        if (!adGroups[baseName].feed) adGroups[baseName].feed = row;
      }
    }

    const creativeIdToBaseName: Record<string, string> = {};
    for (const row of creativeRows) {
      creativeIdToBaseName[row.id as string] = getAdBaseName(row.name as string);
    }

    // ── Métricas agregadas por nó ──
    type NodeMetrics = {
      totalSpend: number;
      totalImpressions: number;
      totalClicks: number;
      totalLeads: number;
      totalLpv: number;
      avgCpm: number;
      avgCtr: number;
      avgCpc: number;
      daysRunning: number;
      cpl: number | null;
    };

    const nodeMetricsMap: Record<string, NodeMetrics> = {};

    for (const [baseName, group] of Object.entries(adGroups)) {
      const feedSpend = Number(group.feed?.total_spend ?? 0);
      const storiesSpend = Number(group.stories?.total_spend ?? 0);
      const totalSpend = feedSpend + storiesSpend;

      const feedLeads = Number(group.feed?.total_leads ?? 0);
      const storiesLeads = Number(group.stories?.total_leads ?? 0);
      const totalLeads = feedLeads + storiesLeads;

      const feedLpv = Number(group.feed?.total_lpv ?? 0);
      const storiesLpv = Number(group.stories?.total_lpv ?? 0);
      const totalLpv = feedLpv + storiesLpv;

      const feedImpressions = Number(group.feed?.total_impressions ?? 0);
      const storiesImpressions = Number(group.stories?.total_impressions ?? 0);
      const totalImpressions = feedImpressions + storiesImpressions;

      const feedClicks = Number(group.feed?.total_clicks ?? 0);
      const storiesClicks = Number(group.stories?.total_clicks ?? 0);
      const totalClicks = feedClicks + storiesClicks;

      const feedCpm = Number(group.feed?.avg_cpm ?? 0);
      const storiesCpm = Number(group.stories?.avg_cpm ?? 0);
      const avgCpm = totalImpressions > 0
        ? (feedCpm * feedImpressions + storiesCpm * storiesImpressions) / totalImpressions
        : 0;

      const feedCtr = Number(group.feed?.avg_ctr ?? 0);
      const storiesCtr = Number(group.stories?.avg_ctr ?? 0);
      const avgCtr = totalImpressions > 0
        ? (feedCtr * feedImpressions + storiesCtr * storiesImpressions) / totalImpressions
        : 0;

      const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

      const feedDays = Number(group.feed?.days_count ?? 0);
      const storiesDays = Number(group.stories?.days_count ?? 0);
      const daysRunning = Math.max(feedDays, storiesDays);

      nodeMetricsMap[baseName] = {
        totalSpend,
        totalImpressions,
        totalClicks,
        totalLeads,
        totalLpv,
        avgCpm,
        avgCtr,
        avgCpc,
        daysRunning,
        cpl: totalLeads > 0 ? totalSpend / totalLeads : null,
      };
    }

    // ── Identificar controlCpl ──
    let controlCpl: number | null = null;
    for (const [baseName, group] of Object.entries(adGroups)) {
      const primary = group.feed || group.stories;
      if (!primary) continue;
      const isControl = !!primary.is_control;
      const isGen0 = (primary.generation as number) === 0;
      if (isControl || isGen0) {
        const m = nodeMetricsMap[baseName];
        if (m && m.cpl !== null) {
          controlCpl = m.cpl;
          if (isControl) break;
        }
      }
    }

    // ── Construir nós ──
    const nodes: GraphNode[] = [];
    for (const [baseName, group] of Object.entries(adGroups)) {
      const primary = group.feed || group.stories;
      if (!primary) continue;

      const m = nodeMetricsMap[baseName];
      const placements: string[] = [];
      if (group.feed) placements.push("feed");
      if (group.stories) placements.push("stories");

      let killRuleResult: GraphNode["kill_rule"] = undefined;
      if (m && m.totalSpend > 0) {
        const evaluated = evaluateKillRules({
          spend: m.totalSpend,
          leads: m.totalLeads,
          cpl: m.cpl,
          impressions: m.totalImpressions,
          ctr: m.avgCtr,
          cplTarget,
          controlCpl,
          daysRunning: m.daysRunning,
        });
        if (evaluated) {
          killRuleResult = {
            level: evaluated.level,
            name: evaluated.name,
            action: evaluated.action,
          };
        }
      }

      const node: GraphNode = {
        id: baseName,
        name: baseName,
        thumbnail_url: primary.thumbnail_url as string | undefined,
        blob_url: (group.feed?.blob_url || group.stories?.blob_url) as string,
        status: primary.status as GraphNode["status"],
        generation: primary.generation as number,
        prompt: primary.prompt as string | undefined,
        created_at: primary.created_at as string,
        placements,
        feed_id: group.feed?.id as string | undefined,
        stories_id: group.stories?.id as string | undefined,
        stories_blob_url: group.stories?.blob_url as string | undefined,
        cpl_target: cplTarget,
        kill_rule: killRuleResult,
        metrics: m && m.totalSpend > 0
          ? {
              total_spend: m.totalSpend,
              total_impressions: m.totalImpressions,
              total_clicks: m.totalClicks,
              total_leads: m.totalLeads,
              total_lpv: m.totalLpv,
              avg_cpm: m.avgCpm,
              avg_ctr: m.avgCtr,
              avg_cpc: m.avgCpc,
              cpl: m.cpl,
            }
          : undefined,
        is_control: !!primary.is_control || (primary.generation as number) === 0,
      };
      nodes.push(node);
    }

    // ── Edges para os nós agrupados ──
    const edgeSet = new Set<string>();
    const edges: GraphEdge[] = [];
    for (const row of edgeRows) {
      const sourceId = row.source_id as string;
      const targetId = row.target_id as string;
      const sourceBase = creativeIdToBaseName[sourceId];
      const targetBase = creativeIdToBaseName[targetId];
      if (!sourceBase || !targetBase) continue;
      if (sourceBase === targetBase) continue;

      const edgeKey = `${sourceBase}→${targetBase}→${row.relationship}`;
      if (edgeSet.has(edgeKey)) continue;
      edgeSet.add(edgeKey);

      edges.push({
        id: row.id as string,
        source: sourceBase,
        target: targetBase,
        relationship: row.relationship as GraphEdge["relationship"],
        variable_isolated: row.variable_isolated as string | undefined,
      });
    }

    const graph: GraphData = { nodes, edges };
    return NextResponse.json(graph);
  } catch (error) {
    console.error("Graph error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
