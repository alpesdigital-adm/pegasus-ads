/**
 * Workspace — Operações de workspace e contas Meta vinculadas.
 *
 * Centraliza CRUD de workspaces, membros, contas Meta e API keys.
 *
 * MIGRADO NA FASE 1C (Wave 2, high-leverage library):
 *  - getDb() → dbAdmin (BYPASSRLS — library chamada de várias rotas,
 *    cada caller passa workspace_id explícito; RLS fica redundante e
 *    as queries sempre têm filtro manual)
 *  - 14 funções × ~31 queries migradas para Drizzle typed builder
 *  - Funções crypto (encryptToken/decryptToken) + generateApiKey +
 *    hashApiKey permanecem — são pure functions sobre buffers
 */

import { dbAdmin, sql } from "./db";
import {
  workspaces,
  workspaceMembers,
  workspaceMetaAccounts,
  workspaceSettings,
  apiKeys,
} from "./db/schema";
import { generateApiKey, hashApiKey } from "./auth";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import crypto from "crypto";

// ── Types ──

export interface WorkspaceMetaAccount {
  id: string;
  workspace_id: string;
  label: string;
  meta_account_id: string;
  auth_method: "token" | "oauth";
  /** Encrypted token (for token auth) */
  token_encrypted?: string;
  /** OAuth tokens JSON (for oauth auth) */
  oauth_tokens?: string;
  page_id?: string;
  pixel_id?: string;
  instagram_user_id?: string;
  is_default: boolean;
  created_at: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  owner_user_id: string;
}

export interface AddMetaAccountInput {
  workspace_id: string;
  label: string;
  meta_account_id: string;
  auth_method: "token" | "oauth";
  token?: string;
  oauth_tokens?: Record<string, unknown>;
  page_id?: string;
  pixel_id?: string;
  instagram_user_id?: string;
}

// ── Encryption (AES-256-GCM for tokens at rest) ──

function getEncryptionKey(): Buffer {
  const key = process.env.WORKSPACE_ENCRYPTION_KEY;
  if (!key) throw new Error("WORKSPACE_ENCRYPTION_KEY env var is required (32-byte hex)");
  return Buffer.from(key, "hex");
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data) + decipher.final("utf8");
}

// ── Workspace CRUD ──

export async function createWorkspace(input: CreateWorkspaceInput): Promise<string> {
  const inserted = await dbAdmin
    .insert(workspaces)
    .values({
      name: input.name,
      slug: input.slug,
      plan: "free",
    })
    .returning({ id: workspaces.id });

  const id = inserted[0].id as string;

  // Add owner as member
  await dbAdmin.insert(workspaceMembers).values({
    workspaceId: id,
    userId: input.owner_user_id,
    role: "owner",
  });

  return id;
}

export async function getWorkspace(id: string): Promise<Record<string, unknown> | null> {
  const rows = await dbAdmin
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getUserWorkspaces(userId: string): Promise<Record<string, unknown>[]> {
  const rows = await dbAdmin
    .select({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      plan: workspaces.plan,
      created_at: workspaces.createdAt,
      role: workspaceMembers.role,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      eq(workspaceMembers.workspaceId, workspaces.id),
    )
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt));
  return rows;
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: "admin" | "member",
): Promise<void> {
  await dbAdmin
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoUpdate({
      target: [workspaceMembers.workspaceId, workspaceMembers.userId],
      set: { role: sql`EXCLUDED.role` },
    });
}

export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string,
): Promise<void> {
  // Não remove owner (proteção contra remover acidentalmente o dono)
  await dbAdmin
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
        // role != 'owner' — Drizzle não tem helper, uso sql``
        sql`${workspaceMembers.role} != 'owner'`,
      ),
    );
}

// ── Meta Accounts ──

export async function addMetaAccount(input: AddMetaAccountInput): Promise<string> {
  let tokenEncrypted: string | null = null;
  let oauthTokens: string | null = null;

  if (input.auth_method === "token" && input.token) {
    tokenEncrypted = encryptToken(input.token);
  } else if (input.auth_method === "oauth" && input.oauth_tokens) {
    oauthTokens = encryptToken(JSON.stringify(input.oauth_tokens));
  }

  // Check if first account → make default
  const existing = await dbAdmin
    .select({ count: sql<number>`count(*)::int` })
    .from(workspaceMetaAccounts)
    .where(eq(workspaceMetaAccounts.workspaceId, input.workspace_id));
  const isDefault = Number(existing[0]?.count ?? 0) === 0;

  const inserted = await dbAdmin
    .insert(workspaceMetaAccounts)
    .values({
      workspaceId: input.workspace_id,
      label: input.label,
      metaAccountId: input.meta_account_id,
      authMethod: input.auth_method,
      tokenEncrypted,
      oauthTokens,
      pageId: input.page_id ?? null,
      pixelId: input.pixel_id ?? null,
      instagramUserId: input.instagram_user_id ?? null,
      isDefault,
    })
    .returning({ id: workspaceMetaAccounts.id });

  return inserted[0].id as string;
}

