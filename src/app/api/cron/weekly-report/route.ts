/**
 * GET /api/cron/weekly-report
 *
 * Cron Vercel — dispara toda segunda-feira às 8h BRT (11:00 UTC).
 * Gera relatório HTML e salva no Google Drive (se configurado).
 * Também envia para REPORT_WEBHOOK_URL se definida.
 *
 * Configuração em vercel.json:
 * { "crons": [{ "path": "/api/cron/weekly-report", "schedule": "0 11 * * 1" }] }
 *
 * Proteção: CRON_SECRET no header Authorization: Bearer <secret>
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 120;

function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${cronSecret}`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const apiKey = process.env.TEST_LOG_API_KEY ?? "";
  const cronSecret = process.env.CRON_SECRET ?? "";

  const results: Record<string, unknown> = {};
  const campaigns = (process.env.REPORT_CAMPAIGNS ?? "T7_0003_RAT").split(",");

  for (const campaignKey of campaigns) {
    try {
      // 1. Gerar relatório HTML
      const reportRes = await fetch(
        `${baseUrl}/api/reports/weekly?campaign_key=${campaignKey.trim()}&format=html`,
        {
          headers: {
            "x-api-key": apiKey,
            Authorization: `Bearer ${cronSecret}`,
          },
        }
      );

      if (!reportRes.ok) {
        results[campaignKey] = { ok: false, error: `HTTP ${reportRes.status}` };
        continue;
      }

      const htmlContent = await reportRes.text();

      // 2. Enviar para webhook se configurado (Slack, Discord, WhatsApp, etc.)
      const webhookUrl = process.env.REPORT_WEBHOOK_URL;
      if (webhookUrl) {
        const today = new Date().toLocaleDateString("pt-BR");
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `📊 *Pegasus Ads — Relatório Semanal* (${today})\nCampanha: ${campaignKey}\nAcesse: ${baseUrl}/api/reports/weekly?campaign_key=${campaignKey}`,
          }),
        });
      }

      results[campaignKey] = {
        ok: true,
        html_size: htmlContent.length,
        webhook_notified: !!webhookUrl,
      };
    } catch (err) {
      results[campaignKey] = { ok: false, error: String(err) };
    }
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    campaigns_processed: campaigns.length,
    results,
  });
}
