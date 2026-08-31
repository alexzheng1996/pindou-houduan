// 文件开头说明：M2.2 社区治理服务只读取社区帖子、冻结快照、社区媒体、举报、
// 用户主动填写的社区资料和运营档案。公开作者投影额外读取 users.image
// 及 published 帖子聚合统计；所有查询均显式投影，绝不读取私密 Work、邮箱、
// 原图或 storageKey；媒体字节只能经受控路由返回。
import { createHash, randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'

import { BusinessApiError, stableStringify } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import type { CommunityOperatorSessionContext } from '@/auth/require-community-operator-session'
import { hasRole } from '@/collections/Users'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { getObjectStore } from '@/storage'
import { ObjectStoreNotFoundError, ObjectStoreUnavailableError } from '@/storage/object-store'
import { withIdempotentWrite } from '@/works/idempotency'

type DatabaseRow = Record<string, unknown>
type QueryResult = { rows: DatabaseRow[] }
type Database = { execute: (query: unknown) => Promise<QueryResult> }
type Pool = { query: (query: string, parameters?: readonly unknown[]) => Promise<QueryResult> }
type PostStatus = 'published' | 'withdrawn' | 'takedown' | 'deleted'
type ReportStatus = 'pending' | 'reviewing' | 'resolved' | 'rejected'
type SocialVisibility = 'public' | 'hidden'
type WatchlistStatus = 'none' | 'watching' | 'paused'

const postIdPattern = /^community_post_[a-f0-9]{32}$/
const reportIdPattern = /^community_report_[a-f0-9]{32}$/
const mediaIdPattern = /^community_media_[a-f0-9]{32}$/
const creatorIdPattern = /^creator_[a-f0-9]{32}$/
const postStatuses = new Set<PostStatus>(['published', 'withdrawn', 'takedown', 'deleted'])
const reportStatuses = new Set<ReportStatus>(['pending', 'reviewing', 'resolved', 'rejected'])
const reportReasons = new Set(['copyright', 'adult_violence', 'harassment', 'spam', 'privacy'])
const socialPlatforms = new Set(['instagram', 'tiktok', 'youtube', 'pinterest', 'facebook', 'x', 'reddit', 'linkedin'])
const socialHosts: Record<string, string[]> = {
  instagram: ['instagram.com'],
  tiktok: ['tiktok.com'],
  youtube: ['youtube.com'],
  pinterest: ['pinterest.com'],
  facebook: ['facebook.com'],
  x: ['x.com'],
  reddit: ['reddit.com'],
  linkedin: ['linkedin.com'],
}

const toPublicId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`
const creatorPublicId = (userId: number): string => `creator_${createHash('md5').update(`m22:${userId}`).digest('hex')}`
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return value
}
const asNumber = (value: unknown): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(number)) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return number
}
const dateValue = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}
const toBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}
const getPool = (context: Pick<CommunityOperatorSessionContext, 'payload'>): Pool => {
  const pool = (context.payload.db as unknown as { pool?: Pool }).pool
  if (!pool) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return pool
}
const getDatabase = async (context: CommunityOperatorSessionContext): Promise<Database> => {
  const transactionId = await context.req.transactionID
  const db = transactionId ? context.payload.db.sessions?.[transactionId]?.db : context.payload.db.drizzle
  if (!db) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  return db as Database
}
const parseBody = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '请求体无效。', 422)
  return value
}
const text = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== 'string') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', `${label}无效。`, 422)
  const result = value.trim()
  if (!result || Array.from(result).length > maximum) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', `${label}无效。`, 422)
  return result
}
const optionalText = (value: unknown, maximum: number, label: string): string | null => {
  if (value === null || value === undefined || value === '') return null
  return text(value, maximum, label)
}
const expectedVersion = (value: unknown): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', 'expectedVersion 无效。', 422)
  }
  return value as number
}
const parsePostId = (value: string): void => {
  if (!postIdPattern.test(value)) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
}
const parseReportId = (value: string): void => {
  if (!reportIdPattern.test(value)) throw new BusinessApiError('COMMUNITY_REPORT_NOT_FOUND', '举报不存在。', 404)
}
const parseCreatorId = (value: string): void => {
  if (!creatorIdPattern.test(value)) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
}
const parseWindow = (searchParams: URLSearchParams): { limit: number; offset: number } => {
  const rawLimit = searchParams.get('limit')
  const requested = rawLimit ? Number(rawLimit) : 24
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 24
  const cursor = searchParams.get('cursor')
  if (!cursor) return { limit, offset: 0 }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown }
    if (!Number.isSafeInteger(decoded.offset) || (decoded.offset as number) < 0) throw new Error('invalid')
    return { limit, offset: decoded.offset as number }
  } catch {
    throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '分页游标无效。', 422)
  }
}
const encodeCursor = (offset: number): string => Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url')
const parseStatuses = (value: string | null): PostStatus[] => {
  if (!value) return ['published', 'withdrawn', 'takedown', 'deleted']
  const statuses = value.split(',').map((item) => item.trim()).filter(Boolean)
  if (!statuses.length || statuses.some((item) => !postStatuses.has(item as PostStatus))) {
    throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '内容状态筛选无效。', 422)
  }
  return [...new Set(statuses)] as PostStatus[]
}
const parseDate = (value: unknown, label: string, required = false): string | null => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', `${label}不能为空。`, 422)
    return null
  }
  if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
    throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', `${label}无效。`, 422)
  }
  return new Date(value).toISOString()
}
const isAdmin = (context: CommunityOperatorSessionContext): boolean => hasRole(context.user, 'admin')

const mediaProjection = (row: DatabaseRow, admin = false) => ({
  mediaId: asString(row.public_id),
  role: asString(row.role),
  sortOrder: asNumber(row.sort_order),
  mimeType: asString(row.mime_type),
  sizeBytes: asNumber(row.size_bytes),
  altText: row.alt_text === null ? null : asString(row.alt_text),
  status: asString(row.status),
  availability: asString(row.status) === 'ready' ? 'available' : 'purged',
  ...(admin && asString(row.status) === 'ready' ? { previewUrl: `/api/v1/admin/community/media/${encodeURIComponent(asString(row.public_id))}` } : {}),
})

const postSummary = (row: DatabaseRow) => {
  const status = asString(row.status) as PostStatus
  const featured = toBoolean(row.is_featured)
  return {
    postId: asString(row.public_id),
    author: { creatorId: row.creator_public_id === null ? null : asString(row.creator_public_id), displayName: asString(row.author_name_snapshot || 'PixoMosaic 用户') },
    title: asString(row.title),
    category: asString(row.category),
    tags: Array.isArray(row.tags) ? row.tags : [],
    status,
    isFeatured: featured,
    shareable: status === 'published',
    indexable: status === 'published' && featured,
    reportCount: asNumber(row.report_count ?? 0),
    unresolvedHighRiskReportCount: asNumber(row.high_risk_report_count ?? 0),
    moderationVersion: asNumber(row.moderation_version),
    publishedAt: dateValue(row.published_at),
    withdrawnAt: dateValue(row.withdrawn_at),
    takedownAt: dateValue(row.takedown_at),
    deletedAt: dateValue(row.deleted_at),
    moderationUpdatedAt: dateValue(row.moderation_updated_at),
  }
}

const creatorProjection = (row: DatabaseRow, socialLinks: DatabaseRow[] = [], notes: DatabaseRow[] = []) => ({
  creatorId: asString(row.creator_public_id ?? row.public_id),
  ...(row.avatar_url !== undefined ? { avatarUrl: row.avatar_url === null ? null : asString(row.avatar_url) } : {}),
  displayName: row.display_name === null || row.display_name === undefined ? null : asString(row.display_name),
  bio: row.bio === null || row.bio === undefined ? null : asString(row.bio),
  createdAt: dateValue(row.creator_created_at ?? row.created_at),
  updatedAt: dateValue(row.creator_updated_at ?? row.updated_at),
  socialLinks: socialLinks.map((link) => ({
    platform: asString(link.platform),
    url: asString(link.url),
    visibility: asString(link.visibility) as SocialVisibility,
    visibilityLabel: asString(link.visibility) === 'hidden' ? '隐藏' : '公开',
    updatedAt: dateValue(link.updated_at),
  })),
  ...(row.published_like_count !== undefined || row.published_favorite_count !== undefined ? {
    stats: { likeCount: asNumber(row.published_like_count ?? 0), favoriteCount: asNumber(row.published_favorite_count ?? 0) },
  } : {}),
  operations: row.watchlist_status === undefined ? undefined : {
    watchlistStatus: asString(row.watchlist_status) as WatchlistStatus,
    watchReason: row.watch_reason === null ? null : asString(row.watch_reason),
    ownerStaffId: row.owner_staff_id === null ? null : asNumber(row.owner_staff_id),
    reviewAt: dateValue(row.review_at),
    version: asNumber(row.ops_version),
    notes: notes.map((note) => ({
      noteId: asString(note.public_id),
      body: asString(note.body),
      tags: Array.isArray(note.tags) ? note.tags : [],
      authorId: asNumber(note.author_id),
      expiresAt: dateValue(note.expires_at),
      archivedAt: dateValue(note.archived_at),
      createdAt: dateValue(note.created_at),
      updatedAt: dateValue(note.updated_at),
    })),
  },
})

const ensureCreatorProfile = async (db: Database, userId: number): Promise<void> => {
  await db.execute(sql`INSERT INTO community_creator_profiles (public_id, owner_id)
    VALUES (${creatorPublicId(userId)}, ${userId}) ON CONFLICT (owner_id) DO NOTHING`)
}

const findCreator = async (db: Database, creatorId: string, forUpdate = false): Promise<DatabaseRow> => {
  parseCreatorId(creatorId)
  const result = await db.execute(sql`SELECT id, public_id, owner_id, display_name, bio, created_at AS creator_created_at, updated_at AS creator_updated_at
    FROM community_creator_profiles WHERE public_id = ${creatorId}${forUpdate ? sql` FOR UPDATE` : sql``}`)
  const row = result.rows[0]
  if (!row) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
  return row
}

const socialLinksForProfile = async (pool: Pool, profileId: number, publicOnly = false): Promise<DatabaseRow[]> => {
  const result = await pool.query(
    `SELECT platform, url, visibility, updated_at
     FROM community_social_links WHERE profile_id = $1${publicOnly ? " AND visibility = 'public'" : ''}
     ORDER BY platform ASC`,
    [profileId],
  )
  return result.rows
}

const notesForUser = async (pool: Pool, userId: number): Promise<DatabaseRow[]> => {
  const result = await pool.query(
    `SELECT public_id, body, tags, author_id, expires_at, archived_at, created_at, updated_at
     FROM community_user_ops_notes WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
    [userId],
  )
  return result.rows
}

