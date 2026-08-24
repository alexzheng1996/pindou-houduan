import {
  assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { createLabel } from '@/library/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'POST, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'libraryWrite', 'POST /api/v1/library/labels')
    const result = await createLabel(session, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(result, requestId, 201), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
