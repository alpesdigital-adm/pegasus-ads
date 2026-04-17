# HANDOFF — Fase 0 (Pegasus Ads migration)

**Para:** Claude Code rodando dentro da VPS (srv1512423.hstgr.cloud)
**De:** Claude Code remoto (sandbox sem acesso SSH/Docker à VPS)
**Branch:** `claude/review-pegasus-migration-plan-Gg25C`
**Data:** 2026-04-17

---

## Por que existe este handoff

O Claude remoto montou tudo que podia do lado do repo (deps, `drizzle.config.ts`,
`.env.example`, script idempotente de setup). Mas o sandbox remoto não tem
outbound TCP para `187.77.245.144` — não dá para tocar Docker/psql diretamente.

Você (gêmeo na VPS) tem acesso local ao Docker e ao cluster `alpes-ads_supabase`.
Termina a Fase 0 executando o script e deixa a base pronta para a Fase 1.

---

## Contexto que você precisa antes de tocar em qualquer coisa

### Plano de migração
Documento fonte da verdade: [`docs/plano-migracao-pegasus-ads.md`](../plano-migracao-pegasus-ads.md)
v1.3 — seção **14. Fases de Execução**, bloco **FASE 0 — Preparação**.

### Stack atual (Brain — infra-vps / pegasus-crm)

- **VPS:** Hostinger, Ubuntu 24.04, Docker 29.3.0 Swarm, 16 GB RAM
- **Supabase container:** `alpes-ads_supabase-db-1` (Postgres **15.8.1.085** —
  não 16 como o plano assumia; `gen_random_uuid()` já é core em 13+, então OK)