const hasUnresolvedHighRiskReport = async (db: Database, postDbId: number): Promise<boolean> => {
  const result = await db.execute(sql`SELECT 1 FROM community_reports
    WHERE post_id = ${postDbId} AND status IN ('pending', 'reviewing') AND reason IN ('copyright', 'privacy') LIMIT 1`)
  return Boolean(result.rows[0])
}

const addModerationAction = async (
  db: Database,
  context: CommunityOperatorSessionContext,
  input: {
    action: 'featured' | 'unfeatured' | 'takedown' | 'restored' | 'deleted' | 'report_resolved' | 'report_rejected' | 'note_created' | 'watchlist_updated'
    afterState: Record<string, unknown>
    beforeState: Record<string, unknown>
    notificationResult?: string | null
    reasonCode?: string | null
    reasonText?: string | null
    reportPublicId?: string | null
    targetPublicId: string
    targetType: 'post' | 'report' | 'user'
  },
): Promise<void> => {
  await db.execute(sql`INSERT INTO community_moderation_actions
    (public_id, target_type, target_public_id, actor_id, action, reason_code, reason_text, before_state, after_state, report_public_id, request_id, notification_result)
    VALUES (${toPublicId('community_action')}, ${input.targetType}, ${input.targetPublicId}, ${context.user.id}, ${input.action},
      ${input.reasonCode ?? null}, ${input.reasonText ?? null}, ${JSON.stringify(input.beforeState)}::jsonb,
      ${JSON.stringify(input.afterState)}::jsonb, ${input.reportPublicId ?? null}, ${context.requestId}, ${input.notificationResult ?? null})`)
}

const recordModerationAudit = async (context: CommunityOperatorSessionContext, route: string, resourcePublicId: string, reasonCode?: string): Promise<void> => {
  await recordAuthenticatedAuditEvent(context, {
    action: 'community.moderated', outcome: 'allowed', resourcePublicId, resourceType: 'community', route, reasonCode,
  })
}

