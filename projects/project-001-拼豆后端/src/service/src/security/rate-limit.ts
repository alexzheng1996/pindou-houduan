// 文件开头说明：M1 应用级限流保护已登录的作品、上传与私有下载入口。认证入口
// 继续复用 Better Auth 的数据库限流；本模块不采集 IP 或设备指纹，只按已验证
// 用户和操作类别计数，避免把隐私数据写入本机开发数据库。
import type { Payload } from 'payload'

import { BusinessApiError } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'

type QueryablePool = {
  query: (
    query: string,
    parameters: readonly unknown[],
  ) => Promise<{ rows: Array<{ request_count: number | string }> }>
}

type RateLimitPolicy = {
  maximum: number
  scope:
    | 'asset-confirm'
    | 'asset-download'
    | 'asset-intent'
    | 'asset-upload'
    | 'inventory-read'
    | 'inventory-write'
    | 'work-inventory-read'
    | 'work-write'
  windowMilliseconds: number
}

const policies = {
  assetConfirm: { maximum: 12, scope: 'asset-confirm', windowMilliseconds: 10 * 60_000 },
  assetDownload: { maximum: 20, scope: 'asset-download', windowMilliseconds: 10 * 60_000 },
  assetIntent: { maximum: 12, scope: 'asset-intent', windowMilliseconds: 10 * 60_000 },
  assetUpload: { maximum: 15, scope: 'asset-upload', windowMilliseconds: 10 * 60_000 },
  inventoryRead: { maximum: 120, scope: 'inventory-read', windowMilliseconds: 10 * 60_000 },
  inventoryWrite: { maximum: 60, scope: 'inventory-write', windowMilliseconds: 10 * 60_000 },
  workInventoryRead: { maximum: 120, scope: 'work-inventory-read', windowMilliseconds: 10 * 60_000 },
  // 上限需要允许用户在导入已有本地作品时完成 50 份云端首存；仍能阻断无节制
  // 自动保存。真实 team-test 流量与前端自动保存策略确认后再收紧。
  workWrite: { maximum: 120, scope: 'work-write', windowMilliseconds: 10 * 60_000 },
} as const satisfies Record<string, RateLimitPolicy>

export type AuthenticatedRateLimit = keyof typeof policies

const getPool = (payload: Payload): QueryablePool => {
  const pool = (payload.db as unknown as { pool?: QueryablePool }).pool
  if (!pool) {
    throw new Error('M1 应用级限流需要 PostgreSQL 连接池。')
  }
  return pool
}

const getWindowStart = (windowMilliseconds: number): Date =>
  new Date(Math.floor(Date.now() / windowMilliseconds) * windowMilliseconds)

export const enforceAuthenticatedRateLimit = async (
  context: ActiveSessionContext,
  limit: AuthenticatedRateLimit,
  route: string,
): Promise<void> => {
  const policy = policies[limit]
  const windowStart = getWindowStart(policy.windowMilliseconds)
  const result = await getPool(context.payload).query(
    `INSERT INTO api_rate_limit_buckets
       (actor_id, scope, window_started_at, request_count, updated_at)
     VALUES ($1, $2, $3, 1, NOW())
     ON CONFLICT (actor_id, scope, window_started_at)
     DO UPDATE SET request_count = api_rate_limit_buckets.request_count + 1, updated_at = NOW()
       WHERE api_rate_limit_buckets.request_count < $4
     RETURNING request_count`,
    [context.user.id, policy.scope, windowStart.toISOString(), policy.maximum],
  )

  if (result.rows[0]) {
    return
  }

  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowStart.getTime() + policy.windowMilliseconds - Date.now()) / 1000),
  )
  try {
    await recordAuthenticatedAuditEvent(context, {
      action: 'rate_limit.denied',
      outcome: 'denied',
      reasonCode: policy.scope,
      route,
    })
  } catch {
    // 限流本身是优先级更高的保护，审计存储短暂不可用不能让超额请求穿透。
  }
  throw new BusinessApiError(
    'RATE_LIMITED',
    '当前操作过于频繁，请稍后再试。',
    429,
    { retryAfterSeconds },
    { 'Retry-After': String(retryAfterSeconds) },
  )
}
