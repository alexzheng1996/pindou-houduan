// 文件开头说明：验证 M1.1 个人豆仓只使用本机 PostgreSQL 与随机测试账号。覆盖
// owner 隔离、余额版本、服务端图纸用量、负库存与幂等；不连接云对象存储或前端。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { POST as adjustInventoryPost } from '@/app/api/v1/inventory/adjustments/route'
import { DELETE as deleteInventoryOperation } from '@/app/api/v1/inventory/operations/[id]/route'
import { GET as getInventoryOperations } from '@/app/api/v1/inventory/operations/route'
import { GET as getInventory } from '@/app/api/v1/inventory/route'
import { POST as completeWorkPost } from '@/app/api/v1/works/[id]/complete/route'
import { GET as inventoryStatusGet } from '@/app/api/v1/works/[id]/inventory-status/route'
import { POST as createWorkPost } from '@/app/api/v1/works/route'
import { PATCH as updateWorkDocument } from '@/app/api/v1/works/[id]/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import config from '@/payload.config'

let payload: Payload
const origin = 'http://127.0.0.1:3000'

const patternDocument = (documentRevision: number, materialListRevision: number, title = 'M1.1 库存图纸') => ({
  schemaVersion: 1,
  kind: 'pattern',
  title,
  documentRevision,
  settings: {},
  pattern: {
    gridDimensions: { columns: 2, rows: 2 },
    mappedPixelData: [
      [
        { key: 'A1', color: '#123456', isExternal: false },
        { key: 'A1', color: '#123456', isExternal: false },
      ],
      [
        { key: 'B1', color: '#ABCDEF', isExternal: false },
        { key: 'ERASE', color: '#FFFFFF', isExternal: true },
      ],
    ],
    colorCounts: {
      A1: { color: '#123456', count: 2 },
      B1: { color: '#ABCDEF', count: 1 },
    },
    totalBeadCount: 3,
    beadSizeMm: 2.6,
  },
  board: null,
  materialList: documentRevision === 0
    ? { status: 'not_generated', items: [] }
    : {
        status: 'generated',
        generatedFromRevision: materialListRevision,
        items: [
          { colorKey: 'A1', color: '#123456', count: 2 },
          { colorKey: 'B1', color: '#ABCDEF', count: 1 },
        ],
      },
})

