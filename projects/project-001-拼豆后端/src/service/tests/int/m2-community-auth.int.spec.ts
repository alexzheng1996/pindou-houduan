// 文件开头说明：M2 认证主链路回归测试。所有账号、作品和社区媒体均为随机本地
// 测试对象；重点固定发布快照、A/B 隔离、board 资产净化与删除/恢复边界。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { POST as publishCommunity, GET as listCommunity } from '@/app/api/v1/community/route'
import { GET as getCommunity, PATCH as updateCommunity } from '@/app/api/v1/community/[id]/route'
import { POST as copyCommunity } from '@/app/api/v1/community/[id]/copy/route'
import { POST as uploadCommunityMedia } from '@/app/api/v1/community/media/upload/route'
import { POST as requestWorkDeletion } from '@/app/api/v1/works/[id]/deletion-request/route'
import { GET as getWork, PATCH as updateWork } from '@/app/api/v1/works/[id]/route'
import { POST as createWork } from '@/app/api/v1/works/route'
import { POST as restoreWork } from '@/app/api/v1/library/works/[id]/restore/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import config from '@/payload.config'

const origin = 'http://127.0.0.1:3002'
let payload: Payload

type TestUser = { cookie: string; userId: number }

const cell = (key = '#123456', color = '#123456') => ({ key, color, isExternal: false })

const patternDocument = (title: string, revision: number, color = '#123456', generated = true) => ({
  schemaVersion: 1,
  kind: 'pattern',
  title,
  documentRevision: revision,
  settings: {},
  pattern: {
    beadSizeMm: 2.6,
    gridDimensions: { columns: 2, rows: 2 },
    mappedPixelData: [[cell(color, color), cell(color, color)], [cell(color, color), cell(color, color)]],
    colorCounts: { [color]: { count: 4, color } },
    totalBeadCount: 4,
  },
  board: null,
  materialList: generated
    ? { status: 'generated', generatedFromRevision: revision + 1, items: [{ colorKey: color, color, count: 4 }] }
    : { status: 'not_generated', items: [] },
})

const boardDocument = (
  title: string,
  revision: number,
  sourceAssetId: string | null,
  thumbnailAssetId: string | null,
  generated = true,
) => ({
  schemaVersion: 1,
  kind: 'board',
  title,
  documentRevision: revision,
  settings: {},
  pattern: null,
  board: {
    size: { width: 2, height: 2 },
    overlapMode: 'cover',
    beadSizeMm: 2.6,
    layers: [{
      layerId: 'layer_m2_source',
      name: '来源图片图层',
      x: 0, y: 0, width: 2, height: 2, zIndex: 1,
      gridDimensions: { columns: 2, rows: 2 },
      mappedPixelData: [[cell(), cell()], [cell(), cell()]],
      colorCounts: { '#123456': { count: 4, color: '#123456' } },
      totalBeadCount: 4,
      selectedColorSystem: 'MARD',
      sourceImportMode: 'image',
      templateImportConfidence: null,
      sourceAssetId,
      thumbnailAssetId,
      generation: {
        subjectWidth: 2, similarityThreshold: 0, backgroundTolerance: 0, colorLimit: 8,
        pixelationMode: 'dominant', preprocessMode: 'crisp', removeBackgroundOnRegenerate: false,
      },
      regenerationCapability: sourceAssetId || thumbnailAssetId ? 'available' : 'unavailable',
    }],
    directPixels: {},
    erasePixels: {},
    colorReplacements: {},
  },
  materialList: generated
    ? { status: 'generated', generatedFromRevision: revision + 1, items: [{ colorKey: '#123456', color: '#123456', count: 4 }] }
    : { status: 'not_generated', items: [] },
})

