// 文件开头说明：仅用于 M1 本机验证的到期作品回收入口。它不连接 team-test 或
// 生产资源；未来 R2/S3 接入后必须先替换存储适配器，再开放同名部署任务。
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
