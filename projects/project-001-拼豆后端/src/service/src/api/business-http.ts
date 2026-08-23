// 文件开头说明：M1 业务 API 的公共 HTTP 安全边界。认证路由有自己的 CORS
// 规则；作品等业务路由必须在这里单独校验可信来源、幂等键、请求体和统一错误格式。
import { createHash, randomUUID } from 'crypto'

import { runtimeConfig } from '@/config/runtime'

export const MAX_WORK_REQUEST_BYTES = 8 * 1024 * 1024

export class BusinessApiError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  readonly headers: HeadersInit
  readonly status: number

  constructor(
    code: string,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
    headers: HeadersInit = {},
  ) {
    super(message)
    this.code = code
    this.details = details
    this.headers = headers
    this.status = status
  }
}

export const createRequestId = (): string => randomUUID()

const getAllowedOrigin = (request: Request): string | undefined => {
  const origin = request.headers.get('origin')

  return origin && runtimeConfig.allowedOrigins.includes(origin) ? origin : undefined
}

export const createBusinessCorsHeaders = (
  request: Request,
  methods: string,
): Headers => {
  const headers = new Headers({
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, X-Requested-With',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  })
  const allowedOrigin = getAllowedOrigin(request)

  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin)
  }

  return headers
}

export const withBusinessCors = (
  request: Request,
  response: Response,
  methods: string,
  requestId?: string,
): Response => {
  const headers = new Headers(response.headers)
  const corsHeaders = createBusinessCorsHeaders(request, methods)

  corsHeaders.forEach((value, key) => headers.set(key, value))
  headers.set('Cache-Control', 'no-store')
  if (requestId) {
    headers.set('X-Request-Id', requestId)
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export const assertTrustedWriteOrigin = (request: Request): void => {
  if (!getAllowedOrigin(request)) {
    throw new BusinessApiError(
      'ORIGIN_NOT_ALLOWED',
      '当前请求来源未获授权。',
      403,
    )
  }
}

export const requireIdempotencyKey = (request: Request): string => {
  const key = request.headers.get('idempotency-key')

  if (!key) {
    throw new BusinessApiError(
      'IDEMPOTENCY_KEY_REQUIRED',
      '此操作需要 Idempotency-Key。',
      400,
    )
  }

  if (!/^[!-~]{1,128}$/.test(key)) {
    throw new BusinessApiError(
      'IDEMPOTENCY_KEY_INVALID',
      'Idempotency-Key 格式无效。',
      400,
    )
  }

  return key
}

const parseContentLength = (request: Request): number | undefined => {
  const header = request.headers.get('content-length')

  if (!header) {
    return undefined
  }

  if (!/^\d+$/.test(header)) {
    return undefined
  }

  const value = Number(header)

  return Number.isSafeInteger(value) ? value : undefined
}

export const readBoundedJsonBody = async (request: Request): Promise<unknown> => {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''

  if (!contentType.startsWith('application/json')) {
    throw new BusinessApiError('REQUEST_INVALID', '请求体必须是 JSON。', 415)
  }

  const declaredLength = parseContentLength(request)
  if (declaredLength !== undefined && declaredLength > MAX_WORK_REQUEST_BYTES) {
    throw new BusinessApiError(
      'WORK_DOCUMENT_TOO_LARGE',
      '作品文档超过当前容量限制。',
      413,
    )
  }

  const body = await request.text()
  if (Buffer.byteLength(body, 'utf8') > MAX_WORK_REQUEST_BYTES) {
    throw new BusinessApiError(
      'WORK_DOCUMENT_TOO_LARGE',
      '作品文档超过当前容量限制。',
      413,
    )
  }

  try {
    return JSON.parse(body) as unknown
  } catch {
    throw new BusinessApiError('REQUEST_INVALID', '请求体不是有效 JSON。', 400)
  }
}

// M1 files use a separate bounded binary reader. Route Handlers expose standard
// Web Request bodies, so do not trust Content-Length or let an omitted/forged
// value cause the complete request to be buffered before enforcing the limit.
export const readBoundedBinaryBody = async (request: Request, maximumBytes: number): Promise<Buffer> => {
  const declaredLength = parseContentLength(request)
  if (declaredLength !== undefined && declaredLength > maximumBytes) {
    throw new BusinessApiError('ASSET_TOO_LARGE', '文件大小超出当前限制。', 413)
  }

  if (!request.body) {
    return Buffer.alloc(0)
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      bytesRead += value.byteLength
      if (bytesRead > maximumBytes) {
        await reader.cancel()
        throw new BusinessApiError('ASSET_TOO_LARGE', '文件大小超出当前限制。', 413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks, bytesRead)
}

// CSV 导入不能复用作品的 8 MiB JSON 上限：库存模板只需要少量文本，先限字节、
// 再做严格 UTF-8 解码，避免在预检前把大文件或其他编码内容留在内存和数据库中。
export const readBoundedCsvBody = async (request: Request, maximumBytes: number): Promise<string> => {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('text/csv')) {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入文件必须是 UTF-8 CSV。', 415)
  }
  const bytes = await readBoundedBinaryBody(request, maximumBytes)
  if (bytes.includes(0)) {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入文件必须是 UTF-8 CSV。', 422)
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入文件必须是 UTF-8 CSV。', 422)
  }
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
      .join(',')}}`
  }

  throw new BusinessApiError('REQUEST_INVALID', '请求体不是有效 JSON。', 400)
}

export const errorResponse = (error: BusinessApiError, requestId: string): Response =>
  Response.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        details: error.details,
      },
    },
    { headers: error.headers, status: error.status },
  )

export const successResponse = (
  body: Record<string, unknown>,
  requestId: string,
  status = 200,
): Response => Response.json({ ...body, requestId }, { status })
