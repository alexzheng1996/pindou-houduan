import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

// Rules are stored per account; health remains derived at read time and is
// deliberately never materialized in inventory_items or ledger rows.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "users"
      ADD COLUMN "inventory_out_of_stock_threshold" numeric DEFAULT 50 NOT NULL,
      ADD COLUMN "inventory_warning_threshold" numeric DEFAULT 100 NOT NULL;
    ALTER TABLE "users"
      ADD CONSTRAINT "users_inventory_out_of_stock_threshold_check"
        CHECK ("inventory_out_of_stock_threshold" BETWEEN 0 AND 10000000),
      ADD CONSTRAINT "users_inventory_warning_threshold_check"
        CHECK ("inventory_warning_threshold" BETWEEN 1 AND 10000000),
      ADD CONSTRAINT "users_inventory_threshold_order_check"
        CHECK ("inventory_warning_threshold" > "inventory_out_of_stock_threshold");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "users"
      DROP CONSTRAINT "users_inventory_threshold_order_check",
      DROP CONSTRAINT "users_inventory_warning_threshold_check",
      DROP CONSTRAINT "users_inventory_out_of_stock_threshold_check";
    ALTER TABLE "users"
      DROP COLUMN "inventory_warning_threshold",
      DROP COLUMN "inventory_out_of_stock_threshold";`)
}
