// Earlier local M2.2 iterations used a unique index for duplicate reports.
// Existing installations can already contain historical duplicates, so use a
// transaction-scoped advisory lock in the service instead of deleting reports
// or letting a future migration fail on records created before this release.
import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`DROP INDEX IF EXISTS "community_reports_reporter_post_reason_idx";`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  // The reviewed M2.2 target has no unique report index; deduplication is
  // performed by the service's transaction lock so historical duplicates can
  // remain readable. Keep rollback at that same safe shape.
  void db
}
