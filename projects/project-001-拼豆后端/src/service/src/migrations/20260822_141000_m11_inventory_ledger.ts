import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// 文件开头说明：M1.1 个人豆仓使用独立账本表，而不是把余额塞进 WorkDocument。
// 当前余额、一次操作头和不可变颜色明细分层保存；所有结构变化仍只允许显式迁移。
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "inventory_items" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar(80) NOT NULL,
      "owner_id" integer NOT NULL,
      "bead_size_mm" numeric(3,1) NOT NULL,
      "color_hex" varchar(7) NOT NULL,
      "quantity" integer DEFAULT 0 NOT NULL,
      "revision" integer DEFAULT 0 NOT NULL,
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "inventory_items_bead_size_mm_check" CHECK ("bead_size_mm" IN (2.6, 5.0)),
      CONSTRAINT "inventory_items_color_hex_check" CHECK ("color_hex" ~ '^#[0-9A-F]{6}$'),
      CONSTRAINT "inventory_items_quantity_check" CHECK ("quantity" BETWEEN -10000000 AND 10000000),
      CONSTRAINT "inventory_items_revision_check" CHECK ("revision" >= 0)
    );

    CREATE TABLE "inventory_operations" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar(80) NOT NULL,
      "owner_id" integer NOT NULL,
      "kind" varchar(32) NOT NULL,
      "note" varchar(500),
      "source_work_public_id" varchar(80),
      "source_work_title" varchar(120),
      "source_document_revision" integer,
      "source_document_sha256" varchar(64),
      "reversal_of_operation_id" integer,
      "deleted_at" timestamp(3) with time zone,
      "deleted_by_id" integer,
      "deletion_reason" varchar(500),
      "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "inventory_operations_kind_check" CHECK (
        "kind" IN (
          'receipt',
          'manual_decrement',
          'stocktake',
          'import_overwrite',
          'import_append',
          'production_decrement',
          'deletion_reversal'
        )
      ),
      CONSTRAINT "inventory_operations_source_revision_check" CHECK (
        "source_document_revision" IS NULL OR "source_document_revision" >= 0
      ),
      CONSTRAINT "inventory_operations_reversal_shape_check" CHECK (
        ("kind" = 'deletion_reversal') = ("reversal_of_operation_id" IS NOT NULL)
      )
    );

    CREATE TABLE "inventory_transaction_lines" (
      "id" serial PRIMARY KEY NOT NULL,
      "operation_id" integer NOT NULL,
      "item_id" integer NOT NULL,
      "bead_size_mm" numeric(3,1) NOT NULL,
      "color_hex" varchar(7) NOT NULL,
      "delta" integer NOT NULL,
      "quantity_before" integer NOT NULL,
      "quantity_after" integer NOT NULL,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "inventory_transaction_lines_bead_size_mm_check" CHECK ("bead_size_mm" IN (2.6, 5.0)),
      CONSTRAINT "inventory_transaction_lines_color_hex_check" CHECK ("color_hex" ~ '^#[0-9A-F]{6}$'),
      CONSTRAINT "inventory_transaction_lines_delta_check" CHECK ("delta" BETWEEN -10000000 AND 10000000),
      CONSTRAINT "inventory_transaction_lines_before_check" CHECK ("quantity_before" BETWEEN -10000000 AND 10000000),
      CONSTRAINT "inventory_transaction_lines_after_check" CHECK ("quantity_after" BETWEEN -10000000 AND 10000000),
      CONSTRAINT "inventory_transaction_lines_arithmetic_check" CHECK ("quantity_before" + "delta" = "quantity_after")
    );


    ALTER TABLE "inventory_items"
      ADD CONSTRAINT "inventory_items_owner_id_users_id_fk"
      FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
    ALTER TABLE "inventory_operations"
      ADD CONSTRAINT "inventory_operations_owner_id_users_id_fk"
      FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
    ALTER TABLE "inventory_operations"
      ADD CONSTRAINT "inventory_operations_deleted_by_id_users_id_fk"
      FOREIGN KEY ("deleted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "inventory_operations"
      ADD CONSTRAINT "inventory_operations_reversal_of_operation_id_inventory_operations_id_fk"
      FOREIGN KEY ("reversal_of_operation_id") REFERENCES "public"."inventory_operations"("id") ON DELETE restrict ON UPDATE no action;
    ALTER TABLE "inventory_transaction_lines"
      ADD CONSTRAINT "inventory_transaction_lines_operation_id_inventory_operations_id_fk"
      FOREIGN KEY ("operation_id") REFERENCES "public"."inventory_operations"("id") ON DELETE restrict ON UPDATE no action;
    ALTER TABLE "inventory_transaction_lines"
      ADD CONSTRAINT "inventory_transaction_lines_item_id_inventory_items_id_fk"
      FOREIGN KEY ("item_id") REFERENCES "public"."inventory_items"("id") ON DELETE restrict ON UPDATE no action;

    CREATE UNIQUE INDEX "inventory_items_public_id_idx" ON "inventory_items" USING btree ("public_id");
    CREATE UNIQUE INDEX "inventory_items_owner_size_color_idx" ON "inventory_items" USING btree ("owner_id", "bead_size_mm", "color_hex");
    CREATE INDEX "inventory_items_owner_updated_at_idx" ON "inventory_items" USING btree ("owner_id", "updated_at");
    CREATE UNIQUE INDEX "inventory_operations_public_id_idx" ON "inventory_operations" USING btree ("public_id");
    CREATE INDEX "inventory_operations_owner_created_at_idx" ON "inventory_operations" USING btree ("owner_id", "created_at");
    CREATE UNIQUE INDEX "inventory_operations_reversal_of_operation_id_idx" ON "inventory_operations" USING btree ("reversal_of_operation_id");
    CREATE UNIQUE INDEX "inventory_transaction_lines_operation_item_idx" ON "inventory_transaction_lines" USING btree ("operation_id", "item_id");
    CREATE INDEX "inventory_transaction_lines_item_created_at_idx" ON "inventory_transaction_lines" USING btree ("item_id", "created_at");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE "inventory_transaction_lines";
    DROP TABLE "inventory_operations";
    DROP TABLE "inventory_items";
  `)
}
