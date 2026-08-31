// 文件开头说明：灵感库公开层只读独立的 CommunityPost/PublishedPatternVersion
// 快照。任何公开响应都不查询或返回 WorkAsset、storageKey、私有 document URL；
// 复制时从冻结快照创建新的 owner-only Work。
import { randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'

import { BusinessApiError, sha256, stableStringify } from '@/api/business-http'
import { inspectImageUpload, parseMimeType, type AssetMimeType } from '@/assets/validation'
import type { ActiveSessionContext } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { ensureCommunityCreatorForPost } from '@/community/admin-service'
import { withIdempotentWrite } from '@/works/idempotency'
import { getObjectStore } from '@/storage'
import { ObjectStoreNotFoundError, ObjectStoreUnavailableError } from '@/storage/object-store'

type DatabaseRow = Record<string, unknown>
type QueryResult = { rows: DatabaseRow[] }
type Database = { execute: (query: unknown) => Promise<QueryResult> }
type Pool = { query: (query: string, parameters?: readonly unknown[]) => Promise<QueryResult> }
type PostStatus = 'published' | 'withdrawn' | 'takedown' | 'deleted'
type CommunityListSort = 'recommended' | 'latest' | 'likes' | 'favorites'
type CommunityListCursor = {
  v: 1
  sort: CommunityListSort
  filter: string
  id: number
  publishedAt: number
  isFeatured?: boolean
  score?: number
}
type OwnerPostsCursor = { v: 1; scope: 'owner-posts'; ownerId: number; statuses: string; updatedAt: number; id: number }
type CreatorPostsCursor = { v: 1; scope: 'creator-posts'; creatorId: string; publishedAt: number; id: number }
type FavoritesCursor = { v: 1; scope: 'favorites'; ownerId: number; createdAt: number; id: number }

const postIdPattern = /^community_post_[a-f0-9]{32}$/
const mediaIdPattern = /^community_media_[a-f0-9]{32}$/
const workIdPattern = /^work_[a-f0-9]{32}$/
const reportReasons = new Set(['copyright', 'adult_violence', 'harassment', 'spam', 'privacy'])
const mediaMimeTypes = new Set<AssetMimeType>(['image/png', 'image/jpeg', 'image/webp'])

const toId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return value
}
const asNumber = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(n)) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return n
}
const getPool = (context: Pick<ActiveSessionContext, 'payload'>): Pool => {
  const pool = (context.payload.db as unknown as { pool?: Pool }).pool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return pool
}
const getDatabase = async (context: ActiveSessionContext): Promise<Database> => {
  const transactionId = await context.req.transactionID
  const db = transactionId ? context.payload.db.sessions?.[transactionId]?.db : context.payload.db.drizzle
  if (!db) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return db as Database
}
const parseBody = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '请求体无效。', 422)
  return value
}
const requiredText = (value: unknown, max: number, message: string): string => {
  if (typeof value !== 'string') throw new BusinessApiError('COMMUNITY_INPUT_INVALID', message, 422)
  const text = value.trim()
  if (!text || Array.from(text).length > max) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', message, 422)
  return text
}
const safeTags = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 20) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '标签数量无效。', 422)
  const tags = value.map((tag) => requiredText(tag, 20, '标签格式无效。'))
  return [...new Set(tags)]
}
const parsePostId = (value: string): void => {
  if (!postIdPattern.test(value)) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
}
const parseReportReason = (value: unknown): string => {
  if (typeof value !== 'string' || !reportReasons.has(value)) throw new BusinessApiError('COMMUNITY_REPORT_INVALID', '举报理由无效。', 422)
  return value
}

const parseCommunityListSort = (searchParams?: URLSearchParams): CommunityListSort => {
  const value = searchParams?.get('sort') ?? 'recommended'
  if (value === 'recommended' || value === 'latest' || value === 'likes' || value === 'favorites') return value
  // Keep the original M2 client values working while the frontend migrates to
  // the formal, user-facing "likes" sort name.
  if (value === 'hot' || value === 'popular') return 'likes'
  throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '排序参数无效。', 422)
}

const cursorFilter = (query: string, category: string, tag: string): string =>
  sha256(stableStringify({ query, category, tag }))

const parseListWindow = (
  searchParams: URLSearchParams | undefined,
  sort: CommunityListSort,
  filter: string,
): { limit: number; cursor: CommunityListCursor | null } => {
  const rawLimit = searchParams?.get('limit')
  const requestedLimit = rawLimit ? Number(rawLimit) : 24
  const limit = Number.isSafeInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 24
  const rawCursor = searchParams?.get('cursor')
  if (!rawCursor) return { limit, cursor: null }
  try {
    const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as Partial<CommunityListCursor>
    if (
      decoded.v !== 1
      || decoded.sort !== sort
      || decoded.filter !== filter
      || !Number.isSafeInteger(decoded.id)
      || (decoded.id as number) < 1
      || !Number.isSafeInteger(decoded.publishedAt)
      || (decoded.publishedAt as number) < 0
    ) throw new Error('invalid cursor')
    if (sort === 'recommended' && typeof decoded.isFeatured !== 'boolean') throw new Error('invalid cursor')
    if ((sort === 'likes' || sort === 'favorites') && (!Number.isSafeInteger(decoded.score) || (decoded.score as number) < 0)) throw new Error('invalid cursor')
    return {
      limit,
      cursor: {
        v: 1,
        sort,
        filter,
        id: decoded.id as number,
        publishedAt: decoded.publishedAt as number,
        ...(sort === 'recommended' ? { isFeatured: decoded.isFeatured } : {}),
        ...(sort === 'likes' || sort === 'favorites' ? { score: decoded.score } : {}),
      },
    }
  } catch {
    throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422)
  }
}

const publishedAtValue = (value: unknown): number => {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === 'string' ? new Date(value).getTime() : NaN
  if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp
  throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}

