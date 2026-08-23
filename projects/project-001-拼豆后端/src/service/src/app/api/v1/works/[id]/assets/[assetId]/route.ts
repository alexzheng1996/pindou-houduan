// 文件开头说明：M1 私有文件读取入口。只返回当前 owner 已确认的 ready 图片流，不
// 给前端永久 URL；之后接入 R2/S3 时改为短期签名或受控流式读取，但权限不改变。
import {
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  withBusinessCors,
} from '@/api/business-http'
import { readReadyAsset } from '@/assets/service'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(
  request: Request,
  context: { params: Promise<{ assetId: string; id: string }> },
): Promise<Response> {
  const requestId = createRequestId()

  try {
    const { id, assetId } = await context.params
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'assetDownload', 'GET /api/v1/works/:id/assets/:assetId')
    const asset = await readReadyAsset(session, id, assetId)
    await recordAuthenticatedAuditEvent(session, {
      action: 'asset.downloaded',
      outcome: 'allowed',
      resourcePublicId: assetId,
      resourceType: 'asset',
      route: 'GET /api/v1/works/:id/assets/:assetId',
    })
    return withBusinessCors(
      request,
      new Response(asset.content, {
        headers: {
          'Content-Type': asset.mimeType,
          'Content-Length': String(asset.content.length),
          'Content-Disposition': 'attachment; filename="asset"',
          'X-Content-Type-Options': 'nosniff',
        },
      }),
      methods,
      requestId,
    )
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
