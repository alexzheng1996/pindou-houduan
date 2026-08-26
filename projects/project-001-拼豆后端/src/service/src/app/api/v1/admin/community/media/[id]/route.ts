import { createBusinessCorsHeaders, createRequestId, errorResponse, withBusinessCors } from '@/api/business-http'
import { requireCommunityOperatorSession } from '@/auth/require-community-operator-session'
import { readModerationCommunityMedia } from '@/community/admin-service'
import { moderationBusinessError } from '@/app/api/v1/admin/community/route-utils'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireCommunityOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityModerationRead', 'GET /api/v1/admin/community/media/:id')
    const media = await readModerationCommunityMedia(session, (await context.params).id)
    return withBusinessCors(request, new Response(media.content, { status: 200, headers: { 'Content-Type': media.mimeType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }), methods, requestId)
  } catch (error) {
    return withBusinessCors(request, errorResponse(moderationBusinessError(error), requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
