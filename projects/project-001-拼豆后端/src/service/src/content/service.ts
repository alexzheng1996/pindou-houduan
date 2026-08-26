// 文件开头说明：M2.1-A 的内容服务只处理 Staff/Admin 草稿。公开读取、审核、
// 发布、SEO/sitemap、媒体上传与 MCP 服务身份均不在本模块范围内。
import { randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'

import { BusinessApiError, stableStringify } from '@/api/business-http'
import type { ContentSessionContext } from '@/auth/require-content-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'

type ArticleSection = 'guides' | 'blog'
type ArticleType = 'tool_guide' | 'faq' | 'creative' | 'product_tutorial' | 'case_study' | 'announcement'
type AuthorType = 'staff' | 'codex_assisted'
type FactCheckStatus = 'not_started' | 'needs_review' | 'checked'
type TwitterCard = 'summary' | 'summary_large_image'

type RichText = {
  root: {
    children: Array<Record<string, unknown> & { type: unknown; version: number }>
    direction: 'ltr' | 'rtl' | null
    format: '' | 'left' | 'start' | 'center' | 'right' | 'end' | 'justify'
    indent: number
    type: string
    version: number
  }
  [key: string]: unknown
}
type Source = { label: string; url: string }
type DraftInput = {
  articleType: ArticleType
  authorDisplayName: string
  authorType: AuthorType
  body: RichText
  contentQuality: { editorNotes: string | null; factCheckStatus: FactCheckStatus; topicIntent: string | null }
  excerpt: string
  section: ArticleSection
  seoSuggestions: { metaDescription: string | null; primaryTopic: string | null; seoTitle: string | null; twitterCard: TwitterCard }
  slug: string
  sourceList: Source[]
  title: string
}

type Database = { execute: (query: unknown) => Promise<{ rows: Array<Record<string, unknown>> }> }

const articleIdPattern = /^article_[a-f0-9]{32}$/
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const articleTypesBySection: Record<ArticleSection, ReadonlySet<ArticleType>> = {
  guides: new Set(['tool_guide', 'faq']),
  blog: new Set(['creative', 'product_tutorial', 'case_study', 'announcement']),
}
const authorTypes = new Set<AuthorType>(['staff', 'codex_assisted'])
const factCheckStatuses = new Set<FactCheckStatus>(['not_started', 'needs_review', 'checked'])
const twitterCards = new Set<TwitterCard>(['summary', 'summary_large_image'])

const toPublicId = (): string => `article_${randomUUID().replaceAll('-', '')}`

const asRecord = (value: unknown, code = 'CONTENT_INPUT_INVALID'): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BusinessApiError(code, '文章草稿格式无效。', 422)
  }
  return value as Record<string, unknown>
}

const optionalText = (value: unknown, maximum: number, label: string): string | null => {
  if (value === null || value === undefined || value === '') return null
  return requiredText(value, 1, maximum, label)
}

const requiredText = (value: unknown, minimum: number, maximum: number, label: string): string => {
  if (typeof value !== 'string') throw new BusinessApiError('CONTENT_INPUT_INVALID', `${label}格式无效。`, 422)
  const text = value.trim()
  const length = Array.from(text).length
  if (length < minimum || length > maximum) throw new BusinessApiError('CONTENT_INPUT_INVALID', `${label}长度无效。`, 422)
  return text
}

const parseSection = (value: unknown): ArticleSection => {
  if (value === 'guides' || value === 'blog') return value
  throw new BusinessApiError('CONTENT_INPUT_INVALID', '文章入口必须是 guides 或 blog。', 422)
}

const parseArticleType = (value: unknown, section: ArticleSection): ArticleType => {
  if (typeof value !== 'string' || !articleTypesBySection[section].has(value as ArticleType)) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '文章类型与入口不匹配。', 422)
  }
  return value as ArticleType
}

const parseSlug = (value: unknown): string => {
  const slug = requiredText(value, 3, 120, 'Slug')
  if (!slugPattern.test(slug)) throw new BusinessApiError('CONTENT_INPUT_INVALID', 'Slug 必须是小写英文、数字和连字符。', 422)
  return slug
}

const parseRichText = (value: unknown): RichText => {
  const body = asRecord(value)
  const root = asRecord(body.root)
  if (
    !Array.isArray(root.children)
    || root.children.some((child) => !child || typeof child !== 'object' || Array.isArray(child)
      || typeof (child as { type?: unknown }).type !== 'string'
      || !Number.isSafeInteger((child as { version?: unknown }).version))
    || (root.direction !== 'ltr' && root.direction !== 'rtl' && root.direction !== null)
    || !['', 'left', 'start', 'center', 'right', 'end', 'justify'].includes(root.format as string)
    || !Number.isSafeInteger(root.indent)
    || typeof root.type !== 'string'
    || !Number.isSafeInteger(root.version)
  ) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '正文必须是有效的富文本草稿。', 422)
  }
  const serialized = JSON.stringify(body)
  if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '正文草稿超过当前容量限制。', 422)
  }
  return body as RichText
}

