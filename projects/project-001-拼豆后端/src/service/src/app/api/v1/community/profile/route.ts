// 用户只可维护自己的社区显示资料；运营备注和特别关注绝不从这里返回。
import { assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors } from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { getOwnCommunityProfile, updateOwnCommunityProfile } from '@/community/admin-service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, PATCH, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const businessError = (error: unknown): BusinessApiError => error instanceof BusinessApiError
  ? error
  : error instanceof SessionRequirementError
    ? new BusinessApiError(error.code, error.message, error.status)
    : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityRead', 'GET /api/v1/community/profile')
    return withBusinessCors(request, successResponse(await getOwnCommunityProfile(session), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(businessError(error), requestId), methods)
  }
}
export async function PATCH(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'PATCH /api/v1/community/profile')
    return withBusinessCors(request, successResponse(await updateOwnCommunityProfile(session, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request))), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(businessError(error), requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
