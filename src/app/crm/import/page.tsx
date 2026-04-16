"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import AppShell from "@/components/AppShell";
import { useAuthStore } from "@/store/auth";

// ── Types ──
interface MappingConfig {
  id?: string;
  name: string;
  description?: string;
  column_mappings: Record<string, string>;
  target_fields?: string[];
  import_count?: number;
  last_used_at?: string;
}

interface ImportResult {
  success: boolean;
  imported: number;
  skipped: number;
  qualified: number;
  total_rows: number;
  errors: string[];
  ad_id_resolved?: number;
  campaign_id_resolved?: number;
}

type Step = "upload" | "mapping" | "preview" | "importing" | "result";

// ── System fields (what /api/crm/import expects as CSV headers) ──
const SYSTEM_FIELDS: { key: string; label: string; required: boolean; group: string }[] = [
  { key: "ID", label: "ID (CRM)", required: true, group: "Identificação" },
  { key: "Nome", label: "Nome", required: false, group: "Identificação" },
  { key: "Sobrenome", label: "Sobrenome", required: false, group: "Identificação" },
  { key: "Nome Completo", label: "Nome Completo", required: true, group: "Identificação" },
  { key: "Email", label: "Email", required: true, group: "Identificação" },
  { key: "Telefone", label: "Telefone", required: false, group: "Identificação" },
  { key: "País", label: "País", required: false, group: "Identificação" },
  { key: "Médico", label: "Médico", required: false, group: "Qualificação" },
  { key: "CRM", label: "CRM", required: false, group: "Qualificação" },
  { key: "Profissão Confirmada", label: "Profissão Confirmada", required: false, group: "Qualificação" },
  { key: "Bloqueado", label: "Bloqueado", required: false, group: "Status" },
  { key: "Mudou Status", label: "Mudou Status", required: false, group: "Status" },
  { key: "Clicou WhatsApp", label: "Clicou WhatsApp", required: false, group: "Status" },
  { key: "Telefone Válido", label: "Telefone Válido", required: false, group: "Status" },
  { key: "Status Evento", label: "Status Evento", required: false, group: "Status" },
  { key: "Status Grupo", label: "Status Grupo", required: false, group: "Grupo" },
  { key: "Link Grupo", label: "Link Grupo", required: false, group: "Grupo" },
  { key: "Data Link Enviado", label: "Data Link Enviado", required: false, group: "Grupo" },
  { key: "Data Solicitou Entrada", label: "Data Solicitou Entrada", required: false, group: "Grupo" },
  { key: "Data Entrou Grupo", label: "Data Entrou Grupo", required: false, group: "Grupo" },
  { key: "Data Saiu Grupo", label: "Data Saiu Grupo", required: false, group: "Grupo" },
  { key: "Inscrições", label: "Inscrições", required: false, group: "Atribuição" },
  { key: "Página", label: "Página", required: false, group: "Atribuição" },
  { key: "Hook", label: "Hook", required: false, group: "Atribuição" },
  { key: "UTM Source", label: "UTM Source", required: false, group: "Atribuição" },
  { key: "UTM Medium", label: "UTM Medium", required: false, group: "Atribuição" },
  { key: "UTM Campaign", label: "UTM Campaign", required: false, group: "Atribuição" },
  { key: "UTM Content", label: "UTM Content", required: false, group: "Atribuição" },
  { key: "UTM Term", label: "UTM Term", required: false, group: "Atribuição" },
  { key: "FBCLID", label: "FBCLID", required: false, group: "Atribuição" },
  { key: "GCLID", label: "GCLID", required: false, group: "Atribuição" },
  { key: "Primeira Inscrição", label: "Primeira Inscrição", required: false, group: "Datas" },
  { key: "Última Inscrição", label: "Última Inscrição", required: false, group: "Datas" },
  { key: "Criado Em", label: "Criado Em", required: false, group: "Datas" },
  { key: "Origem Lead", label: "Origem Lead", required: false, group: "Origem" },
  { key: "Tipo Origem", label: "Tipo Origem", required: false, group: "Origem" },
  { key: "Cadastro", label: "Cadastro", required: false, group: "Origem" },
  { key: "Origem do Lead", label: "Origem do Lead", required: false, group: "Origem" },
];

const REQUIRED_FIELDS = SYSTEM_FIELDS.filter((f) => f.required).map((f) => f.key);

