"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";

interface AdMetrics {
  ad_id: string;
  ad_name: string;
  adset_id: string;
  adset_name: string;
  status: string;
  effective_status: string;
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  cpm: number;
  leads: number;
  qualified_leads: number;
  cpl: number;
  leads_source: string;
  kill_rule: { level: string; name: string; action: string } | null;
}

interface KillRuleResponse {
  campaign_id: string;
  campaign_name: string;
  window: string;
  total_ads: number;
  active_ads: number;
  kill_candidates: number;
  total_spend: number;
  total_leads: number;
  total_leads_crm: number;
  total_qualified_leads: number;
  rolling_5d_cpl: number;
  leads_source: string;
  control_cpl: number | null;
  cpl_target: number;
  ads: AdMetrics[];
}

// Group ads by adset
interface AdsetGroup {
  adset_id: string;
  adset_name: string;
  ads: AdMetrics[];
  total_spend: number;
  total_leads: number;
  total_qualified: number;
  active_count: number;
  kill_count: number;
}

const WINDOWS = [
  { key: "today", label: "Hoje" },
  { key: "2d", label: "2 dias" },
  { key: "3d", label: "3 dias" },
  { key: "5d", label: "5 dias" },
];

function fmt(n: number | null, prefix = ""): string {
  if (n == null || isNaN(n)) return "—";
  return prefix + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function killRuleDescription(level: string): string {
  const descriptions: Record<string, string> = {
    "L0a": "Sem Lead + CPM alto: spend >= 1x CPL meta + 0 leads + CPM >= R$60. Pausar.",
    "L0b": "Sem Lead: spend >= 1.5x CPL meta + 0 leads. Pausar.",
    L1: "Claramente ruim: spend > 4x CPL meta & CPL > 1.5x CPL meta. Pausar.",
    L2: "Acima da meta com evidencia: spend > 6x CPL meta & CPL > 1.3x CPL meta. Pausar.",
    L3: "Deterioracao aguda 3d: spend 3d > 5x & CPL 3d > 1.7x & CPL acum > 1x & benchmark & rolling 5d > 1.15x. Pausar.",
    L4: "Deterioracao lenta 7d: spend 7d > 5x & CPL 7d > 1.7x & CPL acum > 1x & benchmark & rolling 5d > 1.15x. Pausar.",
    L5: "Mediocridade persistente: spend > 10x & CPL > 1.15x & benchmark & rolling 5d > 1.15x. Pausar.",
  };
  return descriptions[level] || "";
}

export default function CampaignDrillPage() {
  const params = useParams();
  const router = useRouter();
  const campaignId = params.id as string;

  const [window, setWindow] = useState("3d");
  const [data, setData] = useState<KillRuleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedAdsets, setExpandedAdsets] = useState<Set<string>>(new Set());
  const [showPaused, setShowPaused] = useState(false);
  const [togglingAds, setTogglingAds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);

  const syncData = async () => {
    setSyncing(true);
    try {
      await fetch("/api/cron/sync-all");
    } catch { /* ignore */ }
    setSyncing(false);
    fetchData();
  };

  const fetchData = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/campaigns/${campaignId}/drill?window=${window}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setData(d);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [campaignId, window]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const toggleAdset = (id: string) => {
    setExpandedAdsets((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleAdStatus = async (adId: string, currentStatus: string) => {
    const newStatus = currentStatus === "ACTIVE" ? "PAUSED" : "ACTIVE";
    setTogglingAds((prev) => new Set(prev).add(adId));

    try {
      const res = await fetch("/api/ads/toggle-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ad_id: adId, status: newStatus }),
      });
      const result = await res.json();
      if (result.success) {
        // Update local state only — no full refresh
        setData((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            active_ads: prev.active_ads + (newStatus === "ACTIVE" ? 1 : -1),
            ads: prev.ads.map((ad) =>
              ad.ad_id === adId
                ? { ...ad, status: newStatus, effective_status: newStatus }
                : ad
            ),
          };
        });
      } else {
        alert(`Erro ao ${newStatus === "PAUSED" ? "pausar" : "ativar"}: ${JSON.stringify(result.error)}`);
      }
    } catch (e) {
      alert(`Erro: ${e}`);
    } finally {
      setTogglingAds((prev) => {
        const next = new Set(prev);
        next.delete(adId);
        return next;
      });
    }
  };

  // Group ads by adset
  const adsetGroups: AdsetGroup[] = [];
  if (data?.ads) {
    const map = new Map<string, AdMetrics[]>();
    for (const ad of data.ads) {
      const key = ad.adset_id || "unknown";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ad);
    }
    for (const [adsetId, ads] of map) {
      const filteredAds = showPaused ? ads : ads.filter((a) => a.effective_status === "ACTIVE");
      if (filteredAds.length === 0 && !showPaused) continue;
      adsetGroups.push({
        adset_id: adsetId,
        adset_name: ads[0]?.adset_name || adsetId,
        ads: filteredAds,
        total_spend: filteredAds.reduce((s, a) => s + (a.spend || 0), 0),
        total_leads: filteredAds.reduce((s, a) => s + (a.leads || 0), 0),
        total_qualified: filteredAds.reduce((s, a) => s + (a.qualified_leads || 0), 0),
        active_count: ads.filter((a) => a.effective_status === "ACTIVE").length,
        kill_count: filteredAds.filter((a) => a.kill_rule?.action === "kill").length,
      });
    }
    adsetGroups.sort((a, b) => b.total_spend - a.total_spend);
  }

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button onClick={() => router.push("/campaigns")} className="p-2 rounded-lg hover:bg-[var(--bg-hover)] transition-colors">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
          </button>
          <div className="flex-1">
            <h1 className="text-xl font-semibold tracking-tight">Kill Rules</h1>
            <p className="text-xs text-[var(--text-tertiary)] mt-0.5 font-mono">{data?.campaign_name || campaignId}</p>
          </div>
          <button
            onClick={syncData}
            disabled={syncing}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] text-xs font-medium text-[var(--text-secondary)] transition-all disabled:opacity-50"
            title="Atualizar dados da Meta"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={syncing ? "animate-spin" : ""}>
              <path d="M21 12a9 9 0 01-9 9m0 0a9 9 0 01-9-9m9 9V3m0 0a9 9 0 019 9m-9-9a9 9 0 00-9 9" />
            </svg>
            {syncing ? "Atualizando..." : "Atualizar dados"}
          </button>
        </div>

        {/* Controls */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Window selector */}
          <div className="flex gap-1 bg-[var(--bg-tertiary)] rounded-lg p-1">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                onClick={() => setWindow(w.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  window === w.key
                    ? "bg-[var(--accent)] text-white"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                {w.label}
              </button>
            ))}
          </div>

          {/* Show paused toggle */}
          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={showPaused}
              onChange={(e) => setShowPaused(e.target.checked)}
              className="rounded border-[var(--border-default)] bg-[var(--bg-tertiary)]"
            />
            Mostrar pausados
          </label>
        </div>

        {/* Summary */}
        {data && !loading && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <SummaryCard label="Ads Ativos" value={String(data.active_ads)} />
            <SummaryCard label="Total Ads" value={String(data.total_ads)} />
            <SummaryCard label="Kill Candidates" value={String(data.kill_candidates)} color={data.kill_candidates > 0 ? "red" : undefined} />
            <SummaryCard label="Spend" value={fmt(data.total_spend, "R$ ")} />
            <SummaryCard label="CPL 5d" value={fmt(data.rolling_5d_cpl, "R$ ")} />
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
        ) : adsetGroups.length === 0 ? (
          <div className="text-center py-20 text-[var(--text-muted)]">Nenhum ad encontrado para esta janela.</div>
        ) : (
          <div className="space-y-3">
            {adsetGroups.map((group) => {
              const isExpanded = expandedAdsets.has(group.adset_id);
              return (
                <div key={group.adset_id} className="rounded-xl border border-[var(--border-default)] overflow-hidden">
                  {/* Adset header */}
                  <button
                    onClick={() => toggleAdset(group.adset_id)}
                    className="w-full flex items-center gap-3 px-4 py-3 bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors text-left"
                  >
                    <svg
                      width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{group.adset_name}</p>
                      <p className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
                        {group.active_count} ativos / {group.ads.length} ads
                        {group.kill_count > 0 && <span className="text-red-400 ml-2">{group.kill_count} kill</span>}
                      </p>
                    </div>
                    <div className="flex gap-6 text-xs text-[var(--text-secondary)] shrink-0">
                      <span>R$ {group.total_spend.toFixed(2)}</span>
                      <span>{group.total_leads} leads</span>
                      <span>{group.total_qualified} qual.</span>
                      <span>{group.total_leads > 0 ? `CPL R$ ${(group.total_spend / group.total_leads).toFixed(2)}` : "—"}</span>
                    </div>
                  </button>

                  {/* Ads table */}
                  {isExpanded && (
                    <div className="border-t border-[var(--border-default)] overflow-x-auto">
                      <table className="w-full text-xs min-w-[900px]">
                        <thead>
                          <tr className="bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] uppercase tracking-wider">
                            <th className="text-left px-4 py-2 font-medium">Ad</th>
                            <th className="text-center px-2 py-2 font-medium">Status</th>
                            <th className="text-center px-2 py-2 font-medium">Kill Rule</th>
                            <th className="text-right px-2 py-2 font-medium">Spend</th>
                            <th className="text-right px-2 py-2 font-medium">Impr.</th>
                            <th className="text-right px-2 py-2 font-medium">CTR</th>
                            <th className="text-right px-2 py-2 font-medium">Leads Meta</th>
                            <th className="text-right px-2 py-2 font-medium">Leads CRM</th>
                            <th className="text-right px-2 py-2 font-medium">Qual.</th>
                            <th className="text-right px-2 py-2 font-medium">CPL Meta</th>
                            <th className="text-right px-2 py-2 font-medium">CPL CRM</th>
                            <th className="text-center px-2 py-2 font-medium">Acao</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.ads.map((ad) => {
                            const isToggling = togglingAds.has(ad.ad_id);
                            const isActive = ad.effective_status === "ACTIVE";
                            return (
                              <tr key={ad.ad_id} className={`border-t border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors ${!isActive ? "opacity-50" : ""}`}>
                                <td className="px-4 py-2">
                                  <p className="font-medium truncate max-w-[200px]" title={ad.ad_name}>{ad.ad_name}</p>
                                  <p className="text-[9px] text-[var(--text-muted)] font-mono">{ad.ad_id}</p>
                                </td>
                                <td className="text-center px-2 py-2">
                                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                    isActive ? "bg-emerald-500/10 text-emerald-400" : "bg-gray-500/10 text-gray-400"
                                  }`}>
                                    <span className={`w-1.5 h-1.5 rounded-full ${isActive ? "bg-emerald-400" : "bg-gray-500"}`} />
                                    {isActive ? "ON" : "OFF"}
                                  </span>
                                </td>
                                <td className="text-center px-2 py-2">
                                  {ad.kill_rule ? (
                                    <span
                                      title={`${ad.kill_rule.level} — ${ad.kill_rule.name}\nAcao: ${ad.kill_rule.action === "kill" ? "Pausar" : ad.kill_rule.action === "warn" ? "Atenção" : "Promover"}\n\n${killRuleDescription(ad.kill_rule.level)}`}
                                      className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold cursor-help ${
                                      ad.kill_rule.action === "kill"
                                        ? "bg-red-500/10 text-red-400"
                                        : ad.kill_rule.action === "warn"
                                        ? "bg-yellow-500/10 text-yellow-400"
                                        : "bg-emerald-500/10 text-emerald-400"
                                    }`}>
                                      {ad.kill_rule.level}
                                    </span>
                                  ) : (
                                    <span className="text-[var(--text-muted)]" title="Nenhuma regra disparada — ad dentro dos parametros">OK</span>
                                  )}
                                </td>
                                <td className="text-right px-2 py-2 font-medium">{fmt(ad.spend, "R$ ")}</td>
                                <td className="text-right px-2 py-2 text-[var(--text-secondary)]">{fmtInt(ad.impressions || 0)}</td>
                                <td className="text-right px-2 py-2 text-[var(--text-secondary)]">{(ad.ctr || 0).toFixed(2)}%</td>
                                <td className="text-right px-2 py-2">{ad.leads || 0}</td>
                                <td className="text-right px-2 py-2 text-emerald-400">{(ad as any).leads_crm || 0}</td>
                                <td className="text-right px-2 py-2 text-blue-400">{ad.qualified_leads || 0}</td>
                                <td className="text-right px-2 py-2">
                                  {(ad as any).cpl_meta != null && (ad as any).cpl_meta > 0 ? (
                                    <span className={`font-medium ${(ad as any).cpl_meta <= 32.77 ? "text-emerald-400" : "text-red-400"}`}>
                                      R$ {(ad as any).cpl_meta.toFixed(2)}
                                    </span>
                                  ) : "—"}
                                </td>
                                <td className="text-right px-2 py-2">
                                  {ad.cpl > 0 ? (
                                    <span className={`font-medium ${ad.cpl <= 30 ? "text-emerald-400" : ad.cpl <= 50 ? "text-yellow-400" : "text-red-400"}`}>
                                      R$ {ad.cpl.toFixed(2)}
                                    </span>
                                  ) : "—"}
                                </td>
                                <td className="text-center px-2 py-2">
                                  <button
                                    onClick={() => toggleAdStatus(ad.ad_id, ad.effective_status)}
                                    disabled={isToggling}
                                    className={`p-1.5 rounded-lg transition-all ${
                                      isToggling
                                        ? "opacity-50 cursor-wait"
                                        : isActive
                                        ? "hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400"
                                        : "hover:bg-emerald-500/10 text-[var(--text-muted)] hover:text-emerald-400"
                                    }`}
                                    title={isActive ? "Pausar" : "Ativar"}
                                  >
                                    {isToggling ? (
                                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                                    ) : isActive ? (
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></svg>
                                    ) : (
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
                                    )}
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className={`p-3 rounded-xl border ${color === "red" ? "border-red-500/20 bg-red-500/5" : "border-[var(--border-default)] bg-[var(--bg-card)]"}`}>
      <p className="text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">{label}</p>
      <p className={`text-lg font-semibold ${color === "red" ? "text-red-400" : ""}`}>{value}</p>
    </div>
  );
}
