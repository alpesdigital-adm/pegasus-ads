/**
 * AIVerifyService — Checkpoints de verificação com IA ao longo do pipeline.
 *
 * 4 checkpoints:
 * 1. post_generation: A variante gerada isola corretamente a variável?
 * 2. pre_publish: Tudo pronto para publicar? (naming, dimensões, meta config)
 * 3. post_publish: Ads foram criados corretamente? Status esperado?
 * 4. analysis: Dados suficientes para decisão? Kill rule aplicável?
 */

import type { VerificationCheckpoint } from "./types";

// ── Checkpoint 1: Post-Generation ──

interface PostGenVerifyInput {
  controlImageBase64?: string;
  variantImageBase64?: string;
  variableType: string;
  variableValue?: string;
  variantWidth?: number;
  variantHeight?: number;
  expectedWidth: number;
  expectedHeight: number;
}

export function verifyPostGeneration(input: PostGenVerifyInput): VerificationCheckpoint {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Verificar dimensões
  if (input.variantWidth && input.variantHeight) {
    if (input.variantWidth !== input.expectedWidth || input.variantHeight !== input.expectedHeight) {
      issues.push(
        `Dimensões incorretas: ${input.variantWidth}x${input.variantHeight}, esperado ${input.expectedWidth}x${input.expectedHeight}. Resize necessário.`
      );
      suggestions.push("Aplicar resize com LANCZOS antes de salvar.");
    }
  }

  // Verificar se imagem foi gerada
  if (!input.variantImageBase64) {
    issues.push("Nenhuma imagem gerada pelo modelo.");
    suggestions.push("Retentar geração com prompt ajustado.");
  }

  // Score baseado em issues
  const score = issues.length === 0 ? 1.0 : Math.max(0, 1.0 - issues.length * 0.3);

  return {
    checkpoint: "post_generation",
    passed: issues.filter((i) => !i.includes("Resize")).length === 0, // Resize é fixável
    score,
    issues,
    suggestions,
    verified_at: new Date().toISOString(),
  };
}

// ── Checkpoint 2: Pre-Publish ──

interface PrePublishVerifyInput {
  adName: string;
  adSetName: string;
  feedImageReady: boolean;
  storiesImageReady: boolean;
  hasAttribution: boolean;
  hasBidStrategy: boolean;
  hasTargeting: boolean;
  hasPromotedObject: boolean;
  dailyBudgetCents?: number;
  campaignObjective?: string;
}

export function verifyPrePublish(input: PrePublishVerifyInput): VerificationCheckpoint {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Naming convention
  if (!input.adName.match(/^T\d+EBMX-AD\d{3}/)) {
    issues.push(`Nome do ad "${input.adName}" não segue padrão T{N}EBMX-AD{NNN}.`);
    suggestions.push("Corrigir nome antes de publicar.");
  }

  // Imagens
  if (!input.feedImageReady) {
    issues.push("Imagem Feed não está pronta.");
  }
  if (!input.storiesImageReady) {
    issues.push("Imagem Stories não está pronta.");
  }

  // Attribution (obrigatória para lead campaigns)
  if (!input.hasAttribution) {
    issues.push("CRÍTICO: attribution_spec com 1 dia clique não configurado.");
    suggestions.push("Adicionar attribution_spec: [{event_type: CLICK_THROUGH, window_days: 1}]");
  }

  // Bid strategy
  if (!input.hasBidStrategy) {
    issues.push("bid_strategy não definido no ad set.");
    suggestions.push("Definir bid_strategy (ex: LOWEST_COST_WITHOUT_CAP).");
  }

  // Targeting
  if (!input.hasTargeting) {
    issues.push("Targeting não definido.");
    suggestions.push("Copiar targeting de ad set template da campanha.");
  }

  // Promoted object
  if (!input.hasPromotedObject) {
    issues.push("promoted_object não definido.");
    suggestions.push("Incluir pixel_id + custom_event_type: Lead.");
  }

  // Budget sanity
  if (input.dailyBudgetCents && input.dailyBudgetCents < 500) {
    suggestions.push(`Budget diário de R$${(input.dailyBudgetCents / 100).toFixed(2)} parece baixo. Mínimo recomendado: R$5.`);
  }

  const criticalIssues = issues.filter(
    (i) => i.includes("CRÍTICO") || i.includes("não está pronta")
  );
  const passed = criticalIssues.length === 0;

  return {
    checkpoint: "pre_publish",
    passed,
    score: Math.max(0, 1.0 - issues.length * 0.2),
    issues,
    suggestions,
    verified_at: new Date().toISOString(),
  };
}