// ── CSV Parser ──
function parseCsvLine(line: string): string[] {
  const r: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { r.push(cur.trim()); cur = ""; }
      else cur += c;
    }
  }
  r.push(cur.trim());
  return r;
}

function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

function autoDetectMapping(csvHeaders: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const sysKeys = SYSTEM_FIELDS.map((f) => f.key);
  csvHeaders.forEach((col) => {
    const exact = sysKeys.find((sk) => sk.toLowerCase() === col.toLowerCase());
    if (exact) { mapping[col] = exact; return; }
    const norm = col.toLowerCase().replace(/[_\-\s]+/g, "");
    const partial = sysKeys.find((sk) => sk.toLowerCase().replace(/[_\-\s]+/g, "") === norm);
    if (partial) mapping[col] = partial;
  });
  return mapping;
}

function buildTransformedCsv(rows: Record<string, string>[], mapping: Record<string, string>): string {
  const rev: Record<string, string> = {};
  Object.entries(mapping).forEach(([csv, sys]) => { if (sys && sys !== "__skip__") rev[sys] = csv; });
  const hdrs = Object.keys(rev);
  const lines: string[] = [hdrs.join(",")];
  rows.forEach((row) => {
    const vals = hdrs.map((sys) => {
      const v = row[rev[sys]] || "";
      return v.includes(",") || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v;
    });
    lines.push(vals.join(","));
  });
  return lines.join("\n");
}

// ── API helper ──
async function api(path: string, options: RequestInit = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: "include",
    headers: { ...(options.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Step indicator ──
function StepBar({ current, steps }: { current: Step; steps: { key: Step; label: string }[] }) {
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <div className="flex items-center gap-2 mb-8">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div className={`flex items-center justify-center w-7 h-7 rounded-full text-xs font-medium transition-colors ${
            i < idx ? "bg-green-500 text-white" : i === idx ? "bg-[var(--accent)] text-white" : "bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
          }`}>
            {i < idx ? "✓" : i + 1}
          </div>
          <span className={`text-sm ${i === idx ? "text-[var(--accent)] font-medium" : "text-[var(--text-tertiary)]"}`}>{s.label}</span>
          {i < steps.length - 1 && <div className={`w-6 h-px ${i < idx ? "bg-green-500" : "bg-[var(--border-default)]"}`} />}
        </div>
      ))}
    </div>
  );
}

