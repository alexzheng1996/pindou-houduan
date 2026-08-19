import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_users_role" AS ENUM('user', 'staff', 'admin');
  CREATE TYPE "public"."enum_users_account_status" AS ENUM('pending_verification', 'active', 'suspended');
  CREATE TYPE "public"."enum_users_auth_provider" AS ENUM('local', 'google');
  ALTER TABLE "users" ADD COLUMN "role" "enum_users_role" DEFAULT 'user' NOT NULL;
  ALTER TABLE "users" ADD COLUMN "account_status" "enum_users_account_status" DEFAULT 'pending_verification' NOT NULL;
  ALTER TABLE "users" ADD COLUMN "auth_provider" "enum_users_auth_provider" DEFAULT 'local' NOT NULL;
  ALTER TABLE "users" ADD COLUMN "google_subject" varchar;
  ALTER TABLE "users" ADD COLUMN "terms_version" varchar;
  ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp(3) with time zone;
  ALTER TABLE "users" ADD COLUMN "_verified" boolean;
  ALTER TABLE "users" ADD COLUMN "_verificationtoken" varchar;
  CREATE UNIQUE INDEX "users_google_subject_idx" ON "users" USING btree ("google_subject");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "users_google_subject_idx";
  ALTER TABLE "users" DROP COLUMN "role";
  ALTER TABLE "users" DROP COLUMN "account_status";
  ALTER TABLE "users" DROP COLUMN "auth_provider";
  ALTER TABLE "users" DROP COLUMN "google_subject";
  ALTER TABLE "users" DROP COLUMN "terms_version";
  ALTER TABLE "users" DROP COLUMN "terms_accepted_at";
  ALTER TABLE "users" DROP COLUMN "_verified";
  ALTER TABLE "users" DROP COLUMN "_verificationtoken";
  DROP TYPE "public"."enum_users_role";
  DROP TYPE "public"."enum_users_account_status";
  DROP TYPE "public"."enum_users_auth_provider";`)
}
