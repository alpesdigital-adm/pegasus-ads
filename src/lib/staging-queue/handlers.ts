// Registry de handlers da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §8.
//
// Cada handler recebe (input, workspaceId) e retorna outputData. Sem side
// effects no banco local — o worker cuida da persistência (markStepSucceeded,
// propagateOutputs, emitEvent).
//
// FASE 1B (shell): apenas `load_context` está implementado (handler mínimo
// pra validar ponta-a-ponta sem tocar Meta API). Os demais retornam NOT_IMPLEMENTED
// — serão preenchidos na Fase 2 (step handlers completos).

import { dbAdmin } from "@/lib/db";
import { testRounds } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

export type StepHandler = (
  input: Record<string, unknown>,
  workspaceId: string,
) => Promise<Record<string, unknown>>;

/**
 * load_context — resolve contexto de negócio mínimo (test_round + campaign).
 * Input:  { testRoundId: string }
 * Output: { testRoundId, campaignId, workspaceId, loadedAt }
 *
 * Implementação real: busca via dbAdmin + filtro manual de workspace
 * (worker pattern — BYPASSRLS + enforcement no WHERE). Se o test_round
 * não existe ou não pertence ao workspace, lança erro — classificado
 * como UNKNOWN (retryable) porque pode ser race condition de criação.
 */
async function handleLoadContext(
  input: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const testRoundId = input.testRoundId as string | undefined;
  if (!testRoundId) {
    throw new Error("META_VALIDATION: load_context requires testRoundId in input");
  }

  const [row] = await dbAdmin
    .select({ id: testRounds.id, campaignId: testRounds.campaignId })
    .from(testRounds)
    .where(
      and(
        eq(testRounds.id, testRoundId),
        eq(testRounds.workspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!row) {
    throw new Error(
      `load_context: test_round ${testRoundId} not found in workspace ${workspaceId}`,
    );
  }

  return {
    testRoundId: row.id,
    campaignId: row.campaignId,
    workspaceId,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Stub — lança NOT_IMPLEMENTED pra forçar retry=off e batch=failed fast.
 * Substituído handler por handler na Fase 2.
 */
function notImplemented(stepType: string): StepHandler {
  return async () => {
    throw new Error(
      `NOT_IMPLEMENTED: handler for step_type='${stepType}' will be added in Fase 2`,
    );
  };
}

export const stepHandlers: Record<string, StepHandler> = {
  load_context: handleLoadContext,

  // Upload
  upload_image: notImplemented("upload_image"),
  upload_video: notImplemented("upload_video"),
  // Labels
  create_ad_label: notImplemented("create_ad_label"),
  // Creative
  create_creative: notImplemented("create_creative"),
  create_carousel_creative: notImplemented("create_carousel_creative"),
  // Ad Set
  create_adset: notImplemented("create_adset"),
  clone_adset: notImplemented("clone_adset"),
  // Ad
  create_ad: notImplemented("create_ad"),
  // Verificação
  verify_pre_publish: notImplemented("verify_pre_publish"),
  verify_post_publish: notImplemented("verify_post_publish"),
  // Contexto
  resolve_model_ad: notImplemented("resolve_model_ad"),
  list_adsets: notImplemented("list_adsets"),
  download_drive_files: notImplemented("download_drive_files"),
  // Ativação
  activate_ads: notImplemented("activate_ads"),
  // Persistência
  persist_results: notImplemented("persist_results"),
  // Import (Fase 6)
  import_structure: notImplemented("import_structure"),
  import_image: notImplemented("import_image"),
  import_video: notImplemented("import_video"),
  import_insights: notImplemented("import_insights"),
};

export function getStepHandler(stepType: string): StepHandler {
  const h = stepHandlers[stepType];
  if (!h) throw new Error(`No handler for step type: ${stepType}`);
  return h;
}

/**
 * Steps que chamam Meta API — worker insere rate-limit de 2s entre eles.
 * Mantido em fonte única pra reuso na Fase 2 (handlers reais).
 */
const META_STEP_TYPES = new Set<string>([
  "upload_image",
  "upload_video",
  "create_ad_label",
  "create_creative",
  "create_carousel_creative",
  "create_adset",
  "clone_adset",
  "create_ad",
  "verify_pre_publish",
  "verify_post_publish",
  "resolve_model_ad",
  "list_adsets",
  "activate_ads",
  "import_structure",
  "import_image",
  "import_video",
  "import_insights",
]);

export function isMetaApiStep(stepType: string): boolean {
  return META_STEP_TYPES.has(stepType);
}
