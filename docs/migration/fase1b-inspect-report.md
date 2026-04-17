# Fase 1B — Inspeção do Neon (relatório)

**Data:** 2026-04-17
**Gêmeo:** VPS Hostinger
**Script:** `scripts/phase-1b/01-inspect-neon.sh`

---

## 🚨 Bloqueadores antes do step 03 (apply-migration)

1. **pg_dump instalado na VPS é 16.13, Neon é 17.8.** O step 04 (`pg-dump-data.sh`)
   vai falhar com `server version mismatch`. Precisa instalar `postgresql-client-17`
   na VPS ou rodar via `docker run --rm postgres:17-alpine pg_dump ...`.

2. **11 tabelas em Neon não têm schema Drizzle.** A migration 0000+0001 atual
   só cria 34 tables, mas o Neon tem 45. Se aplicar migration e restaurar
   dump, as 11 tabelas são perdidas (não existem no target). Lista + \d abaixo.

---

## Resumo

- Neon: **45 tabelas**, Postgres 17.8
- Drizzle schema (branch atual): **34 tabelas**
- Gap: **11 tabelas sem schema** (todas com dados ou com FKs relevantes)
- Total de rows a migrar: ~42.000 (hourly_insights é 60% disso)

## 11 tabelas missing + row counts

| tabela | rows | criticidade |
|---|---:|---|
| `hourly_insights` | 25.463 | **alta** — maior tabela; referencia ad_accounts |
| `sync_logs` | 4.554 | média — audit trail de jobs |
| `leads` | 3.833 | alta — leads CRM importados |
| `ad_insights` | 2.755 | **alta** — referenciada por `classified_insights` (já no Drizzle); FK bloqueia restore se ausente |
| `accounts` | 1 | **alta** — referenciada por `leads` e `lead_sources` |
| `lead_sources` | 1 | média — referenciada por `leads` |
| `projects` | 1 | média — referenciada por workspaces via FK |
| `ad_accounts` | 0 | **alta** — referenciada por `ad_insights`, `classified_insights`, `hourly_insights`, `sync_logs` (4 FKs!) |
| `classification_rules` | 0 | baixa |
| `crm_import_mappings` | 0 | baixa |
| `saved_views` | 0 | baixa |

**Observação**: `ad_accounts` tem 0 rows mas é central pro grafo de FKs. `accounts`
(tabela legacy diferente) tem 1 row e também é pivot.

## Não-UUID PKs (33 tabelas usam `text` ou `serial integer` como PK)

Plano v1.3 converte todos via UUIDv5 determinístico no step 05. Lista completa
em `/tmp/pegasus-ads-neon-inspect/non_uuid_pks.tsv`. Destaques:

- PKs `text` (não-numeric): 30+ tabelas — chaves literais do sistema legado
- PKs `integer serial`: `ad_creatives`, `ad_insights`, `angles`, `classified_insights`, `concepts`, `hourly_insights`, `launches`, `leads`, `lead_sources`, `offers`, `saved_views`, `sync_logs`, `ad_accounts`, `accounts`, `classification_rules` (15 com serial)

---

## \d completo das 11 tabelas missing

### 1. `accounts` (1 row — DIFERENTE de `ad_accounts`)

```
id                integer        PK (serial)
name              varchar(255)   NOT NULL
slug              varchar(100)   NOT NULL  UNIQUE
meta_access_token text
meta_account_id   varchar(50)
is_active         boolean        DEFAULT true
created_at        timestamptz    DEFAULT now()
updated_at        timestamptz    DEFAULT now()
```

Referenciada por: `lead_sources.account_id`, `leads.account_id`.

### 2. `ad_accounts` (0 rows — central no grafo)

```
id              integer        PK (serial)
meta_account_id varchar(50)    NOT NULL  UNIQUE
name            varchar(255)   NOT NULL
access_token    text           NOT NULL
app_secret      text
api_version     varchar(10)    DEFAULT 'v25.0'
is_active       boolean        DEFAULT true
created_at      timestamptz    DEFAULT now()
updated_at      timestamptz    DEFAULT now()
```

Referenciada por: `ad_insights.account_id`, `classified_insights.account_id`,
`hourly_insights.account_id`, `sync_logs.account_id`.

### 3. `ad_insights` (2755 rows)

