// 文件开头说明：只清理过期且已超过短期审计窗口的 CSV 导入预览。预览不保存原
// CSV；本脚本不会触碰库存余额、账本操作、用户、作品或对象文件。
import 'dotenv/config'

import config from '@payload-config'
import { getPayload } from 'payload'

const retentionDays = 7

const run = async (): Promise<void> => {
  const payload = await getPayload({ config })
  const pool = (payload.db as unknown as {
    pool?: { query: (query: string, parameters: readonly unknown[]) => Promise<{ rowCount?: number | null }> }
  }).pool
  if (!pool) {
    throw new Error('导入预览清理需要 PostgreSQL 连接池。')
  }
  try {
    const result = await pool.query(
      `DELETE FROM inventory_import_previews WHERE expires_at < NOW() - ($1 * INTERVAL '1 day')`,
      [retentionDays],
    )
    console.info(`已清理 ${result.rowCount ?? 0} 条过期库存导入预览。`)
  } finally {
    await payload.destroy()
  }
}

run().catch((error: unknown) => {
  console.error('库存导入预览清理失败。')
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
