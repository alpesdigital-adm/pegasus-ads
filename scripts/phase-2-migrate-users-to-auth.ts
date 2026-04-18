/**
 * Fase 2 — Migra public.users existentes pra auth.users (gotrue).
 *
 * Para cada usuário em public.users que ainda não tem auth_user_id:
 *   1. Chama POST /admin/users no gotrue com email + senha temporária
 *      aleatória + email_confirm=true (evita email de verificação).
 *   2. Grava auth.users.id em public.users.auth_user_id.
 *   3. Envia email de password reset via POST /recover (gotrue manda
 *      link para o usuário definir nova senha).
 *
 * Idempotente: re-rodadas pulam users que já têm auth_user_id.
 *
 * Uso:
 *   DATABASE_URL=... SUPABASE_AUTH_URL=... \
 *   SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
 *   SUPABASE_JWT_SECRET=... \
 *   tsx scripts/phase-2-migrate-users-to-auth.ts [--dry-run]
 */

import { dbAdmin } from "@/lib/db";
import { users } from "@/lib/db/schema";
import {
  adminCreateUser,
  adminGetUserByEmail,
  adminSendPasswordReset,
  GotrueHttpError,
} from "@/lib/supabase-auth";
import { eq, isNull } from "drizzle-orm";
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

async function runMigration(dryRun: boolean): Promise<MigrationResult> {
  const pendingRows = (await dbAdmin
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(isNull(users.authUserId))) as MigrationRow[];

  const result: MigrationResult = {
    total: pendingRows.length,
    migrated: 0,
    skipped: 0,
    errors: [],
  };

  console.log(`[phase-2] ${pendingRows.length} usuários sem auth_user_id.`);
  if (dryRun) {
    console.log("[phase-2] DRY RUN — nenhuma mudança aplicada.");
    console.log(pendingRows.map((r) => `  - ${r.email} (${r.id})`).join("\n"));
    return result;
  }

  for (const row of pendingRows) {
    try {
      // Evita duplicar se o user já existe no gotrue (re-run após falha parcial)
      let gotrueUser = await adminGetUserByEmail(row.email);

      if (!gotrueUser) {
        // Senha temporária aleatória — usuário nunca vai usar, vai resetar via email
        const tempPassword = crypto.randomBytes(24).toString("base64url");
        gotrueUser = await adminCreateUser({
          email: row.email,
          password: tempPassword,
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

      // Manda email de reset — usuário precisa clicar pra definir senha nova
      await adminSendPasswordReset(row.email);

      result.migrated += 1;
      console.log(`[phase-2] ✓ ${row.email} → auth.users.id=${gotrueUser.id}`);
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
  const dryRun = process.argv.includes("--dry-run");
  const result = await runMigration(dryRun);

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