const parseSources = (value: unknown): Source[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '来源清单必须包含 1–20 项。', 422)
  }
  return value.map((item) => {
    const source = asRecord(item)
    const label = requiredText(source.label, 1, 160, '来源名称')
    const url = requiredText(source.url, 1, 2_000, '来源链接')
    try {
      if (new URL(url).protocol !== 'https:') throw new Error('protocol')
    } catch {
      throw new BusinessApiError('CONTENT_INPUT_INVALID', '来源链接必须是 HTTPS URL。', 422)
    }
    return { label, url }
  })
}

const parseContentQuality = (value: unknown): DraftInput['contentQuality'] => {
  const quality = asRecord(value ?? {})
  const factCheckStatus = quality.factCheckStatus === undefined ? 'not_started' : quality.factCheckStatus
  if (typeof factCheckStatus !== 'string' || !factCheckStatuses.has(factCheckStatus as FactCheckStatus)) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '事实核查状态无效。', 422)
  }
  return {
    editorNotes: optionalText(quality.editorNotes, 2_000, '编辑备注'),
    factCheckStatus: factCheckStatus as FactCheckStatus,
    topicIntent: optionalText(quality.topicIntent, 240, '选题意图'),
  }
}

const parseSeoSuggestions = (value: unknown): DraftInput['seoSuggestions'] => {
  const seo = asRecord(value ?? {})
  const twitterCard = seo.twitterCard === undefined ? 'summary_large_image' : seo.twitterCard
  if (typeof twitterCard !== 'string' || !twitterCards.has(twitterCard as TwitterCard)) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', 'Twitter 卡片类型无效。', 422)
  }
  return {
    metaDescription: optionalText(seo.metaDescription, 320, 'SEO 描述'),
    primaryTopic: optionalText(seo.primaryTopic, 160, '主话题'),
    seoTitle: optionalText(seo.seoTitle, 160, 'SEO 标题'),
    twitterCard: twitterCard as TwitterCard,
  }
}

const parseAuthorType = (value: unknown): AuthorType => {
  const authorType = value === undefined ? 'staff' : value
  if (typeof authorType !== 'string' || !authorTypes.has(authorType as AuthorType)) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', '作者类型无效。', 422)
  }
  return authorType as AuthorType
}

const rejectNonDraftLifecycleInput = (body: Record<string, unknown>): void => {
  // A draft creator may omit status or state it as draft. Any attempt to set a
  // later lifecycle field must fail explicitly instead of being silently
  // coerced to draft, so callers cannot mistake a rejected publish for success.
  if (
    (body.status !== undefined && body.status !== 'draft')
    || body.publishedAt !== undefined
    || body.scheduledAt !== undefined
  ) {
    throw new BusinessApiError(
      'CONTENT_STATE_INVALID',
      'M2.1-A 仅允许保存 draft，发布和排期将在后续阶段启用。',
      409,
    )
  }
}

const parseDraftInput = (value: unknown): DraftInput => {
  const body = asRecord(value)
  rejectNonDraftLifecycleInput(body)
  const section = parseSection(body.section)
  return {
    articleType: parseArticleType(body.articleType, section),
    authorDisplayName: requiredText(body.authorDisplayName, 1, 120, '作者显示名'),
    authorType: parseAuthorType(body.authorType),
    body: parseRichText(body.body),
    contentQuality: parseContentQuality(body.contentQuality),
    excerpt: requiredText(body.excerpt, 20, 320, '摘要'),
    section,
    seoSuggestions: parseSeoSuggestions(body.seoSuggestions),
    slug: parseSlug(body.slug),
    sourceList: parseSources(body.sourceList),
    title: requiredText(body.title, 3, 160, '标题'),
  }
}

const getDatabase = async (context: ContentSessionContext): Promise<Database> => {
  const transactionId = await context.req.transactionID
  const db = transactionId ? context.payload.db.sessions?.[transactionId]?.db : context.payload.db.drizzle
  if (!db) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return db as Database
}

const isUniqueConstraintError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const value = error as { cause?: { code?: unknown }; code?: unknown }
  return value.code === '23505' || value.cause?.code === '23505'
}

const mapDraft = (article: Record<string, unknown>) => ({
  article: {
    articleId: article.publicId,
    articleType: article.articleType,
    authorDisplayName: article.authorDisplayName,
    authorType: article.authorType,
    body: article.body,
    contentQuality: article.contentQuality,
    createdAt: article.createdAt,
    excerpt: article.excerpt,
    section: article.section,
    seoSuggestions: article.seoSuggestions,
    slug: article.slug,
    sourceList: article.sourceList,
    status: article.status,
    title: article.title,
    updatedAt: article.updatedAt,
    version: article.version,
  },
})

const writeDraft = (input: DraftInput) => ({
  articleType: input.articleType,
  authorDisplayName: input.authorDisplayName,
  authorType: input.authorType,
  body: input.body,
  contentQuality: input.contentQuality,
  excerpt: input.excerpt,
  section: input.section,
  seoSuggestions: input.seoSuggestions,
  slug: input.slug,
  sourceList: input.sourceList,
  status: 'draft' as const,
  title: input.title,
  // The collection hook is authoritative and increments it for every write;
  // this value only satisfies Payload's required create shape.
  version: 1,
})

