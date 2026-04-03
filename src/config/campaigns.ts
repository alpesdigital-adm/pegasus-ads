/**
 * Campaign Defaults — Configurações padrão para campanhas conhecidas.
 *
 * Centraliza IDs, targeting, promoted_object e outras configs
 * que são reutilizadas entre ad sets da mesma campanha.
 */

export interface CampaignDefaults {
  name: string;
  metaCampaignId: string;
  metaAccountId: string;
  pixelId: string;
  pageId: string;
  instagramUserId: string;
  cplTarget: number;
  bidStrategy: string;
  billingEvent: string;
  optimizationGoal: string;
  dailyBudgetCents: string;
  promotedObject: Record<string, unknown>;
  urlTagsTemplate: string;
  /**
   * Nome da env var que contém o access token Meta para esta conta.
   * Se omitido, usa META_SYSTEM_USER_TOKEN como fallback.
   * Ex: "META_TOKEN_RAT" → process.env.META_TOKEN_RAT
   */
  metaTokenEnvVar?: string;
}

/**
 * Padrão UTM da Alpes Digital.
 */
export const UTM_TEMPLATE =
  "utm_source={{site_source_name}}&utm_medium={{placement}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&utm_id={{ad.id}}";

/**
 * Campanhas cadastradas. Podem ser movidas para o banco futuramente.
 */
export const KNOWN_CAMPAIGNS: Record<string, CampaignDefaults> = {
  T7_0003_RAT: {
    name: "T7__0003",
    metaCampaignId: "120242407847250521",
    metaAccountId: "act_3601611403432716",
    pixelId: "789670008816798",
    pageId: "681873548347022",
    instagramUserId: "17841466553352631",
    cplTarget: 25.0, // R$25 — cenário realista do planejamento
    bidStrategy: "LOWEST_COST_WITHOUT_CAP",
    billingEvent: "IMPRESSIONS",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    dailyBudgetCents: "8000", // R$80/dia
    promotedObject: {
      pixel_id: "789670008816798",
      custom_event_type: "Lead",
    },
    urlTagsTemplate: UTM_TEMPLATE,
    metaTokenEnvVar: "META_TOKEN_RAT", // Conta RAT Academy — fallback: META_SYSTEM_USER_TOKEN
  },

  // ── Conta Alpes Digital (para futuras campanhas de outros produtos) ──
  // ALPES_EXAMPLE: {
  //   name: "ALPES__EXEMPLO",
  //   metaAccountId: "act_XXXXXXXXXXXXXXXXX",
  //   metaTokenEnvVar: "META_TOKEN_ALPES",
  //   ...
  // },
};

/**
 * Retorna config de uma campanha conhecida.
 */
export function getCampaignDefaults(campaignKey: string): CampaignDefaults | null {
  return KNOWN_CAMPAIGNS[campaignKey] || null;
}
