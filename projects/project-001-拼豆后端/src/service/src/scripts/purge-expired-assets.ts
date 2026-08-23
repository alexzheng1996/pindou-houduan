// 文件开头说明：M1 本机私有资产的手工清理入口。只清理数据库已标记为过期或
// 无效的 WorkAsset 与其项目内对象，不扫描 Workspace 外部路径，也不用于 team-test
// 或生产；未来部署改由受控任务调度器调用同一业务函数。
import { getPayload } from 'payload'

import { purgeExpiredOrphanedAssets } from '@/assets/service'
import config from '@/payload.config'

const payload = await getPayload({ config: await config })

try {
  const removed = await purgeExpiredOrphanedAssets({ payload })
  console.log(`已清理 ${removed} 个过期或无效的本机资产。`)
} finally {
  await payload.destroy()
}
