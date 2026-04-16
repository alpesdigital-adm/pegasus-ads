"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/store/auth";
import gsap from "gsap";

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Dashboard",
    href: "/",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="7" height="8" rx="1.5" />
        <rect x="11" y="2" width="7" height="5" rx="1.5" />
        <rect x="2" y="12" width="7" height="5" rx="1.5" />
        <rect x="11" y="9" width="7" height="8" rx="1.5" />
      </svg>
    ),
  },
  {
    label: "Projects",
    href: "/projects",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4l3-2h4l2 2h7v12H2V4z" />
      </svg>
    ),
  },
  {
    label: "Campaigns",
    href: "/campaigns",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 5h14M3 10h14M3 15h8" />
      </svg>
    ),
  },
  {
    label: "Creatives",
    href: "/creatives",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="16" height="12" rx="2" />
        <circle cx="7" cy="8" r="2" />
        <path d="M18 14l-4-4-6 6" />
      </svg>
    ),
  },
  {
    label: "Insights",
    href: "/insights",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 17V10M8 17V6M13 17V8M18 17V3" />
      </svg>
    ),
  },
  {
    label: "CRM Import",
    href: "/crm/import",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2v12M6 10l4 4 4-4" />
        <path d="M3 15v2h14v-2" />
      </svg>
    ),
  },
];

