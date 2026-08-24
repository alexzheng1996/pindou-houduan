import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Only a lifecycle transition into recovery/deletion should hide a published
// post. Ordinary document/title updates also touch the Work row and must not
// withdraw an otherwise valid frozen community snapshot.
const transitionFunction = sql`
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
  await db.execute(transitionFunction)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // Keep the corrected transition guard on rollback. Reintroducing the
  // update-on-every-state-write behavior would make rollback unsafe for M1.
  await db.execute(transitionFunction)
}
