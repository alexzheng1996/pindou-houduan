// 文件开头说明：M1 作品 API 的首个入口。当前仅创建经过完整 pattern 校验的私密
// draft；它不暴露 Payload REST，也不在此阶段开放画板、上传、激活或删除。
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
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'
import { createDraftWork } from '@/works/create-work'
import { listActiveWorks } from '@/works/read-works'
import { validateCreateWorkInput, WorkDocumentValidationError } from '@/works/validation'

const methods = 'GET, POST, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()

  try {
    const session = await requireActiveSession(request, requestId)
    const body = await listActiveWorks(session, new URL(request.url).searchParams)

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

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()

  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workWrite', 'POST /api/v1/works')
    const keySha256 = sha256(requireIdempotencyKey(request))
    const input = validateCreateWorkInput(await readBoundedJsonBody(request))
    const body = await createDraftWork(session, input, keySha256)

    return withBusinessCors(request, successResponse(body, requestId, 201), methods)
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
