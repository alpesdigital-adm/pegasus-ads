"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import AppShell from "@/components/AppShell";
import gsap from "gsap";

interface MetaAccount {
  id: string;
  label: string;
  meta_account_id: string;
  auth_method: string;
  page_id?: string;
  pixel_id?: string;
  instagram_user_id?: string;
  is_default: boolean;
  created_at: string;
}

export default function SettingsPage() {
  const [accounts, setAccounts] = useState<MetaAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Form state
  const [label, setLabel] = useState("");
  const [metaAccountId, setMetaAccountId] = useState("");
  const [token, setToken] = useState("");
  const [pageId, setPageId] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [igUserId, setIgUserId] = useState("");
  const [showForm, setShowForm] = useState(false);

  const headerRef = useRef<HTMLDivElement>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const successRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/workspaces/meta-accounts");
      if (res.ok) {
        const data = await res.json();
        setAccounts(data.accounts);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  // Animate header on mount
  useEffect(() => {
    if (headerRef.current) {
      gsap.fromTo(headerRef.current, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" });
    }
  }, []);

  // Animate cards when loaded
  useEffect(() => {
    if (!loading && cardsRef.current) {
      const cards = cardsRef.current.querySelectorAll(".account-card");
      gsap.fromTo(cards, { opacity: 0, y: 20, scale: 0.97 }, {
        opacity: 1, y: 0, scale: 1, duration: 0.4, stagger: 0.08, ease: "power2.out",
      });
    }
  }, [loading, accounts]);

  // Animate form
  useEffect(() => {
    if (formRef.current) {
      if (showForm) {
        gsap.fromTo(formRef.current,
          { opacity: 0, height: 0, overflow: "hidden" },
          { opacity: 1, height: "auto", duration: 0.4, ease: "power2.out" }
        );
      } else {
        gsap.to(formRef.current, { opacity: 0, height: 0, duration: 0.3, ease: "power2.in" });
      }
    }
  }, [showForm]);

  // Flash success/error messages
  useEffect(() => {
    if (success && successRef.current) {
      gsap.fromTo(successRef.current, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3 });
      const timer = setTimeout(() => {
        if (successRef.current) gsap.to(successRef.current, { opacity: 0, y: -10, duration: 0.3 });
        setTimeout(() => setSuccess(null), 300);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [success]);

  useEffect(() => {
    if (error && errorRef.current) {
      gsap.fromTo(errorRef.current, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.3 });
    }
  }, [error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);

    try {
      const res = await fetch("/api/workspaces/meta-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          meta_account_id: metaAccountId,
          auth_method: "token",
          token,
          page_id: pageId || undefined,
          pixel_id: pixelId || undefined,
          instagram_user_id: igUserId || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Failed to add account");
        // Shake the form on error
        if (formRef.current) {
          gsap.fromTo(formRef.current, { x: -8 }, { x: 0, duration: 0.4, ease: "elastic.out(1, 0.3)" });
        }
        return;
      }

      // Success animation
      setSuccess("Meta account added successfully!");
      setShowForm(false);
      setLabel("");
      setMetaAccountId("");
      setToken("");
      setPageId("");
      setPixelId("");
      setIgUserId("");
      await fetchAccounts();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    const card = document.getElementById(`account-${id}`);
    if (card) {
      await gsap.to(card, { opacity: 0, x: 30, scale: 0.95, duration: 0.3, ease: "power2.in" }).then();
    }

    try {
      const res = await fetch(`/api/workspaces/meta-accounts?id=${id}`, { method: "DELETE" });
      if (res.ok) {
        setAccounts((prev) => prev.filter((a) => a.id !== id));
        setSuccess("Account removed.");
      }
    } catch {
      await fetchAccounts();
    }
  };

  return (
    <AppShell>
      <div className="max-w-2xl">
        {/* Header */}
        <div ref={headerRef}>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="text-[var(--text-secondary)] mt-1">
            Manage your Meta Ads accounts and integrations.
          </p>
        </div>

        {/* Success toast */}
        {success && (
          <div
            ref={successRef}
            className="mt-4 px-4 py-3 rounded-lg bg-[var(--success-bg)] border border-[rgba(34,197,94,0.2)] flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round">
              <path d="M4 8.5l3 3 5-6" />
            </svg>
            <span className="text-sm text-[var(--success)]">{success}</span>
          </div>
        )}

        {/* Error message */}
        {error && (
          <div
            ref={errorRef}
            className="mt-4 px-4 py-3 rounded-lg bg-[var(--error-bg)] border border-[rgba(239,68,68,0.2)] flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--error)" strokeWidth="2" strokeLinecap="round">
              <circle cx="8" cy="8" r="6" />
              <path d="M8 5v3M8 10.5v.5" />
            </svg>
            <span className="text-sm text-[var(--error)]">{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </div>
        )}

        {/* Section: Meta Ads Accounts */}
        <section className="mt-8">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-medium">Meta Ads Accounts</h2>
              <p className="text-sm text-[var(--text-tertiary)] mt-0.5">
                Connect your Facebook/Meta ad accounts to manage campaigns.
              </p>
            </div>
            <button
              onClick={() => { setShowForm(!showForm); setError(null); }}
              className="btn btn-primary text-sm"
            >
              {showForm ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 3l8 8M11 3l-8 8" />
                  </svg>
                  Cancel
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M7 2v10M2 7h10" />
                  </svg>
                  Add Account
                </>
              )}
            </button>
          </div>

          {/* Add Account Form */}
          <div ref={formRef} style={{ opacity: 0, height: 0, overflow: "hidden" }}>
            <form onSubmit={handleSubmit} className="p-5 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] mb-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
                    Account Label *
                  </label>
                  <input
                    type="text"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. My Business Account"
                    required
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
                    Ad Account ID *
                  </label>
                  <input
                    type="text"
                    value={metaAccountId}
                    onChange={(e) => setMetaAccountId(e.target.value)}
                    placeholder="act_1234567890"
                    required
                    className="w-full"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1.5">
                  Access Token *
                </label>
                <input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="EAAx..."
                  required
                  className="w-full font-mono text-xs"
                />
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Your Meta System User Token or long-lived token. Stored encrypted (AES-256-GCM).
                </p>
              </div>

              <details className="group">
                <summary className="text-sm text-[var(--text-tertiary)] cursor-pointer hover:text-[var(--text-secondary)] transition-colors select-none">
                  Advanced (optional)
                </summary>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1">Page ID</label>
                    <input
                      type="text"
                      value={pageId}
                      onChange={(e) => setPageId(e.target.value)}
                      placeholder="123456789"
                      className="w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1">Pixel ID</label>
                    <input
                      type="text"
                      value={pixelId}
                      onChange={(e) => setPixelId(e.target.value)}
                      placeholder="123456789"
                      className="w-full text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1">Instagram User ID</label>
                    <input
                      type="text"
                      value={igUserId}
                      onChange={(e) => setIgUserId(e.target.value)}
                      placeholder="123456789"
                      className="w-full text-sm"
                    />
                  </div>
                </div>
              </details>

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowForm(false)} className="btn btn-ghost text-sm">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn btn-primary text-sm">
                  {saving ? (
                    <>
                      <svg className="animate-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <circle cx="7" cy="7" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="30" strokeDashoffset="10" />
                      </svg>
                      Saving...
                    </>
                  ) : (
                    "Save Account"
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Accounts List */}
          <div ref={cardsRef} className="space-y-3">
            {loading ? (
              <div className="space-y-3">
                {[1, 2].map((i) => (
                  <div key={i} className="p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] animate-pulse">
                    <div className="h-4 bg-[var(--bg-hover)] rounded w-40 mb-2" />
                    <div className="h-3 bg-[var(--bg-hover)] rounded w-60" />
                  </div>
                ))}
              </div>
            ) : accounts.length === 0 && !showForm ? (
              <div className="p-8 rounded-xl border border-dashed border-[var(--border-default)] text-center">
                <svg className="mx-auto mb-3 text-[var(--text-muted)]" width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="4" y="8" width="32" height="24" rx="3" />
                  <path d="M4 16h32" />
                  <circle cx="12" cy="12" r="2" />
                </svg>
                <p className="text-sm text-[var(--text-tertiary)]">No Meta accounts connected yet.</p>
                <button
                  onClick={() => setShowForm(true)}
                  className="mt-3 btn btn-primary text-sm"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M7 2v10M2 7h10" />
                  </svg>
                  Add your first account
                </button>
              </div>
            ) : (
              accounts.map((account) => (
                <AccountCard
                  key={account.id}
                  account={account}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

function AccountCard({ account, onDelete }: { account: MetaAccount; onDelete: (id: string) => void }) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handleMouseEnter = () => {
    if (cardRef.current) {
      gsap.to(cardRef.current, {
        borderColor: "var(--border-hover)",
        boxShadow: "0 0 30px rgba(59, 130, 246, 0.05)",
        duration: 0.3,
      });
    }
  };

  const handleMouseLeave = () => {
    if (cardRef.current) {
      gsap.to(cardRef.current, {
        borderColor: "var(--border-default)",
        boxShadow: "none",
        duration: 0.3,
      });
    }
  };

  return (
    <div
      id={`account-${account.id}`}
      ref={cardRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className="account-card p-4 rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] transition-colors"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[#1877F2]/10 border border-[#1877F2]/20 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="#1877F2">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{account.label}</span>
              {account.is_default && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-glow)] text-[var(--accent)] border border-[rgba(59,130,246,0.15)] font-medium">
                  DEFAULT
                </span>
              )}
            </div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5 font-mono">
              {account.meta_account_id}
            </div>
          </div>
        </div>

        <button
          onClick={() => onDelete(account.id)}
          className="p-2 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--error-bg)] transition-all"
          title="Remove account"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M9 7v4M5 7v4M3 4l.5 8a1 1 0 001 1h5a1 1 0 001-1L11 4" />
          </svg>
        </button>
      </div>

      {/* Additional info */}
      {(account.page_id || account.pixel_id || account.instagram_user_id) && (
        <div className="mt-3 pt-3 border-t border-[var(--border-default)] flex flex-wrap gap-3">
          {account.page_id && (
            <span className="text-xs text-[var(--text-muted)]">
              Page: <span className="text-[var(--text-tertiary)] font-mono">{account.page_id}</span>
            </span>
          )}
          {account.pixel_id && (
            <span className="text-xs text-[var(--text-muted)]">
              Pixel: <span className="text-[var(--text-tertiary)] font-mono">{account.pixel_id}</span>
            </span>
          )}
          {account.instagram_user_id && (
            <span className="text-xs text-[var(--text-muted)]">
              IG: <span className="text-[var(--text-tertiary)] font-mono">{account.instagram_user_id}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
