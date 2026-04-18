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
 *
 * MIGRADO NA FASE 1C (Wave 5 — CRM):
 *  - getDb() → dbAdmin (BYPASSRLS, workspace_id no WHERE manual)
 *  - 3 lookups iniciais via Drizzle typed builder
 *  - Bulk INSERT com ON CONFLICT DO UPDATE agora usa
 *    .insert().values([...objects]).onConflictDoUpdate(...) — sem
 *    montar placeholders manualmente; jsonb passa como objeto (não JSON.stringify)
 *  - COALESCE(EXCLUDED.field, crm_leads.field) preservado para ad_id/adset_id/campaign_id
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { dbAdmin } from "@/lib/db";
import {
  leadQualificationRules,
  campaigns,
  publishedAds,
  crmLeads,
} from "@/lib/db/schema";
import { and, eq, sql } from "drizzle-orm";

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

type CrmLeadInsert = typeof crmLeads.$inferInsert;

const BATCH_SIZE = 100;

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

    // Load qualification rules
    const rulesRows = await dbAdmin
      .select({ rules: leadQualificationRules.rules })
      .from(leadQualificationRules)
      .where(
        and(
          eq(leadQualificationRules.workspaceId, auth.workspace_id),
          eq(leadQualificationRules.projectKey, projectKey),
        ),
      )
      .limit(1);
    const qualRules: QualRule[] = rulesRows.length > 0
      ? (rulesRows[0].rules as QualRule[]) : [];

    // Load campaign lookup (name -> meta_campaign_id)
    const campRows = await dbAdmin
      .select({
        metaCampaignId: campaigns.metaCampaignId,
        name: campaigns.name,
      })
      .from(campaigns)
      .where(eq(campaigns.workspaceId, auth.workspace_id));
    const campByName = new Map<string, string>();
    for (const c of campRows) {
      campByName.set(c.name.toUpperCase(), c.metaCampaignId);
    }

    // Load ad lookup (ad_name -> {meta_ad_id, meta_adset_id})
    const adRows = await dbAdmin
      .select({
        metaAdId: publishedAds.metaAdId,
        adName: publishedAds.adName,
        metaAdsetId: publishedAds.metaAdsetId,
      })
      .from(publishedAds)
      .where(eq(publishedAds.workspaceId, auth.workspace_id));
    const adByName = new Map<string, { adId: string; adsetId: string }>();
    for (const a of adRows) {
      adByName.set(a.adName.toUpperCase(), {
        adId: a.metaAdId,
        adsetId: a.metaAdsetId || "",
      });
    }

    let imported = 0, skipped = 0, qualified = 0, adResolved = 0, campResolved = 0;
    const errors: string[] = [];
    const batch: CrmLeadInsert[] = [];

    const flush = async () => {
      if (!batch.length) return;
      await dbAdmin
        .insert(crmLeads)
        .values(batch)
        .onConflictDoUpdate({
          target: [crmLeads.workspaceId, crmLeads.crmId],
          set: {
            email: sql`EXCLUDED.email`,
            phone: sql`EXCLUDED.phone`,
            fullName: sql`EXCLUDED.full_name`,
            utmSource: sql`EXCLUDED.utm_source`,
            utmMedium: sql`EXCLUDED.utm_medium`,
            utmCampaign: sql`EXCLUDED.utm_campaign`,
            utmTerm: sql`EXCLUDED.utm_term`,
            utmContent: sql`EXCLUDED.utm_content`,
            fbclid: sql`EXCLUDED.fbclid`,
            // COALESCE preserva o valor existente quando o CSV novo não resolveu a UTM.
            adId: sql`COALESCE(EXCLUDED.ad_id, ${crmLeads.adId})`,
            adsetId: sql`COALESCE(EXCLUDED.adset_id, ${crmLeads.adsetId})`,
            campaignId: sql`COALESCE(EXCLUDED.campaign_id, ${crmLeads.campaignId})`,
            isQualified: sql`EXCLUDED.is_qualified`,
            qualificationData: sql`EXCLUDED.qualification_data`,
            subscribedAt: sql`EXCLUDED.subscribed_at`,
            sourceFile: sql`EXCLUDED.source_file`,
            rawData: sql`EXCLUDED.raw_data`,
            importedAt: sql`NOW()`,
          },
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

        batch.push({
          workspaceId: auth.workspace_id,
          crmId,
          email: row["Email"]?.trim() || null,
          phone: row["Telefone"]?.trim() || null,
          fullName: row["Nome Completo"]?.trim() || null,
          utmSource: raw(row["UTM Source"]) || null,
          utmMedium: raw(row["UTM Medium"]) || null,
          utmCampaign: cleanCampaign || null,
          utmTerm: raw(row["UTM Term"]) || null,
          utmContent: cleanContent || null,
          fbclid: raw(row["FBCLID"]) || null,
          adId,
          adsetId,
          campaignId,
          isQualified: isQual,
          qualificationData: qualData,
          subscribedAt,
          firstSubscribedAt,
          sourceFile: sourceName,
          rawData,
        });
        imported++;

        if (batch.length >= BATCH_SIZE) await flush();
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
