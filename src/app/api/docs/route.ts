/**
 * GET /api/docs
 *
 * Documentação interativa da API pública do Pegasus Ads (tarefa 5.5).
 * Retorna:
 *   - format=html   → página Swagger UI estática (default)
 *   - format=json   → OpenAPI 3.1 spec em JSON
 *   - format=yaml   → OpenAPI 3.1 spec em YAML
 *
 * Pública (sem autenticação) — é documentação.
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAPI_SPEC = {
  openapi: "3.1.0",
  info: {
    title: "Pegasus Ads API",
    version: "2.0.0",
    description:
      "API da plataforma Pegasus Ads — Creative Intelligence para Meta Ads. " +
      "Geração de criativos, publicação, análise de performance, kill rules e pipeline de testes A/B.",
    contact: {
      name: "Alpes Digital",
      url: "https://pegasus-ads.vercel.app",
    },
  },
  servers: [
    { url: "https://pegasus-ads.vercel.app", description: "Produção (Vercel)" },
    { url: "http://localhost:3000", description: "Desenvolvimento local" },
  ],
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "TEST_LOG_API_KEY definida nas variáveis de ambiente do projeto",
      },
      CronAuth: {
        type: "http",
        scheme: "bearer",
        description: "CRON_SECRET — usado pelos endpoints de cron/automação",
      },
    },
    schemas: {
      Creative: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", example: "T7EBMX-AD001-VF" },
          status: {
            type: "string",
            enum: ["testing", "winner", "killed", "paused"],
          },
          is_control: { type: "boolean" },
          funnel_key: { type: "string", example: "T7" },
          campaign_key: { type: "string", example: "T7_0003_RAT" },
          generation: { type: "integer", minimum: 1 },
          total_spend: { type: "number", format: "double" },
          total_leads: { type: "integer" },
          cpl: { type: "number", format: "double", nullable: true },
          created_at: { type: "string", format: "date-time" },
        },
      },
      Funnel: {
        type: "object",
        properties: {
          id: { type: "string" },
          key: { type: "string", example: "T7" },
          name: { type: "string", example: "Turma 7 — RAT Academy" },
          prefix: { type: "string", example: "T7EBMX" },
          ebook_title: { type: "string" },
          cpl_target: { type: "number", format: "double" },
          total_creatives: { type: "integer" },
          active_creatives: { type: "integer" },
          winner_creatives: { type: "integer" },
          killed_creatives: { type: "integer" },
          total_spend: { type: "number" },
          total_leads: { type: "integer" },
          avg_cpl: { type: "number", nullable: true },
        },
      },
      Hypothesis: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" },
          campaign_key: { type: "string" },
          variable_dimension: {
            type: "string",
            enum: ["hero", "ebook", "copy", "palette", "style", "layout"],
          },
          variable_code: { type: "string", example: "H3" },
          hypothesis: { type: "string" },
          rationale: { type: "string" },
          priority: { type: "integer", minimum: 1, maximum: 10 },
          status: {
            type: "string",
            enum: ["pending", "in_test", "validated", "discarded"],
          },
          suggested_prompt_delta: { type: "string", nullable: true },
        },
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    // ── Criativos ──────────────────────────────────────────────────────────
    "/api/creatives": {
      get: {
        tags: ["Criativos"],
        summary: "Listar criativos",
        description:
          "Lista criativos com métricas agregadas. Suporta filtros por campanha, status e funil.",
        parameters: [
          { name: "campaign_key", in: "query", schema: { type: "string" } },
          {
            name: "status",
            in: "query",
            schema: { type: "string", enum: ["testing", "winner", "killed", "all"] },
          },
          { name: "funnel_key", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Lista de criativos",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    creatives: { type: "array", items: { $ref: "#/components/schemas/Creative" } },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Funis ──────────────────────────────────────────────────────────────
    "/api/funnels": {
      get: {
        tags: ["Funis"],
        summary: "Listar funis com métricas",
        responses: {
          "200": {
            description: "Lista de funis",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    funnels: { type: "array", items: { $ref: "#/components/schemas/Funnel" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Funis"],
        summary: "Criar ou atualizar funil",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["key", "name", "prefix"],
                properties: {
                  key: { type: "string", example: "T8" },
                  name: { type: "string" },
                  prefix: { type: "string" },
                  ebook_title: { type: "string" },
                  cpl_target: { type: "number" },
                  meta_campaign_id: { type: "string" },
                  meta_account_id: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Funil criado/atualizado" },
          "400": { description: "Dados inválidos" },
        },
      },
    },

    // ── Atribuição ─────────────────────────────────────────────────────────
    "/api/attribution": {
      get: {
        tags: ["Analytics"],
        summary: "Modelo de atribuição first-touch + any-touch",
        description:
          "Retorna análise de atribuição com constantes validadas do T4 (16.136 leads, CPL R$32,77).",
        parameters: [
          { name: "campaign_key", in: "query", schema: { type: "string" } },
          {
            name: "period",
            in: "query",
            schema: { type: "string", enum: ["7d", "30d", "all"] },
          },
        ],
        responses: {
          "200": { description: "Dados de atribuição" },
        },
      },
    },

    // ── Budget ─────────────────────────────────────────────────────────────
    "/api/budget/suggest": {
      get: {
        tags: ["Analytics"],
        summary: "Sugestão de redistribuição de budget",
        description:
          "Propõe alocação de verba proporcional ao inverso do CPL (melhor CPL → mais budget).",
        parameters: [
          { name: "campaign_key", in: "query", schema: { type: "string" } },
          { name: "total_budget", in: "query", schema: { type: "number" } },
          { name: "period", in: "query", schema: { type: "string", enum: ["7d", "30d"] } },
          { name: "top_n", in: "query", schema: { type: "integer" } },
        ],
        responses: {
          "200": { description: "Sugestão de alocação de budget" },
        },
      },
    },

    // ── Hipóteses ──────────────────────────────────────────────────────────
    "/api/hypotheses/generate": {
      post: {
        tags: ["Testes A/B"],
        summary: "Gerar hipóteses de teste A/B com IA",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  campaign_key: { type: "string" },
                  top_n: { type: "integer", default: 10 },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Hipóteses geradas",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    hypotheses: {
                      type: "array",
                      items: { $ref: "#/components/schemas/Hypothesis" },
                    },
                    source: { type: "string", enum: ["gemini", "rule_based"] },
                  },
                },
              },
            },
          },
        },
      },
    },

    // ── Templates ─────────────────────────────────────────────────────────
    "/api/templates": {
      get: {
        tags: ["Templates"],
        summary: "Listar templates de padrões visuais validados",
        parameters: [
          { name: "funnel_key", in: "query", schema: { type: "string" } },
          {
            name: "dimension",
            in: "query",
            schema: {
              type: "string",
              enum: ["hero", "ebook", "copy", "palette", "style", "layout"],
            },
          },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "archived", "all"] } },
        ],
        responses: {
          "200": { description: "Lista de templates" },
        },
      },
      post: {
        tags: ["Templates"],
        summary: "Criar template de padrão visual",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "funnel_key", "dimensions"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string" },
                  funnel_key: { type: "string" },
                  dimensions: { type: "object" },
                  prompt_fragment: { type: "string" },
                  cpl_validated: { type: "number" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Template criado" },
        },
      },
    },

    // ── Pipeline ───────────────────────────────────────────────────────────
    "/api/pipeline/run-cycle": {
      post: {
        tags: ["Pipeline"],
        summary: "Executar ciclo end-to-end",
        description: "Encadeia: coleta métricas → avalia kill rules → gera hipóteses A/B.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  campaign_key: { type: "string" },
                  top_n: { type: "integer" },
                  skip_collect: { type: "boolean" },
                  skip_hypotheses: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Resultado do ciclo" },
        },
      },
    },

    // ── Relatório ──────────────────────────────────────────────────────────
    "/api/reports/weekly": {
      get: {
        tags: ["Relatórios"],
        summary: "Relatório semanal de performance",
        parameters: [
          { name: "campaign_key", in: "query", schema: { type: "string" } },
          { name: "weeks_back", in: "query", schema: { type: "integer", default: 1 } },
          { name: "format", in: "query", schema: { type: "string", enum: ["html", "json"] } },
        ],
        responses: {
          "200": {
            description: "Relatório HTML ou JSON",
            content: {
              "text/html": { schema: { type: "string" } },
              "application/json": { schema: { type: "object" } },
            },
          },
        },
      },
    },

    // ── Visual Elements ───────────────────────────────────────────────────
    "/api/visual-elements": {
      get: {
        tags: ["Variáveis Visuais"],
        summary: "Listar elementos visuais da biblioteca",
        parameters: [
          { name: "dimension", in: "query", schema: { type: "string" } },
          { name: "funnel_key", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Elementos por dimensão" } },
      },
    },

    // ── Drive ─────────────────────────────────────────────────────────────
    "/api/drive/list-creatives": {
      get: {
        tags: ["Publicação"],
        summary: "Cruzar criativos do Drive com Meta Ads",
        parameters: [
          { name: "campaign_key", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Status de publicação por criativo",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    published: { type: "integer" },
                    unpublished: { type: "integer" },
                    creatives: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

function toYaml(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "boolean") return String(obj);
  if (typeof obj === "number") return String(obj);
  if (typeof obj === "string") {
    if (obj.includes("\n") || obj.includes(":") || obj.includes("#")) {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return "\n" + obj.map((item) => `${pad}- ${toYaml(item, indent + 1).trimStart()}`).join("\n");
  }
  if (typeof obj === "object") {
    const entries = Object.entries(obj);
    if (entries.length === 0) return "{}";
    return (
      "\n" +
      entries
        .map(([k, v]) => {
          const val = toYaml(v, indent + 1);
          if (val.startsWith("\n")) return `${pad}${k}:${val}`;
          return `${pad}${k}: ${val}`;
        })
        .join("\n")
    );
  }
  return String(obj);
}

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pegasus Ads API — Documentação</title>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css">
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { background: #1a1a2e; }
    .swagger-ui .topbar .download-url-wrapper .select-label span,
    .swagger-ui .topbar a { color: white !important; }
    #header { background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; padding: 20px 24px; display: flex; align-items: center; gap: 16px; }
    #header h1 { margin: 0; font-size: 20px; font-family: Arial, sans-serif; }
    #header p { margin: 4px 0 0 0; opacity: 0.7; font-size: 13px; font-family: Arial, sans-serif; }
  </style>
</head>
<body>
<div id="header">
  <div>
    <h1>🚀 Pegasus Ads API</h1>
    <p>Creative Intelligence Platform — Alpes Digital</p>
  </div>
</div>
<div id="swagger-ui"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>
  SwaggerUIBundle({
    url: '/api/docs?format=json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
    layout: 'BaseLayout',
    tryItOutEnabled: true,
    requestInterceptor: (req) => {
      req.headers['x-api-key'] = localStorage.getItem('pegasus_api_key') || '';
      return req;
    }
  });
</script>
</body>
</html>`;

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const format = searchParams.get("format") ?? "html";

  if (format === "json") {
    return NextResponse.json(OPENAPI_SPEC);
  }

  if (format === "yaml") {
    const yaml = `openapi: "3.1.0"${toYaml(OPENAPI_SPEC, 0)}`;
    return new NextResponse(yaml, {
      headers: { "Content-Type": "text/yaml; charset=utf-8" },
    });
  }

  return new NextResponse(SWAGGER_HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
