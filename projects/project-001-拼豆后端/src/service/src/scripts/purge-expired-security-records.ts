// 文件开头说明：M1 本机安全记录清理只处理已过保留期的审计、应用限流桶和幂等
// 缓存，不会删除用户、作品、文件或认证会话。team-test/生产的保留期限需在部署
// 前再次确认。
import 'dotenv/config'

import config from '@payload-config'
import { getPayload } from 'payload'

const auditRetentionDays = 90
const rateBucketRetentionDays = 2
const idempotencyRetentionHours = 24

const run = async (): Promise<void> => {
  const payload = await getPayload({ config })
  const pool = (payload.db as unknown as {
    pool?: { query: (query: string, parameters: readonly unknown[]) => Promise<{ rowCount?: number | null }> }
  }).pool
  if (!pool) {
    throw new Error('安全记录清理需要 PostgreSQL 连接池。')
  }

  try {
    const [audit, buckets, idempotency] = await Promise.all([
      pool.query(
        `DELETE FROM security_audit_events WHERE created_at < NOW() - ($1 * INTERVAL '1 day')`,
        [auditRetentionDays],
      ),
      pool.query(
        `DELETE FROM api_rate_limit_buckets WHERE window_started_at < NOW() - ($1 * INTERVAL '1 day')`,
        [rateBucketRetentionDays],
      ),
      pool.query(
        `DELETE FROM api_idempotency_records WHERE expires_at < NOW() - ($1 * INTERVAL '1 hour')`,
        [idempotencyRetentionHours],
      ),
    ])
    console.info(
      `清理完成：审计 ${audit.rowCount ?? 0} 条，限流桶 ${buckets.rowCount ?? 0} 条，幂等缓存 ${idempotency.rowCount ?? 0} 条。`,
    )
  } finally {
    await payload.destroy()
  }
}

run().catch((error: unknown) => {
  console.error('安全记录清理失败。')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
