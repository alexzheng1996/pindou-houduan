// 文件开头说明：M1 本机文件替身只把已验证的测试对象写入项目内且被 Git 忽略的
// 目录。它不生成公开 URL，也不适合作为 Docker、team-test 或生产的长期存储。
import { randomUUID } from 'crypto'
import { access, link, mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'

import { BusinessApiError } from '@/api/business-http'
import { runtimeConfig } from '@/config/runtime'
import {
  assertObjectStorageKey,
  createObjectStorageKey,
  ObjectStoreConflictError,
  ObjectStoreNotFoundError,
  type ObjectStore,
} from '@/storage/object-store'

const localStorageRoot = path.resolve(process.cwd(), 'data/local-object-store')
const localStorageRootPrefix = `${localStorageRoot}${path.sep}`

const assertLocalStorage = (): void => {
  if (runtimeConfig.appEnv !== 'local') {
    throw new BusinessApiError('LOCAL_STORAGE_UNAVAILABLE', '当前环境未配置可用的私有文件存储。', 503)
  }
}

const resolveStoragePath = (storageKey: string): string => {
  const target = path.resolve(localStorageRoot, storageKey)
  if (!target.startsWith(localStorageRootPrefix)) {
    throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件存储状态无效。', 422)
  }
  return target
}

const existsAtPath = async (target: string): Promise<boolean> => {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

// M1 旧调用方保留这个名称；新业务统一使用 createObjectStorageKey。
export const createLocalStorageKey = createObjectStorageKey

export class LocalObjectStore implements ObjectStore {
  async putIfAbsent(storageKey: string, content: Buffer): Promise<void> {
    assertObjectStorageKey(storageKey)
    assertLocalStorage()
    const target = resolveStoragePath(storageKey)
    const stagingDirectory = path.join(localStorageRoot, '.staging')
    const temporaryFile = path.join(stagingDirectory, `${randomUUID()}.uploading`)

    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })
    if (await existsAtPath(target)) throw new ObjectStoreConflictError()

    try {
      await writeFile(temporaryFile, content, { flag: 'wx', mode: 0o600 })
      // link is atomic and never replaces an existing destination.
      await link(temporaryFile, target)
    } catch (error) {
      if (await existsAtPath(target)) throw new ObjectStoreConflictError()
      throw error
    } finally {
      await rm(temporaryFile, { force: true })
    }
  }

  async read(storageKey: string): Promise<Buffer> {
    assertObjectStorageKey(storageKey)
    assertLocalStorage()
    try {
      return await readFile(resolveStoragePath(storageKey))
    } catch {
      throw new ObjectStoreNotFoundError()
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    assertObjectStorageKey(storageKey)
    assertLocalStorage()
    return existsAtPath(resolveStoragePath(storageKey))
  }

  async delete(storageKey: string): Promise<void> {
    assertObjectStorageKey(storageKey)
    assertLocalStorage()
    await rm(resolveStoragePath(storageKey), { force: true })
  }
}

// 兼容既有 M1 资产、社区和清理逻辑；后续业务接入统一端口时使用 storage/index.ts。
const localObjectStore = new LocalObjectStore()

export const writeLocalObjectIfAbsent = async (storageKey: string, content: Buffer): Promise<void> => {
  try {
    await localObjectStore.putIfAbsent(storageKey, content)
  } catch (error) {
    if (error instanceof ObjectStoreConflictError) {
      throw new BusinessApiError('ASSET_UPLOAD_CONFLICT', '该文件已存在，不能覆盖。', 409)
    }
    throw error
  }
}

export const readLocalObject = async (storageKey: string): Promise<Buffer> => {
  try {
    return await localObjectStore.read(storageKey)
  } catch (error) {
    if (error instanceof ObjectStoreNotFoundError) {
      throw new BusinessApiError('ASSET_NOT_FOUND', '无法访问该文件。', 404)
    }
    throw error
  }
}

export const localObjectExists = async (storageKey: string): Promise<boolean> => localObjectStore.exists(storageKey)

export const deleteLocalObject = async (storageKey: string): Promise<void> => localObjectStore.delete(storageKey)
