// 文件开头说明：个人豆仓的最小 CSV 模板。模板不携带规格或色号系统；用户必须在
// 预检请求中主动选择两者，避免一个文件混入多种口径后被静默记账。
import {
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryRead', 'GET /api/v1/inventory/template')
    return withBusinessCors(request, new Response('\uFEFF色号,数量\r\n', {
      headers: {
        'Content-Disposition': 'attachment; filename="pixomosaic-inventory-template.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    }), methods, requestId)
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
