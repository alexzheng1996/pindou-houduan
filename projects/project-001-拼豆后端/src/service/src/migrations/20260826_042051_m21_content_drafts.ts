import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_articles_section" AS ENUM('guides', 'blog');
  CREATE TYPE "public"."enum_articles_article_type" AS ENUM('tool_guide', 'faq', 'creative', 'product_tutorial', 'case_study', 'announcement');
  CREATE TYPE "public"."enum_articles_author_type" AS ENUM('staff', 'codex_assisted');
  CREATE TYPE "public"."enum_articles_content_quality_fact_check_status" AS ENUM('not_started', 'needs_review', 'checked');
  CREATE TYPE "public"."enum_articles_seo_suggestions_twitter_card" AS ENUM('summary', 'summary_large_image');
  CREATE TYPE "public"."enum_articles_status" AS ENUM('draft');
  CREATE TYPE "public"."enum_article_media_status" AS ENUM('upload_pending', 'ready', 'validation_failed', 'orphaned', 'deleted');
  CREATE TABLE "articles_source_list" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"url" varchar NOT NULL
  );
  
  CREATE TABLE "articles" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"public_id" varchar NOT NULL,
  	"section" "enum_articles_section" NOT NULL,
  	"slug" varchar NOT NULL,
  	"title" varchar NOT NULL,
  	"excerpt" varchar NOT NULL,
  	"body" jsonb NOT NULL,
  	"article_type" "enum_articles_article_type" NOT NULL,
  	"author_type" "enum_articles_author_type" DEFAULT 'staff' NOT NULL,
  	"author_display_name" varchar NOT NULL,
  	"content_quality_topic_intent" varchar,
  	"content_quality_fact_check_status" "enum_articles_content_quality_fact_check_status" DEFAULT 'not_started' NOT NULL,
  	"content_quality_editor_notes" varchar,
  	"seo_suggestions_seo_title" varchar,
  	"seo_suggestions_meta_description" varchar,
  	"seo_suggestions_primary_topic" varchar,
  	"seo_suggestions_twitter_card" "enum_articles_seo_suggestions_twitter_card" DEFAULT 'summary_large_image',
  	"status" "enum_articles_status" DEFAULT 'draft' NOT NULL,
  	"version" numeric DEFAULT 1 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "article_media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"public_id" varchar NOT NULL,
  	"article_id" integer,
  	"uploader_id" integer NOT NULL,
  	"status" "enum_article_media_status" DEFAULT 'upload_pending' NOT NULL,
  	"mime_type" varchar NOT NULL,
  	"size_bytes" numeric NOT NULL,
  	"sha256" varchar NOT NULL,
  	"storage_key" varchar NOT NULL,
  	"alt_text" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "articles_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "article_media_id" integer;
  ALTER TABLE "articles_source_list" ADD CONSTRAINT "articles_source_list_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "article_media" ADD CONSTRAINT "article_media_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "article_media" ADD CONSTRAINT "article_media_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  CREATE INDEX "articles_source_list_order_idx" ON "articles_source_list" USING btree ("_order");
  CREATE INDEX "articles_source_list_parent_id_idx" ON "articles_source_list" USING btree ("_parent_id");
  CREATE UNIQUE INDEX "articles_public_id_idx" ON "articles" USING btree ("public_id");
  CREATE UNIQUE INDEX "articles_slug_idx" ON "articles" USING btree ("slug");
  CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");
  CREATE INDEX "articles_created_at_idx" ON "articles" USING btree ("created_at");
  CREATE INDEX "section_status_updatedAt_idx" ON "articles" USING btree ("section","status","updated_at");
  CREATE UNIQUE INDEX "article_media_public_id_idx" ON "article_media" USING btree ("public_id");
  CREATE INDEX "article_media_article_idx" ON "article_media" USING btree ("article_id");
  CREATE INDEX "article_media_uploader_idx" ON "article_media" USING btree ("uploader_id");
  CREATE UNIQUE INDEX "article_media_storage_key_idx" ON "article_media" USING btree ("storage_key");
  CREATE INDEX "article_media_updated_at_idx" ON "article_media" USING btree ("updated_at");
  CREATE INDEX "article_media_created_at_idx" ON "article_media" USING btree ("created_at");
  CREATE INDEX "article_status_idx" ON "article_media" USING btree ("article_id","status");
  CREATE INDEX "uploader_status_idx" ON "article_media" USING btree ("uploader_id","status");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_articles_fk" FOREIGN KEY ("articles_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_article_media_fk" FOREIGN KEY ("article_media_id") REFERENCES "public"."article_media"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_articles_id_idx" ON "payload_locked_documents_rels" USING btree ("articles_id");
  CREATE INDEX "payload_locked_documents_rels_article_media_id_idx" ON "payload_locked_documents_rels" USING btree ("article_media_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_articles_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_article_media_fk";
  DROP INDEX "payload_locked_documents_rels_articles_id_idx";
  DROP INDEX "payload_locked_documents_rels_article_media_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "articles_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "article_media_id";
   ALTER TABLE "articles_source_list" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "articles" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "article_media" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "articles_source_list" CASCADE;
  DROP TABLE "article_media" CASCADE;
  DROP TABLE "articles" CASCADE;
  DROP TYPE "public"."enum_articles_section";
  DROP TYPE "public"."enum_articles_article_type";
  DROP TYPE "public"."enum_articles_author_type";
  DROP TYPE "public"."enum_articles_content_quality_fact_check_status";
  DROP TYPE "public"."enum_articles_seo_suggestions_twitter_card";
  DROP TYPE "public"."enum_articles_status";
  DROP TYPE "public"."enum_article_media_status";`)
}
