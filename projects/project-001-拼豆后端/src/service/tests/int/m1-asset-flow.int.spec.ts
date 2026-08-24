// 文件开头说明：验证 M1 本地受控图片闭环。只用随机本地用户、临时作品和项目内
// Git 忽略对象目录；不连接 R2/S3、真实邮件、真实前端或 Workspace 外部路径。
import { createHash, randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { readBoundedBinaryBody } from '@/api/business-http'
import { POST as createWorkPost } from '@/app/api/v1/works/route'
import { POST as confirmAssetPost } from '@/app/api/v1/works/[id]/assets/confirm/route'
import { GET as getAsset } from '@/app/api/v1/works/[id]/assets/[assetId]/route'
import { POST as uploadIntentPost } from '@/app/api/v1/works/[id]/assets/upload-intent/route'
import { PUT as uploadAssetPut } from '@/app/api/v1/works/[id]/assets/[assetId]/upload/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import { purgeExpiredOrphanedAssets } from '@/assets/service'
import { MAX_ASSET_BYTES } from '@/assets/validation'
import { localObjectExists } from '@/storage/local-object-store'
import config from '@/payload.config'

let payload: Payload

const origin = 'http://127.0.0.1:3002'
const checksum = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

const validCreateBody = () => ({
  title: '上传测试图纸',
  kind: 'pattern',
  document: {
    schemaVersion: 1,
    kind: 'pattern',
    title: '上传测试图纸',
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

const createWorkRequest = (body: unknown, cookie: string): Request =>
  new Request(`${origin}/api/v1/works`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'idempotency-key': `asset-work-${randomUUID()}`,
    },
    body: JSON.stringify(body),
  })

const writeRequest = (url: string, body: unknown, cookie: string, idempotencyKey = `asset-${randomUUID()}`): Request =>
  new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie,
      origin,
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  })

const uploadRequest = (url: string, content: Buffer, cookie: string, contentType = 'image/png'): Request =>
  new Request(url, {
    method: 'PUT',
    headers: { 'content-type': contentType, cookie, origin },
    body: content,
  })

const readOnlyRequest = (url: string, cookie?: string): Request =>
  new Request(url, { headers: { ...(cookie ? { cookie } : {}), origin } })

const signInVerifiedUser = async (): Promise<{ cookie: string; userId: number }> => {
  const email = `m1-asset-${randomUUID()}@example.com`
  const password = 'M1-asset-test-password-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name: 'M1 Asset Test', email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('本地 outbox 未生成资产测试 OTP。')
  }
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('资产测试未取得会话 Cookie。')
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
    throw new Error('资产测试未找到用户。')
  }
  return { cookie, userId }
}

const createDraft = async (cookie: string): Promise<string> => {
  const response = await createWorkPost(createWorkRequest(validCreateBody(), cookie))
  if (response.status !== 201) {
    throw new Error(`创建资产测试 draft 失败：${response.status}`)
  }
  return ((await response.json()) as { work: { workId: string } }).work.workId
}

const createPng = (): Promise<Buffer> =>
  sharp({ create: { background: '#123456', channels: 3, height: 2, width: 2 } }).png().toBuffer()

const createDifferentPng = (): Promise<Buffer> =>
  sharp({ create: { background: '#abcdef', channels: 3, height: 2, width: 2 } }).png().toBuffer()

const createIntent = async (cookie: string, workId: string, content: Buffer, key = `intent-${randomUUID()}`) => {
  const response = await uploadIntentPost(
    writeRequest(
      `${origin}/api/v1/works/${workId}/assets/upload-intent`,
      { role: 'original', mimeType: 'image/png', sizeBytes: content.length, sha256: checksum(content) },
      cookie,
      key,
    ),
    { params: Promise.resolve({ id: workId }) },
  )
  return response
}