export const listModerationPosts = async (context: CommunityOperatorSessionContext, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const statuses = parseStatuses(searchParams.get('status'))
  const query = (searchParams.get('q') ?? '').trim().slice(0, 120)
  const authorId = searchParams.get('authorId')?.trim() ?? ''
  if (authorId && !creatorIdPattern.test(authorId)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '作者筛选无效。', 422)
  const reportStatus = searchParams.get('reportStatus')
  if (reportStatus && !reportStatuses.has(reportStatus as ReportStatus)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '举报状态筛选无效。', 422)
  const featuredRaw = searchParams.get('isFeatured')
  if (featuredRaw && featuredRaw !== 'true' && featuredRaw !== 'false') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '精选筛选无效。', 422)
  const { limit, offset } = parseWindow(searchParams)
  const result = await getPool(context).query(
    `SELECT p.public_id, p.title, p.category, p.tags, p.status, p.is_featured, p.moderation_version,
        p.author_name_snapshot, p.published_at, p.withdrawn_at, p.takedown_at, p.deleted_at, p.moderation_updated_at,
        cp.public_id AS creator_public_id,
        (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id) AS report_count,
        (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id AND r.status IN ('pending', 'reviewing') AND r.reason IN ('copyright', 'privacy')) AS high_risk_report_count
     FROM community_posts p LEFT JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
     WHERE p.status::text = ANY($1::text[])
       AND ($2 = '' OR cp.public_id = $2)
       AND ($3 = '' OR p.title ILIKE '%' || $3 || '%' OR p.tags::text ILIKE '%' || $3 || '%')
       AND ($4 = '' OR EXISTS (SELECT 1 FROM community_reports r WHERE r.post_id = p.id AND r.status::text = $4))
       AND ($5::text IS NULL OR p.is_featured = $5::boolean)
     ORDER BY COALESCE(p.moderation_updated_at, p.updated_at) DESC, p.id DESC LIMIT $6 OFFSET $7`,
    [statuses, authorId, query, reportStatus ?? '', featuredRaw, limit + 1, offset],
  )
  const rows = result.rows.slice(0, limit)
  return { posts: rows.map(postSummary), nextCursor: result.rows.length > limit ? encodeCursor(offset + limit) : null }
}

export const getModerationPost = async (context: CommunityOperatorSessionContext, postId: string): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  const pool = getPool(context)
  const result = await pool.query(
    `SELECT p.id AS db_post_id, p.public_id, p.title, p.category, p.tags, p.status, p.is_featured, p.moderation_version,
        p.author_name_snapshot, p.copyright_confirmed, p.allow_copy, p.like_count, p.favorite_count,
        p.published_at, p.withdrawn_at, p.takedown_at, p.deleted_at, p.moderation_updated_at,
        p.featured_at, p.featured_reason, v.public_id AS version_public_id, v.version_number, v.kind, v.document,
        v.document_sha256, v.document_byte_size, v.bead_size_mm, v.grid_columns, v.grid_rows, v.color_count, v.total_bead_count, v.difficulty, v.created_at AS version_created_at,
        cp.id AS profile_id, cp.public_id AS creator_public_id, cp.display_name, cp.bio, cp.created_at AS creator_created_at, cp.updated_at AS creator_updated_at,
        (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id) AS report_count,
        (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id AND r.status IN ('pending', 'reviewing') AND r.reason IN ('copyright', 'privacy')) AS high_risk_report_count
     FROM community_posts p
     LEFT JOIN published_pattern_versions v ON v.id = p.current_version_id
     LEFT JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
     WHERE p.public_id = $1`, [postId],
  )
  const row = result.rows[0]
  if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
  const [media, reports, actions, socialLinks] = await Promise.all([
    pool.query(`SELECT public_id, role, sort_order, mime_type, size_bytes, alt_text, status FROM community_post_media WHERE post_id = $1 ORDER BY sort_order ASC, id ASC`, [asNumber(row.db_post_id)]),
    pool.query(`SELECT public_id, reason, details, status, version, handled_at, decision_reason_code, notification_result, created_at, updated_at FROM community_reports WHERE post_id = $1 ORDER BY created_at DESC, id DESC`, [asNumber(row.db_post_id)]),
    pool.query(`SELECT public_id, target_type, target_public_id, actor_id, action, reason_code, reason_text, before_state, after_state, report_public_id, notification_result, created_at FROM community_moderation_actions WHERE target_public_id = $1 OR report_public_id IN (SELECT public_id FROM community_reports WHERE post_id = $2) ORDER BY created_at DESC, id DESC`, [postId, asNumber(row.db_post_id)]),
    row.profile_id === null ? Promise.resolve([] as DatabaseRow[]) : socialLinksForProfile(pool, asNumber(row.profile_id)),
  ])
  const summary = postSummary(row)
  return {
    post: {
      ...summary,
      copyrightConfirmed: Boolean(row.copyright_confirmed),
      allowCopy: Boolean(row.allow_copy),
      stats: { likeCount: asNumber(row.like_count), favoriteCount: asNumber(row.favorite_count) },
      featuredAt: dateValue(row.featured_at),
      featuredReason: row.featured_reason === null ? null : asString(row.featured_reason),
      media: media.rows.map((item) => mediaProjection(item, true)),
      frozenVersion: row.version_public_id === null ? { availability: 'purged' } : {
        versionId: asString(row.version_public_id), versionNumber: asNumber(row.version_number), kind: asString(row.kind),
        document: row.document, documentSha256: asString(row.document_sha256), documentByteSize: asNumber(row.document_byte_size),
        beadSizeMm: row.bead_size_mm === null ? null : Number(row.bead_size_mm), gridColumns: asNumber(row.grid_columns), gridRows: asNumber(row.grid_rows),
        colorCount: asNumber(row.color_count), totalBeadCount: asNumber(row.total_bead_count), difficulty: asString(row.difficulty), createdAt: dateValue(row.version_created_at),
      },
      authorProfile: row.creator_public_id === null ? null : creatorProjection(row, socialLinks),
      reports: reports.rows.map((report) => ({
        reportId: asString(report.public_id), reason: asString(report.reason), details: report.details === null ? null : asString(report.details),
        status: asString(report.status), version: asNumber(report.version), handledAt: dateValue(report.handled_at),
        decisionReasonCode: report.decision_reason_code === null ? null : asString(report.decision_reason_code), notificationResult: report.notification_result === null ? null : asString(report.notification_result),
        createdAt: dateValue(report.created_at), updatedAt: dateValue(report.updated_at),
      })),
      moderationActions: actions.rows.map((action) => ({
        actionId: asString(action.public_id), targetType: asString(action.target_type), targetPublicId: asString(action.target_public_id), actorId: asNumber(action.actor_id),
        action: asString(action.action), reasonCode: action.reason_code === null ? null : asString(action.reason_code), reasonText: action.reason_text === null ? null : asString(action.reason_text),
        beforeState: action.before_state, afterState: action.after_state, reportId: action.report_public_id === null ? null : asString(action.report_public_id),
        notificationResult: action.notification_result === null ? null : asString(action.notification_result), createdAt: dateValue(action.created_at),
      })),
    },
  }
}