```
id                    integer        PK (serial)
account_id            integer        FK ad_accounts(id)
date                  date           NOT NULL
campaign_id           varchar(50)    NOT NULL
campaign_name         varchar(500)
adset_id              varchar(50)    NOT NULL
adset_name            varchar(500)
ad_id                 varchar(50)    NOT NULL
ad_name               varchar(500)
spend                 numeric(12,2)  DEFAULT 0
impressions           integer        DEFAULT 0
reach                 integer        DEFAULT 0
link_clicks           integer        DEFAULT 0
landing_page_views    integer        DEFAULT 0
leads                 integer        DEFAULT 0
add_to_wishlist       integer        DEFAULT 0
add_to_cart           integer        DEFAULT 0
initiate_checkout     integer        DEFAULT 0
purchases             integer        DEFAULT 0
purchase_value        numeric(12,2)  DEFAULT 0
video_views_3s/25/50/75/95   integer  DEFAULT 0
profile_visits        integer        DEFAULT 0
new_followers         integer        DEFAULT 0
comments/reactions/shares/saves  integer DEFAULT 0
conversations_started integer        DEFAULT 0
messages_received     integer        DEFAULT 0
synced_at             timestamptz    DEFAULT now()
```

- UNIQUE `(date, ad_id)` — evita duplicados por dia/ad
- Índices: `(account_id, date)`, `(campaign_id)`, `(date)`
- Referenciada por: `classified_insights.insight_id` (FK importante — `classified_insights` já está no Drizzle)

### 4. `classification_rules` (0 rows)

```
id           integer        PK (serial)
version      integer        DEFAULT 1
dimension    varchar(50)    NOT NULL
source_field varchar(30)    NOT NULL
pattern      text           NOT NULL
value        varchar(100)   NOT NULL
priority     integer        DEFAULT 100
is_active    boolean        DEFAULT true
description  text
created_at   timestamptz    DEFAULT now()
updated_at   timestamptz    DEFAULT now()
```

### 5. `crm_import_mappings` (0 rows)

```
id              text           PK (literal, não-serial)
workspace_id    text           NOT NULL  FK workspaces(id) CASCADE
name            varchar(255)   NOT NULL
description     text
column_mappings jsonb          DEFAULT '{}' NOT NULL
target_fields   jsonb          DEFAULT '[]' NOT NULL
last_used_at    timestamptz
import_count    integer        DEFAULT 0
created_at      timestamptz    DEFAULT now()
updated_at      timestamptz    DEFAULT now()
```

- UNIQUE `(workspace_id, name)`
- Index: `(workspace_id)`

### 6. `hourly_insights` (25.463 rows — MAIOR TABELA)

```
id                 integer        PK (serial)
account_id         integer        FK ad_accounts(id)
date               date           NOT NULL
hour               integer        NOT NULL
campaign_id        varchar(50)    NOT NULL
campaign_name      varchar(500)
adset_id           varchar(50)    NOT NULL
adset_name         varchar(500)
ad_id              varchar(50)    NOT NULL
ad_name            varchar(500)
launch             varchar(50)
phase              varchar(50)
subphase           varchar(100)
capture_type       varchar(50)
audience_category  varchar(10)
temperature        varchar(20)
creative_type      varchar(30)
page               varchar(100)
ebook              varchar(100)
spend              numeric(12,2)  DEFAULT 0
impressions        integer        DEFAULT 0
reach              integer        DEFAULT 0
link_clicks        integer        DEFAULT 0
landing_page_views integer        DEFAULT 0
leads              integer        DEFAULT 0
purchases          integer        DEFAULT 0
purchase_value     numeric(12,2)  DEFAULT 0
video_views_3s     integer        DEFAULT 0
synced_at          timestamptz    DEFAULT now()
```

- UNIQUE `(date, hour, ad_id)`
- Índices: `(date)`, `(date, hour)`, `(date, phase)`, `(phase)`

### 7. `lead_sources` (1 row)

```
id                   integer        PK (serial)
account_id           integer        NOT NULL  FK accounts(id)
name                 varchar(255)   NOT NULL
sheet_id             varchar(255)   NOT NULL
sheet_tab            varchar(100)   DEFAULT 'Leads'
header_row           integer        DEFAULT 1
column_map           jsonb          NOT NULL
campaign_match_rules jsonb
is_active            boolean        DEFAULT true
last_synced_at       timestamptz
last_row_count       integer        DEFAULT 0
created_at           timestamptz    DEFAULT now()
updated_at           timestamptz    DEFAULT now()
```

