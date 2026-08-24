// 文件开头说明：对象存储端口的本机无凭据验证。测试只使用内存 fake、临时本地对象
// 和假的 S3 send 客户端，不创建 R2 桶、不连接云端，也不写入任何真实凭据。
import { randomUUID } from 'crypto'

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import { createRuntimeConfig } from '@/config/runtime'
import {
  MemoryObjectStore,
  ObjectStoreConflictError,
  ObjectStoreNotFoundError,
  ObjectStoreUnavailableError,
} from '@/storage/object-store'
import { LocalObjectStore } from '@/storage/local-object-store'
import { R2ObjectStore } from '@/storage/r2-object-store'

const teamTestEnvironment = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'test',
  APP_ENV: 'team-test',
  AUTH_BASE_URL: 'https://api-test.pixomosaic.example',
  ALLOWED_ORIGINS: 'https://app-test.pixomosaic.example',
  CSRF_ORIGINS: 'https://app-test.pixomosaic.example',
  MAIL_TRANSPORT: 'resend',
  RESEND_API_KEY: 'not-a-real-test-key',
  MAIL_FROM_ADDRESS: 'no-reply@test.pixomosaic.example',
  MAIL_FROM_NAME: 'PixoMosaic Test',
  OBJECT_STORAGE_MODE: 'r2',
  R2_ACCOUNT_ID: 'a'.repeat(32),
  R2_BUCKET: 'pixomosaic-team-test',
  R2_ACCESS_KEY_ID: 'not-a-real-access-key',
  R2_SECRET_ACCESS_KEY: 'not-a-real-secret-key',
  R2_REGION: 'auto',
  ...overrides,
})

describe('M1 对象存储运行时门禁', () => {
  it('local 默认只选择本机适配器，并拒绝误用 R2', () => {
    expect(createRuntimeConfig({ APP_ENV: 'local' }).objectStorage).toEqual({ mode: 'local' })
    expect(() => createRuntimeConfig({ APP_ENV: 'local', OBJECT_STORAGE_MODE: 'r2' })).toThrow('APP_ENV=local')
  })

  it('team-test 必须完整配置 R2，且返回对象不包含任何密钥', () => {
    const config = createRuntimeConfig(teamTestEnvironment())
    expect(config.objectStorage).toMatchObject({
      mode: 'r2',
      accountId: 'a'.repeat(32),
      bucket: 'pixomosaic-team-test',
      region: 'auto',
      endpoint: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com',
    })
    expect(JSON.stringify(config.objectStorage)).not.toContain('not-a-real-access-key')
    expect(JSON.stringify(config.objectStorage)).not.toContain('not-a-real-secret-key')
    expect(() => createRuntimeConfig(teamTestEnvironment({ R2_SECRET_ACCESS_KEY: undefined }))).toThrow('R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY 和 R2_REGION')
    expect(() => createRuntimeConfig(teamTestEnvironment({ OBJECT_STORAGE_MODE: 'local' }))).toThrow('APP_ENV=team-test')
    expect(() => createRuntimeConfig(teamTestEnvironment({ R2_BUCKET: 'Not A Bucket' }))).toThrow('R2_BUCKET')
    expect(() => createRuntimeConfig(teamTestEnvironment({ R2_BUCKET: 'ab' }))).toThrow('R2_BUCKET')
  })
})

