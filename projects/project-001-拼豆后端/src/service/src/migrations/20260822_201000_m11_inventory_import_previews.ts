import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// 文件开头说明：CSV 导入先保存短期、不可由客户端改写的规范化预览，再由用户确认
// 提交。绝不保存原 CSV；提交时会核对余额 revision，避免预览过期或被其他设备改动后
// 覆盖新库存。此迁移独立于已执行的库存账本迁移，便于安全部署和回滚。
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "inventory_import_previews" (
      "id" serial PRIMARY KEY NOT NULL,
      "public_id" varchar(80) NOT NULL,
      "owner_id" integer NOT NULL,
      "bead_size_mm" numeric(3,1) NOT NULL,
      "color_system" varchar(32) NOT NULL,
      "strategy" varchar(16) NOT NULL,
      "source_sha256" varchar(64) NOT NULL,
      "mapping_sha256" varchar(64) NOT NULL,
      "preview_sha256" varchar(64) NOT NULL,
      "normalized_lines" jsonb NOT NULL,
      "expires_at" timestamp(3) with time zone NOT NULL,
      "consumed_at" timestamp(3) with time zone,
      "consumed_operation_id" integer,
      "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "inventory_import_previews_bead_size_mm_check" CHECK ("bead_size_mm" IN (2.6, 5.0)),
      CONSTRAINT "inventory_import_previews_color_system_check" CHECK ("color_system" IN ('MARD', 'COCO', '漫漫', '盼盼', '咪小窝')),
      CONSTRAINT "inventory_import_previews_strategy_check" CHECK ("strategy" IN ('append', 'overwrite')),
      CONSTRAINT "inventory_import_previews_consumed_shape_check" CHECK (
        ("consumed_at" IS NULL) = ("consumed_operation_id" IS NULL)
      )
    );

    ALTER TABLE "inventory_import_previews"
      ADD CONSTRAINT "inventory_import_previews_owner_id_users_id_fk"
      FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
    ALTER TABLE "inventory_import_previews"
      ADD CONSTRAINT "inventory_import_previews_consumed_operation_id_inventory_operations_id_fk"
      FOREIGN KEY ("consumed_operation_id") REFERENCES "public"."inventory_operations"("id") ON DELETE restrict ON UPDATE no action;

    CREATE UNIQUE INDEX "inventory_import_previews_public_id_idx" ON "inventory_import_previews" USING btree ("public_id");
    CREATE INDEX "inventory_import_previews_owner_expires_at_idx" ON "inventory_import_previews" USING btree ("owner_id", "expires_at");
    CREATE INDEX "inventory_import_previews_expires_at_idx" ON "inventory_import_previews" USING btree ("expires_at");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE "inventory_import_previews";
  `)
}
