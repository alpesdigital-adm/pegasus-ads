"use client";

import AppShell from "@/components/AppShell";

export default function DashboardPage() {
  return (
    <AppShell>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-[var(--text-secondary)] mt-1">
          Welcome to Pegasus Ads. Configure your ad accounts in Settings to get started.
        </p>
      </div>
    </AppShell>
  );
}
