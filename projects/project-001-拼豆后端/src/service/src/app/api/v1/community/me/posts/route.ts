// 本人发布管理只从活动会话确定 owner；非公开帖子绝不返回封面或治理原因。
import { BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, successResponse, withBusinessCors } from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { listOwnCommunityPosts } from '@/community/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityRead', 'GET /api/v1/community/me/posts')
    return withBusinessCors(request, successResponse(await listOwnCommunityPosts(session, new URL(request.url).searchParams), requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
