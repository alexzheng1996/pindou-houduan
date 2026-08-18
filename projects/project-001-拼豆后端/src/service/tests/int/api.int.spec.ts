import { getPayload, type Payload } from 'payload'
import config from '@/payload.config'

import { describe, it, beforeAll, expect } from 'vitest'

let payload: Payload

describe('M0 Payload 与 PostgreSQL 基础链路', () => {
  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  it('连接数据库且只保留 Users 基础集合', async () => {
    const users = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 0,
      overrideAccess: true,
    })
    expect(users.totalDocs).toBeGreaterThanOrEqual(0)

    const payloadConfig = await config
    expect(payloadConfig.collections?.map(({ slug }) => slug)).toContain('users')
    expect(payloadConfig.collections?.map(({ slug }) => slug)).not.toContain('media')
    expect(payloadConfig.graphQL?.disable).toBe(true)
  })
})
