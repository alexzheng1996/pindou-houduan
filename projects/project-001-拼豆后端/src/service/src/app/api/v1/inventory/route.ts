// 文件开头说明：M1.1 私有豆仓余额列表。只返回当前活动用户已有的余额项，颜色显示
// 名称由前端按自己的当前色号系统转换；服务端固定返回底层大写 HEX 和规格。
import {
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { listInventoryItems } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryRead', 'GET /api/v1/inventory')
    return withBusinessCors(request, successResponse(await listInventoryItems(session, new URL(request.url).searchParams), requestId), methods)
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
