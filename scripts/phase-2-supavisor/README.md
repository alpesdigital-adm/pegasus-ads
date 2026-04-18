# Phase 2 — Supavisor Pooling (TD-002)

Fecha o último débito de infra de base: pegasus-ads passa a conectar no
Postgres **via Supavisor** (pooler do Supabase) em vez de direto na porta
5432. Ganho principal: multiplexing de conexões — aguenta carga sem
explodir `max_connections`.

## Por que agora

Decisão do Leandro (2026-04-18): fundação direito antes do telhado. Nenhum
débito de infra pendurado antes de Fases 3-5 (design, observability,
storage).

## Decision tree

```
01-inspect.sh
  │
  ▼
02-create-tenant-eval.sh  ← CANONICO (funciona em todas versões)
  │                        usa `supavisor eval` pra Cloak encrypt + SQL
  │
  ▼ (se eval falhar, fallbacks não recomendados:)
  │   02-create-tenant-rpc.sh  ← falha com noconnection se hostname short
  │   02-create-tenant-sql.js  ← AES-GCM raw ≠ formato Cloak (auth_tag quebra)
  │
  ▼
03-smoke.sh  (crítico — valida SET LOCAL em transaction mode)
  │    PASS → 04-cutover.sh
  │    FAIL → revert (não fazer cutover)
  │
  └─ Monitor 1h, se OK fica, se quebrar: restore backup do .env
```

### Por que eval é o caminho canonico (aprendizado de 2026-04-18)

- **RPC** (`supavisor rpc`): depende de Erlang distribution + FQDN. Quebra
  em containers com hostname short (`noconnection` / `Hostname X is illegal`).
- **SQL + AES-GCM via Node** (`02-create-tenant-sql.js`): produz envelope
  RAW (iv + ciphertext + authTag). Cloak usa envelope próprio
  `<<version:1, tag_len:1, tag:N, iv:12, ciphertext+auth_tag:N>>`. Resulta
  em `cannot load ... as type Supavisor.Encrypted.Binary` quando o
  Supavisor tenta decifrar.
- **Eval** (`supavisor eval`): roda no BEAM do release sem dependência de
  distribution + encryption via Cloak nativo. Funciona em todas versões.

## O que cada script faz

- **`01-inspect.sh`** — descobre versão do Supavisor, schema de tenants
  (moderno vs legado), presença de env vars críticas (API_JWT_SECRET,
  VAULT_ENC_KEY, SECRET_KEY_BASE), se RPC tá disponível. Não muda nada.

- **`02-create-tenant-rpc.sh`** — usa `/app/bin/supavisor rpc` pra chamar
  `Supavisor.Tenants.create_tenant/1` direto no runtime Elixir.
  Encryption da senha é feita internamente.

- **`02-create-tenant-sql.js`** — fallback quando RPC não disponível.
  Cifra senha com AES-GCM usando `VAULT_ENC_KEY` (base64 ou hex) e
  emite SQL pronto pra `psql`.

- **`03-smoke.sh`** — valida conectividade + **crítico:** `SET LOCAL
  app.workspace_id` persiste dentro da transação (requisito do
  `withWorkspace()`). Se falhar aqui, RLS quebra em prod — não fazer
  cutover.

- **`04-cutover.sh`** — backup do `.env`, swap `DATABASE_URL`
  (6543 pooled) + `DATABASE_URL_ADMIN` (5432 direto — pra migrations).
  Rebuild green. Monitor 60s. Path de rollback documentado no output.

## Risco que o smoke cobre

`withWorkspace()` em `src/lib/db/index.ts` usa
`SELECT set_config('app.workspace_id', $1, true)` dentro de transação.
`true` = local-to-transaction. Em **transaction mode** do Supavisor, a
conexão Postgres é dedicada do BEGIN ao COMMIT — portanto `SET LOCAL`
DEVE persistir entre queries dentro do mesmo callback.

Teoria diz que funciona. Smoke valida na prática antes de swapear
prod.

## Pré-requisitos pra executar

1. TD-006 (gotrue) já resolvido ✓
2. Fase 2 (PRs 2a/2b/2c) deployada ✓
3. Senha do `pegasus_ads_app` + `pegasus_ads_admin` em mãos (env vars)
4. Janela de 15-30min pra cutover + monitor

## Rotação de segredos (condicional)

Se `01-inspect.sh` detectar valores demo em `API_JWT_SECRET` /
`SECRET_KEY_BASE` / `VAULT_ENC_KEY`:

- Rotação precisa coordenar com CRM (segredos são cluster-wide, mesmo
  que CRM não use Supavisor hoje — o valor muda pros dois)
- Se rotacionar: qualquer tenant pré-existente fica com encryption
  inválida → recriar todos. Hoje não tem tenants reais, então é seguro
- TODO: adicionar `02-rotate-supavisor-secrets.sh` no mesmo pattern
  do `scripts/td-006-*`

Leandro pode autorizar "rotacionar junto" ou "só criar tenant com o
demo key". Pooling funciona ambos — diferença é segurança dos segredos
administrativos do Supavisor.

## Rollback

Trivial: restaurar backup do `.env` (gerado automático em
`04-cutover.sh`) e rebuildar green. DB não muda — só o DATABASE_URL.

```bash
cp /apps/pegasus/.env.pre-supavisor-YYYYMMDD-HHMMSS /apps/pegasus/.env
bash scripts/cutover/01-deploy-green.sh
```
