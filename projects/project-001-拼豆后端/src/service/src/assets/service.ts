// 文件开头说明：M1 私有图片的业务服务。WorkAsset 只保存元数据，实际字节经
// local-object-store 在本机验证；以后替换 R2/S3 只能改变存储适配，不改变权限、
// 哈希、限额或 API 契约。
import { randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { BusinessApiError } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import type { Work, WorkAsset } from '@/payload-types'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import {
  createLocalStorageKey,
  deleteLocalObject,
  localObjectExists,
  readLocalObject,
  writeLocalObjectIfAbsent,
} from '@/storage/local-object-store'
import {
  type AssetMimeType,
  type ValidatedConfirmAssetInput,
  type ValidatedUploadIntentInput,
  inspectImageUpload,
  MAX_IMAGE_BYTES_PER_USER,
  MAX_IMAGE_BYTES_PER_WORK,
  MAX_IMAGES_PER_WORK,
  ORPHAN_RETENTION_MS,
  parseMimeType,
  UPLOAD_INTENT_LIFETIME_MS,
} from '@/assets/validation'
import { withIdempotentWrite } from '@/works/idempotency'

const workIdPattern = /^work_[a-f0-9]{32}$/
const assetIdPattern = /^asset_[a-f0-9]{32}$/
const uploadableStates = ['draft', 'active']

type AssetStatus = 'upload_pending' | 'uploaded' | 'ready' | 'validation_failed' | 'orphaned'
type AssetRole = 'original' | 'display' | 'thumbnail'

type AssetProjection = {
  assetId: string
  mimeType: AssetMimeType
  role: AssetRole
  sha256: string
  sizeBytes: number
  status: AssetStatus
  visibility: 'private'
}

type UploadIntentResponse = {
  asset: AssetProjection
  expiresAt: string
  upload: {
    method: 'PUT'
    url: string
  }
}

type ConfirmResponse = {
  asset: AssetProjection
}

type TransactionDatabase = {
  execute: (query: unknown) => Promise<{ rows: Array<{ asset_count: number | string; total_bytes: number | string }> }>
}

const createAssetId = (): string => `asset_${randomUUID().replaceAll('-', '')}`

const relationshipId = (value: number | { id: number }): number => (typeof value === 'number' ? value : value.id)

const asAssetProjection = (asset: WorkAsset): AssetProjection => ({
  assetId: asset.publicId,
  role: asset.role as AssetRole,
  status: asset.status as AssetStatus,
  mimeType: asset.mimeType as AssetMimeType,
  sha256: asset.sha256,
  sizeBytes: asset.sizeBytes,
  visibility: 'private',
})

const getTransactionDatabase = async (context: ActiveSessionContext): Promise<TransactionDatabase> => {
  const transactionId = await context.req.transactionID
  const db = transactionId
    ? context.payload.db.sessions?.[transactionId]?.db
    : context.payload.db.drizzle

  if (!db) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }

  return db as TransactionDatabase
}

const lockAssetCapacity = async (context: ActiveSessionContext): Promise<void> => {
  const db = await getTransactionDatabase(context)
  await db.execute(sql`SELECT pg_advisory_xact_lock(${context.user.id}::bigint)`)
}

const getOwnedWritableWork = async (context: ActiveSessionContext, publicId: string): Promise<Work> => {
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
        { state: { in: uploadableStates } },
      ],
    },
  })
  const work = result.docs[0]
  if (!work) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }

  return work
}

const findOwnedAsset = async (
  context: ActiveSessionContext,
  work: Work,
  assetId: string,
): Promise<WorkAsset> => {
  if (!assetIdPattern.test(assetId)) {
    throw new BusinessApiError('ASSET_NOT_FOUND', '无法访问该文件。', 404)
  }

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
        { publicId: { equals: assetId } },
      ],
    },
  })
  const asset = result.docs[0]
  if (!asset || relationshipId(asset.owner) !== context.user.id || relationshipId(asset.work) !== work.id) {
    throw new BusinessApiError('ASSET_NOT_FOUND', '无法访问该文件。', 404)
  }

  return asset
}

const parseIntentResponse = (value: unknown): UploadIntentResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const response = value as Partial<UploadIntentResponse>
  if (
    !response.asset ||
    !assetIdPattern.test(response.asset.assetId) ||
    !response.expiresAt ||
    !response.upload ||
    response.upload.method !== 'PUT' ||
    typeof response.upload.url !== 'string'
  ) {
    return null
  }
  return response as UploadIntentResponse
}

const parseConfirmResponse = (value: unknown): ConfirmResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const response = value as Partial<ConfirmResponse>
  return response.asset && assetIdPattern.test(response.asset.assetId) ? (response as ConfirmResponse) : null
}