const encodeListCursor = (sort: CommunityListSort, filter: string, row: DatabaseRow): string => {
  const cursor: CommunityListCursor = {
    v: 1,
    sort,
    filter,
    id: asNumber(row.db_post_id),
    publishedAt: publishedAtValue(row.published_at),
    ...(sort === 'recommended' ? { isFeatured: Boolean(row.is_featured) } : {}),
    ...(sort === 'likes' ? { score: asNumber(row.like_count) } : {}),
    ...(sort === 'favorites' ? { score: asNumber(row.favorite_count) } : {}),
  }
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

const hasDatabaseCode = (error: unknown, code: string): boolean => {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (value.code === 'P0001' && typeof value.message === 'string' && value.message.includes(code)) return true
  if (value.cause && hasDatabaseCode(value.cause, code)) return true
  return Array.isArray(value.errors) && value.errors.some((item) => hasDatabaseCode(item, code))
}

export const uploadCommunityMedia = async (
  context: ActiveSessionContext,
  content: Buffer,
  role: 'cover' | 'gallery',
  declaredMimeType: string,
  altText: string | null,
  keySha256: string,
) => {
  const mimeType = parseMimeType(declaredMimeType)
  if (!mimeType || !mediaMimeTypes.has(mimeType as AssetMimeType)) throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体类型无效。', 422)
  if (role !== 'cover' && role !== 'gallery') throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体角色无效。', 422)
  const inspected = await inspectImageUpload(content, mimeType as AssetMimeType)
  return withIdempotentWrite(context, {
    route: 'POST /api/v1/community/media', keySha256,
    requestSha256: stableStringify({ role, mimeType, sha256: inspected.sha256, altText }),
    responseStatus: 201, parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const mediaId = toId('community_media')
      const storageKey = `community/${context.user.id}/${mediaId}`
      await getObjectStore().putIfAbsent(storageKey, content)
      try {
        const db = await getDatabase(context)
        await db.execute(sql`INSERT INTO community_post_media (public_id, post_id, uploader_id, role, sort_order, mime_type, size_bytes, sha256, storage_key, status, alt_text)
          VALUES (${mediaId}, NULL, ${context.user.id}, ${role}, 0, ${mimeType}, ${inspected.sizeBytes}, ${inspected.sha256}, ${storageKey}, 'ready', ${altText})`)
      } catch (error) {
        await getObjectStore().delete(storageKey).catch(() => undefined)
        throw error
      }
      return { media: { mediaId, role, mimeType, sizeBytes: inspected.sizeBytes, status: 'ready' as const } }
    },
  })
}

export const readCommunityMedia = async (payload: ActiveSessionContext['payload'], mediaId: string): Promise<{ content: Buffer; mimeType: string }> => {
  if (!mediaIdPattern.test(mediaId)) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在。', 404)
  const pool = (payload.db as unknown as { pool?: Pool }).pool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  const result = await pool.query(`SELECT m.storage_key, m.mime_type FROM community_post_media m JOIN community_posts p ON p.id = m.post_id WHERE m.public_id = $1 AND m.status = 'ready' AND p.status = 'published'`, [mediaId])
  const row = result.rows[0]
  if (!row || typeof row.storage_key !== 'string' || !row.storage_key.startsWith('community/')) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在。', 404)
  try {
    return { content: await getObjectStore().read(row.storage_key), mimeType: asString(row.mime_type) }
  } catch (error) {
    if (error instanceof ObjectStoreNotFoundError) {
      throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在。', 404)
    }
    if (error instanceof ObjectStoreUnavailableError) {
      throw new BusinessApiError('COMMUNITY_MEDIA_STORAGE_UNAVAILABLE', '社区媒体暂时不可用，请稍后重试。', 503)
    }
    throw error
  }
}

type PublishedStats = { gridColumns: number; gridRows: number; colorCount: number; totalBeadCount: number; difficulty: string; beadSizeMm: number | null }

const inspectDocument = (document: unknown, kind: string): PublishedStats => {
  const root = isRecord(document) ? document : {}
  const source = kind === 'pattern' && isRecord(root.pattern) ? root.pattern : isRecord(root.board) ? root.board : {}
  const dimensions = isRecord(source.gridDimensions) ? source.gridDimensions : {}
  let columns = Number(dimensions.columns) || 0
  let rows = Number(dimensions.rows) || 0
  let total = Number(source.totalBeadCount) || 0
  let colorCount = isRecord(source.colorCounts) ? Object.keys(source.colorCounts).length : 0
  if (kind === 'board' && Array.isArray(source.layers)) {
    const layers = source.layers.filter(isRecord)
    columns = Math.max(0, ...layers.map((layer) => Number(layer.x) + Number(layer.width)))
    rows = Math.max(0, ...layers.map((layer) => Number(layer.y) + Number(layer.height)))
    total = layers.reduce((sum, layer) => sum + (Number(layer.totalBeadCount) || 0), 0)
    const colors = new Set<string>()
    layers.forEach((layer) => { if (isRecord(layer.colorCounts)) Object.keys(layer.colorCounts).forEach((key) => colors.add(key)) })
    colorCount = colors.size
  }
  const cells = Math.max(0, columns * rows)
  const difficulty = cells > 2500 || colorCount > 24 ? '挑战' : cells > 400 || colorCount > 10 ? '中等' : '简单'
  const beadSize = kind === 'pattern' && isRecord(source) && (source.beadSizeMm === 2.6 || source.beadSizeMm === 5) ? source.beadSizeMm : kind === 'board' && isRecord(source) && (source.beadSizeMm === 2.6 || source.beadSizeMm === 5) ? source.beadSizeMm : null
  return { gridColumns: columns, gridRows: rows, colorCount, totalBeadCount: total, difficulty, beadSizeMm: beadSize }
}

const sanitizeDocumentForCopy = (input: unknown, kind: string): unknown => {
  if (!isRecord(input)) throw new BusinessApiError('COMMUNITY_VERSION_INVALID', '公开图纸快照无效。', 500)
  const clone = JSON.parse(JSON.stringify(input)) as Record<string, unknown>
  // A copied Work starts at its own immutable revision 1. Keeping the
  // snapshot's old revision would make generated materialList metadata fail
  // the existing WorkDocument validator on the first edit.
  clone.documentRevision = 1
  if (isRecord(clone.materialList) && clone.materialList.status === 'generated') {
    clone.materialList.generatedFromRevision = 1
  }
  if (kind === 'board' && isRecord(clone.board) && Array.isArray(clone.board.layers)) {
    clone.board.layers = clone.board.layers.map((layerValue) => {
      if (!isRecord(layerValue)) return layerValue
      const layer: Record<string, unknown> = { ...layerValue, sourceAssetId: null, thumbnailAssetId: null }
      if (layerValue.sourceAssetId || layerValue.thumbnailAssetId) layer.regenerationCapability = 'unavailable'
      return layer
    })
  }
  return clone
}

const publicMediaProjection = (rows: DatabaseRow[]) => rows.map((row) => ({
  mediaId: asString(row.public_id),
  role: asString(row.role),
  sortOrder: asNumber(row.sort_order),
  mimeType: asString(row.mime_type),
  altText: row.alt_text === null ? null : asString(row.alt_text),
  url: `/api/v1/community/media/${encodeURIComponent(asString(row.public_id))}`,
}))

