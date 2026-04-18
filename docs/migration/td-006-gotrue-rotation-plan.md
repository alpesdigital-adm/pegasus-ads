# TD-006 — Rotação do gotrue JWT secret (plano, não executar)

**Criado:** 2026-04-18 (Track D do gêmeo VPS, pré-Fase 2)
**Status:** PLANO — aguardando coordenação com Leandro + time CRM
**Bloqueador P0 de:** Fase 2 (Pegasus Ads adotar Supabase Auth) +
TD-002 (Supavisor tenant, usa `API_JWT_SECRET`)

## O problema

Cluster `alpes-ads_supabase` roda com `JWT_SECRET` = valor demo
público do tutorial Supabase self-hosted:

```
your-super-secret-jwt-token-with-at-least-32-characters-long
```

Fonte única em
`/etc/easypanel/projects/alpes-ads/supabase/code/supabase/code/.env`
(var `JWT_SECRET`). Docker-compose propaga para:

| container | env var | uso |
|---|---|---|
| auth (gotrue) | `GOTRUE_JWT_SECRET` | assina/verifica user JWT |
| rest (postgrest) | `PGRST_JWT_SECRET` | valida JWT em requests |
| storage | `AUTH_JWT_SECRET` | idem |
| realtime | `JWT_SECRET` | autentica websocket |
| functions | `JWT_SECRET` | edge functions |
| supavisor | `API_JWT_SECRET` + `METRICS_JWT_SECRET` | admin API + metrics |
| kong (gateway) | `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_KEY` | JWTs assinados pelo secret |

`ANON_KEY` e `SERVICE_ROLE_KEY` são JWT gerados com esse secret
(payload `{"iss": "supabase-demo", ...}` — confirmado demo). Rotar o
secret invalida os dois — precisam ser regerados.

## Quem consome hoje

### pegasus-crm (ativo)

Env do container:
- `NEXT_PUBLIC_SUPABASE_URL` (roda no browser)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (frontend supabase-js)
- `SUPABASE_SERVICE_ROLE_KEY` (backend admin)

Sessões ativas do CRM = JWT assinados pelo secret atual. Rotação
**derruba todos os usuários logados do CRM** e obriga relogar.

### pegasus-ads (hoje NÃO consome)

Não tem nenhuma env `SUPABASE_*`. Auth ainda via tabela `users`/
`sessions` própria (bridge da Fase 1B). Fase 2 é onde passa a
depender — então hoje **rotação não afeta Ads**.

### Usuários de cliente supabase-js próprios

Ferramentas externas (Studio, scripts ad-hoc) podem ter ANON_KEY
hardcoded. Grep no cluster:

```bash
grep -rI 'your-super-secret-jwt-token' /apps/ /etc/easypanel/ 2>/dev/null
```

## Secrets a rotacionar (escopo de TD-006)

Na `.env` do compose:

1. `JWT_SECRET` — base de tudo; gerar 64 hex aleatórios
   (`openssl rand -hex 32`)
2. `ANON_KEY` — JWT novo com role=anon, iss=alpes-ads, exp futuro
3. `SERVICE_ROLE_KEY` — JWT novo com role=service_role
4. Opcional no mesmo PR:
   - `SECRET_KEY_BASE` (Supavisor Erlang/Elixir) — hoje NÃO é demo
     (`UpNVntn3...`), mas aproveitar pra fortalecer
   - `LOGFLARE_*` tokens — não bloqueador, baixo risco mas demo

**Fora de escopo** de TD-006 (tratar separado):
- `POSTGRES_PASSWORD` (demo, precisa rotação mas é outro caminho:
  `ALTER USER supabase_admin` + atualizar `.env` + restart DB +
  todos os apps que conectam direto — CRM e Ads inclusos. Alto
  impacto. Considerar TD-010)

## Impacto esperado

- **CRM**: todos os usuários deslogados, browsers fazem fetch em
  rotas e recebem 401 com `JWT expired/invalid` até relogar.
  Refresh token em cookie Supabase também invalida.
- **Ads**: nenhum impacto hoje. Pós-Fase 2, mesmo comportamento.
- **Integrações backend** (edge functions chamando REST com
  service_role key): pararam até atualizar a key no consumidor.
- **Supavisor** (quando for usado — TD-002): quebra conexão pooled
  se não atualizar `API_JWT_SECRET` simultaneamente.

## Sequência proposta

