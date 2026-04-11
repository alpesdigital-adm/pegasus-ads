# Pegasus Ads — API Reference

> **Base URL:** `https://pegasus.alpesd.com.br`
> **Auth:** Header `x-api-key: <sua_chave>` em todos os endpoints protegidos
> **Meta API Version:** v25.0

---

## POST /api/ads/publish-to-adsets

Publica criativos de imagem em ad sets de uma campanha. Aceita imagens unicas ou pares F/S (Feed + Stories).

### Funcionalidades implementadas

| Gap | Descricao |
|-----|-----------|
| G1 | Override de link via campo `link` (substitui link do model_ad) |
| G2 | Filtro de adsets via `adset_ids[]` (vazio = publica em todos) |
| G3 | Clone de adset com `source_adset_id` + `new_adset_name` + `daily_budget_cents` |
| G5 | `image_hash` aceito diretamente (pula upload -- Meta ja tem a imagem) |
| G8 | Retry automatico com backoff exponencial em rate limit Meta (codigo 17) |
| G9 | `model_ad_id` opcional -- aceita `page_id` + `instagram_user_id` + `account_id` diretamente |
| G10 | **Pareamento F/S automatico** -- pares de imagens com sufixo F/S viram um unico ad |
| G11 | **Auto-testimonial** -- gerado automaticamente quando `partnership.sponsor_id` set e `testimonial` vazio |

### Body (JSON)

```json
{
  "campaign_id": "120242550231280521",

  "model_ad_id": "120242550231240521",
  "page_id": "123456789",
  "instagram_user_id": "17841400000000001",
  "account_id": "act_3601611403432716",

  "link": "https://exemplo.com/pagina",

  "adset_ids": ["120242870106240521"],

  "source_adset_id": "120242521315670521",
  "new_adset_name": "PA__INSTA365D_SEGUIDORES",
  "daily_budget_cents": 50000,

  "ads": [
    {
      "name": "T4EBANP-AD01F",
      "image_hash": "abc123def456...",
      "image_base64": "iVBOR...",
      "image_filename": "T4EBANP-AD01F.png",
      "body": "Texto principal do ad...",
      "title": "Headline do ad",
      "description": "",
      "cta_type": "DOWNLOAD"
    },
    {
      "name": "T4EBANP-AD01S",
      "image_hash": "xyz789...",
      "image_filename": "T4EBANP-AD01S.png",
      "body": "Texto principal do ad...",
      "title": "Headline do ad",
      "description": "",
      "cta_type": "DOWNLOAD"
    }
  ],

  "partnership": {
    "sponsor_id": "17841400601834755",
    "testimonial": ""
  }
}
```

### Comportamento G10 -- Pareamento F/S

- Nomes com sufixo `F` maiusculo = imagem de Feed
- Nomes com sufixo `S` maiusculo = imagem de Stories
- Par com mesmo nome base -> **1 unico ad** com `placement_customizations.story.image_hash`
- Imagens sem sufixo F/S -> publicadas como ad unico (single)
- Exemplo: `T4EBANP-AD01F` + `T4EBANP-AD01S` -> ad `T4EBANP-AD01`

### Comportamento G11 -- Auto-testimonial

Quando `partnership.sponsor_id` esta preenchido mas `testimonial` esta vazio, o sistema gera automaticamente uma frase persuasiva baseada no conteudo de `body` + `title`. Contextos detectados: anamnese capilar, minoxidil, tricologia, conteudo gratuito, formacao.

### Resposta (200)

```json
{
  "campaign_id": "120242550231280521",
  "adsets_processed": 1,
  "total_ads_created": 8,
  "paired_groups": 8,
  "results": [
    {
      "adset_id": "120242870106240521",
      "adset_name": "PA__INSTA365D_SEGUIDORES",
      "ads_created": 8,
      "groups": [
        {
          "name": "T4EBANP-AD01",
          "type": "paired",
          "feed_image": "abc123...",
          "stories_image": "xyz789...",
          "ad_id": "120242871000000001",
          "creative_id": "120242871000000002"
        }
      ]
    }
  ]
}
```

---

## POST /api/ads/publish-videos

Publica criativos de video, criando novo ad set (via clone) ou publicando em ad set existente.