const parsePostMetadata = (value: unknown) => {
  const body = parseBody(value)
  const title = body.title === undefined ? undefined : requiredText(body.title, 120, '社区标题无效。')
  const category = body.category === undefined ? undefined : requiredText(body.category, 60, '主题分类无效。')
  const tags = body.tags === undefined ? undefined : safeTags(body.tags)
  if (body.allowCopy !== undefined && typeof body.allowCopy !== 'boolean') {
    throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '复制开关格式无效。', 422)
  }
  const allowCopy = body.allowCopy === undefined ? undefined : body.allowCopy
  const coverMediaId = body.coverMediaId === undefined ? undefined : requiredText(body.coverMediaId, 100, '社区封面标识无效。')
  if (coverMediaId !== undefined && !mediaIdPattern.test(coverMediaId)) {
    throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区封面标识无效。', 422)
  }
  return Object.fromEntries(
    Object.entries({ title, category, tags, allowCopy, coverMediaId }).filter(([, value]) => value !== undefined),
  ) as { title?: string; category?: string; tags?: string[]; allowCopy?: boolean; coverMediaId?: string }
}

const postProjection = (row: DatabaseRow, media: DatabaseRow[] = []) => ({
  postId: asString(row.post_public_id ?? row.public_id),
  title: asString(row.title),
  category: asString(row.category),
  tags: Array.isArray(row.tags) ? row.tags : [],
  status: asString(row.status) as PostStatus,
  allowCopy: Boolean(row.allow_copy),
  author: {
    creatorId: asString(row.creator_public_id),
    name: asString(row.author_name_snapshot || 'PixoMosaic 用户'),
    displayName: asString(row.author_name_snapshot || 'PixoMosaic 用户'),
  },
  source: { workRevision: asNumber(row.source_work_revision), isAvailable: row.source_post_status ? row.source_post_status === 'published' : row.status === 'published' },
  version: row.version_public_id ? { versionId: asString(row.version_public_id), kind: asString(row.kind), gridColumns: asNumber(row.grid_columns), gridRows: asNumber(row.grid_rows), colorCount: asNumber(row.color_count), totalBeadCount: asNumber(row.total_bead_count), difficulty: asString(row.difficulty) === '简单' ? 'simple' : asString(row.difficulty) === '中等' ? 'medium' : 'challenging', beadSizeMm: row.bead_size_mm === null ? null : Number(row.bead_size_mm) } : null,
  media: publicMediaProjection(media),
  coverUrl: media.find((item) => item.role === 'cover') ? `/api/v1/community/media/${encodeURIComponent(asString(media.find((item) => item.role === 'cover')?.public_id))}` : null,
  gallery: media.filter((item) => item.role === 'gallery').map((item) => ({ mediaId: asString(item.public_id), url: `/api/v1/community/media/${encodeURIComponent(asString(item.public_id))}`, alt: item.alt_text === null ? null : asString(item.alt_text) })),
  width: row.grid_columns === undefined ? null : asNumber(row.grid_columns),
  height: row.grid_rows === undefined ? null : asNumber(row.grid_rows),
  beadCount: row.total_bead_count === undefined ? null : asNumber(row.total_bead_count),
  colorCount: row.color_count === undefined ? null : asNumber(row.color_count),
  difficulty: row.difficulty === undefined ? null : asString(row.difficulty) === '简单' ? 'simple' : asString(row.difficulty) === '中等' ? 'medium' : 'challenging',
  stats: { likeCount: asNumber(row.like_count), favoriteCount: asNumber(row.favorite_count) },
  ...(typeof row.is_liked === 'boolean' ? { isLiked: row.is_liked } : {}),
  ...(typeof row.is_favorited === 'boolean' ? { isFavorited: row.is_favorited } : {}),
  publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : asString(row.published_at),
})

const publishedPostProjection = (row: DatabaseRow, media: DatabaseRow[] = []) => ({
  postId: asString(row.post_public_id ?? row.public_id),
  title: asString(row.title),
  category: asString(row.category),
  tags: Array.isArray(row.tags) ? row.tags : [],
  status: 'published' as const,
  allowCopy: Boolean(row.allow_copy),
  author: {
    creatorId: asString(row.creator_public_id),
    name: asString(row.author_name_snapshot || 'PixoMosaic 用户'),
    displayName: asString(row.author_display_name || row.author_name_snapshot || 'PixoMosaic 用户'),
  },
  publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : asString(row.published_at),
  coverUrl: media.find((item) => item.role === 'cover')
    ? `/api/v1/community/media/${encodeURIComponent(asString(media.find((item) => item.role === 'cover')?.public_id))}`
    : null,
  gallery: media.filter((item) => item.role === 'gallery').map((item) => ({
    mediaId: asString(item.public_id),
    url: `/api/v1/community/media/${encodeURIComponent(asString(item.public_id))}`,
    alt: item.alt_text === null ? null : asString(item.alt_text),
  })),
  version: row.version_public_id ? {
    versionId: asString(row.version_public_id),
    kind: asString(row.kind) as 'pattern' | 'board',
    gridColumns: asNumber(row.grid_columns),
    gridRows: asNumber(row.grid_rows),
    colorCount: asNumber(row.color_count),
    totalBeadCount: asNumber(row.total_bead_count),
    difficulty: asString(row.difficulty) === '简单' ? 'simple' : asString(row.difficulty) === '中等' ? 'medium' : 'challenging',
    beadSizeMm: row.bead_size_mm === null ? null : Number(row.bead_size_mm),
  } : null,
  stats: { likeCount: asNumber(row.like_count ?? 0), favoriteCount: asNumber(row.favorite_count ?? 0) },
  ...(typeof row.is_liked === 'boolean' ? { isLiked: row.is_liked } : {}),
  ...(typeof row.is_favorited === 'boolean' ? { isFavorited: row.is_favorited } : {}),
})

const parseStrictLimit = (searchParams: URLSearchParams): number => {
  const raw = searchParams.get('limit')
  if (raw === null || raw === '') return 24
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页数量无效。', 422)
  return value
}

const encodeOpaque = (value: object): string => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
const decodeOpaque = (value: string): Record<string, unknown> => {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!isRecord(decoded)) throw new Error('invalid cursor')
    return decoded
  }
  catch { throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422) }
}
const timestampMs = (value: unknown): number => {
  const result = value instanceof Date ? value.getTime() : typeof value === 'string' ? new Date(value).getTime() : NaN
  if (!Number.isSafeInteger(result) || result < 0) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return result
}
const parseOwnerStatuses = (searchParams: URLSearchParams): string[] => {
  const values = searchParams.getAll('status').flatMap((item) => item.split(','))
  if (!values.length) return ['published', 'withdrawn', 'takedown', 'deleted']
  const allowed = new Set<PostStatus>(['published', 'withdrawn', 'takedown', 'deleted'])
  const statuses = [...new Set(values.map((item) => item.trim()).filter(Boolean))]
  if (!statuses.length || statuses.some((item) => !allowed.has(item as PostStatus))) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '内容状态筛选无效。', 422)
  return statuses.sort()
}

