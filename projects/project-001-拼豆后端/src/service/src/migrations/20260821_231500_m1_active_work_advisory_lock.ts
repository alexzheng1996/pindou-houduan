import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// 文件开头说明：修复 M1 激活并发的锁顺序。幂等记录的 actor 外键会持有 users
// 共享锁，因此触发器不能再对同一行升级为 FOR UPDATE；改用按 owner 的事务咨询锁
// 串行化 active 作品计数，仍由数据库强制每位用户最多 50 份 active 作品。
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
        PERFORM pg_advisory_xact_lock(NEW."owner_id"::bigint);

        IF (SELECT COUNT(*) FROM "works" WHERE "owner_id" = NEW."owner_id" AND "state" = 'active') >= 50 THEN
          RAISE EXCEPTION 'WORK_LIMIT_REACHED' USING ERRCODE = 'P0001';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
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
    $$ LANGUAGE plpgsql;`)
}
