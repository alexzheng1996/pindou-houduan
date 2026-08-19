// 文件开头说明：读取 M1 环境边界；只解析白名单 URL 和布尔开关，不承载任何密钥。

export const parseUrlList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

export const isProductionLike = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'team-test'

export const runtimeConfig = {
  allowedOrigins: parseUrlList(process.env.ALLOWED_ORIGINS),
  csrfOrigins: parseUrlList(process.env.CSRF_ORIGINS),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  cookieSecure: process.env.COOKIE_SECURE === 'true' || isProductionLike,
}
