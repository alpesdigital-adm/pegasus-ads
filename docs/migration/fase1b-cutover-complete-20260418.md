# Fase 1B CUTOVER FINALIZADO — 2026-04-18

## Sequência executada

1. `git pull` — commit `5667148` trouxe `05-bridge-users-sessions.sh`.
2. Script rodou, falhou na 1ª vez por diff de schema: Neon `users`
   tem 4 colunas extras (`account_id`, `role`, `is_active`,
   `last_login_at`) que o Drizzle schema do pegasus_ads omitiu.
3. `ALTER TABLE public.users ADD COLUMN IF NOT EXISTS (...)` aplicado
   como `supabase_admin`. Script atualizado para fazer isso no step 0
   (idempotente) — fix persistido.
4. Bridge re-rodado: **7 users + 24 sessions** (todas ativas)
   migrados. `orphan_members = 0`.
5. Teste end-to-end: peguei um token ativo, passei como cookie
   `pegasus_session` em `GET https://pegasus.alpesd.com.br/api/auth/me`.
   Resposta HTTP 200 com Leandro logado, 2 workspaces, role `owner`.
   Idêntico ao blue (Neon).

## Estado final

| host | container | DB | status |
|---|---|---|---|
| pegasus.alpesd.com.br | pegasus-ads-green | Supabase/pegasus_ads | PROD ✓ |
| pegasus-green.alpesd.com.br | pegasus-ads-green | Supabase/pegasus_ads | staging |
| pegasus-blue.alpesd.com.br | pegasus-ads | Neon | rollback 24-48h |

- `/api/cron/sync-all` funcionando (último teste: `upserted=168`,
  `errors=0`)
- Login via session cookie migrada: validado
- Bridge `users`/`sessions`: idempotente, documentada em TD-004

## Fixes consolidados nesta iteração

1. `.env` hostname sem sufixo `-1` → corrigido no .env (não commitado
   por ser secret).
2. `02-swap-to-green.sh` sem `traefik.docker.network=easypanel` →
   label adicionada.
3. `sync-all/route.ts` inserindo integer em coluna UUID → fix commit
   `af93c63` (route NULL + migration 0003 drop FK/NOT NULL).
4. Bridge script faltando `ALTER TABLE users ADD COLUMN` → fix neste
   commit.

## Próximos passos

- [ ] Monitor 24-48h (erros de auth, sync hourly, alertas do kill
      rules)
- [ ] `bash scripts/cutover/04-remove-blue.sh` quando confiante
- [ ] Fase 2: migrar `users` → `auth.users` (gotrue), resolver TD-006
      (JWT secret público) antes
- [ ] TD-002: configurar tenant Supavisor (ganho de pooling)

## Brain memórias

- #172 — 1º attempt (hostname + sync-all)
- #173 — swap inicial (traefik + auth P0)
- #174 — cutover finalizado
