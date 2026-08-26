// 文件开头说明：M2.1-A 内容后台路由只支持 Staff/Admin 的文章草稿读取与创建。
// 它不提供公开内容、审核发布、媒体上传、SEO 或 MCP 服务身份入口。
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
import { createDraftArticle, listDraftArticles } from '@/content/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, POST, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const asBusinessError = (error: unknown): BusinessApiError => {
  if (error instanceof BusinessApiError) return error
  if (error instanceof SessionRequirementError || error instanceof ContentOperatorRequirementError) {
    return new BusinessApiError(error.code, error.message, error.status)
  }
  return new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    const session = await requireContentOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'contentRead', 'GET /api/v1/admin/content/articles')
    return withBusinessCors(request, successResponse(await listDraftArticles(session), requestId), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(asBusinessError(error), requestId), methods)
  }
}

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireContentOperatorSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'contentWrite', 'POST /api/v1/admin/content/articles')
    const body = await createDraftArticle(
      session,
      await readBoundedJsonBody(request),
      sha256(requireIdempotencyKey(request)),
    )
    return withBusinessCors(request, successResponse(body, requestId, 201), methods)
  } catch (error) {
    return withBusinessCors(request, errorResponse(asBusinessError(error), requestId), methods)
  }
}

export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
