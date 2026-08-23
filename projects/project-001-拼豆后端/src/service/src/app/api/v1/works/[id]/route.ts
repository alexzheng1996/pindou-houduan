// 文件开头说明：读取单一 active 私密作品。URL 中的 ID 是公开 workId；所有者和
// 状态均在服务端二次限定，草稿与其他用户的数据都统一返回不可访问。
import {
  BusinessApiError,
  createRequestId,
  errorResponse,
  assertTrustedWriteOrigin,
  createBusinessCorsHeaders,
  readBoundedJsonBody,
  requireIdempotencyKey,
  sha256,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'
import { getActiveWorkDetail } from '@/works/read-works'
import { toUpdateWorkError, updateWorkDocument } from '@/works/update-work'
import { validateUpdateWorkInput, WorkDocumentValidationError } from '@/works/validation'

const methods = 'GET, PATCH, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    const body = await getActiveWorkDetail(session, id)

    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    if (error instanceof BusinessApiError) {
      return withBusinessCors(request, errorResponse(error, requestId), methods)
    }

    if (error instanceof SessionRequirementError) {
      return withBusinessCors(
        request,
        errorResponse(new BusinessApiError(error.code, error.message, error.status), requestId),
        methods,
      )
    }

    return withBusinessCors(
      request,
      errorResponse(new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500), requestId),
      methods,
    )
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workWrite', 'PATCH /api/v1/works/:id/document')
    const keySha256 = sha256(requireIdempotencyKey(request))
    const input = validateUpdateWorkInput(await readBoundedJsonBody(request))
    const body = await updateWorkDocument(
      session,
      id,
      input.expectedRevision,
      input,
      keySha256,
    )

    return withBusinessCors(request, successResponse(body, requestId), methods)
  } catch (error) {
    if (error instanceof BusinessApiError) {
      return withBusinessCors(request, errorResponse(error, requestId), methods)
    }

    if (error instanceof WorkDocumentValidationError) {
      const status = error.code === 'WORK_DOCUMENT_TOO_LARGE' ? 413 : 422
      return withBusinessCors(
        request,
        errorResponse(
          new BusinessApiError(
            error.code,
            error.code === 'WORK_DOCUMENT_TOO_LARGE'
              ? '作品文档超过当前容量限制。'
              : '作品文档格式无效。',
            status,
          ),
          requestId,
        ),
        methods,
      )
    }

    if (error instanceof SessionRequirementError) {
      return withBusinessCors(
        request,
        errorResponse(new BusinessApiError(error.code, error.message, error.status), requestId),
        methods,
      )
    }

    const domainError = toUpdateWorkError(error)
    if (domainError) {
      return withBusinessCors(request, errorResponse(domainError, requestId), methods)
    }

    return withBusinessCors(
      request,
      errorResponse(new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500), requestId),
      methods,
    )
  }
}


export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)

  if (!headers.get('Access-Control-Allow-Origin')) {
    return new Response(null, { status: 403 })
  }

  return new Response(null, { status: 204, headers })
}