export const getModerationCreator = async (context: CommunityOperatorSessionContext, creatorId: string): Promise<Record<string, unknown>> => {
  parseCreatorId(creatorId)
  const pool = getPool(context)
  const result = await pool.query(
    `SELECT cp.id AS profile_id, cp.public_id AS creator_public_id, cp.owner_id, cp.display_name, cp.bio, cp.created_at AS creator_created_at, cp.updated_at AS creator_updated_at,
        COALESCE(op.watchlist_status::text, 'none') AS watchlist_status, op.watch_reason, op.owner_staff_id, op.review_at, COALESCE(op.version, 1) AS ops_version,
        COUNT(p.id)::int AS post_count,
        COUNT(p.id) FILTER (WHERE p.status = 'published')::int AS published_count,
        COUNT(p.id) FILTER (WHERE p.status = 'withdrawn')::int AS withdrawn_count,
        COUNT(p.id) FILTER (WHERE p.status = 'takedown')::int AS takedown_count,
        COUNT(p.id) FILTER (WHERE p.status = 'deleted')::int AS deleted_count
     FROM community_creator_profiles cp
     LEFT JOIN community_user_ops_profiles op ON op.user_id = cp.owner_id
     LEFT JOIN community_posts p ON p.owner_id = cp.owner_id
     WHERE cp.public_id = $1
     GROUP BY cp.id, op.id`, [creatorId],
  )
  const row = result.rows[0]
  if (!row) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
  const [links, notes, aggregates] = await Promise.all([
    socialLinksForProfile(pool, asNumber(row.profile_id)),
    notesForUser(pool, asNumber(row.owner_id)),
    pool.query(`SELECT COUNT(*)::int AS report_count, COUNT(*) FILTER (WHERE r.status IN ('pending', 'reviewing'))::int AS unresolved_report_count
      FROM community_reports r JOIN community_posts p ON p.id = r.post_id WHERE p.owner_id = $1`, [asNumber(row.owner_id)]),
  ])
  return {
    creator: creatorProjection(row, links, notes),
    postCounts: { total: asNumber(row.post_count), published: asNumber(row.published_count), withdrawn: asNumber(row.withdrawn_count), takedown: asNumber(row.takedown_count), deleted: asNumber(row.deleted_count) },
    reportSummary: { total: asNumber(aggregates.rows[0]?.report_count ?? 0), unresolved: asNumber(aggregates.rows[0]?.unresolved_report_count ?? 0) },
  }
}

export const listModerationCreatorPosts = async (context: CommunityOperatorSessionContext, creatorId: string, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  parseCreatorId(creatorId)
  const statuses = parseStatuses(searchParams.get('status'))
  const { limit, offset } = parseWindow(searchParams)
  const result = await getPool(context).query(
    `SELECT p.public_id, p.title, p.category, p.tags, p.status, p.is_featured, p.moderation_version, p.author_name_snapshot,
       p.published_at, p.withdrawn_at, p.takedown_at, p.deleted_at, p.moderation_updated_at, cp.public_id AS creator_public_id,
       (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id) AS report_count,
       (SELECT COUNT(*)::int FROM community_reports r WHERE r.post_id = p.id AND r.status IN ('pending', 'reviewing') AND r.reason IN ('copyright', 'privacy')) AS high_risk_report_count
     FROM community_posts p JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
     WHERE cp.public_id = $1 AND p.status::text = ANY($2::text[])
     ORDER BY COALESCE(p.moderation_updated_at, p.updated_at) DESC, p.id DESC LIMIT $3 OFFSET $4`,
    [creatorId, statuses, limit + 1, offset],
  )
  const rows = result.rows.slice(0, limit)
  return { posts: rows.map(postSummary), nextCursor: result.rows.length > limit ? encodeCursor(offset + limit) : null }
}

export const listModerationReports = async (context: CommunityOperatorSessionContext, searchParams: URLSearchParams): Promise<Record<string, unknown>> => {
  const status = searchParams.get('status')
  if (status && !reportStatuses.has(status as ReportStatus)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '举报状态筛选无效。', 422)
  const reason = searchParams.get('reason')
  if (reason && !reportReasons.has(reason)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '举报理由筛选无效。', 422)
  const postId = searchParams.get('postId')?.trim() ?? ''
  if (postId && !postIdPattern.test(postId)) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '帖子筛选无效。', 422)
  const { limit, offset } = parseWindow(searchParams)
  const result = await getPool(context).query(
    `SELECT r.public_id, r.post_public_id, r.reason, r.details, r.status, r.version, r.handled_at, r.decision_reason_code, r.notification_result, r.created_at, r.updated_at,
      p.title AS post_title, p.status AS post_status, cp.public_id AS creator_public_id
     FROM community_reports r JOIN community_posts p ON p.id = r.post_id
     LEFT JOIN community_creator_profiles cp ON cp.owner_id = p.owner_id
     WHERE ($1 = '' OR r.status::text = $1) AND ($2 = '' OR r.reason::text = $2) AND ($3 = '' OR r.post_public_id = $3)
     ORDER BY CASE WHEN r.reason IN ('copyright', 'privacy') AND r.status IN ('pending', 'reviewing') THEN 0 ELSE 1 END, r.created_at ASC, r.id ASC
     LIMIT $4 OFFSET $5`, [status ?? '', reason ?? '', postId, limit + 1, offset],
  )
  const rows = result.rows.slice(0, limit)
  return {
    reports: rows.map((report) => ({
      reportId: asString(report.public_id), postId: asString(report.post_public_id), postTitle: asString(report.post_title), postStatus: asString(report.post_status),
      creatorId: report.creator_public_id === null ? null : asString(report.creator_public_id), reason: asString(report.reason),
      details: report.details === null ? null : asString(report.details), status: asString(report.status), version: asNumber(report.version),
      handledAt: dateValue(report.handled_at), decisionReasonCode: report.decision_reason_code === null ? null : asString(report.decision_reason_code),
      notificationResult: report.notification_result === null ? null : asString(report.notification_result), createdAt: dateValue(report.created_at), updatedAt: dateValue(report.updated_at),
    })),
    nextCursor: result.rows.length > limit ? encodeCursor(offset + limit) : null,
  }
}

