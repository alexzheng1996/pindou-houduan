// 文件开头说明：M1 本机私有资产的手工清理入口。只清理数据库已标记为过期或
// 无效的 WorkAsset 与其对象，不扫描 Workspace 外部路径；本机与 team-test 都通过
// 统一 ObjectStore 端口执行，部署环境由受控任务调度器调用同一业务函数。
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