- **Network:** `alpes-ads_supabase_default`
- **Database CRM já existente:** `pegasus_crm` com role `pegasus_app`
  (memória Brain #149) — NÃO MEXER
- **Postgres local do Brain:** database `claude_memory`, porta 5432 (só
  socket local) — NÃO é o cluster do Supabase, não confundir
- **Pegasus-ads path VPS:** `/apps/pegasus`
- **Deploy:** `cd /apps/pegasus && git pull origin main && docker build -t pegasus-ads:latest . && bash deploy.sh`
- **Gotcha 1:** `.env` no VPS NÃO pode ter aspas (Docker env-file não remove)
- **Gotcha 2:** Pegasus-ads container hoje está na network `easypanel`, não em
  `alpes-ads_supabase_default` — precisará de `docker network connect` na Fase 1
  para resolver o hostname `alpes-ads_supabase-db`
- **Gotcha 3:** O gotrue do cluster está com JWT secret demo público (TD-001 no
  CRM) — não é problema da Fase 0, mas vira bloqueador antes de prod com
  dados reais

### Credenciais (Brain — infra-vps, memória #59)

- SSH VPS: `root / h4xBdUTQgB,UHKq` em `srv1512423.hstgr.cloud:22`
- Neon atual (DATABASE_URL do pegasus-ads hoje):
  `postgresql://neondb_owner:npg_gNJKU2s6qwQO@ep-small-wildflower-ac7jqlwl-pooler.sa-east-1.aws.neon.tech/neondb?sslmode=require`
- Brain API: `https://brain.alpesd.com.br` com `Bearer brain-api-2026-secure-token`

---

## O que JÁ está feito (não refazer)

Commits no branch `claude/review-pegasus-migration-plan-Gg25C`:

- [x] `drizzle-orm ^0.45` + `postgres ^3.4` em `dependencies`
- [x] `drizzle-kit ^0.31` em `devDependencies`
- [x] `drizzle.config.ts` na raiz — aponta para `./src/lib/db/schema/*`,
      usa `DATABASE_URL_ADMIN` (ou `DATABASE_URL` fallback)
- [x] `.env.example` documentando todas as vars (atuais + novas Supabase)
- [x] `scripts/phase-0-vps-setup.sh` — script idempotente para rodar na VPS
- [x] Este handoff

NÃO foi feito ainda — responsabilidade sua:

- [ ] Executar `scripts/phase-0-vps-setup.sh` na VPS
- [ ] Atualizar `/apps/pegasus/.env` no VPS com as novas connection strings
- [ ] Testar conexão com o novo database
- [ ] Salvar senhas geradas no Brain (projeto `infra-vps`)
- [ ] (Opcional Fase 0) Avaliar adicionar pooler ao stack — Supavisor ou
      PgBouncer. Se não existir pooler, Fase 1 pode usar pool do `postgres-js`
      (parâmetro `max`) direto na conexão — funciona, só perde o multiplexing
      de conexões que um PgBouncer transaction-mode daria

---

## Execução passo a passo (copiar e colar)

### 1. Puxar o branch no VPS

```bash
cd /apps/pegasus
git fetch origin
git checkout claude/review-pegasus-migration-plan-Gg25C
git pull origin claude/review-pegasus-migration-plan-Gg25C
```

### 2. Inspecionar o script antes de rodar (confira você mesmo)

```bash
less scripts/phase-0-vps-setup.sh
```

Pontos que você deve validar:
- O container `alpes-ads_supabase-db-1` está rodando? (`docker ps | grep supabase`)
- O superuser é `supabase_admin` ou `postgres`? (script detecta automaticamente)
- Tem algum pooler? (script detecta e informa)

### 3. Rodar o script

```bash
cd /apps/pegasus
bash scripts/phase-0-vps-setup.sh
```

Output esperado (feliz): diagnóstico do cluster, criação de DB + 2 roles, e no
final um snippet `.env` com as duas senhas geradas.

**Copie as duas senhas imediatamente.** Se perder, tem que resetar a role.

### 4. Atualizar o .env do pegasus-ads

```bash
# Edite /apps/pegasus/.env e adicione as linhas DATABASE_URL e
# DATABASE_URL_ADMIN que o script imprimiu. NÃO remova o DATABASE_URL antigo
# do Neon ainda — só adicione as novas. O switch acontece na Fase 1.

# Sugestão: renomear o Neon atual para DATABASE_URL_NEON antes de adicionar as
# novas, para evitar conflito e manter referência.
```

Exemplo de estado final esperado do `.env`:

```
DATABASE_URL_NEON=postgresql://neondb_owner:...@...neon.tech/neondb?sslmode=require
DATABASE_URL=postgres://pegasus_ads_app:<GERADA>@alpes-ads_supabase-db:5432/pegasus_ads?sslmode=disable
DATABASE_URL_ADMIN=postgres://pegasus_ads_admin:<GERADA>@alpes-ads_supabase-db:5432/pegasus_ads?sslmode=disable
```

IMPORTANTE: durante a Fase 0 o app em produção continua no Neon. Só mude o
`DATABASE_URL` para Supabase depois que a Fase 1 (ORM + dump/restore) estiver
validada.

### 5. Teste de conexão (rápido)

Como o container `pegasus-ads` ainda está em outra network, faça o teste de
dentro do próprio container Supabase:

```bash
# Como pegasus_ads_admin (deve conectar OK)
docker exec -it alpes-ads_supabase-db-1 \
  psql "postgres://pegasus_ads_admin:<SENHA_ADMIN>@localhost:5432/pegasus_ads" \
  -c "SELECT current_user, current_database(), version();"

# Como pegasus_ads_app (deve conectar OK, sem DDL)
docker exec -it alpes-ads_supabase-db-1 \
  psql "postgres://pegasus_ads_app:<SENHA_APP>@localhost:5432/pegasus_ads" \
  -c "SELECT current_user; CREATE TABLE x(); -- deve falhar: permission denied"
```

A segunda query (CREATE TABLE) deve falhar — é o fail-safe de `pegasus_ads_app`
não ter DDL. Se passou, está errado.

### 6. Salvar senhas no Brain

```bash
curl -X POST https://brain.alpesd.com.br/memories \
  -H "Authorization: Bearer brain-api-2026-secure-token" \
  -H "Content-Type: application/json" \
  -d '{
    "project": "infra-vps",
    "thread": "credentials",
    "kind": "fact",
    "title": "Pegasus Ads — database pegasus_ads (Fase 0, Supabase self-hosted)",
    "content": "Database: pegasus_ads no container alpes-ads_supabase-db-1 (Postgres 15.8). Criado em 2026-04-17 na Fase 0 da migração.\n\nRole app (RLS enforced):\nUser: pegasus_ads_app\nPassword: <COLAR_AQUI>\nConn: postgres://pegasus_ads_app:<senha>@alpes-ads_supabase-db:5432/pegasus_ads?sslmode=disable\n\nRole admin (BYPASSRLS — migrations, crons, system ops):\nUser: pegasus_ads_admin\nPassword: <COLAR_AQUI>\nConn: postgres://pegasus_ads_admin:<senha>@alpes-ads_supabase-db:5432/pegasus_ads?sslmode=disable\n\nNetwork: alpes-ads_supabase_default (o container pegasus-ads precisa ser conectado a essa network na Fase 1 para resolver o hostname).\n\nPooler: <PREENCHER — nome do container detectado ou \"nenhum\">.",
    "tags": ["pegasus-ads", "supabase", "migration", "fase-0", "credentials"]
  }'
```

Troque os `<COLAR_AQUI>` pelas senhas de verdade antes de enviar.

### 7. Commit + push do estado do .env.example (se houver ajuste)

Se você notar algo no script que precisa ajustar (ex: pooler foi encontrado e
o bloco de comentário merece atualização), faça o ajuste e commit:

```bash
cd /apps/pegasus
git add -A
git commit -m "chore(fase-0): ajustes após validação na VPS"
git push origin claude/review-pegasus-migration-plan-Gg25C
```

---

## Validação Fase 0 completa (checklist)

- [ ] `docker exec alpes-ads_supabase-db-1 psql -U <super> -d postgres -c "\l"`
      lista `pegasus_ads`
- [ ] Roles `pegasus_ads_app` e `pegasus_ads_admin` existem (`\du` no psql)
- [ ] Admin consegue criar tabela; app NÃO consegue (fail-safe OK)
- [ ] Senhas salvas no Brain (memória em `infra-vps / credentials`)
- [ ] `.env` do `/apps/pegasus` contém DATABASE_URL + DATABASE_URL_ADMIN **sem
      aspas**
- [ ] Aplicação em produção continua funcionando (Neon ainda ativo — nenhum
      switch de env foi feito)

---

## Rollback (se algo der errado)

Como Fase 0 é aditiva, rollback é trivial:

```bash
docker exec -i alpes-ads_supabase-db-1 psql -U <super> -d postgres <<SQL
REVOKE ALL PRIVILEGES ON DATABASE pegasus_ads FROM pegasus_ads_app, pegasus_ads_admin;
DROP DATABASE IF EXISTS pegasus_ads;
DROP ROLE IF EXISTS pegasus_ads_app;
DROP ROLE IF EXISTS pegasus_ads_admin;
SQL
```

O app em produção nem percebe — está no Neon ainda.

---

## Depois da Fase 0

Fase 1 (ORM + UUID + RLS) — 3-5 dias. Começa criando os schemas Drizzle em
`src/lib/db/schema/*` conforme seção 3.1 do plano, depois `pg_dump` do Neon,
script de conversão TEXT→UUID (UUIDv5), `pg_restore` no `pegasus_ads`,
e migração gradual das 84 rotas API para Drizzle + `withWorkspace()`.

Antes de começar a Fase 1, confirmar com o Leandro:
1. Data do pg_dump (snapshot) — afeta janela de downtime
2. Se vai adicionar pooler (Supavisor) ao stack ou usar pool do driver
3. Se a network do container pegasus-ads será alterada na mesma janela

---

## Perguntas rápidas para você (gêmeo VPS)

Se qualquer um destes estiver errado, **PARA** e pergunta ao Leandro:

1. O container `alpes-ads_supabase-db-1` é mesmo o cluster certo? (há apenas
   um Supabase rodando na VPS — Brain #129 e #149 confirmam)
2. O database `pegasus_crm` existente deve permanecer intocado? (sim — é do
   CRM, em desenvolvimento)
3. Posso criar um database novo sem avisar? (sim, é Fase 0 explicitamente
   autorizada pelo Leandro)

Se tudo OK: prossiga.
