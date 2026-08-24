// 文件开头说明：以本地 outbox 模拟受控邮件投递，覆盖 M1 的邮箱验证和登录安全闭环。
// 本测试不发送真实邮件、不记录验证码，并依赖已顺序执行的本地认证迁移。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { clearLocalMailOutbox, getLatestLocalEmailVerificationOtp, getLocalMailOutbox } from '@/auth/config'
import { GET, POST } from '@/app/api/v1/auth/[...all]/route'
import config from '@/payload.config'

let payload: Payload

const request = (path: string, body: Record<string, string>): Request =>
  new Request(`http://127.0.0.1:3002/api/v1/auth${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://127.0.0.1:3002',
    },
    body: JSON.stringify(body),
  })

const getRequest = (path: string, cookie?: string): Request =>
  new Request(`http://127.0.0.1:3002/api/v1/auth${path}`, {
    headers: {
      origin: 'http://127.0.0.1:3002',
      ...(cookie ? { cookie } : {}),
    },
  })

describe('M1 一次性邮箱验证', () => {
  beforeAll(async () => {
    const payloadConfig = await config
    payload = await getPayload({ config: payloadConfig })
  })

  beforeEach(async () => {
    // The database-backed rate limiter intentionally survives process restarts.
    // Clear only the local test counter so re-running this suite never inherits
    // a previous run's 60-second request bucket.
    await payload.delete({
      collection: 'rateLimit',
      overrideAccess: true,
      where: {},
    })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('仅把验证码哈希入库，首次验证激活账号，重放与免密码登录均被拒绝', async () => {
    const email = `m1-otp-${randomUUID()}@example.com`
    const password = 'M1-local-password-2026'

    clearLocalMailOutbox()

    const signUpResponse = await POST(
      request('/sign-up/email', {
        name: 'M1 OTP Verification Test',
        email,
        password,
      }),
    )
    expect(signUpResponse.status).toBe(200)
    expect(signUpResponse.headers.get('x-request-id')).toEqual(expect.any(String))

    const outbox = getLocalMailOutbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]).toMatchObject({ kind: 'email-verification-otp', email })

    if (outbox[0]?.kind !== 'email-verification-otp') {
      throw new Error('本地 outbox 未生成邮箱验证 OTP。')
    }

    const storedVerification = await payload.find({
      collection: 'verifications',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: '-createdAt',
    })

    expect(storedVerification.docs).toHaveLength(1)
    expect(storedVerification.docs[0]?.value).not.toContain(outbox[0].otp)
    expect(storedVerification.docs[0]?.value).not.toMatch(/^\d{6}:0$/)

    const verifyResponse = await POST(
      request('/email-otp/verify-email', {
        email,
        otp: outbox[0].otp,
      }),
    )
    expect(verifyResponse.status).toBe(200)
    await expect(verifyResponse.json()).resolves.toMatchObject({
      status: true,
      user: {
        email,
        emailVerified: true,
        accountStatus: 'active',
      },
    })

    const replayResponse = await POST(
      request('/email-otp/verify-email', {
        email,
        otp: outbox[0].otp,
      }),
    )
    expect(replayResponse.status).toBeGreaterThanOrEqual(400)

    const passwordLoginResponse = await POST(
      request('/sign-in/email', {
        email,
        password,
      }),
    )
    expect(passwordLoginResponse.status).toBe(200)

    const passwordlessLoginResponse = await POST(
      request('/sign-in/email-otp', {
        email,
        otp: outbox[0].otp,
      }),
    )
    expect(passwordlessLoginResponse.status).toBe(404)
  })

  it('本机测试读取只返回指定邮箱最新 OTP，不读取重设令牌', async () => {
    const email = `m1-local-outbox-${randomUUID()}@example.com`
    const password = 'M1-local-password-2026'

    clearLocalMailOutbox()
    expect(
      (
        await POST(
          request('/sign-up/email', {
            name: 'M1 Local Outbox Test',
            email,
            password,
          }),
        )
      ).status,
    ).toBe(200)

    const outbox = getLocalMailOutbox()
    if (outbox[0]?.kind !== 'email-verification-otp') {
      throw new Error('本地 outbox 未生成邮箱验证 OTP。')
    }

    expect(getLatestLocalEmailVerificationOtp(email)).toBe(outbox[0].otp)
    expect(getLatestLocalEmailVerificationOtp(`missing-${randomUUID()}@example.com`)).toBeNull()

    const localOtpResponse = await GET(
      getRequest(`/local-test/email-verification-otp?email=${encodeURIComponent(email)}`),
    )
    expect(localOtpResponse.status).toBe(200)
    await expect(localOtpResponse.json()).resolves.toEqual({ otp: outbox[0].otp })

    const missingOtpResponse = await GET(
      getRequest(`/local-test/email-verification-otp?email=missing-${randomUUID()}%40example.com`),
    )
    expect(missingOtpResponse.status).toBe(404)
  })

  it('连续 5 次密码失败锁定 15 分钟，停用账号不能创建会话', async () => {
    const email = `m1-login-guard-${randomUUID()}@example.com`
    const password = 'M1-local-password-2026'

    clearLocalMailOutbox()
    expect(
      (
        await POST(
          request('/sign-up/email', {
            name: 'M1 Login Guard Test',
            email,
            password,
          }),
        )
      ).status,
    ).toBe(200)

    const outbox = getLocalMailOutbox()
    if (outbox[0]?.kind !== 'email-verification-otp') {
      throw new Error('本地 outbox 未生成邮箱验证 OTP。')
    }

    expect(
      (
        await POST(
          request('/email-otp/verify-email', {
            email,
            otp: outbox[0].otp,
          }),
        )
      ).status,
    ).toBe(200)

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const failedLoginResponse = await POST(
        request('/sign-in/email', {
          email,
          password: 'incorrect-password',
        }),
      )
      expect(failedLoginResponse.status).toBe(401)
    }

    const fifthFailedLoginResponse = await POST(
      request('/sign-in/email', {
        email,
        password: 'incorrect-password',
      }),
    )
    expect(fifthFailedLoginResponse.status).toBe(429)
    expect(fifthFailedLoginResponse.headers.get('Retry-After')).toBe('900')

    const correctPasswordWhileLocked = await POST(
      request('/sign-in/email', {
        email,
        password,
      }),
    )
    expect(correctPasswordWhileLocked.status).toBe(429)

    const user = await payload.find({
      collection: 'users',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      where: {
        email: {
          equals: email,
        },
      },
    })
    const userId = user.docs[0]?.id
    if (!userId) {
      throw new Error('未找到已验证的登录门禁测试用户。')
    }

    await (payload.db as unknown as { pool: { query: (query: string, parameters: unknown[]) => Promise<void> } }).pool.query(
      'UPDATE users SET account_status = $1, login_locked_until = NULL WHERE id = $2',
      ['suspended', userId],
    )

    const suspendedLoginResponse = await POST(
      request('/sign-in/email', {
        email,
        password,
      }),
    )
    expect(suspendedLoginResponse.status).toBe(403)
    await expect(suspendedLoginResponse.json()).resolves.toMatchObject({ code: 'ACCOUNT_UNAVAILABLE' })
  })

  it('重设令牌不以明文落库、只能使用一次，并撤销重设前会话', async () => {
    const email = `m1-password-reset-${randomUUID()}@example.com`
    const password = 'M1-local-password-2026'
    const replacementPassword = 'M1-replacement-password-2026'

    clearLocalMailOutbox()
    expect(
      (
        await POST(
          request('/sign-up/email', {
            name: 'M1 Password Reset Test',
            email,
            password,
          }),
        )
      ).status,
    ).toBe(200)

    const verificationOutbox = getLocalMailOutbox()
    if (verificationOutbox[0]?.kind !== 'email-verification-otp') {
      throw new Error('本地 outbox 未生成邮箱验证 OTP。')
    }

    expect(
      (
        await POST(
          request('/email-otp/verify-email', {
            email,
            otp: verificationOutbox[0].otp,
          }),
        )
      ).status,
    ).toBe(200)

    const signedInResponse = await POST(
      request('/sign-in/email', {
        email,
        password,
      }),
    )
    expect(signedInResponse.status).toBe(200)
    const oldSessionCookie = signedInResponse.headers.get('set-cookie')?.split(';')[0]
    expect(oldSessionCookie).toBeTruthy()
    await expect(GET(getRequest('/get-session', oldSessionCookie))).resolves.toHaveProperty('status', 200)

    clearLocalMailOutbox()
    const resetRequestResponse = await POST(request('/request-password-reset', { email }))
    expect(resetRequestResponse.status).toBe(200)
    await expect(resetRequestResponse.json()).resolves.toMatchObject({ status: true })

    const resetOutbox = getLocalMailOutbox()
    expect(resetOutbox).toHaveLength(1)
    if (resetOutbox[0]?.kind !== 'password-reset') {
      throw new Error('本地 outbox 未生成密码重设令牌。')
    }

    const storedResetVerification = await payload.find({
      collection: 'verifications',
      depth: 0,
      limit: 1,
      overrideAccess: true,
      sort: '-createdAt',
    })
    expect(storedResetVerification.docs[0]?.identifier).not.toContain(resetOutbox[0].token)

    const resetResponse = await POST(
      request('/reset-password', {
        token: resetOutbox[0].token,
        newPassword: replacementPassword,
      }),
    )
    expect(resetResponse.status).toBe(200)

    const oldSessionResponse = await GET(getRequest('/get-session', oldSessionCookie))
    expect(oldSessionResponse.status).toBe(200)
    await expect(oldSessionResponse.json()).resolves.toBeNull()

    const replayResponse = await POST(
      request('/reset-password', {
        token: resetOutbox[0].token,
        newPassword: replacementPassword,
      }),
    )
    expect(replayResponse.status).toBeGreaterThanOrEqual(400)

    expect(
      (
        await POST(
          request('/sign-in/email', {
            email,
            password,
          }),
        )
      ).status,
    ).toBe(401)
    expect(
      (
        await POST(
          request('/sign-in/email', {
            email,
            password: replacementPassword,
          }),
        )
      ).status,
    ).toBe(200)
  })
})
