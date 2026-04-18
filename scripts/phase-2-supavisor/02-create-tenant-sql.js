#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Phase 2 — Supavisor Pooling (TD-002)
 * 02-create-tenant-sql.js — fallback quando RPC + eval não disponíveis
 *
 * ⚠️ AVISO CRÍTICO (descoberto 2026-04-18):
 * Este script produz AES-GCM RAW (iv + ciphertext + authTag), mas
 * Supavisor moderno usa Cloak.Ciphers.AES.GCM com envelope próprio:
 *   <<version:1, tag_len:1, tag:N, iv:12, ciphertext+auth_tag:N>>
 *
 * Resultado: INSERT vai passar, mas quando Supavisor tentar DECRYPT a senha
 * no startup ou no dispatch, erro `cannot load ... as type
 * Supavisor.Encrypted.Binary`.
 *
 * CAMINHO CANONICO (funciona em todas versões):
 *   Usar `/app/bin/supavisor eval` (NÃO sofre do FQDN issue do `rpc`) pra
 *   chamar Cloak direto — encryption automática no formato certo:
 *
 *   docker exec alpes-ads_supabase-supavisor-1 /app/bin/supavisor eval '
 *     {:ok, ciphertext} = Supavisor.Vault.encrypt("password")
 *     IO.puts(Base.encode16(ciphertext))
 *   '
 *
 * Este script fica preservado pra emergência (ex: eval também quebrado) mas
 * PRECISA verificar round-trip contra Cloak antes de usar em prod.
 *
 * Uso (CUIDADO):
 *   VAULT_ENC_KEY=$(docker exec alpes-ads_supabase-supavisor-1 printenv VAULT_ENC_KEY) \
 *   DB_APP_PASSWORD='senha' \
 *   node 02-create-tenant-sql.js
 */

const crypto = require("crypto");

const VAULT_KEY = process.env.VAULT_ENC_KEY;
const DB_PASS = process.env.DB_APP_PASSWORD;

if (!VAULT_KEY) {
  console.error("VAULT_ENC_KEY env var ausente");
  console.error("Uso: VAULT_ENC_KEY=\\$(docker exec alpes-ads_supabase-supavisor-1 printenv VAULT_ENC_KEY) node $0");
  process.exit(1);
}
if (!DB_PASS) {
  console.error("DB_APP_PASSWORD env var ausente (senha do pegasus_ads_app)");
  process.exit(1);
}

// Supavisor usa AES-256-GCM com key derivada do VAULT_ENC_KEY.
// Formato no bytea: <iv(16)><ciphertext><authTag(16)>
// Referência: Supavisor.Vault module (Elixir)
const iv = crypto.randomBytes(16);

// VAULT_ENC_KEY no Supavisor é base64 de 32 bytes (256 bits)
let keyBuf;
try {
  keyBuf = Buffer.from(VAULT_KEY, "base64");
  if (keyBuf.length !== 32) {
    // Alguns deploys usam raw 32-byte hex ou raw string
    if (VAULT_KEY.length === 64 && /^[0-9a-f]+$/i.test(VAULT_KEY)) {
      keyBuf = Buffer.from(VAULT_KEY, "hex");
    } else if (VAULT_KEY.length >= 32) {
      keyBuf = Buffer.from(VAULT_KEY.slice(0, 32), "utf8");
    } else {
      throw new Error(`VAULT_ENC_KEY tem ${keyBuf.length} bytes (esperado 32)`);
    }
  }
} catch (err) {
  console.error("Falha a decodificar VAULT_ENC_KEY:", err.message);
  process.exit(1);
}

const cipher = crypto.createCipheriv("aes-256-gcm", keyBuf, iv);
const encrypted = Buffer.concat([cipher.update(DB_PASS, "utf8"), cipher.final()]);
const authTag = cipher.getAuthTag();

const encryptedFull = Buffer.concat([iv, encrypted, authTag]);
const hexEncoded = encryptedFull.toString("hex");

// Validação: decrypt de volta pra confirmar
try {
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuf, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  if (decrypted !== DB_PASS) throw new Error("decrypt não bateu");
  console.error("[validação] round-trip AES-GCM OK");
} catch (err) {
  console.error("[validação] FALHOU:", err.message);
  console.error("VAULT_ENC_KEY pode estar em formato incompatível — checa docs Supavisor desta versão");
  process.exit(2);
}

// SQL pronto pra rodar
console.log(`-- =============================================================
-- Tenant + user pegasus_ads para Supavisor (schema moderno v1.1x+)
-- Rode como: docker exec -i alpes-ads_supabase-db-1 \\
--             psql -U supabase_admin -d _supabase -v ON_ERROR_STOP=1
--
-- 3 ajustes aplicados após bate-cabeça na primeira execução (2026-04-18):
--  1. tenants.id e users.id são uuid NOT NULL SEM default → gen_random_uuid()
--  2. users.db_user_alias é NOT NULL (formato user.tenant da connection string)
--  3. UNIQUE em users é (db_user_alias, tenant_external_id, mode_type)
--  4. require_user=true evita exigir auth_query (opção mais simples quando
--     connection string usa formato user.alias)
-- =============================================================

BEGIN;

-- 1. Tenant
INSERT INTO _supavisor.tenants (
  id, external_id, db_host, db_port, db_database,
  default_pool_size, default_max_clients,
  ip_version, default_parameter_status, require_user,
  inserted_at, updated_at
) VALUES (
  gen_random_uuid(),
  'pegasus_ads', 'alpes-ads_supabase-db-1', 5432, 'pegasus_ads',
  15, 100,
  'auto', '{}'::jsonb, true,
  NOW(), NOW()
) ON CONFLICT (external_id) DO NOTHING;

-- 2. User com senha cifrada (AES-GCM)
--    require_user=true usa db_user_alias no formato user.tenant da conn string
INSERT INTO _supavisor.users (
  id, tenant_external_id, db_user, db_user_alias, db_pass_encrypted,
  pool_size, mode_type, is_manager,
  inserted_at, updated_at
) VALUES (
  gen_random_uuid(),
  'pegasus_ads',
  'pegasus_ads_app',
  'pegasus_ads_app',
  decode('${hexEncoded}', 'hex'),
  15, 'transaction', true,
  NOW(), NOW()
) ON CONFLICT (db_user_alias, tenant_external_id, mode_type) DO UPDATE SET
  db_pass_encrypted = EXCLUDED.db_pass_encrypted,
  pool_size = EXCLUDED.pool_size,
  updated_at = NOW();

COMMIT;

-- 3. Restart Supavisor pra recarregar cache (RPC reload_cache pode falhar
--    por noconnection em Erlang distribution — restart é mais confiável).
-- docker restart alpes-ads_supabase-supavisor-1
`);

console.error("\n[pronto] SQL acima emitido pro stdout. Redireciona pra rodar:");
console.error("  node 02-create-tenant-sql.js > /tmp/tenant.sql");
console.error("  docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d _supabase -v ON_ERROR_STOP=1 < /tmp/tenant.sql");
