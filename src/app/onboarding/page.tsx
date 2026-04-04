"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/store/auth";

type Step = "meta" | "drive" | "campaign" | "done";

export default function OnboardingPage() {
  const router = useRouter();
  const { user, workspace, fetchMe, initialized } = useAuthStore();
  const [step, setStep] = useState<Step>("meta");

  useEffect(() => {
    if (!initialized) fetchMe();
  }, [initialized, fetchMe]);

  useEffect(() => {
    if (initialized && !user) router.replace("/login");
  }, [initialized, user, router]);

  if (!user || !workspace) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-5 h-5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      <div
        className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{
          background: "linear-gradient(180deg, #1e293b 0%, #0f172a 100%)",
          border: "1px solid rgba(59,130,246,0.2)",
          boxShadow: "0 0 40px rgba(0,0,0,0.6), 0 0 80px rgba(59,130,246,0.1)",
        }}
      >
        {/* Progress */}
        <div className="px-8 pt-6 pb-4">
          <div className="flex items-center justify-center gap-2 mb-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
            <h1 className="text-lg font-bold text-white">Configurar {workspace.name}</h1>
          </div>
          <StepIndicator current={step} />
        </div>

        {/* Content */}
        <div className="px-8 pb-8">
          {step === "meta" && <MetaStep onNext={() => setStep("drive")} onSkip={() => setStep("drive")} />}
          {step === "drive" && <DriveStep onNext={() => setStep("campaign")} onSkip={() => setStep("campaign")} onBack={() => setStep("meta")} />}
          {step === "campaign" && <CampaignStep onNext={() => setStep("done")} onSkip={() => setStep("done")} onBack={() => setStep("drive")} />}
          {step === "done" && <DoneStep onFinish={() => router.replace("/")} />}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: "meta", label: "Meta Ads" },
    { key: "drive", label: "Google Drive" },
    { key: "campaign", label: "Campanha" },
    { key: "done", label: "Pronto" },
  ];
  const currentIdx = steps.findIndex((s) => s.key === current);

  return (
    <div className="flex items-center gap-1">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center flex-1">
          <div className="flex flex-col items-center flex-1">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold transition-all ${
                i <= currentIdx
                  ? "bg-blue-600 text-white"
                  : "bg-slate-800 text-slate-500 border border-slate-700"
              }`}
            >
              {i < currentIdx ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              ) : (
                i + 1
              )}
            </div>
            <span className={`text-[9px] mt-1 ${i <= currentIdx ? "text-slate-300" : "text-slate-600"}`}>
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div className={`h-px flex-1 mx-1 mb-4 ${i < currentIdx ? "bg-blue-600" : "bg-slate-700"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function MetaStep({ onNext, onSkip }: { onNext: () => void; onSkip: () => void }) {
  const [method, setMethod] = useState<"token" | "oauth">("token");
  const [label, setLabel] = useState("");
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [pageId, setPageId] = useState("");
  const [pixelId, setPixelId] = useState("");
  const [instagramId, setInstagramId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    if (!label || !accountId) {
      setError("Label e Account ID sao obrigatorios");
      return;
    }
    if (method === "token" && !token) {
      setError("Token e obrigatorio");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/workspaces/meta-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          meta_account_id: accountId.startsWith("act_") ? accountId : `act_${accountId}`,
          auth_method: method,
          token: method === "token" ? token : undefined,
          page_id: pageId || undefined,
          pixel_id: pixelId || undefined,
          instagram_user_id: instagramId || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Falha ao conectar");
        setSaving(false);
        return;
      }
      onNext();
    } catch {
      setError("Erro de rede");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white mb-1">Conectar conta Meta Ads</h2>
        <p className="text-xs text-slate-400">Vincule sua conta de anuncios para publicar e coletar metricas.</p>
      </div>

      {/* Method toggle */}
      <div className="flex gap-2">
        {(["token", "oauth"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMethod(m)}
            className={`flex-1 py-2 rounded-lg text-xs font-medium transition-all ${
              method === m
                ? "bg-blue-600/20 text-blue-400 border border-blue-500/30"
                : "bg-slate-800/50 text-slate-400 border border-slate-700/50 hover:bg-slate-700/50"
            }`}
          >
            {m === "token" ? "Token manual" : "OAuth (em breve)"}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <Input label="Label" value={label} onChange={setLabel} placeholder="Ex: Alpes Digital" />
        <Input label="Account ID" value={accountId} onChange={setAccountId} placeholder="act_1234567890" />
        {method === "token" && (
          <Input label="Access Token" value={token} onChange={setToken} placeholder="EAAx..." type="password" />
        )}
        <Input label="Page ID (opcional)" value={pageId} onChange={setPageId} placeholder="123456789" />
        <Input label="Pixel ID (opcional)" value={pixelId} onChange={setPixelId} placeholder="123456789" />
        <Input label="Instagram User ID (opcional)" value={instagramId} onChange={setInstagramId} placeholder="17841..." />
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={onSkip} className="flex-1 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-300 transition-all">
          Pular
        </button>
        <button
          onClick={handleSave}
          disabled={saving || method === "oauth"}
          className="flex-1 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {saving ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : "Conectar"}
        </button>
      </div>
    </div>
  );
}

function DriveStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const [status, setStatus] = useState<{ connected: boolean; email?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/drive/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ connected: false }))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white mb-1">Conectar Google Drive</h2>
        <p className="text-xs text-slate-400">Sincronize criativos automaticamente com uma pasta do Drive.</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-8">
          <div className="w-5 h-5 border-2 border-slate-600 border-t-slate-300 rounded-full animate-spin" />
        </div>
      ) : status?.connected ? (
        <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-4 py-3">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-xs text-green-400 font-medium">Conectado</span>
          </div>
          {status.email && <p className="text-[10px] text-slate-400 mt-1">{status.email}</p>}
        </div>
      ) : (
        <button
          onClick={() => { window.location.href = "/api/auth/google"; }}
          className="w-full py-3 rounded-lg text-sm font-medium bg-slate-800/80 border border-slate-700/50 text-white hover:bg-slate-700/50 transition-all flex items-center justify-center gap-2"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          </svg>
          Conectar Google Drive
        </button>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={onBack} className="flex-1 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-300 transition-all">
          Voltar
        </button>
        <button
          onClick={status?.connected ? onNext : onSkip}
          className="flex-1 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all"
        >
          {status?.connected ? "Proximo" : "Pular"}
        </button>
      </div>
    </div>
  );
}