const assertCapacity = async (context: ActiveSessionContext, work: Work, sizeBytes: number): Promise<void> => {
  const db = await getTransactionDatabase(context)
  const statuses = sql`('upload_pending', 'uploaded', 'ready')`
  // Payload binds one PostgreSQL connection to this transaction. Keep these
  // aggregate queries sequential; Promise.all here would issue concurrent
  // client.query calls on a single transaction connection.
  const workUsage = await db.execute(sql`
    SELECT COUNT(*)::int AS asset_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes
    FROM work_assets
    WHERE owner_id = ${context.user.id} AND work_id = ${work.id} AND status IN ${statuses}`)
  const userUsage = await db.execute(sql`
    SELECT COUNT(*)::int AS asset_count, COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes
    FROM work_assets
    WHERE owner_id = ${context.user.id} AND status IN ${statuses}`)
  const workAssetCount = Number(workUsage.rows[0]?.asset_count ?? 0)
  const workBytes = Number(workUsage.rows[0]?.total_bytes ?? 0)
  const userBytes = Number(userUsage.rows[0]?.total_bytes ?? 0)

  if (workAssetCount >= MAX_IMAGES_PER_WORK || workBytes + sizeBytes > MAX_IMAGE_BYTES_PER_WORK) {
    throw new BusinessApiError('ASSET_LIMIT_REACHED', '该作品的图片数量或容量已达上限。', 409)
  }
  if (userBytes + sizeBytes > MAX_IMAGE_BYTES_PER_USER) {
    throw new BusinessApiError('ASSET_LIMIT_REACHED', '当前账号的图片容量已达上限。', 409)
  }
}

export const createUploadIntent = async (
  context: ActiveSessionContext,
  publicWorkId: string,
  input: ValidatedUploadIntentInput,
  keySha256: string,
): Promise<UploadIntentResponse> => {
  const route = `POST /api/v1/works/${publicWorkId}/assets/upload-intent`
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: input.requestSha256,
    responseStatus: 201,
    parseStoredResponse: parseIntentResponse,
    execute: async () => {
      const work = await getOwnedWritableWork(context, publicWorkId)
      await lockAssetCapacity(context)
      await assertCapacity(context, work, input.sizeBytes)
      const assetId = createAssetId()
      const expiresAt = new Date(Date.now() + UPLOAD_INTENT_LIFETIME_MS).toISOString()
      const asset = await context.payload.create({
        collection: 'work-assets',
        data: {
          publicId: assetId,
          owner: context.user.id,
          work: work.id,
          role: input.role,
          status: 'upload_pending',
          visibility: 'private',
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          storageKey: createLocalStorageKey(context.user.id, publicWorkId, assetId),
          uploadExpiresAt: expiresAt,
        },
        overrideAccess: false,
        req: context.req,
      })

      await recordAuthenticatedAuditEvent(context, {
        action: 'asset.upload_intent_created',
        outcome: 'allowed',
        resourcePublicId: asset.publicId,
        resourceType: 'asset',
        route: 'POST /api/v1/works/:id/assets/upload-intent',
      })

      return {
        asset: asAssetProjection(asset),
        expiresAt,
        upload: {
          method: 'PUT',
          url: `/api/v1/works/${publicWorkId}/assets/${assetId}/upload`,
        },
      }
    },
  })
}

export const uploadAssetBytes = async (
  context: ActiveSessionContext,
  publicWorkId: string,
  assetId: string,
  declaredContentType: string | null,
  content: Buffer,
): Promise<void> => {
  const work = await getOwnedWritableWork(context, publicWorkId)
  const asset = await findOwnedAsset(context, work, assetId)
  const expectedMimeType = asset.mimeType as AssetMimeType
  const declaredMimeType = parseMimeType(declaredContentType)

  if (declaredMimeType !== expectedMimeType) {
    throw new BusinessApiError('ASSET_TYPE_INVALID', '文件类型与上传意图不一致。', 422)
  }
  if (asset.status === 'uploaded' || asset.status === 'ready') {
    const inspectedIncoming = await inspectImageUpload(content, expectedMimeType)
    const existing = await readLocalObject(asset.storageKey)
    const inspectedExisting = await inspectImageUpload(existing, expectedMimeType)
    if (
      inspectedIncoming.sha256 === asset.sha256 &&
      inspectedExisting.sha256 === asset.sha256
    ) {
      return
    }
    throw new BusinessApiError('ASSET_UPLOAD_CONFLICT', '该文件已存在，不能覆盖。', 409)
  }
  if (asset.status !== 'upload_pending' || !asset.uploadExpiresAt || new Date(asset.uploadExpiresAt).getTime() <= Date.now()) {
    throw new BusinessApiError('ASSET_UPLOAD_EXPIRED', '上传授权已过期，请重新申请。', 409)
  }

  try {
    const inspected = await inspectImageUpload(content, expectedMimeType)
    if (inspected.sizeBytes !== asset.sizeBytes || inspected.sha256 !== asset.sha256) {
      throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件大小或内容校验失败。', 422)
    }
    await writeLocalObjectIfAbsent(asset.storageKey, content)
    const startedTransaction = await initTransaction(context.req as PayloadRequest)
    if (!startedTransaction && !context.req.transactionID) {
      throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
    }
    let transactionClosed = false
    try {
      await context.payload.update({
        collection: 'work-assets',
        id: asset.id,
        data: {
          detectedMimeType: inspected.detectedMimeType,
          status: 'uploaded',
          storageETag: inspected.sha256,
        },
        overrideAccess: false,
        req: context.req,
      })
      await recordAuthenticatedAuditEvent(context, {
        action: 'asset.uploaded',
        outcome: 'allowed',
        resourcePublicId: asset.publicId,
        resourceType: 'asset',
        route: 'PUT /api/v1/works/:id/assets/:assetId/upload',
      })
      if (startedTransaction) {
        await commitTransaction(context.req)
        transactionClosed = true
      }
    } catch (transactionError) {
      if (startedTransaction && !transactionClosed) {
        await killTransaction(context.req)
      }
      throw transactionError
    }
  } catch (error) {
    if (error instanceof BusinessApiError) {
      if (error.code !== 'ASSET_UPLOAD_CONFLICT') {
        await deleteLocalObject(asset.storageKey)
        await context.payload.update({
          collection: 'work-assets',
          id: asset.id,
          data: {
            status: 'validation_failed',
            orphanedAt: new Date().toISOString(),
            purgeAfter: new Date(Date.now() + ORPHAN_RETENTION_MS).toISOString(),
          },
          overrideAccess: false,
          req: context.req,
        })
      }
      throw error
    }
    throw error
  }
}

