# Fase 1C — Route Audit Completo

**Gerado:** 2026-04-18 (pós Wave 1)
**Branch:** `claude/review-pegasus-migration-plan-Gg25C`
**Total rotas:** 84
**Migradas (Wave 1):** 8 / 84 (9,5%) — 7 auth + `/api/cron/weekly-report` (stateless)
**A migrar:** 49 rotas com raw SQL ativo (raw ≥ 1 ou usa lib legacy)
**Sem DB (nada a migrar):** 27 rotas (drive / ads publish / videos / etc.)

---

## Metodologia

1. `grep -cE "db\.execute|getDb\(\)\.execute|dbAdmin\.execute"` por arquivo — conta
   queries raw ativas (exclui comentários).
2. Tabelas extraídas via regex `(INSERT INTO|UPDATE|DELETE FROM|FROM) \w+`, deduplicado.
3. Auth detectada por grep em `requireAuth`, `withWorkspace`, `authenticateApiKey`,
   `CRON_SECRET`.
4. Status `✓` confirmado contra files tocados em commits `c7c1e5c`, `0235d38`,
   `fda0ec4`, `b19b349` (Wave 1).

**Complexidade:**
- **S:** 1–4 queries raw, 1 tabela principal, <150 LOC
- **M:** 5–10 queries raw, 2–3 tabelas ou LOC 150–300
- **L:** >10 queries OU aggregates dinâmicos OU >300 LOC → PR dedicado

---

## Resumo por Wave

| Wave | Escopo              | Rotas c/ DB | Migradas | Pendentes | Complex. (S/M/L)  |
|------|---------------------|------------:|---------:|----------:|-------------------|
| 1    | crons + auth        |      8      |    8     |     0     | S:4 M:3 L:2       |
| 2    | ads + campaigns     |      8      |    0     |     8     | S:1  M:6  L:1     |
| 3    | creatives + insights + reports | 27 | 0 |    27     | S:4 M:14 L:9      |
| 4    | admin + setup       |      4      |    0     |     4     | M:1  L:3          |
| 5    | CRM + workspaces + settings |  10 |   0      |    10     | S:5  M:3  L:2     |
| —    | Sem DB (NOP)        |     27      |   n/a    |    n/a    | n/a               |
| **TOTAL** | **c/ DB = 57** |  **57**     |  **8**   |   **49**  |                   |

**Números refletem apenas rotas com raw SQL.** Rotas sem DB (27) aparecem na
tabela completa com `Status=n/a` e não contam nas waves.

---

## Tabela completa (ordenada por wave ASC, complexidade ASC, LOC ASC)

Legenda: `raw` = nº de `db.execute` (ou equivalente) ativos.
Tabelas apenas as principais tocadas (até 3).

### Wave 1 — crons/auth (já migrado)

| Rota                          | raw | Tabelas                        | Auth          | Cx | Status |
|-------------------------------|----:|--------------------------------|---------------|----|--------|
| /api/auth/google/route        |  0  | —                              | none          |  S | ✓ N/A  |
| /api/auth/logout              |  0  | sessions (via auth.ts)         | none          |  S | ✓      |
| /api/auth/google/callback     |  0  | users/workspace_members        | requireAuth   |  S | ✓      |
| /api/auth/me                  |  0  | users (via auth.ts)            | requireAuth   |  S | ✓      |
| /api/workspaces/switch        |  0  | sessions/workspace_members     | requireAuth   |  S | ✓      |
| /api/auth/register            |  0  | users/workspace_members        | none          |  M | ✓      |
| /api/auth/login               |  0  | users/workspace_members/sessions | none        |  M | ✓      |
| /api/cron/weekly-report       |  0  | — (delega)                     | cronSecret    |  S | ✓ N/A  |
| /api/cron/collect             |  0  | metrics/creatives/alerts/breakdowns | cronSecret    |  L | ✓      |
| /api/cron/sync-all            |  0  | metrics/classified_insights/alerts | withWorkspace+cronSecret | L | ✓ |

### Wave 2 — ads / campaigns (a migrar)

