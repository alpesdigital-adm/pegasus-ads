CREATE TABLE "classified_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"insight_id" integer NOT NULL,
	"account_id" bigint,
	"date" date NOT NULL,
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
	"classification_status" varchar(30) DEFAULT 'classified',
	"applied_rule" varchar(200),
	"classification_reason" text,
	"conflicts" text,
	"spend" numeric(12, 2) DEFAULT '0',
	"impressions" integer DEFAULT 0,
	"reach" integer DEFAULT 0,
	"link_clicks" integer DEFAULT 0,
	"landing_page_views" integer DEFAULT 0,
	"leads" integer DEFAULT 0,
	"purchases" integer DEFAULT 0,
	"purchase_value" numeric(12, 2) DEFAULT '0',
	"video_views_3s" integer DEFAULT 0,
	"classified_at" timestamp with time zone DEFAULT now(),
	"effective_status" varchar(30),
	CONSTRAINT "uq_classified_date_ad" UNIQUE("date","ad_id")
);
--> statement-breakpoint
CREATE TABLE "ad_creatives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"launch_id" uuid NOT NULL,
	"angle_id" uuid,
	"ad_name" text NOT NULL,
	"format" text NOT NULL,
	"placement" text,
	"variant" text,
	"hook" text,
	"motor" text,
	"concept_label" text,
	"status" text DEFAULT 'active' NOT NULL,
	"image_url" text,
	"video_url" text,
	"meta_creative_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_ad_creatives_workspace_adname" UNIQUE("workspace_id","ad_name")
);
--> statement-breakpoint
CREATE TABLE "angles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"motor" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_angles_concept_code" UNIQUE("concept_id","code")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_concepts_offer_code" UNIQUE("offer_id","code")
);
--> statement-breakpoint
CREATE TABLE "launches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"starts_at" date,
	"ends_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_launches_workspace_key" UNIQUE("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"offer_type" text DEFAULT 'lead_magnet' NOT NULL,
	"description" text,
	"cpl_target" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_offers_workspace_key" UNIQUE("workspace_id","key")
);
--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_launch_id_launches_id_fk" FOREIGN KEY ("launch_id") REFERENCES "public"."launches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_angle_id_angles_id_fk" FOREIGN KEY ("angle_id") REFERENCES "public"."angles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "angles" ADD CONSTRAINT "angles_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "launches" ADD CONSTRAINT "launches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_classified_account" ON "classified_insights" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_classified_adname" ON "classified_insights" USING btree ("ad_name");--> statement-breakpoint
CREATE INDEX "idx_classified_adname_campaign" ON "classified_insights" USING btree ("ad_name","campaign_id");--> statement-breakpoint
CREATE INDEX "idx_classified_adname_campaign_adset" ON "classified_insights" USING btree ("ad_name","campaign_id","adset_id");--> statement-breakpoint
CREATE INDEX "idx_classified_date_account" ON "classified_insights" USING btree ("date","account_id","phase");--> statement-breakpoint
CREATE INDEX "idx_classified_date_adsetname" ON "classified_insights" USING btree ("date","adset_name");--> statement-breakpoint
CREATE INDEX "idx_classified_date_campaign" ON "classified_insights" USING btree ("date","campaign_id");--> statement-breakpoint
CREATE INDEX "idx_classified_date_phase" ON "classified_insights" USING btree ("date","phase");--> statement-breakpoint
CREATE INDEX "idx_classified_effective_status" ON "classified_insights" USING btree ("effective_status");--> statement-breakpoint
CREATE INDEX "idx_classified_launch_phase" ON "classified_insights" USING btree ("launch","phase");--> statement-breakpoint
CREATE INDEX "idx_classified_phase" ON "classified_insights" USING btree ("phase");--> statement-breakpoint
CREATE INDEX "idx_classified_phase_date_account" ON "classified_insights" USING btree ("phase","date","account_id");--> statement-breakpoint
CREATE INDEX "idx_classified_temperature" ON "classified_insights" USING btree ("temperature");--> statement-breakpoint
CREATE INDEX "idx_ad_creatives_ad_name" ON "ad_creatives" USING btree ("ad_name");--> statement-breakpoint
CREATE INDEX "idx_ad_creatives_offer_id" ON "ad_creatives" USING btree ("offer_id");--> statement-breakpoint
CREATE INDEX "idx_ad_creatives_launch_id" ON "ad_creatives" USING btree ("launch_id");--> statement-breakpoint
CREATE INDEX "idx_ad_creatives_angle_id" ON "ad_creatives" USING btree ("angle_id");