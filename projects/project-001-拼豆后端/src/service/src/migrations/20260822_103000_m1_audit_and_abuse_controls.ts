import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// 文件开头说明：M1 审计和应用级限流只能通过显式迁移创建。两张表不作为
// Payload REST 集合暴露，避免把安全记录或限流计数变成可浏览的后台资源。
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "security_audit_events" (
      "id" serial PRIMARY KEY NOT NULL,
      "actor_id" integer,
      "action" varchar(80) NOT NULL,
      "outcome" varchar(16) NOT NULL,
      "route" varchar(180) NOT NULL,
      "resource_type" varchar(32),
      "resource_public_id" varchar(80),
      "request_id" varchar(64) NOT NULL,
      "reason_code" varchar(80),
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "security_audit_events_outcome_check" CHECK ("outcome" IN ('allowed', 'denied'))
    );

    ALTER TABLE "security_audit_events"
      ADD CONSTRAINT "security_audit_events_actor_id_users_id_fk"
      FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE no action;

    CREATE INDEX "security_audit_events_actor_created_at_idx"
      ON "security_audit_events" USING btree ("actor_id", "created_at");
    CREATE INDEX "security_audit_events_action_created_at_idx"
      ON "security_audit_events" USING btree ("action", "created_at");
    CREATE INDEX "security_audit_events_resource_created_at_idx"
      ON "security_audit_events" USING btree ("resource_public_id", "created_at");

    CREATE TABLE "api_rate_limit_buckets" (
      "id" serial PRIMARY KEY NOT NULL,
      "actor_id" integer NOT NULL,
      "scope" varchar(64) NOT NULL,
      "window_started_at" timestamp(3) with time zone NOT NULL,
      "request_count" integer DEFAULT 1 NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "api_rate_limit_buckets_request_count_check" CHECK ("request_count" > 0)
    );

    ALTER TABLE "api_rate_limit_buckets"
      ADD CONSTRAINT "api_rate_limit_buckets_actor_id_users_id_fk"
      FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE no action;

    CREATE UNIQUE INDEX "api_rate_limit_buckets_actor_scope_window_idx"
      ON "api_rate_limit_buckets" USING btree ("actor_id", "scope", "window_started_at");
    CREATE INDEX "api_rate_limit_buckets_window_started_at_idx"
      ON "api_rate_limit_buckets" USING btree ("window_started_at");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE "api_rate_limit_buckets";
    DROP TABLE "security_audit_events";`)
}
