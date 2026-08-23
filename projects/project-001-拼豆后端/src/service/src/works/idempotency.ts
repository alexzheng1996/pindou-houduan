// 文件开头说明：M1 所有业务写操作共用的数据库幂等执行器。它把幂等记录和实际
// 写入放在同一 Payload/PostgreSQL 事务中，避免浏览器重试或多实例重复改变状态。
import { commitTransaction, initTransaction, killTransaction, type PayloadRequest } from 'payload'

import { BusinessApiError } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'

const idempotencyLifetimeMilliseconds = 24 * 60 * 60 * 1000

type IdempotentWriteOptions<ResponseBody> = {
  execute: () => Promise<ResponseBody>
  keySha256: string
  parseStoredResponse: (value: unknown) => ResponseBody | null
  requestSha256: string
  responseStatus: number
  route: string
}

const isExpired = (expiresAt: string): boolean => new Date(expiresAt).getTime() <= Date.now()

const isUniqueConstraintError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const value = error as { cause?: { code?: unknown }; code?: unknown; message?: unknown }
  return (
    value.code === '23505' ||
    value.cause?.code === '23505' ||
    value.message === 'duplicate key value violates unique constraint'
  )
}

const findRecord = async (context: ActiveSessionContext, route: string, keySha256: string) => {
  const result = await context.payload.find({
    collection: 'api-idempotency-records',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: context.req,
    where: {
      and: [
        { actor: { equals: context.user.id } },
        { route: { equals: route } },
        { keySha256: { equals: keySha256 } },
      ],
    },
  })

  return result.docs[0] ?? null
}

const resolveExisting = async <ResponseBody>(
  context: ActiveSessionContext,
  options: Omit<IdempotentWriteOptions<ResponseBody>, 'execute'>,
): Promise<ResponseBody | null> => {
  const existing = await findRecord(context, options.route, options.keySha256)
  if (!existing) {
    return null
  }

  if (existing.requestSha256 !== options.requestSha256) {
    throw new BusinessApiError(
      'IDEMPOTENCY_KEY_REUSED',
      '同一 Idempotency-Key 不能用于不同请求。',
      409,
    )
  }

  if (isExpired(existing.expiresAt)) {
    await context.payload.delete({
      collection: 'api-idempotency-records',
      id: existing.id,
      overrideAccess: false,
      req: context.req,
    })
    return null
  }

  if (existing.state === 'in_progress') {
    throw new BusinessApiError(
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      '相同请求正在处理，请稍后重试。',
      409,
    )
  }

  const response = options.parseStoredResponse(existing.responseBody)
  if (!response || existing.responseStatus !== options.responseStatus) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }

  return response
}

export const withIdempotentWrite = async <ResponseBody>(
  context: ActiveSessionContext,
  options: IdempotentWriteOptions<ResponseBody>,
): Promise<ResponseBody> => {
  const startedTransaction = await initTransaction(context.req as PayloadRequest)
  if (!startedTransaction && !context.req.transactionID) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }

  let transactionClosed = false

  try {
    const existing = await resolveExisting(context, options)
    if (existing) {
      if (startedTransaction) {
        await commitTransaction(context.req)
        transactionClosed = true
      }
      return existing
    }

    const record = await context.payload.create({
      collection: 'api-idempotency-records',
      data: {
        actor: context.user.id,
        route: options.route,
        keySha256: options.keySha256,
        requestSha256: options.requestSha256,
        state: 'in_progress',
        expiresAt: new Date(Date.now() + idempotencyLifetimeMilliseconds).toISOString(),
      },
      overrideAccess: false,
      req: context.req,
    })
    const response = await options.execute()

    await context.payload.update({
      collection: 'api-idempotency-records',
      id: record.id,
      data: {
        state: 'completed',
        responseStatus: options.responseStatus,
        responseBody: response as never,
      },
      overrideAccess: false,
      req: context.req,
    })

    if (startedTransaction) {
      await commitTransaction(context.req)
      transactionClosed = true
    }

    return response
  } catch (error) {
    if (startedTransaction && !transactionClosed) {
      await killTransaction(context.req)
    }

    if (isUniqueConstraintError(error)) {
      const retriedResponse = await resolveExisting(context, options)
      if (retriedResponse) {
        return retriedResponse
      }
    }

    throw error
  }
}
