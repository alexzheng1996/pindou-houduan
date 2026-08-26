// 用户只可增删自己的社交链接和可见性；链接不接入社交账号，也不接受任意外链。
import { assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors } from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { deleteOwnSocialLink, upsertOwnSocialLink } from '@/community/admin-service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'PUT, DELETE, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const businessError = (error: unknown): BusinessApiError => error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
export async function PUT(request: Request, context: { params: Promise<{ platform: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'PUT /api/v1/community/profile/social-links/:platform')
    return withBusinessCors(request, successResponse(await upsertOwnSocialLink(session, (await context.params).platform, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request))), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(businessError(error), requestId), methods)
  }
}
export async function DELETE(request: Request, context: { params: Promise<{ platform: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'DELETE /api/v1/community/profile/social-links/:platform')
    return withBusinessCors(request, successResponse(await deleteOwnSocialLink(session, (await context.params).platform, sha256(requireIdempotencyKey(request))), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(businessError(error), requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
