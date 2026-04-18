# Docs — Pegasus Ads

Índice da documentação do projeto.

## Engenharia & Operações

- **[plano-migracao-pegasus-ads.md](plano-migracao-pegasus-ads.md)** —
  Plano macro da migração Neon → Supabase + Drizzle + Supabase Auth.
  Fases 0 a 5 + Staging Queue v2.
- **[tech-debt.md](tech-debt.md)** — Registro de débitos técnicos (open,
  in-progress, done). Trilha permanente de decisões.
- **[observability.md](observability.md)** — Setup de logs estruturados
  (Pino), métricas (Prometheus + Grafana) e CI (GitHub Actions).
- **[staging-queue-v2.md](staging-queue-v2.md)** — Spec completa da
  orquestração assíncrona de publicação Meta Ads (TD-007, ~12-15d).
- **[operations/cluster-runbook.md](operations/cluster-runbook.md)** —
  Runbook do cluster Supabase self-hosted: arquitetura, credenciais,
  operações comuns, gotchas, incidents históricos.
  - Status page pública (UptimeRobot → `/api/health`):
    <https://stats.uptimerobot.com/zDpiIXbCwA>
- **[api-reference.md](api-reference.md)** — Referência de endpoints.

## Migrações

- **[migration/fase1b-complete-report.md](migration/fase1b-complete-report.md)**
  — Relatório end-to-end da extração Neon + RLS.
- **[migration/fase2-supabase-auth.md](migration/fase2-supabase-auth.md)** —
  Plano detalhado da migração de auth (PR 2a/2b/2c).
- **[migration/td-006-gotrue-rotation-plan.md](migration/td-006-gotrue-rotation-plan.md)**
  — Plano de rotação dos secrets demo do cluster.

## Business Intelligence

- **[business/t4-attribution-coefficients.md](business/t4-attribution-coefficients.md)**
  — Coeficientes validados de atribuição T4 (preservados após `/api/attribution`
  ter sido removida por ser projeção estática).

## Memória persistente

Decisões e aprendizados desta sessão/projeto ficam no **Brain API**
(`brain.alpesd.com.br`, projeto `pegasus-ads`). Cada memória tem `id`,
`kind` (fact/decision/gotcha/incident) e é searchable via embedding.

Complementar ao git — git guarda *o que mudou*, Brain guarda *o porquê
+ o aprendizado*.
