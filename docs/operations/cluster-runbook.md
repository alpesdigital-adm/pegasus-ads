# Cluster Operations Runbook

Runbook operacional do cluster Supabase self-hosted (`alpes-ads_supabase_*`)
que serve pegasus-ads e pegasus-crm.

**Última atualização:** 2026-04-18

## Índice

- [Arquitetura do cluster](#arquitetura-do-cluster)
- [Credenciais e rotação](#credenciais-e-rotação)
- [Operações comuns](#operações-comuns)
- [Gotchas conhecidas](#gotchas-conhecidas)
- [Incidents históricos](#incidents-históricos)

---

## Arquitetura do cluster

```
Container                             Rede docker         Função
─────────────────────────────────────────────────────────────────
alpes-ads_supabase-db-1             internal             Postgres 17 (cluster-wide)
alpes-ads_supabase-kong-1           traefik + internal   Gateway + Auth proxy
alpes-ads_supabase-auth-1           internal             gotrue (auth.users compartilhado)
alpes-ads_supabase-supavisor-1      internal + :6543     Connection pooler (tenant-aware)
alpes-ads_supabase-realtime-1       internal             Realtime subscriptions
alpes-ads_supabase-studio-1         traefik              Admin UI
alpes-ads_supabase-storage-1        internal             File storage (não usado hoje)
alpes-ads_supabase-vector-1         internal             Log aggregation
```

### Databases

| Database | Propósito | Apps que acessam |
|---|---|---|
| `postgres` | DB padrão, poucos usos | Ferramentas admin |
| `_supabase` | Metadata do Supavisor (schema `_supavisor.*`) | Supavisor |
| `pegasus_ads` | App data pegasus-ads | pegasus-ads-green |
| `pegasus_crm` | App data pegasus-crm | pegasus-crm |

### Roles principais

| Role | SUPER | Uso |
|---|---|---|
| `postgres` | ✅ | Admin máximo, não usado por apps |
| `supabase_admin` | ✅ | Admin compartilhado do cluster |
| `pegasus_ads_admin` | ❌ (BYPASSRLS) | Migrations pegasus-ads |
| `pegasus_ads_app` | ❌ | App pegasus-ads via pool (RLS enforced) |
| `supavisor_meta` | ❌ | Supavisor acessa próprio metadata (TD-014) |

---

## Credenciais e rotação

### Política atual

| Credencial | Frequência | Gatilho | Local |
|---|---|---|---|
| `GOTRUE_JWT_SECRET` + anon/service_role keys | Anual OU incidente | TD-006 rotacionou | Gerenciador de senhas do Leandro |
| `pegasus_ads_app` password | Anual OU incidente | - | `/root/.pegasus-ads-app-password` |
| `pegasus_ads_admin` password | Anual OU incidente | - | `/root/.pegasus-ads-admin-password` |
| `supavisor_meta` password | **180 dias OU mudança SSH access VPS** | 2026-04-18 (TD-014) | `/root/.supavisor-meta-password` |
| `supabase_admin` password | Anual OU incidente | - | Gerenciador de senhas |

### Triggers obrigatórios pra rotacionar

Rotacionar TODAS as credenciais acima quando:

- 🚨 **Mudança de acesso SSH ao VPS** (nova pessoa com acesso root, ou saída de pessoa que tinha)
- 🚨 **Suspeita de comprometimento** (log de auth suspeito, vazamento em commit, etc)
- 🚨 **Após qualquer `docker cp` de arquivo `.env`** pra fora do VPS
- 📅 **Janela anual** de hardening (planejada)

**Motivação da trigger de SSH:** quem tem root no VPS pode `cat /root/.*-password` e ler tudo. Rotacionar fecha a janela de exposição histórica.

### Runbook de rotação — `supavisor_meta`

```bash
# 1. Gera senha nova
NEW_PASS="supavisor_meta_$(openssl rand -hex 16)"

# 2. ALTER role
docker exec -i alpes-ads_supabase-db-1 psql -U supabase_admin -d postgres \
  -c "ALTER ROLE supavisor_meta WITH PASSWORD '$NEW_PASS';"

# 3. Atualiza .env do compose do Supabase (path depende do easypanel)
# Edita DATABASE_URL do serviço supavisor substituindo user:pass
# (mantém o resto da URL)

# 4. Salva nova senha
echo "$NEW_PASS" > /root/.supavisor-meta-password
chmod 600 /root/.supavisor-meta-password

# 5. Recreate
docker compose -p alpes-ads_supabase up -d supavisor --force-recreate

# 6. Smoke — ver scripts/td-014-supavisor-dburl/01-inspect.sh
```

---

## Operações comuns

### Recreate de serviços Supabase via easypanel

⚠️ **Gotcha descoberta no TD-014 (2026-04-18):**

Executar `docker compose -p alpes-ads_supabase up -d <serviço> --force-recreate`
pode **recriar outros serviços** por conta de env vars interpoladas
cross-service no `docker-compose.override.yml` gerado pelo easypanel.

Exemplo real: recreate do `supavisor` recriou também `db + vector +
realtime`. Downtime real ~10s, cluster voltou healthy.

**Mitigação ao planejar mudanças:**
- Trate qualquer edit de env do stack Supabase como janela de manutenção
- Faça em horário de baixo tráfego (CRM + pegasus-ads ambos idle)
- Backup do `.env` e `docker-compose.override.yml` antes (`cp <file>.pre-<task>-<timestamp>`)
- Smoke imediato pós-recreate:
  - `docker ps | grep alpes-ads_supabase` — todos os containers healthy
  - `curl -si https://pegasus.alpesd.com.br/api/docs` — 200
  - `curl -si https://crm.alpesd.com.br/api/...` — CRM smoke do lado deles
- Rollback em < 30s restaurando arquivos + force-recreate

### Adicionar tenant novo ao Supavisor

Ver `scripts/phase-2-supavisor/02-create-tenant-eval.sh` (TD-002).
Usa `eval` (não `rpc`) pra evitar issue de FQDN do Erlang.

### Rotacionar credenciais gotrue (anon/service_role + JWT secret)

Ver `scripts/td-006-*` + doc `docs/migration/td-006-gotrue-rotation-plan.md`.
Coordenar com time CRM — impacta ambos apps.

---

## Gotchas conhecidas

### 1. Docker compose recreate cascade

Ver "Recreate de serviços Supabase via easypanel" acima.

### 2. Supavisor RPC vs eval

`docker exec supavisor /app/bin/supavisor rpc ...` falha com
`noconnection` / `Hostname X is illegal` em builds com
`RELEASE_DISTRIBUTION=name` + hostname short. Use `eval` em vez.

Documentado em `scripts/phase-2-supavisor/02-create-tenant-eval.sh`.

### 3. Supavisor encryption é Cloak, não AES-GCM raw

Cloak.Ciphers.AES.GCM usa envelope próprio
`<<version:1, tag_len:1, tag:N, iv:12, ct+auth_tag:N>>`.
Gerar encryption via Node crypto.createCipheriv produz formato RAW
incompatível — Supavisor quebra com `cannot load as type
Supavisor.Encrypted.Binary`. Use `Supavisor.Vault.encrypt/1` via eval.

### 4. gotrue `/admin/users?email=` ignora o filtro

Retorna todos os users paginados. Filter client-side por email exato
(case-insensitive). Documentado em `src/lib/supabase-auth.ts` e bug
fix commit `77417ef`.

### 5. `SET LOCAL` não aceita bind params

Postgres rejeita `SET LOCAL app.workspace_id = $1` com 42601.
Use `SELECT set_config('app.workspace_id', $1::text, true)` — é
equivalente + aceita parâmetros.

### 6. GOTRUE SMTP não configurado no cluster

`POST /recover` não dispara email real. Para reset de senha, use
`adminUpdateUser` com nova senha explícita em vez de reset link.

---

## Monitoring

### Healthcheck do pool Supavisor

Cron diário (`/api/cron/sync-all` às 13:00 UTC) valida implicitamente
que o pool funciona — se a role `supavisor_meta` quebrar, o upsert de
`classified_insights` falha e gera alerta.

**Adicional** (TD-014 follow-up): `/api/health` expõe check explícito
de pool + tenants visíveis — vale hit externo via uptime monitor.

Ver `src/app/api/health/route.ts`.

### Log aggregation

`vector` container agrega logs Docker pra file. Pra investigar:

```bash
docker logs alpes-ads_supabase-vector-1 --tail 100
# ou
docker exec alpes-ads_supabase-vector-1 tail -f /var/log/vector/combined.log
```

---

## Incidents históricos

### 2026-04-18 — Cutover Neon → Supabase + Fase 2 Auth + TD-002 Supavisor

Dia de grandes mudanças — plano de migração v1.4 executado completo.
Trilha consolidada em memórias Brain #166..#192 + commits na branch
`claude/review-pegasus-migration-plan-Gg25C`.

### 2026-04-18 — TD-014 isolation

Supavisor passou a usar role dedicada `supavisor_meta` em vez de
`supabase_admin`. Efeito colateral: compose recriou db+vector+realtime
junto (~10s downtime). Documentado aqui como gotcha #1.

### 2026-04-18 — Bug SET LOCAL

Latente desde 4978fde (Fase 1A). Quebrou 39 rotas workspace-scoped no
primeiro rebuild pós-Fase 1C. Fix em commit `5abfdea`. Gotcha #5.

### 2026-04-18 — Bug adminGetUserByEmail

Ligou Leandro a user do CRM (`leandro@pegasus-crm.test`). Fix
em commit `77417ef`. Gotcha #4.

---

## Links

- `docs/tech-debt.md` — estado atual dos débitos técnicos
- `docs/plano-migracao-pegasus-ads.md` — plano macro da migração
- `docs/observability.md` — setup Pino + Prometheus + Grafana
- `docs/staging-queue-v2.md` — spec do próximo marco de engenharia
- `scripts/phase-2-supavisor/` — scripts de setup pooling
- `scripts/td-006-*` — rotação JWT gotrue
- `scripts/td-014-supavisor-dburl/` — isolation do metadata DB
