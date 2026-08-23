// 文件开头说明：M1 文件确认入口。它独立于 PUT 再读取私有对象并核对类型、大小和
// 哈希，只有通过确认的 ready 资产才可被后续作品文档或下载入口使用。
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
import { confirmAsset } from '@/assets/service'
import { validateConfirmAssetInput } from '@/assets/validation'
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
    await enforceAuthenticatedRateLimit(session, 'assetConfirm', 'POST /api/v1/works/:id/assets/confirm')
    const input = validateConfirmAssetInput(await readBoundedJsonBody(request))
    const body = await confirmAsset(session, id, input, sha256(requireIdempotencyKey(request)))
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

export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)
  return new Response(null, { status: headers.get('Access-Control-Allow-Origin') ? 204 : 403, headers })
}
