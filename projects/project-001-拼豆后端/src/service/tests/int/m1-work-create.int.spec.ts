// 文件开头说明：覆盖 M1 首个作品写入入口。测试只使用随机本地邮箱和 PostgreSQL，
// 不连接对象存储、真实邮件或前端仓库；重点验证图纸边界、会话、事务与持久化幂等。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { OPTIONS as createWorkOptions, POST as createWorkPost } from '@/app/api/v1/works/route'
import {
  GET as getWorkDetail,
  OPTIONS as updateWorkOptions,
  PATCH as patchWorkDocument,
} from '@/app/api/v1/works/[id]/route'
import { POST as requestWorkDeletion } from '@/app/api/v1/works/[id]/deletion-request/route'
import { DELETE as cancelDraftWork } from '@/app/api/v1/works/[id]/draft/route'
import { GET as listWorks } from '@/app/api/v1/works/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import { purgeExpiredWorks } from '@/works/purge-expired-works'
import config from '@/payload.config'
import {
  validateCreateWorkInput,
  validateUpdateWorkInput,
  WorkDocumentValidationError,
} from '@/works/validation'

let payload: Payload

const origin = 'http://127.0.0.1:3002'

const validCreateBody = () => ({
  title: '  2 × 2 测试图纸  ',
  kind: 'pattern',
  document: {
    schemaVersion: 1,
    kind: 'pattern',
    title: '  2 × 2 测试图纸  ',
    documentRevision: 0,
    settings: {},
    pattern: {
      gridDimensions: { columns: 2, rows: 2 },
      mappedPixelData: [
        [
          { key: '#123456', color: '#123456', isExternal: false },
          { key: 'ERASE', color: '#FFFFFF', isExternal: true },
        ],
        [
          { key: '#ABCDEF', color: '#ABCDEF', isExternal: false },
          { key: '#123456', color: '#123456', isExternal: false },
        ],
      ],
      colorCounts: {
        '#123456': { count: 2, color: '#123456' },
        '#ABCDEF': { count: 1, color: '#ABCDEF' },
      },
      totalBeadCount: 3,
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

const workRequest = (body: unknown, cookie?: string, idempotencyKey?: string, requestOrigin = origin): Request =>
  new Request(`${origin}/api/v1/works`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: requestOrigin,
      ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  })

const readWorksRequest = (path: string, cookie?: string): Request =>
  new Request(`${origin}${path}`, {
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
    },
  })

const updateWorkRequest = (
  workId: string,
  body: unknown,
  cookie?: string,
  idempotencyKey?: string,
  requestOrigin = origin,
): Request =>
  new Request(`${origin}/api/v1/works/${workId}/document`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      origin: requestOrigin,
      ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  })

const validUpdateBody = (title = '更新后的 2 × 2 图纸') => {
  const create = validCreateBody()
  create.title = title
  create.document.title = title

  return {
    expectedRevision: 0,
    document: {
      ...create.document,
      documentRevision: 0,
      materialList: {
        status: 'generated',
        generatedFromRevision: 1,
        items: [
          { colorKey: '#123456', color: '#123456', count: 2 },
          { colorKey: '#ABCDEF', color: '#ABCDEF', count: 1 },
        ],
      },
    },
  }
}

const deleteDraftRequest = (workId: string, cookie?: string, idempotencyKey?: string): Request =>
  new Request(`${origin}/api/v1/works/${workId}/draft`, {
    method: 'DELETE',
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
  })

const requestDeletionRequest = (
  workId: string,
  expectedRevision: number,
  cookie?: string,
  idempotencyKey?: string,
): Request =>
  new Request(`${origin}/api/v1/works/${workId}/deletion-request`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      ...(cookie ? { cookie } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify({ expectedRevision }),
  })

const signInVerifiedUser = async (): Promise<{ cookie: string; userId: number }> => {
  const email = `m1-work-create-${randomUUID()}@example.com`
  const password = 'M1-work-create-password-2026'

  clearLocalMailOutbox()
  expect(
    (
      await authPost(
        authRequest('/sign-up/email', {
          name: 'M1 Work Create Test',
          email,
          password,
        }),
      )
    ).status,
  ).toBe(200)

  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('本地 outbox 未生成作品测试所需的邮箱验证 OTP。')
  }

  expect(
    (
      await authPost(
        authRequest('/email-otp/verify-email', {
          email,
          otp: outbox[0].otp,
        }),
      )
    ).status,
  ).toBe(200)

  const signInResponse = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signInResponse.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('本地作品测试未取得登录会话 Cookie。')
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
    throw new Error('本地作品测试未找到已验证用户。')
  }

  return { cookie, userId }
}

