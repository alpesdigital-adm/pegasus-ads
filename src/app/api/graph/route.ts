import { NextResponse } from "next/server";
import { initDb } from "@/lib/db";
import type { GraphData, GraphNode, GraphEdge } from "@/lib/types";

/**
 * GET /api/graph
 *
 * Retorna o grafo de ADs (não criativos individuais).
 * Cada nó = 1 AD (ex: T7EBMX-AD014), agrupando Feed + Stories.
 * A imagem exibida é a do Feed (1:1), com referência à versão Stories.
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

export async function GET() {
  try {
    const db = await initDb();

    // Buscar todos os criativos com métricas agregadas
    const creativesResult = await db.execute(`
      SELECT c.*,
        (SELECT SUM(m.spend) FROM metrics m WHERE m.creative_id = c.id) as total_spend,
        (SELECT SUM(m.impressions) FROM metrics m WHERE m.creative_id = c.id) as total_impressions,
        (SELECT SUM(m.clicks) FROM metrics m WHERE m.creative_id = c.id) as total_clicks,
        (SELECT SUM(m.leads) FROM metrics m WHERE m.creative_id = c.id) as total_leads,
        (SELECT AVG(m.cpm) FROM metrics m WHERE m.creative_id = c.id) as avg_cpm,
        (SELECT AVG(m.ctr) FROM metrics m WHERE m.creative_id = c.id) as avg_ctr,
        (SELECT AVG(m.cpc) FROM metrics m WHERE m.creative_id = c.id AND m.cpc > 0) as avg_cpc
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

    // ── Construir nós agrupados ──
    // Mapear creative IDs individuais → baseName (para redirecionar edges)
    const creativeIdToBaseName: Record<string, string> = {};

    for (const row of creativesResult.rows) {
      const baseName = getAdBaseName(row.name as string);
      creativeIdToBaseName[row.id as string] = baseName;
    }

    const nodes: GraphNode[] = [];

    for (const [baseName, group] of Object.entries(adGroups)) {
      // Prioriza Feed como representante; fallback para Stories
      const primary = group.feed || group.stories;
      if (!primary) continue;

      // Somar métricas de Feed + Stories
      const feedSpend = (group.feed?.total_spend as number) || 0;
      const storiesSpend = (group.stories?.total_spend as number) || 0;
      const totalSpend = feedSpend + storiesSpend;

      const feedLeads = (group.feed?.total_leads as number) || 0;
      const storiesLeads = (group.stories?.total_leads as number) || 0;
      const totalLeads = feedLeads + storiesLeads;

      const feedImpressions = (group.feed?.total_impressions as number) || 0;
      const storiesImpressions = (group.stories?.total_impressions as number) || 0;
      const totalImpressions = feedImpressions + storiesImpressions;

      const feedClicks = (group.feed?.total_clicks as number) || 0;
      const storiesClicks = (group.stories?.total_clicks as number) || 0;
      const totalClicks = feedClicks + storiesClicks;

      // Médias ponderadas (ou simples avg se apenas um tem dados)
      const feedCpm = (group.feed?.avg_cpm as number) || 0;
      const storiesCpm = (group.stories?.avg_cpm as number) || 0;
      const avgCpm = totalImpressions > 0
        ? (feedCpm * feedImpressions + storiesCpm * storiesImpressions) / totalImpressions
        : 0;

      const feedCtr = (group.feed?.avg_ctr as number) || 0;
      const storiesCtr = (group.stories?.avg_ctr as number) || 0;
      const avgCtr = totalImpressions > 0
        ? (feedCtr * feedImpressions + storiesCtr * storiesImpressions) / totalImpressions
        : 0;

      const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

      // Determinar placements disponíveis
      const placements: string[] = [];
      if (group.feed) placements.push("feed");
      if (group.stories) placements.push("stories");

      const node: GraphNode = {
        id: baseName, // ID do nó = base name do AD
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
        metrics: totalSpend > 0
          ? {
              total_spend: totalSpend,
              total_impressions: totalImpressions,
              total_clicks: totalClicks,
              total_leads: totalLeads,
              avg_cpm: avgCpm,
              avg_ctr: avgCtr,
              avg_cpc: avgCpc,
              cpl: totalLeads > 0 ? totalSpend / totalLeads : null,
            }
          : undefined,
      };

      nodes.push(node);
    }

    // ── Redirecionar edges para os nós agrupados ──
    // As edges originais apontam para creative IDs individuais.
    // Precisamos redirecionar para os baseNames (IDs dos nós agrupados).
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
