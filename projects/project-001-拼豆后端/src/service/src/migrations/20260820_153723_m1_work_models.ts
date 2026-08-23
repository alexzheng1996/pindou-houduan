import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_works_kind" AS ENUM('pattern', 'board');
  CREATE TYPE "public"."enum_works_state" AS ENUM('draft', 'active', 'pending_deletion', 'deleted');
  CREATE TYPE "public"."enum_works_visibility" AS ENUM('private');
  CREATE TYPE "public"."enum_work_documents_kind" AS ENUM('pattern', 'board');
  CREATE TYPE "public"."enum_work_assets_role" AS ENUM('original', 'display', 'thumbnail', 'document', 'export');
  CREATE TYPE "public"."enum_work_assets_status" AS ENUM('upload_pending', 'uploaded', 'ready', 'validation_failed', 'orphaned', 'pending_purge', 'deleted');
  CREATE TYPE "public"."enum_work_assets_visibility" AS ENUM('private');
  CREATE TYPE "public"."enum_api_idempotency_records_state" AS ENUM('in_progress', 'completed');
  CREATE TABLE "works" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"public_id" varchar NOT NULL,
  	"owner_id" integer NOT NULL,
  	"kind" "enum_works_kind" NOT NULL,
  	"title" varchar NOT NULL,
  	"state" "enum_works_state" DEFAULT 'draft' NOT NULL,
  	"visibility" "enum_works_visibility" DEFAULT 'private' NOT NULL,
  	"document_revision" numeric DEFAULT 0 NOT NULL,
  	"document_sha256" varchar NOT NULL,
  	"current_document_id" integer,
  	"recoverable_until" timestamp(3) with time zone,
  	"deleted_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "work_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"owner_id" integer NOT NULL,
  	"work_id" integer NOT NULL,
  	"revision" numeric NOT NULL,
  	"schema_version" numeric NOT NULL,
  	"kind" "enum_work_documents_kind" NOT NULL,
  	"document" jsonb NOT NULL,
  	"content_sha256" varchar NOT NULL,
  	"document_byte_size" numeric NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "work_assets" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"public_id" varchar NOT NULL,
  	"owner_id" integer NOT NULL,
  	"work_id" integer NOT NULL,
  	"role" "enum_work_assets_role" NOT NULL,
  	"status" "enum_work_assets_status" NOT NULL,
  	"visibility" "enum_work_assets_visibility" DEFAULT 'private' NOT NULL,
  	"mime_type" varchar NOT NULL,
  	"detected_mime_type" varchar,
  	"size_bytes" numeric NOT NULL,
  	"sha256" varchar NOT NULL,
  	"storage_key" varchar NOT NULL,
  	"storage_e_tag" varchar,
  	"upload_expires_at" timestamp(3) with time zone,
  	"confirmed_at" timestamp(3) with time zone,
  	"orphaned_at" timestamp(3) with time zone,
  	"purge_after" timestamp(3) with time zone,
  	"source_document_revision" numeric,
  	"source_document_sha256" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "api_idempotency_records" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"actor_id" integer NOT NULL,
  	"route" varchar NOT NULL,
  	"key_sha256" varchar NOT NULL,
  	"request_sha256" varchar NOT NULL,
  	"state" "enum_api_idempotency_records_state" NOT NULL,
  	"response_status" numeric,
  	"response_body" jsonb,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "works_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "work_documents_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "work_assets_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "api_idempotency_records_id" integer;
  ALTER TABLE "works" ADD CONSTRAINT "works_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  ALTER TABLE "works" ADD CONSTRAINT "works_current_document_id_work_documents_id_fk" FOREIGN KEY ("current_document_id") REFERENCES "public"."work_documents"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "work_documents" ADD CONSTRAINT "work_documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  ALTER TABLE "work_documents" ADD CONSTRAINT "work_documents_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;
  ALTER TABLE "work_assets" ADD CONSTRAINT "work_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  ALTER TABLE "work_assets" ADD CONSTRAINT "work_assets_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;
  ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  CREATE INDEX "works_owner_idx" ON "works" USING btree ("owner_id");
  CREATE INDEX "works_current_document_idx" ON "works" USING btree ("current_document_id");
  CREATE INDEX "works_updated_at_idx" ON "works" USING btree ("updated_at");
  CREATE INDEX "works_created_at_idx" ON "works" USING btree ("created_at");
  CREATE UNIQUE INDEX "publicId_idx" ON "works" USING btree ("public_id");
  CREATE INDEX "owner_state_updatedAt_idx" ON "works" USING btree ("owner_id","state","updated_at");
  CREATE INDEX "work_documents_owner_idx" ON "work_documents" USING btree ("owner_id");
  CREATE INDEX "work_documents_work_idx" ON "work_documents" USING btree ("work_id");
  CREATE INDEX "work_documents_content_sha256_idx" ON "work_documents" USING btree ("content_sha256");
  CREATE INDEX "work_documents_updated_at_idx" ON "work_documents" USING btree ("updated_at");
  CREATE INDEX "work_documents_created_at_idx" ON "work_documents" USING btree ("created_at");
  CREATE UNIQUE INDEX "work_revision_idx" ON "work_documents" USING btree ("work_id","revision");
  CREATE INDEX "owner_work_revision_idx" ON "work_documents" USING btree ("owner_id","work_id","revision");
  CREATE INDEX "work_assets_owner_idx" ON "work_assets" USING btree ("owner_id");
  CREATE INDEX "work_assets_work_idx" ON "work_assets" USING btree ("work_id");
  CREATE INDEX "work_assets_sha256_idx" ON "work_assets" USING btree ("sha256");
  CREATE INDEX "work_assets_updated_at_idx" ON "work_assets" USING btree ("updated_at");
  CREATE INDEX "work_assets_created_at_idx" ON "work_assets" USING btree ("created_at");
  CREATE UNIQUE INDEX "publicId_1_idx" ON "work_assets" USING btree ("public_id");
  CREATE INDEX "owner_work_status_idx" ON "work_assets" USING btree ("owner_id","work_id","status");
  CREATE INDEX "purgeAfter_idx" ON "work_assets" USING btree ("purge_after");
  CREATE UNIQUE INDEX "storageKey_idx" ON "work_assets" USING btree ("storage_key");
  CREATE INDEX "api_idempotency_records_actor_idx" ON "api_idempotency_records" USING btree ("actor_id");
  CREATE INDEX "api_idempotency_records_updated_at_idx" ON "api_idempotency_records" USING btree ("updated_at");
  CREATE INDEX "api_idempotency_records_created_at_idx" ON "api_idempotency_records" USING btree ("created_at");
  CREATE UNIQUE INDEX "actor_route_keySha256_idx" ON "api_idempotency_records" USING btree ("actor_id","route","key_sha256");
  CREATE INDEX "expiresAt_idx" ON "api_idempotency_records" USING btree ("expires_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_works_fk" FOREIGN KEY ("works_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_work_documents_fk" FOREIGN KEY ("work_documents_id") REFERENCES "public"."work_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_work_assets_fk" FOREIGN KEY ("work_assets_id") REFERENCES "public"."work_assets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_api_idempotency_records_fk" FOREIGN KEY ("api_idempotency_records_id") REFERENCES "public"."api_idempotency_records"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_works_id_idx" ON "payload_locked_documents_rels" USING btree ("works_id");
  CREATE INDEX "payload_locked_documents_rels_work_documents_id_idx" ON "payload_locked_documents_rels" USING btree ("work_documents_id");
  CREATE INDEX "payload_locked_documents_rels_work_assets_id_idx" ON "payload_locked_documents_rels" USING btree ("work_assets_id");
  CREATE INDEX "payload_locked_documents_rels_api_idempotency_records_id_idx" ON "payload_locked_documents_rels" USING btree ("api_idempotency_records_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_works_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_work_documents_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_work_assets_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_api_idempotency_records_fk";
  
  DROP INDEX "payload_locked_documents_rels_works_id_idx";
  DROP INDEX "payload_locked_documents_rels_work_documents_id_idx";
  DROP INDEX "payload_locked_documents_rels_work_assets_id_idx";
  DROP INDEX "payload_locked_documents_rels_api_idempotency_records_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "works_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "work_documents_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "work_assets_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "api_idempotency_records_id";
  ALTER TABLE "works" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "work_documents" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "work_assets" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "api_idempotency_records" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "api_idempotency_records" CASCADE;
  DROP TABLE "work_assets" CASCADE;
  DROP TABLE "work_documents" CASCADE;
  DROP TABLE "works" CASCADE;
  DROP TYPE "public"."enum_works_kind";
  DROP TYPE "public"."enum_works_state";
  DROP TYPE "public"."enum_works_visibility";
  DROP TYPE "public"."enum_work_documents_kind";
  DROP TYPE "public"."enum_work_assets_role";
  DROP TYPE "public"."enum_work_assets_status";
  DROP TYPE "public"."enum_work_assets_visibility";
  DROP TYPE "public"."enum_api_idempotency_records_state";`)
}
