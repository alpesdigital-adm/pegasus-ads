// Emissão de eventos da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §4.4 + §10.4.4 (throttle intra-step).

import { dbAdmin } from "@/lib/db";
import { stepEvents } from "@/lib/db/schema";

/**
 * Emite transição de estado de um step. Append-only em step_events.
 * Usa dbAdmin (worker tem BYPASSRLS) — workspace_id vem do step pra
 * manter RLS consistente na leitura via Realtime.
 */
export async function emitEvent(params: {
  stepId: string;
  batchId: string;
  workspaceId: string;
  fromStatus: string;
  toStatus: string;
  message?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await dbAdmin.insert(stepEvents).values({
    stepId: params.stepId,
    batchId: params.batchId,
    workspaceId: params.workspaceId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    message: params.message ?? null,
    metadata: params.metadata ?? {},
  });
}

/**
 * Progresso intra-step (ex: upload_video em chunks). Não é transição de
 * state machine — ambos fromStatus/toStatus são 'progress'. Throttle
 * em memória: emite no máximo a cada 5% de delta OU 5s, o que vier primeiro.
 * Evita explodir rows em step_events pra vídeos grandes.
 *
 * Chamadores devem passar `resetKey` único por execução de step
 * (tipicamente o stepId da invocação atual) pra isolar progressões.
 */
const progressState = new Map<string, { percent: number; at: number }>();
const THROTTLE_PCT = 5;
const THROTTLE_MS = 5_000;

export async function emitProgress(params: {
  stepId: string;
  batchId: string;
  workspaceId: string;
  percent: number;
  extra?: Record<string, unknown>;
}): Promise<void> {
  const key = params.stepId;
  const last = progressState.get(key);
  const now = Date.now();

  // Sempre deixa o 100% passar
  const delta = last ? params.percent - last.percent : params.percent;
  const timeSince = last ? now - last.at : Infinity;
  const isTerminal = params.percent >= 100;

  if (!isTerminal && delta < THROTTLE_PCT && timeSince < THROTTLE_MS) {
    return;
  }

  progressState.set(key, { percent: params.percent, at: now });

  await dbAdmin.insert(stepEvents).values({
    stepId: params.stepId,
    batchId: params.batchId,
    workspaceId: params.workspaceId,
    fromStatus: "progress",
    toStatus: "progress",
    message: `Progress ${params.percent.toFixed(0)}%`,
    metadata: { percent: params.percent, ...params.extra },
  });

  if (isTerminal) progressState.delete(key);
}
