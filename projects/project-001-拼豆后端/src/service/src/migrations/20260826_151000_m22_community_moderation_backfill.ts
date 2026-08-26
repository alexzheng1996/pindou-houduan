// This is a forward-only companion to M2.2. The first governance migration
// may already have run in local development, so existing history is repaired
// through an explicit reviewed migration rather than by altering it in place.
import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

const withdrawFunction = sql`
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
`

const preModerationWithdrawFunction = sql`
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
`

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    INSERT INTO "community_creator_profiles" ("public_id", "owner_id")
      SELECT 'creator_' || md5('m22:' || "owner_id"::text), "owner_id"
      FROM "community_posts" GROUP BY "owner_id"
      ON CONFLICT ("owner_id") DO NOTHING;
  `)
  await db.execute(withdrawFunction)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(preModerationWithdrawFunction)
}
