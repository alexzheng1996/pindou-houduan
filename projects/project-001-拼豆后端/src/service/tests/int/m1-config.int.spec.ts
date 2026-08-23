import { describe, expect, it } from 'vitest'

import { authInternalCollections } from '@/auth/collections'
import { betterAuthOptions } from '@/auth/config'
import { createPayloadEmailAdapter } from '@/auth/mail'
import { Users, accountStatuses, userRoles } from '@/collections/Users'
import {
  createRuntimeConfig,
  isRegistrationEmailAllowed,
  parseUrlList,
  runtimeConfig,
} from '@/config/runtime'

describe('M1 账号基础配置', () => {
  it('固定角色与账号状态枚举，并把身份来源收敛到 Better Auth accounts', () => {
    expect(userRoles).toEqual(['user', 'staff', 'admin'])
    expect(accountStatuses).toEqual(['pending_verification', 'active', 'suspended'])

    expect(Users.fields).toEqual([])
    expect(authInternalCollections.map((collection) => collection.slug)).toEqual([
      'accounts',
      'sessions',
      'verifications',
      'rateLimit',
    ])
  })

  it('默认只允许管理员访问 Payload 管理面，内部认证适配器可访问认证记录', () => {
    const access = Users.access ?? {}
    type MinimalRequest = { req: { user: { role: string }; context?: Record<string, unknown> } }
    const adminRequest: MinimalRequest = { req: { user: { role: 'admin' } } }
    const userRequest: MinimalRequest = { req: { user: { role: 'user' } } }
    const adapterRequest: MinimalRequest = {
      req: { user: { role: 'user' }, context: { 'payload-db-adapter': {} } },
    }
    const callAccess = (permission: unknown, request: MinimalRequest) =>
      (permission as (args: MinimalRequest) => boolean)(request)

    expect(callAccess(access.admin, adminRequest)).toBe(true)
    expect(callAccess(access.read, adminRequest)).toBe(true)
    expect(callAccess(access.read, adapterRequest)).toBe(true)
    expect(callAccess(access.update, userRequest)).toBe(false)
    expect(callAccess(access.delete, userRequest)).toBe(false)
    expect(callAccess(access.create, userRequest)).toBe(false)

    const accounts = authInternalCollections[0]
    expect(callAccess(accounts.access?.read, adapterRequest)).toBe(true)
    expect(callAccess(accounts.access?.read, userRequest)).toBe(false)
  })

  it('禁用 Payload Local Auth，由 Better Auth 接管密码与会话', () => {
    expect(Users.auth).toBeUndefined()
  })

  it('邮箱验证使用一次性、限时、哈希存储的 OTP，而非可重放 JWT', () => {
    const emailOtpPlugin = betterAuthOptions.plugins?.find((plugin) => plugin.id === 'email-otp')

    expect(emailOtpPlugin).toBeDefined()
    expect(betterAuthOptions.emailVerification?.expiresIn).toBe(15 * 60)
  })
})

describe('M1 环境白名单解析', () => {
  it('去除空白和空项，但不改写来源值', () => {
    expect(parseUrlList(' https://app.example , ,https://test.example ')).toEqual([
      'https://app.example',
      'https://test.example',
    ])
    expect(parseUrlList(undefined)).toEqual([])
  })

  it('本地允许脱敏测试注册，并冻结 Better Auth 路由与可信来源', () => {
    expect(isRegistrationEmailAllowed('local-test@example.com')).toBe(true)
    expect(runtimeConfig.authBasePath).toBe('/api/v1/auth')
    expect(runtimeConfig.authTrustedOrigins).toContain('http://127.0.0.1:3000')
    expect(runtimeConfig.allowedOrigins).toContain('http://127.0.0.1:3000')
  })

  it('本机邮件只使用进程内 outbox 适配器，不会退回控制台或调用真实 Resend', () => {
    expect(runtimeConfig.mail.transport).toBe('local-outbox')
    expect(runtimeConfig.mail.resendApiKey).toBeUndefined()

    const adapter = createPayloadEmailAdapter()({} as never)
    expect(adapter.name).toBe('pixomosaic-local-outbox')
    expect(adapter.defaultFromAddress).toBe('no-reply@local.invalid')
  })

  it('team-test 的 Resend 不继承本机占位发件人，缺任一真实配置都拒绝启动', () => {
    const teamTestEnvironment = {
      NODE_ENV: 'test',
      APP_ENV: 'team-test',
      AUTH_BASE_URL: 'https://api-test.pixomosaic.com',
      ALLOWED_ORIGINS: 'https://test.pixomosaic.com',
      CSRF_ORIGINS: 'https://test.pixomosaic.com',
      MAIL_TRANSPORT: 'resend',
    }

    expect(() => createRuntimeConfig(teamTestEnvironment)).toThrow(
      'RESEND_API_KEY、MAIL_FROM_ADDRESS 和 MAIL_FROM_NAME',
    )
    expect(() =>
      createRuntimeConfig({
        ...teamTestEnvironment,
        RESEND_API_KEY: 'test-only-key',
        MAIL_FROM_ADDRESS: 'no-reply@test.pixomosaic.com',
      }),
    ).toThrow('RESEND_API_KEY、MAIL_FROM_ADDRESS 和 MAIL_FROM_NAME')

    const config = createRuntimeConfig({
      ...teamTestEnvironment,
      RESEND_API_KEY: 'test-only-key',
      MAIL_FROM_ADDRESS: 'no-reply@test.pixomosaic.com',
      MAIL_FROM_NAME: 'PixoMosaic Team Test',
    })
    expect(config.mail).toMatchObject({
      transport: 'resend',
      fromAddress: 'no-reply@test.pixomosaic.com',
      fromName: 'PixoMosaic Team Test',
    })
    expect(config.cookieSecure).toBe(true)
  })
})
