export interface Image {
  id: string;
  name: string;
  category: "dra-priscila" | "marca" | "produto" | "referencia";
  blob_url: string;
  thumbnail_url?: string;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface Creative {
  id: string;
  name: string;
  blob_url: string;
  thumbnail_url?: string;
  prompt?: string;
  prompt_json?: string;
  model?: string;
  width?: number;
  height?: number;
  parent_id?: string;
  generation: number;
  status: "generated" | "testing" | "winner" | "killed" | "paused";
  metadata?: Record<string, unknown>;
  created_at: string;
  // Joined data
  metrics?: MetricsAggregate;
  ref_images?: Image[];
}

export interface CreativeEdge {
  id: string;
  source_id: string;
  target_id: string;
  relationship: "variation" | "iteration" | "style-transfer" | "remix";
  variable_isolated?: string;
  created_at: string;
}

export interface Metrics {
  id: string;
  creative_id: string;
  date: string;
  spend: number;
  impressions: number;
  cpm: number;
  ctr: number;
  clicks: number;
  cpc: number;
  leads: number;
  cpl?: number;
  meta_ad_id?: string;
  created_at: string;
}

export interface MetricsAggregate {
  total_spend: number;
  total_impressions: number;
  avg_cpm: number;
  avg_ctr: number;
  total_clicks: number;
  avg_cpc: number;
  total_leads: number;
  total_lpv: number;
  cpl: number | null;
}

export interface KillRuleResult {
  level: string;
  name: string;
  action: "kill" | "warn" | "promote" | "observe";
}

export interface GraphNode {
  id: string;
  name: string;
  thumbnail_url?: string;
  blob_url: string;
  status: Creative["status"];
  generation: number;
  prompt?: string;
  metrics?: MetricsAggregate;
  created_at: string;
  /** Placements disponíveis para este criativo (ex: ["feed", "stories"]) */
  placements?: string[];
  /** ID do criativo Stories pareado (quando agrupado) */
  stories_id?: string;
  /** Blob URL da versão Stories (quando agrupado) */
  stories_blob_url?: string;
  /** Kill rule ativa para este AD (resultado avaliação L0-L5) */
  kill_rule?: KillRuleResult;
  /** CPL target da campanha (para colorização dinâmica) */
  cpl_target?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: CreativeEdge["relationship"];
  variable_isolated?: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// API Request/Response types
export interface GenerateRequest {
  prompt: string;
  prompt_format?: "text" | "json" | "markdown";
  reference_image_ids?: string[];
  parent_creative_id?: string;
  name?: string;
  aspect_ratio?: string;
  image_size?: string;
  model?: string;
  variable_isolated?: string;
  relationship?: CreativeEdge["relationship"];
}

export interface GenerateResponse {
  creative: Creative;
  edges: CreativeEdge[];
}

export interface UpdateMetricsRequest {
  date: string;
  spend?: number;
  impressions?: number;
  cpm?: number;
  ctr?: number;
  clicks?: number;
  cpc?: number;
  leads?: number;
  cpl?: number;
  meta_ad_id?: string;
}

// ── Delivery 1: Test Automation types ──

export interface Campaign {
  id: string;
  name: string;
  meta_campaign_id: string;
  meta_account_id: string;
  pixel_id?: string;
  page_id?: string;
  instagram_user_id?: string;
  objective: string;
  cpl_target?: number;
  status: "active" | "paused" | "archived";
  config: CampaignConfig;
  created_at: string;
  updated_at: string;
}

export interface CampaignConfig {
  bid_strategy?: string;
  daily_budget?: number;
  attribution_window_days?: number;
  optimization_goal?: string;
  billing_event?: string;
  targeting?: Record<string, unknown>;
  promoted_object?: Record<string, unknown>;
}

export interface TestRound {
  id: string;
  campaign_id: string;
  control_creative_id: string;
  variable_type: string;
  variable_value?: string;
  round_number: number;
  status: TestRoundStatus;
  ai_prompt_used?: string;
  ai_verification: Record<string, unknown>;
  decided_at?: string;
  decision?: "winner" | "loser" | "inconclusive";
  decision_reason?: string;
  created_at: string;
  updated_at: string;
  // Joined
  variants?: TestRoundVariant[];
  campaign?: Campaign;
}

export type TestRoundStatus =
  | "draft"
  | "generating"
  | "reviewing"
  | "publishing"
  | "live"
  | "analyzing"
  | "decided"
  | "failed";

export interface TestRoundVariant {
  id: string;
  test_round_id: string;
  creative_id: string;
  role: "control" | "variant";
  placement?: "feed" | "stories" | "both";
  meta_ad_id?: string;
  meta_adset_id?: string;
  meta_creative_id?: string;
  status: "pending" | "generated" | "verified" | "published" | "live" | "paused" | "killed";
  verification_result: Record<string, unknown>;
  created_at: string;
  // Joined
  creative?: Creative;
  published_ads?: PublishedAd[];
}

export interface PublishedAd {
  id: string;
  variant_id: string;
  creative_id: string;
  meta_ad_id: string;
  meta_adset_id: string;
  meta_creative_id: string;
  meta_image_hash?: string;
  ad_name: string;
  adset_name: string;
  placement: "feed" | "stories";
  status: "pending_review" | "active" | "paused" | "rejected" | "deleted";
  drive_file_id?: string;
  drive_file_name?: string;
  published_at: string;
  created_at: string;
}

export interface PipelineExecution {
  id: string;
  test_round_id?: string;
  pipeline_type: "generate" | "publish" | "analyze" | "kill";
  status: "running" | "completed" | "failed" | "cancelled";
  input_data: Record<string, unknown>;
  output_data: Record<string, unknown>;
  error_message?: string;
  steps: PipelineStep[];
  started_at: string;
  completed_at?: string;
  duration_ms?: number;
}

export interface PipelineStep {
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  started_at?: string;
  completed_at?: string;
  output?: Record<string, unknown>;
  error?: string;
}

// ── Variable Types (config-driven) ──

export interface VariableType {
  id: string;
  name: string;
  description: string;
  category: "visual" | "copy" | "layout" | "offer" | "format";
  prompt_guidance: string;
  examples?: string[];
}

// ── AI Verification ──

export interface VerificationCheckpoint {
  checkpoint: "post_generation" | "pre_publish" | "post_publish" | "analysis";
  passed: boolean;
  score?: number;
  issues: string[];
  suggestions: string[];
  verified_at: string;
}

// ── Meta API specific ──

export interface MetaAdSetConfig {
  name: string;
  campaign_id: string;
  daily_budget?: string;
  bid_strategy: string;
  billing_event: string;
  optimization_goal: string;
  targeting: Record<string, unknown>;
  promoted_object: Record<string, unknown>;
  attribution_spec: Array<{ event_type: string; window_days: number }>;
  status: string;
}

export interface MetaCreativeSpec {
  name: string;
  object_story_spec: {
    page_id: string;
    instagram_user_id?: string;
    link_data: {
      link: string;
      message?: string;
      image_hash?: string;
      call_to_action?: Record<string, unknown>;
    };
  };
  asset_feed_spec?: Record<string, unknown>;
}

// ── Pipeline Requests ──

export interface GenerateTestRequest {
  campaign_id: string;
  control_creative_id: string;
  variable_type: string;
  variable_value?: string;
  num_variants?: number;
}

export interface PublishTestRequest {
  test_round_id: string;
  adset_template_id?: string;
}
