// =============================================================================
// Logger (Pino) — structured logging para Pegasus Ads
// =============================================================================
// Uso:
//   import { logger } from "@/lib/logger";
//   logger.info({ workspace_id, route }, "sync-all started");
//
// Scoped:
//   const log = logger.child({ route: "/api/cron/sync-all" });
//   log.error({ err }, "meta api failed");
//
// Level vem de LOG_LEVEL (default "info"). Dev usa pino-pretty (colorido +
// timestamps legíveis). Prod emite JSON em stdout — `docker logs` captura
// direto, pronto pra Loki/Vector/fluentbit no futuro.

import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: "pegasus-ads",
    env: process.env.NODE_ENV || "development",
  },
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
    },
  }),
});

export type Logger = typeof logger;
