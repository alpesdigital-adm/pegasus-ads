/**
 * POST /api/crm/import
 *
 * Importa CSV de leads do CRM. Para cada lead:
 * 1. Resolve UTMs → campaign_id e ad_id via lookup nas tabelas locais
 * 2. Aplica regras de qualificação do projeto (lead_qualification_rules)
 * 3. Upsert em crm_leads (idempotente por workspace_id + crm_id)
 *
 * Form data:
 *   file         — arquivo CSV
 *   project_key  — chave do projeto (ex: "rat")
 *   source_file  — nome do arquivo (opcional, usa file.name)
 *
 * Protegido por x-api-key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const maxDuration = 120;

interface QualRule {
  column: string;
  values: string[];
  negate?: boolean;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      fields.push(current.trim()); current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parseCsv(text: string): Record<string, string>[] {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

function parseBrDate(str: string): Date | null {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`);
}

function qualifyLead(row: Record<string, string>, rules: QualRule[]): boolean {
  if (!rules.length) return true;
  return rules.every((rule) => {
    const cell = (row[rule.column] ?? "").trim().toLowerCase();
    const match = rule.values.some((v) => (v ?? "").trim().toLowerCase() === cell);
    return rule.negate ? !match : match;
  });
}

function extractCampaignCode(utm: string): string {
  if (!utm || /^\d+$/.test(utm)) return utm;
  const parts = utm.split("__");
  return parts.length >= 2 ? `${parts[0]}__${parts[1]}` : utm;
}

const COL_COUNT = 21;

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const projectKey = (formData.get("project_key") as string) || "rat";
    const sourceName = (formData.get("source_file") as string) || file?.name || "unknown.csv";

    if (!file) return NextResponse.json({ error: "file required" }, { status: 400 });

    const text = await file.text();
    const rows = parseCsv(text);
    if (!rows.length) return NextResponse.json({ error: "CSV empty or invalid" }, { status: 400 });

    const db = getDb();

    // Load qualification rules
    const rulesRes = await db.execute({
      sql: "SELECT rules FROM lead_qualification_rules WHERE workspace_id = ? AND project_key = ?",
      args: [auth.workspace_id, projectKey],
    });
    const qualRules: QualRule[] = rulesRes.rows.length > 0
      ? (rulesRes.rows[0].rules as QualRule[]) : [];

    // Load campaign lookup (name -> meta_campaign_id)
    const campRes = await db.execute({
      sql: "SELECT meta_campaign_id, name FROM campaigns WHERE workspace_id = ?",
      args: [auth.workspace_id],
    });
    const campByName = new Map<string, string>();
    for (const c of campRes.rows) {
      campByName.set((c.name as string).toUpperCase(), c.meta_campaign_id as string);
    }

    // Load ad lookup (ad_name -> {meta_ad_id, meta_adset_id})
    const adRes = await db.execute({
      sql: "SELECT meta_ad_id, ad_name, meta_adset_id FROM published_ads WHERE workspace_id = ? AND meta_ad_id IS NOT NULL",
      args: [auth.workspace_id],
    });
    const adByName = new Map<string, { adId: string; adsetId: string }>();
    for (const a of adRes.rows) {
      adByName.set((a.ad_name as string).toUpperCase(), {
        adId: a.meta_ad_id as string,
        adsetId: (a.meta_adset_id as string) || "",
      });
    }

    let imported = 0, skipped = 0, qualified = 0, adResolved = 0, campResolved = 0;
    const errors: string[] = [];
    const batch: unknown[] = [];

    const flush = async () => {
      if (!batch.length) return;
      const rowCount = batch.length / COL_COUNT;
      const placeholders = Array.from({ length: rowCount }, (_, i) =>
        `(${Array.from({ length: COL_COUNT }, (__, j) => `$${i * COL_COUNT + j + 1}`).join(",")})`
      ).join(",");

      await db.execute({
        sql: `INSERT INTO crm_leads (
          crm_id, workspace_id, email, phone, full_name,
          utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbclid,
          ad_id, adset_id, campaign_id,
          is_qualified, qualification_data,
          subscribed_at, first_subscribed_at,
          source_file, raw_data, imported_at
        ) VALUES ${placeholders}
        ON CONFLICT (workspace_id, crm_id) DO UPDATE SET
          email = EXCLUDED.email,
          phone = EXCLUDED.phone,
          full_name = EXCLUDED.full_name,
          utm_source = EXCLUDED.utm_source,
          utm_medium = EXCLUDED.utm_medium,
          utm_campaign = EXCLUDED.utm_campaign,
          utm_term = EXCLUDED.utm_term,
          utm_content = EXCLUDED.utm_content,
          fbclid = EXCLUDED.fbclid,
          ad_id = COALESCE(EXCLUDED.ad_id, crm_leads.ad_id),
          adset_id = COALESCE(EXCLUDED.adset_id, crm_leads.adset_id),
          campaign_id = COALESCE(EXCLUDED.campaign_id, crm_leads.campaign_id),
          is_qualified = EXCLUDED.is_qualified,
          qualification_data = EXCLUDED.qualification_data,
          subscribed_at = EXCLUDED.subscribed_at,
          source_file = EXCLUDED.source_file,
          raw_data = EXCLUDED.raw_data,
          imported_at = NOW()`,
        args: batch.slice(),
      });
      batch.length = 0;
    };

    for (const row of rows) {
      try {
        const crmId = row["ID"]?.trim();
        if (!crmId) { skipped++; continue; }

        const raw = (s: string) => s?.trim() || "";
        const utmCampaign = raw(row["UTM Campaign"]);
        const utmContent = raw(row["UTM Content"]);
        const isMacro = (s: string) => s.startsWith("{{") || s.startsWith("[[");

        const cleanCampaign = isMacro(utmCampaign) ? "" : utmCampaign;
        const cleanContent = isMacro(utmContent) ? "" : utmContent;

        // Resolve campaign_id
        let campaignId: string | null = null;
        if (/^\d+$/.test(cleanCampaign)) {
          campaignId = cleanCampaign; campResolved++;
        } else if (cleanCampaign) {
          const code = extractCampaignCode(cleanCampaign).toUpperCase();
          const found = campByName.get(cleanCampaign.toUpperCase()) || campByName.get(code);
          if (found) { campaignId = found; campResolved++; }
        }

        // Resolve ad_id
        let adId: string | null = null;
        let adsetId: string | null = null;
        if (/^\d+$/.test(cleanContent)) {
          adId = cleanContent; adResolved++;
        } else if (cleanContent) {
          const key = cleanContent.toUpperCase();
          const exact = adByName.get(key);
          if (exact) {
            adId = exact.adId; adsetId = exact.adsetId; adResolved++;
          } else {
            for (const [name, data] of adByName) {
              if (name.startsWith(key)) {
                adId = data.adId; adsetId = data.adsetId; adResolved++; break;
              }
            }
          }
        }

        // Qualify
        const isQual = qualifyLead(row, qualRules);
        const qualData: Record<string, string> = {};
        for (const rule of qualRules) qualData[rule.column] = row[rule.column] ?? "";
        if (isQual) qualified++;

        const subscribedAt = parseBrDate(row["Última Inscrição"] || "");
        const firstSubscribedAt = parseBrDate(row["Primeira Inscrição"] || "");

        const rawData = Object.fromEntries(
          Object.entries(row).filter(([k]) => !["Nome Completo"].includes(k))
        );

        batch.push(
          crmId, auth.workspace_id,
          row["Email"]?.trim() || null, row["Telefone"]?.trim() || null, row["Nome Completo"]?.trim() || null,
          raw(row["UTM Source"]) || null, raw(row["UTM Medium"]) || null,
          cleanCampaign || null, raw(row["UTM Term"]) || null, cleanContent || null, raw(row["FBCLID"]) || null,
          adId, adsetId, campaignId,
          isQual, JSON.stringify(qualData),
          subscribedAt?.toISOString() || null, firstSubscribedAt?.toISOString() || null,
          sourceName, JSON.stringify(rawData), new Date().toISOString()
        );
        imported++;

        if (batch.length >= 100 * COL_COUNT) await flush();
      } catch (e) {
        errors.push(`Row ${row["ID"]}: ${e}`); skipped++;
      }
    }

    await flush();

    return NextResponse.json({
      success: true,
      project_key: projectKey,
      total_rows: rows.length,
      imported,
      skipped,
      qualified,
      qualification_rules_applied: qualRules.length,
      ad_id_resolved: adResolved,
      campaign_id_resolved: campResolved,
      errors: errors.slice(0, 10),
    });
  } catch (err) {
    console.error("[CRM Import]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
