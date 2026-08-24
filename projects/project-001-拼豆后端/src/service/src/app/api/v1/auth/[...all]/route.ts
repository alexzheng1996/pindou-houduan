// 文件开头说明：M1 唯一的浏览器认证入口。其底层由 Better Auth 处理，业务 API
// 仍保持在 /api/v1，不能把 Payload Admin/REST 当作 PixoMosaic 的业务契约。
import config from '@payload-config'
import { getPayloadAuth } from 'payload-auth/better-auth/plugin'

import { createAuthCorsHeaders, withAuthCors } from '@/auth/cors'
import { getLatestLocalEmailVerificationOtp } from '@/auth/mail'
import { createRequestId } from '@/api/business-http'
import { runtimeConfig } from '@/config/runtime'
import {
  clearLoginFailures,
  getLoginBlockResponse,
  getLoginEmail,
  getLoginGuardUser,
  recordFailedLogin,
} from '@/auth/login-guard'
import { recordSecurityAuditEvent, type SecurityAuditAction } from '@/security/audit'

const disabledEmailOtpPaths = new Set([
  '/api/v1/auth/email-otp/send-verification-otp',
  '/api/v1/auth/email-otp/check-verification-otp',
  '/api/v1/auth/email-otp/request-password-reset',
  '/api/v1/auth/email-otp/reset-password',
  '/api/v1/auth/email-otp/request-email-change',
  '/api/v1/auth/email-otp/change-email',
  '/api/v1/auth/sign-in/email-otp',
  '/api/v1/auth/forget-password/email-otp',
])

const emailPasswordSignInPath = '/api/v1/auth/sign-in/email'
const localTestOtpPath = '/api/v1/auth/local-test/email-verification-otp'

const localTestOtpResponse = (
  request: Request,
  requestId: string,
  status: number,
  body: Record<string, string>,
): Response => withAuthCors(request, Response.json(body, { status }), requestId)

