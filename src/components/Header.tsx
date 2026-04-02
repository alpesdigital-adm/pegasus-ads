"use client";

import { useGraphStore } from "@/store/graph";
import { useState, useEffect, useCallback } from "react";

interface DriveStatus {
  connected: boolean;
  folder_id?: string;
  folder_name?: string;
  email?: string;
}

interface DriveFolder {
  id: string;
  name: string;
}

function GoogleDriveButton() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [saving, setSaving] = useState(false);

  const checkStatus = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/drive/status");
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  const handleConnect = () => {
    window.location.href = "/api/auth/google";
  };

  const handleOpenModal = async () => {
    setShowModal(true);
    setLoadingFolders(true);
    try {
      const res = await fetch("/api/drive/folders", { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setFolders(data.folders || []);
      }
    } catch {
      setFolders([]);
    } finally {
      setLoadingFolders(false);
    }
  };

  const handleSelectFolder = async (folderId: string) => {
    setSaving(true);
    try {
      const res = await fetch("/api/drive/select-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_id: folderId }),
      });
      if (res.ok) {
        await checkStatus();
        setShowModal(false);
      }
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-slate-800/50 border border-slate-700/50">
        <div className="w-3 h-3 border-2 border-slate-600 border-t-slate-400 rounded-full animate-spin" />
        Drive
      </div>
    );
  }

  // Not connected
  if (!status?.connected) {
    return (
      <button
        onClick={handleConnect}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-300 bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50 hover:border-green-500/30 transition-all"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L4.5 14h5.5l-2 8L20 10h-5.5l2-8z" fill="#4285f4" opacity="0" />
          <path d="M7.71 3.5l-5.16 8.93 3.45 5.96h6.03" stroke="#0F9D58" strokeWidth="1.5" fill="none" />
          <path d="M7.71 3.5h10.3l-5.15 8.93H2.55" stroke="#4285F4" strokeWidth="1.5" fill="none" />
          <path d="M18.01 3.5l-5.15 8.93 3.45 5.96h5.14l-3.45-5.96" stroke="#F4B400" strokeWidth="1.5" fill="none" />
        </svg>
        Conectar Drive
      </button>
    );
  }

  // Connected but no folder selected
  if (!status.folder_id) {
    return (
      <>
        <button
          onClick={handleOpenModal}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 bg-amber-900/20 border border-amber-500/30 hover:bg-amber-900/30 transition-all"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Selecionar Pasta
        </button>
        {showModal && (
          <FolderModal
            folders={folders}
            loading={loadingFolders}
            saving={saving}
            onSelect={handleSelectFolder}
            onClose={() => setShowModal(false)}
          />
        )}
      </>
    );
  }

  // Connected and folder selected
  return (
    <>
      <button
        onClick={handleOpenModal}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-green-300 bg-green-900/20 border border-green-500/30 hover:bg-green-900/30 transition-all"
        title={`Drive conectado: ${status.folder_name || status.folder_id}`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <path d="M9 13l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Drive ✓
      </button>
      {showModal && (
        <FolderModal
          folders={folders}
          loading={loadingFolders}
          saving={saving}
          onSelect={handleSelectFolder}
          onClose={() => setShowModal(false)}
          currentFolderId={status.folder_id}
        />
      )}
    </>
  );
}

function FolderModal({
  folders,
  loading,
  saving,
  onSelect,
  onClose,
  currentFolderId,
}: {
  folders: DriveFolder[];
  loading: boolean;
  saving: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  currentFolderId?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-96 max-h-[70vh] rounded-xl overflow-hidden flex flex-col"
        style={{
          background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
          border: "1px solid rgba(59,130,246,0.2)",
          boxShadow: "0 0 40px rgba(59,130,246,0.1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="px-5 py-4 flex items-center justify-between border-b border-slate-700/50">
          <div>
            <h3 className="text-sm font-semibold text-white">Selecionar Pasta do Drive</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">As variações serão salvas automaticamente</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="ml-2 text-xs text-slate-400">Carregando pastas...</span>
            </div>
          ) : folders.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-xs text-slate-500">Nenhuma pasta encontrada</p>
              <p className="text-[10px] text-slate-600 mt-1">Crie uma pasta no Google Drive primeiro</p>
            </div>
          ) : (
            folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => onSelect(folder.id)}
                disabled={saving}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
                  folder.id === currentFolderId
                    ? "bg-blue-500/20 border border-blue-500/40 text-blue-300"
                    : "bg-slate-800/30 border border-transparent text-slate-300 hover:bg-slate-700/50 hover:border-slate-600/50"
                } disabled:opacity-50`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="text-xs font-medium truncate">{folder.name}</span>
                {folder.id === currentFolderId && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2.5" className="ml-auto shrink-0">
                    <path d="M20 6L9 17l-5-5" />
                  </svg>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

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
        <GoogleDriveButton />

        <div className="w-px h-6 bg-slate-700/50" />

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
