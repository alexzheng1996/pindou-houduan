// 文件开头说明：Cloudflare R2 的 S3 兼容适配器。它只接受服务端生成的 storageKey，
// 不生成公开 URL；条件写入失败只能被解释为冲突，绝不覆盖已有对象。

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

import {
  assertObjectStorageKey,
  ObjectStoreConflictError,
  ObjectStoreNotFoundError,
  ObjectStoreUnavailableError,
  type ObjectStore,
} from '@/storage/object-store'

export type R2ObjectStoreOptions = {
  accountId: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  region: string
  client?: Pick<S3Client, 'send'>
}

const isNotFound = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return value.name === 'NoSuchKey' || value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404
}

const isConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return (
    value.name === 'PreconditionFailed' ||
    value.name === 'ConditionalRequestConflict' ||
    value.$metadata?.httpStatusCode === 409 ||
    value.$metadata?.httpStatusCode === 412
  )
}

const toUnavailable = (error: unknown): ObjectStoreUnavailableError => {
  const wrapped = new ObjectStoreUnavailableError()
  wrapped.cause = error
  return wrapped
}

export class R2ObjectStore implements ObjectStore {
  private readonly client: Pick<S3Client, 'send'>
  private readonly bucket: string

  constructor(options: R2ObjectStoreOptions) {
    this.client = options.client ?? new S3Client({
      region: options.region,
      endpoint: `https://${options.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    })
    this.bucket = options.bucket
  }

  async putIfAbsent(storageKey: string, content: Buffer): Promise<void> {
    assertObjectStorageKey(storageKey)
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: content,
        IfNoneMatch: '*',
      }))
    } catch (error) {
      if (isConflict(error)) throw new ObjectStoreConflictError()
      throw toUnavailable(error)
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    assertObjectStorageKey(storageKey)
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      if (!response.Body) throw new ObjectStoreNotFoundError()
      return Buffer.from(await response.Body.transformToByteArray())
    } catch (error) {
      if (error instanceof ObjectStoreNotFoundError || isNotFound(error)) throw new ObjectStoreNotFoundError()
      throw toUnavailable(error)
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    assertObjectStorageKey(storageKey)
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: storageKey }))
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw toUnavailable(error)
    }
  }

  async delete(storageKey: string): Promise<void> {
    assertObjectStorageKey(storageKey)
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }))
    } catch (error) {
      throw toUnavailable(error)
    }
  }
}