describe('M1 对象存储适配器', () => {
  it('MemoryObjectStore 支持条件写入、复制读取、存在检查、删除和可注入失败', async () => {
    const store = new MemoryObjectStore()
    const content = Buffer.from('m1-object-storage')
    await store.putIfAbsent('objects/test/object', content)
    content[0] = 0
    await expect(store.putIfAbsent('objects/test/object', Buffer.from('different'))).rejects.toBeInstanceOf(ObjectStoreConflictError)
    await expect(store.read('objects/test/object')).resolves.toEqual(Buffer.from('m1-object-storage'))
    await expect(store.exists('objects/test/object')).resolves.toBe(true)
    await store.delete('objects/test/object')
    await expect(store.exists('objects/test/object')).resolves.toBe(false)
    await expect(store.read('objects/test/object')).rejects.toBeInstanceOf(ObjectStoreNotFoundError)

    const failing = new MemoryObjectStore({ beforeDelete: () => { throw new ObjectStoreUnavailableError() } })
    await failing.putIfAbsent('objects/test/failing-delete', Buffer.from('x'))
    await expect(failing.delete('objects/test/failing-delete')).rejects.toBeInstanceOf(ObjectStoreUnavailableError)
  })

  it('LocalObjectStore 保留 M1 条件写入行为且不会覆盖已有对象', async () => {
    const store = new LocalObjectStore()
    const key = `objects/test/${randomUUID()}`
    try {
      await store.putIfAbsent(key, Buffer.from('local-object'))
      await expect(store.read(key)).resolves.toEqual(Buffer.from('local-object'))
      await expect(store.putIfAbsent(key, Buffer.from('different'))).rejects.toBeInstanceOf(ObjectStoreConflictError)
      await store.delete(key)
      await expect(store.exists(key)).resolves.toBe(false)
    } finally {
      await store.delete(key).catch(() => undefined)
    }
  })

  it('R2 adapter 只发出私有 S3 Put/Get/Head/Delete 命令，并映射条件冲突与缺失', async () => {
    const objects = new Map<string, Buffer>()
    const commands: string[] = []
    const fakeClient = {
      async send(command: unknown): Promise<unknown> {
        if (command instanceof PutObjectCommand) {
          commands.push('put')
          const key = command.input.Key
          if (!key) throw new Error('missing S3 key')
          if (objects.has(key)) {
            const error = Object.assign(new Error('precondition'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } })
            throw error
          }
          objects.set(key, Buffer.from(command.input.Body as Uint8Array))
          expect(command.input.IfNoneMatch).toBe('*')
          return {}
        }
        if (command instanceof GetObjectCommand) {
          commands.push('get')
          const key = command.input.Key
          if (!key) throw new Error('missing S3 key')
          const value = objects.get(key)
          if (!value) throw Object.assign(new Error('missing'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } })
          return { Body: { transformToByteArray: async () => Uint8Array.from(value) } }
        }
        if (command instanceof HeadObjectCommand) {
          commands.push('head')
          const key = command.input.Key
          if (!key) throw new Error('missing S3 key')
          if (!objects.has(key)) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })
          return {}
        }
        if (command instanceof DeleteObjectCommand) {
          commands.push('delete')
          const key = command.input.Key
          if (!key) throw new Error('missing S3 key')
          objects.delete(key)
          return {}
        }
        throw new Error('unexpected S3 command')
      },
    }
    const store = new R2ObjectStore({
      accountId: 'a'.repeat(32),
      bucket: 'pixomosaic-team-test',
      accessKeyId: 'not-a-real-access-key',
      secretAccessKey: 'not-a-real-secret-key',
      region: 'auto',
      client: fakeClient as unknown as Pick<S3Client, 'send'>,
    })

    await store.putIfAbsent('objects/test/r2', Buffer.from('r2-object'))
    await expect(store.putIfAbsent('objects/test/r2', Buffer.from('different'))).rejects.toBeInstanceOf(ObjectStoreConflictError)
    await expect(store.read('objects/test/r2')).resolves.toEqual(Buffer.from('r2-object'))
    await expect(store.exists('objects/test/r2')).resolves.toBe(true)
    await store.delete('objects/test/r2')
    await expect(store.exists('objects/test/r2')).resolves.toBe(false)
    await expect(store.read('objects/test/r2')).rejects.toBeInstanceOf(ObjectStoreNotFoundError)
    expect(commands).toEqual(['put', 'put', 'get', 'head', 'delete', 'head', 'get'])
  })
})
