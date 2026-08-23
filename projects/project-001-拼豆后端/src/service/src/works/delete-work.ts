// 文件开头说明：M1 作品删除只做可追溯的状态迁移。草稿取消后立即隐藏并可清理；
// active 作品进入 30 天回收期。物理删除由独立的受控清理任务执行，不能绕过文件、
// 历史快照和外键的回收顺序。
import { BusinessApiError, sha256, stableStringify } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import type { Work } from '@/payload-types'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'

const workIdPattern = /^work_[a-f0-9]{32}$/
const recoverableDeletionLifetimeMs = 30 * 24 * 60 * 60 * 1000

type CancelDraftResponse = {
  work: {
    deletedAt: string
    state: 'deleted'
    workId: string
  }
}

type DeletionRequestResponse = {
  work: {
    recoverableUntil: string
    state: 'pending_deletion'
    workId: string
  }
}

const parseCancelDraftResponse = (value: unknown): CancelDraftResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const work = (value as { work?: unknown }).work
  if (!work || typeof work !== 'object' || Array.isArray(work)) {
    return null
  }

  const record = work as Partial<CancelDraftResponse['work']>
  return (
    record.state === 'deleted' &&
    typeof record.workId === 'string' &&
    workIdPattern.test(record.workId) &&
    typeof record.deletedAt === 'string'
  )
    ? { work: record as CancelDraftResponse['work'] }
    : null
}

const parseDeletionRequestResponse = (value: unknown): DeletionRequestResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const work = (value as { work?: unknown }).work
  if (!work || typeof work !== 'object' || Array.isArray(work)) {
    return null
  }

  const record = work as Partial<DeletionRequestResponse['work']>
  return (
    record.state === 'pending_deletion' &&
    typeof record.workId === 'string' &&
    workIdPattern.test(record.workId) &&
    typeof record.recoverableUntil === 'string'
  )
    ? { work: record as DeletionRequestResponse['work'] }
    : null
}

const findOwnedWork = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<Work> => {
  if (!workIdPattern.test(publicId)) {
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
      ],
    },
  })
  const work = result.docs[0]
  if (!work) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return work
}

const transitionOwnedWork = async (
  context: ActiveSessionContext,
  work: Work,
  expectedState: Work['state'],
  data: Record<string, unknown>,
  expectedRevision?: number,
): Promise<Work | null> => {
  const result = await context.payload.update({
    collection: 'works',
    data: data as never,
    depth: 0,
    overrideAccess: false,
    req: context.req,
    where: {
      and: [
        { id: { equals: work.id } },
        { owner: { equals: context.user.id } },
        { state: { equals: expectedState } },
        ...(expectedRevision === undefined
          ? []
          : [{ documentRevision: { equals: expectedRevision } }]),
      ],
    },
  })

  return result.docs[0] ?? null
}

export const cancelDraftWork = async (
  context: ActiveSessionContext,
  publicId: string,
  keySha256: string,
): Promise<CancelDraftResponse> => {
  const route = `DELETE /api/v1/works/${publicId}/draft`

  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify({})),
    responseStatus: 200,
    parseStoredResponse: parseCancelDraftResponse,
    execute: async () => {
      const work = await findOwnedWork(context, publicId)
      if (work.state !== 'draft') {
        throw new BusinessApiError('WORK_NOT_DRAFT', '该作品不是可取消的草稿。', 409)
      }

      const deletedAt = new Date().toISOString()
      const transitioned = await transitionOwnedWork(context, work, 'draft', {
        state: 'deleted',
        deletedAt,
        // A cancelled first-save draft has no recovery promise. It remains in
        // the database only until the next controlled local purge can remove
        // its files and immutable revision-0 snapshot in the correct order.
        recoverableUntil: deletedAt,
      })
      if (!transitioned) {
        throw new BusinessApiError('WORK_NOT_DRAFT', '该作品不是可取消的草稿。', 409)
      }

      await recordAuthenticatedAuditEvent(context, {
        action: 'work.draft_cancelled',
        outcome: 'allowed',
        resourcePublicId: transitioned.publicId,
        resourceType: 'work',
        route: 'DELETE /api/v1/works/:id/draft',
      })

      return {
        work: {
          workId: transitioned.publicId,
          state: 'deleted',
          deletedAt,
        },
      }
    },
  })
}

export const requestActiveWorkDeletion = async (
  context: ActiveSessionContext,
  publicId: string,
  expectedRevision: number,
  keySha256: string,
): Promise<DeletionRequestResponse> => {
  const route = `POST /api/v1/works/${publicId}/deletion-request`

  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify({ expectedRevision })),
    responseStatus: 200,
    parseStoredResponse: parseDeletionRequestResponse,
    execute: async () => {
      const work = await findOwnedWork(context, publicId)
      if (work.state !== 'active') {
        throw new BusinessApiError('WORK_NOT_ACTIVE', '只有已保存的作品可以申请删除。', 409)
      }
      if (work.documentRevision !== expectedRevision) {
        throw new BusinessApiError(
          'WORK_REVISION_CONFLICT',
          '作品已在其他位置更新，请刷新后重试。',
          409,
        )
      }

      const deletedAt = new Date().toISOString()
      const recoverableUntil = new Date(
        Date.now() + recoverableDeletionLifetimeMs,
      ).toISOString()
      const transitioned = await transitionOwnedWork(
        context,
        work,
        'active',
        {
          state: 'pending_deletion',
          deletedAt,
          recoverableUntil,
        },
        expectedRevision,
      )
      if (!transitioned) {
        throw new BusinessApiError(
          'WORK_REVISION_CONFLICT',
          '作品已在其他位置更新，请刷新后重试。',
          409,
        )
      }

      await recordAuthenticatedAuditEvent(context, {
        action: 'work.deletion_requested',
        outcome: 'allowed',
        resourcePublicId: transitioned.publicId,
        resourceType: 'work',
        route: 'POST /api/v1/works/:id/deletion-request',
      })

      return {
        work: {
          workId: transitioned.publicId,
          state: 'pending_deletion',
          recoverableUntil,
        },
      }
    },
  })
}