const isLoopbackRequest = (request: Request): boolean => {
  const hostname = new URL(request.url).hostname

  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

const handleLocalTestOtp = (request: Request, requestId: string): Response => {
  // This endpoint deliberately exposes a one-time value only to the local
  // manual-test UI. It must not be available when a team-test or production
  // process is started, even if a caller can reach a loopback address.
  const allowedOrigin = createAuthCorsHeaders(request).get('Access-Control-Allow-Origin')
  if (runtimeConfig.appEnv !== 'local' || !isLoopbackRequest(request) || !allowedOrigin) {
    return localTestOtpResponse(request, requestId, 404, {
      code: 'LOCAL_TEST_ENDPOINT_UNAVAILABLE',
      message: '本机测试验证码入口不可用。',
    })
  }

  const email = new URL(request.url).searchParams.get('email')?.trim() || ''
  if (!email || email.length > 320) {
    return localTestOtpResponse(request, requestId, 400, {
      code: 'EMAIL_REQUIRED',
      message: '请填写用于注册的邮箱。',
    })
  }

  const otp = getLatestLocalEmailVerificationOtp(email)
  if (!otp) {
    return localTestOtpResponse(request, requestId, 404, {
      code: 'LOCAL_TEST_OTP_NOT_FOUND',
      message: '未找到当前邮箱的本机验证码，请先重新提交注册。',
    })
  }

  return localTestOtpResponse(request, requestId, 200, { otp })
}

const handle = async (request: Request): Promise<Response> => {
  // emailOTP is used only to meet M1's one-time email-verification rule.
  // Do not accidentally turn on its optional passwordless-login/reset flows.
  const requestId = createRequestId()
  const path = new URL(request.url).pathname
  const auditRoute = path.replace(/^\/api\/v1\/auth/, '/api/v1/auth')
  if (request.method === 'GET' && path === localTestOtpPath) {
    return handleLocalTestOtp(request, requestId)
  }
  if (disabledEmailOtpPaths.has(path)) {
    return withAuthCors(request, new Response(null, { status: 404 }), requestId)
  }

  const payload = await getPayloadAuth(config)
  const isEmailPasswordSignIn = new URL(request.url).pathname === emailPasswordSignInPath
  const canContainEmail = new Set([
    '/api/v1/auth/sign-up/email',
    '/api/v1/auth/sign-in/email',
    '/api/v1/auth/email-otp/verify-email',
    '/api/v1/auth/request-password-reset',
  ]).has(path)
  const email = canContainEmail ? await getLoginEmail(request) : null
  const user = email ? await getLoginGuardUser(payload, email) : null
  const recordAuthAudit = async (
    action: SecurityAuditAction,
    outcome: 'allowed' | 'denied',
    reasonCode?: string,
  ): Promise<void> => {
    try {
      await recordSecurityAuditEvent(payload, {
        action,
        actorId: user?.id,
        outcome,
        reasonCode,
        requestId,
        route: auditRoute,
      })
    } catch {
      // Authentication and account-lock enforcement cannot become unavailable
      // just because the audit database write is temporarily unavailable.
    }
  }
  const blockedResponse = user ? getLoginBlockResponse(user) : null

  if (blockedResponse) {
    await recordAuthAudit('auth.login_blocked', 'denied', 'ACCOUNT_UNAVAILABLE')
    return withAuthCors(request, blockedResponse, requestId)
  }

  const response = await payload.betterAuth.handler(request)

  if (isEmailPasswordSignIn && user) {
    if (response.ok) {
      await clearLoginFailures(payload, user.id)
      await recordAuthAudit('auth.login_succeeded', 'allowed')
    } else if (response.status === 401 && (await recordFailedLogin(payload, user.id))) {
      await recordAuthAudit('auth.login_failed', 'denied', 'LOGIN_TEMPORARILY_LOCKED')
      return withAuthCors(
        request,
        Response.json(
          { code: 'LOGIN_TEMPORARILY_LOCKED', message: '登录尝试次数过多，请稍后再试。' },
          { status: 429, headers: { 'Retry-After': '900' } },
        ),
        requestId,
      )
    } else if (response.status === 401) {
      await recordAuthAudit('auth.login_failed', 'denied', 'AUTH_INVALID')
    }
  }

  if (response.ok && path === '/api/v1/auth/sign-up/email') {
    await recordAuthAudit('auth.registration', 'allowed')
  } else if (response.ok && path === '/api/v1/auth/email-otp/verify-email') {
    await recordAuthAudit('auth.email_verified', 'allowed')
  } else if (response.ok && path === '/api/v1/auth/request-password-reset') {
    await recordAuthAudit('auth.password_reset_requested', 'allowed')
  } else if (response.ok && path === '/api/v1/auth/reset-password') {
    await recordAuthAudit('auth.password_reset_completed', 'allowed')
  }

  if (path === '/api/v1/auth/callback/google') {
    // OAuth callbacks are redirects even when they fail. Record only the
    // fixed result category, never the returned provider profile, code,
    // state, token or redirect URL.
    const redirectTarget = response.headers.get('location')
    const callbackError = redirectTarget ? new URL(redirectTarget, request.url).searchParams.get('error') : null
    await recordAuthAudit(
      'auth.google_callback',
      callbackError ? 'denied' : 'allowed',
      callbackError ? 'GOOGLE_CALLBACK_REJECTED' : undefined,
    )
  }

  return withAuthCors(request, response, requestId)
}

export const GET = handle
export const POST = handle

export const OPTIONS = async (request: Request): Promise<Response> => {
  const allowedOrigin = createAuthCorsHeaders(request).get('Access-Control-Allow-Origin')

  if (!allowedOrigin) {
    return new Response(null, { status: 403 })
  }

  return new Response(null, {
    status: 204,
    headers: new Headers({
      ...Object.fromEntries(createAuthCorsHeaders(request)),
      'X-Request-Id': createRequestId(),
    }),
  })
}
