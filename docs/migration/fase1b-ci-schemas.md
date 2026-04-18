# Fase 1B — Creative Intelligence tables (extraídas do Neon)

**Data:** 2026-04-17
**Origem:** `pegasus-ads/neondb_owner@neon.tech/neondb`
**Handoff:** gêmeo VPS → Claude remoto (adicionar schemas em `src/lib/db/schema/`)

As 6 tabelas abaixo foram criadas fora do `initDb()` em ~2026-04-12 (TD-008).
Precisam ser adicionadas ao Drizzle antes do `pg_dump` da Fase 1B, senão o
restore perde dados.

## Contagem de linhas (antes do dump)

| tabela              | rows |
|---------------------|-----:|
| offers              |    2 |
| concepts            |    5 |
| angles              |   23 |
| launches            |    1 |
| ad_creatives        |   81 |
| classified_insights | 2755 |

---

## 1. `offers`

```
id             integer  NOT NULL  DEFAULT nextval('offers_id_seq'::regclass)
workspace_id   text     NOT NULL
key            text     NOT NULL
name           text     NOT NULL
offer_type     text     NOT NULL  DEFAULT 'lead_magnet'
description    text
cpl_target     numeric(10,2)
created_at     timestamptz NOT NULL DEFAULT now()
```

- PK: `(id)`
- UNIQUE: `uq_offers_workspace_key (workspace_id, key)`
- Referenciada por: `concepts.offer_id` (CASCADE), `ad_creatives.offer_id` (NO ACTION)

## 2. `concepts`

```
id           integer  NOT NULL  DEFAULT nextval('concepts_id_seq'::regclass)
offer_id     integer  NOT NULL
code         text     NOT NULL
name         text     NOT NULL
description  text
created_at   timestamptz NOT NULL DEFAULT now()
```

- PK: `(id)`
- UNIQUE: `uq_concepts_offer_code (offer_id, code)`
- FK: `offer_id → offers(id) ON DELETE CASCADE`
- Referenciada por: `angles.concept_id` (CASCADE)

## 3. `angles`

```
id           integer  NOT NULL  DEFAULT nextval('angles_id_seq'::regclass)
concept_id   integer  NOT NULL
code         text     NOT NULL
name         text     NOT NULL
motor        text
description  text
created_at   timestamptz NOT NULL DEFAULT now()
```

- PK: `(id)`
- UNIQUE: `uq_angles_concept_code (concept_id, code)`
- FK: `concept_id → concepts(id) ON DELETE CASCADE`
- Referenciada por: `ad_creatives.angle_id` (NO ACTION)

## 4. `launches`

```
id            integer  NOT NULL  DEFAULT nextval('launches_id_seq'::regclass)
workspace_id  text     NOT NULL
key           text     NOT NULL
name          text     NOT NULL
starts_at     date
ends_at       date
created_at    timestamptz NOT NULL DEFAULT now()
```

- PK: `(id)`
- UNIQUE: `uq_launches_workspace_key (workspace_id, key)`
- Referenciada por: `ad_creatives.launch_id` (NO ACTION)

## 5. `ad_creatives`

```
id                integer  NOT NULL  DEFAULT nextval('ad_creatives_id_seq'::regclass)
workspace_id      text     NOT NULL
offer_id          integer  NOT NULL
launch_id         integer  NOT NULL
angle_id          integer
ad_name           text     NOT NULL
format            text     NOT NULL
placement         text
variant           text
hook              text
motor             text
concept_label     text
status            text     NOT NULL  DEFAULT 'active'
image_url         text
video_url         text
meta_creative_id  bigint
created_at        timestamptz NOT NULL DEFAULT now()
```

- PK: `(id)`
- UNIQUE: `uq_ad_creatives_workspace_adname (workspace_id, ad_name)`
- Índices btree: `(ad_name)`, `(angle_id)`, `(launch_id)`, `(offer_id)`
- FKs:
  - `offer_id → offers(id)`
  - `launch_id → launches(id)`
  - `angle_id → angles(id)`

## 6. `classified_insights`

```
id                     integer  NOT NULL  DEFAULT nextval('classified_insights_id_seq'::regclass)
insight_id             integer  NOT NULL
account_id             bigint
date                   date     NOT NULL
campaign_id            varchar(50)  NOT NULL
campaign_name          varchar(500)
adset_id               varchar(50)  NOT NULL
adset_name             varchar(500)
ad_id                  varchar(50)  NOT NULL
ad_name                varchar(500)
launch                 varchar(50)
phase                  varchar(50)
subphase               varchar(100)
capture_type           varchar(50)
audience_category      varchar(10)
temperature            varchar(20)
creative_type          varchar(30)
page                   varchar(100)
ebook                  varchar(100)
classification_status  varchar(30)   DEFAULT 'classified'
applied_rule           varchar(200)
classification_reason  text
conflicts              text
spend                  numeric(12,2) DEFAULT 0
impressions            integer       DEFAULT 0
reach                  integer       DEFAULT 0
link_clicks            integer       DEFAULT 0
landing_page_views     integer       DEFAULT 0
leads                  integer       DEFAULT 0
purchases              integer       DEFAULT 0
purchase_value         numeric(12,2) DEFAULT 0
video_views_3s         integer       DEFAULT 0
classified_at          timestamptz   DEFAULT now()
effective_status       varchar(30)
```

- PK: `(id)`
- UNIQUE: `uq_classified_date_ad (date, ad_id)`
- Índices btree:
  - `idx_classified_account (account_id)`
  - `idx_classified_adname (ad_name)`
  - `idx_classified_adname_campaign (ad_name, campaign_id)`
  - `idx_classified_adname_campaign_adset (ad_name, campaign_id, adset_id)`
  - `idx_classified_date_account (date, account_id, phase)`
  - `idx_classified_date_adsetname (date DESC, adset_name)`
  - `idx_classified_date_campaign (date DESC, campaign_id)`
  - `idx_classified_date_phase (date, phase)`
  - `idx_classified_effective_status (effective_status)`
  - `idx_classified_launch_phase (launch, phase)`
  - `idx_classified_phase (phase)`
  - `idx_classified_phase_date_account (phase, date DESC, account_id)`
  - `idx_classified_temperature (temperature)`
- FKs:
  - `account_id → ad_accounts(id)` (NO ACTION, nullable)
  - `insight_id → ad_insights(id)` (NO ACTION)

---

## Notas pra quem for escrever os schemas Drizzle

1. **IDs serão migrados pra UUID** conforme plano v1.3 (UUIDv5 determinístico a
   partir do legado `id`). Os FKs abaixo referenciam `(id)` integer — na Fase
   1B os schemas Drizzle devem usar `uuid` e a transformação acontece no
   `pg_restore` via mapping table.

2. **`workspace_id` está como `text`** hoje — o plano v1.3 padroniza como
   `uuid`. A conversão também é feita no dump/restore.

3. **`classified_insights.insight_id` referencia `ad_insights`** — `ad_insights`
   já está no schema Drizzle (tabela de hot data), então a FK é resolvível.
   Mas vale conferir que o schema novo mantém o link.

4. **`account_id bigint` em `classified_insights`** é o `ad_accounts.id` (Meta
   account ID numérico). Continua bigint no schema novo.

5. **Sequences**: drizzle-kit vai gerar tudo com UUID default quando a gente
   migrar, então os sequences ficam inertes. Pode dropar depois do restore.
