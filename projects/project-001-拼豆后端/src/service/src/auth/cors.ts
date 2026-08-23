// 文件开头说明：Better Auth 是独立 Next 路由，需自行返回带凭据的 CORS 响应；
// Payload 全局 cors/csrf 配置不会自动覆盖此入口。
import { runtimeConfig } from '@/config/runtime'

const allowedMethods = 'GET, POST, OPTIONS'
const allowedHeaders = 'Content-Type, X-Requested-With'

const getAllowedOrigin = (request: Request): string | undefined => {
  const origin = request.headers.get('origin')

  if (origin && runtimeConfig.authTrustedOrigins.includes(origin)) {
    return origin
  }

  return undefined
}

export const createAuthCorsHeaders = (request: Request): Headers => {
  const headers = new Headers({
    'Access-Control-Allow-Methods': allowedMethods,
    'Access-Control-Allow-Headers': allowedHeaders,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  })
  const allowedOrigin = getAllowedOrigin(request)

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin)
  }

  return headers
}

export const withAuthCors = (request: Request, response: Response, requestId?: string): Response => {
  const headers = new Headers(response.headers)
  const corsHeaders = createAuthCorsHeaders(request)

  corsHeaders.forEach((value, key) => headers.set(key, value))
  headers.set('Cache-Control', 'no-store')
  if (requestId) {
    // Better Auth owns its JSON response shape. Keep that contract intact and
    // use the standard header to correlate authentication with minimal audits.
    headers.set('X-Request-Id', requestId)
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}