export const listDraftArticles = async (context: ContentSessionContext): Promise<Record<string, unknown>> => {
  const result = await context.payload.find({
    collection: 'articles',
    depth: 0,
    limit: 100,
    overrideAccess: false,
    req: context.req,
    sort: '-updatedAt',
  })
  return { articles: result.docs.map((article) => mapDraft(article as unknown as Record<string, unknown>).article) }
}

export const createDraftArticle = async (
  context: ContentSessionContext,
  bodyValue: unknown,
  keySha256: string,
): Promise<Record<string, unknown>> => {
  const input = parseDraftInput(bodyValue)
  return withIdempotentWrite(context, {
    keySha256,
    parseStoredResponse: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null,
    requestSha256: stableStringify(input),
    responseStatus: 201,
    route: 'POST /api/v1/admin/content/articles',
    execute: async () => {
      try {
        const article = await context.payload.create({
          collection: 'articles',
          data: { ...writeDraft(input), publicId: toPublicId() },
          depth: 0,
          draft: false,
          overrideAccess: false,
          req: context.req,
        })
        const response = mapDraft(article as unknown as Record<string, unknown>)
        await recordAuthenticatedAuditEvent(context, {
          action: 'content.draft_created',
          outcome: 'allowed',
          resourcePublicId: response.article.articleId as string,
          resourceType: 'content',
          route: 'POST /api/v1/admin/content/articles',
        })
        return response
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new BusinessApiError('CONTENT_SLUG_CONFLICT', '该 Slug 已被另一篇文章使用。', 409)
        }
        throw error
      }
    },
  })
}

const parseExpectedVersion = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BusinessApiError('CONTENT_INPUT_INVALID', 'expectedVersion 必须是当前草稿版本。', 422)
  }
  return value
}

export const updateDraftArticle = async (
  context: ContentSessionContext,
  articleId: string,
  bodyValue: unknown,
  keySha256: string,
): Promise<Record<string, unknown>> => {
  if (!articleIdPattern.test(articleId)) throw new BusinessApiError('CONTENT_NOT_FOUND', '文章草稿不存在。', 404)
  const body = asRecord(bodyValue)
  const expectedVersion = parseExpectedVersion(body.expectedVersion)
  const input = parseDraftInput(body)
  return withIdempotentWrite(context, {
    keySha256,
    parseStoredResponse: (value) => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null,
    requestSha256: stableStringify({ ...input, expectedVersion }),
    responseStatus: 200,
    route: `PATCH /api/v1/admin/content/articles/${articleId}`,
    execute: async () => {
      const db = await getDatabase(context)
      const versionResult = await db.execute(sql`SELECT id, version FROM articles
        WHERE public_id = ${articleId} AND status = 'draft' FOR UPDATE`)
      const row = versionResult.rows[0]
      if (!row || typeof row.id !== 'number') throw new BusinessApiError('CONTENT_NOT_FOUND', '文章草稿不存在。', 404)
      const currentVersion = typeof row.version === 'number' ? row.version : Number(row.version)
      if (!Number.isSafeInteger(currentVersion) || currentVersion !== expectedVersion) {
        throw new BusinessApiError('CONTENT_VERSION_CONFLICT', '草稿已被更新，请重新读取后再保存。', 409)
      }
      try {
        const article = await context.payload.update({
          collection: 'articles',
          data: writeDraft(input),
          depth: 0,
          draft: false,
          id: row.id,
          overrideAccess: false,
          req: context.req,
        })
        const response = mapDraft(article as unknown as Record<string, unknown>)
        await recordAuthenticatedAuditEvent(context, {
          action: 'content.draft_updated',
          outcome: 'allowed',
          resourcePublicId: articleId,
          resourceType: 'content',
          route: `PATCH /api/v1/admin/content/articles/${articleId}`,
        })
        return response
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new BusinessApiError('CONTENT_SLUG_CONFLICT', '该 Slug 已被另一篇文章使用。', 409)
        }
        throw error
      }
    },
  })
}

export const getDraftArticle = async (
  context: ContentSessionContext,
  articleId: string,
): Promise<Record<string, unknown>> => {
  if (!articleIdPattern.test(articleId)) throw new BusinessApiError('CONTENT_NOT_FOUND', '文章草稿不存在。', 404)
  const result = await context.payload.find({
    collection: 'articles',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: context.req,
    where: { publicId: { equals: articleId } },
  })
  const article = result.docs[0]
  if (!article) throw new BusinessApiError('CONTENT_NOT_FOUND', '文章草稿不存在。', 404)
  return mapDraft(article as unknown as Record<string, unknown>)
}

// Keeps the service context structurally compatible with the established
// idempotency implementation while keeping the content-service marker private.
export type ContentWriteContext = ContentSessionContext & { req: PayloadRequest }
