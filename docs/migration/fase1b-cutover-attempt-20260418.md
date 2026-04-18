# Cutover — 2026-04-18 00:15-00:23 UTC (EXECUTADO, REVISÃO NECESSÁRIA)

**Gêmeo:** Claude na VPS (srv1512423)
**Estado:** swap ativo; **login quebrado** aguardando decisão do Leandro.

## Sequência executada

1. `git pull` — trouxe `af93c63` (migration 0003 + route sync-all NULL).
2. Migration `0003_0003_relax_classified_fks.sql` aplicada no
   `pegasus_ads` — FKs `classified_insights_{insight,account}_id_*_fk`
   dropadas, `insight_id` agora nullable. Registrado em
   `drizzle.__drizzle_migrations` com sha256 real
   (`e92b3f71ddcf48c99089675269d025fc16e230007d121498c2a0c1fa7490c5bc`).
3. `docker build -t pegasus-ads:green .` (25s, cache).
4. `01-deploy-green.sh` — recriou green com `.env` atualizado.
5. `/api/cron/sync-all` via green — `upserted=168`, `errors=[]`,
   `kills_triggered=88`, `alerts_created=35`. Fix do commit af93c63
   validado.
6. `02-swap-to-green.sh` — swap executado.

## Problema #1 — traefik 504 pós-swap (RESOLVIDO manualmente)

O `02-swap-to-green.sh` não tem `traefik.docker.network=easypanel` que
o `01-deploy-green.sh` ganhou no commit `77abcc6`. Com o green em duas
networks (`easypanel` + `alpes-ads_supabase_default`), Traefik ficou
ambíguo e devolveu 504 em `pegasus.alpesd.com.br` e
`pegasus-green.alpesd.com.br`. Blue continuou respondendo porque só
está na `easypanel`.

**Fix aplicado:** recriei green manualmente com o label. Os três
hosts voltaram a responder 401. **Script 02 também atualizado neste
commit** para incluir o label (linha 92).

## Problema #2 — login QUEBRADO (P0, NÃO RESOLVIDO)

`src/app/api/auth/login/route.ts` usa `initDb()` (client único,
`DATABASE_URL`) e faz `SELECT FROM users WHERE email = ?`.

- Neon (blue): 7 users
- `pegasus_ads` (green): 0 users — Fase 1B excluiu `users`/`sessions`
  porque a migração para `auth.users` é Fase 2

Pós-swap, `pegasus.alpesd.com.br`:
- ninguém consegue login novo (fake login já retornava
  `INVALID_CREDENTIALS` antes; agora TODAS as credenciais retornam
  isso, válidas ou não)
- sessions table vazia → cookies existentes viram 401 na próxima
  request

O HANDOFF-fase-1b.md seção "Validação pós-cutover" lista
"Login funciona (continua usando Neon `users` por enquanto)", mas
**não existe** dual-client/Neon-fallback no código. Era uma
expectativa incorreta.

## Opções para Leandro

**A. Rollback agora.**
```bash
bash scripts/cutover/03-rollback-to-blue.sh
```
~10 segundos. Produção volta a `blue/Neon`. Login reabre.

**B. Migrar `users` + `sessions` Neon → `pegasus_ads` como ponte.**
~5 min. Os PKs já são UUID no Neon, então é `pg_dump --data-only` +
restore direto (sem UUIDv5). Depois `GRANT` pro `pegasus_ads_app`.
Login volta. Fase 2 depois migra para `auth.users` e dropa essas
tabelas. Leandro aprovou TD-004 ("DROP TABLE users, sessions após 30
dias da Fase 2") — consistente.

**C. Continuar em `pegasus-blue.alpesd.com.br`** enquanto decide.
`pegasus.alpesd.com.br` fica "meio morto" (só endpoints sem auth).

## Estado atual

| host | container | DB | login |
|---|---|---|---|
| pegasus.alpesd.com.br | pegasus-ads-green | Supabase/pegasus_ads | ❌ |
| pegasus-green.alpesd.com.br | pegasus-ads-green | Supabase/pegasus_ads | ❌ |
| pegasus-blue.alpesd.com.br | pegasus-ads | Neon | ✅ |

## Brain memórias

- #172 — incidente do primeiro attempt (hostname + sync-all bugs)
- #173 — este incidente (traefik fix + auth P0)
