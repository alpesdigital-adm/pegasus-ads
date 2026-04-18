CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meta_account_id" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"access_token" text NOT NULL,
	"app_secret" text,
	"api_version" varchar(10) DEFAULT 'v25.0',
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_meta_account_id_unique" UNIQUE("meta_account_id")
);
--> statement-breakpoint
CREATE TABLE "ad_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"date" date NOT NULL,
	"campaign_id" varchar(50) NOT NULL,
	"campaign_name" varchar(500),
	"adset_id" varchar(50) NOT NULL,
	"adset_name" varchar(500),
	"ad_id" varchar(50) NOT NULL,
	"ad_name" varchar(500),
	"spend" numeric(12, 2) DEFAULT '0',
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"link_clicks" integer DEFAULT 0,
	"landing_page_views" integer DEFAULT 0,
	"leads" integer DEFAULT 0,
	"add_to_wishlist" integer DEFAULT 0,
	"add_to_cart" integer DEFAULT 0,
	"initiate_checkout" integer DEFAULT 0,
	"purchases" integer DEFAULT 0,
	"purchase_value" numeric(12, 2) DEFAULT '0',
	"video_views_3s" integer DEFAULT 0,
	"video_views_25" integer DEFAULT 0,
	"video_views_50" integer DEFAULT 0,
	"video_views_75" integer DEFAULT 0,
	"video_views_95" integer DEFAULT 0,
	"profile_visits" integer DEFAULT 0,
	"new_followers" integer DEFAULT 0,
	"comments" integer DEFAULT 0,
	"reactions" integer DEFAULT 0,
	"shares" integer DEFAULT 0,
	"saves" integer DEFAULT 0,
	"conversations_started" integer DEFAULT 0,
	"messages_received" integer DEFAULT 0,
	"synced_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_ad_insights_date_ad" UNIQUE("date","ad_id")
);
--> statement-breakpoint
CREATE TABLE "hourly_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"date" date NOT NULL,
	"hour" integer NOT NULL,
	"campaign_id" varchar(50) NOT NULL,
	"campaign_name" varchar(500),
	"adset_id" varchar(50) NOT NULL,
	"adset_name" varchar(500),
	"ad_id" varchar(50) NOT NULL,
	"ad_name" varchar(500),
	"launch" varchar(50),
	"phase" varchar(50),
	"subphase" varchar(100),
	"capture_type" varchar(50),
	"audience_category" varchar(10),
	"temperature" varchar(20),
	"creative_type" varchar(30),
	"page" varchar(100),
	"ebook" varchar(100),
	"spend" numeric(12, 2) DEFAULT '0',
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"link_clicks" integer DEFAULT 0,
	"landing_page_views" integer DEFAULT 0,
	"leads" integer DEFAULT 0,
	"purchases" integer DEFAULT 0,
	"purchase_value" numeric(12, 2) DEFAULT '0',
	"video_views_3s" integer DEFAULT 0,
	"synced_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "uq_hourly_insights_date_hour_ad" UNIQUE("date","hour","ad_id")
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"job_type" varchar(50) NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"status" varchar(20) NOT NULL,
	"rows_synced" integer DEFAULT 0,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"meta_access_token" text,
	"meta_account_id" varchar(50),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "lead_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"sheet_id" varchar(255) NOT NULL,
	"sheet_tab" varchar(100) DEFAULT 'Leads',
	"header_row" integer DEFAULT 1,
	"column_map" jsonb NOT NULL,
	"campaign_match_rules" jsonb,
	"is_active" boolean DEFAULT true,
	"last_synced_at" timestamp with time zone,
	"last_row_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source_type" varchar(20) NOT NULL,
	"source_id" uuid,
	"email" varchar(320),
	"email_hash" varchar(64) NOT NULL,
	"name" varchar(255),
	"phone" varchar(50),
	"utm_source" varchar(200),
	"utm_medium" varchar(200),
	"utm_campaign" varchar(500),
	"utm_content" varchar(500),
	"utm_term" varchar(500),
	"utm_id" varchar(100),
	"campaign_id" varchar(50),
	"adset_id" varchar(50),
	"ad_id" varchar(50),
	"raw" jsonb,
	"created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now(),
	"qualificado" boolean,
	"pagina" varchar(200),
	"objeto" varchar(200),
	"formato" varchar(100),
	"temperatura" varchar(30),
	"evento" varchar(200),
	"fase" varchar(30),
	CONSTRAINT "uq_leads_source_email" UNIQUE("source_type","source_id","email_hash")
);
--> statement-breakpoint
CREATE TABLE "crm_import_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"column_mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"import_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_crm_import_mappings_ws_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"campaign_filter" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '',
	"status" text DEFAULT 'active',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "classification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer DEFAULT 1,
	"dimension" varchar(50) NOT NULL,
	"source_field" varchar(30) NOT NULL,
	"pattern" text NOT NULL,
	"value" varchar(100) NOT NULL,
	"priority" integer DEFAULT 100,
	"is_active" boolean DEFAULT true,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"filters_json" text NOT NULL,
	"pathname" varchar(255) DEFAULT '/dashboard',
	"is_shared" boolean DEFAULT false,
	"created_by" varchar(255) DEFAULT 'default',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "classified_insights" ALTER COLUMN "insight_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "classified_insights" ALTER COLUMN "account_id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "ad_insights" ADD CONSTRAINT "ad_insights_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hourly_insights" ADD CONSTRAINT "hourly_insights_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_lead_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."lead_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_import_mappings" ADD CONSTRAINT "crm_import_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ad_insights_account_date" ON "ad_insights" USING btree ("account_id","date");--> statement-breakpoint
CREATE INDEX "idx_ad_insights_campaign" ON "ad_insights" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_ad_insights_date" ON "ad_insights" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_hourly_insights_date" ON "hourly_insights" USING btree ("date");--> statement-breakpoint
CREATE INDEX "idx_hourly_insights_date_hour" ON "hourly_insights" USING btree ("date","hour");--> statement-breakpoint
CREATE INDEX "idx_hourly_insights_date_phase" ON "hourly_insights" USING btree ("date","phase");--> statement-breakpoint
CREATE INDEX "idx_hourly_insights_phase" ON "hourly_insights" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "idx_lead_sources_account" ON "lead_sources" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_lead_sources_active" ON "lead_sources" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "idx_leads_account_created" ON "leads" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_leads_campaign" ON "leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "idx_leads_evento" ON "leads" USING btree ("evento");--> statement-breakpoint
CREATE INDEX "idx_leads_fase" ON "leads" USING btree ("fase");--> statement-breakpoint
CREATE INDEX "idx_leads_qualificado" ON "leads" USING btree ("qualificado");--> statement-breakpoint
CREATE INDEX "idx_leads_source" ON "leads" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "idx_crm_import_mappings_workspace" ON "crm_import_mappings" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_projects_workspace" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "classified_insights" ADD CONSTRAINT "classified_insights_insight_id_ad_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "public"."ad_insights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "classified_insights" ADD CONSTRAINT "classified_insights_account_id_ad_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE no action ON UPDATE no action;