export async function getMetaAccounts(workspaceId: string): Promise<Record<string, unknown>[]> {
  const rows = await dbAdmin
    .select({
      id: workspaceMetaAccounts.id,
      workspace_id: workspaceMetaAccounts.workspaceId,
      label: workspaceMetaAccounts.label,
      meta_account_id: workspaceMetaAccounts.metaAccountId,
      auth_method: workspaceMetaAccounts.authMethod,
      page_id: workspaceMetaAccounts.pageId,
      pixel_id: workspaceMetaAccounts.pixelId,
      instagram_user_id: workspaceMetaAccounts.instagramUserId,
      is_default: workspaceMetaAccounts.isDefault,
      created_at: workspaceMetaAccounts.createdAt,
    })
    .from(workspaceMetaAccounts)
    .where(eq(workspaceMetaAccounts.workspaceId, workspaceId))
    .orderBy(desc(workspaceMetaAccounts.isDefault), asc(workspaceMetaAccounts.createdAt));
  return rows;
}

/**
 * Retorna o token Meta para uma conta do workspace.
 * Descriptografa do banco — nunca expõe em resposta de API.
 */
export async function getMetaToken(
  workspaceId: string,
  metaAccountId: string,
): Promise<string | null> {
  const rows = await dbAdmin
    .select({
      authMethod: workspaceMetaAccounts.authMethod,
      tokenEncrypted: workspaceMetaAccounts.tokenEncrypted,
      oauthTokens: workspaceMetaAccounts.oauthTokens,
    })
    .from(workspaceMetaAccounts)
    .where(
      and(
        eq(workspaceMetaAccounts.workspaceId, workspaceId),
        eq(workspaceMetaAccounts.metaAccountId, metaAccountId),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  if (row.authMethod === "token" && row.tokenEncrypted) {
    return decryptToken(row.tokenEncrypted as string);
  }

  if (row.authMethod === "oauth" && row.oauthTokens) {
    const tokens = JSON.parse(decryptToken(row.oauthTokens as string));
    return tokens.access_token || null;
  }

  return null;
}

/**
 * Retorna o token Meta do workspace. Sem fallback para env vars.
 * Cada workspace DEVE ter sua própria conta Meta configurada.
 */
export async function resolveMetaToken(
  workspaceId: string | null,
  metaAccountId?: string,
): Promise<string> {
  if (!workspaceId) {
    throw new Error("workspace_id is required — Meta tokens are per-workspace");
  }

  // If a specific account is requested, get its token
  if (metaAccountId) {
    const token = await getMetaToken(workspaceId, metaAccountId);
    if (token) return token;
    throw new Error(`No Meta token found for account ${metaAccountId} in this workspace. Configure it in workspace settings.`);
  }

  // No specific account — use the default account for this workspace
  const rows = await dbAdmin
    .select({
      metaAccountId: workspaceMetaAccounts.metaAccountId,
      authMethod: workspaceMetaAccounts.authMethod,
      tokenEncrypted: workspaceMetaAccounts.tokenEncrypted,
      oauthTokens: workspaceMetaAccounts.oauthTokens,
    })
    .from(workspaceMetaAccounts)
    .where(
      and(
        eq(workspaceMetaAccounts.workspaceId, workspaceId),
        eq(workspaceMetaAccounts.isDefault, true),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new Error("No Meta account configured for this workspace. Add one in workspace settings.");
  }

  const row = rows[0];
  if (row.authMethod === "token" && row.tokenEncrypted) {
    return decryptToken(row.tokenEncrypted as string);
  }
  if (row.authMethod === "oauth" && row.oauthTokens) {
    const tokens = JSON.parse(decryptToken(row.oauthTokens as string));
    return tokens.access_token || null;
  }

  throw new Error("Meta account found but has no valid token. Reconfigure it in workspace settings.");
}

// ── API Keys ──

export async function createApiKey(
  workspaceId: string,
  userId: string,
  name: string,
): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const prefix = key.substring(0, 10);

  const inserted = await dbAdmin
    .insert(apiKeys)
    .values({
      workspaceId,
      userId,
      name,
      keyHash,
      keyPrefix: prefix,
    })
    .returning({ id: apiKeys.id });

  return { id: inserted[0].id as string, key }; // key só é retornado uma vez
}

export async function listApiKeys(workspaceId: string): Promise<Record<string, unknown>[]> {
  const rows = await dbAdmin
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      key_prefix: apiKeys.keyPrefix,
      last_used_at: apiKeys.lastUsedAt,
      created_at: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.workspaceId, workspaceId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .orderBy(desc(apiKeys.createdAt));
  return rows;
}

export async function revokeApiKey(workspaceId: string, keyId: string): Promise<void> {
  await dbAdmin
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.workspaceId, workspaceId),
      ),
    );
}

// ── Workspace Settings ──

export async function getWorkspaceSetting(
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const rows = await dbAdmin
    .select({ value: workspaceSettings.value })
    .from(workspaceSettings)
    .where(
      and(
        eq(workspaceSettings.workspaceId, workspaceId),
        eq(workspaceSettings.key, key),
      ),
    )
    .limit(1);
  return rows.length > 0 ? (rows[0].value as string) : null;
}

export async function setWorkspaceSetting(
  workspaceId: string,
  key: string,
  value: string,
): Promise<void> {
  await dbAdmin
    .insert(workspaceSettings)
    .values({ workspaceId, key, value })
    .onConflictDoUpdate({
      target: [workspaceSettings.workspaceId, workspaceSettings.key],
      set: {
        value: sql`EXCLUDED.value`,
        updatedAt: sql`NOW()`,
      },
    });
}
