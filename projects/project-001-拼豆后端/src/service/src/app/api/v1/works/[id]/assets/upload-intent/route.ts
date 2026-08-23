// 文件开头说明：M1 私有图片上传意图。它只预留受控资产槽位并给出同源本机 PUT
// 地址；不返回存储键、绝对路径、公开 URL 或任何对象存储凭据。
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
import { createUploadIntent } from '@/assets/service'
import { validateUploadIntentInput } from '@/assets/validation'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

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
    await enforceAuthenticatedRateLimit(
      session,
      'assetIntent',
      'POST /api/v1/works/:id/assets/upload-intent',
    )
    const input = validateUploadIntentInput(await readBoundedJsonBody(request))
    const body = await createUploadIntent(session, id, input, sha256(requireIdempotencyKey(request)))

    return withBusinessCors(request, successResponse(body, requestId, 201), methods)
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
  return new Response(null, { status: headers.get('Access-Control-Allow-Origin') ? 204 : 403, headers })
}
