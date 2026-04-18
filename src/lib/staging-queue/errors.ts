// Classificação e retry policy da Staging Queue v2.
// Spec: docs/staging-queue-v2.md §7.4 + §5.2 (backoff).

export type StepErrorCode =
  | "META_RATE_LIMIT"
  | "META_AUTH_EXPIRED"
  | "META_VALIDATION"
  | "META_DUPLICATE"
  | "META_TEMPORARY"
  | "NETWORK"
  | "STORAGE"
  | "NOT_IMPLEMENTED"
  | "UNKNOWN";

/**
 * Classifica erro em código canônico. Usado pra:
 *  - decidir se vale retry (isNonRetryable)
 *  - telemetria agregada (last_error_code virá no Brain/logs)
 */
export function classifyError(error: unknown): StepErrorCode {
  const msg = error instanceof Error ? error.message : String(error);

  // HTTP 4xx de fetch nosso (ex: upload_image buscando blob URL morto).
  // TD-018: 4xx é non-retryable — recurso que retornou 404/403/401 hoje
  // não vai virar 200 em 5s. Poupa ~105s de backoff (5+20+80) até failed.
  // Match em mensagens do tipo "blob fetch failed 404", "HTTP 403", etc.
  if (/\b(4\d{2})\b.*(?:fetch|http|status|failed)/i.test(msg) ||
      /(?:fetch|http|status)[^\d]{0,20}\b4\d{2}\b/i.test(msg)) {
    return "META_VALIDATION"; // reusa non-retryable existing code
  }

  // Meta API
  if (msg.includes("code 17") || /rate.?limit/i.test(msg)) return "META_RATE_LIMIT";
  if (msg.includes("code 190") || /access.?token/i.test(msg)) return "META_AUTH_EXPIRED";
  if (msg.includes("code 100") || /invalid parameter/i.test(msg)) return "META_VALIDATION";
  if (msg.includes("code 506") || /duplicate/i.test(msg)) return "META_DUPLICATE";
  if (msg.includes("code 2") || /temporary error/i.test(msg)) return "META_TEMPORARY";

  // Network (conexão real) — retryable
  if (/ECONNREFUSED|ETIMEDOUT|fetch failed|ENOTFOUND/i.test(msg)) return "NETWORK";

  // Storage
  if (/storage|bucket/i.test(msg)) return "STORAGE";

  if (/NOT_IMPLEMENTED/i.test(msg)) return "NOT_IMPLEMENTED";

  return "UNKNOWN";
}

/**
 * Erros que NÃO devem ser retentados. Retry é desperdício:
 *  - META_VALIDATION: input ruim, vai falhar igual
 *  - META_AUTH_EXPIRED: precisa intervenção manual (rotacionar token)
 *  - META_DUPLICATE: operação já aconteceu, retry duplicaria efeito
 *  - NOT_IMPLEMENTED: handler não existe, retry é inútil
 */
export function isNonRetryable(code: StepErrorCode): boolean {
  return (
    code === "META_VALIDATION" ||
    code === "META_AUTH_EXPIRED" ||
    code === "META_DUPLICATE" ||
    code === "NOT_IMPLEMENTED"
  );
}

/**
 * Backoff exponencial por attempts. Cap em 5min.
 *   attempts=0 → 5s
 *   attempts=1 → 20s
 *   attempts=2 → 80s
 *   attempts=3 → 320s (5min cap)
 */
export function calculateNextRetry(attempts: number): Date {
  const baseMs = 5000;
  const delayMs = Math.min(300_000, baseMs * Math.pow(4, attempts));
  return new Date(Date.now() + delayMs);
}
