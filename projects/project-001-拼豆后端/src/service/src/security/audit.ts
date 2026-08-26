// 文件开头说明：M1 只记录安全操作所需的最小审计证据：操作者、动作、结果、
// 资源公开 ID、请求 ID 和非敏感原因码。不得写入邮箱、IP、Cookie、密码、OTP、
// 文件路径、存储键、请求体或响应体；审计记录不是业务数据的第二真值。
import { randomUUID } from 'crypto'

import type { Payload, PayloadRequest } from 'payload'
import { sql } from '@payloadcms/db-postgres'

import type { ActiveSessionContext } from '@/auth/require-session'

type QueryablePool = {
  query: (query: string, parameters: readonly unknown[]) => Promise<unknown>
}

type TransactionDatabase = {
  execute: (query: unknown) => Promise<unknown>
}

export type SecurityAuditAction =
  | 'asset.downloaded'
  | 'asset.upload_intent_created'
  | 'asset.uploaded'
  | 'asset.confirmed'
  | 'auth.email_verified'
  | 'auth.google_callback'
  | 'auth.login_blocked'
  | 'auth.login_failed'
  | 'auth.login_succeeded'
  | 'auth.password_reset_completed'
  | 'auth.password_reset_requested'
  | 'auth.registration'
  | 'rate_limit.denied'
  | 'inventory.adjusted'
  | 'inventory.import_committed'
  | 'inventory.import_previewed'
  | 'inventory.operation_reversed'
  | 'inventory.settings_updated'
  | 'inventory.work_completed'
  | 'work.created'
  | 'work.deletion_requested'
  | 'work.document_saved'
  | 'work.draft_cancelled'
  | 'work.restored'
  | 'library.folder_created'
  | 'library.label_created'
  | 'library.metadata_updated'
  | 'community.published'
  | 'community.copied'
  | 'community.interaction'
  | 'community.reported'
  | 'community.moderated'
  | 'community.profile_updated'
  | 'content.draft_created'
  | 'content.draft_updated'

export type SecurityAuditInput = {
  action: SecurityAuditAction
  actorId?: number | null
  outcome: 'allowed' | 'denied'
  reasonCode?: string
  requestId: string
  resourcePublicId?: string
  resourceType?: 'asset' | 'inventory_import' | 'inventory_operation' | 'inventory_settings' | 'work' | 'library' | 'community' | 'content'
  route: string
}

const getPool = (payload: Payload): QueryablePool => {
  const pool = (payload.db as unknown as { pool?: QueryablePool }).pool
  if (!pool) {
    throw new Error('M1 审计记录需要 PostgreSQL 连接池。')
  }
  return pool
}

export const recordSecurityAuditEvent = async (
  payload: Payload,
  input: SecurityAuditInput,
): Promise<void> => {
  await getPool(payload).query(
    `INSERT INTO security_audit_events
       (actor_id, action, outcome, route, resource_type, resource_public_id, request_id, reason_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.actorId ?? null,
      input.action,
      input.outcome,
      input.route,
      input.resourceType ?? null,
      input.resourcePublicId ?? null,
      input.requestId,
      input.reasonCode ?? null,
    ],
  )
}

export const recordAuthenticatedAuditEvent = async (
  context: Pick<ActiveSessionContext, 'payload' | 'req' | 'requestId' | 'user'>,
  input: Omit<SecurityAuditInput, 'actorId' | 'requestId'>,
): Promise<void> => {
  const transactionId = await context.req.transactionID
  const db = transactionId
    ? (context.payload.db.sessions?.[transactionId]?.db as TransactionDatabase | undefined)
    : undefined

  if (!db) {
    await recordSecurityAuditEvent(context.payload, {
      ...input,
      actorId: context.user.id,
      requestId: context.requestId,
    })
    return
  }

  await db.execute(sql`
    INSERT INTO security_audit_events
      (actor_id, action, outcome, route, resource_type, resource_public_id, request_id, reason_code)
    VALUES (
      ${context.user.id},
      ${input.action},
      ${input.outcome},
      ${input.route},
      ${input.resourceType ?? null},
      ${input.resourcePublicId ?? null},
      ${context.requestId},
      ${input.reasonCode ?? null}
    )`)
}

// Payload Admin writes do not use the browser business route helpers, but they
// still need the same minimal audit trail. This intentionally accepts only
// fixed metadata and never a document body, media byte stream, storage key or
// request body.
export const recordPayloadRequestAuditEvent = async (
  payload: Payload,
  req: PayloadRequest,
  input: Omit<SecurityAuditInput, 'actorId' | 'requestId'>,
): Promise<void> => {
  const actorId = typeof req.user?.id === 'number'
    ? req.user.id
    : typeof req.user?.id === 'string' && /^\d+$/.test(req.user.id)
      ? Number(req.user.id)
      : null
  const contextRequestId = req.context?.requestId
  const requestId = typeof contextRequestId === 'string' && contextRequestId.length <= 64
    ? contextRequestId
    : randomUUID()
  const transactionId = await req.transactionID
  const db = transactionId
    ? (payload.db.sessions?.[transactionId]?.db as TransactionDatabase | undefined)
    : undefined

  if (!db) {
    await recordSecurityAuditEvent(payload, { ...input, actorId, requestId })
    return
  }

  await db.execute(sql`
    INSERT INTO security_audit_events
      (actor_id, action, outcome, route, resource_type, resource_public_id, request_id, reason_code)
    VALUES (
      ${actorId},
      ${input.action},
      ${input.outcome},
      ${input.route},
      ${input.resourceType ?? null},
      ${input.resourcePublicId ?? null},
      ${requestId},
      ${input.reasonCode ?? null}
    )`)
}
