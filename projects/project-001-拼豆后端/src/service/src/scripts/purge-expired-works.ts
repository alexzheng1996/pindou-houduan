// 文件开头说明：到期作品回收入口。local 与 team-test 共用业务函数，实际对象删除
// 由统一 ObjectStore 端口决定；生产调度仍需使用受控 Cron，不在 Web 请求中触发。
import config from '@payload-config'
import { getPayload } from 'payload'

import { purgeExpiredWorks } from '@/works/purge-expired-works'

const payload = await getPayload({ config })

try {
  const removed = await purgeExpiredWorks(payload)
  console.info(`已回收 ${removed} 个到期作品。`)
} finally {
  await payload.destroy()
}
