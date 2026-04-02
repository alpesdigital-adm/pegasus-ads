"use client";

import { GraphCanvas } from "@/components/GraphCanvas";
import { Header } from "@/components/Header";

export default function Home() {
  return (
    <div className="flex flex-col h-screen" style={{ background: "#080c14" }}>
      <Header />
      <main className="flex-1 relative overflow-hidden">
        <GraphCanvas />
      </main>
    </div>
  );
}
