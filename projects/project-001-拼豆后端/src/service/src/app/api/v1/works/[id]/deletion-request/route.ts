// 文件开头说明：active 作品删除申请入口。作品立即从业务读取中隐藏，服务端保留
// 30 天恢复窗口；物理回收由项目内受控清理任务执行。
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
import { requestActiveWorkDeletion } from '@/works/delete-work'

const methods = 'POST, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workWrite', 'POST /api/v1/works/:id/deletion-request')
    const keySha256 = sha256(requireIdempotencyKey(request))
    const body = await readBoundedJsonBody(request)
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof (body as { expectedRevision?: unknown }).expectedRevision !== 'number' ||
      !Number.isSafeInteger((body as { expectedRevision: number }).expectedRevision) ||
      (body as { expectedRevision: number }).expectedRevision < 0
    ) {
      throw new BusinessApiError('REQUEST_INVALID', '删除请求的作品修订号无效。', 400)
    }

    const deletion = await requestActiveWorkDeletion(
      session,
      id,
      (body as { expectedRevision: number }).expectedRevision,
      keySha256,
    )
    return withBusinessCors(request, successResponse(deletion, requestId), methods)
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

export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin')
    ? new Response(null, { status: 204, headers })
    : new Response(null, { status: 403 })
}
