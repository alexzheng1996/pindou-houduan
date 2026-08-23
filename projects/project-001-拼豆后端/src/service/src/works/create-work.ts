// 文件开头说明：创建 M1 私密 draft 作品的原子服务。一个写请求同时写入幂等
// 记录、Work、revision 0 的 WorkDocument 和当前文档指针；首次创建不能包含
// assetId，必须先取得 workId 再按上传/确认/更新的受控顺序关联文件。
import { randomUUID } from 'crypto'

import type { ActiveSessionContext } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'
import type { ValidatedCreateWorkInput } from '@/works/validation'

const route = 'POST /api/v1/works'

export type CreateWorkResponseBody = {
  work: {
    createdAt: string
    documentRevision: 0
    kind: 'pattern' | 'board'
    state: 'draft'
    title: string
    visibility: 'private'
    workId: string
  }
}

const createPublicWorkId = (): string => `work_${randomUUID().replaceAll('-', '')}`

const asStoredBody = (value: unknown): CreateWorkResponseBody | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }

  const work = (value as { work?: unknown }).work
  if (!work || typeof work !== 'object' || Array.isArray(work)) {
    return null
  }

  const record = work as Partial<CreateWorkResponseBody['work']>
  if (
    typeof record.workId !== 'string' ||
    typeof record.title !== 'string' ||
    (record.kind !== 'pattern' && record.kind !== 'board') ||
    record.state !== 'draft' ||
    record.visibility !== 'private' ||
    record.documentRevision !== 0 ||
    typeof record.createdAt !== 'string'
  ) {
    return null
  }

  return { work: record as CreateWorkResponseBody['work'] }
}

export const createDraftWork = async (
  context: ActiveSessionContext,
  input: ValidatedCreateWorkInput,
  keySha256: string,
): Promise<CreateWorkResponseBody> => {
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: input.requestSha256,
    responseStatus: 201,
    parseStoredResponse: asStoredBody,
    execute: async () => {
      const work = await context.payload.create({
      collection: 'works',
      data: {
        publicId: createPublicWorkId(),
        owner: context.user.id,
        kind: input.kind,
        title: input.title,
        state: 'draft',
        visibility: 'private',
        documentRevision: 0,
        documentSha256: input.documentSha256,
      },
      overrideAccess: false,
      req: context.req,
    })

      const document = await context.payload.create({
      collection: 'work-documents',
      data: {
        owner: context.user.id,
        work: work.id,
        revision: 0,
        schemaVersion: 1,
        kind: input.kind,
        document: input.document,
        contentSha256: input.documentSha256,
        documentByteSize: input.documentByteSize,
      },
      overrideAccess: false,
      req: context.req,
    })

      await context.payload.update({
      collection: 'works',
      id: work.id,
      data: { currentDocument: document.id },
      overrideAccess: false,
      req: context.req,
      })

      await recordAuthenticatedAuditEvent(context, {
        action: 'work.created',
        outcome: 'allowed',
        resourcePublicId: work.publicId,
        resourceType: 'work',
        route,
      })

      const response: CreateWorkResponseBody = {
      work: {
        workId: work.publicId,
        title: work.title,
        kind: work.kind,
        state: 'draft',
        visibility: 'private',
        documentRevision: 0,
        createdAt: work.createdAt,
      },
    }

      return response
    },
  })
}
