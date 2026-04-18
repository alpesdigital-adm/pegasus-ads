/**
 * Fase 2 — One-off: enrola user existente nos apps indicados.
 *
 * Motivação: usuários criados ANTES do app_metadata.apps tagging (ex: user
 * do Leandro migrado em 2026-04-18) não têm a tag. Este script faz o
 * backfill: adiciona os apps passados ao app_metadata.apps do user no
 * gotrue, preservando o que já existe (merge union).
 *
 * Uso:
 *   npx tsx scripts/phase-2-enroll-user-in-apps.ts \
 *     --email=alpesdigital.adm@gmail.com \
 *     --apps=pegasus_ads,pegasus_crm
 *
 * Idempotente: re-rodar não duplica entradas na lista.
 */

import {
  adminGetUserByEmail,
  ensureAppEnrolled,
  GotrueHttpError,
} from "@/lib/supabase-auth";

function parseFlag(prefix: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  if (!arg) return undefined;
  const value = arg.slice(prefix.length);
  return value.length > 0 ? value : undefined;
}

async function main() {
  const email = parseFlag("--email=");
  const appsRaw = parseFlag("--apps=") ?? "pegasus_ads";
  const apps = appsRaw.split(",").map((s) => s.trim()).filter(Boolean);

  if (!email) {
    console.error("Uso: --email=<email> --apps=<app1,app2,...>");
    process.exit(1);
  }
  if (apps.length === 0) {
    console.error("--apps= precisa de pelo menos 1 app");
    process.exit(1);
  }

  console.log(`[enroll] email=${email} apps=[${apps.join(", ")}]`);

  try {
    const user = await adminGetUserByEmail(email);
    if (!user) {
      console.error(`[enroll] user não encontrado no gotrue: ${email}`);
      process.exit(2);
    }

    console.log(
      `[enroll] user encontrado: id=${user.id} apps_antes=${JSON.stringify(user.app_metadata?.apps ?? [])}`,
    );

    let updated = user;
    for (const app of apps) {
      updated = await ensureAppEnrolled(updated, app);
    }

    console.log(
      `[enroll] ✓ apps_depois=${JSON.stringify(updated.app_metadata?.apps ?? [])}`,
    );
  } catch (err) {
    const msg =
      err instanceof GotrueHttpError
        ? `${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.error(`[enroll] ✗ ${msg}`);
    process.exit(3);
  }
}

main();
