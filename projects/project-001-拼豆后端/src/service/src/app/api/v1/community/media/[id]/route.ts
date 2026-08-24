import { BusinessApiError, createBusinessCorsHeaders, createRequestId, errorResponse, withBusinessCors } from '@/api/business-http'
import { readCommunityMedia } from '@/community/service'
import config from '@payload-config'
import { getPayload } from 'payload'

const methods = 'GET, OPTIONS'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const requestId = createRequestId()
  try {
    const { id } = await context.params
    const payload = await getPayload({ config: await config })
    const media = await readCommunityMedia(payload, id)
    const response = new Response(media.content, { status: 200, headers: { 'Content-Type': media.mimeType, 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' } })
    return withBusinessCors(request, response, methods)
  } catch (error) {
    const business = error instanceof BusinessApiError ? error : new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
    return withBusinessCors(request, errorResponse(business, requestId), methods)
  }
}
export function OPTIONS(request: Request): Response {
  const headers = createBusinessCorsHeaders(request, methods)
  return headers.get('Access-Control-Allow-Origin') ? new Response(null, { status: 204, headers }) : new Response(null, { status: 403 })
}
