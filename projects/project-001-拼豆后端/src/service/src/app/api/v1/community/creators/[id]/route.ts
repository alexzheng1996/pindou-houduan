// 访客作者资料只投影公开社交链接；隐藏链接和运营档案不进入该响应。
import { BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, successResponse, withBusinessCors } from '@/api/business-http'
import { getPublicCommunityCreator } from '@/community/admin-service'
import config from '@payload-config'
import { getPayload } from 'payload'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const payload = await getPayload({ config: await config })
    return withBusinessCors(request, successResponse(await getPublicCommunityCreator({ payload }, (await context.params).id), requestId), methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
