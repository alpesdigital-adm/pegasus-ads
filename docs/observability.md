# Observability — Pegasus Ads

Documento operacional da Fase 4. Cobre a stack de logs + métricas + CI
que roda em produção, e o runbook de debug quando algo quebra.

## Arquitetura (atual)

```
┌─────────────────────┐       stdout JSON        ┌─────────────────┐
│ pegasus-ads-green   │ ───────────────────────▶ │ docker logs     │
│ (Next 16, Node 20)  │                          │ (journald)      │
│                     │ /api/metrics (bearer)    └─────────────────┘
│ pino logger         │ ◀─ scrape 30s ──┐
│ prom-client registry│                 │
└─────────────────────┘                 │
                                        │
                             ┌──────────┴──────────┐
                             │ pegasus-prometheus  │
                             │  (retention 30d)    │
                             └──────────┬──────────┘
                                        │
                             ┌──────────▼──────────┐
                             │ pegasus-grafana     │
                             │  grafana.alpesd...  │
                             └─────────────────────┘
```

## Componentes

### Logs — Pino
- Lib: `src/lib/logger.ts` (singleton + `.child({ route })`)
- Nível: `LOG_LEVEL` env (default `info`). Em dev vira pino-pretty; em
  prod é JSON puro no stdout.
- Onde está em uso: `cron/*`, `creative-intel/*`, `insights/*`,
  `reports/*`, `pipelines/*`. Auth routes (`/api/auth/*`, `src/lib/auth.ts`)
  ficaram fora — são território da Fase 2, migram depois.
- Como acessar: `docker logs -f pegasus-ads-green` (no VPS).

### Métricas — prom-client
- Lib: `src/lib/metrics.ts`
- Registry global via guard em `globalThis` (hot-reload safe).
- Métricas expostas hoje:
  - `http_requests_total{method,route,status}` — counter por request
  - `http_request_duration_seconds{method,route,status}` — histogram
  - `pipeline_runs_total{pipeline,status}` — counter (ainda não
    incrementado nos pipelines; gancho pronto)
  - `meta_api_calls_total{endpoint,status}` — counter (idem)
  - `pegasus_*` — métricas default do Node (memória, event loop, GC)
- Labels `route` são bucketizados: UUIDs e dígitos viram `:id` para
  evitar cardinality explosion.

### Scrape endpoint — `/api/metrics`
- `src/app/api/metrics/route.ts`
- Protegido por `Authorization: Bearer $PROMETHEUS_SCRAPE_TOKEN`
  (comparação constant-time via `timingSafeEqual`).
- Sem token → 503 (fail-safe, não expõe métricas abertas).

### Prometheus
- Container `pegasus-prometheus` na network `alpes-ads_supabase_default`
  (sem ingress externo — só o Grafana fala com ele).
- Config em `infra/prometheus/prometheus.yml.tpl`.
- Scrape interval 30s, retention 30d.
- Bearer vem de um secret file montado read-only (`/etc/prometheus/scrape-token`),
  **não** de env var — evita vazamento via `docker inspect`.

### Grafana
- Container `pegasus-grafana` em `easypanel` (Traefik) +
  `alpes-ads_supabase_default` (pra falar com Prometheus).
- URL: **https://grafana.alpesd.com.br**
- Admin pass em `/root/.grafana-admin-pass` (mode 600). Pra rotacionar:
  `rm` o arquivo e re-rodar `scripts/phase-4-setup-observability.sh`.
- Provisioning auto (read-only no container):
  - Datasource: `infra/grafana/provisioning/datasources/prometheus.yml`
  - Dashboards: `infra/grafana/dashboards/*.json`
- Dashboard inicial: **Pegasus Ads — Overview** (folder "Pegasus Ads").

### CI — GitHub Actions
- `.github/workflows/ci.yml`
- Jobs: `lint`, `typecheck`, `build` — paralelos, Node 22, cache npm.
- Roda em PR + push em `main`.
- Build usa envs dummy (ver workflow) — suficiente pra resolver imports.

## Runbook

### "CPL subiu / lead tracking quebrou — por onde começo?"

1. **Grafana** → dashboard "Pegasus Ads — Overview"
   - Painel "Erros 5xx / min (por rota)" — algum spike recente?
   - Painel "Latência (p50/p95/p99)" — p95 explodiu? Meta API lenta?
   - Painel "Requests/min por status" — queda em 2xx com 5xx plano
     sugere downstream (DB, Meta API) degradado.

