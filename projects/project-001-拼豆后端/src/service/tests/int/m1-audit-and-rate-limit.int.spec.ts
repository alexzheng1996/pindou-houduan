// 文件开头说明：验证 M1 应用级反滥用与最小审计。测试只读取/清理本机 PostgreSQL
// 的随机测试记录；不记录或断言真实邮箱、Cookie、文件路径或外部服务凭据。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { POST as createWorkPost } from '@/app/api/v1/works/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'
import config from '@/payload.config'

let payload: Payload

const origin = 'http://127.0.0.1:3002'

const validCreateBody = () => ({
  title: '审计测试图纸',
  kind: 'pattern',
  document: {
    schemaVersion: 1,
    kind: 'pattern',
    title: '审计测试图纸',
    documentRevision: 0,
    settings: {},
    pattern: {
      gridDimensions: { columns: 1, rows: 1 },
      mappedPixelData: [[{ key: '#123456', color: '#123456', isExternal: false }]],
      colorCounts: { '#123456': { count: 1, color: '#123456' } },
      totalBeadCount: 1,
    },
    board: null,
    materialList: { status: 'not_generated', items: [] },
  },
})

const authRequest = (path: string, body: Record<string, string>): Request =>
  new Request(`${origin}/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })

const workRequest = (body: unknown, cookie: string): Request =>
  new Request(`${origin}/api/v1/works`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'idempotency-key': `audit-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  })

const signInVerifiedUser = async (): Promise<{ cookie: string; userId: number }> => {
  const email = `m1-audit-${randomUUID()}@example.com`
  const password = 'M1-audit-test-password-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name: 'M1 Audit Test', email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('本地 outbox 未生成审计测试 OTP。')
  }
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('审计测试未取得会话 Cookie。')
  }
  const users = await payload.find({
    collection: 'users',
    depth: 0,
    limit: 1,
    overrideAccess: true,
    where: { email: { equals: email } },
  })
  const userId = users.docs[0]?.id
  if (!userId) {
    throw new Error('审计测试未找到用户。')
  }
  return { cookie, userId }
}

const securityRows = async (userId: number): Promise<Array<Record<string, unknown>>> => {
  const pool = (payload.db as unknown as {
    pool: { query: (query: string, parameters: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
  }).pool
  return (
    await pool.query(
      `SELECT action, outcome, route, resource_type, resource_public_id, request_id, reason_code
       FROM security_audit_events WHERE actor_id = $1 ORDER BY id ASC`,
      [userId],
    )
  ).rows
}

describe('M1 审计与应用级反滥用', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
    const pool = (payload.db as unknown as { pool: { query: (query: string) => Promise<unknown> } }).pool
    await pool.query('DELETE FROM api_rate_limit_buckets')
    await pool.query('DELETE FROM security_audit_events')
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('创建作品后写入最小成功审计，且不含作品文档或敏感会话内容', async () => {
    const user = await signInVerifiedUser()
    const response = await createWorkPost(workRequest(validCreateBody(), user.cookie))
    expect(response.status).toBe(201)
    const responseBody = (await response.json()) as { requestId: string; work: { workId: string } }
    const rows = await securityRows(user.userId)
    const row = rows.find((candidate) => candidate.action === 'work.created')

    expect(row).toMatchObject({
      action: 'work.created',
      outcome: 'allowed',
      resource_type: 'work',
      resource_public_id: responseBody.work.workId,
      request_id: responseBody.requestId,
      route: 'POST /api/v1/works',
    })
    expect(JSON.stringify(row)).not.toContain('mappedPixelData')
    expect(JSON.stringify(row)).not.toContain('cookie')
  })

  it('原子限制同一用户的上传次数，并返回可重试时间和最小审计事件', async () => {
    const user = await signInVerifiedUser()
    const requestId = `request-${randomUUID()}`
    const session = {
      payload,
      req: { transactionID: undefined },
      requestId,
      user: { id: user.userId },
    } as never

    for (let attempt = 0; attempt < 15; attempt += 1) {
      await expect(enforceAuthenticatedRateLimit(session, 'assetUpload', 'PUT /api/v1/upload-test')).resolves.toBeUndefined()
    }

    await expect(
      enforceAuthenticatedRateLimit(session, 'assetUpload', 'PUT /api/v1/upload-test'),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { retryAfterSeconds: expect.any(Number) },
    })
    const rows = await securityRows(user.userId)
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'rate_limit.denied',
          outcome: 'denied',
          reason_code: 'asset-upload',
          request_id: requestId,
        }),
      ]),
    )
  })
})