const postState = (row: DatabaseRow) => ({ status: asString(row.status), isFeatured: toBoolean(row.is_featured), moderationVersion: asNumber(row.moderation_version) })

export const featureModerationPost = async (context: CommunityOperatorSessionContext, postId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  const body = parseBody(bodyValue)
  if (typeof body.featured !== 'boolean') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', 'featured 必须是布尔值。', 422)
  const reason = text(body.reason, 1000, '精选理由')
  const version = expectedVersion(body.expectedVersion)
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/posts/${postId}/feature`, keySha256, requestSha256: stableStringify({ featured: body.featured, reason, expectedVersion: version }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT id, public_id, status, is_featured, moderation_version FROM community_posts WHERE public_id = ${postId} FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
      if (asNumber(row.moderation_version) !== version) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '社区内容已被其他运营人员更新。', 409)
      if (asString(row.status) !== 'published') throw new BusinessApiError('COMMUNITY_FEATURE_STATE_INVALID', '只有公开内容可以设置精选。', 409)
      if (body.featured && await hasUnresolvedHighRiskReport(db, asNumber(row.id))) {
        throw new BusinessApiError('COMMUNITY_FEATURE_BLOCKED_BY_REPORT', '存在待处理的版权或隐私举报，暂不能设为精选。', 409)
      }
      const before = postState(row)
      const nextVersion = version + 1
      const updated = await db.execute(sql`UPDATE community_posts SET is_featured = ${body.featured},
        featured_at = CASE WHEN ${body.featured} THEN NOW() ELSE NULL END,
        featured_by_id = CASE WHEN ${body.featured} THEN ${context.user.id}::integer ELSE NULL END,
        featured_reason = CASE WHEN ${body.featured} THEN ${reason} ELSE NULL END,
        moderation_version = ${nextVersion}, moderation_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${asNumber(row.id)} RETURNING status, is_featured, moderation_version`)
      const after = postState(updated.rows[0]!)
      await addModerationAction(db, context, { action: body.featured ? 'featured' : 'unfeatured', targetType: 'post', targetPublicId: postId, reasonText: reason, beforeState: before, afterState: after })
      await recordModerationAudit(context, `POST /api/v1/admin/community/posts/:id/feature`, postId)
      return { postId, ...after, shareable: true, indexable: Boolean(body.featured) }
    },
  })
}

const parseModerationReason = (body: Record<string, unknown>) => ({
  reasonCode: optionalText(body.reasonCode, 80, '原因代码') ?? 'other',
  reason: text(body.reason, 1000, '治理理由'),
  expectedVersion: expectedVersion(body.expectedVersion),
  notifyAuthor: body.notifyAuthor === undefined ? false : body.notifyAuthor,
})

const notificationResult = (notify: unknown): string => {
  if (typeof notify !== 'boolean') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '通知选项无效。', 422)
  return notify ? 'not_configured' : 'not_requested'
}

export const takedownModerationPost = async (context: CommunityOperatorSessionContext, postId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  const input = parseModerationReason(parseBody(bodyValue))
  const notice = notificationResult(input.notifyAuthor)
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/posts/${postId}/takedown`, keySha256, requestSha256: stableStringify({ ...input, notificationResult: notice }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT id, public_id, status, is_featured, moderation_version FROM community_posts WHERE public_id = ${postId} FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
      if (asNumber(row.moderation_version) !== input.expectedVersion) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '社区内容已被其他运营人员更新。', 409)
      if (asString(row.status) !== 'published') throw new BusinessApiError('COMMUNITY_TAKEDOWN_STATE_INVALID', '当前内容不能下架。', 409)
      const before = postState(row)
      const updated = await db.execute(sql`UPDATE community_posts SET status = 'takedown', is_featured = false, featured_at = NULL, featured_by_id = NULL, featured_reason = NULL,
        takedown_at = NOW(), moderation_version = ${input.expectedVersion + 1}, moderation_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${asNumber(row.id)} RETURNING status, is_featured, moderation_version`)
      const after = postState(updated.rows[0]!)
      await addModerationAction(db, context, { action: 'takedown', targetType: 'post', targetPublicId: postId, reasonCode: input.reasonCode, reasonText: input.reason, beforeState: before, afterState: after, notificationResult: notice })
      await recordModerationAudit(context, 'POST /api/v1/admin/community/posts/:id/takedown', postId, input.reasonCode)
      return { postId, ...after, shareable: false, indexable: false, notificationResult: notice }
    },
  })
}

