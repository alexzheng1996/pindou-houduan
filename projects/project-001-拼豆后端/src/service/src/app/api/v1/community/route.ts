import {
  assertTrustedWriteOrigin, BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, readBoundedJsonBody, requireIdempotencyKey, sha256, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { publishCommunityPost, listCommunityWithPayload } from '@/community/service'
import config from '@payload-config'
import { getPayload } from 'payload'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, POST, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const payload = await getPayload({ config: await config })
    const body = await listCommunityWithPayload(payload, new URL(request.url).searchParams)
    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'communityWrite', 'POST /api/v1/community')
    const body = await publishCommunityPost(session, await readBoundedJsonBody(request), sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(body, requestId, 201), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : error instanceof SessionRequirementError ? new BusinessApiError(error.code, error.message, error.status) : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
