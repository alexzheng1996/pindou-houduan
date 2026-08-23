// 文件开头说明：M1 私密作品读取服务。所有查询都同时限定当前 owner 和业务状态，
// 并用安全投影返回；Payload 数字 ID、owner、内部文档 ID 与存储键永不离开服务端。
import { BusinessApiError } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import type { Work, WorkDocument } from '@/payload-types'
import type { Where } from 'payload'

const defaultListLimit = 20
const maxListLimit = 50
const cursorPattern = /^[a-z0-9]+(?:_[a-z0-9]+)*$/

type WorkSummary = {
  documentRevision: number
  kind: 'pattern' | 'board'
  state: 'active'
  title: string
  updatedAt: string
  workId: string
}

type WorkDetail = WorkSummary & {
  createdAt: string
  document: unknown
}

const toPublicId = (value: string): string => {
  if (!cursorPattern.test(value)) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return value
}

const parseLimit = (value: string | null): number => {
  if (!value) {
    return defaultListLimit
  }

  if (!/^\d+$/.test(value)) {
    throw new BusinessApiError('REQUEST_INVALID', '分页参数无效。', 400)
  }

  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxListLimit) {
    throw new BusinessApiError('REQUEST_INVALID', '分页参数无效。', 400)
  }

  return limit
}

const asSummary = (work: Work): WorkSummary => ({
  workId: work.publicId,
  title: work.title,
  kind: work.kind,
  state: 'active',
  documentRevision: work.documentRevision,
  updatedAt: work.updatedAt,
})

const activeWorkWhere = (ownerId: number, after?: string): Where => ({
  and: [
    { owner: { equals: ownerId } },
    { state: { equals: 'active' } },
    ...(after ? [{ publicId: { greater_than: after } }] : []),
  ],
})

export const listActiveWorks = async (
  context: ActiveSessionContext,
  searchParams: URLSearchParams,
): Promise<{ nextCursor: string | null; works: WorkSummary[] }> => {
  const limit = parseLimit(searchParams.get('limit'))
  const cursor = searchParams.get('cursor')
  const after = cursor ? toPublicId(cursor) : undefined
  const result = await context.payload.find({
    collection: 'works',
    depth: 0,
    limit: limit + 1,
    overrideAccess: false,
    req: context.req,
    sort: 'publicId',
    where: activeWorkWhere(context.user.id, after),
  })
  const hasNextPage = result.docs.length > limit
  const page = result.docs.slice(0, limit)

  return {
    works: page.map(asSummary),
    nextCursor: hasNextPage ? page.at(-1)?.publicId ?? null : null,
  }
}

const findAccessibleActiveWork = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<Work> => {
  const result = await context.payload.find({
    collection: 'works',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: context.req,
    where: {
      and: [
        { owner: { equals: context.user.id } },
        { state: { equals: 'active' } },
        { publicId: { equals: toPublicId(publicId) } },
      ],
    },
  })
  const work = result.docs[0]
  if (!work) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return work
}

const findCurrentDocument = async (
  context: ActiveSessionContext,
  work: Work,
): Promise<WorkDocument> => {
  if (typeof work.currentDocument !== 'number') {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  const document = await context.payload.findByID({
    collection: 'work-documents',
    id: work.currentDocument,
    depth: 0,
    overrideAccess: false,
    req: context.req,
  })

  const documentOwner = typeof document.owner === 'number' ? document.owner : document.owner.id
  const documentWork = typeof document.work === 'number' ? document.work : document.work.id
  if (
    documentOwner !== context.user.id ||
    documentWork !== work.id ||
    document.revision !== work.documentRevision
  ) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return document
}

export const getActiveWorkDetail = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<{ work: WorkDetail }> => {
  const work = await findAccessibleActiveWork(context, publicId)
  const document = await findCurrentDocument(context, work)

  return {
    work: {
      ...asSummary(work),
      createdAt: work.createdAt,
      document: document.document,
    },
  }
}