export const restoreModerationPost = async (context: CommunityOperatorSessionContext, postId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  const body = parseBody(bodyValue)
  const reason = text(body.reason, 1000, '恢复理由')
  const version = expectedVersion(body.expectedVersion)
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/posts/${postId}/restore`, keySha256, requestSha256: stableStringify({ reason, expectedVersion: version }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT id, public_id, status, is_featured, moderation_version FROM community_posts WHERE public_id = ${postId} FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
      if (asNumber(row.moderation_version) !== version) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '社区内容已被其他运营人员更新。', 409)
      if (asString(row.status) !== 'takedown') throw new BusinessApiError('COMMUNITY_TAKEDOWN_STATE_INVALID', '当前内容不能恢复。', 409)
      if (await hasUnresolvedHighRiskReport(db, asNumber(row.id))) throw new BusinessApiError('COMMUNITY_RESTORE_BLOCKED_BY_REPORT', '存在待处理的版权或隐私举报，暂不能恢复。', 409)
      const before = postState(row)
      const updated = await db.execute(sql`UPDATE community_posts SET status = 'published', is_featured = false, featured_at = NULL, featured_by_id = NULL, featured_reason = NULL,
        moderation_version = ${version + 1}, moderation_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${asNumber(row.id)} RETURNING status, is_featured, moderation_version`)
      const after = postState(updated.rows[0]!)
      await addModerationAction(db, context, { action: 'restored', targetType: 'post', targetPublicId: postId, reasonText: reason, beforeState: before, afterState: after })
      await recordModerationAudit(context, 'POST /api/v1/admin/community/posts/:id/restore', postId)
      return { postId, ...after, shareable: true, indexable: false }
    },
  })
}

export const deleteModerationPost = async (context: CommunityOperatorSessionContext, postId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parsePostId(postId)
  if (!isAdmin(context)) throw new BusinessApiError('COMMUNITY_MODERATION_FORBIDDEN', '只有 Admin 可以删除社区内容。', 403)
  const body = parseBody(bodyValue)
  if (body.confirm !== 'DELETE') throw new BusinessApiError('COMMUNITY_DELETE_CONFIRMATION_REQUIRED', '删除需要确认字段。', 422)
  const reason = text(body.reason, 1000, '删除理由')
  const version = expectedVersion(body.expectedVersion)
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/posts/${postId}/delete`, keySha256, requestSha256: stableStringify({ confirm: 'DELETE', reason, expectedVersion: version }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT id, public_id, status, is_featured, moderation_version FROM community_posts WHERE public_id = ${postId} FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_POST_NOT_FOUND', '社区内容不存在。', 404)
      if (asNumber(row.moderation_version) !== version) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '社区内容已被其他运营人员更新。', 409)
      if (asString(row.status) === 'deleted') throw new BusinessApiError('COMMUNITY_TAKEDOWN_STATE_INVALID', '内容已删除。', 409)
      const before = postState(row)
      const updated = await db.execute(sql`UPDATE community_posts SET status = 'deleted', is_featured = false, featured_at = NULL, featured_by_id = NULL, featured_reason = NULL,
        deleted_at = NOW(), moderation_version = ${version + 1}, moderation_updated_at = NOW(), updated_at = NOW()
        WHERE id = ${asNumber(row.id)} RETURNING status, is_featured, moderation_version`)
      const after = postState(updated.rows[0]!)
      await addModerationAction(db, context, { action: 'deleted', targetType: 'post', targetPublicId: postId, reasonText: reason, beforeState: before, afterState: after })
      await recordModerationAudit(context, 'POST /api/v1/admin/community/posts/:id/delete', postId)
      return { postId, ...after, shareable: false, indexable: false }
    },
  })
}

