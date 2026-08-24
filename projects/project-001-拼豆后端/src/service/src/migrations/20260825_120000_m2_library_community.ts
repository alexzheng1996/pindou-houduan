import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// M2 deliberately uses raw tables instead of Payload collections.  These
// records are part of the versioned business API, while Work/WorkDocument/
// WorkAsset remain the existing owner-only Payload collections.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_library_making_status" AS ENUM('draft', 'to_make', 'making', 'completed');
    CREATE TYPE "public"."enum_community_post_status" AS ENUM('published', 'withdrawn', 'takedown', 'deleted');
    CREATE TYPE "public"."enum_community_media_role" AS ENUM('cover', 'gallery');
    CREATE TYPE "public"."enum_community_media_status" AS ENUM('ready', 'deleted');
    CREATE TYPE "public"."enum_community_report_reason" AS ENUM('copyright', 'adult_violence', 'harassment', 'spam', 'privacy');
    CREATE TYPE "public"."enum_community_report_status" AS ENUM('pending', 'reviewing', 'resolved', 'rejected');

    CREATE TABLE "library_folders" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "owner_id" integer NOT NULL,
      "name" varchar(100) NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "library_labels" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "owner_id" integer NOT NULL,
      "name" varchar(20) NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "work_library_entries" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "owner_id" integer NOT NULL,
      "work_id" integer NOT NULL,
      "folder_id" integer,
      "making_status" "enum_library_making_status" DEFAULT 'draft' NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "work_library_label_links" (
      "entry_id" integer NOT NULL,
      "label_id" integer NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      PRIMARY KEY ("entry_id", "label_id")
    );

    CREATE TABLE "community_posts" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "owner_id" integer NOT NULL,
      "source_work_id" integer,
      "source_work_public_id" varchar NOT NULL,
      "source_work_revision" numeric NOT NULL,
      "author_name_snapshot" varchar(120) NOT NULL,
      "title" varchar(120) NOT NULL,
      "category" varchar(60) NOT NULL,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "copyright_confirmed" boolean NOT NULL,
      "allow_copy" boolean NOT NULL DEFAULT true,
      "status" "enum_community_post_status" NOT NULL DEFAULT 'published',
      "current_version_id" integer,
      "like_count" integer NOT NULL DEFAULT 0,
      "favorite_count" integer NOT NULL DEFAULT 0,
      "published_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "withdrawn_at" timestamp(3) with time zone,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "published_pattern_versions" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "post_id" integer NOT NULL,
      "version_number" integer NOT NULL,
      "source_work_id" integer,
      "source_work_public_id" varchar NOT NULL,
      "source_document_revision" numeric NOT NULL,
      "kind" varchar(20) NOT NULL,
      "document" jsonb NOT NULL,
      "document_sha256" varchar NOT NULL,
      "document_byte_size" numeric NOT NULL,
      "bead_size_mm" numeric,
      "grid_columns" integer NOT NULL,
      "grid_rows" integer NOT NULL,
      "color_count" integer NOT NULL,
      "total_bead_count" integer NOT NULL,
      "difficulty" varchar(20) NOT NULL,
      "author_name_snapshot" varchar(120) NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_post_media" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "post_id" integer,
      "uploader_id" integer NOT NULL,
      "role" "enum_community_media_role" NOT NULL,
      "sort_order" integer NOT NULL DEFAULT 0,
      "mime_type" varchar(100) NOT NULL,
      "size_bytes" numeric NOT NULL DEFAULT 0,
      "sha256" varchar,
      "storage_key" varchar,
      "status" "enum_community_media_status" NOT NULL DEFAULT 'ready',
      "alt_text" varchar(240),
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_likes" (
      "id" serial PRIMARY KEY NOT NULL,
      "post_id" integer NOT NULL,
      "actor_id" integer NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_favorites" (
      "id" serial PRIMARY KEY NOT NULL,
      "post_id" integer NOT NULL,
      "actor_id" integer NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "copy_provenance" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "source_post_id" integer,
      "source_post_public_id" varchar NOT NULL,
      "source_version_id" integer,
      "source_version_public_id" varchar NOT NULL,
      "source_author_name_snapshot" varchar(120) NOT NULL,
      "copied_by_id" integer NOT NULL,
      "copied_work_id" integer NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );
    CREATE TABLE "community_reports" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar NOT NULL,
      "post_id" integer,
      "post_public_id" varchar NOT NULL,
      "reporter_id" integer NOT NULL,
      "reason" "enum_community_report_reason" NOT NULL,
      "details" varchar(1000),
      "status" "enum_community_report_status" NOT NULL DEFAULT 'pending',
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
    );

    ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_current_version_fk"
      FOREIGN KEY ("current_version_id") REFERENCES "published_pattern_versions"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "library_folders" ADD CONSTRAINT "library_folders_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "library_labels" ADD CONSTRAINT "library_labels_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "work_library_entries" ADD CONSTRAINT "work_library_entries_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "work_library_entries" ADD CONSTRAINT "work_library_entries_work_fk"
      FOREIGN KEY ("work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "work_library_entries" ADD CONSTRAINT "work_library_entries_folder_fk"
      FOREIGN KEY ("folder_id") REFERENCES "library_folders"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "work_library_label_links" ADD CONSTRAINT "work_library_label_links_entry_fk"
      FOREIGN KEY ("entry_id") REFERENCES "work_library_entries"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "work_library_label_links" ADD CONSTRAINT "work_library_label_links_label_fk"
      FOREIGN KEY ("label_id") REFERENCES "library_labels"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_owner_fk"
      FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_source_work_fk"
      FOREIGN KEY ("source_work_id") REFERENCES "works"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "published_pattern_versions" ADD CONSTRAINT "published_versions_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "published_pattern_versions" ADD CONSTRAINT "published_versions_source_work_fk"
      FOREIGN KEY ("source_work_id") REFERENCES "works"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "community_post_media" ADD CONSTRAINT "community_media_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_post_media" ADD CONSTRAINT "community_media_uploader_fk"
      FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "community_likes" ADD CONSTRAINT "community_likes_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_likes" ADD CONSTRAINT "community_likes_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_favorites" ADD CONSTRAINT "community_favorites_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_favorites" ADD CONSTRAINT "community_favorites_actor_fk"
      FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "copy_provenance" ADD CONSTRAINT "copy_provenance_source_post_fk"
      FOREIGN KEY ("source_post_id") REFERENCES "community_posts"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "copy_provenance" ADD CONSTRAINT "copy_provenance_source_version_fk"
      FOREIGN KEY ("source_version_id") REFERENCES "published_pattern_versions"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "copy_provenance" ADD CONSTRAINT "copy_provenance_copied_by_fk"
      FOREIGN KEY ("copied_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;
    ALTER TABLE "copy_provenance" ADD CONSTRAINT "copy_provenance_copied_work_fk"
      FOREIGN KEY ("copied_work_id") REFERENCES "works"("id") ON DELETE CASCADE ON UPDATE no action;
    ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_post_fk"
      FOREIGN KEY ("post_id") REFERENCES "community_posts"("id") ON DELETE SET NULL ON UPDATE no action;
    ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_reporter_fk"
      FOREIGN KEY ("reporter_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE no action;

    CREATE UNIQUE INDEX "library_folders_public_id_idx" ON "library_folders" ("public_id");
    CREATE UNIQUE INDEX "library_labels_public_id_idx" ON "library_labels" ("public_id");
    CREATE UNIQUE INDEX "library_folder_owner_name_idx" ON "library_folders" ("owner_id", lower("name"));
    CREATE UNIQUE INDEX "library_label_owner_name_idx" ON "library_labels" ("owner_id", lower("name"));
    CREATE UNIQUE INDEX "work_library_entries_public_id_idx" ON "work_library_entries" ("public_id");
    CREATE UNIQUE INDEX "work_library_entries_owner_work_idx" ON "work_library_entries" ("owner_id", "work_id");
    CREATE INDEX "work_library_entries_owner_updated_idx" ON "work_library_entries" ("owner_id", "updated_at");
    CREATE UNIQUE INDEX "community_posts_public_id_idx" ON "community_posts" ("public_id");
    CREATE INDEX "community_posts_published_idx" ON "community_posts" ("status", "published_at", "id");
    CREATE INDEX "community_posts_owner_idx" ON "community_posts" ("owner_id", "status");
    CREATE UNIQUE INDEX "published_versions_public_id_idx" ON "published_pattern_versions" ("public_id");
    CREATE UNIQUE INDEX "published_versions_post_version_idx" ON "published_pattern_versions" ("post_id", "version_number");
    CREATE INDEX "published_versions_source_work_idx" ON "published_pattern_versions" ("source_work_id");
    CREATE UNIQUE INDEX "community_media_public_id_idx" ON "community_post_media" ("public_id");
    CREATE INDEX "community_media_post_role_idx" ON "community_post_media" ("post_id", "role", "sort_order");
    CREATE INDEX "community_media_uploader_status_idx" ON "community_post_media" ("uploader_id", "status");
    CREATE UNIQUE INDEX "community_likes_actor_post_idx" ON "community_likes" ("actor_id", "post_id");
    CREATE UNIQUE INDEX "community_favorites_actor_post_idx" ON "community_favorites" ("actor_id", "post_id");
    CREATE UNIQUE INDEX "copy_provenance_public_id_idx" ON "copy_provenance" ("public_id");
    CREATE UNIQUE INDEX "copy_provenance_copied_work_idx" ON "copy_provenance" ("copied_work_id");
    CREATE UNIQUE INDEX "community_reports_public_id_idx" ON "community_reports" ("public_id");
    CREATE INDEX "community_reports_post_status_idx" ON "community_reports" ("post_id", "status");

    ALTER TABLE "community_posts" ADD CONSTRAINT "community_posts_tags_array_check"
      CHECK (jsonb_typeof("tags") = 'array');
    ALTER TABLE "community_post_media" ADD CONSTRAINT "community_media_storage_namespace_check"
      CHECK ("storage_key" IS NULL OR "storage_key" LIKE 'community/%');
    ALTER TABLE "published_pattern_versions" ADD CONSTRAINT "published_versions_kind_check"
      CHECK ("kind" IN ('pattern', 'board'));

    CREATE OR REPLACE FUNCTION "enforce_active_work_limit"() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW."document_revision" IS DISTINCT FROM OLD."document_revision" THEN
        IF NOT (OLD."state" = 'pending_deletion' AND NEW."state" = 'active')
          AND NEW."document_revision" <> OLD."document_revision" + 1 THEN
          RAISE EXCEPTION 'WORK_REVISION_CONFLICT' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      IF TG_OP = 'UPDATE' AND OLD."state" IS DISTINCT FROM 'active'
        AND NEW."state" = 'active'
        AND NOT (OLD."state" = 'pending_deletion')
        AND NEW."document_revision" <> OLD."document_revision" + 1 THEN
        RAISE EXCEPTION 'WORK_REVISION_CONFLICT' USING ERRCODE = 'P0001';
      END IF;

      IF NEW."state" = 'active' AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM 'active') THEN
        PERFORM pg_advisory_xact_lock(NEW."owner_id"::bigint);
        IF (SELECT COUNT(*) FROM "works" WHERE "owner_id" = NEW."owner_id" AND "state" = 'active') >= 50 THEN
          RAISE EXCEPTION 'WORK_LIMIT_REACHED' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION "withdraw_community_for_work"() RETURNS trigger AS $$
    DECLARE source_work integer;
    BEGIN
      source_work := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
      UPDATE "community_posts"
        SET "status" = 'withdrawn', "withdrawn_at" = COALESCE("withdrawn_at", NOW()), "updated_at" = NOW()
        WHERE "source_work_id" = source_work AND "status" = 'published';
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS "works_withdraw_community_posts" ON "works";
    CREATE TRIGGER "works_withdraw_community_posts"
      BEFORE UPDATE OF "state" OR DELETE ON "works"
      FOR EACH ROW EXECUTE FUNCTION "withdraw_community_for_work"();
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TRIGGER IF EXISTS "works_withdraw_community_posts" ON "works";
    DROP FUNCTION IF EXISTS "withdraw_community_for_work"();
    DROP TABLE IF EXISTS "community_reports" CASCADE;
    DROP TABLE IF EXISTS "copy_provenance" CASCADE;
    DROP TABLE IF EXISTS "community_favorites" CASCADE;
    DROP TABLE IF EXISTS "community_likes" CASCADE;
    DROP TABLE IF EXISTS "community_post_media" CASCADE;
    DROP TABLE IF EXISTS "published_pattern_versions" CASCADE;
    DROP TABLE IF EXISTS "community_posts" CASCADE;
    DROP TABLE IF EXISTS "work_library_label_links" CASCADE;
    DROP TABLE IF EXISTS "work_library_entries" CASCADE;
    DROP TABLE IF EXISTS "library_labels" CASCADE;
    DROP TABLE IF EXISTS "library_folders" CASCADE;
    DROP TYPE IF EXISTS "public"."enum_community_report_status";
    DROP TYPE IF EXISTS "public"."enum_community_report_reason";
    DROP TYPE IF EXISTS "public"."enum_community_media_status";
    DROP TYPE IF EXISTS "public"."enum_community_media_role";
    DROP TYPE IF EXISTS "public"."enum_community_post_status";
    DROP TYPE IF EXISTS "public"."enum_library_making_status";

    -- Restore the exact M1 advisory-lock function that existed immediately
    -- before M2. The earlier migration owns the trigger; M2 must not leave a
    -- weaker user-row-lock implementation behind when rolled back.
    CREATE OR REPLACE FUNCTION "enforce_active_work_limit"() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW."document_revision" IS DISTINCT FROM OLD."document_revision" THEN
        IF NEW."document_revision" <> OLD."document_revision" + 1 THEN
          RAISE EXCEPTION 'WORK_REVISION_CONFLICT' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      IF TG_OP = 'UPDATE'
        AND OLD."state" IS DISTINCT FROM 'active'
        AND NEW."state" = 'active'
        AND NEW."document_revision" <> OLD."document_revision" + 1 THEN
        RAISE EXCEPTION 'WORK_REVISION_CONFLICT' USING ERRCODE = 'P0001';
      END IF;

      IF NEW."state" = 'active' AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM 'active') THEN
        PERFORM pg_advisory_xact_lock(NEW."owner_id"::bigint);
        IF (SELECT COUNT(*) FROM "works" WHERE "owner_id" = NEW."owner_id" AND "state" = 'active') >= 50 THEN
          RAISE EXCEPTION 'WORK_LIMIT_REACHED' USING ERRCODE = 'P0001';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)
}
