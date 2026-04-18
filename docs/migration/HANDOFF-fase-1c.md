# HANDOFF — Fase 1C kickoff (route migration)

**Para:** próxima sessão Claude (remota ou VPS) que for tocar rotas
**De:** sessão de consolidação pós-cutover (2026-04-18)
**Branch:** `claude/review-pegasus-migration-plan-Gg25C`
**Depende de:** Fase 0 + 1A + 1B + cutover done (TD-009 🟢)

---

## Escopo da Fase 1C

Migrar **84 rotas API** que ainda usam o adapter legado `getDb().execute()` com
raw SQL para:

1. **Drizzle queries** (`db.select().from(schema).where(...)`)
2. **`withWorkspace(wsId, async (tx) => ...)`** para RLS automático
3. **Remoção dos filtros manuais `WHERE workspace_id = ?`** (redundantes com RLS)

**Resultado final**: RLS `FORCE` totalmente confiável (hoje a legacy API passa
por `dbAdmin` que bypassa RLS — segurança só está nos WHEREs manuais).

## Priorização recomendada

### Wave 1 — Rotas críticas + alto risco (fazer primeiro)
- [ ] `/api/auth/login` (toca `users`, `sessions`)
- [ ] `/api/auth/me` (session validation)
- [ ] `/api/auth/register`, `/api/auth/google/callback`
- [ ] `/api/cron/sync-all` ← POC desta fase (já tem fix do cutover)
- [ ] `/api/cron/collect`
- [ ] `/api/workspaces/switch` (muda sessão)

### Wave 2 — Rotas de ads (médio risco)
- [ ] `/api/ads/kill-rule`, `/api/ads/publish-external`, `/api/ads/toggle-status`
- [ ] `/api/campaigns/*` (3 rotas)
- [ ] `/api/creatives/*` (5 rotas)
- [ ] `/api/test-rounds/*` (3 rotas)

### Wave 3 — Rotas de métricas + insights (baixo risco)
- [ ] `/api/insights/*` (4 rotas)
- [ ] `/api/creative-intel/*` (4 rotas)
- [ ] `/api/creatives/[id]/metrics`, `/api/reports/*`

### Wave 4 — Rotas admin + setup (menor impacto)
- [ ] `/api/admin/*`, `/api/setup/*`, `/api/seed`
- [ ] `/api/docs`, `/api/templates`

### Wave 5 — CRM (pode paralelo)
- [ ] `/api/crm/*` (3 rotas)
- [ ] `/api/workspaces/api-keys`, `/api/workspaces/members`

**Tamanho sugerido de PR**: 3-5 rotas por PR. Cada wave = 3-4 PRs.

## Padrão de migração (before / after)

### Antes (legacy, raw SQL via adapter)

```typescript
// src/app/api/creatives/route.ts (exemplo hipotético)
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const db = getDb();
  const result = await db.execute({
    sql: `SELECT id, name, blob_url, status
            FROM creatives
            WHERE workspace_id = ? AND status = ?
            ORDER BY created_at DESC
            LIMIT 100`,
    args: [auth.workspace_id, "generated"],
  });
  return NextResponse.json(result.rows);
}
```

### Depois (Drizzle + withWorkspace)

```typescript
// src/app/api/creatives/route.ts (pós Fase 1C)
import { withWorkspace } from "@/lib/db";
import { creatives } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth";
import { and, eq, desc } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const rows = await withWorkspace(auth.workspace_id, async (tx) => {
    return tx
      .select({
        id: creatives.id,
        name: creatives.name,
        blobUrl: creatives.blobUrl,
        status: creatives.status,
      })
      .from(creatives)
      .where(eq(creatives.status, "generated"))
      // NENHUM filtro workspace_id — RLS injeta via SET LOCAL
      .orderBy(desc(creatives.createdAt))
      .limit(100);
  });

  return NextResponse.json(rows);
}
```

**Ganhos:**
- `-1 linha` por WHERE workspace_id removido
- Type-safety em select (IDE autocomplete nos campos)
- RLS enforced no DB (defense in depth — query sem withWorkspace retorna 0 rows)
- Queries mais enxutas, sem template strings

## Gotchas conhecidos

### 1. Crons precisam `dbAdmin` (BYPASSRLS)

Cron jobs operam cross-workspace. Em vez de `withWorkspace(...)`, usar:

```typescript
import { dbAdmin } from "@/lib/db";

const activeAds = await dbAdmin
  .select()
  .from(publishedAds)
  .where(eq(publishedAds.status, "active"));
```

### 2. Auth handlers antes do workspace_id

`/api/auth/login` não tem workspace ainda (está logando). Use `dbAdmin` para o
INSERT em `users`/`sessions`, depois o restante flui com `withWorkspace`.

### 3. Raw SQL que Drizzle não tem built-in

Algumas queries complexas (CTEs, window functions, JSON operators) podem ser
mais claras em raw SQL. Para essas, usar:

```typescript
import { sql, withWorkspace } from "@/lib/db";

await withWorkspace(wsId, async (tx) => {
  return tx.execute(sql`
    WITH daily AS (SELECT ... FROM metrics WHERE date >= ${since})
    SELECT ... FROM daily
  `);
});
```

O `sql`-tagged template tem escaping seguro + RLS continua via `SET LOCAL`.

### 4. Interface legada durante transição

O `getDb().execute()` continua válido — só vai embora quando todas as 84
rotas forem migradas. Durante Fase 1C, mistura é OK.

Quando 0 rotas usarem `getDb()`, remover `initDb()`, `getDb()`, e todo o
legacy adapter em `src/lib/db/index.ts`.

## Por onde começar (próxima sessão)

Sugestão: **`/api/cron/sync-all`** como POC.
- Já foi tocado no cutover fix (bug dos FKs)
- Não tem workspace_id direto (usa dbAdmin)
- Migração serve de exemplo para outros crons

Depois: Wave 1 Auth (4 rotas). Esses tocam `users`/`sessions` que vão
sumir na Fase 2 — então a "migração" deles é temporária, mas estabelece
o padrão para os handlers.

## Validação a cada PR

- [ ] `npx tsc --noEmit` passa
- [ ] `docker build` passa (próxima imagem green)
- [ ] Rota funciona em `pegasus-green.alpesd.com.br` via smoke test
- [ ] Se mexer em kill rules ou cron, monitorar 1h antes de próximo PR
- [ ] Rollback simples: revert do commit + rebuild green

## Critério de "Fase 1C completa"

- [ ] Zero `getDb().execute()` no src
- [ ] Zero raw SQL `WHERE workspace_id = ?` em rotas (RLS cobre)
- [ ] Legacy adapter removido de `src/lib/db/index.ts`
- [ ] `initDb()` shim removido (10 rotas ainda usam — migrar antes)
- [ ] `@neondatabase/serverless` removido do `package.json`

Depois disso, Fase 1 inteira está 100% fechada e a base fica pronta pra
Fase 2 (auth) e Fase 3 (design system) em paralelo.
