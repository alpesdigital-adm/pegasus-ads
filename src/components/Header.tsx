"use client";

import { useGraphStore } from "@/store/graph";
import { useState, useEffect, useCallback, useRef } from "react";

interface DriveStatus {
  connected: boolean;
  folder_id?: string;
  folder_name?: string;
  email?: string;
}

// DriveFolder kept for type reference


function GoogleDriveButton() {
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

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

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch("/api/drive/disconnect", { method: "POST" });
      setStatus({ connected: false });
      setShowMenu(false);
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  };

  const handleReconnect = async () => {
    setDisconnecting(true);
    try {
      await fetch("/api/drive/disconnect", { method: "POST" });
      window.location.href = "/api/auth/google";
    } catch {
      setDisconnecting(false);
    }
  };

  const handleOpenModal = () => {
    setShowModal(true);
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

  // Connected (with or without folder)
  const isFullySetup = !!status.folder_id;

  return (
    <>
      <div className="relative">
        <div className="flex items-center">
          {/* Main action button */}
          <button
            onClick={isFullySetup ? handleOpenModal : handleOpenModal}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-l-lg text-xs font-medium transition-all ${
              isFullySetup
                ? "text-green-300 bg-green-900/20 border border-green-500/30 hover:bg-green-900/30"
                : "text-amber-300 bg-amber-900/20 border border-amber-500/30 hover:bg-amber-900/30"
            }`}
            title={isFullySetup ? `Drive: ${status.folder_name || status.folder_id}` : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              {isFullySetup && <path d="M9 13l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />}
            </svg>
            {isFullySetup ? "Drive ✓" : "Selecionar Pasta"}
          </button>

          {/* Dropdown trigger */}
          <button
            onClick={() => setShowMenu(!showMenu)}
            className={`flex items-center px-1.5 py-1.5 rounded-r-lg text-xs font-medium transition-all border-l-0 ${
              isFullySetup
                ? "text-green-300 bg-green-900/20 border border-green-500/30 hover:bg-green-900/30"
                : "text-amber-300 bg-amber-900/20 border border-amber-500/30 hover:bg-amber-900/30"
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>

        {/* Dropdown menu */}
        {showMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
            <div
              className="absolute right-0 top-full mt-1 w-48 rounded-lg overflow-hidden z-50"
              style={{
                background: "#1e293b",
                border: "1px solid rgba(59,130,246,0.2)",
                boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
              }}
            >
              <button
                onClick={() => { setShowMenu(false); handleOpenModal(); }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-slate-700/50 transition-colors text-left"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                {isFullySetup ? "Trocar Pasta" : "Selecionar Pasta"}
              </button>
              <button
                onClick={handleReconnect}
                disabled={disconnecting}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-blue-300 hover:bg-slate-700/50 transition-colors text-left disabled:opacity-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                </svg>
                Reconectar Drive
              </button>
              <div className="border-t border-slate-700/50" />
              <button
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-red-900/20 transition-colors text-left disabled:opacity-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
                Desconectar
              </button>
            </div>
          </>
        )}
      </div>

      {showModal && (
        <FolderBrowser
          saving={saving}
          onSelect={handleSelectFolder}
          onClose={() => setShowModal(false)}
          currentFolderId={status.folder_id}
        />
      )}
    </>
  );
}

interface BrowseItem {
  id: string;
  name: string;
  type: "my_drive" | "shared_drive" | "folder";
  hasChildren: boolean;
}

interface BreadcrumbItem {
  id: string;
  name: string;
  driveId?: string;
}

function FolderBrowser({
  saving,
  onSelect,
  onClose,
  currentFolderId,
}: {
  saving: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  currentFolderId?: string;
}) {
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [activeDriveId, setActiveDriveId] = useState<string | undefined>(undefined);

  const currentFolderName = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].name : null;
  const currentBrowseId = breadcrumbs.length > 0 ? breadcrumbs[breadcrumbs.length - 1].id : null;

  const loadFolder = useCallback(async (parentId?: string, driveId?: string) => {
    setLoading(true);
    try {
      const body: Record<string, string> = {};
      if (parentId) body.parent_id = parentId;
      if (driveId) body.drive_id = driveId;

      const res = await fetch("/api/drive/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      } else {
        setItems([]);
      }
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load roots on mount
  useEffect(() => {
    loadFolder();
  }, [loadFolder]);

  const handleNavigateInto = (item: BrowseItem) => {
    const newDriveId = item.type === "shared_drive" ? item.id : activeDriveId;
    setActiveDriveId(newDriveId);
    setBreadcrumbs((prev) => [...prev, { id: item.id, name: item.name, driveId: newDriveId }]);
    loadFolder(item.id, newDriveId);
  };

  const handleBreadcrumbClick = (index: number) => {
    if (index < 0) {
      // Go to root
      setBreadcrumbs([]);
      setActiveDriveId(undefined);
      loadFolder();
    } else {
      const target = breadcrumbs[index];
      setBreadcrumbs((prev) => prev.slice(0, index + 1));
      setActiveDriveId(target.driveId);
      loadFolder(target.id, target.driveId);
    }
  };

  const handleSelectCurrent = () => {
    if (currentBrowseId) {
      onSelect(currentBrowseId);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        className="w-[440px] max-h-[75vh] rounded-xl overflow-hidden flex flex-col"
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
            <h3 className="text-sm font-semibold text-white">Navegar Google Drive</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">Escolha a pasta onde salvar os criativos</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Breadcrumbs */}
        <div className="px-4 py-2 flex items-center gap-1 overflow-x-auto border-b border-slate-800/50" style={{ minHeight: 36 }}>
          <button
            onClick={() => handleBreadcrumbClick(-1)}
            className={`shrink-0 text-[11px] px-1.5 py-0.5 rounded transition-colors ${
              breadcrumbs.length === 0
                ? "text-blue-400 font-medium"
                : "text-slate-400 hover:text-white"
            }`}
          >
            Drive
          </button>
          {breadcrumbs.map((bc, i) => (
            <div key={bc.id} className="flex items-center gap-1 shrink-0">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5">
                <path d="M9 18l6-6-6-6" />
              </svg>
              <button
                onClick={() => handleBreadcrumbClick(i)}
                className={`text-[11px] px-1.5 py-0.5 rounded transition-colors truncate max-w-[120px] ${
                  i === breadcrumbs.length - 1
                    ? "text-blue-400 font-medium"
                    : "text-slate-400 hover:text-white"
                }`}
                title={bc.name}
              >
                {bc.name}
              </button>
            </div>
          ))}
        </div>

        {/* Folder list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-0.5" style={{ minHeight: 200 }}>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="ml-2 text-xs text-slate-400">Carregando...</span>
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-12">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5" className="mx-auto mb-2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-xs text-slate-500">Pasta vazia</p>
              <p className="text-[10px] text-slate-600 mt-1">Nenhuma subpasta encontrada aqui</p>
            </div>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                onClick={() => handleNavigateInto(item)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all group ${
                  item.id === currentFolderId
                    ? "bg-blue-500/15 border border-blue-500/30"
                    : "border border-transparent hover:bg-slate-700/40 hover:border-slate-600/30"
                }`}
              >
                {/* Icon */}
                {item.type === "shared_drive" ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="shrink-0">
                    <path d="M7.71 3.5l-5.16 8.93 3.45 5.96h6.03" stroke="#0F9D58" strokeWidth="1.5" />
                    <path d="M7.71 3.5h10.3l-5.15 8.93H2.55" stroke="#4285F4" strokeWidth="1.5" />
                    <path d="M18.01 3.5l-5.15 8.93 3.45 5.96h5.14l-3.45-5.96" stroke="#F4B400" strokeWidth="1.5" />
                  </svg>
                ) : item.type === "my_drive" ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" className="shrink-0">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v8M8 12h8" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={item.id === currentFolderId ? "#60a5fa" : "#64748b"} strokeWidth="1.5" className="shrink-0">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                )}

                {/* Name */}
                <span className={`text-xs font-medium truncate flex-1 ${
                  item.id === currentFolderId ? "text-blue-300" : "text-slate-300"
                }`}>
                  {item.name}
                </span>

                {/* Current folder indicator */}
                {item.id === currentFolderId && (
                  <span className="text-[9px] text-blue-400 bg-blue-500/15 px-1.5 py-0.5 rounded shrink-0">ATUAL</span>
                )}

                {/* Chevron */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2" className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
            ))
          )}
        </div>

        {/* Footer: select current folder */}
        <div className="px-4 py-3 border-t border-slate-700/50 flex items-center justify-between">
          <div className="text-[10px] text-slate-500 truncate mr-3">
            {currentFolderName ? (
              <span>Pasta: <span className="text-slate-300">{currentFolderName}</span></span>
            ) : (
              <span>Navegue e selecione uma pasta</span>
            )}
          </div>
          <button
            onClick={handleSelectCurrent}
            disabled={!currentBrowseId || saving}
            className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {saving ? (
              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M20 6L9 17l-5-5" />
              </svg>
            )}
            Selecionar esta pasta
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Botão: Relatório de Testes (Google Sheets) ───────────────────────────────

interface SheetStatus {
  deployed: boolean;
  spreadsheet_id?: string;
  spreadsheet_url?: string;
  last_sync?: string | null;
}

function TestLogButton() {
  const [status, setStatus] = useState<SheetStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [showTip, setShowTip] = useState(false);
  const tipTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/test-log-sheet");
      if (res.ok) setStatus(await res.json());
    } catch {
      setStatus({ deployed: false });
    }
  }, []);

  useEffect(() => { checkStatus(); }, [checkStatus]);

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/test-log-sheet", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setStatus({
          deployed:        true,
          spreadsheet_id:  data.spreadsheet_id,
          spreadsheet_url: data.spreadsheet_url,
          last_sync:       data.last_sync,
        });
        // Feedback visual rápido
        setShowTip(true);
        tipTimeout.current = setTimeout(() => setShowTip(false), 4000);
      } else {
        setError(data.error || "Erro desconhecido");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSyncing(false);
    }
  };

  useEffect(() => () => { if (tipTimeout.current) clearTimeout(tipTimeout.current); }, []);

  const formatLastSync = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  };

  const isDeployed = status?.deployed;

  return (
    <div className="relative">
      <div className="flex items-center">
        {/* Botão principal — sync */}
        <button
          onClick={handleSync}
          disabled={syncing}
          title={isDeployed ? `Última sync: ${status?.last_sync ? formatLastSync(status.last_sync) : "—"}` : "Criar planilha de testes no Google Sheets"}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-l-lg text-xs font-medium transition-all disabled:opacity-60 disabled:cursor-wait ${
            error
              ? "text-red-300 bg-red-900/20 border border-red-500/30 hover:bg-red-900/30"
              : isDeployed
              ? "text-emerald-300 bg-emerald-900/20 border border-emerald-500/30 hover:bg-emerald-900/30"
              : "text-slate-300 bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50 hover:border-emerald-500/30"
          }`}
        >
          {syncing ? (
            <div className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            /* Sheets icon */
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M3 9h18M3 15h18M9 3v18" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          )}
          {syncing
            ? (isDeployed ? "Atualizando..." : "Criando...")
            : error
            ? "Erro ✕"
            : isDeployed
            ? "Relatório ✓"
            : "Criar Relatório"}
        </button>

        {/* Botão de abrir planilha (só aparece quando deployado) */}
        {isDeployed && status?.spreadsheet_url && (
          <a
            href={status.spreadsheet_url}
            target="_blank"
            rel="noopener noreferrer"
            title="Abrir no Google Sheets"
            className="flex items-center px-1.5 py-1.5 rounded-r-lg text-xs font-medium transition-all border-l-0 text-emerald-300 bg-emerald-900/20 border border-emerald-500/30 hover:bg-emerald-900/30"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        )}
      </div>

      {/* Tooltip de sucesso */}
      {showTip && (
        <div
          className="absolute right-0 top-full mt-2 px-3 py-2 rounded-lg text-[11px] text-emerald-300 whitespace-nowrap z-50 pointer-events-none"
          style={{ background: "#0d2016", border: "1px solid rgba(52,211,153,0.25)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}
        >
          ✓ Planilha atualizada com sucesso
        </div>
      )}

      {/* Tooltip de erro */}
      {error && (
        <div
          className="absolute right-0 top-full mt-2 w-64 px-3 py-2 rounded-lg text-[11px] text-red-300 z-50 cursor-pointer"
          style={{ background: "#1a0808", border: "1px solid rgba(239,68,68,0.25)", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}
          onClick={() => setError(null)}
          title="Clique para fechar"
        >
          {error}
        </div>
      )}
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

        <TestLogButton />

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
