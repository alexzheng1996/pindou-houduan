import { createLocalReq, getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { authInternalCollections } from '@/auth/collections'
import { Works, WorkDocuments, WorkAssets, ApiIdempotencyRecords } from '@/collections/Works'
import config from '@/payload.config'

let payload: Payload

type AccessFunction = (args: { req: unknown }) => boolean | Record<string, unknown> | Promise<boolean | Record<string, unknown>>

describe('M1 私密作品模型与会话边界', () => {
  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('注册四个内部集合，关闭原始 REST，并保留版本化快照与幂等字段', async () => {
    const payloadConfig = await config
    const collectionSlugs = payloadConfig.collections?.map(({ slug }) => slug) ?? []
    expect(collectionSlugs).toEqual(
      expect.arrayContaining([
        'users',
        ...authInternalCollections.map(({ slug }) => slug),
        'works',
        'work-documents',
        'work-assets',
        'api-idempotency-records',
      ]),
    )
    expect(Works.endpoints).toBe(false)
    expect(WorkDocuments.endpoints).toBe(false)
    expect(WorkAssets.endpoints).toBe(false)
    expect(ApiIdempotencyRecords.endpoints).toBe(false)
    expect(WorkDocuments.fields.map((field) => ('name' in field ? field.name : null))).toContain(
      'document',
    )
    expect(ApiIdempotencyRecords.fields.map((field) => ('name' in field ? field.name : null))).toContain(
      'keySha256',
    )
  })

  it('未登录请求不能伪造业务身份，活动会话读取数据库权威账号状态', async () => {
    const request = new Request('http://127.0.0.1:3002/api/v1/works', {
      headers: { origin: 'http://127.0.0.1:3002' },
    })

    await expect(requireActiveSession(request, 'test-request')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      status: 401,
    } satisfies Partial<SessionRequirementError>)

    const localReq = await createLocalReq(
      {
        context: { requestId: 'test-request', workService: true },
        req: { headers: request.headers },
        user: {
          id: 999999,
          name: 'M1 Work Model Test',
          email: 'm1-work-model@example.com',
          emailVerified: true,
          accountStatus: 'active',
          collection: 'users',
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
        },
      },
      payload,
    )
    expect(await (Works.access?.create as AccessFunction)({ req: localReq })).toBe(true)
    expect(await (Works.access?.read as AccessFunction)({ req: localReq })).toEqual({
      owner: { equals: 999999 },
    })
  })
})
