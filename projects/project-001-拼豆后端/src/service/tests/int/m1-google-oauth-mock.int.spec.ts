// 文件开头说明：以 Vitest 进程内的 loopback OIDC 服务验证 Google 登录最小门禁。
// 不会访问 Google、不需要真实 OAuth 凭据；覆盖授权码、PKCE、state、nonce、
// 签名、issuer、audience、email_verified 与禁止同邮箱隐式绑定。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { GET, POST } from '@/app/api/v1/auth/[...all]/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import config from '@/payload.config'

const origin = 'http://127.0.0.1:3000'

let payload: Payload

type SocialStart = {
  callbackResponse: Response
  callbackUrl: string
  cookies: string
  startResponse: Response
}

const request = (path: string, body?: Record<string, unknown>, cookie?: string): Request =>
  new Request(`${origin}/api/v1/auth${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      origin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const responseCookies = (response: Response): string => {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const setCookies = headers.getSetCookie?.() ?? [response.headers.get('set-cookie')].filter(Boolean)

  return setCookies.map((value) => value.split(';', 1)[0]).join('; ')
}

const mergeCookies = (...cookies: string[]): string =>
  Array.from(
    new Map(
      cookies
        .flatMap((value) => value.split('; '))
        .filter(Boolean)
        .map((value) => [value.split('=', 1)[0], value]),
    ).values(),
  ).join('; ')

const startGoogleFlow = async (
  email: string,
  options: {
    cookie?: string
    invalidClaim?: 'audience' | 'issuer' | 'nonce'
    emailVerified?: boolean
    link?: boolean
    requestSignUp?: boolean
  } = {},
): Promise<SocialStart> => {
  const path = options.link ? '/link-social' : '/sign-in/social'
  const startResponse = await POST(
    request(
      path,
      {
        provider: 'google',
        disableRedirect: true,
        callbackURL: `${origin}/google-complete`,
        loginHint: email,
        ...(options.link ? {} : { requestSignUp: options.requestSignUp ?? true }),
        ...(options.invalidClaim || options.emailVerified === false
          ? {
              additionalParams: {
                ...(options.invalidClaim ? { mock_invalid_claim: options.invalidClaim } : {}),
                ...(options.emailVerified === false ? { mock_email_verified: 'false' } : {}),
              },
            }
          : {}),
      },
      options.cookie,
    ),
  )
  expect(startResponse.status).toBe(200)
  expect(startResponse.headers.get('x-request-id')).toEqual(expect.any(String))
  const startBody = (await startResponse.json()) as { redirect: boolean; url: string }
  expect(startBody.redirect).toBe(false)
  const authorizationUrl = new URL(startBody.url)
  expect(authorizationUrl.origin).toBe('http://127.0.0.1:55441')
  expect(authorizationUrl.pathname).toBe('/authorize')
  expect(authorizationUrl.searchParams.get('state')).toEqual(expect.any(String))
  expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
  expect(authorizationUrl.searchParams.get('code_challenge')).toEqual(expect.any(String))
  expect(authorizationUrl.searchParams.get('nonce')).toEqual(expect.any(String))

  const authorizeResponse = await fetch(authorizationUrl, { redirect: 'manual' })
  expect(authorizeResponse.status).toBe(302)
  const callbackUrl = authorizeResponse.headers.get('location')
  if (!callbackUrl) {
    throw new Error('Google 本地 mock 没有返回 OAuth 回调地址。')
  }

  const cookies = mergeCookies(options.cookie ?? '', responseCookies(startResponse))
  const callback = new URL(callbackUrl)
  // The Next catch-all route receives only the segment following
  // /api/v1/auth. Passing the complete API pathname would double that prefix
  // in this direct Route Handler test and incorrectly return 404.
  const callbackResponse = await GET(request(`${callback.pathname.replace('/api/v1/auth', '')}${callback.search}`, undefined, cookies))

  return { callbackResponse, callbackUrl, cookies, startResponse }
}

const signInLocalVerifiedUser = async (email: string): Promise<string> => {
  const password = 'M1-local-google-link-password-2026'
  clearLocalMailOutbox()
  expect((await POST(request('/sign-up/email', { name: 'M1 Google Link Test', email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('本地 outbox 未生成 Google 绑定测试 OTP。')
  }
  expect((await POST(request('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const signedIn = await POST(request('/sign-in/email', { email, password }))
  expect(signedIn.status).toBe(200)
  const cookie = responseCookies(signedIn)
  if (!cookie) {
    throw new Error('本地账号没有创建用于 Google 显式绑定的会话。')
  }

  return cookie
}

const accountsForEmail = async (email: string): Promise<Array<Record<string, unknown>>> => {
  const pool = (payload.db as unknown as {
    pool: { query: (query: string, parameters: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> }
  }).pool
  return (
    await pool.query(
      `SELECT accounts.provider_id, accounts.issuer, accounts.account_id
       FROM accounts INNER JOIN users ON users.id = accounts.user_id
       WHERE users.email = $1 ORDER BY accounts.id ASC`,
      [email],
    )
  ).rows
}

const auditOutcomes = async (): Promise<Array<Record<string, unknown>>> => {
  const pool = (payload.db as unknown as {
    pool: { query: (query: string) => Promise<{ rows: Array<Record<string, unknown>> }> }
  }).pool
  return (
    await pool.query(
      `SELECT action, outcome, reason_code, route
       FROM security_audit_events WHERE action = 'auth.google_callback' ORDER BY id ASC`,
    )
  ).rows
}

describe('M1 Google 本地 OIDC mock', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
    const pool = (payload.db as unknown as { pool: { query: (query: string) => Promise<unknown> } }).pool
    await pool.query('DELETE FROM security_audit_events')
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('完整验证授权码、PKCE、state、nonce、签名、issuer、audience 后才创建 Google 会话', async () => {
    const email = `m1-google-valid-${randomUUID()}@example.com`
    const flow = await startGoogleFlow(email)

    expect(flow.callbackResponse.status).toBe(302)
    expect(flow.callbackResponse.headers.get('location')).toBe(`${origin}/google-complete`)
    const sessionCookie = responseCookies(flow.callbackResponse)
    expect(sessionCookie).toContain('better-auth.session_token')

    const sessionResponse = await GET(request('/get-session', undefined, mergeCookies(flow.cookies, sessionCookie)))
    expect(sessionResponse.status).toBe(200)
    await expect(sessionResponse.json()).resolves.toMatchObject({
      user: { email, emailVerified: true, accountStatus: 'active' },
    })
    expect(await accountsForEmail(email)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider_id: 'google', issuer: 'http://127.0.0.1:55441' }),
      ]),
    )
    expect(await auditOutcomes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'auth.google_callback',
          outcome: 'allowed',
          route: '/api/v1/auth/callback/google',
        }),
      ]),
    )
  })

  it('拒绝错误 issuer、audience、nonce 或未验证邮箱，不创建 Google 会话或账号', async () => {
    const rejectedCases: Array<{
      emailVerified?: false
      invalidClaim?: 'audience' | 'issuer' | 'nonce'
      name: string
    }> = [
      { name: 'issuer', invalidClaim: 'issuer' },
      { name: 'audience', invalidClaim: 'audience' },
      { name: 'nonce', invalidClaim: 'nonce' },
      { name: 'email_verified', emailVerified: false },
    ]

    for (const rejected of rejectedCases) {
      // Better Auth's database limiter uses a process-independent source
      // bucket. Clear this test-only counter per case so the four deliberate
      // rejection flows exercise token validation rather than prior traffic.
      await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
      const email = `m1-google-${rejected.name}-${randomUUID()}@example.com`
      const flow = await startGoogleFlow(email, rejected)

      expect(flow.callbackResponse.status).toBe(302)
      const location = flow.callbackResponse.headers.get('location')
      expect(location).toContain('error=')
      expect(responseCookies(flow.callbackResponse)).not.toContain('better-auth.session_token')
      expect(await accountsForEmail(email)).toEqual([])
    }

    expect(await auditOutcomes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'auth.google_callback', outcome: 'denied', reason_code: 'GOOGLE_CALLBACK_REJECTED' }),
      ]),
    )
  })

  it('同邮箱本地账号不能被 Google 静默绑定，只有已登录用户显式绑定后才关联', async () => {
    const email = `m1-google-link-${randomUUID()}@example.com`
    const localCookie = await signInLocalVerifiedUser(email)

    const implicitFlow = await startGoogleFlow(email, { requestSignUp: false })
    expect(implicitFlow.callbackResponse.status).toBe(302)
    expect(implicitFlow.callbackResponse.headers.get('location')).toContain('error=account_not_linked')
    expect(await accountsForEmail(email)).toHaveLength(1)

    const explicitFlow = await startGoogleFlow(email, { cookie: localCookie, link: true })
    expect(explicitFlow.callbackResponse.status).toBe(302)
    expect(explicitFlow.callbackResponse.headers.get('location')).toBe(`${origin}/google-complete`)
    expect(await accountsForEmail(email)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider_id: 'credential' }),
        expect.objectContaining({ provider_id: 'google', issuer: 'http://127.0.0.1:55441' }),
      ]),
    )
  })
})
