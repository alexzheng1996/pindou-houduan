// 文件开头说明：M1 私密作品的持久化边界。Work 只保存作品归属、状态和当前
// 快照指针；可编辑图纸真值只存在 WorkDocument，文件真值只存在 WorkAsset。
import type { Access, CollectionConfig, PayloadRequest, Where } from 'payload'

const workKinds = ['pattern', 'board']
const workStates = ['draft', 'active', 'pending_deletion', 'deleted']
const assetRoles = ['original', 'display', 'thumbnail', 'document', 'export']
const assetStatuses = [
  'upload_pending',
  'uploaded',
  'ready',
  'validation_failed',
  'orphaned',
  'pending_purge',
  'deleted',
]
const idempotencyStates = ['in_progress', 'completed']

type WorkRequest = PayloadRequest & {
  context?: Record<string, unknown>
  user?: { id?: number | string } | null
}

const getUserId = (req: WorkRequest): number | null => {
  const id = req.user?.id

  if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
    return id
  }

  if (typeof id === 'string' && /^\d+$/.test(id)) {
    const parsed = Number(id)

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }

  return null
}

const isWorkService = (req: WorkRequest): boolean => req.context?.workService === true

const ownRecordsOnly: Access = ({ req }) => {
  const userId = getUserId(req as WorkRequest)

  return userId ? ({ owner: { equals: userId } } satisfies Where) : false
}

const workServiceOnly: Access = ({ req }) => isWorkService(req as WorkRequest)

const noAdminBrowse = (): boolean => false

export const Works: CollectionConfig = {
  slug: 'works',
  admin: {
    hidden: true,
    useAsTitle: 'title',
  },
  access: {
    admin: noAdminBrowse,
    create: workServiceOnly,
    delete: workServiceOnly,
    read: ownRecordsOnly,
    update: workServiceOnly,
  },
  endpoints: false,
  indexes: [
    { fields: ['publicId'], unique: true },
    { fields: ['owner', 'state', 'updatedAt'] },
  ],
  fields: [
    { name: 'publicId', type: 'text', required: true },
    { name: 'owner', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'kind', type: 'select', options: workKinds, required: true },
    { name: 'title', type: 'text', required: true, maxLength: 120 },
    { name: 'state', type: 'select', options: workStates, required: true, defaultValue: 'draft' },
    {
      name: 'visibility',
      type: 'select',
      options: ['private'],
      required: true,
      defaultValue: 'private',
    },
    { name: 'documentRevision', type: 'number', required: true, min: 0, defaultValue: 0 },
    { name: 'documentSha256', type: 'text', required: true },
    { name: 'currentDocument', type: 'relationship', relationTo: 'work-documents' },
    { name: 'recoverableUntil', type: 'date' },
    { name: 'deletedAt', type: 'date' },
  ],
}

export const WorkDocuments: CollectionConfig = {
  slug: 'work-documents',
  admin: { hidden: true },
  access: {
    admin: noAdminBrowse,
    create: workServiceOnly,
    delete: workServiceOnly,
    read: ownRecordsOnly,
    update: () => false,
  },
  endpoints: false,
  indexes: [
    { fields: ['work', 'revision'], unique: true },
    { fields: ['owner', 'work', 'revision'] },
  ],
  fields: [
    { name: 'owner', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'work', type: 'relationship', relationTo: 'works', required: true, index: true },
    { name: 'revision', type: 'number', required: true, min: 0 },
    { name: 'schemaVersion', type: 'number', required: true, min: 1 },
    { name: 'kind', type: 'select', options: workKinds, required: true },
    { name: 'document', type: 'json', required: true },
    { name: 'contentSha256', type: 'text', required: true, index: true },
    { name: 'documentByteSize', type: 'number', required: true, min: 0 },
  ],
}

export const WorkAssets: CollectionConfig = {
  slug: 'work-assets',
  admin: { hidden: true },
  access: {
    admin: noAdminBrowse,
    create: workServiceOnly,
    delete: workServiceOnly,
    read: ownRecordsOnly,
    update: workServiceOnly,
  },
  endpoints: false,
  indexes: [
    { fields: ['publicId'], unique: true },
    { fields: ['owner', 'work', 'status'] },
    { fields: ['purgeAfter'] },
    { fields: ['storageKey'], unique: true },
  ],
  fields: [
    { name: 'publicId', type: 'text', required: true },
    { name: 'owner', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'work', type: 'relationship', relationTo: 'works', required: true, index: true },
    { name: 'role', type: 'select', options: assetRoles, required: true },
    { name: 'status', type: 'select', options: assetStatuses, required: true },
    {
      name: 'visibility',
      type: 'select',
      options: ['private'],
      required: true,
      defaultValue: 'private',
    },
    { name: 'mimeType', type: 'text', required: true },
    { name: 'detectedMimeType', type: 'text', access: { read: ({ req }) => isWorkService(req as WorkRequest) } },
    { name: 'sizeBytes', type: 'number', required: true, min: 0 },
    { name: 'sha256', type: 'text', required: true, index: true },
    {
      name: 'storageKey',
      type: 'text',
      required: true,
      access: { read: ({ req }) => isWorkService(req as WorkRequest) },
    },
    { name: 'storageETag', type: 'text', access: { read: ({ req }) => isWorkService(req as WorkRequest) } },
    { name: 'uploadExpiresAt', type: 'date' },
    { name: 'confirmedAt', type: 'date' },
    { name: 'orphanedAt', type: 'date' },
    { name: 'purgeAfter', type: 'date' },
    { name: 'sourceDocumentRevision', type: 'number', min: 0 },
    { name: 'sourceDocumentSha256', type: 'text' },
  ],
}

// 所有写入接口都必须使用持久化幂等记录；内存 Map 无法应对浏览器重试、服务重启
// 和将来的多实例部署。请求与幂等键只保存哈希，不保存用户原始 Header 内容。
export const ApiIdempotencyRecords: CollectionConfig = {
  slug: 'api-idempotency-records',
  admin: { hidden: true },
  access: {
    admin: noAdminBrowse,
    create: workServiceOnly,
    delete: workServiceOnly,
    read: workServiceOnly,
    update: workServiceOnly,
  },
  endpoints: false,
  indexes: [
    { fields: ['actor', 'route', 'keySha256'], unique: true },
    { fields: ['expiresAt'] },
  ],
  fields: [
    { name: 'actor', type: 'relationship', relationTo: 'users', required: true, index: true },
    { name: 'route', type: 'text', required: true },
    { name: 'keySha256', type: 'text', required: true },
    { name: 'requestSha256', type: 'text', required: true },
    { name: 'state', type: 'select', options: idempotencyStates, required: true },
    { name: 'responseStatus', type: 'number', min: 100, max: 599 },
    { name: 'responseBody', type: 'json' },
    { name: 'expiresAt', type: 'date', required: true },
  ],
}
