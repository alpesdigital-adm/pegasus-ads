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
  cpl: number | null;
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
