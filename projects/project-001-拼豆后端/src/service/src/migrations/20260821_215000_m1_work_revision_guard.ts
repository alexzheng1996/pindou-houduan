import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// 文件开头说明：补强 M1 作品激活和修订的数据库级并发保护。应用层负责组织
// Work、不可变 WorkDocument 与幂等记录；本迁移防止不同请求绕过乐观锁或 50 份上限。
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
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
        PERFORM 1 FROM "users" WHERE "id" = NEW."owner_id" FOR UPDATE;

        IF (SELECT COUNT(*) FROM "works" WHERE "owner_id" = NEW."owner_id" AND "state" = 'active') >= 50 THEN
          RAISE EXCEPTION 'WORK_LIMIT_REACHED' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS "works_enforce_active_work_limit" ON "works";
    CREATE TRIGGER "works_enforce_active_work_limit"
    BEFORE INSERT OR UPDATE OF "state", "owner_id", "document_revision" ON "works"
    FOR EACH ROW EXECUTE FUNCTION "enforce_active_work_limit"();`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
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

    DROP TRIGGER IF EXISTS "works_enforce_active_work_limit" ON "works";
    CREATE TRIGGER "works_enforce_active_work_limit"
    BEFORE INSERT OR UPDATE OF "state", "owner_id" ON "works"
    FOR EACH ROW EXECUTE FUNCTION "enforce_active_work_limit"();`)
}
