// 文件开头说明：这些集合由 Better Auth 插件补齐字段。这里只收紧 Payload 原始
// REST 的访问面：认证适配器可内部读写，Payload Admin 仅限 Admin，前端只走 /api/v1。
import type { CollectionConfig } from 'payload'

import { allowBetterAuthOrAdmin } from '@/collections/Users'

const createAuthInternalCollection = (slug: string): CollectionConfig => ({
  slug,
  access: {
    create: allowBetterAuthOrAdmin,
    read: allowBetterAuthOrAdmin,
    update: allowBetterAuthOrAdmin,
    delete: allowBetterAuthOrAdmin,
  },
  fields: [],
})

export const authInternalCollections: CollectionConfig[] = [
  createAuthInternalCollection('accounts'),
  createAuthInternalCollection('sessions'),
  createAuthInternalCollection('verifications'),
  createAuthInternalCollection('rateLimit'),
]
