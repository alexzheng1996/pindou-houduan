// 文件开头说明：库存 CSV 预检入口。只接受限长 UTF-8 文本，服务端负责解析、色号
// 映射与冻结预览；前端不能上传自己解析出的 HEX 或余额作为可信结果。
import {
  assertTrustedWriteOrigin,
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  readBoundedCsvBody,
  requireIdempotencyKey,
  sha256,
  successResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { previewInventoryImport } from '@/inventory/service'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'POST, OPTIONS'
const maximumCsvBytes = 128 * 1024

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function POST(request: Request): Promise<Response> {
  const requestId = createRequestId()
  try {
    assertTrustedWriteOrigin(request)
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'inventoryWrite', 'POST /api/v1/inventory/imports/preview')
    const body = await previewInventoryImport(
      session,
      await readBoundedCsvBody(request, maximumCsvBytes),
      new URL(request.url).searchParams,
      sha256(requireIdempotencyKey(request)),
    )
    return withBusinessCors(request, successResponse(body, requestId, 201), methods)
  } catch (error) {
    if (error instanceof BusinessApiError) {
      return withBusinessCors(request, errorResponse(error, requestId), methods)
    }
    if (error instanceof SessionRequirementError) {
      return withBusinessCors(request, errorResponse(new BusinessApiError(error.code, error.message, error.status), requestId), methods)
    }
    return withBusinessCors(request, errorResponse(new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500), requestId), methods)
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin')
    ? new Response(null, { status: 204, headers })
    : new Response(null, { status: 403 })
}
