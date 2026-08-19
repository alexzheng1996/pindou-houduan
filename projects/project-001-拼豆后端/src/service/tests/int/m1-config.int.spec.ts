import { describe, expect, it } from 'vitest'

import { Users, accountStatuses, authProviders, userRoles } from '@/collections/Users'
import { parseUrlList } from '@/config/runtime'

describe('M1 账号基础配置', () => {
  it('固定角色、账号状态和认证来源枚举', () => {
    expect(userRoles).toEqual(['user', 'staff', 'admin'])
    expect(accountStatuses).toEqual(['pending_verification', 'active', 'suspended'])
    expect(authProviders).toEqual(['local', 'google'])

    const fields = Users.fields ?? []
    expect(fields.filter((field): field is Extract<typeof field, { name: string }> => 'name' in field).map((field) => field.name)).toEqual([
      'role',
      'accountStatus',
      'authProvider',
      'googleSubject',
      'termsVersion',
      'termsAcceptedAt',
    ])
  })

  it('默认只允许管理员访问 Payload 管理面', () => {
    const access = Users.access ?? {}
    type MinimalRequest = { req: { user: { role: string } } }
    const adminRequest: MinimalRequest = { req: { user: { role: 'admin' } } }
    const userRequest: MinimalRequest = { req: { user: { role: 'user' } } }
    const callAccess = (permission: unknown, request: MinimalRequest) =>
      (permission as (args: MinimalRequest) => boolean)(request)

    expect(callAccess(access.admin, adminRequest)).toBe(true)
    expect(callAccess(access.read, adminRequest)).toBe(true)
    expect(callAccess(access.update, userRequest)).toBe(false)
    expect(callAccess(access.delete, userRequest)).toBe(false)
    expect(callAccess(access.create, userRequest)).toBe(false)
  })

  it('启用邮箱验证、失败锁定和受控浏览器 Cookie', () => {
    expect(Users.auth).toMatchObject({
      lockTime: 15 * 60 * 1000,
      maxLoginAttempts: 5,
      tokenExpiration: 2 * 60 * 60,
      verify: true,
    })
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
})
