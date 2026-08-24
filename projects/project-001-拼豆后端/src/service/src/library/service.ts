// 文件开头说明：M2 图纸册只保存当前用户对私有 Work 的整理元数据。
// Work/WorkDocument/WorkAsset 仍由 M1 owner-only 接口保护；本模块不改变
// Work.state，也不触碰个人豆仓。
import { randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'

import { BusinessApiError, stableStringify } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'

type DatabaseRow = Record<string, unknown>
type QueryResult = { rows: DatabaseRow[] }
type Database = { execute: (query: unknown) => Promise<QueryResult> }
type Pool = { query: (query: string, parameters?: readonly unknown[]) => Promise<QueryResult> }
type MakingStatus = 'draft' | 'to_make' | 'making' | 'completed'
type LibraryStats = { width: number; height: number; beadCount: number; colorCount: number }

const publicIdPattern = /^[a-z]+_[a-f0-9]{32}$/
const maxNameLength = 100
const maxLabelLength = 20

const toId = (prefix: string): string => `${prefix}_${randomUUID().replaceAll('-', '')}`

const getPool = (context: ActiveSessionContext): Pool => {
  const pool = (context.payload.db as unknown as { pool?: Pool }).pool
  if (!pool) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }
  return pool
}

const getDatabase = async (context: ActiveSessionContext): Promise<Database> => {
  const transactionId = await context.req.transactionID
  const db = transactionId ? context.payload.db.sessions?.[transactionId]?.db : context.payload.db.drizzle
  if (!db) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }
  return db as Database
}

const asString = (value: unknown): string => {
  if (typeof value !== 'string') throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return value
}

const asNumber = (value: unknown): number => {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(number)) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  return number
}

const parsePublicId = (value: unknown, code = 'REQUEST_INVALID'): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !publicIdPattern.test(value)) {
    throw new BusinessApiError(code, '图纸册对象标识无效。', 422)
  }
  return value
}

const parseName = (value: unknown, label = false): string => {
  if (typeof value !== 'string') throw new BusinessApiError('LIBRARY_INPUT_INVALID', '名称格式无效。', 422)
  const name = value.trim()
  const length = Array.from(name).length
  const maximum = label ? maxLabelLength : maxNameLength
  if (length < 1 || length > maximum) throw new BusinessApiError('LIBRARY_INPUT_INVALID', '名称长度超出限制。', 422)
  return name
}

const parseMakingStatus = (value: unknown): MakingStatus => {
  if (value === 'draft' || value === 'to_make' || value === 'making' || value === 'completed') return value
  throw new BusinessApiError('LIBRARY_INPUT_INVALID', '制作状态无效。', 422)
}

const parseLabelIds = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 5 || value.some((id) => typeof id !== 'string' || !publicIdPattern.test(id))) {
    throw new BusinessApiError('LIBRARY_INPUT_INVALID', '标签数量或标识无效。', 422)
  }
  return [...new Set(value as string[])]
}

const parseBody = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BusinessApiError('LIBRARY_INPUT_INVALID', '请求体无效。', 422)
  }
  return value as Record<string, unknown>
}

const parseStoredObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const inspectLibraryDocument = (document: unknown, kind: string): LibraryStats => {
  const root = isRecord(document) ? document : {}
  const source = kind === 'pattern' && isRecord(root.pattern) ? root.pattern : isRecord(root.board) ? root.board : {}
  const dimensions = isRecord(source.gridDimensions) ? source.gridDimensions : {}
  let width = Number(dimensions.columns) || 0
  let height = Number(dimensions.rows) || 0
  let beadCount = Number(source.totalBeadCount) || 0
  let colorCount = isRecord(source.colorCounts) ? Object.keys(source.colorCounts).length : 0
  if (kind === 'board' && Array.isArray(source.layers)) {
    const layers = source.layers.filter(isRecord)
    width = Math.max(0, ...layers.map((layer) => (Number(layer.x) || 0) + (Number(layer.width) || 0)))
    height = Math.max(0, ...layers.map((layer) => (Number(layer.y) || 0) + (Number(layer.height) || 0)))
    beadCount = layers.reduce((sum, layer) => sum + (Number(layer.totalBeadCount) || 0), 0)
    const colors = new Set<string>()
    layers.forEach((layer) => {
      if (isRecord(layer.colorCounts)) Object.keys(layer.colorCounts).forEach((key) => colors.add(key))
    })
    colorCount = colors.size
  }
  return { width, height, beadCount, colorCount }
}

