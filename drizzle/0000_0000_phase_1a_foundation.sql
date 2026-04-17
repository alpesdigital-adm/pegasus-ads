CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"password_hash" text,
	"google_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"meta_campaign_id" text NOT NULL,
	"meta_account_id" text NOT NULL,
	"pixel_id" text,
	"page_id" text,
	"instagram_user_id" text,
	"objective" text DEFAULT 'OUTCOME_LEADS',
	"cpl_target" double precision,
	"status" text DEFAULT 'active',
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funnels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"ebook_title" text,
	"cpl_target" double precision,
	"meta_campaign_id" text,
	"meta_account_id" text,
	"active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funnels_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "creative_edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relationship" text DEFAULT 'variation',
	"variable_isolated" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creative_ref_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"creative_id" uuid NOT NULL,
	"image_id" uuid NOT NULL,
	"role" text DEFAULT 'reference',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"blob_url" text NOT NULL,
	"thumbnail_url" text,
	"prompt" text,
	"prompt_json" text,
	"model" text DEFAULT 'gemini-2.5-flash-image',
	"width" integer,
	"height" integer,
	"parent_id" uuid,
	"generation" integer DEFAULT 0,
	"status" text DEFAULT 'generated',
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"is_control" boolean DEFAULT false,
	"funnel_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"blob_url" text NOT NULL,
	"thumbnail_url" text,
	"width" integer,
	"height" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"workspace_id" uuid NOT NULL,
	"crm_id" text NOT NULL,
	"email" text,
	"phone" text,
	"full_name" text,
	"utm_source" text,
	"utm_medium" text,
	"utm_campaign" text,
	"utm_term" text,
	"utm_content" text,
	"fbclid" text,
	"ad_id" text,
	"adset_id" text,
	"campaign_id" text,
	"is_qualified" boolean DEFAULT false,
	"qualification_data" jsonb DEFAULT '{}'::jsonb,
	"subscribed_at" timestamp with time zone,
	"first_subscribed_at" timestamp with time zone,
	"source_file" text,
	"raw_data" jsonb DEFAULT '{}'::jsonb,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_leads_workspace_id_crm_id_pk" PRIMARY KEY("workspace_id","crm_id")
);
--> statement-breakpoint
CREATE TABLE "lead_qualification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_qual_rules_ws_project" UNIQUE("workspace_id","project_key")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"max_creatives" integer DEFAULT 50 NOT NULL,
	"max_campaigns" integer DEFAULT 3 NOT NULL,
	"max_meta_accounts" integer DEFAULT 1 NOT NULL,
	"max_members" integer DEFAULT 1 NOT NULL,
	"max_api_keys" integer DEFAULT 2 NOT NULL,
	"ai_generations_per_month" integer DEFAULT 20 NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_members_role_check" CHECK ("workspace_members"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_settings_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug"),
	CONSTRAINT "workspaces_plan_check" CHECK ("workspaces"."plan" IN ('free', 'pro', 'enterprise'))
);
--> statement-breakpoint
CREATE TABLE "workspace_meta_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"label" text NOT NULL,
	"meta_account_id" text NOT NULL,
	"auth_method" text NOT NULL,
	"token_encrypted" text,
	"oauth_tokens" text,
	"page_id" text,
	"pixel_id" text,
	"instagram_user_id" text,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_meta_accounts_ws_meta" UNIQUE("workspace_id","meta_account_id")
);
--> statement-breakpoint
CREATE TABLE "metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"creative_id" uuid NOT NULL,
	"date" text NOT NULL,
	"spend" double precision DEFAULT 0,
	"impressions" integer DEFAULT 0,
	"cpm" double precision DEFAULT 0,
	"ctr" double precision DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"cpc" double precision DEFAULT 0,
	"leads" integer DEFAULT 0,
	"cpl" double precision,
	"meta_ad_id" text,
	"landing_page_views" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_metrics_creative_date" UNIQUE("creative_id","date")
);
--> statement-breakpoint
CREATE TABLE "metrics_breakdowns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"creative_id" uuid NOT NULL,
	"date" text NOT NULL,
	"publisher_platform" text DEFAULT '' NOT NULL,
	"platform_position" text DEFAULT '' NOT NULL,
	"spend" double precision DEFAULT 0,
	"impressions" integer DEFAULT 0,
	"cpm" double precision DEFAULT 0,
	"ctr" double precision DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"cpc" double precision DEFAULT 0,
	"leads" integer DEFAULT 0,
	"cpl" double precision,
	"meta_ad_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_metrics_bd" UNIQUE("creative_id","date","publisher_platform","platform_position")
);
--> statement-breakpoint
CREATE TABLE "metrics_demographics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"creative_id" uuid NOT NULL,
	"date" text NOT NULL,
	"age" text DEFAULT '' NOT NULL,
	"gender" text DEFAULT '' NOT NULL,
	"spend" double precision DEFAULT 0,
	"impressions" integer DEFAULT 0,
	"cpm" double precision DEFAULT 0,
	"ctr" double precision DEFAULT 0,
	"clicks" integer DEFAULT 0,
	"cpc" double precision DEFAULT 0,
	"leads" integer DEFAULT 0,
	"cpl" double precision,
	"meta_ad_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_metrics_demo" UNIQUE("creative_id","date","age","gender")
);
--> statement-breakpoint
CREATE TABLE "test_round_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_round_id" uuid NOT NULL,
	"creative_id" uuid NOT NULL,
	"role" text DEFAULT 'variant' NOT NULL,
	"placement" text,
	"meta_ad_id" text,
	"meta_adset_id" text,
	"meta_creative_id" text,
	"status" text DEFAULT 'pending',
	"verification_result" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"campaign_id" uuid NOT NULL,
	"control_creative_id" uuid NOT NULL,
	"variable_type" text NOT NULL,
	"variable_value" text,
	"round_number" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft',
	"ai_prompt_used" text,
	"ai_verification" jsonb DEFAULT '{}'::jsonb,
	"decided_at" timestamp with time zone,
	"decision" text,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"variant_id" uuid NOT NULL,
	"creative_id" uuid NOT NULL,
	"meta_ad_id" text NOT NULL,
	"meta_adset_id" text NOT NULL,
	"meta_creative_id" text NOT NULL,
	"meta_image_hash" text,
	"ad_name" text NOT NULL,
	"adset_name" text NOT NULL,
	"placement" text NOT NULL,
	"status" text DEFAULT 'pending_review',
	"drive_file_id" text,
	"drive_file_name" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"creative_id" uuid,
	"campaign_key" text,
	"date" text NOT NULL,
	"level" text NOT NULL,
	"rule_name" text,
	"message" text NOT NULL,
	"spend" double precision,
	"cpl" double precision,
	"cpl_target" double precision,
	"resolved" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hypotheses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"campaign_key" text NOT NULL,
	"variable_dimension" text NOT NULL,
	"variable_code" text,
	"hypothesis" text NOT NULL,
	"rationale" text,
	"priority" integer DEFAULT 5,
	"status" text DEFAULT 'pending',
	"source_creative_ids" jsonb DEFAULT '[]'::jsonb,
	"ai_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visual_elements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"code" text NOT NULL,
	"dimension" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"active_in_meta" boolean DEFAULT false,
	"priority" integer DEFAULT 5,
	"funnel_key" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_visual_elements_code_funnel" UNIQUE("code","funnel_key")
);
--> statement-breakpoint
CREATE TABLE "pipeline_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"test_round_id" uuid,
	"pipeline_type" text NOT NULL,
	"status" text DEFAULT 'running',
	"input_data" jsonb DEFAULT '{}'::jsonb,
	"output_data" jsonb DEFAULT '{}'::jsonb,
	"error_message" text,
	"steps" jsonb DEFAULT '[]'::jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creative_id" uuid,
	"prompt_text" text NOT NULL,
	"prompt_format" text DEFAULT 'text',
	"model" text,
	"reference_image_ids" jsonb DEFAULT '[]'::jsonb,
	"response_raw" text,
	"tokens_used" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funnels" ADD CONSTRAINT "funnels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_edges" ADD CONSTRAINT "creative_edges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_edges" ADD CONSTRAINT "creative_edges_source_id_creatives_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_edges" ADD CONSTRAINT "creative_edges_target_id_creatives_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_ref_images" ADD CONSTRAINT "creative_ref_images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_ref_images" ADD CONSTRAINT "creative_ref_images_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_ref_images" ADD CONSTRAINT "creative_ref_images_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_parent_id_creatives_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_qualification_rules" ADD CONSTRAINT "lead_qualification_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_meta_accounts" ADD CONSTRAINT "workspace_meta_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics" ADD CONSTRAINT "metrics_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_breakdowns" ADD CONSTRAINT "metrics_breakdowns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_breakdowns" ADD CONSTRAINT "metrics_breakdowns_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_demographics" ADD CONSTRAINT "metrics_demographics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metrics_demographics" ADD CONSTRAINT "metrics_demographics_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_round_variants" ADD CONSTRAINT "test_round_variants_test_round_id_test_rounds_id_fk" FOREIGN KEY ("test_round_id") REFERENCES "public"."test_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_round_variants" ADD CONSTRAINT "test_round_variants_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rounds" ADD CONSTRAINT "test_rounds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rounds" ADD CONSTRAINT "test_rounds_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_rounds" ADD CONSTRAINT "test_rounds_control_creative_id_creatives_id_fk" FOREIGN KEY ("control_creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_ads" ADD CONSTRAINT "published_ads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_ads" ADD CONSTRAINT "published_ads_variant_id_test_round_variants_id_fk" FOREIGN KEY ("variant_id") REFERENCES "public"."test_round_variants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_ads" ADD CONSTRAINT "published_ads_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hypotheses" ADD CONSTRAINT "hypotheses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visual_elements" ADD CONSTRAINT "visual_elements_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_executions" ADD CONSTRAINT "pipeline_executions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_executions" ADD CONSTRAINT "pipeline_executions_test_round_id_test_rounds_id_fk" FOREIGN KEY ("test_round_id") REFERENCES "public"."test_rounds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_creative_id_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."creatives"("id") ON DELETE no action ON UPDATE no action;