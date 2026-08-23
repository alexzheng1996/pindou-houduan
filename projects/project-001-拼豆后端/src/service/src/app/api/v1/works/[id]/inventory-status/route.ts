// 文件开头说明：只读返回当前用户已保存作品的服务端颜色用量与个人库存状态，不能
// 读取草稿、其他用户作品，且不信任前端传入的颜色统计或拼豆规格。
import {
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { getWorkInventoryStatus } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workInventoryRead', 'GET /api/v1/works/:id/inventory-status')
    return withBusinessCors(request, successResponse(await getWorkInventoryStatus(session, id), requestId), methods)
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