| Rota                                | raw | Tabelas                                | Auth        | Cx | Status |
|-------------------------------------|----:|----------------------------------------|-------------|----|--------|
| /api/ads/toggle-status              |  1  | classified_insights                    | requireAuth |  S |  ⏳    |
| /api/budget/suggest                 |  1  | creatives                              | requireAuth |  M |  ⏳    |
| /api/campaigns/metrics              |  2  | classified_insights, crm_leads         | requireAuth |  M |  ⏳    |
| /api/campaigns/route (list)         |  5  | campaigns                              | requireAuth |  M |  ⏳    |
| /api/ads/kill-rule                  |  3  | campaigns, crm_leads                   | requireAuth |  M |  ⏳    |
| /api/attribution                    |  2  | creatives, metrics                     | requireAuth |  M |  ⏳    |
| /api/kill-rules/evaluate            |  2  | creatives                              | requireAuth |  M |  ⏳    |
| /api/campaigns/[id]/drill           |  5  | classified_insights, crm_leads         | requireAuth |  L |  ⏳    |

Ads stateless (sem DB, não precisa migrar):
`/api/ads/duplicate-creative`, `/api/ads/inspect`, `/api/ads/pause`,
`/api/ads/publish-carousel`, `/api/ads/publish-external`,
`/api/ads/publish-to-adsets`, `/api/ads/publish-videos`,
`/api/ads/upload-image`, `/api/adsets/archive`, `/api/adsets/pause`,
`/api/campaigns/create-meta`.

### Wave 3 — creatives / insights / reports (a migrar)

| Rota                                | raw | Tabelas                                 | Auth        | Cx | Status |
|-------------------------------------|----:|-----------------------------------------|-------------|----|--------|
| /api/test-rounds/generate           |  1  | test_rounds                             | requireAuth |  S |  ⏳    |
| /api/test-rounds/publish            |  1  | test_rounds                             | requireAuth |  S |  ⏳    |
| /api/images/route                   |  2  | images                                  | requireAuth |  S |  ⏳    |
| /api/images/[id]                    |  2  | images                                  | requireAuth |  S |  ⏳    |
| /api/insights/route                 |  3  | metrics                                 | requireAuth |  M |  ⏳    |
| /api/insights/breakdowns            |  3  | metrics_breakdowns                      | requireAuth |  M |  ⏳    |
| /api/insights/demographics          |  3  | metrics_demographics, published_ads     | requireAuth |  M |  ⏳    |
| /api/funnels                        |  4  | creatives, funnels                      | requireAuth |  M |  ⏳    |
| /api/test-rounds/route              |  4  | test_rounds, test_round_variants        | requireAuth |  M |  ⏳    |
| /api/visual-elements                |  5  | visual_elements                         | requireAuth |  M |  ⏳    |
| /api/creative-intel/pause           |  2  | classified_insights                     | requireAuth |  M |  ⏳    |
| /api/creative-intel/taxonomy        |  2  | ad_creatives, crm_leads                 | requireAuth |  M |  ⏳    |
| /api/creative-intel/ads             |  3  | ad_creatives, classified_insights, crm_leads | requireAuth | M |  ⏳    |
| /api/creative-intel/performance     |  3  | ad_creatives, crm_leads                 | requireAuth |  M |  ⏳    |
| /api/creatives/route                |  4  | creatives, creative_edges, metrics      | requireAuth |  L |  ⏳    |
| /api/creatives/[id]/metrics         |  6  | creatives, metrics                      | requireAuth |  L |  ⏳    |
| /api/creatives/promote-control      |  8  | alerts, creative_edges, creatives       | requireAuth |  L |  ⏳    |
| /api/graph                          |  2  | creatives, creative_edges, metrics      | requireAuth |  L |  ⏳    |
| /api/generate/verify-ocr            |  1  | creatives                               | requireAuth |  M |  ⏳    |
| /api/generate/retry                 |  6  | creatives, creative_ref_images, prompts | requireAuth |  L |  ⏳    |
| /api/generate/route                 |  7  | creatives, creative_edges, images, prompts | requireAuth | L | ⏳    |
| /api/hypotheses/generate            |  4  | creatives, hypotheses, visual_elements  | requireAuth |  L |  ⏳    |
| /api/reports/creative-performance   |  4  | ad_creatives, classified_insights, crm_leads | requireAuth | L | ⏳   |
| /api/reports/weekly                 |  5  | alerts, creatives, metrics              | requireAuth |  L |  ⏳    |
| /api/insights/collect               |  6  | creatives, metrics, metrics_breakdowns, published_ads | requireAuth | L | ⏳ |
| /api/alerts/route                   |  4  | alerts                                  | requireAuth |  M |  ⏳    |
| /api/export/test-log                |  2  | creatives                               | requireAuth |  M |  ⏳    |

