# Fase 2 — Supabase Auth (migração gradual)

Trocar auth custom (scrypt/bcrypt + `sessions` table) por Supabase gotrue.
Executado em 3 PRs sequenciais para minimizar risco.

## Estado atual (PR 2a — Foundation + dual-mode)

- ✅ `src/lib/supabase-auth.ts` — cliente gotrue server-side (fetch direto,
  sem dependência do `@supabase/supabase-js`). Inclui verificação HS256 local
  de JWT pra evitar round-trip em toda request.
- ✅ `public.users.auth_user_id` — coluna UUID nullable + UNIQUE. Liga
  profile local ao `auth.users.id` do gotrue (migration 0007).
- ✅ `authenticate()` em `src/lib/auth.ts` agora tenta 3 métodos em ordem:
  1. `sb-access-token` cookie → `verifySupabaseJwt` → lookup local
  2. `pegasus_session` cookie (legado) — continua valendo
  3. `x-api-key` header
- ✅ `scripts/phase-2-migrate-users-to-auth.ts` — cria users no gotrue +
  linka via `auth_user_id` + envia email de reset.

**Neste estado, quem acessa continua entrando via senha legada.** Nenhum
usuário tem `auth_user_id` populado ainda. O caminho Supabase só vai ficar
ativo após PR 2b.

## Env vars (criar no VPS antes do próximo deploy)

```bash
# URL interna do gotrue (mesma network docker)
SUPABASE_AUTH_URL=http://supabase-kong:8000/auth/v1

# Keys rotacionadas em 2026-04-18 (TD-006 resolvido)
SUPABASE_ANON_KEY=<do gerenciador de senhas do Leandro>
SUPABASE_SERVICE_ROLE_KEY=<do gerenciador de senhas do Leandro>
SUPABASE_JWT_SECRET=<do gerenciador de senhas do Leandro>
```

Notas:
- `SUPABASE_JWT_SECRET` é o mesmo valor em `GOTRUE_JWT_SECRET` do container
  gotrue. Usado pra verificação local (HS256).
- `SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` foram regeneradas pelo
  cowork CRM durante rotação. Pegar os valores do gerenciador.
- Não use `NEXT_PUBLIC_*` prefixo — esse módulo só roda server-side. Se no
  futuro precisar do supabase-js no client, aí sim adiciona
  `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## Próximos PRs

### PR 2b — Flip login

- `/api/auth/login` passa a chamar `signInWithPassword` (gotrue) em vez de
  scrypt local. Fallback pro caminho legado se o usuário ainda não tiver
  `auth_user_id` (usuário então roda script de migração manual).
- `/api/auth/register` passa a chamar `signUp` (gotrue).
- `/api/auth/me` e `/api/auth/logout` atualizados.
- Roda `scripts/phase-2-migrate-users-to-auth.ts` em prod (apenas Leandro
  por enquanto — ele recebe email de reset, define senha nova).
- Leandro testa login novo end-to-end.

### PR 2c — Cleanup

- Remove caminho legado em `authenticate()` (só aceita Supabase + API key).
- `DROP TABLE sessions` (migração).
- `DROP COLUMN password_hash FROM users` (migração).
- `auth_user_id` vira NOT NULL.
- Fecha TD-004.

## Rollback

Se PR 2b causar problemas, basta reverter o commit. O dual-mode em 2a
garante que sessões legadas continuam válidas — ninguém fica fora.

Se PR 2c revelar problemas, `sessions` table já foi removida — rollback
exige restore do backup. Por isso 2c só deve rodar após 2b estar 30 dias
estável.

## Riscos conhecidos

- **Emails de reset podem não chegar** se o SMTP do gotrue não estiver
  configurado. Pré-voo: testar `POST /recover` com email de teste antes de
  rodar o script de migração.
- **Bridge `users`/`sessions` do Neon (TD-004)**: continua ativa até 2c.
  Fase 2b não precisa mexer nela.
- **Cookies domain**: se o app for acessado via `pegasus.alpesd.com.br` e
  o cookie `sb-access-token` for setado sem `domain`, fica escopado pro
  subdomain exato. Ok pra agora.
- **JWT secret vaza em log**: `verifySupabaseJwt` não loga o segredo, mas
  cuidado em outros lugares. Nunca passar `SUPABASE_JWT_SECRET` pra
  `NEXT_PUBLIC_*`.
