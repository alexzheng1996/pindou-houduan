// 文件开头说明：验证 M1 board v1 的服务端边界。测试只使用随机本地账号、项目内
// 私有对象目录和已冻结的 API 契约；不修改 PixoMosaic 前端，也不连接任何云资源。
import { createHash, randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { POST as createWorkPost } from '@/app/api/v1/works/route'
import { POST as confirmAssetPost } from '@/app/api/v1/works/[id]/assets/confirm/route'
import { POST as uploadIntentPost } from '@/app/api/v1/works/[id]/assets/upload-intent/route'
import { PUT as uploadAssetPut } from '@/app/api/v1/works/[id]/assets/[assetId]/upload/route'
import { PATCH as patchWorkDocument } from '@/app/api/v1/works/[id]/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import { validateCreateWorkInput, WorkDocumentValidationError } from '@/works/validation'
import config from '@/payload.config'

let payload: Payload

const origin = 'http://127.0.0.1:3000'
const checksum = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

const cell = (key = '#123456', color = '#123456') => ({ key, color, isExternal: false })

const boardDocument = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: 'board',
  title: '画板云端测试',
  documentRevision: 0,
  settings: {},
  pattern: null,
  board: {
    size: { width: 4, height: 3 },
    overlapMode: 'cover',
    beadSizeMm: 2.6,
    layers: [
      {
        layerId: 'layer_1',
        name: '图片图层',
        x: 0,
        y: 0,
        width: 2,
        height: 2,
        zIndex: 1,
        gridDimensions: { columns: 2, rows: 2 },
        mappedPixelData: [[cell(), cell()], [cell(), cell()]],
        colorCounts: { '#123456': { count: 4, color: '#123456' } },
        totalBeadCount: 4,
        selectedColorSystem: 'MARD',
        sourceImportMode: 'image',
        templateImportConfidence: null,
        sourceAssetId: null,
        thumbnailAssetId: null,
        generation: {
          subjectWidth: 2,
          similarityThreshold: 0,
          backgroundTolerance: 0,
          colorLimit: 8,
          pixelationMode: 'dominant',
          preprocessMode: 'crisp',
          removeBackgroundOnRegenerate: false,
        },
        regenerationCapability: 'unavailable',
      },
    ],
    directPixels: {
      '3,2': { ...cell('#ABCDEF', '#ABCDEF'), colorMode: 'final' },
    },
    erasePixels: { '1,1': true },
    colorReplacements: {
      '#123456': cell('#ABCDEF', '#ABCDEF'),
    },
  },
  materialList: {
    status: 'generated',
    generatedFromRevision: 1,
    items: [{ colorKey: '#ABCDEF', color: '#ABCDEF', count: 4 }],
  },
  ...overrides,
})

const createBoardBody = () => ({
  title: '画板云端测试',
  kind: 'board',
  document: boardDocument({
    documentRevision: 0,
    materialList: { status: 'not_generated', items: [] },
  }),
})

