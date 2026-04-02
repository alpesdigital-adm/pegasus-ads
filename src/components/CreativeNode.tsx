"use client";

import { memo } from "react";
import { Handle, Position, type NodeProps } from "reactflow";
import type { GraphNode } from "@/lib/types";

const statusConfig = {
  generated: { color: "#64748b", label: "Gerado", glow: "rgba(100,116,139,0.3)" },
  testing: { color: "#3b82f6", label: "Em teste", glow: "rgba(59,130,246,0.3)" },
  winner: { color: "#10b981", label: "Vencedor", glow: "rgba(16,185,129,0.4)" },
  killed: { color: "#ef4444", label: "Kill", glow: "rgba(239,68,68,0.3)" },
  paused: { color: "#f59e0b", label: "Pausado", glow: "rgba(245,158,11,0.3)" },
};

const killRuleConfig: Record<"kill" | "warn" | "promote" | "observe", { bg: string; border: string; text: string }> = {
  kill:    { bg: "#ef444420", border: "#ef444450", text: "#ef4444" },
  warn:    { bg: "#f9731620", border: "#f9731650", text: "#f97316" },
  promote: { bg: "#10b98120", border: "#10b98150", text: "#10b981" },
  observe: { bg: "#8b5cf620", border: "#8b5cf650", text: "#8b5cf6" },
};

function getCplColor(cpl: number | null | undefined, cplTarget: number): string {
  if (cpl === null || cpl === undefined) return "#64748b";
  if (cpl <= cplTarget * 1.31) return "#10b981";   // ≤ 1.31x target → verde
  if (cpl <= cplTarget * 1.97) return "#f59e0b";   // ≤ 1.97x target → amarelo
  if (cpl <= cplTarget * 2.62) return "#f97316";   // ≤ 2.62x target → laranja
  return "#ef4444";                                  // > 2.62x target → vermelho
}

function CreativeNodeComponent({ data }: NodeProps<GraphNode>) {
  const config = statusConfig[data.status] || statusConfig.generated;
  const metrics = data.metrics;
  const cplTarget = data.cpl_target ?? 25;
  const cplColor = getCplColor(metrics?.cpl, cplTarget);
  const killRule = data.kill_rule;
  const killConfig = killRule ? killRuleConfig[killRule.action] : null;

  return (
    <div
      className="relative group"
      style={{
        width: 200,
        minHeight: 240,
      }}
    >
      {/* Kill rule badge — flutua acima do card */}
      {killRule && killConfig && (
        <div
          className="absolute -top-6 left-0 right-0 flex justify-center z-20"
        >
          <div
            className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider"
            style={{
              backgroundColor: killConfig.bg,
              border: `1px solid ${killConfig.border}`,
              color: killConfig.text,
            }}
          >
            <span>{killRule.level}</span>
            <span className="font-normal opacity-80">·</span>
            <span>{killRule.name}</span>
          </div>
        </div>
      )}

      {/* Card */}
      <div
        className="rounded-xl overflow-hidden transition-all duration-300 group-hover:scale-[1.02]"
        style={{
          background: "linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",
          border: killRule
            ? `1px solid ${killConfig?.border ?? "#475569"}`
            : `1px solid ${config.color}40`,
          boxShadow: killRule
            ? `0 0 20px ${killConfig?.bg ?? "transparent"}, 0 4px 24px rgba(0,0,0,0.4)`
            : `0 0 20px ${config.glow}, 0 4px 24px rgba(0,0,0,0.4)`,
        }}
      >
        {/* Status badge */}
        <div className="flex items-center justify-between px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <div
              className="w-2 h-2 rounded-full animate-pulse"
              style={{ backgroundColor: config.color }}
            />
            <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: config.color }}>
              {config.label}
            </span>
          </div>
          <span className="text-[9px] text-slate-500">G{data.generation}</span>
        </div>

        {/* Image */}
        <div className="relative w-full aspect-square bg-slate-800/50">
          {data.blob_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.blob_url}
              alt={data.name}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-600">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
              </svg>
            </div>
          )}
          {/* Gradient overlay */}
          <div
            className="absolute inset-0"
            style={{
              background: "linear-gradient(0deg, #0f172a 0%, transparent 40%)",
            }}
          />
        </div>

        {/* Placement badges */}
        {data.placements && data.placements.length > 0 && (
          <div className="absolute top-[38px] right-2 flex gap-1 z-10">
            {data.placements.includes("feed") && (
              <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">
                F
              </span>
            )}
            {data.placements.includes("stories") && (
              <span className="text-[8px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 border border-purple-500/30">
                S
              </span>
            )}
          </div>
        )}

        {/* Name */}
        <div className="px-3 -mt-6 relative z-10">
          <p className="text-xs font-semibold text-white truncate">{data.name}</p>
        </div>

        {/* Metrics */}
        {metrics && metrics.total_spend > 0 ? (
          <div className="px-3 py-2 space-y-1">
            <div className="grid grid-cols-3 gap-1">
              <MetricBadge label="CPL" value={metrics.cpl !== null ? `R$${metrics.cpl.toFixed(0)}` : "—"} color={cplColor} />
              <MetricBadge label="Leads" value={String(metrics.total_leads)} color="#3b82f6" />
              <MetricBadge label="CTR" value={`${metrics.avg_ctr.toFixed(1)}%`} color="#8b5cf6" />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] text-slate-500">
                R${metrics.total_spend.toFixed(0)} gasto
              </span>
              <span className="text-[9px] text-slate-500">
                {metrics.total_clicks} clicks
              </span>
            </div>
          </div>
        ) : (
          <div className="px-3 py-2">
            <span className="text-[10px] text-slate-600 italic">Sem métricas</span>
          </div>
        )}
      </div>

      {/* Handles */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !rounded-full !border-2"
        style={{ background: "#0f172a", borderColor: config.color }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !rounded-full !border-2"
        style={{ background: "#0f172a", borderColor: "#475569" }}
      />
    </div>
  );
}

function MetricBadge({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div
      className="rounded-md px-1.5 py-0.5 text-center"
      style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}
    >
      <p className="text-[8px] uppercase tracking-wider" style={{ color: `${color}90` }}>
        {label}
      </p>
      <p className="text-[11px] font-bold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

export const CreativeNode = memo(CreativeNodeComponent);
