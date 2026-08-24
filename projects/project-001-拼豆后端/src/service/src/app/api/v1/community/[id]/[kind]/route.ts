import { assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, requireIdempotencyKey, sha256, successResponse, withBusinessCors } from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { toggleInteraction } from '@/community/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'PUT, DELETE, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const handle = async (request: Request, context: { params: Promise<{ id: string; kind: string }> }, active: boolean): Promise<Response> => {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const params = await context.params
    if (params.kind !== 'like' && params.kind !== 'favorite') throw new BusinessApiError('REQUEST_INVALID', '互动类型无效。', 400)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', `${active ? 'PUT' : 'DELETE'} /api/v1/community/:id/${params.kind}`)
    const body = await toggleInteraction(session, params.id, params.kind, active, sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}
export const PUT = (request: Request, context: { params: Promise<{ id: string; kind: string }> }) => handle(request, context, true)
export const DELETE = (request: Request, context: { params: Promise<{ id: string; kind: string }> }) => handle(request, context, false)
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