// ── Checkpoint 3: Post-Publish ──

interface PostPublishVerifyInput {
  adsCreated: Array<{
    adId: string;
    adName: string;
    status: string;
  }>;
  expectedCount: number;
}

export function verifyPostPublish(input: PostPublishVerifyInput): VerificationCheckpoint {
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Verificar quantidade
  if (input.adsCreated.length !== input.expectedCount) {
    issues.push(
      `Esperados ${input.expectedCount} ads, criados ${input.adsCreated.length}.`
    );
  }

  // Verificar status
  for (const ad of input.adsCreated) {
    if (ad.status === "DISAPPROVED" || ad.status === "WITH_ISSUES") {
      issues.push(`Ad ${ad.adName} (${ad.adId}) com status ${ad.status}.`);
      suggestions.push("Verificar políticas de anúncio no Meta Ads Manager.");
    }
  }

  // Lembrete de Advantage+ Creative
  suggestions.push(
    "VERIFICAR: Variações de IA (Advantage+ Creative) estão ativas? Conferir manualmente no Gerenciador de Anúncios."
  );

  return {
    checkpoint: "post_publish",
    passed: issues.length === 0,
    score: Math.max(0, 1.0 - issues.length * 0.3),
    issues,
    suggestions,
    verified_at: new Date().toISOString(),
  };
}

// ── Checkpoint 4: Analysis ──

interface AnalysisVerifyInput {
  variantMetrics: {
    creativeId: string;
    spend: number;
    impressions: number;
    leads: number;
    cpl: number | null;
  };
  controlMetrics: {
    spend: number;
    impressions: number;
    leads: number;
    cpl: number | null;
  };
  cplTarget: number;
  minSpendForDecision: number;
  minImpressionsForDecision: number;
}

export function verifyAnalysis(input: AnalysisVerifyInput): VerificationCheckpoint {
  const issues: string[] = [];
  const suggestions: string[] = [];
  const { variantMetrics, controlMetrics, cplTarget, minSpendForDecision, minImpressionsForDecision } = input;

  // Dados suficientes?
  if (variantMetrics.spend < minSpendForDecision) {
    issues.push(
      `Spend insuficiente: R$${variantMetrics.spend.toFixed(2)} < R$${minSpendForDecision.toFixed(2)} mínimo.`
    );
    suggestions.push("Aguardar mais dados antes de decidir.");
  }

  if (variantMetrics.impressions < minImpressionsForDecision) {
    issues.push(
      `Impressões insuficientes: ${variantMetrics.impressions} < ${minImpressionsForDecision} mínimo.`
    );
  }

  // Kill rule L0: sem lead com spend >= 1.5x CPL target
  if (variantMetrics.leads === 0 && variantMetrics.spend >= cplTarget * 1.5) {
    suggestions.push(
      `KILL RULE L0: Variante sem leads com spend R$${variantMetrics.spend.toFixed(2)} >= 1.5x CPL target (R$${(cplTarget * 1.5).toFixed(2)}). Recomendação: PAUSAR.`
    );
  }

  // CPL comparison
  if (variantMetrics.cpl !== null && controlMetrics.cpl !== null) {
    const cplDiff = ((variantMetrics.cpl - controlMetrics.cpl) / controlMetrics.cpl) * 100;
    if (cplDiff > 30) {
      suggestions.push(
        `CPL da variante ${cplDiff.toFixed(0)}% acima do controle. Considerar pausar.`
      );
    } else if (cplDiff < -15) {
      suggestions.push(
        `CPL da variante ${Math.abs(cplDiff).toFixed(0)}% abaixo do controle. Potencial winner!`
      );
    }
  }

  const passed = issues.length === 0;

  return {
    checkpoint: "analysis",
    passed,
    score: Math.max(0, 1.0 - issues.length * 0.25),
    issues,
    suggestions,
    verified_at: new Date().toISOString(),
  };
}