const readMediaByPost = async (pool: Pool, postIds: number[]): Promise<Map<number, DatabaseRow[]>> => {
  const result = postIds.length
    ? await pool.query(`SELECT post_id, public_id, role, sort_order, mime_type, alt_text FROM community_post_media WHERE post_id = ANY($1::int[]) AND status = 'ready' ORDER BY sort_order ASC, id ASC`, [postIds])
    : { rows: [] }
  const mediaByPost = new Map<number, DatabaseRow[]>()
  result.rows.forEach((row) => mediaByPost.set(asNumber(row.post_id), [...(mediaByPost.get(asNumber(row.post_id)) ?? []), row]))
  return mediaByPost
}

const ownerPostsCursor = (row: DatabaseRow, statuses: string[], ownerId: number): string => encodeOpaque({ v: 1, scope: 'owner-posts', ownerId, statuses: sha256(statuses.join(',')), updatedAt: timestampMs(row.updated_at), id: asNumber(row.db_post_id) } satisfies OwnerPostsCursor)
const creatorPostsCursor = (row: DatabaseRow, creatorId: string): string => encodeOpaque({ v: 1, scope: 'creator-posts', creatorId, publishedAt: timestampMs(row.published_at), id: asNumber(row.db_post_id) } satisfies CreatorPostsCursor)
const favoritesCursor = (row: DatabaseRow, ownerId: number): string => encodeOpaque({ v: 1, scope: 'favorites', ownerId, createdAt: timestampMs(row.favorited_at), id: asNumber(row.favorite_db_id) } satisfies FavoritesCursor)

const parseCursorDate = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error('invalid cursor')
  return value as number
}
const parseCursorId = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('invalid cursor')
  return value as number
}

export const listOwnCommunityPosts = async (context: ActiveSessionContext, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const pool = getPool(context)
  const statuses = parseOwnerStatuses(searchParams)
  const statusHash = sha256(statuses.join(','))
  const limit = parseStrictLimit(searchParams)
  const rawCursor = searchParams.get('cursor')
  let cursor: OwnerPostsCursor | null = null
  if (rawCursor) {
    const decoded = decodeOpaque(rawCursor) as Partial<OwnerPostsCursor>
    if (decoded.v !== 1 || decoded.scope !== 'owner-posts' || decoded.ownerId !== context.user.id || decoded.statuses !== statusHash) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422)
    try { cursor = { v: 1, scope: 'owner-posts', ownerId: context.user.id, statuses: statusHash, updatedAt: parseCursorDate(decoded.updatedAt), id: parseCursorId(decoded.id) } }
    catch { throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422) }
  }
  const result = await pool.query(`SELECT p.id AS db_post_id, p.public_id, p.title, p.category, p.tags, p.status, p.allow_copy, p.published_at, p.updated_at, p.like_count, p.favorite_count
    FROM community_posts p WHERE p.owner_id = $1 AND p.status::text = ANY($2::text[])
      AND ($3::timestamptz IS NULL OR p.updated_at < $3::timestamptz OR (p.updated_at = $3::timestamptz AND p.id < $4::integer))
    ORDER BY p.updated_at DESC, p.id DESC LIMIT $5`, [context.user.id, statuses, cursor ? new Date(cursor.updatedAt).toISOString() : null, cursor?.id ?? null, limit + 1])
  const rows = result.rows.slice(0, limit)
  const mediaByPost = await readMediaByPost(pool, rows.filter((row) => row.status === 'published').map((row) => asNumber(row.db_post_id)))
  return {
    posts: rows.map((row) => ({
      postId: asString(row.public_id), title: asString(row.title), category: asString(row.category), tags: Array.isArray(row.tags) ? row.tags : [],
      status: asString(row.status), allowCopy: Boolean(row.allow_copy), publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : asString(row.published_at), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : asString(row.updated_at),
      coverMedia: row.status === 'published' && mediaByPost.get(asNumber(row.db_post_id))?.find((item) => item.role === 'cover')
        ? (() => { const cover = mediaByPost.get(asNumber(row.db_post_id))!.find((item) => item.role === 'cover')!; return { mediaId: asString(cover.public_id), url: `/api/v1/community/media/${encodeURIComponent(asString(cover.public_id))}`, altText: cover.alt_text === null ? null : asString(cover.alt_text) } })()
        : null,
      stats: { likeCount: asNumber(row.like_count), favoriteCount: asNumber(row.favorite_count) },
    })),
    nextCursor: result.rows.length > limit && rows.length ? ownerPostsCursor(rows[rows.length - 1]!, statuses, context.user.id) : null,
  }
}

export const listPublicCreatorPosts = async (context: Pick<ActiveSessionContext, 'payload'>, creatorId: string, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const pool = getPool(context)
  if (!/^creator_[a-f0-9]{32}$/.test(creatorId)) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
  const creator = await pool.query('SELECT owner_id FROM community_creator_profiles WHERE public_id = $1', [creatorId])
  const ownerId = creator.rows[0]?.owner_id
  if (!Number.isSafeInteger(ownerId)) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
  const limit = parseStrictLimit(searchParams)
  const rawCursor = searchParams.get('cursor')
  let cursor: CreatorPostsCursor | null = null
  if (rawCursor) {
    const decoded = decodeOpaque(rawCursor) as Partial<CreatorPostsCursor>
    if (decoded.v !== 1 || decoded.scope !== 'creator-posts' || decoded.creatorId !== creatorId) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422)
    try { cursor = { v: 1, scope: 'creator-posts', creatorId, publishedAt: parseCursorDate(decoded.publishedAt), id: parseCursorId(decoded.id) } }
    catch { throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422) }
  }
  const result = await pool.query(`SELECT p.id AS db_post_id, p.public_id AS post_public_id, p.title, p.category, p.tags, p.allow_copy, p.published_at, p.author_name_snapshot, cp.public_id AS creator_public_id, cp.display_name AS author_display_name, p.like_count, p.favorite_count,
      v.public_id AS version_public_id, v.kind, v.grid_columns, v.grid_rows, v.color_count, v.total_bead_count, v.difficulty, v.bead_size_mm
    FROM community_posts p JOIN published_pattern_versions v ON v.id = p.current_version_id
      LEFT JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
    WHERE p.owner_id = $1 AND p.status = 'published'
      AND ($2::timestamptz IS NULL OR p.published_at < $2::timestamptz OR (p.published_at = $2::timestamptz AND p.id < $3::integer))
    ORDER BY p.published_at DESC, p.id DESC LIMIT $4`, [ownerId, cursor ? new Date(cursor.publishedAt).toISOString() : null, cursor?.id ?? null, limit + 1])
  const rows = result.rows.slice(0, limit)
  const mediaByPost = await readMediaByPost(pool, rows.map((row) => asNumber(row.db_post_id)))
  return { posts: rows.map((row) => publishedPostProjection(row, mediaByPost.get(asNumber(row.db_post_id)) ?? [])), nextCursor: result.rows.length > limit && rows.length ? creatorPostsCursor(rows[rows.length - 1]!, creatorId) : null }
}

