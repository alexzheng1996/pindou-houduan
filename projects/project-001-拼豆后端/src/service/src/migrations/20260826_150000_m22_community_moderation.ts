// M2.2 keeps community governance separate from Better Auth and private Work
// tables. The raw SQL is intentional: these records must never become a broad
// Payload REST/Admin surface just because an operator needs a scoped view.
import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_community_social_visibility" AS ENUM('public', 'hidden');
    CREATE TYPE "public"."enum_community_watchlist_status" AS ENUM('none', 'watching', 'paused');
    CREATE TYPE "public"."enum_community_moderation_target" AS ENUM('post', 'report', 'user');
    CREATE TYPE "public"."enum_community_moderation_action" AS ENUM('featured', 'unfeatured', 'takedown', 'restored', 'deleted', 'report_resolved', 'report_rejected', 'note_created', 'watchlist_updated');

    ALTER TABLE "community_posts"
      ADD COLUMN "is_featured" boolean NOT NULL DEFAULT false,
      ADD COLUMN "featured_at" timestamp(3) with time zone,
      ADD COLUMN "featured_by_id" integer,
      ADD COLUMN "featured_reason" varchar(1000),
      ADD COLUMN "takedown_at" timestamp(3) with time zone,
      ADD COLUMN "deleted_at" timestamp(3) with time zone,
      ADD COLUMN "moderation_updated_at" timestamp(3) with time zone,
      ADD COLUMN "moderation_version" integer NOT NULL DEFAULT 1;

    ALTER TABLE "community_reports"
      ADD COLUMN "version" integer NOT NULL DEFAULT 1,
      ADD COLUMN "handled_by_id" integer,
      ADD COLUMN "handled_at" timestamp(3) with time zone,
      ADD COLUMN "decision_reason_code" varchar(80),
      ADD COLUMN "internal_note" varchar(2000),
      ADD COLUMN "notify_author" boolean,
      ADD COLUMN "notify_reporter" boolean,
      ADD COLUMN "notification_result" varchar(80);

    CREATE TABLE "community_creator_profiles" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "owner_id" integer NOT NULL,
      "display_name" varchar(120),
      "bio" varchar(600),
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_social_links" (
      "id" serial PRIMARY KEY NOT NULL,
      "profile_id" integer NOT NULL,
      "platform" varchar(24) NOT NULL,
      "url" varchar(2000) NOT NULL,
      "visibility" "enum_community_social_visibility" NOT NULL DEFAULT 'hidden',
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_user_ops_profiles" (
      "id" serial PRIMARY KEY NOT NULL,
      "user_id" integer NOT NULL,
      "watchlist_status" "enum_community_watchlist_status" NOT NULL DEFAULT 'none',
      "watch_reason" varchar(1000),
      "owner_staff_id" integer,
      "review_at" timestamp(3) with time zone,
      "version" integer NOT NULL DEFAULT 1,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_user_ops_notes" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "user_id" integer NOT NULL,
      "author_id" integer NOT NULL,
      "body" varchar(2000) NOT NULL,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "expires_at" timestamp(3) with time zone,
      "archived_at" timestamp(3) with time zone,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_moderation_actions" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "target_type" "enum_community_moderation_target" NOT NULL,
      "target_public_id" varchar NOT NULL,
      "actor_id" integer NOT NULL,
      "action" "enum_community_moderation_action" NOT NULL,
      "reason_code" varchar(80),
      "reason_text" varchar(2000),
      "before_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "after_state" jsonb NOT NULL DEFAULT '{}'::jsonb,
      "report_public_id" varchar,
      "request_id" varchar(64) NOT NULL,
      "notification_result" varchar(80),
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_featured_by_fk"
      FOREIGN KEY ("featured_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_handled_by_fk"
      FOREIGN KEY ("handled_by_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_creator_profiles" ADD CONSTRAINT "community_creator_profiles_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_social_links" ADD CONSTRAINT "community_social_links_profile_fk"
      FOREIGN KEY ("profile_id") REFERENCES "public"."community_creator_profiles"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_user_ops_profiles" ADD CONSTRAINT "community_user_ops_profiles_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_user_ops_profiles" ADD CONSTRAINT "community_user_ops_profiles_owner_staff_fk"
      FOREIGN KEY ("owner_staff_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_user_ops_notes" ADD CONSTRAINT "community_user_ops_notes_user_fk"
      FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_user_ops_notes" ADD CONSTRAINT "community_user_ops_notes_author_fk"
      FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_moderation_actions" ADD CONSTRAINT "community_moderation_actions_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE no action;

    CREATE INDEX "community_posts_moderation_queue_idx" ON "community_posts" ("status", "is_featured", "moderation_updated_at", "id");
    CREATE INDEX "community_reports_moderation_queue_idx" ON "community_reports" ("status", "reason", "updated_at", "id");
    CREATE UNIQUE INDEX "community_creator_profiles_public_id_idx" ON "community_creator_profiles" ("public_id");
    CREATE UNIQUE INDEX "community_creator_profiles_owner_idx" ON "community_creator_profiles" ("owner_id");
    CREATE UNIQUE INDEX "community_social_links_profile_platform_idx" ON "community_social_links" ("profile_id", "platform");
    CREATE INDEX "community_social_links_profile_visibility_idx" ON "community_social_links" ("profile_id", "visibility");
    CREATE UNIQUE INDEX "community_user_ops_profiles_user_idx" ON "community_user_ops_profiles" ("user_id");
    CREATE UNIQUE INDEX "community_user_ops_notes_public_id_idx" ON "community_user_ops_notes" ("public_id");
    CREATE INDEX "community_user_ops_notes_user_created_idx" ON "community_user_ops_notes" ("user_id", "created_at");
    CREATE UNIQUE INDEX "community_moderation_actions_public_id_idx" ON "community_moderation_actions" ("public_id");
    CREATE INDEX "community_moderation_actions_target_created_idx" ON "community_moderation_actions" ("target_type", "target_public_id", "created_at");

    ALTER TABLE "community_social_links" ADD CONSTRAINT "community_social_links_platform_check"
      CHECK ("platform" IN ('instagram', 'tiktok', 'youtube', 'pinterest', 'facebook', 'x', 'reddit', 'linkedin'));
    ALTER TABLE "community_user_ops_notes" ADD CONSTRAINT "community_user_ops_notes_tags_array_check"
      CHECK (jsonb_typeof("tags") = 'array');
    -- Both an author withdrawal and a source Work recovery/deletion transition
    -- revoke a current feature immediately. This preserves the derived SEO
    -- rule even when the status change did not originate from the admin API.
    CREATE OR REPLACE FUNCTION "withdraw_community_for_work"() RETURNS trigger AS $$
    DECLARE source_work integer;
    BEGIN
      IF TG_OP = 'DELETE' OR (
        TG_OP = 'UPDATE'
        AND OLD."state" IS DISTINCT FROM NEW."state"
        AND NEW."state" IN ('pending_deletion', 'deleted')
      ) THEN
        source_work := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
        UPDATE "community_posts"
          SET "status" = 'withdrawn', "withdrawn_at" = COALESCE("withdrawn_at", NOW()),
            "is_featured" = false, "featured_at" = NULL, "featured_by_id" = NULL, "featured_reason" = NULL,
            "moderation_version" = "moderation_version" + 1, "moderation_updated_at" = NOW(), "updated_at" = NOW()
          WHERE "source_work_id" = source_work AND "status" = 'published';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "community_posts" DROP CONSTRAINT IF EXISTS "community_posts_featured_by_fk";
    ALTER TABLE "community_reports" DROP CONSTRAINT IF EXISTS "community_reports_handled_by_fk";
    DROP TABLE IF EXISTS "community_moderation_actions" CASCADE;
    DROP TABLE IF EXISTS "community_user_ops_notes" CASCADE;
    DROP TABLE IF EXISTS "community_user_ops_profiles" CASCADE;
    DROP TABLE IF EXISTS "community_social_links" CASCADE;
    DROP TABLE IF EXISTS "community_creator_profiles" CASCADE;
    ALTER TABLE "community_reports"
      DROP COLUMN IF EXISTS "notification_result",
      DROP COLUMN IF EXISTS "notify_reporter",
      DROP COLUMN IF EXISTS "notify_author",
      DROP COLUMN IF EXISTS "internal_note",
      DROP COLUMN IF EXISTS "decision_reason_code",
      DROP COLUMN IF EXISTS "handled_at",
      DROP COLUMN IF EXISTS "handled_by_id",
      DROP COLUMN IF EXISTS "version";
    ALTER TABLE "community_posts"
      DROP COLUMN IF EXISTS "moderation_version",
      DROP COLUMN IF EXISTS "moderation_updated_at",
      DROP COLUMN IF EXISTS "deleted_at",
      DROP COLUMN IF EXISTS "takedown_at",
      DROP COLUMN IF EXISTS "featured_reason",
      DROP COLUMN IF EXISTS "featured_by_id",
      DROP COLUMN IF EXISTS "featured_at",
      DROP COLUMN IF EXISTS "is_featured";
    DROP TYPE IF EXISTS "public"."enum_community_moderation_action";
    DROP TYPE IF EXISTS "public"."enum_community_moderation_target";
    DROP TYPE IF EXISTS "public"."enum_community_watchlist_status";
    DROP TYPE IF EXISTS "public"."enum_community_social_visibility";

    CREATE OR REPLACE FUNCTION "withdraw_community_for_work"() RETURNS trigger AS $$
    DECLARE source_work integer;
    BEGIN
      IF TG_OP = 'DELETE' OR (
        TG_OP = 'UPDATE'
        AND OLD."state" IS DISTINCT FROM NEW."state"
        AND NEW."state" IN ('pending_deletion', 'deleted')
      ) THEN
        source_work := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
        UPDATE "community_posts"
          SET "status" = 'withdrawn', "withdrawn_at" = COALESCE("withdrawn_at", NOW()), "updated_at" = NOW()
          WHERE "source_work_id" = source_work AND "status" = 'published';
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)
}
