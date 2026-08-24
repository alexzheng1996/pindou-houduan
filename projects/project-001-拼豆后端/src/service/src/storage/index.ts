// 文件开头说明：按运行时环境选择私有对象存储适配器。team-test 缺少 R2 配置时由
// runtime.ts 在进程启动前拒绝，不能回退到本机磁盘。

import { createRuntimeConfig, runtimeConfig, type RuntimeEnvironment } from '@/config/runtime'
import { R2ObjectStore } from '@/storage/r2-object-store'
import { LocalObjectStore } from '@/storage/local-object-store'
import type { ObjectStore } from '@/storage/object-store'

let cachedObjectStore: ObjectStore | undefined

export const createConfiguredObjectStore = (environment: RuntimeEnvironment = process.env): ObjectStore => {
  const config = environment === process.env ? runtimeConfig : createRuntimeConfig(environment)
  if (config.objectStorage.mode === 'local') {
    return new LocalObjectStore()
  }

  const accessKeyId = environment.R2_ACCESS_KEY_ID?.trim()
  const secretAccessKey = environment.R2_SECRET_ACCESS_KEY?.trim()
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('R2 对象存储凭据未配置。')
  }
  return new R2ObjectStore({
    accountId: config.objectStorage.accountId,
    bucket: config.objectStorage.bucket,
    accessKeyId,
    secretAccessKey,
    region: config.objectStorage.region,
  })
}

export const getObjectStore = (): ObjectStore => {
  cachedObjectStore ??= createConfiguredObjectStore()
  return cachedObjectStore
}

export const resetObjectStoreForTests = (): void => {
  cachedObjectStore = undefined
}
