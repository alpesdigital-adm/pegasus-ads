"use client";

import { useGraphStore } from "@/store/graph";
import { useAuthStore } from "@/store/auth";
import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

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

interface AlertCounts {
  unresolved: number;
  critical: number;
  warnings: number;
  promotions: number;
}

interface AlertRow {
  id: string;
  creative_id?: string;
  creative_name?: string;
  level: string;
  rule_name?: string;
  message: string;
  spend?: number;
  cpl?: number;
  cpl_target?: number;
  date: string;
  resolved: boolean;
  created_at: string;
}

function AlertBell() {
  const [counts, setCounts] = useState<AlertCounts | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [open, setOpen] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/alerts?limit=30");
      if (!res.ok) return;
      const data = await res.json();
      setCounts(data.counts);
      setAlerts(data.alerts || []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadAlerts();
    const interval = setInterval(loadAlerts, 60_000); // refresh a cada 1 min
    return () => clearInterval(interval);
  }, [loadAlerts]);

  const handleResolve = async (alertId: string) => {
    setResolving(alertId);
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alertId }),
      });
      await loadAlerts();
    } finally {
      setResolving(null);
    }
  };

  const handleResolveAll = async () => {
    setResolving("all");
    try {
      await fetch("/api/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolve_all: true }),
      });
      await loadAlerts();
      setOpen(false);
    } finally {
      setResolving(null);
    }
  };

  const unresolved = counts?.unresolved ?? 0;
  const critical   = counts?.critical   ?? 0;

  function levelColor(level: string): string {
    if (["L0", "L1", "L2"].includes(level)) return "#ef4444";
    if (["L3", "L4"].includes(level)) return "#f59e0b";
    if (level === "L5") return "#10b981";
    return "#64748b";
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`relative flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
          critical > 0
            ? "text-red-300 bg-red-900/20 border border-red-500/30 hover:bg-red-900/30"
            : unresolved > 0
            ? "text-amber-300 bg-amber-900/20 border border-amber-500/30 hover:bg-amber-900/30"
            : "text-slate-400 bg-slate-800/50 border border-slate-700/50 hover:bg-slate-700/50"
        }`}
        title={`${unresolved} alerta${unresolved !== 1 ? "s" : ""} não resolvido${unresolved !== 1 ? "s" : ""}`}
      >
        {/* Bell icon */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unresolved > 0 && (
          <span
            className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] rounded-full text-[10px] font-bold flex items-center justify-center px-1"
            style={{
              background: critical > 0 ? "#ef4444" : "#f59e0b",
              color: "#fff",
            }}
          >
            {unresolved > 99 ? "99+" : unresolved}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 top-full mt-2 w-80 max-h-[480px] flex flex-col rounded-xl overflow-hidden z-50"
            style={{
              background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
              border: "1px solid rgba(59,130,246,0.2)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700/50 shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-white">Alertas</span>
                {unresolved > 0 && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full"
                    style={{ background: critical > 0 ? "rgba(239,68,68,0.2)" : "rgba(245,158,11,0.2)", color: critical > 0 ? "#ef4444" : "#f59e0b" }}>
                    {unresolved} pendente{unresolved !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
              {unresolved > 0 && (
                <button
                  onClick={handleResolveAll}
                  disabled={resolving === "all"}
                  className="text-[10px] text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {resolving === "all" ? "..." : "Resolver todos"}
                </button>
              )}
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {alerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth="1.5" className="mb-2">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                  <p className="text-xs text-slate-500">Sem alertas pendentes</p>
                  <p className="text-[10px] text-slate-600 mt-1">Kill rules e anomalias aparecem aqui</p>
                </div>
              ) : (
                alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-3 px-4 py-3 border-b border-slate-800/50 transition-opacity ${alert.resolved ? "opacity-40" : ""}`}
                  >
                    {/* Level badge */}
                    <span
                      className="shrink-0 mt-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded"
                      style={{ background: `${levelColor(alert.level)}20`, color: levelColor(alert.level) }}
                    >
                      {alert.level}
                    </span>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      {alert.creative_name && (
                        <p className="text-[11px] font-semibold text-slate-200 truncate">{alert.creative_name}</p>
                      )}
                      <p className="text-[10px] text-slate-400 leading-relaxed mt-0.5 break-words">
                        {alert.rule_name
                          ? <><span className="text-slate-300">{alert.rule_name}</span> — </>
                          : null}
                        {alert.cpl !== null && alert.cpl !== undefined
                          ? `CPL R$${Number(alert.cpl).toFixed(2)} / target R$${Number(alert.cpl_target).toFixed(0)}`
                          : alert.spend !== null && alert.spend !== undefined
                          ? `Spend R$${Number(alert.spend).toFixed(2)} sem leads`
                          : alert.message}
                      </p>
                      <p className="text-[9px] text-slate-600 mt-1">
                        {new Date(alert.created_at).toLocaleString("pt-BR", {
                          timeZone: "America/Sao_Paulo",
                          day: "2-digit", month: "2-digit",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </p>
                    </div>

                    {/* Resolve button */}
                    {!alert.resolved && (
                      <button
                        onClick={() => handleResolve(alert.id)}
                        disabled={resolving === alert.id}
                        className="shrink-0 text-slate-600 hover:text-slate-300 transition-colors disabled:opacity-50 mt-0.5"
                        title="Resolver alerta"
                      >
                        {resolving === alert.id ? (
                          <div className="w-3.5 h-3.5 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M20 6L9 17l-5-5" />
                          </svg>
                        )}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, workspace, workspaces, logout, switchWorkspace } = useAuthStore();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  if (!user) return null;

  const initials = user.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  async function handleSwitch(wsId: string) {
    if (wsId === workspace?.id) return;
    setSwitching(true);
    const ok = await switchWorkspace(wsId);
    setSwitching(false);
    if (ok) {
      setOpen(false);
      window.location.reload();
    }
  }

  async function handleLogout() {
    await logout();
    router.replace("/login");
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-700/50 transition-all"
      >
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white"
          style={{ background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)" }}
        >
          {initials}
        </div>
        <div className="text-left hidden sm:block">
          <p className="text-xs font-medium text-slate-200 leading-none">{user.name}</p>
          <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{workspace?.name}</p>
        </div>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-500">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-64 rounded-xl overflow-hidden z-50"
          style={{
            background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
            border: "1px solid rgba(59,130,246,0.2)",
            boxShadow: "0 0 40px rgba(0,0,0,0.6)",
          }}
        >
          {/* User info */}
          <div className="px-4 py-3 border-b border-slate-700/50">
            <p className="text-xs font-medium text-white">{user.name}</p>
            <p className="text-[10px] text-slate-500 mt-0.5">{user.email}</p>
          </div>

          {/* Workspaces */}
          {workspaces.length > 1 && (
            <div className="px-2 py-2 border-b border-slate-700/50">
              <p className="text-[9px] uppercase tracking-wider text-slate-500 px-2 mb-1">Workspaces</p>
              {workspaces.map((ws) => (
                <button
                  key={ws.id}
                  onClick={() => handleSwitch(ws.id)}
                  disabled={switching}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs transition-all ${
                    ws.id === workspace?.id
                      ? "bg-blue-500/10 text-blue-400"
                      : "text-slate-300 hover:bg-slate-700/50"
                  }`}
                >
                  <div
                    className="w-5 h-5 rounded flex items-center justify-center text-[8px] font-bold"
                    style={{
                      background: ws.id === workspace?.id ? "rgba(59,130,246,0.2)" : "rgba(100,116,139,0.2)",
                      color: ws.id === workspace?.id ? "#60a5fa" : "#94a3b8",
                    }}
                  >
                    {ws.name[0]?.toUpperCase()}
                  </div>
                  <span className="flex-1 text-left truncate">{ws.name}</span>
                  {ws.id === workspace?.id && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Logout */}
          <div className="px-2 py-2">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-500/10 transition-all"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Sair
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { nodes, fetchGraph, loading } = useGraphStore();
  const { fetchMe, initialized } = useAuthStore();

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

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

        <AlertBell />

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

        <div className="w-px h-6 bg-slate-700/50" />

        <UserMenu />
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
