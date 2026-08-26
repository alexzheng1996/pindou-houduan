import { createBusinessCorsHeaders, createRequestId, errorResponse, successResponse, withBusinessCors } from '@/api/business-http'
import { requireCommunityOperatorSession } from '@/auth/require-community-operator-session'
import { listModerationCreatorPosts } from '@/community/admin-service'
import { moderationBusinessError } from '@/app/api/v1/admin/community/route-utils'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireCommunityOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityModerationRead', 'GET /api/v1/admin/community/users/:id/posts')
    return withBusinessCors(request, successResponse(await listModerationCreatorPosts(session, (await context.params).id, new URL(request.url).searchParams), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(moderationBusinessError(error), requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
