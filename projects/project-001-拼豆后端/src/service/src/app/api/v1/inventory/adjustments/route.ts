// 文件开头说明：M1.1 个人豆仓的手工入库、扣减与盘点入口。余额写入由库存账本服务
// 统一事务处理；本路由只负责业务 HTTP 安全边界、会话、限流和错误投影。
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
import { adjustInventory } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'POST, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryWrite', 'POST /api/v1/inventory/adjustments')
    const body = await adjustInventory(
      session,
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