### Funcionalidades implementadas

| Gap | Descricao |
|-----|-----------|
| G1 | Override de link via campo `link` |
| G4 | Branded content (partnership) propagado para `createVideoCreative` |
| G7 | `video_url` pode apontar para `/api/videos/temp/{filename}` (VPS temp hosting) |
| G8 | Retry automatico com backoff exponencial em rate limit Meta (codigo 17) |
| G9 | `model_ad_id` opcional -- aceita `page_id` + `instagram_user_id` + `account_id` diretamente |
| G11 | Auto-testimonial quando `partnership.sponsor_id` set e `testimonial` vazio |
| G12 | `target_adset_id` -- publica em adset existente (pula clone e rename) |

### Body (JSON)

```json
{
  "target_adset_id": "120242870106240521",

  "source_adset_id": "120242521315670521",
  "new_adset_name": "PA__INSTA365D_SEGUIDORES",
  "daily_budget_cents": 50000,

  "model_ad_id": "120242521326410521",
  "page_id": "123456789",
  "instagram_user_id": "17841400000000001",
  "account_id": "act_3601611403432716",

  "link": "https://exemplo.com/pagina",

  "start_paused": true,

  "partnership": {
    "sponsor_id": "17841400601834755",
    "testimonial": ""
  },

  "ads": [
    {
      "name": "T4EBANP-AD09VD",
      "video_url": "https://pegasus.alpesd.com.br/api/videos/temp/abc123def456abcd.mp4",
      "body": "Texto principal...",
      "title": "Headline",
      "description": "",
      "cta_type": "DOWNLOAD"
    }
  ]
}
```

### Comportamento G12

- Se `target_adset_id` fornecido: usa o adset existente diretamente, sem clonar
- O `campaign_id` e inferido automaticamente buscando o adset na Meta API
- `source_adset_id`, `new_adset_name` e `daily_budget_cents` sao ignorados quando `target_adset_id` presente
- **Regra de negocio:** o nome do adset de videos deve ser IDENTICO ao adset de audience correspondente -- nao criar adset separado por tipo de criativo

### Pipeline interno

1. Se `target_adset_id`: usa adset existente; senao: clona via `/{source_adset_id}/copies`
2. Resolve `page_id`, `instagram_user_id`, `account_id` (do model_ad ou direto via G9)
3. Para cada video (em paralelo):
   - POST `/act_X/advideos` com `file_url`
   - Polling `/{video_id}?fields=status` ate `video_status=ready` (max 240s)
   - Busca thumbnail via `/{video_id}/thumbnails`
   - Cria criativo com `object_story_spec.video_data` (inclui partnership se G4)
   - Cria ad com `adset_id` + `creative_id`
4. Ativa adset se `start_paused=false`

### Resposta (200)

```json
{
  "adset_id": "120242870106240521",
  "adset_name": "PA__INSTA365D_SEGUIDORES",
  "ads_created": 3,
  "ads": [
    {
      "name": "T4EBANP-AD09VD",
      "ad_id": "120242871000000001",
      "creative_id": "120242871000000002",
      "video_id": "1234567890"
    }
  ]
}
```

---

## POST /api/adsets/pause  (G6)

Pausa um ou mais ad sets.

### Body (JSON)

```json
{
  "adset_ids": ["120242521315670521", "120242521315670522"]
}
```

### Resposta (200)

```json
{
  "total": 2,
  "successful": 2,
  "failed": 0,
  "results": [
    { "adset_id": "120242521315670521", "success": true }
  ]
}
```

---

## POST /api/adsets/archive  (G6)

Arquiva (delecao logica) um ou mais ad sets. **Acao irreversivel via API.**

### Body (JSON)

```json
{
  "adset_ids": ["120242521315670521"]
}
```

### Resposta (200)

```json
{
  "total": 1,
  "successful": 1,
  "failed": 0,
  "results": [
    { "adset_id": "120242521315670521", "success": true }
  ]
}
```

---

## POST /api/videos/upload-temp  (G7)

Faz upload de um arquivo de video para pasta temporaria na VPS. A URL retornada e publica e pode ser passada diretamente como `video_url` em `/api/ads/publish-videos`. O arquivo e **deletado automaticamente apos 1 hora**.

