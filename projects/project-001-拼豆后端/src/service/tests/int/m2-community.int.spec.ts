// 文件开头说明：M2 最小公开边界回归测试。不创建真实社区内容，重点固定
// 匿名浏览安全投影和未登录写入拒绝；完整 A/B 复制流程在本地账号样例补齐后执行。
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { getPayload, type Payload } from 'payload'

import config from '@/payload.config'
import { GET as listCommunity, POST as publishCommunity } from '@/app/api/v1/community/route'
import { POST as copyCommunity } from '@/app/api/v1/community/[id]/copy/route'
import { OPTIONS as communityMediaOptions } from '@/app/api/v1/community/media/upload/route'

const origin = 'http://127.0.0.1:3002'
let payload: Payload

describe('M2 社区匿名安全边界', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })
  afterAll(async () => {
    await payload?.destroy()
  })

  it('匿名用户只能读取 published 安全投影，列表不返回私有字段', async () => {
    const response = await listCommunity(new Request(`${origin}/api/v1/community`))
    expect(response.status).toBe(200)
    const body = await response.json() as { posts: Array<{ status?: string }> }
    expect(body.posts.every((post) => post.status === 'published')).toBe(true)
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain('storageKey')
    expect(serialized).not.toContain('document')
    expect(serialized).not.toContain('email')
  })

  it('未登录不能发布或复制', async () => {
    const publish = await publishCommunity(new Request(`${origin}/api/v1/community`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'idempotency-key': 'm2-anonymous-publish' },
      body: '{}',
    }))
    expect(publish.status).toBe(401)

    const copy = await copyCommunity(new Request(`${origin}/api/v1/community/community_post_${'a'.repeat(32)}/copy`, {
      method: 'POST',
      headers: { origin, 'idempotency-key': 'm2-anonymous-copy' },
    }), { params: Promise.resolve({ id: `community_post_${'a'.repeat(32)}` }) })
    expect(copy.status).toBe(401)
  })

  it('社区媒体上传预检允许媒体角色和说明请求头', async () => {
    const response = communityMediaOptions(new Request(`${origin}/api/v1/community/media/upload`, {
      method: 'OPTIONS',
      headers: { origin },
    }))
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-headers')).toContain('X-Community-Media-Role')
    expect(response.headers.get('access-control-allow-headers')).toContain('X-Community-Media-Alt')
  })
})