Stateless nesta família (sem DB): `/api/insights/live`, `/api/pipeline/run-cycle`.

### Wave 4 — admin / setup

| Rota                                | raw | Tabelas                   | Auth                          | Cx | Status |
|-------------------------------------|----:|---------------------------|-------------------------------|----|--------|
| /api/admin/fix-control-blob         |  3  | creatives                 | requireAuth                   |  M |  ⏳    |
| /api/setup/apps-script              |  5  | settings                  | requireAuth+cronSecret        |  L |  ⏳    |
| /api/setup/test-log-sheet           |  6  | creatives, settings       | requireAuth+cronSecret        |  L |  ⏳    |
| /api/templates/route                |  8  | templates                 | requireAuth                   |  L |  ⏳    |

Stateless: `/api/seed`, `/api/docs`, `/api/variable-types`.

### Wave 5 — CRM / workspaces / settings

| Rota                                | raw | Tabelas                      | Auth        | Cx | Status |
|-------------------------------------|----:|------------------------------|-------------|----|--------|
| /api/workspaces/route               |  1  | workspaces                   | requireAuth |  S |  ⏳    |
| /api/projects/route                 |  4  | projects                     | requireAuth |  S |  ⏳    |
| /api/settings/route                 |  3  | settings (global!)           | requireAuth |  S |  ⏳ TD-005 |
| /api/workspaces/api-keys            |  0* | via workspace.ts             | requireAuth |  S |  ⚠️    |
| /api/crm/qualification-rules        |  3  | lead_qualification_rules     | requireAuth |  S |  ⏳    |
| /api/workspaces/meta-accounts       |  2  | workspace_meta_accounts      | requireAuth |  S |  ⏳    |
| /api/workspaces/members             |  3  | users, workspace_members     | requireAuth |  M |  ⏳    |
| /api/crm/import-mappings            |  8  | crm_import_mappings          | requireAuth |  L |  ⏳    |
| /api/crm/import                     |  4  | campaigns, crm_leads, lead_qualification_rules, published_ads | requireAuth | L | ⏳ |

Stateless na família: `/api/workspaces/usage`, `/api/auth/google`.

### Sem DB (sem ação — NOP)

27 rotas. Todas stateless ou delegam para libs externas (`google-drive.ts`,
`meta.ts`) — nada a migrar.

`/api/ads/duplicate-creative`, `/api/ads/inspect`, `/api/ads/pause`,
`/api/ads/publish-carousel`, `/api/ads/publish-to-adsets`,
`/api/ads/publish-videos`, `/api/ads/upload-image`, `/api/adsets/archive`,
`/api/adsets/pause`, `/api/auth/google`, `/api/auth/logout`,
`/api/campaigns/create-meta`, `/api/cron/weekly-report`, `/api/docs`,
`/api/drive/disconnect`, `/api/drive/folders`, `/api/drive/list-creatives`,
`/api/drive/select-folder`, `/api/drive/status`, `/api/drive/upload-file`,
`/api/drive/upload`, `/api/insights/live`, `/api/pipeline/run-cycle`,
`/api/variable-types`, `/api/videos/temp/[filename]`,
`/api/videos/upload-temp`, `/api/workspaces/usage`.

**Nota:** `/api/ads/publish-external` tem `const db = getDb();` morto (linha 101)
mas nunca usa `db` — candidato a limpeza trivial em qualquer PR da Wave 2.
`/api/seed` também tem `const db = getDb();` dead-code que pode sair junto.

---

## Ordem de ataque sugerida — Wave 2 (próxima)

Ordenado por valor/risco: quick wins (S) primeiro para ganhar momentum,
depois rotas média com alta cobertura de código (M/L).