const authRequest = (path: string, body: Record<string, string>): Request =>
  new Request(`${origin}/api/v1/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  })

const jsonRequest = (path: string, method: string, cookie: string, body?: unknown, key?: string): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const signInVerifiedUser = async (): Promise<{ cookie: string }> => {
  const email = `m11-inventory-${randomUUID()}@example.com`
  const password = 'M11-inventory-password-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name: 'M11 Inventory', email, password }))).status).toBe(200)
  const outbox = getLocalMailOutbox()
  if (outbox[0]?.kind !== 'email-verification-otp') {
    throw new Error('M1.1 测试未获取邮箱验证 OTP。')
  }
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: outbox[0].otp }))).status).toBe(200)
  const response = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) {
    throw new Error('M1.1 测试未取得会话 Cookie。')
  }
  return { cookie }
}

const createActivePattern = async (cookie: string): Promise<string> => {
  const create = await createWorkPost(jsonRequest('/api/v1/works', 'POST', cookie, {
    title: 'M1.1 库存图纸',
    kind: 'pattern',
    document: patternDocument(0, 0),
  }, `create-${randomUUID()}`))
  expect(create.status, await create.clone().text()).toBe(201)
  const workId = ((await create.json()) as { work: { workId: string } }).work.workId
  const activate = await updateWorkDocument(
    jsonRequest(`/api/v1/works/${workId}/document`, 'PATCH', cookie, {
      expectedRevision: 0,
      document: patternDocument(0, 1),
    }, `activate-${randomUUID()}`),
    { params: Promise.resolve({ id: workId }) },
  )
  expect(activate.status).toBe(200)
  return workId
}

describe('M1.1 个人豆仓账本与制作扣减', () => {
  beforeAll(async () => {
    payload = await getPayload({ config: await config })
  })

  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
  })

  afterAll(async () => {
    await payload?.destroy()
  })

  it('按 owner + 规格 + HEX 隔离余额，并正确给出 49/50/100 健康度', async () => {
    const first = await signInVerifiedUser()
    const second = await signInVerifiedUser()
    const firstAdjustment = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', first.cookie, {
      kind: 'receipt',
      beadSizeMm: 2.6,
      lines: [
        { colorHex: '#123456', quantity: 49 },
        { colorHex: '#ABCDEF', quantity: 50 },
        { colorHex: '#FEDCBA', quantity: 100 },
      ],
    }, `adjust-${randomUUID()}`))
    expect(firstAdjustment.status, await firstAdjustment.clone().text()).toBe(200)
    const firstAdjustmentBody = await firstAdjustment.json() as { operation: { kind: string; lines: Array<{ colorHex: string; after: number }> } }
    expect(firstAdjustmentBody.operation.kind).toBe('receipt')
    expect(firstAdjustmentBody.operation.lines.some((line) => line.colorHex === '#123456' && line.after === 49)).toBe(true)

    const firstInventory = await getInventory(jsonRequest('/api/v1/inventory', 'GET', first.cookie))
    expect(firstInventory.status).toBe(200)
    const firstInventoryBody = await firstInventory.json() as { items: Array<{ colorHex: string; beadSizeMm: number; quantity: number; health: string }> }
    expect(firstInventoryBody.items.some((item) => item.colorHex === '#123456' && item.beadSizeMm === 2.6 && item.quantity === 49 && item.health === 'out_of_stock')).toBe(true)
    expect(firstInventoryBody.items.some((item) => item.colorHex === '#ABCDEF' && item.quantity === 50 && item.health === 'warning')).toBe(true)
    expect(firstInventoryBody.items.some((item) => item.colorHex === '#FEDCBA' && item.quantity === 100 && item.health === 'normal')).toBe(true)

    const secondInventory = await getInventory(jsonRequest('/api/v1/inventory', 'GET', second.cookie))
    expect(secondInventory.status).toBe(200)
    await expect(secondInventory.json()).resolves.toMatchObject({ items: [] })
  })

  it('库存状态和完成制作使用服务器保存的 pattern 用量，允许负库存且幂等', async () => {
    const user = await signInVerifiedUser()
    const workId = await createActivePattern(user.cookie)
    const statusBefore = await inventoryStatusGet(
      jsonRequest(`/api/v1/works/${workId}/inventory-status`, 'GET', user.cookie),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(statusBefore.status).toBe(200)
    const statusBeforeBody = await statusBefore.json() as { summary: { unrecordedColorCount: number; insufficientColorCount: number }; colors: Array<{ colorHex: string; requiredQuantity: number; availableQuantity: number | null }> }
    expect(statusBeforeBody.summary).toMatchObject({ unrecordedColorCount: 2, insufficientColorCount: 2 })
    expect(statusBeforeBody.colors.some((line) => line.colorHex === '#123456' && line.requiredQuantity === 2 && line.availableQuantity === null)).toBe(true)

    const key = `complete-${randomUUID()}`
    const firstComplete = await completeWorkPost(
      jsonRequest(`/api/v1/works/${workId}/complete`, 'POST', user.cookie, {}, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(firstComplete.status).toBe(200)
    const firstBody = await firstComplete.json() as { operation: { operationId: string; kind: string; lines: Array<{ colorHex: string; after: number }> } }
    expect(firstBody.operation.kind).toBe('production_decrement')
    expect(firstBody.operation.lines.some((line) => line.colorHex === '#123456' && line.after === -2)).toBe(true)
    expect(firstBody.operation.lines.some((line) => line.colorHex === '#ABCDEF' && line.after === -1)).toBe(true)

    const retryComplete = await completeWorkPost(
      jsonRequest(`/api/v1/works/${workId}/complete`, 'POST', user.cookie, {}, key),
      { params: Promise.resolve({ id: workId }) },
    )
    expect(retryComplete.status).toBe(200)
    await expect(retryComplete.json()).resolves.toMatchObject({ operation: { operationId: firstBody.operation.operationId } })

    const inventory = await getInventory(jsonRequest('/api/v1/inventory', 'GET', user.cookie))
    expect(inventory.status).toBe(200)
    const inventoryBody = await inventory.json() as { items: Array<{ colorHex: string; quantity: number; health: string }> }
    expect(inventoryBody.items.some((item) => item.colorHex === '#123456' && item.quantity === -2 && item.health === 'negative')).toBe(true)
    expect(inventoryBody.items.some((item) => item.colorHex === '#ABCDEF' && item.quantity === -1 && item.health === 'negative')).toBe(true)
  })

  it('旧余额 revision 被拒绝，不会覆盖同账号的新调整', async () => {
    const user = await signInVerifiedUser()
    const initial = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', user.cookie, {
      kind: 'receipt', beadSizeMm: 5, lines: [{ colorHex: '#654321', quantity: 10 }],
    }, `initial-${randomUUID()}`))
    const initialBody = await initial.json() as { operation: { lines: Array<{ revision: number }> } }
    expect(initial.status).toBe(200)
    const revision = initialBody.operation.lines[0]?.revision
    expect(revision).toBe(1)

    const fresh = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', user.cookie, {
      kind: 'receipt', beadSizeMm: 5, lines: [{ colorHex: '#654321', quantity: 1, expectedRevision: revision }],
    }, `fresh-${randomUUID()}`))
    expect(fresh.status).toBe(200)
    const stale = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', user.cookie, {
      kind: 'manual_decrement', beadSizeMm: 5, lines: [{ colorHex: '#654321', quantity: 1, expectedRevision: revision }],
    }, `stale-${randomUUID()}`))
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ error: { code: 'INVENTORY_REVISION_CONFLICT' } })
  })

  it('删除原库存操作会原子回滚余额，原操作隐藏且回滚操作不能再次删除', async () => {
    const user = await signInVerifiedUser()
    const receipt = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', user.cookie, {
      kind: 'receipt', beadSizeMm: 2.6, lines: [{ colorHex: '#112233', quantity: 12 }],
    }, `receipt-${randomUUID()}`))
    expect(receipt.status).toBe(200)
    const receiptBody = await receipt.json() as { operation: { operationId: string } }

    const reversal = await deleteInventoryOperation(
      jsonRequest(`/api/v1/inventory/operations/${receiptBody.operation.operationId}`, 'DELETE', user.cookie, { reason: '测试回滚' }, `reversal-${randomUUID()}`),
      { params: Promise.resolve({ id: receiptBody.operation.operationId }) },
    )
    expect(reversal.status, await reversal.clone().text()).toBe(200)
    const reversalBody = await reversal.json() as { operation: { operationId: string; kind: string; lines: Array<{ after: number }> } }
    expect(reversalBody.operation.kind).toBe('deletion_reversal')
    expect(reversalBody.operation.lines[0]?.after).toBe(0)

    const inventory = await getInventory(jsonRequest('/api/v1/inventory', 'GET', user.cookie))
    const inventoryBody = await inventory.json() as { items: Array<{ colorHex: string; quantity: number }> }
    expect(inventoryBody.items.some((item) => item.colorHex === '#112233' && item.quantity === 0)).toBe(true)

    const history = await getInventoryOperations(jsonRequest('/api/v1/inventory/operations', 'GET', user.cookie))
    expect(history.status).toBe(200)
    const historyBody = await history.json() as { operations: Array<{ operationId: string; kind: string }> }
    expect(historyBody.operations.some((operation) => operation.operationId === receiptBody.operation.operationId)).toBe(false)
    expect(historyBody.operations.some((operation) => operation.operationId === reversalBody.operation.operationId && operation.kind === 'deletion_reversal')).toBe(true)

    const repeated = await deleteInventoryOperation(
      jsonRequest(`/api/v1/inventory/operations/${reversalBody.operation.operationId}`, 'DELETE', user.cookie, {}, `repeated-${randomUUID()}`),
      { params: Promise.resolve({ id: reversalBody.operation.operationId }) },
    )
    expect(repeated.status).toBe(409)
    await expect(repeated.json()).resolves.toMatchObject({ error: { code: 'INVENTORY_OPERATION_NOT_REVERSIBLE' } })
  })
})
