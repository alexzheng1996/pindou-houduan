// 文件开头说明：M1 本机文件替身只把已验证的测试对象写入项目内且被 Git 忽略的
// 目录。它不生成公开 URL，也不适合作为 Docker、team-test 或生产的长期存储。
import { randomUUID } from 'crypto'
import { access, link, mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'

import { BusinessApiError } from '@/api/business-http'
import { runtimeConfig } from '@/config/runtime'

const localStorageRoot = path.resolve(process.cwd(), 'data/local-object-store')
const localStorageRootPrefix = `${localStorageRoot}${path.sep}`

const assertLocalStorage = (): void => {
  if (runtimeConfig.appEnv !== 'local') {
    throw new BusinessApiError(
      'LOCAL_STORAGE_UNAVAILABLE',
      '当前环境未配置可用的私有文件存储。',
      503,
    )
  }
}

const resolveStoragePath = (storageKey: string): string => {
  const target = path.resolve(localStorageRoot, storageKey)

  if (!target.startsWith(localStorageRootPrefix)) {
    throw new BusinessApiError('ASSET_VALIDATION_FAILED', '文件存储状态无效。', 422)
  }

  return target
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export const createLocalStorageKey = (ownerId: number, workId: string, assetId: string): string =>
  path.posix.join('objects', String(ownerId), workId, assetId)

export const writeLocalObjectIfAbsent = async (storageKey: string, content: Buffer): Promise<void> => {
  assertLocalStorage()
  const target = resolveStoragePath(storageKey)
  const stagingDirectory = path.join(localStorageRoot, '.staging')
  const temporaryFile = path.join(stagingDirectory, `${randomUUID()}.uploading`)

  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 })

  if (await exists(target)) {
    throw new BusinessApiError('ASSET_UPLOAD_CONFLICT', '该文件已存在，不能覆盖。', 409)
  }

  try {
    await writeFile(temporaryFile, content, { flag: 'wx', mode: 0o600 })
    // link is atomic and never replaces an existing destination. This prevents a
    // retry or an unexpected duplicate request from silently overwriting bytes.
    await link(temporaryFile, target)
  } catch (error) {
    if (await exists(target)) {
      throw new BusinessApiError('ASSET_UPLOAD_CONFLICT', '该文件已存在，不能覆盖。', 409)
    }

    throw error
  } finally {
    await rm(temporaryFile, { force: true })
  }
}

export const readLocalObject = async (storageKey: string): Promise<Buffer> => {
  assertLocalStorage()

  try {
    return await readFile(resolveStoragePath(storageKey))
  } catch {
    throw new BusinessApiError('ASSET_NOT_FOUND', '无法访问该文件。', 404)
  }
}

export const localObjectExists = async (storageKey: string): Promise<boolean> => {
  assertLocalStorage()
  return exists(resolveStoragePath(storageKey))
}

export const deleteLocalObject = async (storageKey: string): Promise<void> => {
  assertLocalStorage()
  await rm(resolveStoragePath(storageKey), { force: true })
}