1. **`/api/ads/toggle-status`** — S, 54 LOC, 1 query. Quick win, pattern simples.
2. **`/api/budget/suggest`** — M, 224 LOC, 1 query (aggregate). Useful para
   validar pattern de aggregate em sql\`\` dentro de rota autenticada.
3. **`/api/campaigns/metrics`** — M, 132 LOC, 2 queries com JOINs (crm + CI).
4. **`/api/campaigns/route`** — M, 149 LOC, 5 queries (CRUD completo — padrão
   para as próximas rotas de listing).
5. **`/api/ads/kill-rule`** — M, 492 LOC mas só 3 queries. Lógica de negócio
   densa, queries pontuais.
6. **`/api/attribution`** — M, 175 LOC, 2 queries agregadas em creatives+metrics.
7. **`/api/kill-rules/evaluate`** — M, 223 LOC, 2 queries com rank windowing.
8. **`/api/campaigns/[id]/drill`** — L, 309 LOC, 5 queries com CASE WHEN.
   Fica por último da wave; candidata a PR dedicado.

**LOC total Wave 2:** ~1.838 LOC (range ads+campaigns com DB).
**Estimativa:** 1–2 dias úteis dependendo de validação e2e por rota.

---

## Top 5 rotas mais complexas a migrar (cross-wave)

Ordenado por raw queries DESC + LOC:

1. **`/api/creatives/promote-control`** — 8 raw, 151 LOC, 3 tabelas,
   cascata promoção+alertas. **L**, PR dedicado.
2. **`/api/templates/route`** — 8 raw, 202 LOC, single table mas CRUD completo
   com filtros dinâmicos. **L**.
3. **`/api/crm/import-mappings`** — 8 raw, 177 LOC, GET/POST/PUT/DELETE
   completo em single table. **L**.
4. **`/api/generate/route`** — 7 raw, 206 LOC, 4 tabelas
   (creatives, creative_edges, images, prompts) com lógica de hypotheses. **L**.
5. **`/api/creatives/[id]/metrics`** — 6 raw, 128 LOC, JOIN creatives+metrics
   com janelas temporais (7d/14d/30d). **L**.

Observação: `/api/insights/collect` (6 raw, 294 LOC, 4 tabelas) ficou na lista
interna como runner-up — tem aggregates complexos com `published_ads`.

---

## Observações

- **Auth coverage:** Todas as rotas não-cron têm `requireAuth` (único outlier
  já era `/api/auth/*` que não podem exigir sessão). Boa trilha para usar
  `withWorkspace` na Fase 2 sem refatorar fluxo auth.
- **TD-005 overlap:** `/api/settings/route` usa a tabela global `settings`
  — migrar junto OU depois do cleanup TD-005 (decidir na Wave 5).
- **`/api/workspaces/api-keys`** marcada **⚠️**: não tem `db.execute` direto,
  mas usa `createApiKey/listApiKeys/revokeApiKey` de `src/lib/workspace.ts`
  que ainda é legado. Migração passa por migrar a library primeiro (igual
  ao que foi feito com `auth.ts` em Wave 1).
- **`/api/cron/weekly-report`:** 0 queries — só dispara relatório via lib,
  delegação para `/api/reports/weekly` que tem 5 queries. A "migração" do
  cron em si já terminou em Wave 1 (sem DB direto); a carga de DB
  concentra-se em `/api/reports/weekly` (Wave 3 L).
- **Stateless massivo:** 24 rotas (29%) nem tocam DB. Maior parte é
  Google Drive (7), ads publishing (9) e videos (2) — delegam para libs
  externas (`google-drive.ts`, `meta.ts`). Não contabilizar em "% migrado".
- **Padrão emergente Wave 1:** `dbAdmin` para cross-workspace (cron, auth),
  `withWorkspace` (RLS) para rotas user-scoped. Wave 2 em diante será
  majoritariamente `withWorkspace`.
- **Misto Drizzle+raw:** Nenhum detectado entre as 52 pendentes. As 8 da Wave
  1 foram migradas por inteiro (auth.ts também). Baixo risco de regressão
  parcial.

---

## Referências

- Wave 1 commits: `c7c1e5c` (sync-all POC), `0235d38` (cron/collect),
  `fda0ec4` (auth + switch), `b19b349` (validation + plano TD-006).
- Handoff: `docs/migration/HANDOFF-fase-1c.md`.
- Débitos relacionados: TD-003 (`TEST_LOG_API_KEY` legacy),
  TD-005 (`settings` global), TD-006 (gotrue rotation — P0 antes Fase 2).
