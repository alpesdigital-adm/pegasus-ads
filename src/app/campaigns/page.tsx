"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";

interface Campaign {
  campaign_id: string;
  campaign_name: string;
  total_ads: number;
  active_ads: number;
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  cpl_meta: number | null;
  cpl_crm: number | null;
  ctr: number;
  cpm: number;
  connect_rate: number;
  days_active: number;
}

interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  total_ads: number;
  active_ads: number;
  cpl_meta: number | null;
  cpl_crm: number | null;
}

const PERIOD_OPTIONS = [
  { label: "Hoje", value: 1 },
  { label: "3 dias", value: 3 },
  { label: "7 dias", value: 7 },
  { label: "14 dias", value: 14 },
  { label: "30 dias", value: 30 },
];

function fmt(n: number | null | undefined, prefix = ""): string {
  if (n == null) return "—";
  return prefix + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function fmtPct(n: number): string {
  return n.toFixed(2) + "%";
}

export default function CampaignsPage() {
  const [days, setDays] = useState(7);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/campaigns/metrics?days=${days}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setCampaigns(data.campaigns || []);
          setTotals(data.totals || null);
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Campanhas</h1>
            <p className="text-[var(--text-secondary)] text-sm mt-1">
              Visao consolidada de todas as campanhas T7
            </p>
          </div>
          <div className="flex gap-1 bg-[var(--bg-tertiary)] rounded-lg p-1">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  days === opt.value
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Totals cards */}
        {totals && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <MetricCard label="Gasto Total" value={fmt(totals.spend, "R$ ")} />
            <MetricCard label="Leads Meta" value={fmtInt(totals.leads_meta)} />
            <MetricCard label="Leads CRM" value={fmtInt(totals.leads_crm)} highlight />
            <MetricCard label="Qualificados" value={fmtInt(totals.leads_qualified)} />
            <MetricCard label="CPL Meta" value={fmt(totals.cpl_meta, "R$ ")} />
            <MetricCard label="CPL CRM" value={fmt(totals.cpl_crm, "R$ ")} highlight />
          </div>
        )}

        {/* Campaigns table */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-[var(--border-default)]">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[var(--bg-tertiary)] text-[var(--text-secondary)] text-xs uppercase tracking-wider">
                  <th className="text-left px-4 py-3 font-medium">Campanha</th>
                  <th className="text-right px-3 py-3 font-medium">Ads</th>
                  <th className="text-right px-3 py-3 font-medium">Gasto</th>
                  <th className="text-right px-3 py-3 font-medium">Impr.</th>
                  <th className="text-right px-3 py-3 font-medium">Cliques</th>
                  <th className="text-right px-3 py-3 font-medium">LPV</th>
                  <th className="text-right px-3 py-3 font-medium">Leads Meta</th>
                  <th className="text-right px-3 py-3 font-medium">Leads CRM</th>
                  <th className="text-right px-3 py-3 font-medium">Qual.</th>
                  <th className="text-right px-3 py-3 font-medium">CPL Meta</th>
                  <th className="text-right px-3 py-3 font-medium">CPL CRM</th>
                  <th className="text-right px-3 py-3 font-medium">CTR</th>
                  <th className="text-right px-3 py-3 font-medium">Connect</th>
                  <th className="text-center px-3 py-3 font-medium">Kill Rules</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.campaign_id}
                    className="border-t border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-[var(--text-primary)]">
                        {c.campaign_name}
                      </div>
                      <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
                        {c.active_ads}/{c.total_ads} ads ativos &middot; {c.days_active}d
                      </div>
                    </td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">
                      <span className="text-emerald-400">{c.active_ads}</span>
                      <span className="text-[var(--text-muted)]">/{c.total_ads}</span>
                    </td>
                    <td className="text-right px-3 py-3 font-medium">{fmt(c.spend, "R$ ")}</td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">{fmtInt(c.impressions)}</td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">{fmtInt(c.clicks)}</td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">{fmtInt(c.lpv)}</td>
                    <td className="text-right px-3 py-3">{fmtInt(c.leads_meta)}</td>
                    <td className="text-right px-3 py-3 text-emerald-400 font-medium">{fmtInt(c.leads_crm)}</td>
                    <td className="text-right px-3 py-3 text-blue-400">{fmtInt(c.leads_qualified)}</td>
                    <td className="text-right px-3 py-3">
                      <CplBadge value={c.cpl_meta} target={32.77} />
                    </td>
                    <td className="text-right px-3 py-3">
                      <CplBadge value={c.cpl_crm} target={30} />
                    </td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">{fmtPct(c.ctr)}</td>
                    <td className="text-right px-3 py-3 text-[var(--text-secondary)]">{fmtPct(c.connect_rate)}</td>
                    <td className="text-center px-3 py-3">
                      <button
                        onClick={() => router.push(`/campaigns/${c.campaign_id}`)}
                        className="p-2 rounded-lg hover:bg-amber-500/10 text-[var(--text-muted)] hover:text-amber-400 transition-all"
                        title="Kill Rules"
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 2L2 7l10 5 10-5-10-5z" />
                          <path d="M2 17l10 5 10-5" />
                          <path d="M2 12l10 5 10-5" />
                        </svg>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`p-4 rounded-xl border ${highlight ? "border-emerald-500/20 bg-emerald-500/5" : "border-[var(--border-default)] bg-[var(--bg-card)]"}`}>
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)] mb-1">{label}</p>
      <p className={`text-lg font-semibold ${highlight ? "text-emerald-400" : "text-[var(--text-primary)]"}`}>{value}</p>
    </div>
  );
}

function CplBadge({ value, target }: { value: number | null; target: number }) {
  if (value == null) return <span className="text-[var(--text-muted)]">—</span>;
  const isGood = value <= target;
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${
      isGood ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
    }`}>
      R$ {value.toFixed(2)}
    </span>
  );
}
