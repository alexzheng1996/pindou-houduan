// 文件开头说明：删除个人豆仓历史不是物理删除：服务端在一个事务内软删原操作、建立
// 唯一反向操作并更新余额。回滚操作及已删除原操作均禁止再次删除。
import {
  assertTrustedWriteOrigin,
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  readBoundedJsonBody,
  requireIdempotencyKey,
  sha256,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { reverseInventoryOperation } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'DELETE, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryWrite', 'DELETE /api/v1/inventory/operations/:id')
    const body = await reverseInventoryOperation(
      session,
      id,
      await readBoundedJsonBody(request),
      sha256(requireIdempotencyKey(request)),
    )
    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    if (error instanceof BusinessApiError) {
      return withBusinessCors(request, errorResponse(error, requestId), methods)
    }
    if (error instanceof SessionRequirementError) {
      return withBusinessCors(request, errorResponse(new BusinessApiError(error.code, error.message, error.status), requestId), methods)
    }
    return withBusinessCors(request, errorResponse(new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500), requestId), methods)
  }
}
export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin')
    ? new Response(null, { status: 204, headers })
    : new Response(null, { status: 403 })
}