export const resolveModerationReport = async (context: CommunityOperatorSessionContext, reportId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parseReportId(reportId)
  const body = parseBody(bodyValue)
  if (body.decision !== 'resolved' && body.decision !== 'rejected') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '举报结论无效。', 422)
  const decision = body.decision as 'resolved' | 'rejected'
  const reasonCode = text(body.reasonCode, 80, '结论代码')
  const internalNote = optionalText(body.internalNote, 2000, '内部说明')
  const version = expectedVersion(body.expectedVersion)
  const notifyAuthor = body.notifyAuthor === undefined ? false : body.notifyAuthor
  const notifyReporter = body.notifyReporter === undefined ? false : body.notifyReporter
  const noticeAuthor = notificationResult(notifyAuthor)
  const noticeReporter = notificationResult(notifyReporter)
  const notice = `${noticeAuthor}/${noticeReporter}`
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/reports/${reportId}/resolve`, keySha256,
    requestSha256: stableStringify({ decision, reasonCode, internalNote, expectedVersion: version, notifyAuthor, notifyReporter }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`SELECT public_id, post_public_id, status, version FROM community_reports WHERE public_id = ${reportId} FOR UPDATE`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('COMMUNITY_REPORT_NOT_FOUND', '举报不存在。', 404)
      if (asNumber(row.version) !== version) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '举报已被其他运营人员更新。', 409)
      if (asString(row.status) === 'resolved' || asString(row.status) === 'rejected') throw new BusinessApiError('COMMUNITY_REPORT_STATE_INVALID', '举报已处理。', 409)
      const before = { status: asString(row.status), version: asNumber(row.version) }
      const updated = await db.execute(sql`UPDATE community_reports SET status = ${decision}, version = ${version + 1}, handled_by_id = ${context.user.id}, handled_at = NOW(),
        decision_reason_code = ${reasonCode}, internal_note = ${internalNote}, notify_author = ${notifyAuthor}, notify_reporter = ${notifyReporter}, notification_result = ${notice}, updated_at = NOW()
        WHERE public_id = ${reportId} RETURNING status, version`)
      const after = { status: asString(updated.rows[0]!.status), version: asNumber(updated.rows[0]!.version) }
      await addModerationAction(db, context, { action: decision === 'resolved' ? 'report_resolved' : 'report_rejected', targetType: 'report', targetPublicId: reportId, reportPublicId: reportId, reasonCode, reasonText: internalNote, beforeState: before, afterState: after, notificationResult: notice })
      await recordModerationAudit(context, 'POST /api/v1/admin/community/reports/:id/resolve', reportId, reasonCode)
      return { reportId, ...after, notificationResult: notice }
    },
  })
}

export const createModerationNote = async (context: CommunityOperatorSessionContext, creatorId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parseCreatorId(creatorId)
  const body = parseBody(bodyValue)
  const noteBody = text(body.body, 2000, '备注内容')
  const tags = body.tags === undefined ? [] : body.tags
  if (!Array.isArray(tags) || tags.length > 10 || tags.some((tag) => typeof tag !== 'string' || !tag.trim() || Array.from(tag.trim()).length > 32)) {
    throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '备注标签无效。', 422)
  }
  const expiresAt = parseDate(body.expiresAt, '备注到期时间') ?? new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString()
  return withIdempotentWrite(context, {
    route: `POST /api/v1/admin/community/users/${creatorId}/notes`, keySha256, requestSha256: stableStringify({ body: noteBody, tags, expiresAt }), responseStatus: 201,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const creator = await findCreator(db, creatorId, true)
      const noteId = toPublicId('community_note')
      await db.execute(sql`INSERT INTO community_user_ops_notes (public_id, user_id, author_id, body, tags, expires_at)
        VALUES (${noteId}, ${asNumber(creator.owner_id)}, ${context.user.id}, ${noteBody}, ${JSON.stringify(tags.map((tag) => (tag as string).trim()))}::jsonb, ${expiresAt})`)
      await addModerationAction(db, context, { action: 'note_created', targetType: 'user', targetPublicId: creatorId, reasonText: '运营备注已创建', beforeState: {}, afterState: { noteId } })
      await recordModerationAudit(context, 'POST /api/v1/admin/community/users/:id/notes', creatorId)
      return { note: { noteId, expiresAt, createdAt: new Date().toISOString() } }
    },
  })
}

export const updateModerationWatchlist = async (context: CommunityOperatorSessionContext, creatorId: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  parseCreatorId(creatorId)
  const body = parseBody(bodyValue)
  if (body.status !== 'none' && body.status !== 'watching' && body.status !== 'paused') throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '特别关注状态无效。', 422)
  const status = body.status as WatchlistStatus
  const reason = status === 'none' ? optionalText(body.reason, 1000, '特别关注理由') : text(body.reason, 1000, '特别关注理由')
  const reviewAt = status === 'none' ? null : parseDate(body.reviewAt, '复查时间', true)
  if (reviewAt && new Date(reviewAt).getTime() <= Date.now()) throw new BusinessApiError('COMMUNITY_MODERATION_INPUT_INVALID', '复查时间必须在未来。', 422)
  const version = expectedVersion(body.expectedVersion)
  return withIdempotentWrite(context, {
    route: `PATCH /api/v1/admin/community/users/${creatorId}/watchlist`, keySha256, requestSha256: stableStringify({ status, reason, reviewAt, expectedVersion: version }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const creator = await findCreator(db, creatorId, true)
      const existing = await db.execute(sql`SELECT watchlist_status, watch_reason, review_at, version FROM community_user_ops_profiles WHERE user_id = ${asNumber(creator.owner_id)} FOR UPDATE`)
      const existingRow = existing.rows[0]
      const currentVersion = existingRow ? asNumber(existingRow.version) : 1
      if (currentVersion !== version) throw new BusinessApiError('COMMUNITY_MODERATION_VERSION_CONFLICT', '特别关注已被其他运营人员更新。', 409)
      const before = existingRow ? { status: asString(existingRow.watchlist_status), reason: existingRow.watch_reason, reviewAt: dateValue(existingRow.review_at), version: currentVersion } : { status: 'none', reason: null, reviewAt: null, version: 1 }
      const nextVersion = currentVersion + 1
      const result = await db.execute(sql`INSERT INTO community_user_ops_profiles (user_id, watchlist_status, watch_reason, owner_staff_id, review_at, version)
        VALUES (${asNumber(creator.owner_id)}, ${status}, ${reason}, ${status === 'none' ? null : context.user.id}, ${reviewAt}, ${nextVersion})
        ON CONFLICT (user_id) DO UPDATE SET watchlist_status = EXCLUDED.watchlist_status, watch_reason = EXCLUDED.watch_reason,
          owner_staff_id = EXCLUDED.owner_staff_id, review_at = EXCLUDED.review_at, version = EXCLUDED.version, updated_at = NOW()
        RETURNING watchlist_status, watch_reason, owner_staff_id, review_at, version, updated_at`)
      const row = result.rows[0]!
      const after = { status: asString(row.watchlist_status), reason: row.watch_reason, reviewAt: dateValue(row.review_at), version: asNumber(row.version) }
      await addModerationAction(db, context, { action: 'watchlist_updated', targetType: 'user', targetPublicId: creatorId, reasonText: reason, beforeState: before, afterState: after })
      await recordModerationAudit(context, 'PATCH /api/v1/admin/community/users/:id/watchlist', creatorId)
      return { watchlist: { status: after.status, reason: after.reason, ownerStaffId: row.owner_staff_id === null ? null : asNumber(row.owner_staff_id), reviewAt: after.reviewAt, version: after.version, updatedAt: dateValue(row.updated_at) } }
    },
  })
}

export const readModerationCommunityMedia = async (context: CommunityOperatorSessionContext, mediaId: string): Promise<{ content: Buffer; mimeType: string }> => {
  if (!mediaIdPattern.test(mediaId)) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在。', 404)
  const result = await getPool(context).query(
    `SELECT m.storage_key, m.mime_type FROM community_post_media m JOIN community_posts p ON p.id = m.post_id
     WHERE m.public_id = $1 AND m.status = 'ready' AND p.status IN ('published', 'withdrawn', 'takedown', 'deleted')`, [mediaId],
  )
  const row = result.rows[0]
  if (!row || typeof row.storage_key !== 'string' || !row.storage_key.startsWith('community/')) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体不存在。', 404)
  try {
    return { content: await getObjectStore().read(row.storage_key), mimeType: asString(row.mime_type) }
  } catch (error) {
    if (error instanceof ObjectStoreNotFoundError) throw new BusinessApiError('COMMUNITY_MEDIA_NOT_FOUND', '社区媒体已清理。', 404)
    if (error instanceof ObjectStoreUnavailableError) throw new BusinessApiError('COMMUNITY_MEDIA_STORAGE_UNAVAILABLE', '社区媒体暂时不可用，请稍后重试。', 503)
    throw error
  }
}

const validateSocialUrl = (platform: string, value: unknown): string => {
  if (!socialPlatforms.has(platform)) throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_INVALID', '社交平台无效。', 422)
  const url = text(value, 2000, '社交链接')
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || !socialHosts[platform].some((domain) => host === domain || host.endsWith(`.${domain}`))) {
      throw new Error('invalid')
    }
    return parsed.toString()
  } catch {
    throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_INVALID', '社交链接必须是对应官方域名的 HTTPS 主页链接，且不含查询参数或凭据。', 422)
  }
}

const getOwnProfile = async (pool: Pool, userId: number): Promise<DatabaseRow | null> => {
  const result = await pool.query(`SELECT id AS profile_id, public_id AS creator_public_id, owner_id, display_name, bio, created_at AS creator_created_at, updated_at AS creator_updated_at FROM community_creator_profiles WHERE owner_id = $1`, [userId])
  return result.rows[0] ?? null
}

export const getOwnCommunityProfile = async (context: CommunityOperatorSessionContext): Promise<Record<string, unknown>> => {
  const pool = getPool(context)
  const profile = await getOwnProfile(pool, context.user.id)
  if (!profile) return { profile: { creatorId: creatorPublicId(context.user.id), displayName: null, bio: null, socialLinks: [] } }
  return { profile: creatorProjection(profile, await socialLinksForProfile(pool, asNumber(profile.profile_id))) }
}

export const updateOwnCommunityProfile = async (context: CommunityOperatorSessionContext, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  const body = parseBody(bodyValue)
  const displayName = body.displayName === undefined ? undefined : optionalText(body.displayName, 120, '显示名')
  const bio = body.bio === undefined ? undefined : optionalText(body.bio, 600, '简介')
  if (displayName === undefined && bio === undefined) throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_INVALID', '至少需要更新一个资料字段。', 422)
  return withIdempotentWrite(context, {
    route: 'PATCH /api/v1/community/profile', keySha256, requestSha256: stableStringify({ displayName, bio }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      await ensureCreatorProfile(db, context.user.id)
      const result = await db.execute(sql`UPDATE community_creator_profiles SET display_name = COALESCE(${displayName ?? null}, display_name), bio = COALESCE(${bio ?? null}, bio), updated_at = NOW()
        WHERE owner_id = ${context.user.id} RETURNING public_id, display_name, bio, created_at AS creator_created_at, updated_at AS creator_updated_at`)
      const profile = result.rows[0]!
      await recordAuthenticatedAuditEvent(context, { action: 'community.profile_updated', outcome: 'allowed', resourcePublicId: asString(profile.public_id), resourceType: 'community', route: 'PATCH /api/v1/community/profile' })
      return { profile: creatorProjection(profile) }
    },
  })
}

export const upsertOwnSocialLink = async (context: CommunityOperatorSessionContext, platform: string, bodyValue: unknown, keySha256: string): Promise<Record<string, unknown>> => {
  const body = parseBody(bodyValue)
  const url = validateSocialUrl(platform, body.url)
  if (body.visibility !== 'public' && body.visibility !== 'hidden') throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_INVALID', '社交链接可见性无效。', 422)
  const visibility = body.visibility as SocialVisibility
  return withIdempotentWrite(context, {
    route: `PUT /api/v1/community/profile/social-links/${platform}`, keySha256, requestSha256: stableStringify({ url, visibility }), responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      await ensureCreatorProfile(db, context.user.id)
      const profile = await db.execute(sql`SELECT id, public_id FROM community_creator_profiles WHERE owner_id = ${context.user.id} FOR UPDATE`)
      const profileRow = profile.rows[0]!
      const result = await db.execute(sql`INSERT INTO community_social_links (profile_id, platform, url, visibility)
        VALUES (${asNumber(profileRow.id)}, ${platform}, ${url}, ${visibility})
        ON CONFLICT (profile_id, platform) DO UPDATE SET url = EXCLUDED.url, visibility = EXCLUDED.visibility, updated_at = NOW()
        RETURNING platform, url, visibility, updated_at`)
      await recordAuthenticatedAuditEvent(context, { action: 'community.profile_updated', outcome: 'allowed', resourcePublicId: asString(profileRow.public_id), resourceType: 'community', route: 'PUT /api/v1/community/profile/social-links/:platform', reasonCode: `${platform}:${visibility}` })
      const row = result.rows[0]!
      return { socialLink: { platform: asString(row.platform), url: asString(row.url), visibility: asString(row.visibility), updatedAt: dateValue(row.updated_at) } }
    },
  })
}

export const deleteOwnSocialLink = async (context: CommunityOperatorSessionContext, platform: string, keySha256: string): Promise<Record<string, unknown>> => {
  if (!socialPlatforms.has(platform)) throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_INVALID', '社交平台无效。', 422)
  return withIdempotentWrite(context, {
    route: `DELETE /api/v1/community/profile/social-links/${platform}`, keySha256, requestSha256: platform, responseStatus: 200,
    parseStoredResponse: (value) => isRecord(value) ? value : null,
    execute: async () => {
      const db = await getDatabase(context)
      const profile = await db.execute(sql`SELECT id, public_id FROM community_creator_profiles WHERE owner_id = ${context.user.id} FOR UPDATE`)
      if (!profile.rows[0]) throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_NOT_FOUND', '社交链接不存在。', 404)
      const profileRow = profile.rows[0]
      const deleted = await db.execute(sql`DELETE FROM community_social_links WHERE profile_id = ${asNumber(profileRow.id)} AND platform = ${platform} RETURNING id`)
      if (!deleted.rows[0]) throw new BusinessApiError('COMMUNITY_SOCIAL_LINK_NOT_FOUND', '社交链接不存在。', 404)
      await recordAuthenticatedAuditEvent(context, { action: 'community.profile_updated', outcome: 'allowed', resourcePublicId: asString(profileRow.public_id), resourceType: 'community', route: 'DELETE /api/v1/community/profile/social-links/:platform', reasonCode: platform })
      return { deleted: true, platform }
    },
  })
}

export const getPublicCommunityCreator = async (context: Pick<CommunityOperatorSessionContext, 'payload'>, creatorId: string): Promise<Record<string, unknown>> => {
  parseCreatorId(creatorId)
  const pool = getPool(context)
  const result = await pool.query(`SELECT cp.id AS profile_id, cp.public_id AS creator_public_id, cp.display_name, cp.bio,
      u.image AS avatar_url,
      COALESCE((SELECT SUM(p.like_count) FROM community_posts p WHERE p.owner_id = cp.owner_id AND p.status = 'published'), 0)::int AS published_like_count,
      COALESCE((SELECT SUM(p.favorite_count) FROM community_posts p WHERE p.owner_id = cp.owner_id AND p.status = 'published'), 0)::int AS published_favorite_count,
      cp.created_at AS creator_created_at, cp.updated_at AS creator_updated_at
    FROM community_creator_profiles cp JOIN users u ON u.id = cp.owner_id WHERE cp.public_id = $1`, [creatorId])
  const profile = result.rows[0]
  if (!profile) throw new BusinessApiError('COMMUNITY_CREATOR_NOT_FOUND', '社区作者不存在。', 404)
  const links = await socialLinksForProfile(pool, asNumber(profile.profile_id), true)
  return {
    creator: {
      creatorId: asString(profile.creator_public_id),
      avatarUrl: profile.avatar_url === null || profile.avatar_url === undefined ? null : asString(profile.avatar_url),
      displayName: profile.display_name === null || profile.display_name === undefined ? null : asString(profile.display_name),
      bio: profile.bio === null || profile.bio === undefined ? null : asString(profile.bio),
      socialLinks: links.map((link) => ({ platform: asString(link.platform), url: asString(link.url) })),
      stats: { likeCount: asNumber(profile.published_like_count ?? 0), favoriteCount: asNumber(profile.published_favorite_count ?? 0) },
    },
  }
}

export const ensureCommunityCreatorForPost = async (context: ActiveSessionContext): Promise<void> => {
  const transactionId = await context.req.transactionID
  const db = transactionId ? context.payload.db.sessions?.[transactionId]?.db : context.payload.db.drizzle
  if (!db) throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  await ensureCreatorProfile(db as Database, context.user.id)
}