Janela: 15-30 minutos, fora de horário comercial, coordenada com
time CRM (aviso no canal + banner "estamos rotacionando,
relogue em 5 min").

> **Automação disponível.** Os passos 1-6 estão implementados em
> `scripts/td-006/rotate-jwt.sh` (orquestrador bash) +
> `scripts/td-006/generate-supabase-jwts.js` (gera HS256 com o novo
> secret, NÃO usa jwt.io). O passo 7 (CRM) está em
> `scripts/td-006/update-crm-env.sh`. Detalhes manuais mantidos abaixo
> para referência.

1. **Gerar novos valores** (local, fora do repo):
   ```bash
   NEW_JWT_SECRET=$(openssl rand -hex 32)
   # IMPORTANTE: assinar os JWTs com o NOVO secret — nunca usar jwt.io
   # ou serviços externos (o secret não pode sair da máquina).
   NEW_JWT_SECRET="$NEW_JWT_SECRET" node scripts/td-006/generate-supabase-jwts.js
   # Saída: {"jwt_secret":"...","anon":"...","service_role":"..."}
   ```
2. **Backup da .env**:
   ```bash
   cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
   cp .env .env.backup-td006-$(date +%s)
   ```
3. **Update compose .env** com os 3 novos valores (`JWT_SECRET`,
   `ANON_KEY`, `SERVICE_ROLE_KEY`).
4. **Recriar containers com as envs novas** — `docker restart`
   **NÃO** relê o `.env`; só `docker compose up --force-recreate`
   aplica os valores atualizados:
   ```bash
   cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
   # Parar kong antes — evita tráfego no gateway durante a troca
   docker stop alpes-ads_supabase-kong-1
   # Recriar todos os JWT consumers em paralelo
   docker compose up -d --force-recreate --no-deps \
     auth rest storage realtime functions supavisor
   # Subir kong com ANON/SERVICE_KEY novas
   docker compose up -d --force-recreate --no-deps kong
   ```
5. **Limpar refresh tokens órfãos** (sessões antigas invalidadas pela
   rotação; manter a tabela suja não é vulnerabilidade mas polui o DB):
   ```bash
   docker exec alpes-ads_supabase-db-1 \
     psql -U supabase_admin -d postgres \
     -c 'DELETE FROM auth.refresh_tokens;'
   ```
6. **Update consumidores** (env do container + recreate):
   - `pegasus-crm`: mudar `NEXT_PUBLIC_SUPABASE_ANON_KEY` e
     `SUPABASE_SERVICE_ROLE_KEY` no `.env` do CRM.
     **Rebuild é OBRIGATÓRIO**, não basta recreate: `NEXT_PUBLIC_*`
     são bakeadas no bundle JS no build (`next build`), não lidas em
     runtime. Sem rebuild, o browser continua enviando a ANON_KEY
     velha e recebe 401.
     ```bash
     cd /apps/pegasus-crm
     # Editar .env com as duas chaves novas
     bash scripts/deploy.sh  # faz docker build + recreate
     ```
   - `pegasus-ads`: N/A hoje; adicionar na Fase 2.
7. **Validar**:
   ```bash
   curl -s https://supabase.alpesd.com.br/auth/v1/settings \
     -H "apikey: $NEW_ANON_KEY" | jq .
   # esperado: { "external": {...}, "disable_signup": ..., ... }

   # Login real no CRM:
   curl -sS -o /dev/null -w '%{http_code}\n' https://crm.alpesd.com.br/login
   # esperado: 200
   ```
8. **Aviso pós-rotação**: canal CRM com instrução pra relogar.

## Rollback

Se quebrar no step 4:
```bash
cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
cp .env.backup-td006-<ts> .env
docker compose up -d --force-recreate --no-deps \
  auth rest storage realtime functions supavisor kong
```
Voltamos ao demo secret. Usuários CRM que tinham sessão antes voltam
a funcionar (JWT velho volta a ser válido) **APENAS se o rollback
acontecer ANTES do passo 5** (DELETE de refresh_tokens é
irreversível — usuários precisam relogar após rollback se o DELETE
já rodou).

Se quebrar no step 6 (CRM rebuild):
```bash
# Backup do .env do CRM é feito automaticamente pelo update-crm-env.sh
cp /apps/pegasus-crm/.env.backup-td006-<ts> /apps/pegasus-crm/.env
cd /apps/pegasus-crm && bash scripts/deploy.sh
```
Volta o CRM ao ANON/SERVICE_KEY antigas — mas o cluster já está com
secret novo, então CRM fica quebrado até rodar rollback completo
(cluster + CRM).

## Checklist pré-execução

- [ ] Coordenar com time CRM (canal + janela)
- [ ] `grep -rlI "your-super-secret-jwt-token"` em /apps/ e
      /etc/easypanel/ retorna APENAS: arquivos `.env(.example)?`,
      `docs/tech-debt.md`, `docs/migration/td-006-*`
- [ ] Script `generate-supabase-jwts.js` roda localmente (não depende
      de jwt.io ou serviços externos)
- [ ] Backup da `.env` do compose automatizado no rotator
- [ ] `scripts/td-006/rotate-jwt.sh --dry-run` rodado pelo menos 1x
- [ ] Banner/aviso no CRM

## Dependências desbloqueadas

- TD-002 Supavisor tenant (precisa do `API_JWT_SECRET` novo pra
  encriptar `db_pass` em `_supavisor.users`)
- Fase 2 Pegasus Ads → Supabase Auth (não começa sem JWT secret
  confiável)

## Fora de escopo (registrar outro TD)

- `POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password`
  (demo do supabase_admin) — alto impacto, separar em TD-010.
- Rotação de Telegram/Slack webhooks se houver.
- Rotation policy recorrente (anual?) — política operacional, não
  código.

## Referências no código

- `/etc/easypanel/projects/alpes-ads/supabase/code/supabase/code/docker-compose.yml` — consumidores
- `/etc/easypanel/projects/alpes-ads/supabase/code/supabase/code/.env` — single source
- pegasus-crm env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- pegasus-ads-green env: (vazio hoje; Fase 2 adiciona)
