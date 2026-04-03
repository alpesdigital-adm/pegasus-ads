/**
 * Pegasus Ads MCP Server (tarefa 5.1)
 *
 * Expõe as principais operações do Pegasus Ads como ferramentas MCP:
 *   - pegasus_run_pipeline       — ciclo completo (coleta + kill rules + hipóteses)
 *   - pegasus_collect_metrics    — coleta métricas Meta + avalia kill rules
 *   - pegasus_generate_hypotheses — gera hipóteses de teste A/B com IA
 *   - pegasus_get_funnels        — lista funis com métricas agregadas
 *   - pegasus_get_attribution    — modelo de atribuição first/any-touch
 *   - pegasus_get_graph          — dados de grafo para visualização de criativos
 *   - pegasus_list_creatives_drive — cruza criativos no Drive com anúncios Meta
 *   - pegasus_get_creative_status  — status e métricas de um criativo específico
 *
 * Transporte: stdio (para uso local via Claude Code / cowork).
 *
 * Configuração via variáveis de ambiente:
 *   PEGASUS_API_URL   — URL base (default: https://pegasus-ads.vercel.app)
 *   PEGASUS_API_KEY   — TEST_LOG_API_KEY do Pegasus Ads
 *   PEGASUS_CRON_KEY  — CRON_SECRET para endpoints de coleta
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// ── Configuração ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.PEGASUS_API_URL ?? "https://pegasus-ads.vercel.app";
const API_KEY = process.env.PEGASUS_API_KEY ?? "";
const CRON_KEY = process.env.PEGASUS_CRON_KEY ?? "";
async function api(path, method = "GET", body, useCronAuth = false) {
    const headers = {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
    };
    if (useCronAuth)
        headers["Authorization"] = `Bearer ${CRON_KEY}`;
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            method,
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
    }
    catch (err) {
        return { ok: false, status: 500, data: { error: String(err) } };
    }
}
function toText(result) {
    if (!result.ok) {
        return `Erro HTTP ${result.status}: ${JSON.stringify(result.data, null, 2)}`;
    }
    return JSON.stringify(result.data, null, 2);
}
// ── Servidor MCP ──────────────────────────────────────────────────────────────
const server = new McpServer({
    name: "pegasus-ads-mcp-server",
    version: "1.0.0",
});
// ── 1. Run Pipeline ────────────────────────────────────────────────────────────
server.registerTool("pegasus_run_pipeline", {
    title: "Pegasus Ads — Executar Ciclo Completo",
    description: `Executa o ciclo end-to-end do Pegasus Ads:
1. Coleta métricas da Meta Ads e avalia kill rules
2. Gera hipóteses de teste A/B com IA (Gemini)

Retorna sumário com métricas coletadas, criativos pausados e hipóteses geradas.

Args:
  - campaign_key (string, opcional): chave da campanha — ex: T7_0003_RAT (default)
  - top_n (number, opcional): criativos analisados para hipóteses (default: 10)
  - skip_collect (boolean, opcional): pula coleta de métricas (default: false)
  - skip_hypotheses (boolean, opcional): pula geração de hipóteses (default: false)

Returns: { ok, campaign_key, duration_ms, summary: { metrics_collected, kills_triggered, alerts_created, hypotheses_generated } }`,
    inputSchema: {
        campaign_key: z.string().optional().default("T7_0003_RAT").describe("Chave da campanha"),
        top_n: z.number().int().min(1).max(50).optional().default(10).describe("Criativos para análise"),
        skip_collect: z.boolean().optional().default(false).describe("Pular coleta de métricas"),
        skip_hypotheses: z.boolean().optional().default(false).describe("Pular geração de hipóteses"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ campaign_key, top_n, skip_collect, skip_hypotheses }) => {
    const result = await api("/api/pipeline/run-cycle", "POST", {
        campaign_key, top_n, skip_collect, skip_hypotheses,
    });
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 2. Collect Metrics ─────────────────────────────────────────────────────────
server.registerTool("pegasus_collect_metrics", {
    title: "Pegasus Ads — Coletar Métricas e Avaliar Kill Rules",
    description: `Coleta métricas da Meta Ads (últimos 7 dias) e avalia kill rules para todos os criativos em teste.

Dispara alertas automáticos quando criativos violam critérios de desempenho.

Returns: { collected, upserted, kills_triggered, alerts_created, period }`,
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async () => {
    const result = await api("/api/cron/collect", "GET", undefined, true);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 3. Generate Hypotheses ────────────────────────────────────────────────────
server.registerTool("pegasus_generate_hypotheses", {
    title: "Pegasus Ads — Gerar Hipóteses de Teste A/B",
    description: `Analisa performance dos criativos + biblioteca de variáveis visuais e gera as 3 melhores hipóteses de teste A/B com variável isolada.

Usa Gemini para análise — fallback para regras se IA não disponível.

Args:
  - campaign_key (string, opcional): ex: T7_0003_RAT
  - top_n (number, opcional): criativos analisados (default: 10)

Returns: { hypotheses: [{ dimension, variable_code, hypothesis, rationale, priority, suggested_prompt_delta }], saved_ids }`,
    inputSchema: {
        campaign_key: z.string().optional().default("T7_0003_RAT"),
        top_n: z.number().int().min(1).max(50).optional().default(10),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
}, async ({ campaign_key, top_n }) => {
    const result = await api("/api/hypotheses/generate", "POST", { campaign_key, top_n });
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 4. Get Funnels ────────────────────────────────────────────────────────────
server.registerTool("pegasus_get_funnels", {
    title: "Pegasus Ads — Listar Funis com Métricas",
    description: `Lista todos os funis cadastrados com métricas agregadas dos criativos.

Cada funil inclui: key, nome, prefixo, CPL meta, ebook, campanha Meta, total/ativos/winners/killed de criativos, spend total, leads totais, CPL médio.

Args:
  - active_only (boolean, opcional): retorna apenas funis ativos (default: false)

Returns: { total, funnels: [{ key, name, prefix, cpl_target, total_creatives, active_creatives, ... }] }`,
    inputSchema: {
        active_only: z.boolean().optional().default(false),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ active_only }) => {
    const qs = active_only ? "?active_only=true" : "";
    const result = await api(`/api/funnels${qs}`);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 5. Get Attribution ────────────────────────────────────────────────────────
server.registerTool("pegasus_get_attribution", {
    title: "Pegasus Ads — Modelo de Atribuição",
    description: `Retorna análise de atribuição first-touch e any-touch baseada em dados validados do T4 (16.136 leads, 233 matriculados).

First-touch: CPL real do ebook que captou o lead — base para alocação de budget.
Any-touch: uplift multi-ebook (1.65x) — mostra upside real do funil.

Args:
  - campaign_key (string, opcional): campanha (default: T7_0003_RAT)
  - period (string, opcional): "7d" | "30d" | "all" (default: "all")

Returns: { live_metrics, first_touch, any_touch, top_creatives_by_cpl, context }`,
    inputSchema: {
        campaign_key: z.string().optional().default("T7_0003_RAT"),
        period: z.enum(["7d", "30d", "all"]).optional().default("all"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ campaign_key, period }) => {
    const result = await api(`/api/attribution?campaign_key=${campaign_key}&period=${period}`);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 6. Get Graph ──────────────────────────────────────────────────────────────
server.registerTool("pegasus_get_graph", {
    title: "Pegasus Ads — Dados de Grafo de Criativos",
    description: `Retorna dados de grafo de criativos para visualização de evolução geracional e performance.

Nós representam criativos; arestas representam relações de derivação (controle → variante).

Args:
  - funnel_key (string, opcional): filtrar por funil — ex: T7
  - status (string, opcional): "testing" | "winner" | "killed" | "all" (default: "all")

Returns: { nodes: [...], edges: [...] } compatível com bibliotecas de grafo`,
    inputSchema: {
        funnel_key: z.string().optional().describe("Filtrar por funil (ex: T7)"),
        status: z.enum(["testing", "winner", "killed", "all"]).optional().default("all"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ funnel_key, status }) => {
    const params = new URLSearchParams();
    if (funnel_key)
        params.set("funnel_key", funnel_key);
    if (status && status !== "all")
        params.set("status", status);
    const qs = params.toString() ? `?${params}` : "";
    const result = await api(`/api/graph${qs}`);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 7. List Creatives Drive ───────────────────────────────────────────────────
server.registerTool("pegasus_list_creatives_drive", {
    title: "Pegasus Ads — Listar Criativos (Drive × Meta)",
    description: `Cruza criativos do Google Drive com anúncios publicados na Meta Ads.

Retorna quais criativos têm par Feed+Stories, quais estão publicados, e o status do anúncio na Meta.

Args:
  - campaign_key (string, opcional): campanha (default: T7_0003_RAT)

Returns: { total, published, unpublished, missing_pair, creatives: [{ name, has_pair, published, meta_ad_status, feed, stories }] }`,
    inputSchema: {
        campaign_key: z.string().optional().default("T7_0003_RAT"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ campaign_key }) => {
    const result = await api(`/api/drive/list-creatives?campaign_key=${campaign_key}`);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── 8. Get Creative Status ────────────────────────────────────────────────────
server.registerTool("pegasus_get_creative_status", {
    title: "Pegasus Ads — Status de um Criativo",
    description: `Retorna status e métricas acumuladas de um criativo específico pelo nome ou ID.

Args:
  - name (string, opcional): nome do criativo (busca parcial — ex: T7EBMX-AD001)
  - id (string, opcional): UUID do criativo no banco
  - Pelo menos um dos dois deve ser fornecido.

Returns: criativo com { id, name, status, generation, is_control, funnel_key, total_spend, total_leads, cpl }`,
    inputSchema: {
        name: z.string().optional().describe("Nome (parcial) do criativo"),
        id: z.string().uuid().optional().describe("UUID do criativo"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
}, async ({ name, id }) => {
    const params = new URLSearchParams();
    if (id)
        params.set("id", id);
    if (name)
        params.set("name", name);
    const result = await api(`/api/creatives?${params}`);
    return { content: [{ type: "text", text: toText(result) }] };
});
// ── Iniciar servidor stdio ────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