2. **Logs do green** → contexto estruturado:
   ```bash
   docker logs pegasus-ads-green --since 30m 2>&1 \
     | jq -c 'select(.level >= 50)' | head -50
   ```
   Filtra erro+fatal. Campos úteis: `route`, `workspace_id`, `err.message`.

3. **Logs do cron**:
   ```bash
   docker logs pegasus-ads-green --since 24h 2>&1 \
     | grep -E '"route":"/api/cron/' | jq -c . | tail -20
   ```

4. **Meta API rate limit**: procure `"fatal"` em `/api/cron/sync-all` —
   `meta_api_calls_total` por status vai mostrar (quando instrumentado).

### "Produção 500 e não sei de onde"

1. Grafana painel 5xx por rota → identifica a rota.
2. `docker logs pegasus-ads-green --tail 200 2>&1 | jq -c 'select(.level>=50)'`
   → pega a stack.
3. Se for regressão recente: `git log --oneline -20` no branch servido
   pelo green.
4. Rollback rápido: `bash scripts/cutover/03-rollback-to-blue.sh`
   (blue volta a servir pegasus.alpesd.com.br).

### "Prometheus não está scrapeando"

```bash
# status de targets
docker exec pegasus-prometheus wget -qO- http://localhost:9090/api/v1/targets \
  | jq '.data.activeTargets[] | {job: .labels.job, health, lastError}'
```

Erros comuns:
- `401 Unauthorized` → `PROMETHEUS_SCRAPE_TOKEN` no green ≠ do scrape-token
  do Prometheus. Re-roda `scripts/phase-4-setup-observability.sh`
  (regenera o scrape-token com o mesmo valor do .env) e faz rebuild do
  green se mudou.
- `503 Service Unavailable` → o green não tem o token env var.
  Rebuild com `bash scripts/cutover/01-deploy-green.sh`.
- `connection refused` → green caiu. `docker ps`, `docker logs`.

### "Grafana não abre / dashboard vazio"

- DNS: `dig grafana.alpesd.com.br` → tem que apontar pro VPS (187.77.245.144).
- Cert TLS: primeira subida demora ~30s pro letsencrypt emitir. Paciência.
- Dashboard vazio: painel mostra "No data" se o scrape falhou nos
  últimos 5min. Confirma scrape no Prometheus antes (ver acima).

## Adicionar uma métrica nova

1. Em `src/lib/metrics.ts`, adiciona counter/gauge/histogram via o
   `counter(...)` / `histogram(...)` factory (idempotente).
2. Importa e incrementa no ponto de uso:
   ```ts
   import { pipelineRunsTotal } from "@/lib/metrics";
   pipelineRunsTotal.inc({ pipeline: "generate", status: "success" });
   ```
3. Próximo scrape (≤30s) aparece no Prometheus. Query em Grafana:
   `rate(pipeline_runs_total[5m])`.
4. Cardinality: **nunca** coloque valores user-controlled (IDs,
   mensagens de erro) em label. Labels são baixa-cardinalidade
   (`status`, `pipeline_name`, `route_bucket`).

## Sentry — deferido (Fase 4b)

Ainda não configurado. Motivo: Sentry exige projeto externo
(sentry.io ou self-hosted) + DSN, e queríamos fechar a Fase 4 sem
dependência de ação no UI. A stack atual (logs + métricas) cobre o
grosso; Sentry seria ganho para agregação de stack traces e alerta por
exception.

Quando ativar: criar projeto Sentry, salvar `SENTRY_DSN` no `.env`,
adicionar `@sentry/nextjs`, wire em `instrumentation.ts` via
`Sentry.init()` + `onRequestError` (docs do Next 16 já trazem o hook).

## TODOs conhecidos

- **DB pool gauge**: `pegasus_db_connections_active` / `_idle` —
  precisa expor via periodic collector lendo o pool do postgres-js.
  Ainda não wirado.
- **Pipeline métricas**: `pipelineRunsTotal` existe mas não é
  incrementado em `src/lib/pipelines/{generate,publish}.ts` — adicionar
  `.inc({pipeline, status})` nos pontos de commit/erro.
- **Meta API métricas**: `metaApiCallsTotal` idem — instrumentar em
  `src/lib/meta.ts` após migrar de `console.*` (fora do escopo Fase 4
  — a lib auth mexe nela parcialmente).
- **Alertmanager**: sem alertas configurados. Prometheus está pronto
  pra plugar Alertmanager depois (canais: email? Slack?).
