// 文件开头说明：M2.2 社区治理后台回归。验证最小权限、全状态审查、精选/下架
// 派生规则、举报并发版本保护，以及隐藏社交资料只向后台完整暴露。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import sharp from 'sharp'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { GET as publicCreator } from '@/app/api/v1/community/creators/[id]/route'
import { GET as publicPost } from '@/app/api/v1/community/[id]/route'
import { POST as publishCommunity } from '@/app/api/v1/community/route'
import { GET as publicMedia } from '@/app/api/v1/community/media/[id]/route'
import { POST as uploadMedia } from '@/app/api/v1/community/media/upload/route'
import { GET as ownProfile, PATCH as patchOwnProfile } from '@/app/api/v1/community/profile/route'
import { PUT as putSocialLink } from '@/app/api/v1/community/profile/social-links/[platform]/route'
import { GET as adminPost } from '@/app/api/v1/admin/community/posts/[id]/route'
import { POST as featurePost } from '@/app/api/v1/admin/community/posts/[id]/feature/route'
import { POST as restorePost } from '@/app/api/v1/admin/community/posts/[id]/restore/route'
import { POST as takedownPost } from '@/app/api/v1/admin/community/posts/[id]/takedown/route'
import { GET as listAdminPosts } from '@/app/api/v1/admin/community/posts/route'
import { GET as adminCreator } from '@/app/api/v1/admin/community/users/[id]/route'
import { POST as createNote } from '@/app/api/v1/admin/community/users/[id]/notes/route'
import { PATCH as watchCreator } from '@/app/api/v1/admin/community/users/[id]/watchlist/route'
import { POST as resolveReport } from '@/app/api/v1/admin/community/reports/[id]/resolve/route'
import { POST as reportPost } from '@/app/api/v1/community/[id]/report/route'
import { POST as createWork } from '@/app/api/v1/works/route'
import { PATCH as patchWork } from '@/app/api/v1/works/[id]/document/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import config from '@/payload.config'

const origin = 'http://127.0.0.1:3002'
let payload: Payload
type TestUser = { cookie: string; userId: number }

