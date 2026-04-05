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
  const { user, workspace, logout } = useAuthStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const navItemsRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLDivElement>(null);

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

  // Mobile overlay animation
  useEffect(() => {
    if (!overlayRef.current || !sidebarRef.current) return;

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

  const handleNav = (href: string) => {
    router.push(href);
    setMobileOpen(false);
  };

  const handleLogout = async () => {
    await logout();
    router.push("/login");
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
        {/* Logo */}
        <div ref={logoRef} className="px-5 py-5 flex items-center gap-3 border-b border-[var(--border-default)]">
          <div className="w-8 h-8 rounded-lg bg-[var(--accent)] flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2L15 6V12L9 16L3 12V6L9 2Z" fill="white" fillOpacity="0.9" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">Pegasus Ads</div>
            <div className="text-[11px] text-[var(--text-tertiary)] truncate max-w-[160px]">
              {workspace?.name || "Loading..."}
            </div>
          </div>

          {/* Mobile close */}
          <button
            onClick={() => setMobileOpen(false)}
            className="lg:hidden ml-auto p-1.5 rounded-md hover:bg-[var(--bg-hover)] transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
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
              Sign out
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
