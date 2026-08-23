// 文件开头说明：导出当前已保存作品的库存不足清单。需求和库存均由服务端计算；
// 未录入库存与零库存分开标示，且不输出内部 ID、用户信息或“可完成份数”。
import {
  BusinessApiError,
  createBusinessCorsHeaders,
  createRequestId,
  errorResponse,
  withBusinessCors,
} from '@/api/business-http'
import { requireActiveSession, SessionRequirementError } from '@/auth/require-session'
import { getWorkInventoryShortageCsv } from '@/inventory/service'
import { isInventoryColorSystem } from '@/inventory/color-mapping'
import { enforceAuthenticatedRateLimit } from '@/security/rate-limit'

const methods = 'GET, OPTIONS'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const { id } = await context.params
    const colorSystem = new URL(request.url).searchParams.get('colorSystem') ?? 'MARD'
    if (!isInventoryColorSystem(colorSystem)) {
      throw new BusinessApiError('INVENTORY_INPUT_INVALID', '色号系统无效。', 422)
    }
    const session = await requireActiveSession(request, requestId)
    await enforceAuthenticatedRateLimit(session, 'workInventoryRead', 'GET /api/v1/works/:id/inventory-shortages')
    const output = await getWorkInventoryShortageCsv(session, id, colorSystem)
    return withBusinessCors(request, new Response(output.csv, {
      headers: {
        'Content-Disposition': 'attachment; filename="pixomosaic-inventory-shortages.csv"',
        'Content-Type': 'text/csv; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      },
    }), methods, requestId)
  } catch (error) {
    if (error instanceof BusinessApiError) {
      return withBusinessCors(request, errorResponse(error, requestId), methods)
    }
    if (error instanceof SessionRequirementError) {
      return withBusinessCors(request, errorResponse(new BusinessApiError(error.code, error.message, error.status), requestId), methods)
    }
    return withBusinessCors(request, errorResponse(new BusinessApiError(
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : '服务器暂时无法处理请求。',
      500,
    ), requestId), methods, requestId)
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin')
    ? new Response(null, { status: 204, headers })
    : new Response(null, { status: 403 })
}