export const listCommunityFavorites = async (context: ActiveSessionContext, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const pool = getPool(context)
  const limit = parseStrictLimit(searchParams)
  const rawCursor = searchParams.get('cursor')
  let cursor: FavoritesCursor | null = null
  if (rawCursor) {
    const decoded = decodeOpaque(rawCursor) as Partial<FavoritesCursor>
    if (decoded.v !== 1 || decoded.scope !== 'favorites' || decoded.ownerId !== context.user.id) throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422)
    try { cursor = { v: 1, scope: 'favorites', ownerId: context.user.id, createdAt: parseCursorDate(decoded.createdAt), id: parseCursorId(decoded.id) } }
    catch { throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '分页游标无效。', 422) }
  }
  const result = await pool.query(`SELECT f.id AS favorite_db_id, f.created_at AS favorited_at, p.id AS db_post_id, p.public_id AS post_public_id, p.title, p.category, p.tags, p.allow_copy, p.status, p.published_at, p.author_name_snapshot, cp.public_id AS creator_public_id, cp.display_name AS author_display_name, p.like_count, p.favorite_count,
      v.public_id AS version_public_id, v.kind, v.grid_columns, v.grid_rows, v.color_count, v.total_bead_count, v.difficulty, v.bead_size_mm
    FROM community_favorites f LEFT JOIN community_posts p ON p.id = f.post_id LEFT JOIN published_pattern_versions v ON v.id = p.current_version_id LEFT JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
    WHERE f.actor_id = $1 AND ($2::timestamptz IS NULL OR f.created_at < $2::timestamptz OR (f.created_at = $2::timestamptz AND f.id < $3::integer))
    ORDER BY f.created_at DESC, f.id DESC LIMIT $4`, [context.user.id, cursor ? new Date(cursor.createdAt).toISOString() : null, cursor?.id ?? null, limit + 1])
  const rows = result.rows.slice(0, limit)
  const publishedRows = rows.filter((row) => row.status === 'published' && row.db_post_id !== null)
  const mediaByPost = await readMediaByPost(pool, publishedRows.map((row) => asNumber(row.db_post_id)))
  return {
    favorites: rows.map((row) => row.status === 'published' && row.db_post_id !== null
      ? { ...publishedPostProjection(row, mediaByPost.get(asNumber(row.db_post_id)) ?? []), availability: 'available' as const, favoritedAt: row.favorited_at instanceof Date ? row.favorited_at.toISOString() : asString(row.favorited_at) }
      : { postId: row.post_public_id === null || row.post_public_id === undefined ? 'community_post_unavailable' : asString(row.post_public_id), availability: 'unavailable' as const, displayLabel: '内容不可用' as const, favoritedAt: row.favorited_at instanceof Date ? row.favorited_at.toISOString() : asString(row.favorited_at) }),
    nextCursor: result.rows.length > limit && rows.length ? favoritesCursor(rows[rows.length - 1]!, context.user.id) : null,
  }
}

const communityListCursorClause = (sort: CommunityListSort): string => {
  if (sort === 'recommended') return `AND ($4::boolean IS NULL OR (
    p.is_featured < $4::boolean OR (p.is_featured = $4::boolean AND (
      p.published_at < $5::timestamptz OR (p.published_at = $5::timestamptz AND p.id < $6::integer)
    ))
  ))`
  if (sort === 'latest') return `AND ($4::timestamptz IS NULL OR (
    p.published_at < $4::timestamptz OR (p.published_at = $4::timestamptz AND p.id < $5::integer)
  ))`
  const countColumn = sort === 'likes' ? 'p.like_count' : 'p.favorite_count'
  return `AND ($4::integer IS NULL OR (
    ${countColumn} < $4::integer OR (${countColumn} = $4::integer AND (
      p.published_at < $5::timestamptz OR (p.published_at = $5::timestamptz AND p.id < $6::integer)
    ))
  ))`
}

const communityListOrder = (sort: CommunityListSort): string => {
  if (sort === 'recommended') return 'p.is_featured DESC, p.published_at DESC, p.id DESC'
  if (sort === 'latest') return 'p.published_at DESC, p.id DESC'
  return `${sort === 'likes' ? 'p.like_count' : 'p.favorite_count'} DESC, p.published_at DESC, p.id DESC`
}

const listCommunityFromPool = async (pool: Pool, searchParams?: URLSearchParams): Promise<Record<string, unknown>> => {
  const query = searchParams?.get('q')?.trim() ?? ''
  const category = searchParams?.get('category')?.trim() ?? ''
  const tag = searchParams?.get('tag')?.trim() ?? ''
  const sort = parseCommunityListSort(searchParams)
  const filter = cursorFilter(query, category, tag)
  const { limit, cursor } = parseListWindow(searchParams, sort, filter)
  const cursorValues = sort === 'latest'
    ? [cursor ? new Date(cursor.publishedAt).toISOString() : null, cursor?.id ?? null]
    : sort === 'recommended'
      ? [cursor?.isFeatured ?? null, cursor ? new Date(cursor.publishedAt).toISOString() : null, cursor?.id ?? null]
      : [cursor?.score ?? null, cursor ? new Date(cursor.publishedAt).toISOString() : null, cursor?.id ?? null]
  const result = await pool.query(`SELECT p.id AS db_post_id, p.public_id AS post_public_id, p.title, p.category, p.tags, p.status, p.allow_copy, p.is_featured, p.author_name_snapshot, cp.public_id AS creator_public_id, p.source_work_revision, p.like_count, p.favorite_count, p.published_at, v.public_id AS version_public_id, v.kind, v.grid_columns, v.grid_rows, v.color_count, v.total_bead_count, v.difficulty, v.bead_size_mm
    FROM community_posts p JOIN published_pattern_versions v ON v.id = p.current_version_id JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
    WHERE p.status = 'published' AND ($1 = '' OR p.title ILIKE '%' || $1 || '%' OR p.tags::text ILIKE '%' || $1 || '%')
      AND ($2 = '' OR p.category = $2) AND ($3 = '' OR p.tags @> jsonb_build_array($3::text))
      ${communityListCursorClause(sort)}
    ORDER BY ${communityListOrder(sort)} LIMIT $${4 + cursorValues.length}`,
  [query, category, tag, ...cursorValues, limit + 1])
  const pageRows = result.rows.slice(0, limit)
  const media = pageRows.length ? await pool.query(`SELECT post_id, public_id, role, sort_order, mime_type, alt_text FROM community_post_media WHERE post_id = ANY($1::int[]) AND status = 'ready' ORDER BY sort_order ASC, id ASC`, [pageRows.map((row) => asNumber(row.db_post_id))]) : { rows: [] }
  const mediaByPost = new Map<number, DatabaseRow[]>()
  media.rows.forEach((row) => mediaByPost.set(asNumber(row.post_id), [...(mediaByPost.get(asNumber(row.post_id)) ?? []), row]))
  return {
    posts: pageRows.map((row) => postProjection(row, mediaByPost.get(asNumber(row.db_post_id)) ?? [])),
    nextCursor: result.rows.length > limit ? encodeListCursor(sort, filter, pageRows[pageRows.length - 1]!) : null,
  }
}

