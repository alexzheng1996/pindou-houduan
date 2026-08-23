// 文件开头说明：完成制作只从服务端已保存的 active 作品快照计算用量，并在单一
// 事务内扣减所有颜色、创建账本操作和审计记录；前端不能提交或篡改颜色用量。
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
import { completeWorkInventory } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'POST, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryWrite', 'POST /api/v1/works/:id/complete')
    const body = await completeWorkInventory(
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