const hasDatabaseCode = (error: unknown, code: string): boolean => {
  if (!error || typeof error !== 'object') return false
  const value = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown }
  if (value.code === 'P0001' && typeof value.message === 'string' && value.message.includes(code)) return true
  if (value.cause && hasDatabaseCode(value.cause, code)) return true
  return Array.isArray(value.errors) && value.errors.some((item) => hasDatabaseCode(item, code))
}

const toEntry = (row: DatabaseRow) => ({
  entryId: asString(row.entry_public_id),
  folderId: row.folder_public_id === null ? null : asString(row.folder_public_id),
  labels: Array.isArray(row.labels)
    ? row.labels.filter((item): item is { labelId: string; name: string } => (
      Boolean(item) && typeof item === 'object' && typeof (item as { labelId?: unknown }).labelId === 'string' && typeof (item as { name?: unknown }).name === 'string'
    ))
    : [],
  makingStatus: asString(row.making_status) as MakingStatus,
})

const toLibraryWork = (row: DatabaseRow) => ({
  workId: asString(row.work_public_id),
  title: asString(row.title),
  kind: asString(row.kind) as 'pattern' | 'board',
  state: 'active' as const,
  documentRevision: asNumber(row.document_revision),
  updatedAt: row.work_updated_at instanceof Date ? row.work_updated_at.toISOString() : asString(row.work_updated_at),
  ...(isRecord(row.current_document) ? inspectLibraryDocument(row.current_document, asString(row.kind)) : { width: null, height: null, beadCount: null, colorCount: null }),
  ...(row.entry_public_id === null
    ? { entryId: null, folderId: null, folderName: null, labels: [], makingStatus: 'draft' as const }
    : { ...toEntry(row), folderName: row.folder_name === null ? null : asString(row.folder_name) }),
  ...(row.provenance_public_id ? {
    provenance: {
      provenanceId: asString(row.provenance_public_id),
      sourcePostId: asString(row.source_post_public_id),
      sourceVersionId: asString(row.source_version_public_id),
      sourceAuthorName: asString(row.source_author_name_snapshot),
      sourceAvailable: row.source_post_status === 'published',
    },
  } : {}),
})

export const listLibrary = async (context: ActiveSessionContext): Promise<Record<string, unknown>> => {
  const result = await getPool(context).query(
    `SELECT w.public_id AS work_public_id, w.title, w.kind, w.document_revision,
       w.updated_at AS work_updated_at, e.public_id AS entry_public_id,
       f.public_id AS folder_public_id, f.name AS folder_name,
       COALESCE(e.making_status::text, 'draft') AS making_status,
       cp.public_id AS provenance_public_id, cp.source_post_public_id, cp.source_version_public_id,
       cp.source_author_name_snapshot, sp.status AS source_post_status,
       d.document AS current_document,
       COALESCE((SELECT jsonb_agg(jsonb_build_object('labelId', l.public_id, 'name', l.name) ORDER BY l.name)
         FROM work_library_label_links ll JOIN library_labels l ON l.id = ll.label_id
         WHERE ll.entry_id = e.id), '[]'::jsonb) AS labels
     FROM works w
     LEFT JOIN work_documents d ON d.id = w.current_document_id AND d.owner_id = $1
     LEFT JOIN work_library_entries e ON e.work_id = w.id AND e.owner_id = $1
     LEFT JOIN library_folders f ON f.id = e.folder_id AND f.owner_id = $1
     LEFT JOIN copy_provenance cp ON cp.copied_work_id = w.id
     LEFT JOIN community_posts sp ON sp.id = cp.source_post_id
     WHERE w.owner_id = $1 AND w.state = 'active'
     ORDER BY w.updated_at DESC, w.id DESC`,
    [context.user.id],
  )
  const folders = await getPool(context).query(
    `SELECT public_id, name FROM library_folders WHERE owner_id = $1 ORDER BY name ASC, id ASC`,
    [context.user.id],
  )
  const labels = await getPool(context).query(
    `SELECT public_id, name FROM library_labels WHERE owner_id = $1 ORDER BY name ASC, id ASC`,
    [context.user.id],
  )
  return {
    works: result.rows.map(toLibraryWork),
    folders: folders.rows.map((row) => ({ folderId: asString(row.public_id), name: asString(row.name) })),
    labels: labels.rows.map((row) => ({ labelId: asString(row.public_id), name: asString(row.name) })),
    nextCursor: null,
  }
}

