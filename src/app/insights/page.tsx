"use client";

import { useEffect, useState, useCallback } from "react";
import AppShell from "@/components/AppShell";

// ── Types ──

interface DayRow {
  date: string;
  campaign: string;
  adset: string;
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
}

interface AdNode {
  ad_name: string;
  format: string;
  hook: string;
  motor: string;
  status: string;
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  days: DayRow[];
}

interface AngleNode {
  code: string;
  name: string;
  motor: string;
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  ads: AdNode[];
}

interface ConceptNode {
  code: string;
  name: string;
  offer_key: string;
  offer_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  angles: AngleNode[];
}

interface Totals {
  spend: number;
  impressions: number;
  clicks: number;
  lpv: number;
  leads_meta: number;
  leads_crm: number;
  leads_qualified: number;
  total_concepts: number;
  total_angles: number;
  total_ads: number;
}

interface Filters {
  offers: { key: string; name: string }[];
  concepts: { code: string; name: string }[];
  launches: { key: string; name: string }[];
  formats: string[];
  campaigns: string[];
  adsets: string[];
}

// ── Formatters ──

function fmt(n: number | null | undefined, prefix = ""): string {
  if (n == null || isNaN(n)) return "—";
  return prefix + n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtInt(n: number): string {
  return n.toLocaleString("pt-BR");
}

function fmtPct(n: number): string {
  if (isNaN(n) || !isFinite(n)) return "—";
  return n.toFixed(2) + "%";
}

function cpl(spend: number, leads: number): string {
  if (!leads) return "—";
  return fmt(spend / leads, "R$ ");
}

function ctr(clicks: number, impressions: number): string {
  if (!impressions) return "—";
  return fmtPct((clicks / impressions) * 100);
}

// ── Offer color palette ──

const OFFER_COLORS: Record<string, { bg: string; text: string }> = {
  ebmx:  { bg: "rgba(59, 130, 246, 0.15)",  text: "#60a5fa" },   // blue
  ebanp: { bg: "rgba(168, 85, 247, 0.15)",  text: "#c084fc" },   // purple
  ebder: { bg: "rgba(34, 197, 94, 0.15)",   text: "#4ade80" },   // green
  ebntr: { bg: "rgba(245, 158, 11, 0.15)",  text: "#fbbf24" },   // amber
  ebpel: { bg: "rgba(236, 72, 153, 0.15)",  text: "#f472b6" },   // pink
  ebcap: { bg: "rgba(20, 184, 166, 0.15)",  text: "#2dd4bf" },   // teal
};

const FALLBACK_COLORS = [
  { bg: "rgba(239, 68, 68, 0.15)",  text: "#f87171" },   // red
  { bg: "rgba(6, 182, 212, 0.15)",  text: "#22d3ee" },   // cyan
  { bg: "rgba(249, 115, 22, 0.15)", text: "#fb923c" },   // orange
  { bg: "rgba(132, 204, 22, 0.15)", text: "#a3e635" },   // lime
];

function offerColor(key: string): { bg: string; text: string } {
  const k = key.toLowerCase();
  if (OFFER_COLORS[k]) return OFFER_COLORS[k];
  // Deterministic fallback based on string hash
  let hash = 0;
  for (let i = 0; i < k.length; i++) hash = ((hash << 5) - hash + k.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// ── Period options ──

const PERIOD_OPTIONS = [
  { label: "Hoje", value: 1 },
  { label: "3 dias", value: 3 },
  { label: "7 dias", value: 7 },
  { label: "14 dias", value: 14 },
  { label: "30 dias", value: 30 },
  { label: "Lifetime", value: 9999 },
];

// ── Chevron ──

function Chevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.15s ease",
        flexShrink: 0,
      }}
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

// ── Column headers ──

const METRIC_COLS = [
  { key: "spend", label: "Spend", align: "right" as const },
  { key: "impressions", label: "Impr.", align: "right" as const },
  { key: "clicks", label: "Clicks", align: "right" as const },
  { key: "ctr", label: "CTR", align: "right" as const },
  { key: "leads_meta", label: "Leads Meta", align: "right" as const },
  { key: "leads_crm", label: "Leads CRM", align: "right" as const },
  { key: "leads_qualified", label: "Qualificados", align: "right" as const },
  { key: "cpl_crm", label: "CPL CRM", align: "right" as const },
];

function MetricCells({ row }: { row: { spend: number; impressions: number; clicks: number; leads_meta: number; leads_crm: number; leads_qualified: number } }) {
  return (
    <>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmt(row.spend, "R$ ")}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmtInt(row.impressions)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmtInt(row.clicks)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{ctr(row.clicks, row.impressions)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmtInt(row.leads_meta)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmtInt(row.leads_crm)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{fmtInt(row.leads_qualified)}</td>
      <td className="px-3 py-2 text-right font-mono text-sm whitespace-nowrap">{cpl(row.spend, row.leads_crm)}</td>
    </>
  );
}

// ── Main page ──

export default function InsightsPage() {
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Data
  const [concepts, setConcepts] = useState<ConceptNode[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [filters, setFilters] = useState<Filters | null>(null);

  // Filter state
  const [fOffer, setFOffer] = useState("");
  const [fConcept, setFConcept] = useState("");
  const [fLaunch, setFLaunch] = useState("");
  const [fFormat, setFFormat] = useState("");
  const [fCampaign, setFCampaign] = useState("");
  const [fAdset, setFAdset] = useState("");

  // Expansion state
  const [expandedConcepts, setExpandedConcepts] = useState<Set<string>>(new Set());
  const [expandedAngles, setExpandedAngles] = useState<Set<string>>(new Set());
  const [expandedAds, setExpandedAds] = useState<Set<string>>(new Set());

  const toggleConcept = (key: string) => {
    setExpandedConcepts(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAngle = (key: string) => {
    setExpandedAngles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAd = (key: string) => {
    setExpandedAds(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ days: String(days) });
      if (fOffer) params.set("offer", fOffer);
      if (fConcept) params.set("concept", fConcept);
      if (fLaunch) params.set("launch", fLaunch);
      if (fFormat) params.set("format", fFormat);
      if (fCampaign) params.set("campaign", fCampaign);
      if (fAdset) params.set("adset", fAdset);

      const r = await fetch(`/api/reports/creative-performance?${params}`);
      const data = await r.json();
      if (data.error) {
        setError(data.error);
      } else {
        setConcepts(data.concepts || []);
        setTotals(data.totals || null);
        setFilters(data.filters || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days, fOffer, fConcept, fLaunch, fFormat, fCampaign, fAdset]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Expand / Collapse all
  const expandAll = () => {
    const cKeys = new Set(concepts.map(c => `${c.offer_key}|${c.code}`));
    const aKeys = new Set<string>();
    const adKeys = new Set<string>();
    for (const c of concepts) {
      for (const a of c.angles) {
        aKeys.add(`${c.offer_key}|${c.code}|${a.code}`);
        for (const ad of a.ads) {
          adKeys.add(ad.ad_name);
        }
      }
    }
    setExpandedConcepts(cKeys);
    setExpandedAngles(aKeys);
    setExpandedAds(adKeys);
  };

  const collapseAll = () => {
    setExpandedConcepts(new Set());
    setExpandedAngles(new Set());
    setExpandedAds(new Set());
  };

  return (
    <AppShell fullWidth>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
              Creative Insights
            </h1>
            <p className="text-sm mt-1" style={{ color: "var(--text-tertiary)" }}>
              Performance por conceito, ângulo e criativo
            </p>
          </div>
          <div className="flex items-center gap-2">
            {PERIOD_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setDays(opt.value)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium transition-all"
                style={{
                  background: days === opt.value ? "var(--accent)" : "var(--bg-tertiary)",
                  color: days === opt.value ? "#fff" : "var(--text-secondary)",
                  border: `1px solid ${days === opt.value ? "var(--accent)" : "var(--border-default)"}`,
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Filters */}
        {filters && (
          <div
            className="rounded-xl p-4 flex flex-wrap items-end gap-3"
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-default)" }}
          >
            <FilterSelect label="Oferta" value={fOffer} onChange={setFOffer}
              options={filters.offers.map(o => ({ value: o.key, label: o.name }))} />
            <FilterSelect label="Conceito" value={fConcept} onChange={setFConcept}
              options={filters.concepts.map(c => ({ value: c.code, label: `${c.code} — ${c.name}` }))} />
            <FilterSelect label="Lançamento" value={fLaunch} onChange={setFLaunch}
              options={filters.launches.map(l => ({ value: l.key, label: l.name }))} />
            <FilterSelect label="Formato" value={fFormat} onChange={setFFormat}
              options={filters.formats.map(f => ({ value: f, label: f }))} />
            <FilterSelect label="Campanha" value={fCampaign} onChange={setFCampaign}
              options={filters.campaigns.map(c => ({ value: c, label: c }))} />
            <FilterSelect label="Ad Set" value={fAdset} onChange={setFAdset}
              options={filters.adsets.map(a => ({ value: a, label: a }))} />

            {(fOffer || fConcept || fLaunch || fFormat || fCampaign || fAdset) && (
              <button
                onClick={() => { setFOffer(""); setFConcept(""); setFLaunch(""); setFFormat(""); setFCampaign(""); setFAdset(""); }}
                className="px-3 py-2 rounded-lg text-sm transition-colors"
                style={{ color: "var(--error)", background: "var(--error-bg)" }}
              >
                Limpar filtros
              </button>
            )}
          </div>
        )}

        {/* Summary cards */}
        {totals && !loading && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <SummaryCard label="Spend" value={fmt(totals.spend, "R$ ")} />
            <SummaryCard label="Leads Meta" value={fmtInt(totals.leads_meta)} />
            <SummaryCard label="Leads CRM" value={fmtInt(totals.leads_crm)} />
            <SummaryCard label="Qualificados" value={fmtInt(totals.leads_qualified)} />
            <SummaryCard label="CPL CRM" value={cpl(totals.spend, totals.leads_crm)} />
            <SummaryCard label="Conceitos" value={String(totals.total_concepts)} />
            <SummaryCard label="Criativos" value={String(totals.total_ads)} />
          </div>
        )}

        {/* Loading / Error */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 rounded-lg animate-pulse flex items-center justify-center" style={{ background: "var(--accent)" }}>
              <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
                <path d="M9 2L15 6V12L9 16L3 12V6L9 2Z" fill="white" fillOpacity="0.9" />
              </svg>
            </div>
            <span className="ml-3 text-sm" style={{ color: "var(--text-tertiary)" }}>Carregando dados...</span>
          </div>
        )}

        {error && (
          <div className="rounded-xl p-4 text-sm" style={{ background: "var(--error-bg)", color: "var(--error)", border: "1px solid var(--error)" }}>
            {error}
          </div>
        )}

        {/* Grid */}
        {!loading && !error && concepts.length > 0 && (
          <div
            className="rounded-xl overflow-hidden"
            style={{ background: "var(--bg-card)", border: "1px solid var(--border-default)" }}
          >
            {/* Toolbar */}
            <div className="flex items-center justify-between px-4 py-2" style={{ borderBottom: "1px solid var(--border-default)" }}>
              <span className="text-xs font-medium" style={{ color: "var(--text-tertiary)" }}>
                {totals?.total_concepts} conceitos · {totals?.total_angles} ângulos · {totals?.total_ads} criativos
              </span>
              <div className="flex gap-2">
                <button onClick={expandAll} className="text-xs px-2 py-1 rounded" style={{ color: "var(--accent)", background: "var(--accent-glow)" }}>
                  Expandir tudo
                </button>
                <button onClick={collapseAll} className="text-xs px-2 py-1 rounded" style={{ color: "var(--text-tertiary)", background: "var(--bg-tertiary)" }}>
                  Recolher
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full" style={{ minWidth: 1100 }}>
                <thead>
                  <tr style={{ background: "var(--bg-tertiary)", borderBottom: "1px solid var(--border-default)" }}>
                    <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)", width: 340 }}>
                      Conceito / Ângulo / Ad
                    </th>
                    <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)", width: 80 }}>
                      Formato
                    </th>
                    {METRIC_COLS.map(col => (
                      <th key={col.key} className="px-3 py-2.5 text-right text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--text-tertiary)" }}>
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* Totals row */}
                  <tr style={{ background: "rgba(59, 130, 246, 0.06)", borderBottom: "1px solid var(--border-default)" }}>
                    <td className="px-4 py-2.5 text-sm font-bold" style={{ color: "var(--accent)" }} colSpan={2}>
                      TOTAL
                    </td>
                    {totals && <MetricCells row={totals} />}
                  </tr>

                  {concepts.map(concept => {
                    const cKey = `${concept.offer_key}|${concept.code}`;
                    const cOpen = expandedConcepts.has(cKey);

                    return (
                      <ConceptRowGroup
                        key={cKey}
                        concept={concept}
                        cKey={cKey}
                        isOpen={cOpen}
                        onToggle={() => toggleConcept(cKey)}
                        expandedAngles={expandedAngles}
                        expandedAds={expandedAds}
                        toggleAngle={toggleAngle}
                        toggleAd={toggleAd}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && concepts.length === 0 && (
          <div className="text-center py-20">
            <p className="text-sm" style={{ color: "var(--text-tertiary)" }}>
              Nenhum dado encontrado para os filtros selecionados.
            </p>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ── Concept Row Group ──

function ConceptRowGroup({
  concept, cKey, isOpen, onToggle,
  expandedAngles, expandedAds, toggleAngle, toggleAd,
}: {
  concept: ConceptNode;
  cKey: string;
  isOpen: boolean;
  onToggle: () => void;
  expandedAngles: Set<string>;
  expandedAds: Set<string>;
  toggleAngle: (key: string) => void;
  toggleAd: (key: string) => void;
}) {
  // (pctSpend removido — placeholder que nunca foi usado)

  return (
    <>
      {/* Concept row */}
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors"
        style={{
          background: isOpen ? "rgba(59, 130, 246, 0.04)" : "transparent",
          borderBottom: "1px solid var(--border-default)",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={e => (e.currentTarget.style.background = isOpen ? "rgba(59, 130, 246, 0.04)" : "transparent")}
      >
        <td className="px-4 py-2.5" colSpan={2}>
          <div className="flex items-center gap-2">
            <Chevron open={isOpen} />
            <span className="text-xs font-medium px-1.5 py-0.5 rounded" style={{ background: offerColor(concept.offer_key).bg, color: offerColor(concept.offer_key).text }}>
              {concept.offer_key.toUpperCase()}
            </span>
            <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {concept.code} — {concept.name}
            </span>
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              ({concept.angles.length} âng · {concept.angles.reduce((s, a) => s + a.ads.length, 0)} ads)
            </span>
          </div>
        </td>
        <MetricCells row={concept} />
      </tr>

      {/* Angle rows */}
      {isOpen && concept.angles.map(angle => {
        const aKey = `${cKey}|${angle.code}`;
        const aOpen = expandedAngles.has(aKey);

        return (
          <AngleRowGroup
            key={aKey}
            angle={angle}
            isOpen={aOpen}
            onToggle={() => toggleAngle(aKey)}
            expandedAds={expandedAds}
            toggleAd={toggleAd}
          />
        );
      })}
    </>
  );
}

// ── Angle Row Group ──

function AngleRowGroup({
  angle, isOpen, onToggle,
  expandedAds, toggleAd,
}: {
  angle: AngleNode;
  isOpen: boolean;
  onToggle: () => void;
  expandedAds: Set<string>;
  toggleAd: (key: string) => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors"
        style={{
          background: isOpen ? "rgba(34, 197, 94, 0.03)" : "transparent",
          borderBottom: "1px solid var(--border-default)",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={e => (e.currentTarget.style.background = isOpen ? "rgba(34, 197, 94, 0.03)" : "transparent")}
      >
        <td className="py-2" colSpan={2}>
          <div className="flex items-center gap-2" style={{ paddingLeft: 40 }}>
            <Chevron open={isOpen} size={12} />
            <span className="text-xs font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--bg-tertiary)", color: "var(--success)" }}>
              {angle.code}
            </span>
            <span className="text-sm" style={{ color: "var(--text-primary)" }}>
              {angle.name}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--warning-bg)", color: "var(--warning)" }}>
              {angle.motor}
            </span>
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              ({angle.ads.length} ads)
            </span>
          </div>
        </td>
        <MetricCells row={angle} />
      </tr>

      {/* Ad rows */}
      {isOpen && angle.ads.map(ad => {
        const adOpen = expandedAds.has(ad.ad_name);

        return (
          <AdRowGroup
            key={ad.ad_name}
            ad={ad}
            isOpen={adOpen}
            onToggle={() => toggleAd(ad.ad_name)}
          />
        );
      })}
    </>
  );
}

// ── Ad Row Group ──

function AdRowGroup({ ad, isOpen, onToggle }: { ad: AdNode; isOpen: boolean; onToggle: () => void }) {
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors"
        style={{
          background: isOpen ? "rgba(245, 158, 11, 0.03)" : "transparent",
          borderBottom: "1px solid var(--border-default)",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg-hover)")}
        onMouseLeave={e => (e.currentTarget.style.background = isOpen ? "rgba(245, 158, 11, 0.03)" : "transparent")}
      >
        <td className="py-2">
          <div className="flex items-center gap-2" style={{ paddingLeft: 68 }}>
            <Chevron open={isOpen} size={10} />
            <span className="text-sm font-mono" style={{ color: "var(--text-primary)" }}>
              {ad.ad_name}
            </span>
            {ad.status === "active" ? (
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--success)" }} />
            ) : (
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--text-muted)" }} />
            )}
          </div>
        </td>
        <td className="px-3 py-2">
          <span className="text-xs px-1.5 py-0.5 rounded" style={{
            background: ad.format === "Carrossel" ? "rgba(139, 92, 246, 0.1)" : ad.format === "Vídeo" ? "rgba(236, 72, 153, 0.1)" : "var(--bg-tertiary)",
            color: ad.format === "Carrossel" ? "#8b5cf6" : ad.format === "Vídeo" ? "#ec4899" : "var(--text-secondary)",
          }}>
            {ad.format}
          </span>
        </td>
        <MetricCells row={ad} />
      </tr>

      {/* Hook preview */}
      {isOpen && ad.hook && (
        <tr style={{ borderBottom: "1px solid var(--border-default)" }}>
          <td colSpan={10} className="py-1.5" style={{ paddingLeft: 92 }}>
            <span className="text-xs italic" style={{ color: "var(--text-tertiary)" }}>
              Hook: {ad.hook}
            </span>
          </td>
        </tr>
      )}

      {/* Day breakdown rows */}
      {isOpen && ad.days.map((day, i) => (
        <tr
          key={`${ad.ad_name}-${day.date}-${day.campaign}-${day.adset}-${i}`}
          style={{
            background: "var(--bg-secondary)",
            borderBottom: "1px solid var(--border-default)",
          }}
        >
          <td className="py-1.5" colSpan={2}>
            <div className="flex items-center gap-2" style={{ paddingLeft: 92 }}>
              <span className="text-xs font-mono" style={{ color: "var(--text-tertiary)" }}>
                {day.date}
              </span>
              <span className="text-xs truncate" style={{ color: "var(--text-muted)", maxWidth: 140 }} title={day.campaign}>
                {day.campaign}
              </span>
              <span className="text-xs truncate" style={{ color: "var(--text-muted)", maxWidth: 120 }} title={day.adset}>
                {day.adset}
              </span>
            </div>
          </td>
          <MetricCells row={day} />
        </tr>
      ))}
    </>
  );
}

// ── Filter Select ──

function FilterSelect({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium" style={{ color: "var(--text-tertiary)" }}>
        {label}
      </label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="text-sm rounded-lg px-3 py-2"
        style={{
          background: "var(--bg-tertiary)",
          border: `1px solid ${value ? "var(--accent)" : "var(--border-default)"}`,
          color: "var(--text-primary)",
          minWidth: 130,
        }}
      >
        <option value="">Todos</option>
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );
}

// ── Summary Card ──

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3"
      style={{ background: "var(--bg-card)", border: "1px solid var(--border-default)" }}
    >
      <div className="text-xs font-medium mb-1" style={{ color: "var(--text-tertiary)" }}>{label}</div>
      <div className="text-lg font-semibold font-mono" style={{ color: "var(--text-primary)" }}>{value}</div>
    </div>
  );
}