const authRequest = (path: string, body: Record<string, string>): Request =>
  new Request(`${origin}/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })

const writeRequest = (
  url: string,
  body: unknown,
  cookie: string,
  method = 'POST',
  key = `board-${randomUUID()}`,
): Request =>
  new Request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })

const signInVerifiedUser = async (): Promise<{ cookie: string }> => {
  const email = `m1-board-${randomUUID()}@example.com`
  const password = 'M1-board-test-password-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name: 'M1 Board Test', email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('本地 outbox 未生成画板测试 OTP。')
  }
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('画板测试未取得会话 Cookie。')
  }
  return { cookie }
}

const createBoardDraft = async (cookie: string): Promise<string> => {
  const response = await createWorkPost(
    writeRequest(`${origin}/api/v1/works`, createBoardBody(), cookie, 'POST', `create-${randomUUID()}`),
  )
  if (response.status !== 201) {
    throw new Error(`创建 board draft 失败：${response.status}`)
  }
  return ((await response.json()) as { work: { workId: string } }).work.workId
}

const createPng = (): Promise<Buffer> =>
  sharp({ create: { background: '#123456', channels: 3, height: 2, width: 2 } }).png().toBuffer()

const uploadReadyAsset = async (
  cookie: string,
  workId: string,
  role: 'display' | 'original' | 'thumbnail',
  shouldConfirm = true,
): Promise<string> => {
  const content = await createPng()
  const intent = await uploadIntentPost(
    writeRequest(
      `${origin}/api/v1/works/${workId}/assets/upload-intent`,
      { role, mimeType: 'image/png', sizeBytes: content.length, sha256: checksum(content) },
      cookie,
      'POST',
      `intent-${randomUUID()}`,
    ),
    { params: Promise.resolve({ id: workId }) },
  )
  if (intent.status !== 201) {
    throw new Error(`创建上传意图失败：${intent.status}`)
  }
  const intentBody = (await intent.json()) as { asset: { assetId: string }; upload: { url: string } }
  const upload = await uploadAssetPut(
    new Request(`${origin}${intentBody.upload.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', cookie, origin },
      body: content,
    }),
    { params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }) },
  )
  if (upload.status !== 204) {
    throw new Error(`上传画板资产失败：${upload.status}`)
  }
  if (!shouldConfirm) {
    return intentBody.asset.assetId
  }
  const confirmResponse = await confirmAssetPost(
    writeRequest(
      `${origin}/api/v1/works/${workId}/assets/confirm`,
      { assetId: intentBody.asset.assetId, sha256: checksum(content) },
      cookie,
      'POST',
      `confirm-${randomUUID()}`,
    ),
    { params: Promise.resolve({ id: workId }) },
  )
  if (confirmResponse.status !== 200) {
    throw new Error(`确认画板资产失败：${confirmResponse.status}`)
  }
  return intentBody.asset.assetId
}

const patchBoard = async (cookie: string, workId: string, document: unknown, key = `patch-${randomUUID()}`) =>
  patchWorkDocument(
    writeRequest(
      `${origin}/api/v1/works/${workId}/document`,
      { expectedRevision: 0, document },
      cookie,
      'PATCH',
      key,
    ),
    { params: Promise.resolve({ id: workId }) },
  )

