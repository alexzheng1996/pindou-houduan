// 文件开头说明：读取 M1 环境边界；只解析白名单 URL 和布尔开关，不承载任何密钥。

export const parseUrlList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const localAuthBaseUrl = 'http://127.0.0.1:3000'

type GoogleOAuthMode = 'disabled' | 'google' | 'mock'
type MailTransport = 'local-outbox' | 'resend'
type RuntimeEnvironment = Record<string, string | undefined>

const getGoogleOAuthMode = (environment: RuntimeEnvironment): GoogleOAuthMode => {
  const mode = environment.GOOGLE_OAUTH_MODE?.trim() || 'disabled'

  if (mode === 'disabled' || mode === 'google' || mode === 'mock') {
    return mode
  }

  throw new Error('GOOGLE_OAUTH_MODE 只能是 disabled、google 或 mock。')
}

const getMailTransport = (
  environment: RuntimeEnvironment,
  appEnv: string,
): MailTransport => {
  const transport = environment.MAIL_TRANSPORT?.trim() || (appEnv === 'local' ? 'local-outbox' : '')

  if (transport === 'local-outbox' || transport === 'resend') {
    return transport
  }

  throw new Error('local 环境只能使用 MAIL_TRANSPORT=local-outbox；team-test 必须显式设置 MAIL_TRANSPORT=resend。')
}

export const isProductionLike = process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'team-test'

export const createRuntimeConfig = (environment: RuntimeEnvironment = process.env) => {
  const configuredAuthBaseUrl = environment.AUTH_BASE_URL || localAuthBaseUrl
  const configuredAppEnv = environment.APP_ENV || 'local'
  const configuredAllowedOrigins = parseUrlList(environment.ALLOWED_ORIGINS)
  const configuredCsrfOrigins = parseUrlList(environment.CSRF_ORIGINS)
  const localServiceOrigin = new URL(configuredAuthBaseUrl).origin
  const allowedOrigins = Array.from(
    new Set([
      ...configuredAllowedOrigins,
      // A fresh local .env must not silently block the service from its own
      // browser origin. Team-test and production still require explicit lists.
      ...(configuredAppEnv === 'local' ? [localServiceOrigin] : []),
    ]),
  )
  const csrfOrigins = Array.from(
    new Set([
      ...configuredCsrfOrigins,
      ...(configuredAppEnv === 'local' ? [localServiceOrigin] : []),
    ]),
  )
  const googleOAuthMode = getGoogleOAuthMode(environment)
  const localGoogleMockDiscoveryUrl =
    environment.GOOGLE_OAUTH_DISCOVERY_URL?.trim() ||
    'http://127.0.0.1:55441/.well-known/openid-configuration'

  if (googleOAuthMode === 'mock' && configuredAppEnv !== 'local') {
    throw new Error('GOOGLE_OAUTH_MODE=mock 只能用于本机 local 环境。')
  }

  const googleOAuthClientId =
    googleOAuthMode === 'mock'
      ? 'pixomosaic-m1-local-google-mock-client'
      : environment.GOOGLE_OAUTH_CLIENT_ID?.trim()
  const googleOAuthClientSecret =
    googleOAuthMode === 'google' ? environment.GOOGLE_OAUTH_CLIENT_SECRET?.trim() : undefined

  if (googleOAuthMode === 'google' && (!googleOAuthClientId || !googleOAuthClientSecret)) {
    throw new Error('启用真实 Google OAuth 前必须设置 GOOGLE_OAUTH_CLIENT_ID 和 GOOGLE_OAUTH_CLIENT_SECRET。')
  }

  const mailTransport = getMailTransport(environment, configuredAppEnv)
  // Local outbox needs a harmless sender identity for Payload internals. Do
  // not give team-test a fallback: a missing real sender must stop startup.
  const mailFromAddress =
    environment.MAIL_FROM_ADDRESS?.trim() ||
    (configuredAppEnv === 'local' ? 'no-reply@local.invalid' : undefined)
  const mailFromName =
    environment.MAIL_FROM_NAME?.trim() || (configuredAppEnv === 'local' ? 'PixoMosaic Local' : undefined)
  const resendApiKey = environment.RESEND_API_KEY?.trim()
  const resendOverrideRecipient = environment.RESEND_OVERRIDE_RECIPIENT?.trim()

  if (mailTransport === 'local-outbox' && configuredAppEnv !== 'local') {
    throw new Error('MAIL_TRANSPORT=local-outbox 只能用于 local 环境。')
  }

  if (mailTransport === 'resend' && configuredAppEnv !== 'team-test') {
    throw new Error('M1 的 MAIL_TRANSPORT=resend 只能在获批的 team-test 环境启用。')
  }

  if (mailTransport === 'resend' && (!resendApiKey || !mailFromAddress || !mailFromName)) {
    throw new Error('启用 Resend 前必须在部署密钥配置中设置 RESEND_API_KEY、MAIL_FROM_ADDRESS 和 MAIL_FROM_NAME。')
  }

  const isRegistrationEmailAllowed = (email: string | undefined): boolean => {
    if (configuredAppEnv === 'local') {
      return true
    }

    const allowedEmails = parseUrlList(environment.REGISTRATION_ALLOWLIST)
      .map((item) => item.toLowerCase())

    return Boolean(email && allowedEmails.includes(email.toLowerCase()))
  }

  return {
    appEnv: configuredAppEnv,
    allowedOrigins,
    csrfOrigins,
    authBaseUrl: configuredAuthBaseUrl,
    authBasePath: '/api/v1/auth',
    authTrustedOrigins: Array.from(
      new Set([
        new URL(configuredAuthBaseUrl).origin,
        ...allowedOrigins,
        ...csrfOrigins,
      ]),
    ),
    cookieDomain: environment.COOKIE_DOMAIN || undefined,
    cookieSecure: environment.COOKIE_SECURE === 'true' ||
      environment.NODE_ENV === 'production' ||
      configuredAppEnv === 'team-test',
    registrationAllowlist: parseUrlList(environment.REGISTRATION_ALLOWLIST),
    isRegistrationEmailAllowed,
    mail: {
      transport: mailTransport,
      fromAddress: mailFromAddress,
      fromName: mailFromName,
      resendApiKey,
      overrideRecipient: resendOverrideRecipient || undefined,
    },
    // 默认完全关闭。mock 仅由 Vitest 启动的 loopback OIDC 服务使用；真实 google
    // 模式必须由后续经业务方确认后提供的环境变量开启，凭据绝不写入代码或文档。
    googleOAuth: {
      mode: googleOAuthMode,
      clientId: googleOAuthClientId,
      clientSecret: googleOAuthClientSecret,
      discoveryUrl:
        googleOAuthMode === 'mock'
          ? localGoogleMockDiscoveryUrl
          : 'https://accounts.google.com/.well-known/openid-configuration',
    },
  }
}

export const runtimeConfig = createRuntimeConfig()

export const isRegistrationEmailAllowed = (email: string | undefined): boolean =>
  runtimeConfig.isRegistrationEmailAllowed(email)
