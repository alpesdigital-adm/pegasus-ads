/**
 * Fase 2 — Migra public.users existentes pra auth.users (gotrue).
 *
 * Para cada usuário em public.users que ainda não tem auth_user_id:
 *   1. Chama POST /admin/users no gotrue com email + senha temporária
 *      aleatória + email_confirm=true (evita email de verificação).
 *   2. Grava auth.users.id em public.users.auth_user_id.
 *   3. Se --skip-reset-email NÃO for passado: envia email de password reset
 *      via POST /recover. Se --set-password for passado, usa essa senha
 *      (em vez de aleatória) — permite login imediato sem depender de SMTP.
 *
 * Idempotente: re-rodadas pulam users que já têm auth_user_id.
 *
 * Flags:
 *   --dry-run            lista usuários sem migrar
 *   --email=<email>      migra só o usuário com este email (filtro)
 *   --set-password=<pwd> cria auth.users com esta senha (vs. aleatória)
 *                        — útil quando SMTP do gotrue não está configurado
 *   --skip-reset-email   não dispara POST /recover (usa junto com --set-password)
 *
 * Uso:
 *   DATABASE_URL=... SUPABASE_AUTH_URL=... \
 *   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   SUPABASE_JWT_SECRET=... \
 *   tsx scripts/phase-2-migrate-users-to-auth.ts [flags]
 */

import { dbAdmin } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  adminCreateUser,
  adminGetUserByEmail,
  adminSendPasswordReset,
  GotrueHttpError,
} from "@/lib/supabase-auth";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "crypto";

interface MigrationRow {
  id: string;
  email: string;
  name: string;
}

interface MigrationResult {
  total: number;
  migrated: number;
  skipped: number;
  errors: Array<{ email: string; error: string }>;
}

interface RunOptions {
  dryRun: boolean;
  emailFilter?: string;
  setPassword?: string;
  skipResetEmail: boolean;
}

function parseFlag(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return undefined;
  const value = arg.slice(prefix.length);
  return value.length > 0 ? value : undefined;
}

async function runMigration(opts: RunOptions): Promise<MigrationResult> {
  const whereClause = opts.emailFilter
    ? and(isNull(users.authUserId), eq(users.email, opts.emailFilter.toLowerCase()))
    : isNull(users.authUserId);

  const pendingRows = (await dbAdmin
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(whereClause)) as MigrationRow[];

  const result: MigrationResult = {
    total: pendingRows.length,
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  console.log(`[phase-2] ${pendingRows.length} usuários sem auth_user_id${opts.emailFilter ? ` (filtro email=${opts.emailFilter})` : ""}.`);
  if (opts.dryRun) {
    console.log("[phase-2] DRY RUN — nenhuma mudança aplicada.");
    console.log(pendingRows.map((r) => `  - ${r.email} (${r.id})`).join("\n"));
    return result;
  }

  for (const row of pendingRows) {
    try {
      // Evita duplicar se o user já existe no gotrue (re-run após falha parcial)
      let gotrueUser = await adminGetUserByEmail(row.email);

      if (!gotrueUser) {
        const password = opts.setPassword ?? crypto.randomBytes(24).toString("base64url");
        gotrueUser = await adminCreateUser({
          email: row.email,
          password,
          email_confirm: true,
          user_metadata: { name: row.name, migrated_from_scrypt: true },
        });
      } else {
        console.log(`[phase-2] ${row.email}: já existe no gotrue (${gotrueUser.id}) — só linkando.`);
      }

      await dbAdmin
        .update(users)
        .set({ authUserId: gotrueUser.id })
        .where(eq(users.id, row.id));

      if (!opts.skipResetEmail) {
        await adminSendPasswordReset(row.email);
      }

      result.migrated += 1;
      console.log(
        `[phase-2] ✓ ${row.email} → auth.users.id=${gotrueUser.id}${opts.skipResetEmail ? " (sem email de reset)" : ""}`,
      );
    } catch (err) {
      const msg =
        err instanceof GotrueHttpError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      result.errors.push({ email: row.email, error: msg });
      console.error(`[phase-2] ✗ ${row.email}: ${msg}`);
    }
  }

  return result;
}

async function main() {
  const opts: RunOptions = {
    dryRun: process.argv.includes("--dry-run"),
    emailFilter: parseFlag("--email="),
    setPassword: parseFlag("--set-password="),
    skipResetEmail: process.argv.includes("--skip-reset-email"),
  };

  // Sanity check: --set-password só faz sentido com --skip-reset-email
  // (senão envia reset por cima da senha definida). Warn, não bloqueia.
  if (opts.setPassword && !opts.skipResetEmail) {
    console.warn("[phase-2] aviso: --set-password sem --skip-reset-email. Usuário receberá email de reset que pode invalidar a senha definida.");
  }

  const result = await runMigration(opts);

  console.log("\n=== RESULT ===");
  console.log(`Total:    ${result.total}`);
  console.log(`Migrated: ${result.migrated}`);
  console.log(`Skipped:  ${result.skipped}`);
  console.log(`Errors:   ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.log("\nErros:");
    for (const e of result.errors) {
      console.log(`  - ${e.email}: ${e.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[phase-2] fatal:", err);
  process.exit(2);
});