const expectInvalidDocument = (input: unknown, code: WorkDocumentValidationError['code']): void => {
  try {
    validateCreateWorkInput(input)
    throw new Error('预期作品文档校验失败，但实际通过。')
  } catch (error) {
    expect(error).toBeInstanceOf(WorkDocumentValidationError)
    expect((error as WorkDocumentValidationError).code).toBe(code)
  }
}

const createDraftThroughApi = async (cookie: string, title = '2 × 2 测试图纸') => {
  const body = validCreateBody()
  body.title = title
  body.document.title = title
  const response = await createWorkPost(workRequest(body, cookie, `m1-work-${randomUUID()}`))
  if (response.status !== 201) {
    throw new Error(`创建测试作品失败，状态码：${response.status}`)
  }

  const result = (await response.json()) as { work: { workId: string } }
  return result.work.workId
}

describe('M1 pattern 图纸校验与创建接口', () => {
  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('严格校验矩阵、透明格、色值、统计和 8 MiB 容量边界', () => {
    const input = validCreateBody()
    const validated = validateCreateWorkInput(input)
    expect(validated.title).toBe('2 × 2 测试图纸')
    expect(validated.document.pattern).toMatchObject({ totalBeadCount: 3 })

    const nonRectangular = validCreateBody()
    nonRectangular.document.pattern.mappedPixelData[1]?.pop()
    expectInvalidDocument(nonRectangular, 'WORK_DOCUMENT_INVALID')

    const invalidTransparentCell = validCreateBody()
    const transparentCell = invalidTransparentCell.document.pattern.mappedPixelData[0]?.[1]
    if (transparentCell) {
      transparentCell.color = '#000000'
    }
    expectInvalidDocument(invalidTransparentCell, 'WORK_DOCUMENT_INVALID')

    const lowercaseHex = validCreateBody()
    const colorCell = lowercaseHex.document.pattern.mappedPixelData[0]?.[0]
    if (colorCell) {
      colorCell.color = '#abcdef'
    }
    expectInvalidDocument(lowercaseHex, 'WORK_DOCUMENT_INVALID')

    const mismatchedStatistics = validCreateBody()
    mismatchedStatistics.document.pattern.totalBeadCount = 4
    expectInvalidDocument(mismatchedStatistics, 'WORK_DOCUMENT_INVALID')

    const tooManyColumns = validCreateBody()
    tooManyColumns.document.pattern.gridDimensions.columns = 301
    expectInvalidDocument(tooManyColumns, 'WORK_DOCUMENT_TOO_LARGE')

    const tooLargeDocument = validCreateBody()
    tooLargeDocument.document.settings = { note: 'x'.repeat(8 * 1024 * 1024) }
    expectInvalidDocument(tooLargeDocument, 'WORK_DOCUMENT_TOO_LARGE')
  })

  it('只允许已验证活动会话创建一次私密 draft，并持久化幂等结果', async () => {
    const { cookie, userId } = await signInVerifiedUser()
    const body = validCreateBody()
    const idempotencyKey = `m1-work-${randomUUID()}`

    const firstResponse = await createWorkPost(workRequest(body, cookie, idempotencyKey))
    expect(firstResponse.status).toBe(201)
    expect(firstResponse.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    const firstPayload = (await firstResponse.json()) as {
      requestId: string
      work: { workId: string; title: string; documentRevision: number; state: string }
    }
    expect(firstPayload).toMatchObject({
      work: {
        workId: expect.stringMatching(/^work_[a-f0-9]{32}$/),
        title: '2 × 2 测试图纸',
        documentRevision: 0,
        state: 'draft',
      },
      requestId: expect.any(String),
    })
    expect(JSON.stringify(firstPayload)).not.toContain('"owner"')

    const retryResponse = await createWorkPost(workRequest(body, cookie, idempotencyKey))
    expect(retryResponse.status).toBe(201)
    const retryPayload = (await retryResponse.json()) as typeof firstPayload
    expect(retryPayload.work).toEqual(firstPayload.work)
    expect(retryPayload.requestId).not.toBe(firstPayload.requestId)

    const works = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { publicId: { equals: firstPayload.work.workId } },
    })
    expect(works.docs).toHaveLength(1)
    const work = works.docs[0]
    if (!work) {
      throw new Error('未找到接口创建的作品。')
    }
    expect(work).toMatchObject({
      owner: userId,
      state: 'draft',
      visibility: 'private',
      documentRevision: 0,
      title: '2 × 2 测试图纸',
    })

    const documents = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: work.id } },
    })
    expect(documents.docs).toHaveLength(1)
    const document = documents.docs[0]
    expect(document).toMatchObject({
      owner: userId,
      work: work.id,
      revision: 0,
      schemaVersion: 1,
      kind: 'pattern',
      documentByteSize: expect.any(Number),
    })
    expect(work.currentDocument).toBe(document?.id)

    const idempotencyRecords = await payload.find({
      collection: 'api-idempotency-records',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { actor: { equals: userId } },
    })
    expect(idempotencyRecords.docs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'completed', responseStatus: 201 }),
      ]),
    )
  })

  it('拒绝未登录、缺少幂等键和不可信来源的写入', async () => {
    const body = validCreateBody()
    const noSessionResponse = await createWorkPost(workRequest(body, undefined, `m1-work-${randomUUID()}`))
    expect(noSessionResponse.status).toBe(401)
    await expect(noSessionResponse.json()).resolves.toMatchObject({
      error: { code: 'AUTH_REQUIRED', requestId: expect.any(String) },
    })

    const { cookie } = await signInVerifiedUser()
    const missingKeyResponse = await createWorkPost(workRequest(body, cookie))
    expect(missingKeyResponse.status).toBe(400)
    await expect(missingKeyResponse.json()).resolves.toMatchObject({
      error: { code: 'IDEMPOTENCY_KEY_REQUIRED', requestId: expect.any(String) },
    })

    const invalidOriginResponse = await createWorkPost(
      workRequest(body, cookie, `m1-work-${randomUUID()}`, 'https://untrusted.example'),
    )
    expect(invalidOriginResponse.status).toBe(403)
    await expect(invalidOriginResponse.json()).resolves.toMatchObject({
      error: { code: 'ORIGIN_NOT_ALLOWED', requestId: expect.any(String) },
    })
  })

  it('仅向可信来源响应含 Idempotency-Key 的业务预检', async () => {
    const trustedResponse = await createWorkOptions(
      new Request(`${origin}/api/v1/works`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      }),
    )
    expect(trustedResponse.status).toBe(204)
    expect(trustedResponse.headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(trustedResponse.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key')

    const untrustedResponse = await createWorkOptions(
      new Request(`${origin}/api/v1/works`, {
        method: 'OPTIONS',
        headers: { origin: 'https://untrusted.example' },
      }),
    )
    expect(untrustedResponse.status).toBe(403)
  })

  it('列表和详情只返回自己的 active 作品，草稿和用户 B 的作品不可读取', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const activeWorkId = await createDraftThroughApi(userA.cookie, '用户 A 的 active 作品')
    const draftWorkId = await createDraftThroughApi(userA.cookie, '用户 A 的 draft 作品')
    expect(
      (
        await patchWorkDocument(
          updateWorkRequest(
            activeWorkId,
            validUpdateBody('用户 A 的 active 作品'),
            userA.cookie,
            `m1-work-update-${randomUUID()}`,
          ),
          { params: Promise.resolve({ id: activeWorkId }) },
        )
      ).status,
    ).toBe(200)

    const listResponse = await listWorks(readWorksRequest('/api/v1/works?limit=1', userA.cookie))
    expect(listResponse.status).toBe(200)
    const listPayload = (await listResponse.json()) as {
      nextCursor: string | null
      requestId: string
      works: Array<{ state: string; workId: string; title: string }>
    }
    expect(listPayload.works).toEqual([
      expect.objectContaining({
        workId: activeWorkId,
        title: '用户 A 的 active 作品',
        state: 'active',
      }),
    ])
    expect(listPayload.works.map((work) => work.workId)).not.toContain(draftWorkId)
    expect(listPayload.nextCursor).toBeNull()

    const detailResponse = await getWorkDetail(
      readWorksRequest(`/api/v1/works/${activeWorkId}`, userA.cookie),
      { params: Promise.resolve({ id: activeWorkId }) },
    )
    expect(detailResponse.status).toBe(200)
    const detailPayload = (await detailResponse.json()) as {
      requestId: string
      work: { document: { pattern: { totalBeadCount: number } }; workId: string }
    }
    expect(detailPayload).toMatchObject({
      requestId: expect.any(String),
      work: { workId: activeWorkId, document: { pattern: { totalBeadCount: 3 } } },
    })
    expect(JSON.stringify(detailPayload)).not.toMatch(/"(?:owner|storageKey|id)"/)

    const draftDetailResponse = await getWorkDetail(
      readWorksRequest(`/api/v1/works/${draftWorkId}`, userA.cookie),
      { params: Promise.resolve({ id: draftWorkId }) },
    )
    expect(draftDetailResponse.status).toBe(404)
    await expect(draftDetailResponse.json()).resolves.toMatchObject({
      error: { code: 'WORK_NOT_FOUND', requestId: expect.any(String) },
    })

    const crossUserResponse = await getWorkDetail(
      readWorksRequest(`/api/v1/works/${activeWorkId}`, userB.cookie),
      { params: Promise.resolve({ id: activeWorkId }) },
    )
    expect(crossUserResponse.status).toBe(404)
    await expect(crossUserResponse.json()).resolves.toMatchObject({
      error: { code: 'WORK_NOT_FOUND', requestId: expect.any(String) },
    })
  })

  it('PATCH 将 draft 原子激活为 active，并保持 Work、快照和幂等结果一致', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraftThroughApi(user.cookie, '待激活的初始图纸')
    const body = validUpdateBody('已激活的图纸')
    const key = `m1-work-update-${randomUUID()}`

    const validated = validateUpdateWorkInput(body)
    expect(validated.document.materialList).toMatchObject({ generatedFromRevision: 1 })

    const firstResponse = await patchWorkDocument(updateWorkRequest(workId, body, user.cookie, key), {
      params: Promise.resolve({ id: workId }),
    })
    expect(firstResponse.status).toBe(200)
    const firstPayload = (await firstResponse.json()) as {
      requestId: string
      work: { contentSha256: string; documentRevision: number; state: string; title: string }
    }
    expect(firstPayload).toMatchObject({
      requestId: expect.any(String),
      work: {
        title: '已激活的图纸',
        state: 'active',
        documentRevision: 1,
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })

    const retryResponse = await patchWorkDocument(updateWorkRequest(workId, body, user.cookie, key), {
      params: Promise.resolve({ id: workId }),
    })
    expect(retryResponse.status).toBe(200)
    const retryPayload = (await retryResponse.json()) as typeof firstPayload
    expect(retryPayload.work).toEqual(firstPayload.work)
    expect(retryPayload.requestId).not.toBe(firstPayload.requestId)

    const workResult = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    const work = workResult.docs[0]
    if (!work || typeof work.currentDocument !== 'number') {
      throw new Error('PATCH 后未找到当前作品快照。')
    }
    expect(work).toMatchObject({
      state: 'active',
      title: '已激活的图纸',
      documentRevision: 1,
      documentSha256: firstPayload.work.contentSha256,
    })

    const documents = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: work.id } },
      sort: 'revision',
    })
    expect(documents.docs).toHaveLength(2)
    const currentDocument = documents.docs.find((document) => document.id === work.currentDocument)
    expect(currentDocument).toMatchObject({
      revision: 1,
      contentSha256: firstPayload.work.contentSha256,
      document: expect.objectContaining({
        documentRevision: 1,
        materialList: expect.objectContaining({ generatedFromRevision: 1 }),
      }),
    })
  })

  it('PATCH 拒绝旧修订、其他用户和不可信来源，且预检允许 Idempotency-Key', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const workId = await createDraftThroughApi(userA.cookie)
    const body = validUpdateBody()

    expect(
      (
        await patchWorkDocument(
          updateWorkRequest(workId, body, userA.cookie, `m1-work-update-${randomUUID()}`),
          { params: Promise.resolve({ id: workId }) },
        )
      ).status,
    ).toBe(200)

    const staleResponse = await patchWorkDocument(
      updateWorkRequest(workId, body, userA.cookie, `m1-work-update-${randomUUID()}`),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(staleResponse.status).toBe(409)
    await expect(staleResponse.json()).resolves.toMatchObject({
      error: { code: 'WORK_REVISION_CONFLICT', requestId: expect.any(String) },
    })

    const crossUserResponse = await patchWorkDocument(
      updateWorkRequest(workId, body, userB.cookie, `m1-work-update-${randomUUID()}`),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(crossUserResponse.status).toBe(404)
    await expect(crossUserResponse.json()).resolves.toMatchObject({
      error: { code: 'WORK_NOT_FOUND', requestId: expect.any(String) },
    })

    const invalidOriginResponse = await patchWorkDocument(
      updateWorkRequest(
        workId,
        body,
        userA.cookie,
        `m1-work-update-${randomUUID()}`,
        'https://untrusted.example',
      ),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(invalidOriginResponse.status).toBe(403)

    const optionsResponse = await updateWorkOptions(
      new Request(`${origin}/api/v1/works/${workId}/document`, {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'content-type,idempotency-key',
        },
      }),
    )
    expect(optionsResponse.status).toBe(204)
    expect(optionsResponse.headers.get('Access-Control-Allow-Headers')).toContain('Idempotency-Key')
  })

  it('同一修订的两个不同幂等键并发写入时，只允许一个提交', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraftThroughApi(user.cookie)
    const first = validUpdateBody('并发更新 A')
    const second = validUpdateBody('并发更新 B')

    const responses = await Promise.all([
      patchWorkDocument(
        updateWorkRequest(workId, first, user.cookie, `m1-work-update-${randomUUID()}`),
        { params: Promise.resolve({ id: workId }) },
      ),
      patchWorkDocument(
        updateWorkRequest(workId, second, user.cookie, `m1-work-update-${randomUUID()}`),
        { params: Promise.resolve({ id: workId }) },
      ),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])

    const workResult = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    const work = workResult.docs[0]
    expect(work).toMatchObject({ state: 'active', documentRevision: 1 })

    const documents = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: work?.id } },
    })
    expect(documents.docs).toHaveLength(2)
  })

  it('第 51 个 draft 激活时由数据库拒绝，且不会留下半成品快照', async () => {
    const user = await signInVerifiedUser()

    for (let index = 0; index < 50; index += 1) {
      const workId = await createDraftThroughApi(user.cookie, `激活配额 ${index + 1}`)
      const response = await patchWorkDocument(
        updateWorkRequest(workId, validUpdateBody(`激活配额 ${index + 1}`), user.cookie, `m1-work-update-${randomUUID()}`),
        { params: Promise.resolve({ id: workId }) },
      )
      if (response.status !== 200) {
        throw new Error(`第 ${index + 1} 个作品激活失败：${response.status}`)
      }
    }

    const excessWorkId = await createDraftThroughApi(user.cookie, '第 51 个作品')
    const excessResponse = await patchWorkDocument(
      updateWorkRequest(
        excessWorkId,
        validUpdateBody('第 51 个作品'),
        user.cookie,
        `m1-work-update-${randomUUID()}`,
      ),
      { params: Promise.resolve({ id: excessWorkId }) },
    )
    expect(excessResponse.status).toBe(409)
    await expect(excessResponse.json()).resolves.toMatchObject({
      error: { code: 'WORK_LIMIT_REACHED', requestId: expect.any(String) },
    })

    const excessWorkResult = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: excessWorkId } },
    })
    const excessWork = excessWorkResult.docs[0]
    expect(excessWork).toMatchObject({ state: 'draft', documentRevision: 0 })
    const excessDocuments = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: excessWork?.id } },
    })
    expect(excessDocuments.docs).toHaveLength(1)
  })

  it('草稿取消立即隐藏，幂等重试不重复变更，其他用户不能取消', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const workId = await createDraftThroughApi(userA.cookie, '待取消草稿')
    const key = `m1-work-delete-${randomUUID()}`

    const crossUser = await cancelDraftWork(
      deleteDraftRequest(workId, userB.cookie, `m1-work-delete-${randomUUID()}`),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(crossUser.status).toBe(404)

    const first = await cancelDraftWork(
      deleteDraftRequest(workId, userA.cookie, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(first.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody).toMatchObject({
      work: { workId, state: 'deleted', deletedAt: expect.any(String) },
    })

    const retry = await cancelDraftWork(
      deleteDraftRequest(workId, userA.cookie, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ work: firstBody.work })

    const hidden = await getWorkDetail(
      readWorksRequest(`/api/v1/works/${workId}`, userA.cookie),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(hidden.status).toBe(404)
    const stored = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    expect(stored.docs[0]).toMatchObject({ state: 'deleted' })
  })

  it('active 作品进入 30 天回收期，旧修订和跨用户删除均被拒绝', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const workId = await createDraftThroughApi(userA.cookie, '待回收作品')
    expect(
      (
        await patchWorkDocument(
          updateWorkRequest(workId, validUpdateBody('待回收作品'), userA.cookie, `m1-work-update-${randomUUID()}`),
          { params: Promise.resolve({ id: workId }) },
        )
      ).status,
    ).toBe(200)

    const stale = await requestWorkDeletion(
      requestDeletionRequest(workId, 0, userA.cookie, `m1-work-delete-${randomUUID()}`),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({
      error: { code: 'WORK_REVISION_CONFLICT', requestId: expect.any(String) },
    })

    const crossUser = await requestWorkDeletion(
      requestDeletionRequest(workId, 1, userB.cookie, `m1-work-delete-${randomUUID()}`),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(crossUser.status).toBe(404)

    const key = `m1-work-delete-${randomUUID()}`
    const first = await requestWorkDeletion(
      requestDeletionRequest(workId, 1, userA.cookie, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(first.status).toBe(200)
    const body = await first.json()
    expect(body).toMatchObject({
      work: {
        workId,
        state: 'pending_deletion',
        recoverableUntil: expect.any(String),
      },
    })
    expect(new Date(body.work.recoverableUntil).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000)

    const retry = await requestWorkDeletion(
      requestDeletionRequest(workId, 1, userA.cookie, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ work: body.work })

    const hidden = await getWorkDetail(
      readWorksRequest(`/api/v1/works/${workId}`, userA.cookie),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(hidden.status).toBe(404)
  })

  it('到期回收按隐藏状态和时间执行，并删除作品历史快照', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraftThroughApi(user.cookie, '到期回收测试')
    const storedBefore = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    const work = storedBefore.docs[0]
    if (!work) {
      throw new Error('未找到回收测试作品。')
    }

    await payload.update({
      collection: 'works',
      id: work.id,
      data: {
        state: 'deleted',
        deletedAt: new Date(Date.now() - 2_000).toISOString(),
        recoverableUntil: new Date(Date.now() - 1_000).toISOString(),
      },
      overrideAccess: true,
    })

    expect(await purgeExpiredWorks(payload)).toBeGreaterThanOrEqual(1)
    const storedAfter = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    expect(storedAfter.docs).toHaveLength(0)
    const documents = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: work.id } },
    })
    expect(documents.docs).toHaveLength(0)
  })
})
