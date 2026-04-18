/**
 * POST /api/setup/apps-script
 *
 * Implanta (ou re-implanta) o Apps Script de sincronização do Log de Testes
 * diretamente na planilha Google Sheets do usuário, via Apps Script API.
 *
 * Body JSON:
 * { spreadsheet_id: string, api_base?: string }
 *
 * MIGRADO NA FASE 1C (Wave 6 misc):
 *  - getDb() → dbAdmin (tabela settings é global — TD-005)
 *  - upsert via Drizzle onConflictDoUpdate (substitui SELECT+INSERT/UPDATE)
 */

import { NextRequest, NextResponse } from "next/server";
import { getValidAccessToken } from "@/lib/google-drive";
import { buildAppsScript } from "@/config/apps-script-template";
import { dbAdmin } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

const SCRIPT_API_BASE = "https://script.googleapis.com/v1";
const SCRIPT_ID_KEY = "apps_script_id";

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
  try {
    const rows = await dbAdmin
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, SCRIPT_ID_KEY))
      .limit(1);
    return rows.length > 0 ? rows[0].value : null;
  } catch {
    return null;
  }
}

async function saveScriptId(scriptId: string): Promise<void> {
  await dbAdmin
    .insert(settings)
    .values({ key: SCRIPT_ID_KEY, value: scriptId })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: sql`EXCLUDED.value`, updatedAt: sql`NOW()` },
    });
}

async function clearScriptId(): Promise<void> {
  await dbAdmin.delete(settings).where(eq(settings.key, SCRIPT_ID_KEY));
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

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
      { status: 400 },
    );
  }

  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(auth.workspace_id);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "Google não conectado. Faça o OAuth primeiro em /api/auth/google.",
        details: String(err),
      },
      { status: 401 },
    );
  }

  const apiKey = process.env.TEST_LOG_API_KEY ?? "";
  const scriptSource = buildAppsScript({ spreadsheetId, apiKey, apiBase });

  const files: AppsScriptFile[] = [
    { name: "sync_test_log", type: "SERVER_JS", source: scriptSource },
    {
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

  let scriptId = await getSavedScriptId();
  let action: "created" | "updated" = scriptId ? "updated" : "created";

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
          { status: 403 },
        );
      }
      return NextResponse.json(
        { ok: false, error: "Falha ao criar projeto Apps Script.", details: errText },
        { status: createRes.status },
      );
    }

    const created = (await createRes.json()) as ScriptProject;
    scriptId = created.scriptId;
    action = "created";
    await saveScriptId(scriptId);
  }

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
    if (contentRes.status === 404) {
      await clearScriptId();
      return NextResponse.json(
        {
          ok: false,
          error:
            "Script não encontrado (pode ter sido deletado). " +
            "Tente novamente — na próxima chamada um novo projeto será criado.",
          details: errText,
        },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: "Falha ao atualizar conteúdo do script.", details: errText },
      { status: contentRes.status },
    );
  }

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
