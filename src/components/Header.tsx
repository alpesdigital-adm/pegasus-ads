"use client";

import { useGraphStore } from "@/store/graph";

export function Header() {
  const { nodes, fetchGraph, loading } = useGraphStore();

  const totalCreatives = nodes.length;
  const winners = nodes.filter((n) => n.status === "winner").length;
  const testing = nodes.filter((n) => n.status === "testing").length;
  const totalLeads = nodes.reduce((sum, n) => sum + (n.metrics?.total_leads || 0), 0);

  return (
    <header
      className="h-16 flex items-center justify-between px-6 shrink-0"
      style={{
        background: "linear-gradient(90deg, #0f172a 0%, #1e293b 100%)",
        borderBottom: "1px solid rgba(59,130,246,0.15)",
      }}
    >
      <div className="flex items-center gap-4">
        {/* Logo */}
        <div className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{
              background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
              boxShadow: "0 0 20px rgba(59,130,246,0.3)",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Pegasus Ads
            </h1>
            <p className="text-[10px] text-slate-500 tracking-wider uppercase">
              Creative Intelligence
            </p>
          </div>
        </div>

        {/* Separator */}
        <div className="w-px h-8 bg-slate-700/50" />

        {/* Stats */}
        <div className="flex items-center gap-4">
          <Stat label="Criativos" value={totalCreatives} />
          <Stat label="Vencedores" value={winners} color="#10b981" />
          <Stat label="Em teste" value={testing} color="#3b82f6" />
          <Stat label="Leads" value={totalLeads} color="#8b5cf6" />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={fetchGraph}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50 hover:border-blue-500/30 transition-all disabled:opacity-50"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className={loading ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
            <path d="M21 3v5h-5" />
          </svg>
          Atualizar
        </button>
      </div>
    </header>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="text-center">
      <p className="text-[9px] text-slate-500 uppercase tracking-wider">{label}</p>
      <p className="text-sm font-bold" style={{ color: color || "#e2e8f0" }}>
        {value}
      </p>
    </div>
  );
}
