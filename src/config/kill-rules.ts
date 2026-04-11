/**
 * Kill Rules — Sistema de 6 camadas (L0-L5) para decisão de criativos.
 *
 * SPEC ORIGINAL validada em 3 lançamentos: 97% acurácia, +774 leads saldo.
 * CPL meta vem do planejamento (cenário realista), sem desconto.
 * Benchmark = ad com spend > 20× CPL meta & CPL ≤ CPL meta.
 * Avaliação hierárquica: L0 → L1 → L2 → L3 → L4 → L5 (primeiro match vence).
 *
 * TODAS as regras resultam em PAUSAR (não há warn/promote neste sistema).
 */

export interface KillRule {
  level: string;
  name: string;
  description: string;
  condition: (m: KillRuleMetrics) => boolean;
  action: "kill";
  priority: number;
}

export interface KillRuleMetrics {
  // Acumulado (lifetime ou janela selecionada)
  spend: number;
  leads: number;
  cpl: number | null;
  impressions: number;
  ctr: number;
  cpm?: number;                // Para L0a (CPM >= R$60)
  daysRunning: number;

  // Config
  cplTarget: number;           // CPL meta do planejamento (R$32.77 para T7)

  // Benchmark (para L3/L4/L5) — opcional, default false/null
  benchmarkExists?: boolean;
  rolling5dCpl?: number | null;

  // Janelas (para L3/L4) — opcional, default 0/null
  spend3d?: number;
  leads3d?: number;
  cpl3d?: number | null;
  spend7d?: number;
  leads7d?: number;
  cpl7d?: number | null;

  // Legado (ignorado, mantido para compatibilidade)
  controlCpl?: number | null;
}

export const KILL_RULES: KillRule[] = [
  // ── L0 — Sem leads ──
  {
    level: "L0a",
    name: "Sem Lead + CPM alto",
    description: "Spend ≥ 1× CPL meta + 0 leads + CPM ≥ R$60 → PAUSAR",
    condition: (m) =>
      m.leads === 0 &&
      m.spend >= m.cplTarget * 1 &&
      (m.cpm ?? 0) >= 60,
    action: "kill",
    priority: 1,
  },
  {
    level: "L0b",
    name: "Sem Lead",
    description: "Spend ≥ 1.5× CPL meta + 0 leads → PAUSAR",
    condition: (m) =>
      m.leads === 0 &&
      m.spend >= m.cplTarget * 1.5,
    action: "kill",
    priority: 2,
  },

  // ── L1 — Claramente ruim (com leads) ──
  {
    level: "L1",
    name: "Claramente ruim",
    description: "Spend acum > 4× CPL meta & CPL acum > 1.5× CPL meta → PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 4 &&
      m.cpl > m.cplTarget * 1.5,
    action: "kill",
    priority: 3,
  },

  // ── L2 — Acima da meta com evidência ──
  {
    level: "L2",
    name: "Acima da meta com evidência",
    description: "Spend acum > 6× CPL meta & CPL acum > 1.3× CPL meta → PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 6 &&
      m.cpl > m.cplTarget * 1.3,
    action: "kill",
    priority: 4,
  },

  // ── L3 — Deterioração aguda 3d ──
  {
    level: "L3",
    name: "Deterioração aguda 3d",
    description: "Spend 3d > 5× CPL meta & CPL 3d > 1.7× & CPL acum > 1× & benchmark existe & rolling 5d > 1.15× → PAUSAR",
    condition: (m) =>
      (m.spend3d ?? 0) > m.cplTarget * 5 &&
      m.cpl3d != null &&
      m.cpl3d > m.cplTarget * 1.7 &&
      m.cpl !== null &&
      m.cpl > m.cplTarget * 1 &&
      (m.benchmarkExists ?? false) &&
      m.rolling5dCpl != null &&
      m.rolling5dCpl > m.cplTarget * 1.15,
    action: "kill",
    priority: 5,
  },

  // ── L4 — Deterioração lenta 7d ──
  {
    level: "L4",
    name: "Deterioração lenta 7d",
    description: "Spend 7d > 5× CPL meta & CPL 7d > 1.7× & CPL acum > 1× & benchmark existe & rolling 5d > 1.15× → PAUSAR",
    condition: (m) =>
      (m.spend7d ?? 0) > m.cplTarget * 5 &&
      m.cpl7d != null &&
      m.cpl7d > m.cplTarget * 1.7 &&
      m.cpl !== null &&
      m.cpl > m.cplTarget * 1 &&
      (m.benchmarkExists ?? false) &&
      m.rolling5dCpl != null &&
      m.rolling5dCpl > m.cplTarget * 1.15,
    action: "kill",
    priority: 6,
  },

  // ── L5 — Mediocridade persistente ──
  {
    level: "L5",
    name: "Mediocridade persistente",
    description: "Spend acum > 10× CPL meta & CPL acum > 1.15× & benchmark existe & rolling 5d > 1.15× → PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 10 &&
      m.cpl > m.cplTarget * 1.15 &&
      (m.benchmarkExists ?? false) &&
      m.rolling5dCpl != null &&
      m.rolling5dCpl > m.cplTarget * 1.15,
    action: "kill",
    priority: 7,
  },
];

/**
 * Avalia um criativo contra todas as kill rules e retorna a primeira que aplica.
 * Hierárquico: L0 → L1 → L2 → L3 → L4 → L5 (primeiro match vence).
 */
export function evaluateKillRules(metrics: KillRuleMetrics): KillRule | null {
  const sorted = [...KILL_RULES].sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (rule.condition(metrics)) {
      return rule;
    }
  }
  return null;
}

/**
 * Avalia todas as kill rules e retorna todas que aplicam.
 */
export function evaluateAllKillRules(metrics: KillRuleMetrics): KillRule[] {
  return KILL_RULES.filter((rule) => rule.condition(metrics))
    .sort((a, b) => a.priority - b.priority);
}
