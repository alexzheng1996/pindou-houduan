import {
  assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { deleteFolder, updateFolder } from '@/library/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'PATCH, DELETE, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const handle = async (request: Request, context: { params: Promise<{ id: string }> }, method: 'PATCH' | 'DELETE'): Promise<Response> => {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'libraryWrite', `${method} /api/v1/library/folders/:id`)
    const result = method === 'PATCH'
      ? await updateFolder(session, id, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request)))
      : await deleteFolder(session, id, sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(result, requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}
export const PATCH = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, 'PATCH')
export const DELETE = (request: Request, context: { params: Promise<{ id: string }> }) => handle(request, context, 'DELETE')
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
