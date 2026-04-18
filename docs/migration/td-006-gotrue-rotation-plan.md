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

1. **Gerar novos valores** (local, fora do repo):
   ```bash
   NEW_JWT_SECRET=$(openssl rand -hex 32)
   # Usar supabase CLI ou jwt.io com HS256 + NEW_JWT_SECRET:
   #   payload anon     = {"role":"anon","iss":"alpes-ads","iat":<now>,"exp":<10y>}
   #   payload service  = {"role":"service_role","iss":"alpes-ads","iat":<now>,"exp":<10y>}
   NEW_ANON_KEY="<jwt>"
   NEW_SERVICE_ROLE_KEY="<jwt>"
   ```
2. **Backup da .env**:
   ```bash
   cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
   cp .env .env.backup-td006-$(date +%s)
   ```
3. **Update compose .env** com os 3 novos valores.
4. **Restart em ordem** (evita gotrue+db assinar um JWT com secret
   velho enquanto postgrest já valida com o novo):
   ```bash
   # Tudo que le JWT — parar primeiro
   docker restart alpes-ads_supabase-auth-1 \
                  alpes-ads_supabase-rest-1 \
                  alpes-ads_supabase-storage-1 \
                  alpes-ads_supabase-realtime-1 \
                  alpes-ads_supabase-functions-1 \
                  alpes-ads_supabase-supavisor-1 \
                  alpes-ads_supabase-kong-1
   ```
5. **Update consumidores** (env do container + recreate):
   - `pegasus-crm`: mudar `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
     `SUPABASE_SERVICE_ROLE_KEY` na .env do CRM + recreate container.
     (CRM precisa rebuild se as vars estão bakeadas no build; nosso
     caso Next.js uses NEXT_PUBLIC_* at build — rebuild necessário)
   - `pegasus-ads`: N/A hoje; adicionar na Fase 2.
6. **Validar**:
   ```bash
   curl -s https://supabase.alpesd.com.br/auth/v1/settings \
     -H "apikey: $NEW_ANON_KEY" | jq .
   # esperado: { "external": {...}, "disable_signup": ..., ... }
   ```
7. **Aviso pós-rotação**: canal CRM com instrução pra relogar.

## Rollback

Se quebrar no step 4:
```bash
cd /etc/easypanel/projects/alpes-ads/supabase/code/supabase/code
cp .env.backup-td006-<ts> .env
# restart mesma lista de containers
```
Voltamos ao demo secret. Usuários CRM que tinham sessão antes voltam
a funcionar (JWT velho volta a ser válido).

## Checklist pré-execução

- [ ] Coordenar com time CRM (canal + janela)
- [ ] Gerar NEW_JWT_SECRET, NEW_ANON_KEY, NEW_SERVICE_ROLE_KEY
      localmente
- [ ] `grep -r "your-super-secret-jwt-token"` em /apps/ pra pegar
      qualquer hardcoded que tenha escapado
- [ ] Backup da .env do compose
- [ ] Testar rollback dry-run (desbloqueia decisão se der merda)
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
