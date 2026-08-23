// 文件开头说明：M1 文件入站校验只接受可安全解码的 PNG、JPEG、WebP。声明的
// MIME/大小/哈希只作为承诺；上传和确认都会按实际字节再次验证。
import { createHash } from 'crypto'

import { fileTypeFromBuffer } from 'file-type'
import sharp from 'sharp'
import { z } from 'zod'

import { BusinessApiError, sha256, stableStringify } from '@/api/business-http'

export const MAX_ASSET_BYTES = 15 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 40_000_000
export const MAX_IMAGES_PER_WORK = 10
export const MAX_IMAGE_BYTES_PER_WORK = 100 * 1024 * 1024
export const MAX_IMAGE_BYTES_PER_USER = 2 * 1024 * 1024 * 1024
export const UPLOAD_INTENT_LIFETIME_MS = 15 * 60 * 1000
export const ORPHAN_RETENTION_MS = 24 * 60 * 60 * 1000

const supportedRoles = ['original', 'display', 'thumbnail'] as const
const supportedMimeTypes = ['image/png', 'image/jpeg', 'image/webp'] as const
const sha256Pattern = /^[a-f0-9]{64}$/

const uploadIntentSchema = z
  .object({
    mimeType: z.enum(supportedMimeTypes),
    role: z.enum(supportedRoles),
    sha256: z.string().regex(sha256Pattern),
    sizeBytes: z.number().int().positive().max(MAX_ASSET_BYTES),
  })
  .strict()

const confirmAssetSchema = z
  .object({
    assetId: z.string().regex(/^asset_[a-f0-9]{32}$/),
    sha256: z.string().regex(sha256Pattern),
  })
  .strict()

export type AssetRole = (typeof supportedRoles)[number]
export type AssetMimeType = (typeof supportedMimeTypes)[number]

export type ValidatedUploadIntentInput = {
  mimeType: AssetMimeType
  requestSha256: string
  role: AssetRole
  sha256: string
  sizeBytes: number
}

export type ValidatedConfirmAssetInput = {
  assetId: string
  requestSha256: string
  sha256: string
}

const hash = (content: Buffer): string => createHash('sha256').update(content).digest('hex')

export const validateUploadIntentInput = (value: unknown): ValidatedUploadIntentInput => {
  const parsed = uploadIntentSchema.safeParse(value)
  if (!parsed.success) {
    throw new BusinessApiError('ASSET_TYPE_INVALID', '文件上传参数无效。', 422)
  }

  const input = parsed.data
  return {
    ...input,
    requestSha256: sha256(stableStringify(input)),
  }
}

export const validateConfirmAssetInput = (value: unknown): ValidatedConfirmAssetInput => {
  const parsed = confirmAssetSchema.safeParse(value)
  if (!parsed.success) {
    throw new BusinessApiError('REQUEST_INVALID', '文件确认参数无效。', 400)
  }

  const input = parsed.data
  return {
    ...input,
    requestSha256: sha256(stableStringify(input)),
  }
}

export const parseMimeType = (value: string | null): string | null => {
  if (!value) {
    return null
  }

  return value.split(';', 1)[0]?.trim().toLowerCase() || null
}

export const inspectImageUpload = async (
  content: Buffer,
  expectedMimeType: AssetMimeType,
): Promise<{ detectedMimeType: AssetMimeType; sha256: string; sizeBytes: number }> => {
  if (content.length < 1 || content.length > MAX_ASSET_BYTES) {
    throw new BusinessApiError('ASSET_TOO_LARGE', '文件大小超出当前限制。', 413)
  }

  const detected = await fileTypeFromBuffer(content)
  if (!detected || !supportedMimeTypes.includes(detected.mime as AssetMimeType)) {
    throw new BusinessApiError('ASSET_TYPE_INVALID', '仅支持 PNG、JPEG 或 WebP 图片。', 422)
  }

  const detectedMimeType = detected.mime as AssetMimeType
  if (detectedMimeType !== expectedMimeType) {
    throw new BusinessApiError('ASSET_TYPE_INVALID', '文件实际类型与上传声明不一致。', 422)
  }

  try {
    const metadata = await sharp(content, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
    const actualMimeType = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`
    const pixelCount = (metadata.width ?? 0) * (metadata.height ?? 0)

    if (
      actualMimeType !== detectedMimeType ||
      !metadata.width ||
      !metadata.height ||
      pixelCount > MAX_IMAGE_PIXELS
    ) {
      throw new BusinessApiError('ASSET_TYPE_INVALID', '图片内容无法通过安全校验。', 422)
    }
  } catch (error) {
    if (error instanceof BusinessApiError) {
      throw error
    }

    throw new BusinessApiError('ASSET_TYPE_INVALID', '图片内容无法通过安全校验。', 422)
  }

  return {
    detectedMimeType,
    sha256: hash(content),
    sizeBytes: content.length,
  }
}