export const listLibraryTrash = async (context: ActiveSessionContext): Promise<Record<string, unknown>> => {
  const result = await getPool(context).query(
    `SELECT public_id AS work_public_id, title, kind, document_revision, updated_at AS work_updated_at,
       recoverable_until
     FROM works WHERE owner_id = $1 AND state = 'pending_deletion'
     ORDER BY recoverable_until ASC, id ASC`,
    [context.user.id],
  )
  return {
    works: result.rows.map((row) => ({
      workId: asString(row.work_public_id),
      title: asString(row.title),
      kind: asString(row.kind),
      state: 'pending_deletion',
      makingStatus: 'draft',
      folderId: null,
      labels: [],
      documentRevision: asNumber(row.document_revision),
      updatedAt: row.work_updated_at instanceof Date ? row.work_updated_at.toISOString() : asString(row.work_updated_at),
      recoverableUntil: row.recoverable_until instanceof Date ? row.recoverable_until.toISOString() : asString(row.recoverable_until),
    })),
  }
}

export const createFolder = async (context: ActiveSessionContext, bodyValue: unknown, keySha256: string) => {
  const body = parseBody(bodyValue)
  const name = parseName(body.name)
  const requestSha256 = stableStringify({ name })
  return withIdempotentWrite(context, {
    route: 'POST /api/v1/library/folders', keySha256, requestSha256,
    responseStatus: 201, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`INSERT INTO library_folders (public_id, owner_id, name)
        VALUES (${toId('folder')}, ${context.user.id}, ${name}) RETURNING public_id, name`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      const response = { folder: { folderId: asString(row.public_id), name: asString(row.name) } }
      await recordAuthenticatedAuditEvent(context, { action: 'library.folder_created', outcome: 'allowed', resourcePublicId: response.folder.folderId, resourceType: 'library', route: 'POST /api/v1/library/folders' })
      return response
    },
  })
}

export const updateFolder = async (context: ActiveSessionContext, folderId: string, bodyValue: unknown, keySha256: string) => {
  const body = parseBody(bodyValue)
  const name = parseName(body.name)
  parsePublicId(folderId)
  return withIdempotentWrite(context, {
    route: `PATCH /api/v1/library/folders/${folderId}`, keySha256,
    requestSha256: stableStringify({ name }), responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`UPDATE library_folders SET name = ${name}, updated_at = NOW()
        WHERE public_id = ${folderId} AND owner_id = ${context.user.id} RETURNING public_id, name`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('LIBRARY_FOLDER_NOT_FOUND', '文件夹不存在。', 404)
      return { folder: { folderId: asString(row.public_id), name: asString(row.name) } }
    },
  })
}

export const deleteFolder = async (context: ActiveSessionContext, folderId: string, keySha256: string) => {
  parsePublicId(folderId)
  return withIdempotentWrite(context, {
    route: `DELETE /api/v1/library/folders/${folderId}`, keySha256,
    requestSha256: folderId, responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`DELETE FROM library_folders WHERE public_id = ${folderId} AND owner_id = ${context.user.id} RETURNING public_id`)
      if (!result.rows[0]) throw new BusinessApiError('LIBRARY_FOLDER_NOT_FOUND', '文件夹不存在。', 404)
      return { deleted: true, folderId }
    },
  })
}