function CampaignStep({ onNext, onSkip, onBack }: { onNext: () => void; onSkip: () => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const [metaCampaignId, setMetaCampaignId] = useState("");
  const [metaAccountId, setMetaAccountId] = useState("");
  const [cplTarget, setCplTarget] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    if (!name || !metaCampaignId || !metaAccountId) {
      setError("Nome, Campaign ID e Account ID sao obrigatorios");
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          meta_campaign_id: metaCampaignId,
          meta_account_id: metaAccountId.startsWith("act_") ? metaAccountId : `act_${metaAccountId}`,
          cpl_target: cplTarget ? parseFloat(cplTarget) : null,
          status: "active",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || data.error || "Falha ao criar campanha");
        setSaving(false);
        return;
      }
      onNext();
    } catch {
      setError("Erro de rede");
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-white mb-1">Configurar primeira campanha</h2>
        <p className="text-xs text-slate-400">Cadastre a campanha Meta que sera gerenciada pelo Pegasus.</p>
      </div>

      <div className="space-y-3">
        <Input label="Nome da campanha" value={name} onChange={setName} placeholder="Ex: T7 - RAT Academy" />
        <Input label="Meta Campaign ID" value={metaCampaignId} onChange={setMetaCampaignId} placeholder="120242407847250521" />
        <Input label="Meta Account ID" value={metaAccountId} onChange={setMetaAccountId} placeholder="act_3601611403432716" />
        <Input label="CPL Target (R$)" value={cplTarget} onChange={setCplTarget} placeholder="25.00" type="number" />
      </div>

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex gap-2 pt-2">
        <button onClick={onBack} className="py-2 px-4 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-300 transition-all">
          Voltar
        </button>
        <button onClick={onSkip} className="flex-1 py-2 rounded-lg text-xs font-medium text-slate-400 hover:text-slate-300 transition-all">
          Pular
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all disabled:opacity-50 flex items-center justify-center gap-1"
        >
          {saving ? <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : "Criar campanha"}
        </button>
      </div>
    </div>
  );
}

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="text-center space-y-4 py-4">
      <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </div>
      <div>
        <h2 className="text-lg font-bold text-white">Tudo pronto!</h2>
        <p className="text-xs text-slate-400 mt-1">Seu workspace esta configurado. Agora voce pode comecar a gerenciar seus criativos.</p>
      </div>
      <button
        onClick={onFinish}
        className="px-8 py-2.5 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all"
      >
        Ir para o dashboard
      </button>
    </div>
  );
}

function Input({ label, value, onChange, placeholder, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded-lg text-sm bg-slate-800/60 border border-slate-700/50 text-white placeholder-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/20 transition-all"
      />
    </div>
  );
}
