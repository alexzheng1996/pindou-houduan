// 文件开头说明：M2.1-A 内容草稿回归测试。覆盖 Staff/Admin 草稿写入、普通用户
// 拒绝、幂等与版本冲突，以及 Staff 进入受控后台后仍无法浏览认证/私密作品数据。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'

import type { Article } from '@/payload-types'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { GET as getContentArticle, PATCH as patchContentArticle } from '@/app/api/v1/admin/content/articles/[id]/route'
import { GET as listContentArticles, POST as createContentArticle } from '@/app/api/v1/admin/content/articles/route'
import { GET as getWork } from '@/app/api/v1/works/[id]/route'
import { POST as createWork } from '@/app/api/v1/works/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import config from '@/payload.config'

const origin = 'http://127.0.0.1:3002'
let payload: Payload

type TestUser = { cookie: string; userId: number }

const authRequest = (path: string, body: Record<string, string>) => new Request(`${origin}/api/v1/auth${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin },
  body: JSON.stringify(body),
})

const jsonWrite = (url: string, body: unknown, cookie: string, method = 'POST', key = `m21-${randomUUID()}`) => new Request(url, {
  method,
  headers: { 'content-type': 'application/json', cookie, origin, 'idempotency-key': key },
  body: JSON.stringify(body),
})

const signInUser = async (name: string): Promise<TestUser> => {
  const email = `m21-${randomUUID()}@example.com`
  const password = 'M21-content-drafts-local-test-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name, email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') throw new Error('M2.1 测试未取得邮箱验证 OTP。')
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('M2.1 测试未取得登录 Cookie。')
  const users = await payload.find({ collection: 'users', depth: 0, limit: 1, overrideAccess: true, where: { email: { equals: email } } })
  const userId = users.docs[0]?.id
  if (!userId) throw new Error('M2.1 测试未取得用户记录。')
  return { cookie, userId }
}

const setRole = async (userId: number, role: 'user' | 'staff' | 'admin'): Promise<void> => {
  const pool = (payload.db as unknown as { pool: { query: (query: string, values: unknown[]) => Promise<unknown> } }).pool
  await pool.query('DELETE FROM users_role WHERE parent_id = $1', [userId])
  await pool.query('INSERT INTO users_role ("order", parent_id, value) VALUES (0, $1, $2)', [userId, role])
}

const lexicalBody = (text: string) => ({
  root: {
    type: 'root',
    version: 1,
    direction: null,
    format: '' as const,
    indent: 0,
    children: [{ type: 'paragraph', version: 1, direction: null, format: '' as const, indent: 0, children: [{ type: 'text', version: 1, text, detail: 0, format: 0, mode: 'normal', style: '' }] }],
  },
})

const draftInput = (suffix: string, section: 'guides' | 'blog' = 'guides'): Omit<Article, 'id' | 'publicId' | 'status' | 'version' | 'updatedAt' | 'createdAt'> => ({
  section,
  slug: `${section}-draft-${suffix}`,
  title: `How to make a PixoMosaic ${suffix}`,
  excerpt: 'This English draft contains a useful description that is long enough for the required editorial summary.',
  body: lexicalBody(`Draft body ${suffix}`),
  articleType: section === 'guides' ? 'tool_guide' : 'creative',
  authorType: 'staff',
  authorDisplayName: 'PixoMosaic Editorial Team',
  sourceList: [{ label: 'PixoMosaic draft source', url: 'https://pixomosaic.com/' }],
  contentQuality: { factCheckStatus: 'needs_review', topicIntent: 'Help users make their first mosaic.', editorNotes: 'Internal note only.' },
  seoSuggestions: { seoTitle: `PixoMosaic ${suffix}`, metaDescription: 'A suggested description for a future published article.', primaryTopic: 'bead mosaic guide', twitterCard: 'summary_large_image' },
})

const patternDocument = (title: string) => ({
  schemaVersion: 1,
  kind: 'pattern',
  title,
  documentRevision: 0,
  settings: {},
  pattern: {
    beadSizeMm: 2.6,
    gridDimensions: { columns: 1, rows: 1 },
    mappedPixelData: [[{ key: '#123456', color: '#123456', isExternal: false }]],
    colorCounts: { '#123456': { count: 1, color: '#123456' } },
    totalBeadCount: 1,
  },
  board: null,
  materialList: { status: 'not_generated', items: [] },
})

describe('M2.1-A 官方内容草稿后台', () => {
  beforeAll(async () => { payload = await getPayload({ config: await config }) })
  beforeEach(async () => { await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} }) })
  afterAll(async () => { await payload?.destroy() })

  it('Staff/Admin 可创建、读取和更新草稿；普通用户被拒绝且任何发布请求失败', async () => {
    const staff = await signInUser('M2.1 Staff')
    const admin = await signInUser('M2.1 Admin')
    const ordinary = await signInUser('M2.1 Ordinary')
    await setRole(staff.userId, 'staff')
    await setRole(admin.userId, 'admin')
    const input = draftInput(randomUUID().replaceAll('-', ''))
    const ordinaryCreate = await createContentArticle(jsonWrite(`${origin}/api/v1/admin/content/articles`, input, ordinary.cookie))
    expect(ordinaryCreate.status).toBe(403)

    // The collection hook supplies publicId/status/version for the real
    // Payload Admin form; its generic programmatic type cannot express a
    // required field populated in beforeChange, so keep this test input
    // narrowly cast at the framework boundary.
    const directAdminDraft = await payload.create({
      collection: 'articles',
      data: draftInput(`payload-admin-${randomUUID().replaceAll('-', '')}`, 'blog') as never,
      draft: false,
      depth: 0,
      overrideAccess: false,
      user: { id: staff.userId, role: ['staff'], collection: 'users' },
    })
    expect(directAdminDraft.publicId).toMatch(/^article_[a-f0-9]{32}$/)
    expect(directAdminDraft.status).toBe('draft')
    expect(directAdminDraft.version).toBe(1)

    const publishAttempt = await createContentArticle(jsonWrite(
      `${origin}/api/v1/admin/content/articles`,
      { ...input, status: 'published', publishedAt: new Date().toISOString() },
      staff.cookie,
    ))
    expect(publishAttempt.status).toBe(409)
    await expect(publishAttempt.json()).resolves.toMatchObject({ error: { code: 'CONTENT_STATE_INVALID' } })

    const key = `m21-create-${randomUUID()}`
    const created = await createContentArticle(jsonWrite(`${origin}/api/v1/admin/content/articles`, input, staff.cookie, 'POST', key))
    if (created.status !== 201) throw new Error(`内容草稿创建失败 ${created.status}: ${JSON.stringify(await created.json())}`)
    const createdBody = await created.json() as { article: { articleId: string; status: string; version: number } }
    expect(createdBody.article.status).toBe('draft')
    expect(createdBody.article.version).toBe(1)

    const retry = await createContentArticle(jsonWrite(`${origin}/api/v1/admin/content/articles`, input, staff.cookie, 'POST', key))
    expect(retry.status).toBe(201)
    await expect(retry.json()).resolves.toMatchObject({ article: { articleId: createdBody.article.articleId, version: 1 } })

    const listing = await listContentArticles(new Request(`${origin}/api/v1/admin/content/articles`, { headers: { cookie: admin.cookie, origin } }))
    expect(listing.status).toBe(200)
    const listingBody = await listing.json() as { articles: Array<{ articleId: string }> }
    expect(listingBody.articles.some((article) => article.articleId === createdBody.article.articleId)).toBe(true)

    const fetched = await getContentArticle(new Request(`${origin}/api/v1/admin/content/articles/${createdBody.article.articleId}`, { headers: { cookie: staff.cookie, origin } }), { params: Promise.resolve({ id: createdBody.article.articleId }) })
    expect(fetched.status).toBe(200)
    const draft = await fetched.json() as { article: { version: number } }
    const updatePublishAttempt = await patchContentArticle(jsonWrite(
      `${origin}/api/v1/admin/content/articles/${createdBody.article.articleId}`,
      { ...input, expectedVersion: draft.article.version, status: 'published' },
      staff.cookie,
      'PATCH',
    ), { params: Promise.resolve({ id: createdBody.article.articleId }) })
    expect(updatePublishAttempt.status).toBe(409)
    await expect(updatePublishAttempt.json()).resolves.toMatchObject({ error: { code: 'CONTENT_STATE_INVALID' } })
    const updatedInput = { ...input, title: `Updated ${input.title}`, expectedVersion: draft.article.version }
    const updated = await patchContentArticle(jsonWrite(`${origin}/api/v1/admin/content/articles/${createdBody.article.articleId}`, updatedInput, staff.cookie, 'PATCH'), { params: Promise.resolve({ id: createdBody.article.articleId }) })
    expect(updated.status).toBe(200)
    await expect(updated.json()).resolves.toMatchObject({ article: { status: 'draft', version: 2, title: updatedInput.title } })

    const stale = await patchContentArticle(jsonWrite(`${origin}/api/v1/admin/content/articles/${createdBody.article.articleId}`, updatedInput, staff.cookie, 'PATCH'), { params: Promise.resolve({ id: createdBody.article.articleId }) })
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'CONTENT_VERSION_CONFLICT' } })
  })

  it('Staff 获得内容后台入口后，仍不能读取认证数据或他人私密作品', async () => {
    const staff = await signInUser('M2.1 Limited Staff')
    const owner = await signInUser('M2.1 Private Owner')
    await setRole(staff.userId, 'staff')
    const work = await createWork(jsonWrite(`${origin}/api/v1/works`, { title: 'Owner private work', kind: 'pattern', document: patternDocument('Owner private work') }, owner.cookie))
    expect(work.status).toBe(201)
    const workId = ((await work.json()) as { work: { workId: string } }).work.workId

    const staffUser = { id: staff.userId, role: ['staff'], collection: 'users' }
    for (const collection of ['users', 'sessions', 'accounts', 'verifications'] as const) {
      const staffRead = await payload.find({ collection, depth: 0, limit: 10, overrideAccess: false, user: staffUser })
        .catch(() => null)
      if (staffRead) {
        expect(staffRead.docs, `Staff must not read ${collection}.`).toHaveLength(0)
        expect(staffRead.totalDocs, `Staff must not read ${collection}.`).toBe(0)
      }
    }
    const staffWork = await getWork(new Request(`${origin}/api/v1/works/${workId}`, { headers: { cookie: staff.cookie, origin } }), { params: Promise.resolve({ id: workId }) })
    expect(staffWork.status).toBe(404)
  })
})