export const listCommunity = async (context?: ActiveSessionContext, searchParams?: URLSearchParams): Promise<Record<string, unknown>> => {
  if (context) return listCommunityFromPool(getPool(context), searchParams)
  const pool = (globalThis as unknown as { __pixomosaicCommunityPool?: Pool }).__pixomosaicCommunityPool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return listCommunityFromPool(pool, searchParams)
}

// Anonymous reads use a short-lived Payload instance in the route. This helper
// keeps the projection shared with authenticated reads without exposing user IDs.
export const listCommunityWithPayload = async (payload: ActiveSessionContext['payload'], searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const pool = (payload.db as unknown as { pool?: Pool }).pool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return listCommunityFromPool(pool, searchParams)
}

export const getCommunityPost = async (payload: ActiveSessionContext['payload'], postId: string, viewerId: number | null = null): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  const pool = (payload.db as unknown as { pool?: Pool }).pool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  const result = await pool.query(`SELECT p.*, cp.public_id AS creator_public_id, v.public_id AS version_public_id, v.kind, v.grid_columns, v.grid_rows, v.color_count, v.total_bead_count, v.difficulty, v.bead_size_mm,
    EXISTS (SELECT 1 FROM community_likes l WHERE l.post_id = p.id AND l.actor_id = $2) AS is_liked,
    EXISTS (SELECT 1 FROM community_favorites f WHERE f.post_id = p.id AND f.actor_id = $2) AS is_favorited
    FROM community_posts p JOIN published_pattern_versions v ON v.id = p.current_version_id JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id WHERE p.public_id = $1 AND p.status = 'published'`, [postId, viewerId])
  const row = result.rows[0]
  if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
  const media = await pool.query(`SELECT public_id, role, sort_order, mime_type, alt_text FROM community_post_media WHERE post_id = $1 AND status = 'ready' ORDER BY sort_order ASC, id ASC`, [row.id])
  return { post: postProjection(row, media.rows) }
}

export const updateCommunityPost = async (context: ActiveSessionContext, postId: string, bodyValue: unknown, keySha256: string) => {
  parsePostId(postId)
  const metadata = parsePostMetadata(bodyValue)
  if (metadata.title === undefined && metadata.category === undefined && metadata.tags === undefined && metadata.allowCopy === undefined && metadata.coverMediaId === undefined) {
    throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '至少需要修改一个社区字段。', 422)
  }
  return withIdempotentWrite(context, {
    route: `PATCH /api/v1/community/${postId}`, keySha256,
    requestSha256: stableStringify(metadata), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const post = await db.execute(sql`SELECT id, public_id, status FROM community_posts WHERE public_id = ${postId} AND owner_id = ${context.user.id} FOR UPDATE`)
      if (!post.rows[0]) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      if (asString(post.rows[0].status) === 'deleted') throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      if (metadata.coverMediaId !== undefined) {
        const replacement = await db.execute(sql`SELECT public_id FROM community_post_media
          WHERE public_id = ${metadata.coverMediaId} AND uploader_id = ${context.user.id}
            AND post_id IS NULL AND role = 'cover' AND status = 'ready' FOR UPDATE`)
        if (!replacement.rows[0]) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区封面不存在或不属于当前账号。', 422)
        await db.execute(sql`UPDATE community_post_media SET status = 'deleted'
          WHERE post_id = ${asNumber(post.rows[0].id)} AND role = 'cover' AND status = 'ready'`)
        await db.execute(sql`UPDATE community_post_media SET post_id = ${asNumber(post.rows[0].id)}, sort_order = 0
          WHERE public_id = ${metadata.coverMediaId} AND uploader_id = ${context.user.id} AND post_id IS NULL`)
      }
      const updated = await db.execute(sql`UPDATE community_posts SET
        title = COALESCE(${metadata.title ?? null}, title), category = COALESCE(${metadata.category ?? null}, category),
        tags = COALESCE(${metadata.tags ? JSON.stringify(metadata.tags) : null}::jsonb, tags),
        allow_copy = COALESCE(${metadata.allowCopy ?? null}, allow_copy), updated_at = NOW()
        WHERE public_id = ${postId} AND owner_id = ${context.user.id}
        RETURNING public_id, title, category, tags, allow_copy, status`)
      const row = updated.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      return { post: { postId, title: asString(row.title), category: asString(row.category), tags: Array.isArray(row.tags) ? row.tags : [], allowCopy: Boolean(row.allow_copy), coverMediaId: metadata.coverMediaId ?? null, status: asString(row.status) } }
    },
  })
}

export const withdrawCommunityPost = async (context: ActiveSessionContext, postId: string, keySha256: string) => {
  parsePostId(postId)
  return withIdempotentWrite(context, {
    route: `POST /api/v1/community/${postId}/withdraw`, keySha256, requestSha256: postId,
    responseStatus: 200, parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`UPDATE community_posts SET status = 'withdrawn', withdrawn_at = COALESCE(withdrawn_at, NOW()),
        is_featured = false, featured_at = NULL, featured_by_id = NULL, featured_reason = NULL,
        moderation_version = moderation_version + 1, moderation_updated_at = NOW(), updated_at = NOW()
        WHERE public_id = ${postId} AND owner_id = ${context.user.id} AND status = 'published' RETURNING public_id, status`)
      if (!result.rows[0]) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在或已下架。', 404)
      return { postId, status: 'withdrawn' }
    },
  })
}

