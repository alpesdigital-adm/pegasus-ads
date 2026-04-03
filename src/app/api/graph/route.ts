import { NextRequest, NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import type { GraphData, GraphNode, GraphEdge } from "@/lib/types";
import { evaluateKillRules } from "@/config/kill-rules";
import { KNOWN_CAMPAIGNS } from "@/config/campaigns";

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
 */

function getAdBaseName(creativeName: string): string {
  // Remove extensão (.png, .jpg, etc)
  let name = creativeName.replace(/\.\w+$/, "");
  // Remove sufixo F ou S no final (placement indicator)
  name = name.replace(/[FS]$/, "");
  return name;
}

const DEFAULT_CPL_TARGET = KNOWN_CAMPAIGNS["T7_0003_RAT"]?.cplTarget ?? 25;

export async function GET(req: NextRequest) {
  try {
    const db = await initDb();
    const { searchParams } = req.nextUrl;
    const cplTarget = parseFloat(searchParams.get("cpl_target") || String(DEFAULT_CPL_TARGET));

    // Buscar todos os criativos com métricas agregadas + dias rodando
    const creativesResult = await db.execute(`
      SELECT c.*,
        (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) as total_spend,
        (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) as total_impressions,
        (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) as total_clicks,
        (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) as total_leads,
        (SELECT COALESCE(SUM(m.landing_page_views),0) FROM metrics m WHERE m.creative_id = c.id) as total_lpv,
        (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) as avg_cpm,
        (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) as avg_ctr,
        (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) as avg_cpc,
        (SELECT COUNT(DISTINCT m.date) FROM metrics m WHERE m.creative_id = c.id) as days_count
      FROM creatives c
      ORDER BY c.generation ASC, c.created_at ASC
    `);

    // Buscar todas as edges
    const edgesResult = await db.execute(
      "SELECT * FROM creative_edges ORDER BY created_at ASC"
    );

    // ── Agrupar criativos por AD (base name) ──
    // Mapa: baseName → { feed?: row, stories?: row }
    const adGroups: Record<string, {
      feed?: (typeof creativesResult.rows)[0];
      stories?: (typeof creativesResult.rows)[0];
    }> = {};

    for (const row of creativesResult.rows) {
      const name = row.name as string;
      const baseName = getAdBaseName(name);

      if (!adGroups[baseName]) {
        adGroups[baseName] = {};
      }

      // Determinar se é Feed ou Stories pelo sufixo ou dimensões
      const isFeed = name.replace(/\.\w+$/, "").endsWith("F") ||
        (row.width === 1080 && row.height === 1080);
      const isStories = name.replace(/\.\w+$/, "").endsWith("S") ||
        (row.width === 1080 && row.height === 1920);

      if (isStories) {
        adGroups[baseName].stories = row;
      } else if (isFeed) {
        adGroups[baseName].feed = row;
      } else {
        // Criativo sem sufixo — trata como Feed (fallback)
        if (!adGroups[baseName].feed) {
          adGroups[baseName].feed = row;
        }
      }
    }

    // ── Mapear creative IDs individuais → baseName (para redirecionar edges) ──
    const creativeIdToBaseName: Record<string, string> = {};

    for (const row of creativesResult.rows) {
      const baseName = getAdBaseName(row.name as string);
      creativeIdToBaseName[row.id as string] = baseName;
    }

    // ── Primeiro passo: construir métricas por nó para poder calcular controlCpl ──
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

      // daysRunning: máximo entre feed e stories (ambos contam tempo de veiculação)
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

    // ── Identificar controlCpl: nó com generation=0, que tenha métricas ──
    let controlCpl: number | null = null;
    for (const [baseName, group] of Object.entries(adGroups)) {
      const primary = group.feed || group.stories;
      if (!primary) continue;
      if ((primary.generation as number) === 0) {
        const m = nodeMetricsMap[baseName];
        if (m && m.cpl !== null) {
          controlCpl = m.cpl;
          break;
        }
      }
    }

    // ── Construir nós agrupados com kill rule ──
    const nodes: GraphNode[] = [];

    for (const [baseName, group] of Object.entries(adGroups)) {
      // Prioriza Feed como representante; fallback para Stories
      const primary = group.feed || group.stories;
      if (!primary) continue;

      const m = nodeMetricsMap[baseName];
      const placements: string[] = [];
      if (group.feed) placements.push("feed");
      if (group.stories) placements.push("stories");

      // Avaliar kill rules se há métricas
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
      };

      nodes.push(node);
    }

    // ── Redirecionar edges para os nós agrupados ──
    const edgeSet = new Set<string>(); // Para deduplicar
    const edges: GraphEdge[] = [];

    for (const row of edgesResult.rows) {
      const sourceId = row.source_id as string;
      const targetId = row.target_id as string;

      const sourceBase = creativeIdToBaseName[sourceId];
      const targetBase = creativeIdToBaseName[targetId];

      if (!sourceBase || !targetBase) continue;
      if (sourceBase === targetBase) continue; // Skip self-edges (F→S do mesmo AD)

      const edgeKey = `${sourceBase}→${targetBase}→${row.relationship}`;
      if (edgeSet.has(edgeKey)) continue; // Deduplicar (F→F' e S→S' viram uma edge só)
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
      { status: 500 }
    );
  }
}