export const createLabel = async (context: ActiveSessionContext, bodyValue: unknown, keySha256: string) => {
  const body = parseBody(bodyValue)
  const name = parseName(body.name, true)
  return withIdempotentWrite(context, {
    route: 'POST /api/v1/library/labels', keySha256,
    requestSha256: stableStringify({ name }), responseStatus: 201, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`INSERT INTO library_labels (public_id, owner_id, name)
        VALUES (${toId('label')}, ${context.user.id}, ${name}) RETURNING public_id, name`)
      const row = result.rows[0]
      if (!row) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      await recordAuthenticatedAuditEvent(context, { action: 'library.label_created', outcome: 'allowed', resourcePublicId: asString(row.public_id), resourceType: 'library', route: 'POST /api/v1/library/labels' })
      return { label: { labelId: asString(row.public_id), name: asString(row.name) } }
    },
  })
}

export const updateLabel = async (context: ActiveSessionContext, labelId: string, bodyValue: unknown, keySha256: string) => {
  const body = parseBody(bodyValue)
  const name = parseName(body.name, true)
  parsePublicId(labelId)
  return withIdempotentWrite(context, {
    route: `PATCH /api/v1/library/labels/${labelId}`, keySha256,
    requestSha256: stableStringify({ name }), responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`UPDATE library_labels SET name = ${name}, updated_at = NOW()
        WHERE public_id = ${labelId} AND owner_id = ${context.user.id} RETURNING public_id, name`)
      if (!result.rows[0]) throw new BusinessApiError('LIBRARY_LABEL_NOT_FOUND', '标签不存在。', 404)
      return { label: { labelId: asString(result.rows[0].public_id), name: asString(result.rows[0].name) } }
    },
  })
}

export const deleteLabel = async (context: ActiveSessionContext, labelId: string, keySha256: string) => {
  parsePublicId(labelId)
  return withIdempotentWrite(context, {
    route: `DELETE /api/v1/library/labels/${labelId}`, keySha256,
    requestSha256: labelId, responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const result = await db.execute(sql`DELETE FROM library_labels WHERE public_id = ${labelId} AND owner_id = ${context.user.id} RETURNING public_id`)
      if (!result.rows[0]) throw new BusinessApiError('LIBRARY_LABEL_NOT_FOUND', '标签不存在。', 404)
      return { deleted: true, labelId }
    },
  })
}

export const updateLibraryWork = async (context: ActiveSessionContext, workId: string, bodyValue: unknown, keySha256: string) => {
  parsePublicId(workId)
  const body = parseBody(bodyValue)
  const folderId = parsePublicId(body.folderId)
  const labels = parseLabelIds(body.labelIds ?? [])
  const makingStatus = parseMakingStatus(body.makingStatus)
  return withIdempotentWrite(context, {
    route: `PATCH /api/v1/library/works/${workId}`, keySha256,
    requestSha256: stableStringify({ folderId, labels, makingStatus }), responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const work = await db.execute(sql`SELECT id FROM works WHERE public_id = ${workId} AND owner_id = ${context.user.id} AND state = 'active'`)
      const workRow = work.rows[0]
      if (!workRow) throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
      const folder = folderId
        ? await db.execute(sql`SELECT id, public_id FROM library_folders WHERE public_id = ${folderId} AND owner_id = ${context.user.id}`)
        : { rows: [] }
      if (folderId && !folder.rows[0]) throw new BusinessApiError('LIBRARY_FOLDER_NOT_FOUND', '文件夹不存在。', 404)
      const labelRows = labels.length
        ? await db.execute(sql`SELECT id, public_id FROM library_labels WHERE owner_id = ${context.user.id} AND public_id IN (${sql.join(labels.map((id) => sql`${id}`), sql`, `)})`)
        : { rows: [] }
      if (labelRows.rows.length !== labels.length) throw new BusinessApiError('LIBRARY_LABEL_NOT_FOUND', '标签不存在。', 404)
      const entry = await db.execute(sql`
        INSERT INTO work_library_entries (public_id, owner_id, work_id, folder_id, making_status)
        VALUES (${toId('entry')}, ${context.user.id}, ${asNumber(workRow.id)}, ${folder.rows[0]?.id ?? null}, ${makingStatus})
        ON CONFLICT (owner_id, work_id) DO UPDATE SET folder_id = EXCLUDED.folder_id,
          making_status = EXCLUDED.making_status, updated_at = NOW()
        RETURNING id, public_id, making_status`)
      const entryRow = entry.rows[0]
      if (!entryRow) throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
      await db.execute(sql`DELETE FROM work_library_label_links WHERE entry_id = ${asNumber(entryRow.id)}`)
      for (const labelRow of labelRows.rows) {
        await db.execute(sql`INSERT INTO work_library_label_links (entry_id, label_id) VALUES (${asNumber(entryRow.id)}, ${asNumber(labelRow.id)})`)
      }
      await recordAuthenticatedAuditEvent(context, { action: 'library.metadata_updated', outcome: 'allowed', resourcePublicId: workId, resourceType: 'library', route: `PATCH /api/v1/library/works/${workId}` })
      return { workId, library: { entryId: asString(entryRow.public_id), folderId, labels, makingStatus } }
    },
  })
}

