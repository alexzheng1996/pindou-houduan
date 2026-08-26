// 文件开头说明：认证内部集合由 Better Auth 插件生成。插件会重建同 slug 集合，
// 因此权限必须通过其 collectionOverrides 注入；不能只把同名集合放进 Payload 配置。
import type { CollectionConfig } from 'payload'

import { allowBetterAuthOrAdmin } from '@/collections/Users'

// Better Auth 内部适配器带有受信任上下文标记，仍能按需读写这些集合。所有普通
// Payload 会话（包括为内容草稿开放后台入口的 Staff）只可由 Admin 读取。
export const restrictAuthInternalCollection = (collection: CollectionConfig): CollectionConfig => ({
  ...collection,
  admin: { hidden: true },
  access: {
    create: allowBetterAuthOrAdmin,
    read: allowBetterAuthOrAdmin,
    update: allowBetterAuthOrAdmin,
    delete: allowBetterAuthOrAdmin,
  },
})

// These stubs keep the internal collections explicit in the application
// configuration and provide the rateLimit collection that Better Auth leaves
// as an incoming Payload collection. For accounts/sessions/verifications,
// Better Auth rebuilds their schema and the overrides in auth/config.ts repeat
// the same access boundary on the generated collection.
const createAuthInternalCollection = (slug: string): CollectionConfig =>
  restrictAuthInternalCollection({ slug, fields: [] })

export const authInternalCollections: CollectionConfig[] = [
  createAuthInternalCollection('accounts'),
  createAuthInternalCollection('sessions'),
  createAuthInternalCollection('verifications'),
  createAuthInternalCollection('rateLimit'),
]
