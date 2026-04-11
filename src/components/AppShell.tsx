"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/auth";
import Sidebar from "./Sidebar";
import gsap from "gsap";

export default function AppShell({ children, fullWidth }: { children: React.ReactNode; fullWidth?: boolean }) {
  const { initialized, user, fetchMe } = useAuthStore();
  const router = useRouter();
  const contentRef = useRef<HTMLDivElement>(null);
  const loaderRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!initialized) {
      fetchMe().then((ok) => {
        if (!ok) router.push("/login");
      });
    }
  }, [initialized, fetchMe, router]);

  // Animate content in when user is loaded
  useEffect(() => {
    if (initialized && user && contentRef.current) {
      gsap.fromTo(
        contentRef.current,
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }
      );
    }
  }, [initialized, user]);

  if (!initialized || !user) {
    return (
      <div ref={loaderRef} className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 rounded-lg bg-[var(--accent)] flex items-center justify-center animate-pulse">
            <svg width="20" height="20" viewBox="0 0 18 18" fill="none">
              <path d="M9 2L15 6V12L9 16L3 12V6L9 2Z" fill="white" fillOpacity="0.9" />
            </svg>
          </div>
          <div className="text-sm text-[var(--text-tertiary)]">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <Sidebar />
      <main
        ref={contentRef}
        className="lg:ml-[var(--sidebar-width)] min-h-screen"
        style={{ opacity: 0 }}
      >
        <div className={`${fullWidth ? "" : "max-w-6xl"} mx-auto px-6 py-8 max-lg:pt-16`}>
          {children}
        </div>
      </main>
    </div>
  );
}