describe('M1 本地受控文件上传', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('对缺失或伪造 Content-Length 的分块超限请求在读取时拒绝', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_ASSET_BYTES))
        controller.enqueue(new Uint8Array(1))
        controller.close()
      },
    })
    const request = new Request('http://127.0.0.1/upload', {
      method: 'PUT',
      body,
      // Node 的 Fetch 要求流式请求显式声明 duplex；Next Route Handler
      // 仍接收标准 Web Request body。
      duplex: 'half',
    } as RequestInit)

    await expect(readBoundedBinaryBody(request, MAX_ASSET_BYTES)).rejects.toMatchObject({
      code: 'ASSET_TOO_LARGE',
      status: 413,
    })
  })

  it('完成 intent、PUT、confirm、私有读取与幂等重试，且不泄露存储键', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraft(user.cookie)
    const content = await createPng()
    const intentKey = `intent-${randomUUID()}`
    const intent = await createIntent(user.cookie, workId, content, intentKey)
    expect(intent.status).toBe(201)
    const intentBody = (await intent.json()) as { asset: { assetId: string; storageKey?: string }; upload: { url: string }; expiresAt: string }
    expect(intentBody.asset.storageKey).toBeUndefined()
    expect(intentBody.upload.url).toBe(`/api/v1/works/${workId}/assets/${intentBody.asset.assetId}/upload`)
    expect(new Date(intentBody.expiresAt).getTime()).toBeGreaterThan(Date.now())

    const duplicateIntent = await createIntent(user.cookie, workId, content, intentKey)
    expect(duplicateIntent.status).toBe(201)
    await expect(duplicateIntent.json()).resolves.toMatchObject({ asset: { assetId: intentBody.asset.assetId } })

    const putUrl = `${origin}${intentBody.upload.url}`
    expect(
      (
        await uploadAssetPut(uploadRequest(putUrl, content, user.cookie), {
          params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }),
        })
      ).status,
    ).toBe(204)
    const differentContent = await createDifferentPng()
    expect(
      (
        await uploadAssetPut(uploadRequest(putUrl, differentContent, user.cookie), {
          params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }),
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await uploadAssetPut(uploadRequest(putUrl, content, user.cookie), {
          params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }),
        })
      ).status,
    ).toBe(204)

    const confirmKey = `confirm-${randomUUID()}`
    const confirm = await confirmAssetPost(
      writeRequest(
        `${origin}/api/v1/works/${workId}/assets/confirm`,
        { assetId: intentBody.asset.assetId, sha256: checksum(content) },
        user.cookie,
        confirmKey,
      ),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(confirm.status).toBe(200)
    await expect(confirm.json()).resolves.toMatchObject({
      asset: { assetId: intentBody.asset.assetId, status: 'ready', mimeType: 'image/png' },
    })
    const repeatedConfirm = await confirmAssetPost(
      writeRequest(
        `${origin}/api/v1/works/${workId}/assets/confirm`,
        { assetId: intentBody.asset.assetId, sha256: checksum(content) },
        user.cookie,
        confirmKey,
      ),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(repeatedConfirm.status).toBe(200)

    const download = await getAsset(
      new Request(`${origin}/api/v1/works/${workId}/assets/${intentBody.asset.assetId}`, {
        headers: { cookie: user.cookie, origin },
      }),
      { params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }) },
    )
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toBe('image/png')
    expect(download.headers.get('content-disposition')).toBe('attachment; filename="asset"')
    expect(download.headers.get('x-content-type-options')).toBe('nosniff')
    expect(download.headers.get('x-request-id')).toEqual(expect.any(String))
    expect(Buffer.from(await download.arrayBuffer())).toEqual(content)
  })

  it('拒绝伪造 MIME、哈希不匹配与用户 B 读取，失败对象不保留', async () => {
    const userA = await signInVerifiedUser()
    const userB = await signInVerifiedUser()
    const workId = await createDraft(userA.cookie)
    const content = await createPng()
    const intent = await createIntent(userA.cookie, workId, content)
    const intentBody = (await intent.json()) as { asset: { assetId: string }; upload: { url: string } }
    const putUrl = `${origin}${intentBody.upload.url}`

    const forgedType = await uploadAssetPut(
      uploadRequest(putUrl, Buffer.from('<svg><script>alert(1)</script></svg>'), userA.cookie),
      { params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }) },
    )
    expect(forgedType.status).toBe(422)

    const asset = await payload.find({
      collection: 'work-assets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: intentBody.asset.assetId } },
    })
    expect(asset.docs[0]).toMatchObject({ status: 'validation_failed' })
    if (asset.docs[0]) {
      expect(await localObjectExists(asset.docs[0].storageKey)).toBe(false)
    }

    const otherUserRead = await getAsset(
      new Request(`${origin}/api/v1/works/${workId}/assets/${intentBody.asset.assetId}`, {
        headers: { cookie: userB.cookie, origin },
      }),
      { params: Promise.resolve({ id: workId, assetId: intentBody.asset.assetId }) },
    )
    expect(otherUserRead.status).toBe(404)
  })

  it('拒绝错误 SHA、超过限额、未知来源与未登录读取', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraft(user.cookie)
    const content = await createPng()
    const wrongHashIntent = await uploadIntentPost(
      writeRequest(
        `${origin}/api/v1/works/${workId}/assets/upload-intent`,
        { role: 'original', mimeType: 'image/png', sizeBytes: content.length, sha256: '0'.repeat(64) },
        user.cookie,
      ),
      { params: Promise.resolve({ id: workId }) },
    )
    const wrongHashBody = (await wrongHashIntent.json()) as { asset: { assetId: string }; upload: { url: string } }
    expect(
      (
        await uploadAssetPut(
          uploadRequest(`${origin}${wrongHashBody.upload.url}`, content, user.cookie),
          { params: Promise.resolve({ id: workId, assetId: wrongHashBody.asset.assetId }) },
        )
      ).status,
    ).toBe(422)

    const oversizedIntent = await uploadIntentPost(
      writeRequest(
        `${origin}/api/v1/works/${workId}/assets/upload-intent`,
        {
          role: 'original',
          mimeType: 'image/png',
          sizeBytes: MAX_ASSET_BYTES + 1,
          sha256: '1'.repeat(64),
        },
        user.cookie,
      ),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(oversizedIntent.status).toBe(422)

    const unknownOrigin = await uploadIntentPost(
      new Request(`${origin}/api/v1/works/${workId}/assets/upload-intent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: user.cookie,
          origin: 'https://untrusted.example',
          'idempotency-key': `origin-${randomUUID()}`,
        },
        body: JSON.stringify({ role: 'original', mimeType: 'image/png', sizeBytes: content.length, sha256: checksum(content) }),
      }),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(unknownOrigin.status).toBe(403)

    const unauthenticatedRead = await getAsset(
      readOnlyRequest(`${origin}/api/v1/works/${workId}/assets/asset_${'a'.repeat(32)}`),
      { params: Promise.resolve({ id: workId, assetId: `asset_${'a'.repeat(32)}` }) },
    )
    expect(unauthenticatedRead.status).toBe(401)
  })

  it('可清理过期的未上传或已上传但未确认 asset，不触及项目目录外文件', async () => {
    const user = await signInVerifiedUser()
    const workId = await createDraft(user.cookie)
    const content = await createPng()
    const intent = await createIntent(user.cookie, workId, content)
    const intentBody = (await intent.json()) as { asset: { assetId: string } }
    const asset = await payload.find({
      collection: 'work-assets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { publicId: { equals: intentBody.asset.assetId } },
    })
    const assetId = asset.docs[0]?.id
    const publicAssetId = asset.docs[0]?.publicId
    if (!assetId || !publicAssetId) {
      throw new Error('未找到待清理 asset。')
    }
    expect(
      (
        await uploadAssetPut(
          uploadRequest(
            `${origin}/api/v1/works/${workId}/assets/${publicAssetId}/upload`,
            content,
            user.cookie,
          ),
          { params: Promise.resolve({ id: workId, assetId: publicAssetId }) },
        )
      ).status,
    ).toBe(204)
    expect(await localObjectExists(asset.docs[0].storageKey)).toBe(true)
    await payload.update({
      collection: 'work-assets',
      id: assetId,
      data: { uploadExpiresAt: new Date(Date.now() - 1_000).toISOString() },
      overrideAccess: true,
    })
    const context = {
      payload,
      requestId: 'asset-cleanup-test',
      req: {} as never,
      user: { id: user.userId } as never,
    }
    expect(await purgeExpiredOrphanedAssets(context)).toBeGreaterThanOrEqual(1)
    const after = await payload.find({
      collection: 'work-assets',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: { id: { equals: assetId } },
    })
    expect(after.docs).toHaveLength(0)
  })
})
