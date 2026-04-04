/**
 * Workspace — Operações de workspace e contas Meta vinculadas.
 *
 * Centraliza CRUD de workspaces, membros, contas Meta e API keys.
 */

import { getDb } from "./db";
import { generateApiKey, hashApiKey } from "./auth";
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
  const db = getDb();
  const id = crypto.randomUUID();

  await db.execute({
    sql: `INSERT INTO workspaces (id, name, slug, plan) VALUES (?, ?, ?, 'free')`,
    args: [id, input.name, input.slug],
  });

  // Add owner as member
  await db.execute({
    sql: `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
    args: [id, input.owner_user_id],
  });

  return id;
}

export async function getWorkspace(id: string): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT * FROM workspaces WHERE id = ?`,
    args: [id],
  });
  return result.rows[0] || null;
}

export async function getUserWorkspaces(userId: string): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT w.*, wm.role
          FROM workspaces w
          JOIN workspace_members wm ON wm.workspace_id = w.id
          WHERE wm.user_id = ?
          ORDER BY w.created_at ASC`,
    args: [userId],
  });
  return result.rows;
}

export async function addWorkspaceMember(
  workspaceId: string,
  userId: string,
  role: "admin" | "member"
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (?, ?, ?)
          ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    args: [workspaceId, userId, role],
  });
}

export async function removeWorkspaceMember(
  workspaceId: string,
  userId: string
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role != 'owner'`,
    args: [workspaceId, userId],
  });
}

// ── Meta Accounts ──

export async function addMetaAccount(input: AddMetaAccountInput): Promise<string> {
  const db = getDb();
  const id = crypto.randomUUID();

  let tokenEncrypted: string | null = null;
  let oauthTokens: string | null = null;

  if (input.auth_method === "token" && input.token) {
    tokenEncrypted = encryptToken(input.token);
  } else if (input.auth_method === "oauth" && input.oauth_tokens) {
    oauthTokens = encryptToken(JSON.stringify(input.oauth_tokens));
  }

  // Check if this is the first account (make default)
  const existing = await db.execute({
    sql: `SELECT COUNT(*) as count FROM workspace_meta_accounts WHERE workspace_id = ?`,
    args: [input.workspace_id],
  });
  const isDefault = (existing.rows[0].count as number) === 0;

  await db.execute({
    sql: `INSERT INTO workspace_meta_accounts
          (id, workspace_id, label, meta_account_id, auth_method, token_encrypted, oauth_tokens,
           page_id, pixel_id, instagram_user_id, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id, input.workspace_id, input.label, input.meta_account_id,
      input.auth_method, tokenEncrypted, oauthTokens,
      input.page_id || null, input.pixel_id || null,
      input.instagram_user_id || null, isDefault,
    ],
  });

  return id;
}

export async function getMetaAccounts(workspaceId: string): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id, workspace_id, label, meta_account_id, auth_method,
                 page_id, pixel_id, instagram_user_id, is_default, created_at
          FROM workspace_meta_accounts
          WHERE workspace_id = ?
          ORDER BY is_default DESC, created_at ASC`,
    args: [workspaceId],
  });
  return result.rows;
}

/**
 * Retorna o token Meta para uma conta do workspace.
 * Descriptografa do banco — nunca expõe em resposta de API.
 */
export async function getMetaToken(
  workspaceId: string,
  metaAccountId: string
): Promise<string | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT auth_method, token_encrypted, oauth_tokens
          FROM workspace_meta_accounts
          WHERE workspace_id = ? AND meta_account_id = ?`,
    args: [workspaceId, metaAccountId],
  });

  if (result.rows.length === 0) return null;
  const row = result.rows[0];

  if (row.auth_method === "token" && row.token_encrypted) {
    return decryptToken(row.token_encrypted as string);
  }

  if (row.auth_method === "oauth" && row.oauth_tokens) {
    const tokens = JSON.parse(decryptToken(row.oauth_tokens as string));
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
  metaAccountId?: string
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
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT meta_account_id, auth_method, token_encrypted, oauth_tokens
          FROM workspace_meta_accounts
          WHERE workspace_id = ? AND is_default = true`,
    args: [workspaceId],
  });

  if (result.rows.length === 0) {
    throw new Error("No Meta account configured for this workspace. Add one in workspace settings.");
  }

  const row = result.rows[0];
  if (row.auth_method === "token" && row.token_encrypted) {
    return decryptToken(row.token_encrypted as string);
  }
  if (row.auth_method === "oauth" && row.oauth_tokens) {
    const tokens = JSON.parse(decryptToken(row.oauth_tokens as string));
    return tokens.access_token || null;
  }

  throw new Error("Meta account found but has no valid token. Reconfigure it in workspace settings.");
}

// ── API Keys ──

export async function createApiKey(
  workspaceId: string,
  userId: string,
  name: string
): Promise<{ id: string; key: string }> {
  const db = getDb();
  const id = crypto.randomUUID();
  const key = generateApiKey();
  const keyHash = hashApiKey(key);
  const prefix = key.substring(0, 10);

  await db.execute({
    sql: `INSERT INTO api_keys (id, workspace_id, user_id, name, key_hash, key_prefix)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, workspaceId, userId, name, keyHash, prefix],
  });

  return { id, key }; // key is only returned once
}

export async function listApiKeys(workspaceId: string): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id, name, key_prefix, last_used_at, created_at
          FROM api_keys
          WHERE workspace_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
    args: [workspaceId],
  });
  return result.rows;
}

export async function revokeApiKey(workspaceId: string, keyId: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE api_keys SET revoked_at = NOW() WHERE id = ? AND workspace_id = ?`,
    args: [keyId, workspaceId],
  });
}

// ── Workspace Settings ──

export async function getWorkspaceSetting(
  workspaceId: string,
  key: string
): Promise<string | null> {
  const db = getDb();
  const result = await db.execute({
    sql: `SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?`,
    args: [workspaceId, key],
  });
  return result.rows.length > 0 ? (result.rows[0].value as string) : null;
}

export async function setWorkspaceSetting(
  workspaceId: string,
  key: string,
  value: string
): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO workspace_settings (workspace_id, key, value, updated_at)
          VALUES (?, ?, ?, NOW())
          ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    args: [workspaceId, key, value],
  });
}