const authRequest = (path: string, body: Record<string, string>) => new Request(`${origin}/api/v1/auth${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
})

const jsonWrite = (url: string, body: unknown, cookie: string, method = 'POST', key = `m2-${randomUUID()}`) => new Request(url, {
  method,
  headers: { 'content-type': 'application/json', cookie, origin, 'idempotency-key': key },
  body: JSON.stringify(body),
})

const signedInUser = async (name: string): Promise<TestUser> => {
  const email = `m2-community-${randomUUID()}@example.com`
  const password = 'M2-community-local-test-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name, email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') throw new Error('M2 测试未取得邮箱验证 OTP。')
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('M2 测试未取得登录 Cookie。')
  const users = await payload.find({ collection: 'users', depth: 0, limit: 1, overrideAccess: true, where: { email: { equals: email } } })
  const userId = users.docs[0]?.id
  if (!userId) throw new Error('M2 测试未找到已验证用户。')
  return { cookie, userId }
}

const createActivePattern = async (user: TestUser, title: string): Promise<string> => {
  const draft = await createWork(jsonWrite(`${origin}/api/v1/works`, { title, kind: 'pattern', document: patternDocument(title, 0, '#123456', false) }, user.cookie))
  expect(draft.status).toBe(201)
  const workId = ((await draft.json()) as { work: { workId: string } }).work.workId
  const active = await updateWork(jsonWrite(`${origin}/api/v1/works/${workId}/document`, { expectedRevision: 0, document: patternDocument(title, 0) }, user.cookie, 'PATCH'), { params: Promise.resolve({ id: workId }) })
  expect(active.status).toBe(200)
  return workId
}

const createActiveBoard = async (user: TestUser, title: string): Promise<{ workId: string; originalId: string; thumbnailId: string }> => {
  const draft = await createWork(jsonWrite(`${origin}/api/v1/works`, { title, kind: 'board', document: boardDocument(title, 0, null, null, false) }, user.cookie))
  expect(draft.status).toBe(201)
  const workId = ((await draft.json()) as { work: { workId: string } }).work.workId
  const work = await payload.find({ collection: 'works', depth: 0, limit: 1, overrideAccess: true, where: { publicId: { equals: workId } } })
  const workRecord = work.docs[0]
  if (!workRecord) throw new Error('M2 board 测试未找到 draft。')
  const createAsset = async (role: 'original' | 'thumbnail') => {
    const assetId = `asset_${randomUUID().replaceAll('-', '')}`
    await payload.create({
      collection: 'work-assets', overrideAccess: true,
      data: {
        publicId: assetId, owner: user.userId, work: workRecord.id, role, status: 'ready', visibility: 'private',
        mimeType: 'image/png', detectedMimeType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64),
        storageKey: `m2-test/${assetId}`, confirmedAt: new Date().toISOString(),
      },
    })
    return assetId
  }
  const originalId = await createAsset('original')
  const thumbnailId = await createAsset('thumbnail')
  const active = await updateWork(jsonWrite(`${origin}/api/v1/works/${workId}/document`, { expectedRevision: 0, document: boardDocument(title, 0, originalId, thumbnailId) }, user.cookie, 'PATCH'), { params: Promise.resolve({ id: workId }) })
  expect(active.status).toBe(200)
  return { workId, originalId, thumbnailId }
}

const uploadCover = async (user: TestUser): Promise<string> => {
  const content = await sharp({ create: { background: '#123456', channels: 3, height: 2, width: 2 } }).png().toBuffer()
  const response = await uploadCommunityMedia(new Request(`${origin}/api/v1/community/media/upload`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', cookie: user.cookie, origin, 'idempotency-key': `m2-media-${randomUUID()}`, 'x-community-media-role': 'cover' },
    body: content,
  }))
  expect(response.status).toBe(201)
  return ((await response.json()) as { media: { mediaId: string } }).media.mediaId
}

const publish = async (user: TestUser, workId: string, title: string, allowCopy = true): Promise<string> => {
  const coverMediaId = await uploadCover(user)
  const response = await publishCommunity(jsonWrite(`${origin}/api/v1/community`, {
    workId, title, category: '人物', tags: ['M2', '测试'], coverMediaId, copyrightConfirmed: true, allowCopy,
  }, user.cookie))
  expect(response.status).toBe(201)
  return ((await response.json()) as { post: { postId: string } }).post.postId
}

describe('M2 认证发布、复制与回收主链路', () => {
  beforeAll(async () => { payload = await getPayload({ config: await config }) })
  beforeEach(async () => { await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} }) })
  afterAll(async () => { await payload?.destroy() })

  it('冻结 pattern 版本、复制保持 A/B 隔离，并在删除后下架且恢复不自动公开', async () => {
    const author = await signedInUser('M2 Pattern Author')
    const copier = await signedInUser('M2 Pattern Copier')
    const workId = await createActivePattern(author, '冻结前的单图')
    const postId = await publish(author, workId, '公开的冻结单图')

    const anonymousBefore = await getCommunity(new Request(`${origin}/api/v1/community/${postId}`), { params: Promise.resolve({ id: postId }) })
    expect(anonymousBefore.status).toBe(200)
    const publicBody = await anonymousBefore.json()
    expect(JSON.stringify(publicBody)).not.toMatch(/(?:email|owner|document|storageKey|inventory)/i)

    const privateUpdate = await updateWork(jsonWrite(`${origin}/api/v1/works/${workId}/document`, { expectedRevision: 1, document: patternDocument('私有修改不应影响公开快照', 1, '#ABCDEF') }, author.cookie, 'PATCH'), { params: Promise.resolve({ id: workId }) })
    expect(privateUpdate.status).toBe(200)
    const pool = (payload.db as unknown as { pool: { query: (query: string, values: unknown[]) => Promise<{ rows: Array<{ document: unknown }> }> } }).pool
    const frozen = await pool.query('SELECT v.document FROM published_pattern_versions v JOIN community_posts p ON p.current_version_id = v.id WHERE p.public_id = $1', [postId])
    expect(JSON.stringify(frozen.rows[0]?.document)).toContain('#123456')
    expect(JSON.stringify(frozen.rows[0]?.document)).not.toContain('#ABCDEF')

    const copyKey = `m2-copy-${randomUUID()}`
    const copied = await copyCommunity(jsonWrite(`${origin}/api/v1/community/${postId}/copy`, {}, copier.cookie, 'POST', copyKey), { params: Promise.resolve({ id: postId }) })
    if (copied.status !== 201) throw new Error(`复制失败 ${copied.status}: ${JSON.stringify(await copied.json())}`)
    const copiedBody = (await copied.json()) as { work: { workId: string } }
    const retry = await copyCommunity(jsonWrite(`${origin}/api/v1/community/${postId}/copy`, {}, copier.cookie, 'POST', copyKey), { params: Promise.resolve({ id: postId }) })
    expect(retry.status).toBe(201)
    await expect(retry.json()).resolves.toMatchObject({ work: { workId: copiedBody.work.workId } })
    const authorCannotReadCopy = await getWork(new Request(`${origin}/api/v1/works/${copiedBody.work.workId}`, { headers: { cookie: author.cookie, origin } }), { params: Promise.resolve({ id: copiedBody.work.workId }) })
    expect(authorCannotReadCopy.status).toBe(404)

    const deletion = await requestWorkDeletion(jsonWrite(`${origin}/api/v1/works/${workId}/deletion-request`, { expectedRevision: 2 }, author.cookie), { params: Promise.resolve({ id: workId }) })
    expect(deletion.status).toBe(200)
    const afterDeletion = await getCommunity(new Request(`${origin}/api/v1/community/${postId}`), { params: Promise.resolve({ id: postId }) })
    expect(afterDeletion.status).toBe(404)
    const existingCopy = await getWork(new Request(`${origin}/api/v1/works/${copiedBody.work.workId}`, { headers: { cookie: copier.cookie, origin } }), { params: Promise.resolve({ id: copiedBody.work.workId }) })
    expect(existingCopy.status).toBe(200)

    const restored = await restoreWork(jsonWrite(`${origin}/api/v1/library/works/${workId}/restore`, { expectedRevision: 2 }, author.cookie), { params: Promise.resolve({ id: workId }) })
    expect(restored.status).toBe(200)
    const afterRestore = await getCommunity(new Request(`${origin}/api/v1/community/${postId}`), { params: Promise.resolve({ id: postId }) })
    expect(afterRestore.status).toBe(404)
  })

  it('复制 board 清除私有资产引用，且作者关闭复制后 API 拒绝新副本', async () => {
    const author = await signedInUser('M2 Board Author')
    const copier = await signedInUser('M2 Board Copier')
    const source = await createActiveBoard(author, '含私有资产的画板')
    const postId = await publish(author, source.workId, '可复制的画板')

    const copied = await copyCommunity(jsonWrite(`${origin}/api/v1/community/${postId}/copy`, {}, copier.cookie), { params: Promise.resolve({ id: postId }) })
    expect(copied.status).toBe(201)
    const copiedWorkId = ((await copied.json()) as { work: { workId: string } }).work.workId
    const copiedWork = await getWork(new Request(`${origin}/api/v1/works/${copiedWorkId}`, { headers: { cookie: copier.cookie, origin } }), { params: Promise.resolve({ id: copiedWorkId }) })
    expect(copiedWork.status).toBe(200)
    const copiedDocument = (await copiedWork.json()) as { work: { document: { board: { layers: Array<Record<string, unknown>> } } } }
    const copiedLayer = copiedDocument.work.document.board.layers[0]
    expect(copiedLayer).toMatchObject({ sourceAssetId: null, thumbnailAssetId: null, regenerationCapability: 'unavailable' })
    expect(JSON.stringify(copiedDocument)).not.toContain(source.originalId)
    expect(JSON.stringify(copiedDocument)).not.toContain(source.thumbnailId)

    const disableCopy = await updateCommunity(jsonWrite(`${origin}/api/v1/community/${postId}`, { allowCopy: false }, author.cookie, 'PATCH'), { params: Promise.resolve({ id: postId }) })
    if (disableCopy.status !== 200) throw new Error(`关闭复制失败 ${disableCopy.status}: ${JSON.stringify(await disableCopy.json())}`)
    const denied = await copyCommunity(jsonWrite(`${origin}/api/v1/community/${postId}/copy`, {}, copier.cookie), { params: Promise.resolve({ id: postId }) })
    expect(denied.status).toBe(403)
    await expect(denied.json()).resolves.toMatchObject({ error: { code: 'COMMUNITY_COPY_DISABLED' } })

    const anonymousList = await listCommunity(new Request(`${origin}/api/v1/community?q=M2`))
    expect(anonymousList.status).toBe(200)
  })
})
