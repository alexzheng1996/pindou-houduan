import { assertTrustedWriteOrigin, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors } from '@/api/business-http'
import { requireCommunityOperatorSession } from '@/auth/require-community-operator-session'
import { updateModerationWatchlist } from '@/community/admin-service'
import { moderationBusinessError } from '@/app/api/v1/admin/community/route-utils'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'PATCH, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireCommunityOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityModerationWrite', 'PATCH /api/v1/admin/community/users/:id/watchlist')
    return withBusinessCors(request, successResponse(await updateModerationWatchlist(session, (await context.params).id, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request))), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(moderationBusinessError(error), requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
