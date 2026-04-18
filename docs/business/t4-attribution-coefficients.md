# T4 — Coeficientes validados de atribuição (2026-03-31)

Inteligência de negócio validada no lançamento T4 (Minoxidil, Dra. Priscila),
preservada aqui como referência histórica quando a rota `/api/attribution` foi
removida na Fase 1C Wave 7 (2026-04-18) por não consumir dados reais.

**Fonte original:** `reference_attribution_model.md` (2026-03-31), consolidado
com 16.136 leads capturados no T4 e 233 matriculados validados via
cross-reference ebook ↔ matrícula.

## Coeficientes

| Métrica                             | Valor     | Amostra               |
|-------------------------------------|-----------|-----------------------|
| CPL ebook first-touch               | R$ 32,77  | ebook de captação     |
| CPL evento direto (sem ebook)       | R$ 58,70  | via evento direto     |
| Conv. rate first-touch              | 1,44%     | 233 / 16.136          |
| Conv. rate total (c/ orgânico)      | 1,95%     | inclui indicação      |
| Multiplicador any-touch (mid-funnel)| 1,65×     | —                     |

## Efeito multi-ebook (conv. leads → matriculados)

| Ebooks por lead | Taxa de conversão |
|-----------------|-------------------|
| 1 ebook         | 1,22%             |
| 2 ebooks        | 4,57%             |
| 3 ou mais       | 6,24%             |

Interpretação: leads que consomem múltiplos ebooks convertem
desproporcionalmente mais. Lead com 3+ ebooks tem ~5× mais chance de matricular
que lead com 1 ebook só.

## Onde usar

- **Projeção de matrículas** a partir de leads: aplicar `conv_rate_first_touch`
  (cenário base) ou `conv_rate_total` (otimista com orgânico).
- **Priorização de campanhas**: comparar CPL real com R$ 32,77 (target first-touch).
- **Estratégia de conteúdo**: investir em jornadas multi-ebook aumenta LTV.

## O que NÃO fazer

- Tratar estes números como "dados de atribuição em tempo real". São
  coeficientes estáticos de uma janela histórica. Projeção baseada neles deve
  declarar isso claramente.
- Aplicar cegamente em lançamentos não-Minoxidil. T4 (produto, persona,
  oferta) tem distribuição específica; outros lançamentos podem divergir.

## Reconstrução futura (se aplicável)

Se virar prioridade ter atribuição real, construir feature nova que:
1. Cruze dados do Neon (leads via UTM) com o CRM (matrícula) por `email`/`cpf`
2. Segmente por campanha via `utm_campaign` (não hardcoded)
3. Atualize coeficientes por janela rolante (ex: últimos 90d) em vez de fixar
   num único lançamento
4. Exponha em `/api/attribution` v2 com contrato honesto (zero dados dummy)
