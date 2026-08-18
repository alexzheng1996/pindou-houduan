// 文件开头说明：M0 本地运行状态检查；只确认数据库可访问，不返回配置或用户数据。
import config from '@payload-config'
import { getPayload } from 'payload'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    const payload = await getPayload({ config })
    await payload.find({
      collection: 'users',
      depth: 0,
      limit: 0,
      overrideAccess: true,
    })

    return Response.json({ status: 'ok' }, { status: 200 })
  } catch {
    // The detailed cause can contain infrastructure data; keep it server-side.
    return Response.json({ status: 'unavailable' }, { status: 503 })
  }
}