// ── Main Page ──
export default function CRMImportPage() {
  const [step, setStep] = useState<Step>("upload");
  const [error, setError] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [fileName, setFileName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [savedMappings, setSavedMappings] = useState<MappingConfig[]>([]);
  const [selectedMappingId, setSelectedMappingId] = useState<string | null>(null);
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [currentMapping, setCurrentMapping] = useState<Record<string, string>>({});
  const [mappingName, setMappingName] = useState("");
  const [mappingDesc, setMappingDesc] = useState("");
  const [projectKey, setProjectKey] = useState("rat");
  const [importProgress, setImportProgress] = useState(0);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [savingMapping, setSavingMapping] = useState(false);

  const groups = useMemo(() => Array.from(new Set(SYSTEM_FIELDS.map((f) => f.group))), []);

  const filteredFields = useMemo(() => {
    if (!activeGroup) return SYSTEM_FIELDS;
    return SYSTEM_FIELDS.filter((f) => f.group === activeGroup);
  }, [activeGroup]);

  // Load saved mappings
  const loadMappings = useCallback(async () => {
    try {
      setLoadingMappings(true);
      const data = await api("/api/crm/import-mappings");
      setSavedMappings(data.mappings || []);
    } catch { /* silent */ } finally {
      setLoadingMappings(false);
    }
  }, []);

  // File upload
  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const { headers, rows } = parseCsv(evt.target?.result as string);
        if (!headers.length) { setError("CSV vazio ou inválido."); return; }
        setCsvHeaders(headers);
        setCsvRows(rows);
        setCurrentMapping(autoDetectMapping(headers));
        loadMappings();
        setStep("mapping");
      } catch (err: any) { setError(`Erro: ${err.message}`); }
    };
    reader.readAsText(file, "UTF-8");
  }, [loadMappings]);

  // Apply saved mapping
  const applyMapping = useCallback((m: MappingConfig) => {
    setSelectedMappingId(m.id || null);
    setMappingName(m.name);
    setMappingDesc(m.description || "");
    const nm: Record<string, string> = {};
    Object.entries(m.column_mappings).forEach(([csv, sys]) => { if (csvHeaders.includes(csv)) nm[csv] = sys; });
    const auto = autoDetectMapping(csvHeaders);
    csvHeaders.forEach((h) => { if (!nm[h] && auto[h]) nm[h] = auto[h]; });
    setCurrentMapping(nm);
  }, [csvHeaders]);

  // Save mapping
  const saveMapping = useCallback(async () => {
    if (!mappingName.trim()) { setError("Dê um nome para o mapeamento."); return; }
    try {
      setSavingMapping(true);
      const data = await api("/api/crm/import-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: mappingName.trim(),
          description: mappingDesc.trim() || null,
          column_mappings: currentMapping,
          target_fields: Object.values(currentMapping).filter((v) => v && v !== "__skip__"),
        }),
      });
      setSelectedMappingId(data.mapping.id);
      await loadMappings();
      setError(null);
    } catch (err: any) { setError(`Erro ao salvar: ${err.message}`); }
    finally { setSavingMapping(false); }
  }, [mappingName, mappingDesc, currentMapping, loadMappings]);

  // Delete mapping
  const deleteMapping = useCallback(async (id: string) => {
    if (!confirm("Excluir este mapeamento?")) return;
    try {
      await api(`/api/crm/import-mappings?id=${id}`, { method: "DELETE" });
      await loadMappings();
      if (selectedMappingId === id) { setSelectedMappingId(null); setMappingName(""); setMappingDesc(""); }
    } catch (err: any) { setError(`Erro: ${err.message}`); }
  }, [selectedMappingId, loadMappings]);

  // Validation
  const validation = useMemo(() => {
    const mapped = new Set(Object.values(currentMapping).filter((v) => v && v !== "__skip__"));
    const missing = REQUIRED_FIELDS.filter((f) => !mapped.has(f));
    const counts: Record<string, number> = {};
    Object.values(currentMapping).forEach((v) => { if (v && v !== "__skip__") counts[v] = (counts[v] || 0) + 1; });
    const dupes = Object.entries(counts).filter(([, c]) => c > 1).map(([k]) => k);
    return { isValid: !missing.length && !dupes.length, missing, dupes, mappedCount: mapped.size };
  }, [currentMapping, csvHeaders]);

  // Preview
  const previewCols = useMemo(() => Object.values(currentMapping).filter((v) => v && v !== "__skip__"), [currentMapping]);
  const previewData = useMemo(() => {
    return csvRows.slice(0, 10).map((row) => {
      const m: Record<string, string> = {};
      Object.entries(currentMapping).forEach(([csv, sys]) => { if (sys && sys !== "__skip__") m[sys] = row[csv] || ""; });
      return m;
    });
  }, [csvRows, currentMapping]);

  // Import
  const executeImport = useCallback(async () => {
    setStep("importing");
    setImportProgress(0);
    setError(null);
    try {
      setImportProgress(15);
      const csv = buildTransformedCsv(csvRows, currentMapping);
      setImportProgress(30);
      const blob = new Blob([csv], { type: "text/csv" });
      const file = new File([blob], fileName || "import.csv", { type: "text/csv" });
      const fd = new FormData();
      fd.append("file", file);
      fd.append("project_key", projectKey);
      fd.append("source_file", fileName || "import.csv");
      setImportProgress(40);
      const res = await fetch("/api/crm/import", { method: "POST", body: fd, credentials: "include" });
      setImportProgress(80);
      if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error); }
      const result = await res.json();
      setImportProgress(90);
      if (selectedMappingId) {
        await api("/api/crm/import-mappings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: selectedMappingId }),
        }).catch(() => {});
      }
      setImportProgress(100);
      setImportResult(result);
      setStep("result");
    } catch (err: any) { setError(`Erro: ${err.message}`); setStep("preview"); }
  }, [csvRows, currentMapping, fileName, projectKey, selectedMappingId]);

  // Reset
  const resetAll = useCallback(() => {
    setStep("upload"); setCsvHeaders([]); setCsvRows([]); setFileName("");
    setCurrentMapping({}); setMappingName(""); setMappingDesc("");
    setSelectedMappingId(null); setImportResult(null); setImportProgress(0); setError(null);
    if (fileRef.current) fileRef.current.value = "";
  }, []);

  const STEPS: { key: Step; label: string }[] = [
    { key: "upload", label: "Upload" }, { key: "mapping", label: "Mapeamento" },
    { key: "preview", label: "Preview" }, { key: "importing", label: "Importando" },
    { key: "result", label: "Resultado" },
  ];

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">Importação de Leads CRM</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">Upload, mapeamento e importação com configurações reutilizáveis</p>
        </div>

        <StepBar current={step} steps={STEPS} />

        {/* Error */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 flex items-start gap-3">
            <span className="text-red-400">⚠</span>
            <div className="flex-1">
              <p className="text-sm text-red-300">{error}</p>
              <button onClick={() => setError(null)} className="text-xs text-red-400 hover:underline mt-1">Fechar</button>
            </div>
          </div>
        )}

        {/* UPLOAD */}
        {step === "upload" && (
          <div className="space-y-4">
            <div
              className="border-2 border-dashed border-[var(--border-default)] rounded-xl p-12 text-center hover:border-[var(--accent)] transition-colors cursor-pointer"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f && fileRef.current) { const dt = new DataTransfer(); dt.items.add(f); fileRef.current.files = dt.files; fileRef.current.dispatchEvent(new Event("change", { bubbles: true })); }
              }}
            >
              <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-[var(--bg-tertiary)] flex items-center justify-center">
                <svg className="w-6 h-6 text-[var(--text-tertiary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              </div>
              <p className="text-[var(--text-primary)] font-medium">Arraste o arquivo CSV aqui</p>
              <p className="text-sm text-[var(--text-tertiary)] mt-1">ou clique para selecionar</p>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="hidden" />
            </div>
            <div className="flex items-center gap-3">
              <label className="text-sm text-[var(--text-secondary)]">Projeto:</label>
              <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)}
                className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)]">
                <option value="rat">RAT Academy</option>
                <option value="alpes">Alpes Digital</option>
              </select>
            </div>
          </div>
        )}

        {/* MAPPING */}
        {step === "mapping" && (
          <div className="space-y-4">
            {/* File info */}
            <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-default)] p-4 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 bg-green-500/20 rounded-lg flex items-center justify-center"><span className="text-green-400 text-sm">CSV</span></div>
                <div>
                  <p className="text-sm font-medium text-[var(--text-primary)]">{fileName}</p>
                  <p className="text-xs text-[var(--text-tertiary)]">{csvRows.length.toLocaleString()} leads · {csvHeaders.length} colunas</p>
                </div>
              </div>
              <button onClick={resetAll} className="text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Trocar</button>
            </div>

            {/* Saved mappings */}
            <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-default)] p-4">
              <h3 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Configurações salvas</h3>
              {loadingMappings ? <p className="text-xs text-[var(--text-tertiary)]">Carregando...</p> :
               savedMappings.length === 0 ? <p className="text-xs text-[var(--text-tertiary)]">Nenhuma configuração salva. Auto-detect aplicado.</p> :
               <div className="flex flex-wrap gap-2">
                 {savedMappings.map((m) => (
                   <div key={m.id} className={`group flex items-center gap-1.5 border rounded-lg px-3 py-1.5 cursor-pointer transition-colors text-sm ${
                     selectedMappingId === m.id ? "bg-[var(--accent)]/20 border-[var(--accent)]/40 text-[var(--accent)]" : "border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                   }`}>
                     <button onClick={() => applyMapping(m)}>{m.name}</button>
                     {m.import_count ? <span className="text-xs opacity-50">({m.import_count}x)</span> : null}
                     <button onClick={() => deleteMapping(m.id!)} className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 text-xs ml-1">×</button>
                   </div>
                 ))}
               </div>
              }
            </div>

            {/* Save mapping */}
            <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-default)] p-4">
              <div className="flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-[var(--text-tertiary)] mb-1">Nome</label>
                  <input type="text" value={mappingName} onChange={(e) => setMappingName(e.target.value)}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)]"
                    placeholder="Ex: CRM RAT Padrão" />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-[var(--text-tertiary)] mb-1">Descrição</label>
                  <input type="text" value={mappingDesc} onChange={(e) => setMappingDesc(e.target.value)}
                    className="w-full bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)]"
                    placeholder="Opcional" />
                </div>
                <button onClick={saveMapping} disabled={!mappingName.trim() || savingMapping}
                  className="px-4 py-1.5 bg-[var(--accent)] text-white text-sm rounded-lg hover:opacity-90 disabled:opacity-40 whitespace-nowrap">
                  {savingMapping ? "Salvando..." : "Salvar"}
                </button>
              </div>
            </div>

            {/* Column mapping */}
            <div className="bg-[var(--bg-secondary)] rounded-xl border border-[var(--border-default)] overflow-hidden">
              <div className="p-4 border-b border-[var(--border-default)]">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">Mapeamento de colunas</h3>
                    <p className="text-xs text-[var(--text-tertiary)] mt-0.5">{validation.mappedCount} de {csvHeaders.length} mapeadas</p>
                  </div>
                  <div className="flex items-center gap-3">
                    {validation.missing.length > 0 && <span className="text-xs text-red-400 bg-red-500/10 px-2 py-1 rounded">Faltam: {validation.missing.join(", ")}</span>}
                    {validation.dupes.length > 0 && <span className="text-xs text-amber-400 bg-amber-500/10 px-2 py-1 rounded">Duplicados: {validation.dupes.join(", ")}</span>}
                    {validation.isValid && <span className="text-xs text-green-400 bg-green-500/10 px-2 py-1 rounded">Válido</span>}
                  </div>
                </div>
                <div className="flex gap-1.5 mt-3 flex-wrap">
                  <button onClick={() => setActiveGroup(null)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${!activeGroup ? "bg-[var(--accent)] text-white border-[var(--accent)]" : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"}`}>Todos</button>
                  {groups.map((g) => (
                    <button key={g} onClick={() => setActiveGroup(g)} className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${activeGroup === g ? "bg-[var(--accent)] text-white border-[var(--accent)]" : "border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)]"}`}>{g}</button>
                  ))}
                </div>
              </div>
              <div className="divide-y divide-[var(--border-default)] max-h-[420px] overflow-y-auto">
                {filteredFields.map((field) => {
                  const mappedCol = Object.entries(currentMapping).find(([, s]) => s === field.key)?.[0];
                  const sample = mappedCol && csvRows[0] ? csvRows[0][mappedCol] || "" : "";
                  return (
                    <div key={field.key} className="px-4 py-2.5 flex items-center gap-3 hover:bg-[var(--bg-tertiary)] transition-colors">
                      <div className="w-44 flex-shrink-0">
                        <span className={`text-sm ${field.required ? "font-semibold text-[var(--text-primary)]" : "text-[var(--text-secondary)]"}`}>{field.label}</span>
                        {field.required && <span className="text-red-400 ml-1 text-xs">*</span>}
                      </div>
                      <span className="text-[var(--text-tertiary)] text-xs flex-shrink-0">←</span>
                      <select value={mappedCol || ""} onChange={(e) => {
                        const nm = { ...currentMapping };
                        Object.keys(nm).forEach((k) => { if (nm[k] === field.key) delete nm[k]; });
                        if (e.target.value) nm[e.target.value] = field.key;
                        setCurrentMapping(nm);
                      }} className={`flex-1 bg-[var(--bg-primary)] border border-[var(--border-default)] rounded-lg px-2 py-1 text-sm ${!mappedCol ? "text-[var(--text-tertiary)]" : "text-[var(--text-primary)]"}`}>
                        <option value="">— Não mapeado —</option>
                        {csvHeaders.map((h) => <option key={h} value={h}>{h}</option>)}
                      </select>
                      <div className="w-44 flex-shrink-0 text-xs text-[var(--text-tertiary)] truncate">{sample ? `"${sample}"` : ""}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Actions */}
            <div className="flex justify-between pt-2">
              <button onClick={resetAll} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Voltar</button>
              <button onClick={() => setStep("preview")} disabled={!validation.isValid}
                className="px-5 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-lg hover:opacity-90 disabled:opacity-40">
                Próximo: Preview
              </button>
            </div>
          </div>
        )}

        {/* PREVIEW */}
        {step === "preview" && (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-3">
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-[var(--text-primary)]">{csvRows.length.toLocaleString()}</p>
                <p className="text-xs text-[var(--text-tertiary)]">Total</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-[var(--accent)]">{validation.mappedCount}</p>
                <p className="text-xs text-[var(--text-tertiary)]">Campos</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-[var(--text-primary)]">{projectKey.toUpperCase()}</p>
                <p className="text-xs text-[var(--text-tertiary)]">Projeto</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-amber-400">UPSERT</p>
                <p className="text-xs text-[var(--text-tertiary)]">Existentes atualizados</p>
              </div>
            </div>
            <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl overflow-hidden">
              <div className="p-4 border-b border-[var(--border-default)]">
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">Preview — primeiros {Math.min(10, previewData.length)} leads</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="bg-[var(--bg-tertiary)]">
                    <th className="text-left px-3 py-2 text-[var(--text-tertiary)] font-medium">#</th>
                    {previewCols.map((c) => <th key={c} className="text-left px-3 py-2 text-[var(--text-tertiary)] font-medium whitespace-nowrap">{c}</th>)}
                  </tr></thead>
                  <tbody className="divide-y divide-[var(--border-default)]">
                    {previewData.map((row, i) => (
                      <tr key={i} className="hover:bg-[var(--bg-tertiary)]">
                        <td className="px-3 py-2 text-[var(--text-tertiary)]">{i + 1}</td>
                        {previewCols.map((c) => <td key={c} className="px-3 py-2 text-[var(--text-secondary)] whitespace-nowrap max-w-[180px] truncate">{row[c] || "—"}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex justify-between pt-2">
              <button onClick={() => setStep("mapping")} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]">Voltar</button>
              <button onClick={executeImport} className="px-5 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-500">
                Importar {csvRows.length.toLocaleString()} leads
              </button>
            </div>
          </div>
        )}

        {/* IMPORTING */}
        {step === "importing" && (
          <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-12 text-center">
            <div className="w-14 h-14 mx-auto mb-6 rounded-full bg-[var(--accent)]/20 flex items-center justify-center">
              <svg className="animate-spin w-7 h-7 text-[var(--accent)]" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            </div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Importando leads...</h3>
            <p className="text-sm text-[var(--text-tertiary)] mb-6">{csvRows.length.toLocaleString()} leads · existentes serão atualizados</p>
            <div className="w-full max-w-sm mx-auto">
              <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div className="h-full bg-[var(--accent)] rounded-full transition-all duration-500" style={{ width: `${importProgress}%` }} />
              </div>
              <p className="text-xs text-[var(--text-tertiary)] mt-2">{importProgress}%</p>
            </div>
          </div>
        )}

        {/* RESULT */}
        {step === "result" && importResult && (
          <div className="space-y-4">
            <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-8 text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                <svg className="w-7 h-7 text-green-400" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
              </div>
              <h3 className="text-xl font-semibold text-[var(--text-primary)]">Importação concluída</h3>
              <p className="text-sm text-[var(--text-tertiary)] mt-1">{fileName}</p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-green-400">{importResult.imported}</p><p className="text-xs text-[var(--text-tertiary)]">Importados</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-amber-400">{importResult.skipped}</p><p className="text-xs text-[var(--text-tertiary)]">Ignorados</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-purple-400">{importResult.qualified}</p><p className="text-xs text-[var(--text-tertiary)]">Qualificados</p>
              </div>
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-[var(--text-primary)]">{importResult.total_rows}</p><p className="text-xs text-[var(--text-tertiary)]">Total CSV</p>
              </div>
            </div>
            {(importResult.ad_id_resolved || importResult.campaign_id_resolved) ? (
              <div className="bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl p-4 flex gap-6 text-sm text-[var(--text-secondary)]">
                {importResult.ad_id_resolved != null && <span>Ad IDs resolvidos: <strong>{importResult.ad_id_resolved}</strong></span>}
                {importResult.campaign_id_resolved != null && <span>Campaign IDs: <strong>{importResult.campaign_id_resolved}</strong></span>}
              </div>
            ) : null}
            {importResult.errors?.length > 0 && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                <h3 className="text-sm font-semibold text-red-300 mb-2">Erros ({importResult.errors.length})</h3>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {importResult.errors.map((e, i) => <p key={i} className="text-xs text-red-400 font-mono">{e}</p>)}
                </div>
              </div>
            )}
            <button onClick={resetAll} className="px-5 py-2 bg-[var(--accent)] text-white text-sm font-medium rounded-lg hover:opacity-90">Nova importação</button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
