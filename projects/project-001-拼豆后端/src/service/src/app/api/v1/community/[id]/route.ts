import { assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors } from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { getCommunityPost, updateCommunityPost } from '@/community/service'
import config from '@payload-config'
import { getPayload } from 'payload'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, PATCH, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const { id } = await context.params
    const payload = await getPayload({ config: await config })
    let viewerId: number | null = null
    try {
      viewerId = (await requireActiveSession(request, requestId)).user.id
    } catch (error) {
      if (!(error instanceof SessionRequirementError)) throw error
    }
    return withBusinessCors(request, successResponse(await getCommunityPost(payload, id, viewerId), requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'PATCH /api/v1/community/:id')
    const result = await updateCommunityPost(session, id, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(result, requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