const BOTTOM_ITEMS: NavItem[] = [
  {
    label: "Settings",
    href: "/settings",
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="3" />
        <path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4" />
      </svg>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, workspace, workspaces, switchWorkspace, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [showCreateWs, setShowCreateWs] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const navItemsRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLButtonElement>(null);
  const wsDropdownRef = useRef<HTMLDivElement>(null);

  // Animate sidebar items on mount
  useEffect(() => {
    if (!navItemsRef.current || !logoRef.current) return;

    const items = navItemsRef.current.querySelectorAll(".nav-item");
    gsap.set(items, { opacity: 0, x: -20 });
    gsap.set(logoRef.current, { opacity: 0, y: -10 });

    gsap.to(logoRef.current, {
      opacity: 1,
      y: 0,
      duration: 0.5,
      ease: "power2.out",
    });

    gsap.to(items, {
      opacity: 1,
      x: 0,
      duration: 0.4,
      stagger: 0.06,
      ease: "power2.out",
      delay: 0.2,
    });
  }, []);

  // Mobile overlay animation (only on small screens)
  useEffect(() => {
    if (!overlayRef.current || !sidebarRef.current) return;
    const isDesktop = window.matchMedia("(min-width: 1024px)").matches;
    if (isDesktop) return;

    if (mobileOpen) {
      gsap.to(overlayRef.current, { opacity: 1, display: "block", duration: 0.3 });
      gsap.to(sidebarRef.current, { x: 0, duration: 0.3, ease: "power2.out" });
    } else {
      gsap.to(overlayRef.current, { opacity: 0, duration: 0.3, onComplete: () => {
        gsap.set(overlayRef.current!, { display: "none" });
      }});
      gsap.to(sidebarRef.current, { x: "-100%", duration: 0.3, ease: "power2.in" });
    }
  }, [mobileOpen]);

  // Close workspace dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target as Node)) {
        setWsDropdownOpen(false);
      }
    }
    if (wsDropdownOpen) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [wsDropdownOpen]);

  const handleNav = (href: string) => {
    router.push(href);
    setMobileOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    router.push("/login");
  };

  const handleSwitchWorkspace = async (wsId: string) => {
    if (wsId === workspace?.id) {
      setWsDropdownOpen(false);
      return;
    }
    setSwitching(true);
    const ok = await switchWorkspace(wsId);
    setSwitching(false);
    if (ok) {
      setWsDropdownOpen(false);
      window.location.reload();
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const slug = newWsName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 30) + "-" + Date.now().toString(36);
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newWsName.trim(), slug }),
      });
      if (!res.ok) {
        const data = await res.json();
        setCreateError(data.message || "Erro ao criar workspace");
        setCreating(false);
        return;
      }
      const data = await res.json();
      // Switch to new workspace
      await switchWorkspace(data.id);
      setWsDropdownOpen(false);
      setShowCreateWs(false);
      setNewWsName("");
      window.location.reload();
    } catch {
      setCreateError("Erro de conexao");
    }
    setCreating(false);
  };

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  return (
    <>
      {/* Mobile burger button */}
      <button
        onClick={() => setMobileOpen(true)}
        className="lg:hidden fixed top-4 left-4 z-50 p-2 rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors"
        aria-label="Open menu"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>

      {/* Mobile overlay */}
      <div
        ref={overlayRef}
        onClick={() => setMobileOpen(false)}
        className="lg:hidden fixed inset-0 bg-black/60 z-40 hidden opacity-0"
      />

      {/* Sidebar */}
      <aside
        ref={sidebarRef}
        className="fixed left-0 top-0 bottom-0 w-[var(--sidebar-width)] bg-[var(--bg-secondary)] border-r border-[var(--border-default)] z-50 flex flex-col
                   max-lg:-translate-x-full lg:translate-x-0 sidebar-transition"
      >
        {/* Workspace Switcher */}
        <div ref={wsDropdownRef} className="relative">
          <button
            ref={logoRef}
            onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
            className="w-full px-4 py-4 flex items-center gap-3 border-b border-[var(--border-default)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center text-xs font-bold text-white shrink-0">
              {workspace?.name?.[0]?.toUpperCase() || "W"}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <div className="text-sm font-semibold text-[var(--text-primary)] truncate">
                {workspace?.name || "Workspace"}
              </div>
              <div className="text-[10px] text-[var(--text-tertiary)]">
                Pegasus Ads
              </div>
            </div>
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`text-[var(--text-muted)] shrink-0 transition-transform ${wsDropdownOpen ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6" />
            </svg>

            {/* Mobile close */}
            <span
              onClick={(e) => { e.stopPropagation(); setMobileOpen(false); }}
              className="lg:hidden p-1 rounded-md hover:bg-[var(--bg-hover)] transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </span>
          </button>

          {/* Workspace dropdown */}
          {wsDropdownOpen && (
            <div
              className="absolute left-3 right-3 top-full mt-1 rounded-xl overflow-hidden z-50"
              style={{
                background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
                border: "1px solid rgba(59,130,246,0.2)",
                boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
              }}
            >
              <div className="px-3 py-2">
                <p className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">Workspaces</p>
                {workspaces.map((ws) => (
                  <button
                    key={ws.id}
                    onClick={() => handleSwitchWorkspace(ws.id)}
                    disabled={switching}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs transition-all ${
                      ws.id === workspace?.id
                        ? "bg-blue-500/10 text-blue-400"
                        : "text-slate-300 hover:bg-slate-700/50"
                    }`}
                  >
                    <div
                      className="w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{
                        background: ws.id === workspace?.id ? "rgba(59,130,246,0.2)" : "rgba(100,116,139,0.2)",
                        color: ws.id === workspace?.id ? "#60a5fa" : "#94a3b8",
                      }}
                    >
                      {ws.name[0]?.toUpperCase()}
                    </div>
                    <span className="flex-1 text-left truncate">{ws.name}</span>
                    {ws.id === workspace?.id && (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>

              {/* Create new workspace */}
              <div className="px-3 py-2 border-t border-slate-700/50">
                {!showCreateWs ? (
                  <button
                    onClick={() => setShowCreateWs(true)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 transition-all"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                    Criar workspace
                  </button>
                ) : (
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={newWsName}
                      onChange={(e) => setNewWsName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleCreateWorkspace()}
                      placeholder="Nome do workspace"
                      autoFocus
                      className="w-full px-2.5 py-1.5 rounded-lg text-xs bg-slate-800/60 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/50"
                    />
                    {createError && (
                      <p className="text-[10px] text-red-400 px-1">{createError}</p>
                    )}
                    <div className="flex gap-1.5">
                      <button
                        onClick={handleCreateWorkspace}
                        disabled={creating || !newWsName.trim()}
                        className="flex-1 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50 transition-all"
                      >
                        {creating ? "Criando..." : "Criar"}
                      </button>
                      <button
                        onClick={() => { setShowCreateWs(false); setNewWsName(""); setCreateError(null); }}
                        className="px-2.5 py-1.5 rounded-lg text-xs text-slate-400 hover:bg-slate-700/50 transition-all"
                      >
                        Cancelar
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav ref={navItemsRef} className="flex-1 py-3 px-3 flex flex-col">
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <NavButton
                key={item.href}
                item={item}
                active={isActive(item.href)}
                onClick={() => handleNav(item.href)}
              />
            ))}
          </div>

          <div className="flex-1" />

          {/* Bottom items */}
          <div className="space-y-1 border-t border-[var(--border-default)] pt-3 mt-3">
            {BOTTOM_ITEMS.map((item) => (
              <NavButton
                key={item.href}
                item={item}
                active={isActive(item.href)}
                onClick={() => handleNav(item.href)}
              />
            ))}
          </div>

          {/* User card */}
          <div className="nav-item mt-3 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)]">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center text-xs font-bold text-white">
                {user?.name?.charAt(0).toUpperCase() || "?"}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{user?.name}</div>
                <div className="text-[11px] text-[var(--text-tertiary)] truncate">{user?.email}</div>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="mt-2.5 w-full text-xs text-[var(--text-muted)] hover:text-[var(--error)] py-1.5 rounded-md hover:bg-[var(--error-bg)] transition-all"
            >
              Sair
            </button>
          </div>
        </nav>
      </aside>
    </>
  );
}

function NavButton({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleMouseEnter = () => {
    if (!active && btnRef.current) {
      gsap.to(btnRef.current, { x: 4, duration: 0.2, ease: "power2.out" });
    }
  };

  const handleMouseLeave = () => {
    if (!active && btnRef.current) {
      gsap.to(btnRef.current, { x: 0, duration: 0.2, ease: "power2.out" });
    }
  };

  return (
    <button
      ref={btnRef}
      onClick={onClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`nav-item w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
        active
          ? "bg-[var(--accent-glow)] text-[var(--accent)] font-medium border border-[rgba(59,130,246,0.15)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
      }`}
    >
      <span className={active ? "text-[var(--accent)]" : ""}>{item.icon}</span>
      {item.label}
    </button>
  );
}
