// 文件开头说明：正式图纸册入口。编辑器内 CloudWorkLibraryModal 仍只负责
// 快速打开 active Work；整理元数据通过此独立资源读取。
import {
  BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, successResponse, withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { listLibrary } from '@/library/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'libraryRead', 'GET /api/v1/library')
    return withBusinessCors(request, successResponse(await listLibrary(session), requestId), methods)
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