export const publishCommunityPost = async (context: ActiveSessionContext, bodyValue: unknown, keySha256: string) => {
  const body = parseBody(bodyValue)
  const workId = requiredText(body.workId, 80, '作品标识无效。')
  if (!workIdPattern.test(workId)) throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  const title = requiredText(body.title, 120, '社区标题无效。')
  const category = requiredText(body.category, 60, '主题分类无效。')
  const tags = safeTags(body.tags ?? [])
  if (body.copyrightConfirmed !== true) throw new BusinessApiError('COMMUNITY_COPYRIGHT_REQUIRED', '请先确认拥有公开发布授权。', 422)
  if (body.allowCopy !== undefined && typeof body.allowCopy !== 'boolean') throw new BusinessApiError('COMMUNITY_INPUT_INVALID', '复制开关格式无效。', 422)
  const allowCopy = body.allowCopy === undefined ? true : body.allowCopy
  const cover = requiredText(body.coverMediaId, 100, '社区封面不能为空。')
  if (cover.startsWith('asset_') || cover.includes('/') || cover.includes('://')) throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体必须使用独立媒体标识。', 422)
  const gallery = Array.isArray(body.galleryMediaIds) ? body.galleryMediaIds.map((value) => requiredText(value, 100, '社区附图标识无效。')) : []
  if (gallery.length > 9) throw new BusinessApiError('COMMUNITY_MEDIA_LIMIT', '社区附图最多 9 张。', 422)
  const requestSha256 = stableStringify({ workId, title, category, tags, allowCopy, cover, gallery, copyrightConfirmed: true })
  return withIdempotentWrite(context, {
    route: 'POST /api/v1/community', keySha256, requestSha256, responseStatus: 201,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      // A profile is a community-only projection. Creating it together with
      // the first post gives governance a stable author ID without exposing a
      // Better Auth user ID on public endpoints.
      await ensureCommunityCreatorForPost(context)
      // Hold the source Work row until the frozen version and post are written.
      // Otherwise a concurrent deletion can pass the active-state read and
      // commit after the database withdrawal trigger has already run.
      const lockedWork = await db.execute(sql`SELECT id FROM works
        WHERE public_id = ${workId} AND owner_id = ${context.user.id} AND state = 'active' FOR UPDATE`)
      if (!lockedWork.rows[0]) throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
      const workResult = await context.payload.find({ collection: 'works', depth: 0, limit: 1, overrideAccess: false, req: context.req, where: { and: [{ owner: { equals: context.user.id } }, { publicId: { equals: workId } }, { state: { equals: 'active' } }] } })
      const work = workResult.docs[0]
      if (!work || typeof work.currentDocument !== 'number') throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
      const document = await context.payload.findByID({ collection: 'work-documents', id: work.currentDocument, depth: 0, overrideAccess: false, req: context.req })
      const kind = work.kind
      const stats = inspectDocument(document.document, kind)
      const postId = toId('community_post')
      const versionId = toId('published_version')
      if (!mediaIdPattern.test(cover) || gallery.some((id) => !mediaIdPattern.test(id))) {
        throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体标识无效。', 422)
      }
      const suppliedMedia = await db.execute(sql`SELECT public_id, role FROM community_post_media
        WHERE uploader_id = ${context.user.id} AND post_id IS NULL AND status = 'ready'
          AND public_id IN (${sql.join([cover, ...gallery].map((id) => sql`${id}`), sql`, `)}) FOR UPDATE`)
      if (suppliedMedia.rows.length !== 1 + gallery.length) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在或不属于当前账号。', 422)
      const mediaById = new Map(suppliedMedia.rows.map((row) => [asString(row.public_id), asString(row.role)]))
      if (mediaById.get(cover) !== 'cover' || gallery.some((id) => mediaById.get(id) !== 'gallery')) throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体角色与发布内容不匹配。', 422)
      const post = await db.execute(sql`INSERT INTO community_posts (public_id, owner_id, source_work_id, source_work_public_id, source_work_revision, author_name_snapshot, title, category, tags, copyright_confirmed, allow_copy) VALUES (${postId}, ${context.user.id}, ${work.id}, ${work.publicId}, ${work.documentRevision}, ${String((context.user as { name?: string }).name ?? '').slice(0, 120)}, ${title}, ${category}, ${JSON.stringify(tags)}::jsonb, true, ${allowCopy}) RETURNING id, public_id`)
      const postRow = post.rows[0]
      if (!postRow) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      const documentJson = stableStringify(document.document)
      const version = await db.execute(sql`INSERT INTO published_pattern_versions (public_id, post_id, version_number, source_work_id, source_work_public_id, source_document_revision, kind, document, document_sha256, document_byte_size, bead_size_mm, grid_columns, grid_rows, color_count, total_bead_count, difficulty, author_name_snapshot) VALUES (${versionId}, ${asNumber(postRow.id)}, 1, ${work.id}, ${work.publicId}, ${work.documentRevision}, ${kind}, ${documentJson}::jsonb, ${work.documentSha256}, ${Buffer.byteLength(documentJson, 'utf8')}, ${stats.beadSizeMm}, ${stats.gridColumns}, ${stats.gridRows}, ${stats.colorCount}, ${stats.totalBeadCount}, ${stats.difficulty}, ${String((context.user as { name?: string }).name ?? '').slice(0, 120)}) RETURNING id`)
      const versionRow = version.rows[0]
      if (!versionRow) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      await db.execute(sql`UPDATE community_posts SET current_version_id = ${asNumber(versionRow.id)} WHERE id = ${asNumber(postRow.id)}`)
      const mediaIds = [cover, ...gallery]
      for (let index = 0; index < mediaIds.length; index += 1) {
        const role = index === 0 ? 'cover' : 'gallery'
        await db.execute(sql`UPDATE community_post_media SET post_id = ${asNumber(postRow.id)}, sort_order = ${index}, role = ${role}
          WHERE public_id = ${mediaIds[index]} AND uploader_id = ${context.user.id} AND post_id IS NULL`)
      }
      await recordAuthenticatedAuditEvent(context, { action: 'community.published', outcome: 'allowed', resourcePublicId: postId, resourceType: 'community', route: 'POST /api/v1/community' })
      return { post: { postId, versionId, status: 'published', allowCopy } }
    },
  })
}

