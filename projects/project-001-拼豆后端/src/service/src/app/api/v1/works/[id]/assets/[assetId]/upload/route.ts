// 文件开头说明：M1 本机文件 PUT 入口。每次上传都以当前活动会话、作品和资产归属
// 重新鉴权，限长读取并验证图片字节；没有公开存储 URL 或客户端可控磁盘路径。
import {
  assertTrustedWriteOrigin,
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  readBoundedBinaryBody,
  withBusinessCors,
} from '@/api/business-http'
import { uploadAssetBytes } from '@/assets/service'
import { MAX_ASSET_BYTES } from '@/assets/validation'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'PUT, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function PUT(
  request: Request,
  context: { params: Promise<{ assetId: string; id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    assertTrustedWriteOrigin(request)
    const { id, assetId } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(
      session,
      'assetUpload',
      'PUT /api/v1/works/:id/assets/:assetId/upload',
    )
    await uploadAssetBytes(
      session,
      id,
      assetId,
      request.headers.get('content-type'),
      await readBoundedBinaryBody(request, MAX_ASSET_BYTES),
    )
    return withBusinessCors(request, new Response(null, { status: 204 }), methods)
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