- Índices: `(account_id)`, `(is_active)`
- Referenciada por: `leads.source_id`

### 8. `leads` (3833 rows)

```
id           integer        PK (serial)
account_id   integer        NOT NULL  FK accounts(id)
source_type  varchar(20)    NOT NULL
source_id    integer        FK lead_sources(id)
email        varchar(320)
email_hash   varchar(64)    NOT NULL
name         varchar(255)
phone        varchar(50)
utm_source   varchar(200)
utm_medium   varchar(200)
utm_campaign varchar(500)
utm_content  varchar(500)
utm_term     varchar(500)
utm_id       varchar(100)
campaign_id  varchar(50)
adset_id     varchar(50)
ad_id        varchar(50)
raw          jsonb
created_at   timestamptz
synced_at    timestamptz    DEFAULT now()
qualificado  boolean
pagina       varchar(200)
objeto       varchar(200)
formato      varchar(100)
temperatura  varchar(30)
evento       varchar(200)
fase         varchar(30)
```

- UNIQUE `(source_type, source_id, email_hash)`
- Índices: `(account_id, created_at)`, `(campaign_id)`, `(evento)`, `(fase)`, `(qualificado)`, `(source_type, source_id)`

### 9. `projects` (1 row)

```
id              text           PK (literal)
workspace_id    text           NOT NULL  FK workspaces(id) CASCADE
name            text           NOT NULL
campaign_filter text           NOT NULL  DEFAULT ''
description     text           DEFAULT ''
status          text           DEFAULT 'active'
created_at      timestamptz    DEFAULT now()
updated_at      timestamptz    DEFAULT now()
```

- Index: `(workspace_id)`

### 10. `saved_views` (0 rows)

```
id           integer        PK (serial)
name         varchar(100)   NOT NULL
filters_json text           NOT NULL
pathname     varchar(255)   DEFAULT '/dashboard'
is_shared    boolean        DEFAULT false
created_by   varchar(255)   DEFAULT 'default'
created_at   timestamptz    DEFAULT now()
updated_at   timestamptz    DEFAULT now()
```

### 11. `sync_logs` (4554 rows)

```
id            integer        PK (serial)
account_id    integer        FK ad_accounts(id)
job_type      varchar(50)    NOT NULL
date_from     date           NOT NULL
date_to       date           NOT NULL
status        varchar(20)    NOT NULL
rows_synced   integer        DEFAULT 0
error_message text
started_at    timestamptz    DEFAULT now()
finished_at   timestamptz
```

---

## Recomendações pro Claude remoto

1. **Criar schema Drizzle pra ad_accounts PRIMEIRO** — é FK pivot de
   `ad_insights`, `hourly_insights`, `sync_logs` e `classified_insights` (que
   já existe). Sem ela, as outras schemas ficam incompletas.

2. **Criar `accounts` (legacy) + `lead_sources` + `leads`** — chain FK:
   `leads → lead_sources → accounts`. Precisam das 3 pra `leads` funcionar.

3. **Criar `ad_insights`** — antes de usar o Drizzle schema de `classified_insights`
   já existente (a FK `classified_insights.insight_id → ad_insights(id)`
   depende dela).

4. **Criar `hourly_insights`, `sync_logs`** (FK → ad_accounts).

5. **Criar `projects`, `crm_import_mappings`** (FK → workspaces).

6. **Criar `saved_views`, `classification_rules`** (sem FKs).

7. **Gerar migration 0002** com drizzle-kit incluindo essas 11 tabelas.

8. **Atualizar `05-transform-and-restore.sh` (Python)** com os mappings
   integer→UUIDv5 pras novas tabelas com PK serial.

9. **Fix do pg_dump** (bloqueador do step 04): atualizar comando em
   `04-pg-dump-data.sh` pra usar `docker run --rm postgres:17-alpine` em vez
   do binário da VPS.

---

## Arquivos de inspeção disponíveis na VPS

- `/tmp/pegasus-ads-neon-inspect/tables.txt` — lista dos 45
- `/tmp/pegasus-ads-neon-inspect/row_counts.tsv` — contagem por tabela
- `/tmp/pegasus-ads-neon-inspect/schema_<table>.txt` — 45 arquivos com `\d`
- `/tmp/pegasus-ads-neon-inspect/non_uuid_pks.tsv` — mapping de PKs serial/text

Posso zipar e push pro repo se for útil — avisa.