const authRequest = (path: string, body: Record<string, string>) => new Request(`${origin}/api/v1/auth${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
})
const jsonWrite = (url: string, body: unknown, cookie: string, method = 'POST', key = `m22-${randomUUID()}`) => new Request(url, {
  method, headers: { 'content-type': 'application/json', cookie, origin, 'idempotency-key': key }, body: JSON.stringify(body),
})
const getRequest = (url: string, cookie: string) => new Request(url, { headers: { cookie, origin } })

const signInUser = async (name: string): Promise<TestUser> => {
  const email = `m22-${randomUUID()}@example.com`
  const password = 'M22-community-governance-local-test-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name, email, password }))).status).toBe(200)
  const message = getLocalMailOutbox()[0]
  if (message?.kind !== 'email-verification-otp') throw new Error('M2.2 测试未取得验证 OTP。')
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: message.otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('M2.2 测试未取得登录 Cookie。')
  const users = await payload.find({ collection: 'users', depth: 0, limit: 1, overrideAccess: true, where: { email: { equals: email } } })
  const userId = users.docs[0]?.id
  if (!userId) throw new Error('M2.2 测试未取得用户。')
  return { cookie, userId }
}
const setRole = async (userId: number, role: 'user' | 'staff' | 'admin') => {
  const pool = (payload.db as unknown as { pool: { query: (query: string, parameters: unknown[]) => Promise<unknown> } }).pool
  await pool.query('DELETE FROM users_role WHERE parent_id = $1', [userId])
  await pool.query('INSERT INTO users_role ("order", parent_id, value) VALUES (0, $1, $2)', [userId, role])
}
const patternDocument = (title: string, revision: number) => ({
  schemaVersion: 1, kind: 'pattern', title, documentRevision: revision, settings: {},
  pattern: { beadSizeMm: 2.6, gridDimensions: { columns: 1, rows: 1 }, mappedPixelData: [[{ key: '#123456', color: '#123456', isExternal: false }]], colorCounts: { '#123456': { count: 1, color: '#123456' } }, totalBeadCount: 1 },
  board: null, materialList: revision === 0 ? { status: 'not_generated', items: [] } : { status: 'generated', generatedFromRevision: revision + 1, items: [{ colorKey: '#123456', color: '#123456', count: 1 }] },
})
const createPublishedPost = async (author: TestUser): Promise<{ postId: string; mediaId: string }> => {
  const title = `M2.2 post ${randomUUID()}`
  const draft = await createWork(jsonWrite(`${origin}/api/v1/works`, { title, kind: 'pattern', document: patternDocument(title, 0) }, author.cookie))
  expect(draft.status).toBe(201)
  const workId = ((await draft.json()) as { work: { workId: string } }).work.workId
  expect((await patchWork(jsonWrite(`${origin}/api/v1/works/${workId}/document`, { expectedRevision: 0, document: patternDocument(title, 0) }, author.cookie, 'PATCH'), { params: Promise.resolve({ id: workId }) })).status).toBe(200)
  const bytes = await sharp({ create: { background: '#123456', channels: 3, width: 2, height: 2 } }).png().toBuffer()
  const media = await uploadMedia(new Request(`${origin}/api/v1/community/media/upload`, { method: 'POST', headers: { 'content-type': 'image/png', origin, cookie: author.cookie, 'idempotency-key': `media-${randomUUID()}`, 'x-community-media-role': 'cover' }, body: bytes }))
  expect(media.status).toBe(201)
  const mediaId = ((await media.json()) as { media: { mediaId: string } }).media.mediaId
  const post = await publishCommunity(jsonWrite(`${origin}/api/v1/community`, { workId, title, category: '测试', tags: ['m22'], coverMediaId: mediaId, copyrightConfirmed: true }, author.cookie))
  expect(post.status).toBe(201)
  return { postId: ((await post.json()) as { post: { postId: string } }).post.postId, mediaId }
}

describe('M2.2 社区治理后台', () => {
  beforeAll(async () => { payload = await getPayload({ config: await config }) })
  beforeEach(async () => { await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} }) })
  afterAll(async () => { await payload?.destroy() })

  it('后台按社区域完整读取，精选/下架/恢复正确派生公开、分享和收录状态', async () => {
    const author = await signInUser('M2.2 Author')
    const staff = await signInUser('M2.2 Staff')
    const ordinary = await signInUser('M2.2 Ordinary')
    await setRole(staff.userId, 'staff')
    const { postId, mediaId } = await createPublishedPost(author)
    const forbidden = await listAdminPosts(getRequest(`${origin}/api/v1/admin/community/posts`, ordinary.cookie))
    expect(forbidden.status).toBe(403)
    const queue = await listAdminPosts(getRequest(`${origin}/api/v1/admin/community/posts`, staff.cookie))
    expect(queue.status).toBe(200)
    const item = ((await queue.json()) as { posts: Array<{ postId: string; moderationVersion: number }> }).posts.find((post) => post.postId === postId)
    if (!item) throw new Error('M2.2 后台队列缺少新帖子。')
    const featured = await featurePost(jsonWrite(`${origin}/api/v1/admin/community/posts/${postId}/feature`, { featured: true, reason: '完整案例', expectedVersion: item.moderationVersion }, staff.cookie), { params: Promise.resolve({ id: postId }) })
    expect(featured.status).toBe(200)
    const featuredBody = await featured.json() as { indexable: boolean; moderationVersion: number }
    expect(featuredBody.indexable).toBe(true)
    const retry = await featurePost(jsonWrite(`${origin}/api/v1/admin/community/posts/${postId}/feature`, { featured: true, reason: '完整案例', expectedVersion: item.moderationVersion }, staff.cookie, 'POST', 'same-m22-feature'), { params: Promise.resolve({ id: postId }) })
    expect(retry.status).toBe(409)
    const detailed = await adminPost(getRequest(`${origin}/api/v1/admin/community/posts/${postId}`, staff.cookie), { params: Promise.resolve({ id: postId }) })
    expect(detailed.status).toBe(200)
    const detailedJson = await detailed.json() as { post: { frozenVersion: { document: unknown }; media: Array<{ previewUrl?: string }>; authorProfile: { creatorId: string } } }
    expect(JSON.stringify(detailedJson)).not.toMatch(/storageKey|email|workAssets/i)
    expect(detailedJson.post.frozenVersion.document).toBeTruthy()
    expect(detailedJson.post.media[0]?.previewUrl).toBe(`/api/v1/admin/community/media/${mediaId}`)
    const takedown = await takedownPost(jsonWrite(`${origin}/api/v1/admin/community/posts/${postId}/takedown`, { reasonCode: 'privacy', reason: '待核验', notifyAuthor: true, expectedVersion: featuredBody.moderationVersion }, staff.cookie), { params: Promise.resolve({ id: postId }) })
    expect(takedown.status).toBe(200)
    const takedownBody = await takedown.json() as { moderationVersion: number; shareable: boolean; indexable: boolean }
    expect(takedownBody.shareable).toBe(false)
    expect(takedownBody.indexable).toBe(false)
    expect((await publicPost(new Request(`${origin}/api/v1/community/${postId}`), { params: Promise.resolve({ id: postId }) })).status).toBe(404)
    expect((await publicMedia(new Request(`${origin}/api/v1/community/media/${mediaId}`), { params: Promise.resolve({ id: mediaId }) })).status).toBe(404)
    const allStates = await listAdminPosts(getRequest(`${origin}/api/v1/admin/community/posts?status=takedown`, staff.cookie))
    expect(JSON.stringify(await allStates.json())).toContain(postId)
    const restored = await restorePost(jsonWrite(`${origin}/api/v1/admin/community/posts/${postId}/restore`, { reason: '证据已澄清', expectedVersion: takedownBody.moderationVersion }, staff.cookie), { params: Promise.resolve({ id: postId }) })
    expect(restored.status).toBe(200)
    await expect(restored.json()).resolves.toMatchObject({ shareable: true, indexable: false, isFeatured: false })
  })

  it('用户隐藏社交链接只在后台显示真实值，备注和特别关注不会进入公开投影', async () => {
    const author = await signInUser('M2.2 Profile Author')
    const staff = await signInUser('M2.2 Profile Staff')
    await setRole(staff.userId, 'staff')
    await createPublishedPost(author)
    const profileUpdate = await patchOwnProfile(jsonWrite(`${origin}/api/v1/community/profile`, { displayName: '创作者 A', bio: '只用于社区资料。' }, author.cookie, 'PATCH'))
    expect(profileUpdate.status).toBe(200)
    const socialUpdate = await putSocialLink(
      jsonWrite(`${origin}/api/v1/community/profile/social-links/instagram`, { url: 'https://www.instagram.com/pixomosaic.creator/', visibility: 'hidden' }, author.cookie, 'PUT'),
      { params: Promise.resolve({ platform: 'instagram' }) },
    )
    expect(socialUpdate.status).toBe(200)
    const own = await ownProfile(getRequest(`${origin}/api/v1/community/profile`, author.cookie))
    const ownBody = await own.json() as { profile: { creatorId: string } }
    const creator = await adminCreator(getRequest(`${origin}/api/v1/admin/community/users/${ownBody.profile.creatorId}`, staff.cookie), { params: Promise.resolve({ id: ownBody.profile.creatorId }) })
    expect(creator.status).toBe(200)
    const creatorBody = await creator.json() as { creator: { socialLinks: Array<{ url: string; visibility: string; visibilityLabel: string }>; operations: { version: number } } }
    expect(creatorBody.creator.socialLinks).toContainEqual(expect.objectContaining({ url: 'https://www.instagram.com/pixomosaic.creator/', visibility: 'hidden', visibilityLabel: '隐藏' }))
    const publicProfile = await publicCreator(new Request(`${origin}/api/v1/community/creators/${ownBody.profile.creatorId}`), { params: Promise.resolve({ id: ownBody.profile.creatorId }) })
    expect(JSON.stringify(await publicProfile.json())).not.toContain('instagram.com')
    expect((await createNote(jsonWrite(`${origin}/api/v1/admin/community/users/${ownBody.profile.creatorId}/notes`, { body: '复查该用户公开授权', tags: ['版权'] }, staff.cookie), { params: Promise.resolve({ id: ownBody.profile.creatorId }) })).status).toBe(201)
    expect((await watchCreator(jsonWrite(`${origin}/api/v1/admin/community/users/${ownBody.profile.creatorId}/watchlist`, { status: 'watching', reason: '待复查', reviewAt: new Date(Date.now() + 86_400_000).toISOString(), expectedVersion: creatorBody.creator.operations.version }, staff.cookie, 'PATCH'), { params: Promise.resolve({ id: ownBody.profile.creatorId }) })).status).toBe(200)
    const refreshedOwn = await ownProfile(getRequest(`${origin}/api/v1/community/profile`, author.cookie))
    expect(JSON.stringify(await refreshedOwn.json())).not.toMatch(/待复查|复查该用户公开授权|watchlist/i)
  })

  it('待处理版权举报阻止精选，举报处理使用版本保护', async () => {
    const author = await signInUser('M2.2 Report Author')
    const reporter = await signInUser('M2.2 Reporter')
    const staff = await signInUser('M2.2 Report Staff')
    await setRole(staff.userId, 'staff')
    const { postId } = await createPublishedPost(author)
    const report = await reportPost(jsonWrite(`${origin}/api/v1/community/${postId}/report`, { reason: 'copyright', details: '测试版权说明' }, reporter.cookie), { params: Promise.resolve({ id: postId }) })
    expect(report.status).toBe(201)
    const reportId = ((await report.json()) as { reportId: string }).reportId
    const queue = await listAdminPosts(getRequest(`${origin}/api/v1/admin/community/posts`, staff.cookie))
    const post = ((await queue.json()) as { posts: Array<{ postId: string; moderationVersion: number }> }).posts.find((item) => item.postId === postId)
    if (!post) throw new Error('M2.2 举报测试未找到帖子。')
    const blocked = await featurePost(jsonWrite(`${origin}/api/v1/admin/community/posts/${postId}/feature`, { featured: true, reason: '不应通过', expectedVersion: post.moderationVersion }, staff.cookie), { params: Promise.resolve({ id: postId }) })
    expect(blocked.status).toBe(409)
    const resolved = await resolveReport(jsonWrite(`${origin}/api/v1/admin/community/reports/${reportId}/resolve`, { decision: 'rejected', reasonCode: 'insufficient_evidence', internalNote: '未发现侵权证据', notifyAuthor: false, notifyReporter: false, expectedVersion: 1 }, staff.cookie), { params: Promise.resolve({ id: reportId }) })
    expect(resolved.status).toBe(200)
    const stale = await resolveReport(jsonWrite(`${origin}/api/v1/admin/community/reports/${reportId}/resolve`, { decision: 'rejected', reasonCode: 'insufficient_evidence', expectedVersion: 1 }, staff.cookie), { params: Promise.resolve({ id: reportId }) })
    expect(stale.status).toBe(409)
  })
})