export const copyCommunityPost = async (context: ActiveSessionContext, postId: string, keySha256: string) => {
  parsePostId(postId)
  try {
    return await withIdempotentWrite(context, {
    route: `POST /api/v1/community/${postId}/copy`, keySha256, requestSha256: postId, responseStatus: 201,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT p.id AS post_id, p.public_id AS post_public_id, p.allow_copy, p.author_name_snapshot, p.source_work_revision, v.id AS version_id, v.public_id AS version_public_id, v.kind, v.document, v.document_sha256 FROM community_posts p JOIN published_pattern_versions v ON v.id = p.current_version_id WHERE p.public_id = ${postId} AND p.status = 'published' FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      if (!row.allow_copy) throw new BusinessApiError('COMMUNITY_COPY_DISABLED', '作者未开放复制。', 403)
      const rawDocument = sanitizeDocumentForCopy(row.document, asString(row.kind)) as Record<string, unknown>
      const title = `${asString(row.author_name_snapshot || '社区图纸')} 的副本`.slice(0, 120)
      const workPublicId = toId('work')
      const documentJson = stableStringify(rawDocument)
      const documentHash = sha256(documentJson)
      const work = await db.execute(sql`INSERT INTO works (public_id, owner_id, kind, title, state, visibility, document_revision, document_sha256) VALUES (${workPublicId}, ${context.user.id}, ${asString(row.kind)}, ${title}, 'active', 'private', 1, ${documentHash}) RETURNING id, public_id`)
      const workRow = work.rows[0]
      if (!workRow) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      const document = await db.execute(sql`INSERT INTO work_documents (owner_id, work_id, revision, schema_version, kind, document, content_sha256, document_byte_size) VALUES (${context.user.id}, ${asNumber(workRow.id)}, 1, 1, ${asString(row.kind)}, ${documentJson}::jsonb, ${documentHash}, ${Buffer.byteLength(documentJson, 'utf8')}) RETURNING id`)
      const documentRow = document.rows[0]
      if (!documentRow) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      await db.execute(sql`UPDATE works SET current_document_id = ${asNumber(documentRow.id)}, updated_at = NOW() WHERE id = ${asNumber(workRow.id)}`)
      const provenanceId = toId('copy_provenance')
      await db.execute(sql`INSERT INTO copy_provenance (public_id, source_post_id, source_post_public_id, source_version_id, source_version_public_id, source_author_name_snapshot, copied_by_id, copied_work_id) VALUES (${provenanceId}, ${asNumber(row.post_id)}, ${asString(row.post_public_id)}, ${asNumber(row.version_id)}, ${asString(row.version_public_id)}, ${asString(row.author_name_snapshot || '')}, ${context.user.id}, ${asNumber(workRow.id)})`)
      await recordAuthenticatedAuditEvent(context, { action: 'community.copied', outcome: 'allowed', resourcePublicId: postId, resourceType: 'community', route: `POST /api/v1/community/${postId}/copy` })
      return { work: { workId: workPublicId, title, kind: asString(row.kind), state: 'active', documentRevision: 1, visibility: 'private' }, provenance: { provenanceId, sourcePostId: postId, sourceVersionId: asString(row.version_public_id), sourceStatus: 'published' } }
    },
    })
  } catch (error) {
    if (hasDatabaseCode(error, 'WORK_LIMIT_REACHED')) throw new BusinessApiError('WORK_LIMIT_REACHED', '当前最多保留 50 份制作中的图纸，请先删除一份后再复制。', 409)
    if (hasDatabaseCode(error, 'WORK_REVISION_CONFLICT')) throw new BusinessApiError('WORK_REVISION_CONFLICT', '作品版本冲突，请稍后重试。', 409)
    throw error
  }
}

export const toggleInteraction = async (context: ActiveSessionContext, postId: string, kind: 'like' | 'favorite', active: boolean, keySha256: string) => {
  parsePostId(postId)
  const table = kind === 'like' ? 'community_likes' : 'community_favorites'
  const column = kind === 'like' ? 'like_count' : 'favorite_count'
  return withIdempotentWrite(context, {
    route: `${active ? 'PUT' : 'DELETE'} /api/v1/community/${postId}/${kind}`, keySha256, requestSha256: `${postId}:${active}`,
    responseStatus: 200, parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      // Serialize the cached counter update with the relation insert/delete.
      // Without the row lock, concurrent actors can each count an old snapshot
      // and the last UPDATE can leave like_count/favorite_count too small.
      const post = await db.execute(sql`SELECT id, public_id, status FROM community_posts
        WHERE public_id = ${postId} AND (status = 'published' OR (${active} = false AND ${kind === 'favorite'})) FOR UPDATE`)
      const postRow = post.rows[0]
      if (!postRow) {
        if (!active && kind === 'favorite') return { postId, favorited: false, favoriteCount: 0 }
        throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      }
      if (active) await db.execute(sql`INSERT INTO ${sql.raw(table)} (post_id, actor_id) VALUES (${asNumber(postRow.id)}, ${context.user.id}) ON CONFLICT (actor_id, post_id) DO NOTHING`)
      else await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE post_id = ${asNumber(postRow.id)} AND actor_id = ${context.user.id}`)
      const count = await db.execute(sql`SELECT COUNT(*)::int AS count FROM ${sql.raw(table)} WHERE post_id = ${asNumber(postRow.id)}`)
      const nextCount = asNumber(count.rows[0]?.count ?? 0)
      await db.execute(sql`UPDATE community_posts SET ${sql.raw(column)} = ${nextCount}, updated_at = NOW() WHERE id = ${asNumber(postRow.id)}`)
      return kind === 'like'
        ? { postId, liked: active, likeCount: nextCount }
        : { postId, favorited: active, favoriteCount: nextCount }
    },
  })
}

export const reportCommunityPost = async (context: ActiveSessionContext, postId: string, bodyValue: unknown, keySha256: string) => {
  parsePostId(postId)
  const body = parseBody(bodyValue)
  const reason = parseReportReason(body.reason)
  const details = body.details === undefined || body.details === null ? null : requiredText(body.details, 1000, '举报说明过长。')
  return withIdempotentWrite(context, {
    route: `POST /api/v1/community/${postId}/report`, keySha256, requestSha256: stableStringify({ postId, reason, details }), responseStatus: 201,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const post = await db.execute(sql`SELECT id, public_id FROM community_posts WHERE public_id = ${postId} AND status = 'published'`)
      if (!post.rows[0]) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区图纸不存在。', 404)
      // Legacy community reports did not have a database uniqueness rule. A
      // scoped advisory lock gives new submissions durable deduplication
      // without discarding historical duplicate reports during migration.
      const postDbId = asNumber(post.rows[0].id)
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.user.id}:${postDbId}:${reason}`}, 0))`)
      const existing = await db.execute(sql`SELECT public_id, status FROM community_reports
        WHERE reporter_id = ${context.user.id} AND post_id = ${postDbId} AND reason = ${reason}
        ORDER BY id ASC LIMIT 1`)
      const reportId = toId('community_report')
      const report = existing.rows[0] ?? (await db.execute(sql`INSERT INTO community_reports
        (public_id, post_id, post_public_id, reporter_id, reason, details)
        VALUES (${reportId}, ${postDbId}, ${postId}, ${context.user.id}, ${reason}, ${details})
        RETURNING public_id, status`)).rows[0]
      if (!report) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      await recordAuthenticatedAuditEvent(context, { action: 'community.reported', outcome: 'allowed', resourcePublicId: postId, resourceType: 'community', route: `POST /api/v1/community/${postId}/report` })
      return { reportId: asString(report.public_id), status: asString(report.status) }
    },
  })
}
