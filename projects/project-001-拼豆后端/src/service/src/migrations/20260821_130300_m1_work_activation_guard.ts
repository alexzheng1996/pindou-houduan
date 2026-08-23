import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE OR REPLACE FUNCTION "enforce_active_work_limit"() RETURNS trigger AS $$
    BEGIN
      IF NEW."state" = 'active' AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM 'active') THEN
        PERFORM 1 FROM "users" WHERE "id" = NEW."owner_id" FOR UPDATE;

        IF (SELECT COUNT(*) FROM "works" WHERE "owner_id" = NEW."owner_id" AND "state" = 'active') >= 50 THEN
          RAISE EXCEPTION 'WORK_LIMIT_REACHED' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER "works_enforce_active_work_limit"
    BEFORE INSERT OR UPDATE OF "state", "owner_id" ON "works"
    FOR EACH ROW EXECUTE FUNCTION "enforce_active_work_limit"();`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TRIGGER IF EXISTS "works_enforce_active_work_limit" ON "works";
    DROP FUNCTION IF EXISTS "enforce_active_work_limit"();`)
}