### Body (multipart/form-data)

| Campo | Tipo | Descricao |
|-------|------|-----------|
| `file` | File (MP4/MOV/AVI/MKV) | Arquivo de video |
| `name` | string | Nome original (ex: `T4EBANP-AD09VD.mp4`) |

### Resposta (200)

```json
{
  "url": "https://pegasus.alpesd.com.br/api/videos/temp/a1b2c3d4e5f6g7h8.mp4",
  "filename": "a1b2c3d4e5f6g7h8.mp4",
  "original_name": "T4EBANP-AD09VD.mp4",
  "size": 12345678,
  "expires_in_seconds": 3600
}
```

**Fluxo completo de upload de video:**
1. `POST /api/videos/upload-temp` com o arquivo -> obtem `url`
2. Usa `url` como `video_url` em `POST /api/ads/publish-videos`
3. Apos publicacao, a Meta ja baixou o video -- o arquivo temp expira em 1h ou pode ser deletado manualmente

---

## GET /api/videos/temp/{filename}  (G7)

Serve arquivos de video temporarios. **Endpoint publico** (sem autenticacao) -- necessario para a Meta API baixar o video durante upload. Seguranca por obscuridade: nomes hex 16 bytes aleatorios.

### Resposta

Stream do arquivo com `Content-Type: video/mp4`.

---

## DELETE /api/videos/temp/{filename}  (G7)

Deleta manualmente um arquivo temporario antes da expiracao automatica.

### Headers

```
x-api-key: <sua_chave>
```

### Resposta (200)

```json
{ "success": true, "filename": "a1b2c3d4e5f6g7h8.mp4" }
```

---

## Comportamentos Globais

### G8 -- Rate Limit com Backoff Exponencial

Todos os endpoints que chamam a Meta API usam retry automatico quando recebem erro codigo 17 (rate limit):

| Tentativa | Espera |
|-----------|--------|
| 1a retry  | 5s     |
| 2a retry  | 10s    |
| 3a retry  | 20s    |
| 4a retry  | 40s    |

### G9 -- Resolucao de Identidade

`model_ad_id` e opcional em ambos os endpoints de publicacao. Se nao fornecido, passar diretamente: `page_id`, `instagram_user_id`, `account_id` (formato `act_XXXXXXX`).

### Autenticacao

Todos os endpoints exceto `GET /api/videos/temp/{filename}` requerem:
```
x-api-key: <chave_api>
```

---

## Convencoes de Nomenclatura de Criativos

| Padrao | Significado |
|--------|-------------|
| `T4EBANP-AD01F` | Campanha T4, produto EBANP, ad 01, placement **Feed** |
| `T4EBANP-AD01S` | Campanha T4, produto EBANP, ad 01, placement **Stories** |
| `T4EBANP-AD09VD` | Campanha T4, produto EBANP, ad 09, tipo **Video** |
| `T7EBMX-AD026VD` | Campanha T7, produto EBMX, ad 026, tipo Video |

**Regra de naming de adsets:** O nome do adset deve refletir o **publico/audience**, nao o tipo de criativo.
- Correto: `PA__INSTA365D_SEGUIDORES`
- Errado: `T4EBANP_VIDEOS_9x16`

---

## Historico de Gaps Implementados

| Gap | Data       | Descricao |
|-----|------------|-----------|
| G1  | 2026-04-11 | Override de link via payload |
| G2  | 2026-04-11 | Filtro por adset_ids[] |
| G3  | 2026-04-11 | Clone de adset com budget |
| G4  | 2026-04-11 | Partnership/branded content em videos |
| G5  | 2026-04-11 | image_hash direto (sem re-upload) |
| G6  | 2026-04-11 | Endpoints /api/adsets/pause e /archive |
| G7  | 2026-04-11 | VPS temp video hosting |
| G8  | 2026-04-11 | Retry backoff exponencial Meta rate limit |
| G9  | 2026-04-11 | model_ad_id opcional |
| G10 | 2026-04-11 | Pareamento automatico F/S em placement_customizations |
| G11 | 2026-04-11 | Auto-testimonial em ads de parceria |
| G12 | 2026-04-11 | target_adset_id para usar adset existente em videos |
