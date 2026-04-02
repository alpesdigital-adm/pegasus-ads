"use client";

import { useGraphStore } from "@/store/graph";
import type { GraphNode } from "@/lib/types";

const statusConfig: Record<string, { color: string; label: string }> = {
  generated: { color: "#64748b", label: "Gerado" },
  testing: { color: "#3b82f6", label: "Em teste" },
  winner: { color: "#10b981", label: "Vencedor" },
  killed: { color: "#ef4444", label: "Kill" },
  paused: { color: "#f59e0b", label: "Pausado" },
};

function getCplColor(cpl: number | null | undefined): string {
  if (cpl === null || cpl === undefined) return "#64748b";
  if (cpl <= 32.77) return "#10b981";
  if (cpl <= 49.16) return "#f59e0b";
  if (cpl <= 65.54) return "#f97316";
  return "#ef4444";
}

export function DetailPanel() {
  const selectedNode = useGraphStore((s) => s.selectedNode);
  const selectNode = useGraphStore((s) => s.selectNode);

  if (!selectedNode) return null;

  const config = statusConfig[selectedNode.status] || statusConfig.generated;
  const metrics = selectedNode.metrics;

  return (
    <div className="absolute right-4 top-4 bottom-4 w-80 z-50 overflow-y-auto rounded-2xl"
      style={{
        background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
        border: "1px solid rgba(59,130,246,0.2)",
        boxShadow: "0 0 40px rgba(0,0,0,0.6), 0 0 80px rgba(59,130,246,0.1)",
        backdropFilter: "blur(20px)",
      }}
    >
      {/* Close button */}
      <button
        onClick={() => selectNode(null)}
        className="absolute top-3 right-3 w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors z-10"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {/* Image */}
      <div className="relative aspect-square w-full">
        {selectedNode.blob_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selectedNode.blob_url}
            alt={selectedNode.name}
            className="w-full h-full object-cover rounded-t-2xl"
          />
        )}
        <div className="absolute inset-0 rounded-t-2xl"
          style={{ background: "linear-gradient(0deg, #0f172a 0%, transparent 50%)" }}
        />
      </div>

      {/* Content */}
      <div className="px-5 -mt-12 relative z-10 pb-5 space-y-4">
        {/* Name & Status */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: config.color }} />
            <span className="text-xs font-medium uppercase tracking-wider" style={{ color: config.color }}>
              {config.label}
            </span>
            <span className="text-xs text-slate-500">• Gen {selectedNode.generation}</span>
          </div>
          <h2 className="text-lg font-bold text-white">{selectedNode.name}</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {new Date(selectedNode.created_at).toLocaleDateString("pt-BR", {
              day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
            })}
          </p>
        </div>

        {/* Metrics Grid */}
        {metrics && metrics.total_spend > 0 ? (
          <div className="space-y-3">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Métricas
            </h3>

            {/* CPL Hero */}
            <div className="rounded-xl p-3 text-center"
              style={{
                background: `linear-gradient(135deg, ${getCplColor(metrics.cpl)}15, transparent)`,
                border: `1px solid ${getCplColor(metrics.cpl)}30`,
              }}
            >
              <p className="text-[10px] text-slate-400 uppercase tracking-wider">CPL</p>
              <p className="text-2xl font-black" style={{ color: getCplColor(metrics.cpl) }}>
                {metrics.cpl !== null ? `R$${metrics.cpl.toFixed(2)}` : "—"}
              </p>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-2 gap-2">
              <MetricCard label="Gasto" value={`R$${metrics.total_spend.toFixed(2)}`} />
              <MetricCard label="Leads" value={String(metrics.total_leads)} highlight />
              <MetricCard label="Impressões" value={metrics.total_impressions.toLocaleString("pt-BR")} />
              <MetricCard label="Clicks" value={String(metrics.total_clicks)} />
              <MetricCard label="CPM" value={`R$${metrics.avg_cpm.toFixed(2)}`} />
              <MetricCard label="CTR" value={`${metrics.avg_ctr.toFixed(2)}%`} />
              <MetricCard label="CPC" value={`R$${metrics.avg_cpc.toFixed(2)}`} />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-700/50 p-4 text-center">
            <p className="text-sm text-slate-500">Sem métricas ainda</p>
            <p className="text-[10px] text-slate-600 mt-1">
              Métricas são importadas via API
            </p>
          </div>
        )}

        {/* Prompt */}
        {selectedNode.prompt && (
          <div className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Prompt
            </h3>
            <div className="rounded-lg bg-slate-800/50 border border-slate-700/50 p-3">
              <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                {selectedNode.prompt.length > 300
                  ? selectedNode.prompt.slice(0, 300) + "…"
                  : selectedNode.prompt}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-800/30 border border-slate-700/30 px-3 py-2">
      <p className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className={`text-sm font-bold ${highlight ? "text-blue-400" : "text-slate-200"}`}>
        {value}
      </p>
    </div>
  );
}
