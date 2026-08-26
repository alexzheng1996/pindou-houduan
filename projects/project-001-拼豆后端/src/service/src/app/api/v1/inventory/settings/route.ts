// 文件开头说明：当前账号的库存阈值入口。数据库只保存两项规则；各库存状态
// 继续由库存服务实时推导，不能由浏览器直接指定健康度或账号 ID。
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
import { getInventorySettings, updateInventorySettings } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, PUT, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const failure = (error: unknown): BusinessApiError =>
  error instanceof BusinessApiError
    ? error
    : error instanceof SessionRequirementError
      ? new BusinessApiError(error.code, error.message, error.status)
      : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryRead', 'GET /api/v1/inventory/settings')
    return withBusinessCors(request, successResponse(await getInventorySettings(session), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(failure(error), requestId), methods)
  }
}

export async function PUT(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryWrite', 'PUT /api/v1/inventory/settings')
    const body = await updateInventorySettings(
      session,
      await readBoundedJsonBody(request),
      sha256(requireIdempotencyKey(request)),
    )
    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(failure(error), requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
