"use client";

import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";

interface Project {
  id: string;
  name: string;
  campaign_filter: string;
  description: string;
  status: string;
  created_at: string;
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", campaign_filter: "", description: "" });
  const [saving, setSaving] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/projects");
      const d = await r.json();
      setProjects(d.projects || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const handleSave = async () => {
    if (!form.name.trim() || !form.campaign_filter.trim()) return;
    setSaving(true);

    if (editingId) {
      await fetch("/api/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: editingId, ...form }),
      });
    } else {
      await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }

    setSaving(false);
    setShowForm(false);
    setEditingId(null);
    setForm({ name: "", campaign_filter: "", description: "" });
    fetchProjects();
  };

  const handleEdit = (p: Project) => {
    setForm({ name: p.name, campaign_filter: p.campaign_filter, description: p.description });
    setEditingId(p.id);
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Tem certeza que deseja excluir este projeto?")) return;
    await fetch("/api/projects", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    fetchProjects();
  };

  return (
    <AppShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projetos</h1>
            <p className="text-[var(--text-secondary)] text-sm mt-1">
              Organize campanhas por projeto usando filtros
            </p>
          </div>
          <button
            onClick={() => { setShowForm(true); setEditingId(null); setForm({ name: "", campaign_filter: "", description: "" }); }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-all"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" /></svg>
            Novo Projeto
          </button>
        </div>

        {/* Form */}
        {showForm && (
          <div className="p-6 rounded-xl border border-[var(--accent)]/20 bg-[var(--bg-card)]">
            <h3 className="text-sm font-semibold mb-4">{editingId ? "Editar Projeto" : "Novo Projeto"}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-[var(--text-tertiary)] mb-1">Nome do projeto</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Ex: RAT Academy T7"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--text-tertiary)] mb-1">
                  Filtro de campanhas
                  <span className="text-[var(--text-muted)] ml-1">(texto contido no nome da campanha)</span>
                </label>
                <input
                  type="text"
                  value={form.campaign_filter}
                  onChange={(e) => setForm({ ...form, campaign_filter: e.target.value })}
                  placeholder="Ex: T7__ (mostra todas as T7)"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50 font-mono"
                />
                <p className="text-[10px] text-[var(--text-muted)] mt-1">
                  Campanhas cujo nome contenha este texto serao exibidas. Ex: &quot;T7__&quot; filtra T7__0001, T7__0002, etc.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-tertiary)] mb-1">Descricao (opcional)</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Descricao do projeto"
                  className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]/50"
                />
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSave}
                  disabled={saving || !form.name.trim() || !form.campaign_filter.trim()}
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium disabled:opacity-50 transition-all"
                >
                  {saving ? "Salvando..." : editingId ? "Salvar" : "Criar"}
                </button>
                <button
                  onClick={() => { setShowForm(false); setEditingId(null); }}
                  className="px-4 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] transition-all"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Projects list */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : projects.length === 0 ? (
          <div className="text-center py-20 text-[var(--text-muted)]">
            Nenhum projeto criado. Crie um para organizar suas campanhas.
          </div>
        ) : (
          <div className="grid gap-3">
            {projects.map((p) => (
              <div key={p.id} className="flex items-center gap-4 p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--bg-hover)] transition-colors">
                <div className="w-10 h-10 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center text-[var(--accent)] font-bold text-sm shrink-0">
                  {p.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{p.name}</p>
                  <p className="text-xs text-[var(--text-tertiary)] mt-0.5">
                    Filtro: <code className="bg-[var(--bg-tertiary)] px-1.5 py-0.5 rounded text-[var(--accent)]">{p.campaign_filter}</code>
                    {p.description && <span className="ml-2">{p.description}</span>}
                  </p>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => handleEdit(p)}
                    className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-all"
                    title="Editar"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                  </button>
                  <button
                    onClick={() => handleDelete(p.id)}
                    className="p-2 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-400 transition-all"
                    title="Excluir"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
