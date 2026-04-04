/**
 * POST /api/setup/apps-script
 *
 * Implanta (ou re-implanta) o Apps Script de sincronização do Log de Testes
 * diretamente na planilha Google Sheets do usuário, via Apps Script API.
 *
 * Pré-requisitos:
 *   - Google OAuth conectado com scope script.projects
 *   - Variável de ambiente TEST_LOG_API_KEY definida (opcional mas recomendada)
 *
 * Body JSON:
 * {
 *   spreadsheet_id: string   // ID da planilha (ex: "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms")
 *   api_base?:      string   // Override da base URL (padrão: https://pegasus-ads.vercel.app)
 * }
 *
 * Resposta JSON (sucesso):
 * {
 *   ok:          true
 *   script_id:   string   // ID do projeto Apps Script criado/atualizado
 *   editor_url:  string   // URL para abrir o editor do script
 *   action:      "created" | "updated"
 *   message:     string
 * }
 *
 * Resposta JSON (erro):
 * {
 *   ok:      false
 *   error:   string
 *   details: string (opcional)
 * }
 *
 * Fluxo:
 *   1. Obtém access token válido (com scope script.projects)
 *   2. Verifica se já existe um script_id salvo nas settings do DB
 *   3a. Se não existe: POST /v1/projects → cria novo projeto Apps Script
 *       ligado ao container (spreadsheetId)
 *   3b. Se existe:     apenas atualiza o conteúdo (PUT /v1/projects/{id}/content)
 *   4. PUT /v1/projects/{id}/content → envia o código gerado pelo template
 *   5. Salva o script_id no DB (settings key: apps_script_id)
 */

import { NextRequest, NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/google-drive";
import { buildAppsScript } from "@/config/apps-script-template";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

const SCRIPT_API_BASE = "https://script.googleapis.com/v1";

interface ScriptProject {
  scriptId: string;
  title: string;
  createTime?: string;
  updateTime?: string;
}

interface AppsScriptFile {
  name: string;
  type: "SERVER_JS" | "HTML" | "JSON";
  source: string;
}

async function getSavedScriptId(): Promise<string | null> {
  const db = getDb();
  try {
    const result = await db.execute({
      sql: "SELECT value FROM settings WHERE key = 'apps_script_id'",
    });
    return result.rows.length > 0 ? (result.rows[0].value as string) : null;
  } catch {
    return null;
  }
}

async function saveScriptId(scriptId: string): Promise<void> {
  const db = getDb();
  const existing = await db.execute({
    sql: "SELECT key FROM settings WHERE key = ?",
    args: ["apps_script_id"],
  });

  if (existing.rows.length > 0) {
    await db.execute({
      sql: "UPDATE settings SET value = ?, updated_at = NOW() WHERE key = ?",
      args: [scriptId, "apps_script_id"],
    });
  } else {
    await db.execute({
      sql: "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, NOW())",
      args: ["apps_script_id", scriptId],
    });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  // ── 1. Parse body ──
  let body: { spreadsheet_id?: string; api_base?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body JSON inválido." }, { status: 400 });
  }

  const { spreadsheet_id: spreadsheetId, api_base: apiBase } = body;

  if (!spreadsheetId) {
    return NextResponse.json(
      { ok: false, error: "Campo obrigatório: spreadsheet_id" },
      { status: 400 }
    );
  }

  // ── 2. Obter access token ──
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken();
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "Google não conectado. Faça o OAuth primeiro em /api/auth/google.",
        details: String(err),
      },
      { status: 401 }
    );
  }

  // ── 3. Gerar código do script ──
  const apiKey = process.env.TEST_LOG_API_KEY ?? "";
  const scriptSource = buildAppsScript({
    spreadsheetId,
    apiKey,
    apiBase,
  });

  const files: AppsScriptFile[] = [
    {
      name: "sync_test_log",
      type: "SERVER_JS",
      source: scriptSource,
    },
    {
      // appsscript.json manifest — necessário para a API aceitar o push
      name: "appsscript",
      type: "JSON",
      source: JSON.stringify({
        timeZone: "America/Sao_Paulo",
        dependencies: {},
        exceptionLogging: "STACKDRIVER",
        runtimeVersion: "V8",
        oauthScopes: [
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/script.scriptapp",
          "https://www.googleapis.com/auth/script.external_request",
        ],
      }),
    },
  ];

  // ── 4. Verificar se já existe script salvo ──
  let scriptId = await getSavedScriptId();
  let action: "created" | "updated" = scriptId ? "updated" : "created";

  // ── 5a. Criar projeto se não existe ──
  if (!scriptId) {
    const createRes = await fetch(`${SCRIPT_API_BASE}/projects`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Pegasus Ads — Log de Testes",
        parentId: spreadsheetId,
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();

      // Se falhou por scope insuficiente, orientar o usuário
      if (createRes.status === 403) {
        return NextResponse.json(
          {
            ok: false,
            error:
              "Permissão negada pela API do Apps Script. " +
              "O token atual pode ter sido gerado sem o scope script.projects. " +
              "Reconecte o Google em /api/auth/google para reautorizar com os novos escopos.",
            details: errText,
          },
          { status: 403 }
        );
      }

      return NextResponse.json(
        { ok: false, error: "Falha ao criar projeto Apps Script.", details: errText },
        { status: createRes.status }
      );
    }

    const created = (await createRes.json()) as ScriptProject;
    scriptId = created.scriptId;
    action = "created";
    await saveScriptId(scriptId);
  }

  // ── 5b. Atualizar conteúdo do script ──
  const contentRes = await fetch(`${SCRIPT_API_BASE}/projects/${scriptId}/content`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ files }),
  });

  if (!contentRes.ok) {
    const errText = await contentRes.text();

    // Se script foi deletado manualmente pelo usuário, limpar ID salvo e tentar recriar
    if (contentRes.status === 404) {
      const db = getDb();
      await db.execute({
        sql: "DELETE FROM settings WHERE key = 'apps_script_id'",
      });
      return NextResponse.json(
        {
          ok: false,
          error:
            "Script não encontrado (pode ter sido deletado). " +
            "Tente novamente — na próxima chamada um novo projeto será criado.",
          details: errText,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { ok: false, error: "Falha ao atualizar conteúdo do script.", details: errText },
      { status: contentRes.status }
    );
  }

  // ── 6. Retornar sucesso ──
  const editorUrl = `https://script.google.com/d/${scriptId}/edit`;

  return NextResponse.json({
    ok: true,
    script_id: scriptId,
    editor_url: editorUrl,
    action,
    message:
      action === "created"
        ? `Script criado com sucesso e vinculado à planilha ${spreadsheetId}. Abra o editor para autorizar as permissões na primeira execução.`
        : `Script atualizado com sucesso. O código mais recente já está no editor.`,
    next_steps:
      action === "created"
        ? [
            "1. Abra o editor: " + editorUrl,
            "2. Execute a função 'syncAll' uma vez para autorizar as permissões (Google pedirá consentimento).",
            "3. Execute 'installTrigger' para ativar o sync diário automático às 7h.",
          ]
        : ["O script foi atualizado. Nenhuma ação adicional necessária."],
  });
}

// GET: retorna status do script implantado
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const scriptId = await getSavedScriptId();

  if (!scriptId) {
    return NextResponse.json({
      ok: true,
      deployed: false,
      message: "Nenhum script implantado ainda. Use POST /api/setup/apps-script para implantar.",
    });
  }

  return NextResponse.json({
    ok: true,
    deployed: true,
    script_id: scriptId,
    editor_url: `https://script.google.com/d/${scriptId}/edit`,
  });
}