describe('M1 board 文档与资产引用', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('严格拒绝越界、重叠、重复层、直接/擦除冲突和资产化前的 board 创建', () => {
    const valid = createBoardBody()
    expect(validateCreateWorkInput(valid)).toMatchObject({ kind: 'board', title: '画板云端测试' })

    const withAsset = createBoardBody()
    ;((withAsset.document.board as { layers: Array<Record<string, unknown>> }).layers[0] as Record<string, unknown>).sourceAssetId = `asset_${'a'.repeat(32)}`
    ;((withAsset.document.board as { layers: Array<Record<string, unknown>> }).layers[0] as Record<string, unknown>).regenerationCapability = 'available'
    expect(() => validateCreateWorkInput(withAsset)).toThrow(WorkDocumentValidationError)

    const overlap = boardDocument()
    ;(overlap.board as { overlapMode: string; layers: unknown[] }).overlapMode = 'avoid'
    ;(overlap.board as { layers: unknown[] }).layers = [
      ...(overlap.board as { layers: unknown[] }).layers,
      {
        ...((overlap.board as { layers: Array<Record<string, unknown>> }).layers[0]),
        layerId: 'layer_2',
        zIndex: 2,
      },
    ]
    expect(() => validateCreateWorkInput({ title: overlap.title, kind: 'board', document: overlap })).toThrow(WorkDocumentValidationError)

    const coordinateConflict = boardDocument()
    ;(coordinateConflict.board as { erasePixels: Record<string, true> }).erasePixels = { '3,2': true }
    expect(() => validateCreateWorkInput({ title: coordinateConflict.title, kind: 'board', document: coordinateConflict })).toThrow(WorkDocumentValidationError)

    const chainedReplacement = boardDocument()
    ;(chainedReplacement.board as { colorReplacements: Record<string, unknown> }).colorReplacements = {
      '#123456': cell('#ABCDEF', '#ABCDEF'),
      '#ABCDEF': cell('#FEDCBA', '#FEDCBA'),
    }
    expect(() => validateCreateWorkInput({ title: chainedReplacement.title, kind: 'board', document: chainedReplacement })).toThrow(WorkDocumentValidationError)
  })

  it('仅允许同一作品、当前用户且 ready 的对应角色资产被 board 引用，并保持 PATCH 幂等', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const workA = await createBoardDraft(userA.cookie)
    const workB = await createBoardDraft(userA.cookie)
    const originalA = await uploadReadyAsset(userA.cookie, workA, 'original')
    const thumbnailA = await uploadReadyAsset(userA.cookie, workA, 'thumbnail')
    await uploadReadyAsset(userA.cookie, workB, 'original')

    const document = boardDocument()
    const layer = (document.board as { layers: Array<Record<string, unknown>> }).layers[0]
    if (!layer) {
      throw new Error('缺少 board 测试图层。')
    }
    layer.sourceAssetId = originalA
    layer.thumbnailAssetId = thumbnailA
    layer.regenerationCapability = 'available'

    const key = `board-patch-${randomUUID()}`
    const first = await patchBoard(userA.cookie, workA, document, key)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({
      work: { workId: workA, kind: 'board', state: 'active', documentRevision: 1 },
    })
    const retry = await patchBoard(userA.cookie, workA, document, key)
    expect(retry.status).toBe(200)
    const storedWork = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workA } },
    })
    const workRecord = storedWork.docs[0]
    if (!workRecord) {
      throw new Error('未找到已保存的 board 作品。')
    }
    const savedDocuments = await payload.find({
      collection: 'work-documents',
      depth: 0,
      limit: 10,
      overrideAccess: true,
      where: { work: { equals: workRecord.id } },
    })
    expect(savedDocuments.docs).toHaveLength(2)

    const foreignWorkDocument = boardDocument()
    const foreignLayer = (foreignWorkDocument.board as { layers: Array<Record<string, unknown>> }).layers[0]
    if (!foreignLayer) {
      throw new Error('缺少跨作品图层。')
    }
    foreignLayer.sourceAssetId = originalA
    foreignLayer.regenerationCapability = 'available'
    const foreignWork = await patchBoard(userA.cookie, workB, foreignWorkDocument)
    expect(foreignWork.status).toBe(422)
    await expect(foreignWork.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_READY' } })

    const otherUserWork = await createBoardDraft(userB.cookie)
    const crossUserDocument = boardDocument()
    const crossUserLayer = (crossUserDocument.board as { layers: Array<Record<string, unknown>> }).layers[0]
    if (!crossUserLayer) {
      throw new Error('缺少跨用户图层。')
    }
    crossUserLayer.sourceAssetId = originalA
    crossUserLayer.regenerationCapability = 'available'
    const crossUser = await patchBoard(userB.cookie, otherUserWork, crossUserDocument)
    expect(crossUser.status).toBe(422)
    await expect(crossUser.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_READY' } })
  })

  it('拒绝 uploaded 未确认资产和错误角色，并且不激活作品', async () => {
    const user = await signInVerifiedUser()
    const workId = await createBoardDraft(user.cookie)
    const uploadedOriginal = await uploadReadyAsset(user.cookie, workId, 'original', false)
    const document = boardDocument()
    const layer = (document.board as { layers: Array<Record<string, unknown>> }).layers[0]
    if (!layer) {
      throw new Error('缺少错误角色图层。')
    }
    layer.sourceAssetId = uploadedOriginal
    layer.regenerationCapability = 'available'

    const notConfirmed = await patchBoard(user.cookie, workId, document)
    expect(notConfirmed.status).toBe(422)
    await expect(notConfirmed.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_READY' } })

    const display = await uploadReadyAsset(user.cookie, workId, 'display')
    layer.sourceAssetId = display
    const wrongRole = await patchBoard(user.cookie, workId, document)
    expect(wrongRole.status).toBe(422)
    await expect(wrongRole.json()).resolves.toMatchObject({ error: { code: 'ASSET_NOT_READY' } })

    const stored = await payload.find({
      collection: 'works',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: workId } },
    })
    expect(stored.docs[0]).toMatchObject({ state: 'draft', documentRevision: 0 })
  })
})
