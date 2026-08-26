import {
  assertTrustedWriteOrigin,
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  readBoundedJsonBody,
  requireIdempotencyKey,
  sha256,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import {
  ContentOperatorRequirementError,
  requireContentOperatorSession,
  SessionRequirementError,
} from '@/auth/require-content-session'
import { getDraftArticle, updateDraftArticle } from '@/content/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, PATCH, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const asBusinessError = (error: unknown): BusinessApiError => {
  if (error instanceof BusinessApiError) return error
  if (error instanceof SessionRequirementError || error instanceof ContentOperatorRequirementError) {
    return new BusinessApiError(error.code, error.message, error.status)
  }
  return new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireContentOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'contentRead', 'GET /api/v1/admin/content/articles/:id')
    const { id } = await context.params
    return withBusinessCors(request, successResponse(await getDraftArticle(session, id), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(asBusinessError(error), requestId), methods)
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireContentOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'contentWrite', 'PATCH /api/v1/admin/content/articles/:id')
    const { id } = await context.params
    const body = await updateDraftArticle(
      session,
      id,
      await readBoundedJsonBody(request),
      sha256(requireIdempotencyKey(request)),
    )
    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(asBusinessError(error), requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
