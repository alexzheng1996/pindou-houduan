import {
  assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { restoreWork } from '@/library/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'POST, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'libraryWrite', 'POST /api/v1/library/works/:id/restore')
    const body = await readBoundedJsonBody(request)
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { expectedRevision?: unknown }).expectedRevision !== 'number') {
      throw new BusinessApiError('REQUEST_INVALID', '恢复请求的作品修订号无效。', 400)
    }
    const result = await restoreWork(session, id, (body as { expectedRevision: number }).expectedRevision, sha256(requireIdempotencyKey(request)))
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
