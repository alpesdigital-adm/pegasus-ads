/**
 * Kill Rules — Sistema de 6 camadas (L0-L5) para decisão de criativos.
 *
 * Validado em 3 lançamentos: 97% acurácia, +774 leads saldo.
 * CPL target vem do planejamento (cenário realista), sem desconto.
 */

export interface KillRule {
  level: string;
  name: string;
  description: string;
  condition: (metrics: KillRuleMetrics) => boolean;
  action: "kill" | "warn" | "promote" | "observe";
  priority: number;
}

export interface KillRuleMetrics {
  spend: number;
  leads: number;
  cpl: number | null;
  impressions: number;
  ctr: number;
  cplTarget: number;
  controlCpl: number | null;
  daysRunning: number;
}

export const KILL_RULES: KillRule[] = [
  {
    level: "L0",
    name: "Sem Lead",
    description: "Spend >= 1.5x CPL target sem nenhum lead",
    condition: (m) => m.leads === 0 && m.spend >= m.cplTarget * 1.5,
    action: "kill",
    priority: 1,
  },
  {
    level: "L1",
    name: "CPL Explosivo",
    description: "CPL > 3x target com pelo menos 1 lead",
    condition: (m) =>
      m.leads > 0 && m.cpl !== null && m.cpl > m.cplTarget * 3,
    action: "kill",
    priority: 2,
  },
  {
    level: "L2",
    name: "CPL Alto Sustentado",
    description: "CPL > 2x target após 2+ dias",
    condition: (m) =>
      m.leads > 0 && m.cpl !== null && m.cpl > m.cplTarget * 2 && m.daysRunning >= 2,
    action: "kill",
    priority: 3,
  },
  {
    level: "L3",
    name: "CTR Morto",
    description: "CTR < 0.5% com 1000+ impressões",
    condition: (m) => m.impressions >= 1000 && m.ctr < 0.5,
    action: "warn",
    priority: 4,
  },
  {
    level: "L4",
    name: "Underperformer vs Controle",
    description: "CPL > 50% acima do controle com dados suficientes",
    condition: (m) =>
      m.cpl !== null &&
      m.controlCpl !== null &&
      m.controlCpl > 0 &&
      m.cpl > m.controlCpl * 1.5 &&
      m.spend >= m.cplTarget,
    action: "warn",
    priority: 5,
  },
  {
    level: "L5",
    name: "Winner Potencial",
    description: "CPL < 80% do controle com dados suficientes",
    condition: (m) =>
      m.cpl !== null &&
      m.controlCpl !== null &&
      m.controlCpl > 0 &&
      m.cpl < m.controlCpl * 0.8 &&
      m.spend >= m.cplTarget * 2 &&
      m.leads >= 3,
    action: "promote",
    priority: 6,
  },
];

/**
 * Avalia um criativo contra todas as kill rules e retorna a primeira que aplica.
 */
export function evaluateKillRules(metrics: KillRuleMetrics): KillRule | null {
  // Regras ordenadas por prioridade (mais urgente primeiro)
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
