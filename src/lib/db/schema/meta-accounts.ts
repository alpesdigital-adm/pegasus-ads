import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  unique,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";

// ─── workspace_meta_accounts ─────────────────────────────────────────────
// Contas da Meta Ads vinculadas a um workspace (pode ter múltiplas).
// RLS-enabled via workspace_id.
export const workspaceMetaAccounts = pgTable(
  "workspace_meta_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    // IDs externos (Meta) — TEXT, não UUID
    metaAccountId: text("meta_account_id").notNull(),
    authMethod: text("auth_method").notNull(), // 'token' | 'oauth' (CHECK aplicado via migration SQL)
    tokenEncrypted: text("token_encrypted"), // AES-256-GCM
    oauthTokens: text("oauth_tokens"),
    pageId: text("page_id"),
    pixelId: text("pixel_id"),
    instagramUserId: text("instagram_user_id"),
    isDefault: boolean("is_default").default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("uq_meta_accounts_ws_meta").on(t.workspaceId, t.metaAccountId)],
);
