// 文件开头说明：验证 Better Auth 生成的 Admin Invitations 集合仍保持角色边界、
// 必填到期时间和未来时间校验；测试只使用本机一次性邀请数据，不发送真实邮件。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import config from '@/payload.config'

let payload: Payload

const invitationRoles = ['user', 'staff', 'admin'] as const

describe('Admin Invitations expiresAt', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('为 user、staff、admin 生成七天内的未来到期时间且保留只读/必填语义', async () => {
    const createdIds: number[] = []
    const collection = payload.collections['admin-invitations']
    const expiresAtField = collection.config.fields.find((field) => 'name' in field && field.name === 'expiresAt')

    expect(expiresAtField).toMatchObject({
      name: 'expiresAt',
      required: true,
      admin: { readOnly: true },
    })

    for (const role of invitationRoles) {
      const invitation = await payload.create({
        collection: 'admin-invitations',
        data: { role, token: `m2-047-${role}-${randomUUID()}` } as { role: typeof role, token: string, expiresAt: string },
        depth: 0,
        overrideAccess: true,
      })
      createdIds.push(Number(invitation.id))

      const expiresAt = new Date(invitation.expiresAt).getTime()
      const now = Date.now()
      expect(expiresAt).toBeGreaterThan(now)
      expect(expiresAt - now).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
      expect(expiresAt - now).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000)
      expect(invitation.role).toBe(role)
    }

    for (const id of createdIds) {
      await payload.delete({ collection: 'admin-invitations', id, overrideAccess: true })
    }
  })

  it('显式缺失、非法或过去的 expiresAt 仍被拒绝', async () => {
    const base = {
      role: 'staff' as const,
      token: `m2-047-invalid-${randomUUID()}`,
    }

    await expect(
      payload.create({
        collection: 'admin-invitations',
        data: { ...base, expiresAt: null as unknown as string },
        depth: 0,
        overrideAccess: true,
      }),
    ).rejects.toThrow()

    await expect(
      payload.create({
        collection: 'admin-invitations',
        data: { ...base, expiresAt: 'not-an-iso-date' },
        depth: 0,
        overrideAccess: true,
      }),
    ).rejects.toThrow()

    await expect(
      payload.create({
        collection: 'admin-invitations',
        data: { ...base, expiresAt: new Date(Date.now() - 1_000).toISOString() },
        depth: 0,
        overrideAccess: true,
      }),
    ).rejects.toThrow()
  })
})
