/**
 * Kill Rules — Sistema de 8 camadas (L0a-L5) para decisão de criativos.
 *
 * v2 — Atualizado com base em validação empírica (T4, T6, T6ASM):
 *   - Degradação intra-campanha é irreversível (0% recuperação em 144 observações)
 *   - ~51% recupera em nova campanha; ~82% com mudança de formato
 *   - Threshold de deterioração reduzido de 1.7× para 1.25× (cortar mais cedo preserva budget)
 *   - Nova regra L3b: degradação monotônica acelerada (cpl3d > cpl7d > cpl acum)
 *   - recoveryPotential adicionado a cada regra para informar decisão de relançamento
 *
 * CPL meta vem do planejamento (cenário realista), sem desconto.
 * Avaliação hierárquica: L0a → L0b → L1 → L2 → L3 → L3b → L4 → L5 (primeiro match vence).
 * TODAS as regras resultam em PAUSAR (não há warn/promote neste sistema).
 */

export type RecoveryPotential = "high" | "medium" | "low" | null;

export interface KillRule {
  level: string;
  name: string;
  description: string;
  condition: (m: KillRuleMetrics) => boolean;
  action: "kill";
  recoveryPotential: RecoveryPotential;
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

  // Benchmark (para L5) — opcional, default false/null
  benchmarkExists?: boolean;
  rolling5dCpl?: number | null;

  // Janelas (para L3/L3b/L4) — opcional, default 0/null
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
    description: "Spend >= 1x CPL meta + 0 leads + CPM >= R$60 -> PAUSAR",
    condition: (m) =>
      m.leads === 0 &&
      m.spend >= m.cplTarget * 1 &&
      (m.cpm ?? 0) >= 60,
    action: "kill",
    recoveryPotential: null,
    priority: 1,
  },
  {
    level: "L0b",
    name: "Sem Lead",
    description: "Spend >= 1.5x CPL meta + 0 leads -> PAUSAR",
    condition: (m) =>
      m.leads === 0 &&
      m.spend >= m.cplTarget * 1.5,
    action: "kill",
    recoveryPotential: null,
    priority: 2,
  },

  // ── L1 — Claramente ruim (com leads) ──
  {
    level: "L1",
    name: "Claramente ruim",
    description: "Spend acum > 4x CPL meta & CPL acum > 1.5x CPL meta -> PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 4 &&
      m.cpl > m.cplTarget * 1.5,
    action: "kill",
    recoveryPotential: "low",
    priority: 3,
  },

  // ── L2 — Acima da meta com evidência ──
  {
    level: "L2",
    name: "Acima da meta com evidencia",
    description: "Spend acum > 6x CPL meta & CPL acum > 1.3x CPL meta -> PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 6 &&
      m.cpl > m.cplTarget * 1.3,
    action: "kill",
    recoveryPotential: "medium",
    priority: 4,
  },

  // ── L3 — Deterioração aguda 3d (threshold 1.25×, Caminho A) ──
  // Validação empírica: 0% recuperação intra-campanha em 144 observações.
  // Cortar cedo preserva budget para relançamento (~51% recovery inter-campanha).
  {
    level: "L3",
    name: "Deterioracao aguda 3d",
    description: "Spend 3d >= 2x CPL meta & CPL 3d > 1.25x & CPL acum > 1x meta & historico > 15% -> PAUSAR",
    condition: (m) =>
      (m.spend3d ?? 0) >= m.cplTarget * 2 &&
      m.cpl3d != null &&
      m.cpl3d > m.cplTarget * 1.25 &&
      m.cpl !== null &&
      m.cpl > m.cplTarget * 1 &&
      m.spend > 0 &&
      ((m.spend3d ?? 0) / m.spend) > 0.15,
    action: "kill",
    recoveryPotential: "high",
    priority: 5,
  },

  // ── L3b — Degradação monotônica acelerada (NOVA) ──
  // Padrão empírico: cpl3d > cpl7d > cpl_acum = tendência irreversível.
  // Captura aceleração da degradação, não apenas nível absoluto.
  {
    level: "L3b",
    name: "Degradacao monotonica acelerada",
    description: "CPL 3d > CPL 7d > CPL acum & CPL 3d > 1.25x meta & spend 3d >= 2x CPL meta -> PAUSAR",
    condition: (m) =>
      m.cpl3d != null &&
      m.cpl7d != null &&
      m.cpl !== null &&
      m.cpl3d > m.cpl7d &&
      m.cpl7d > m.cpl &&
      m.cpl3d > m.cplTarget * 1.25 &&
      (m.spend3d ?? 0) >= m.cplTarget * 2,
    action: "kill",
    recoveryPotential: "high",
    priority: 6,
  },

  // ── L4 — Deterioração lenta 7d ──
  {
    level: "L4",
    name: "Deterioracao lenta 7d",
    description: "Spend 7d >= 2x CPL meta & CPL 7d > 1.25x & CPL acum > 1x meta -> PAUSAR",
    condition: (m) =>
      (m.spend7d ?? 0) >= m.cplTarget * 2 &&
      m.cpl7d != null &&
      m.cpl7d > m.cplTarget * 1.25 &&
      m.cpl !== null &&
      m.cpl > m.cplTarget * 1,
    action: "kill",
    recoveryPotential: "high",
    priority: 7,
  },

  // ── L5 — Mediocridade persistente ──
  {
    level: "L5",
    name: "Mediocridade persistente",
    description: "Spend acum > 10x CPL meta & CPL acum > 1.15x & benchmark existe & rolling 5d > 1.15x -> PAUSAR",
    condition: (m) =>
      m.leads > 0 &&
      m.cpl !== null &&
      m.spend > m.cplTarget * 10 &&
      m.cpl > m.cplTarget * 1.15 &&
      (m.benchmarkExists ?? false) &&
      m.rolling5dCpl != null &&
      m.rolling5dCpl > m.cplTarget * 1.15,
    action: "kill",
    recoveryPotential: "medium",
    priority: 8,
  },
];

/**
 * Avalia um criativo contra todas as kill rules e retorna a primeira que aplica.
 * Hierárquico: L0a -> L0b -> L1 -> L2 -> L3 -> L3b -> L4 -> L5 (primeiro match vence).
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
