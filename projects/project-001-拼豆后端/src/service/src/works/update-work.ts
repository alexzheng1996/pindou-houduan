// 文件开头说明：M1 文档更新与首次激活服务。每次成功保存追加一份不可变快照；
// expectedRevision 必须匹配当前版本，首次从 draft 进入 active 时由数据库门禁保证
// 任一用户最多 50 份 active 作品，不能被并发请求绕过。
import { BusinessApiError, sha256, stableStringify } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import type { Work, WorkAsset } from '@/payload-types'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'
import {
  isAllowedAssetRole,
  type AssetReference,
  type ValidatedUpdateWorkInput,
} from '@/works/validation'
import { and, eq } from '@payloadcms/db-postgres/drizzle'

const routePrefix = 'PATCH /api/v1/works/'
const auditRoute = 'PATCH /api/v1/works/:id/document'
const publicIdPattern = /^work_[a-f0-9]{32}$/

export type UpdateWorkResponseBody = {
  work: {
    contentSha256: string
    documentRevision: number
    kind: 'pattern' | 'board'
    state: 'active'
    title: string
    updatedAt: string
    visibility: 'private'
    workId: string
  }
}

export class WorkRevisionConflictError extends Error {}

type AtomicWorkUpdate = {
  currentDocument?: number
  documentRevision?: number
  documentSha256?: string
  kind?: 'pattern' | 'board'
  state?: 'active'
  title?: string
}

type DrizzleWorkDatabase = {
  update: (table: unknown) => {
    set: (data: Record<string, unknown>) => {
      where: (condition: unknown) => {
        returning: () => Promise<unknown[]>
      }
    }
  }
}

const relationshipId = (value: number | { id: number }): number =>
  typeof value === 'number' ? value : value.id

const updateWorkAtExpectedRevision = async (
  context: ActiveSessionContext,
  work: Work,
  expectedRevision: number,
  data: AtomicWorkUpdate,
): Promise<Work | null> => {
  const table = context.payload.db.tables.works
  const transactionId = await context.req.transactionID
  const db = (transactionId
    ? context.payload.db.sessions?.[transactionId]?.db
    : context.payload.db.drizzle) as DrizzleWorkDatabase | undefined

  if (!db) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }

  const rows = await db
    .update(table)
    .set({
      ...data,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(table.id, work.id), eq(table.documentRevision, expectedRevision)))
    .returning()

  return (rows[0] as Work | undefined) ?? null
}

const hasDatabaseBusinessError = (error: unknown, code: string): boolean => {
  const visited = new Set<unknown>()
  let current = error

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current)
    const value = current as { cause?: unknown; code?: unknown; message?: unknown; errors?: unknown }

    if (
      value.code === 'P0001' &&
      typeof value.message === 'string' &&
      value.message.includes(code)
    ) {
      return true
    }

    if (Array.isArray(value.errors) && value.errors.some((item) => hasDatabaseBusinessError(item, code))) {
      return true
    }

    current = value.cause
  }

  if (error instanceof Error && error.stack?.includes(code)) {
    return true
  }

  return false
}

const parseStoredBody = (value: unknown): UpdateWorkResponseBody | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const work = (value as { work?: unknown }).work
  if (!work || typeof work !== 'object' || Array.isArray(work)) {
    return null
  }

  const record = work as Partial<UpdateWorkResponseBody['work']>
  if (
    typeof record.workId !== 'string' ||
    typeof record.title !== 'string' ||
    (record.kind !== 'pattern' && record.kind !== 'board') ||
    record.state !== 'active' ||
    record.visibility !== 'private' ||
    typeof record.documentRevision !== 'number' ||
    !Number.isSafeInteger(record.documentRevision) ||
    record.documentRevision < 1 ||
    typeof record.contentSha256 !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    return null
  }

  return { work: record as UpdateWorkResponseBody['work'] }
}

const getOwnedEditableWork = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<Work> => {
  if (!publicIdPattern.test(publicId)) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  const result = await context.payload.find({
    collection: 'works',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: context.req,
    where: {
      and: [
        { owner: { equals: context.user.id } },
        { publicId: { equals: publicId } },
        { state: { in: ['draft', 'active'] } },
      ],
    },
  })
  const work = result.docs[0]
  if (!work) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return work
}

