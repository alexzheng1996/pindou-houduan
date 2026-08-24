import {
  assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId,
  errorResponse, readBoundedBinaryBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { uploadCommunityMedia } from '@/community/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'
import { MAX_ASSET_BYTES } from '@/assets/validation'

const methods = 'POST, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'POST /api/v1/community/media/upload')
    const role = request.headers.get('x-community-media-role')
    if (role !== 'cover' && role !== 'gallery') throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '社区媒体角色无效。', 422)
    const altText = request.headers.get('x-community-media-alt')?.trim() || null
    if (altText && Array.from(altText).length > 240) throw new BusinessApiError('COMMUNITY_MEDIA_INVALID', '媒体说明过长。', 422)
    const body = await readBoundedBinaryBody(request, MAX_ASSET_BYTES)
    const result = await uploadCommunityMedia(session, body, role, request.headers.get('content-type') || '', altText, sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(result, requestId, 201), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError
      ? error
      : error instanceof SessionRequirementError
        ? new BusinessApiError(error.code, error.message, error.status)
        : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