export const restoreWork = async (context: ActiveSessionContext, workId: string, expectedRevision: number, keySha256: string) => {
  parsePublicId(workId)
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new BusinessApiError('REQUEST_INVALID', '作品修订号无效。', 400)
  try {
    return await withIdempotentWrite(context, {
    route: `POST /api/v1/library/works/${workId}/restore`, keySha256,
    requestSha256: stableStringify({ expectedRevision }), responseStatus: 200, parseStoredResponse: parseStoredObject,
    execute: async () => {
      const db = await getDatabase(context)
      const current = await db.execute(sql`SELECT id, public_id, title, kind, document_revision, recoverable_until
        FROM works WHERE public_id = ${workId} AND owner_id = ${context.user.id} AND state = 'pending_deletion' FOR UPDATE`)
      const row = current.rows[0]
      if (!row) throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
      if (asNumber(row.document_revision) !== expectedRevision) throw new BusinessApiError('WORK_REVISION_CONFLICT', '作品已在其他位置更新，请刷新后重试。', 409)
      const recoverableUntil = row.recoverable_until instanceof Date ? row.recoverable_until : new Date(asString(row.recoverable_until))
      if (Number.isNaN(recoverableUntil.getTime()) || recoverableUntil.getTime() <= Date.now()) throw new BusinessApiError('WORK_RECOVERY_EXPIRED', '作品恢复期限已结束。', 410)
      const updated = await db.execute(sql`UPDATE works SET state = 'active', deleted_at = NULL, recoverable_until = NULL, updated_at = NOW()
        WHERE id = ${asNumber(row.id)} AND state = 'pending_deletion' AND document_revision = ${expectedRevision}
        RETURNING public_id, title, kind, document_revision, updated_at`)
      const next = updated.rows[0]
      if (!next) throw new BusinessApiError('WORK_REVISION_CONFLICT', '作品已在其他位置更新，请刷新后重试。', 409)
      await recordAuthenticatedAuditEvent(context, { action: 'work.restored', outcome: 'allowed', resourcePublicId: workId, resourceType: 'work', route: `POST /api/v1/library/works/${workId}/restore` })
      return { work: { workId, title: asString(next.title), kind: asString(next.kind), state: 'active', documentRevision: asNumber(next.document_revision), visibility: 'private' } }
    },
    })
  } catch (error) {
    if (hasDatabaseCode(error, 'WORK_LIMIT_REACHED')) throw new BusinessApiError('WORK_LIMIT_REACHED', '当前最多保留 50 份制作中的图纸，请先删除一份后再恢复。', 409)
    if (hasDatabaseCode(error, 'WORK_REVISION_CONFLICT')) throw new BusinessApiError('WORK_REVISION_CONFLICT', '作品已在其他位置更新，请刷新后重试。', 409)
    throw error
  }
}