export const confirmAsset = async (
  context: ActiveSessionContext,
  publicWorkId: string,
  input: ValidatedConfirmAssetInput,
  keySha256: string,
): Promise<ConfirmResponse> => {
  const route = `POST /api/v1/works/${publicWorkId}/assets/confirm`
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: input.requestSha256,
    responseStatus: 200,
    parseStoredResponse: parseConfirmResponse,
    execute: async () => {
      const work = await getOwnedWritableWork(context, publicWorkId)
      const asset = await findOwnedAsset(context, work, input.assetId)
      if (asset.status === 'ready') {
        if (asset.sha256 !== input.sha256) {
          throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件内容校验失败。', 422)
        }
        return { asset: asAssetProjection(asset) }
      }
      if (asset.status !== 'uploaded' || asset.sha256 !== input.sha256) {
        throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件尚未通过上传校验。', 422)
      }

      const content = await readLocalObject(asset.storageKey)
      const inspected = await inspectImageUpload(content, asset.mimeType as AssetMimeType)
      if (
        inspected.sha256 !== asset.sha256 ||
        inspected.sizeBytes !== asset.sizeBytes ||
        inspected.detectedMimeType !== asset.mimeType
      ) {
        await deleteLocalObject(asset.storageKey)
        await context.payload.update({
          collection: 'work-assets',
          id: asset.id,
          data: {
            status: 'validation_failed',
            orphanedAt: new Date().toISOString(),
            purgeAfter: new Date(Date.now() + ORPHAN_RETENTION_MS).toISOString(),
          },
          overrideAccess: false,
          req: context.req,
        })
        throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件内容校验失败。', 422)
      }
      const ready = await context.payload.update({
        collection: 'work-assets',
        id: asset.id,
        data: {
          confirmedAt: new Date().toISOString(),
          status: 'ready',
        },
        overrideAccess: false,
        req: context.req,
      })
      await recordAuthenticatedAuditEvent(context, {
        action: 'asset.confirmed',
        outcome: 'allowed',
        resourcePublicId: ready.publicId,
        resourceType: 'asset',
        route: 'POST /api/v1/works/:id/assets/confirm',
      })
      return { asset: asAssetProjection(ready) }
    },
  })
}

export const readReadyAsset = async (
  context: ActiveSessionContext,
  publicWorkId: string,
  assetId: string,
): Promise<{ content: Buffer; mimeType: AssetMimeType }> => {
  const work = await getOwnedWritableWork(context, publicWorkId)
  const asset = await findOwnedAsset(context, work, assetId)
  if (asset.status !== 'ready' || !(await localObjectExists(asset.storageKey))) {
    throw new BusinessApiError('ASSET_NOT_FOUND', '无法访问该文件。', 404)
  }
  return { content: await readLocalObject(asset.storageKey), mimeType: asset.mimeType as AssetMimeType }
}

export const purgeExpiredOrphanedAssets = async (
  context: Pick<ActiveSessionContext, 'payload'>,
): Promise<number> => {
  const now = new Date().toISOString()
  const result = await context.payload.find({
    collection: 'work-assets',
    depth: 0,
    limit: 100,
    overrideAccess: true,
    where: {
      or: [
        {
          and: [
            { status: { in: ['upload_pending', 'uploaded'] } },
            { uploadExpiresAt: { less_than: now } },
          ],
        },
        { and: [{ status: { equals: 'validation_failed' } }, { purgeAfter: { less_than: now } }] },
        { and: [{ status: { equals: 'orphaned' } }, { purgeAfter: { less_than: now } }] },
      ],
    },
  })
  for (const asset of result.docs) {
    await deleteLocalObject(asset.storageKey)
    await context.payload.delete({
      collection: 'work-assets',
      id: asset.id,
      overrideAccess: true,
    })
  }
  return result.docs.length
}
