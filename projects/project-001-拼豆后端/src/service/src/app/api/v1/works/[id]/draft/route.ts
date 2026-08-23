// 文件开头说明：取消未激活作品的业务入口。草稿会立刻从所有业务读取中消失，
// 但物理文件和不可变快照仍由项目内清理任务按顺序回收。
import {
  assertTrustedWriteOrigin,
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  requireIdempotencyKey,
  sha256,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'
import { cancelDraftWork } from '@/works/delete-work'

const methods = 'DELETE, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    assertTrustedWriteOrigin(request)
    const { id } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workWrite', 'DELETE /api/v1/works/:id/draft')
    const result = await cancelDraftWork(session, id, sha256(requireIdempotencyKey(request)))
    return withBusinessCors(request, successResponse(result, requestId), methods)
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