export const assertReadyAssetReferences = async (
  context: ActiveSessionContext,
  work: Work,
  references: AssetReference[],
): Promise<void> => {
  for (const reference of references) {
    const result = await context.payload.find({
      collection: 'work-assets',
      depth: 0,
      limit: 1,
      overrideAccess: false,
      req: context.req,
      where: {
        and: [
          { owner: { equals: context.user.id } },
          { work: { equals: work.id } },
          { publicId: { equals: reference.assetId } },
          { status: { equals: 'ready' } },
          { role: { in: [...reference.acceptedRoles] } },
        ],
      },
    })
    const asset = result.docs[0] as WorkAsset | undefined

    if (
      !asset ||
      relationshipId(asset.owner) !== context.user.id ||
      relationshipId(asset.work) !== work.id ||
      asset.status !== 'ready' ||
      !isAllowedAssetRole(
        asset.role as 'display' | 'original' | 'thumbnail',
        reference.acceptedRoles,
      )
    ) {
      throw new BusinessApiError(
        'ASSET_NOT_READY',
        '作品引用的文件尚未确认或不可访问。',
        422,
      )
    }
  }
}

export const updateWorkDocument = async (
  context: ActiveSessionContext,
  publicId: string,
  expectedRevision: number,
  input: ValidatedUpdateWorkInput,
  keySha256: string,
): Promise<UpdateWorkResponseBody> => {
  const route = `${routePrefix}${publicId}/document`
  const requestSha256 = input.requestSha256
  const response = await withIdempotentWrite<UpdateWorkResponseBody>(context, {
    route,
    keySha256,
    requestSha256,
    responseStatus: 200,
    parseStoredResponse: parseStoredBody,
    execute: async () => {
      const work = await getOwnedEditableWork(context, publicId)
      if (work.documentRevision !== expectedRevision) {
        throw new WorkRevisionConflictError()
      }
      await assertReadyAssetReferences(context, work, input.assetReferences)

      const nextRevision = expectedRevision + 1
      const document = {
        ...input.document,
        documentRevision: nextRevision,
      }
      const canonicalDocument = stableStringify(document)
      const documentSha256 = sha256(canonicalDocument)
      const documentByteSize = Buffer.byteLength(stableStringify(document), 'utf8')

      // This write is deliberately before the immutable snapshot. PostgreSQL
      // checks that the stored revision advances by exactly one, so two distinct
      // requests cannot both turn revision N into N+1 after reading it.
      const updatedWork = await updateWorkAtExpectedRevision(context, work, expectedRevision, {
        kind: input.kind,
        title: input.title,
        state: 'active',
        documentRevision: nextRevision,
        documentSha256,
      })
      if (!updatedWork) {
        throw new WorkRevisionConflictError()
      }

      const snapshot = await context.payload.create({
        collection: 'work-documents',
        data: {
          owner: context.user.id,
          work: work.id,
          revision: nextRevision,
          schemaVersion: 1,
          kind: input.kind,
          document,
          contentSha256: documentSha256,
          documentByteSize,
        },
        overrideAccess: false,
        req: context.req,
      })

      const finalizedWork = await updateWorkAtExpectedRevision(context, updatedWork, nextRevision, {
        currentDocument: snapshot.id,
      })
      if (!finalizedWork) {
        throw new WorkRevisionConflictError()
      }

      await recordAuthenticatedAuditEvent(context, {
        action: 'work.document_saved',
        outcome: 'allowed',
        resourcePublicId: finalizedWork.publicId,
        resourceType: 'work',
        route: auditRoute,
      })

      return {
        work: {
          workId: finalizedWork.publicId,
          title: finalizedWork.title,
          kind: finalizedWork.kind,
          state: 'active',
          visibility: 'private',
          documentRevision: nextRevision,
          contentSha256: documentSha256,
          updatedAt: finalizedWork.updatedAt,
        },
      }
    },
  })

  return response
}

export const toUpdateWorkError = (error: unknown): BusinessApiError | null => {
  if (error instanceof WorkRevisionConflictError) {
    return new BusinessApiError(
      'WORK_REVISION_CONFLICT',
      '作品已在其他位置更新，请刷新后重试。',
      409,
    )
  }

  if (hasDatabaseBusinessError(error, 'WORK_REVISION_CONFLICT')) {
    return new BusinessApiError(
      'WORK_REVISION_CONFLICT',
      '作品已在其他位置更新，请刷新后重试。',
      409,
    )
  }

  if (hasDatabaseBusinessError(error, 'WORK_LIMIT_REACHED')) {
    return new BusinessApiError(
      'WORK_LIMIT_REACHED',
      '当前账号最多可保存 50 个作品，请先删除或整理已有作品。',
      409,
    )
  }

  return null
}
