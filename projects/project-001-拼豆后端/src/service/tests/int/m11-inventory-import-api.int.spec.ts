// 文件开头说明：通过真实 M1.1 路由验证库存 CSV 导入的“预检冻结→确认记账”闭环。
// 覆盖前端最容易造成错账的映射歧义、余额变动冲突、同键重试和缺货 CSV；不连接云端。
import { randomUUID } from 'crypto'

import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { POST as authPost } from '@/app/api/v1/auth/[...all]/route'
import { POST as adjustInventoryPost } from '@/app/api/v1/inventory/adjustments/route'
import { POST as commitImportPost } from '@/app/api/v1/inventory/imports/commit/route'
import { POST as previewImportPost } from '@/app/api/v1/inventory/imports/preview/route'
import { GET as templateGet } from '@/app/api/v1/inventory/template/route'
import { GET as shortagesGet } from '@/app/api/v1/works/[id]/inventory-shortages/route'
import { POST as createWorkPost } from '@/app/api/v1/works/route'
import { PATCH as updateWorkDocument } from '@/app/api/v1/works/[id]/route'
import { clearLocalMailOutbox, getLocalMailOutbox } from '@/auth/config'
import { requireActiveSession } from '@/auth/require-session'
import { getWorkInventoryShortageCsv } from '@/inventory/service'
import config from '@/payload.config'

let payload: Payload
const origin = 'http://127.0.0.1:3002'

const patternDocument = (documentRevision: number, materialListRevision: number) => ({
  schemaVersion: 1,
  kind: 'pattern',
  title: 'CSV 库存图纸',
  documentRevision,
  settings: {},
  pattern: {
    gridDimensions: { columns: 2, rows: 1 },
    mappedPixelData: [[
      { key: 'A01', color: '#FAF4C8', isExternal: false },
      { key: 'A01', color: '#FAF4C8', isExternal: false },
    ]],
    colorCounts: { A01: { color: '#FAF4C8', count: 2 } },
    totalBeadCount: 2,
    beadSizeMm: 2.6,
  },
  board: null,
  materialList: documentRevision === 0
    ? { status: 'not_generated', items: [] }
    : { status: 'generated', generatedFromRevision: materialListRevision, items: [{ colorKey: 'A01', color: '#FAF4C8', count: 2 }] },
})

const authRequest = (path: string, body: Record<string, string>): Request =>
  new Request(`${origin}/api/v1/auth${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body),
  })

const jsonRequest = (path: string, method: string, cookie: string, body?: unknown, key?: string): Request =>
  new Request(`${origin}${path}`, {
    method,
    headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie, ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const csvRequest = (path: string, cookie: string, csv: string, key: string): Request =>
  new Request(`${origin}${path}`, {
    method: 'POST', headers: { origin, cookie, 'content-type': 'text/csv; charset=utf-8', 'idempotency-key': key }, body: csv,
  })

const signInVerifiedUser = async (): Promise<{ cookie: string }> => {
  const email = `m11-import-${randomUUID()}@example.com`
  const password = 'M11-import-password-2026'
  clearLocalMailOutbox()
  expect((await authPost(authRequest('/sign-up/email', { name: 'M11 Import', email, password }))).status).toBe(200)
  const otp = getLocalMailOutbox()[0]
  if (otp?.kind !== 'email-verification-otp') throw new Error('未获取导入测试 OTP。')
  expect((await authPost(authRequest('/email-otp/verify-email', { email, otp: otp.otp }))).status).toBe(200)
  const response = await authPost(authRequest('/sign-in/email', { email, password }))
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('未获取导入测试会话。')
  return { cookie }
}

const createActivePattern = async (cookie: string): Promise<string> => {
  const created = await createWorkPost(jsonRequest('/api/v1/works', 'POST', cookie, {
    title: 'CSV 库存图纸', kind: 'pattern', document: patternDocument(0, 0),
  }, `create-${randomUUID()}`))
  expect(created.status).toBe(201)
  const workId = ((await created.json()) as { work: { workId: string } }).work.workId
  const activated = await updateWorkDocument(jsonRequest(`/api/v1/works/${workId}/document`, 'PATCH', cookie, {
    expectedRevision: 0, document: patternDocument(0, 1),
  }, `activate-${randomUUID()}`), { params: Promise.resolve({ id: workId }) })
  expect(activated.status).toBe(200)
  return workId
}

describe('M1.1 CSV 导入与缺货导出', () => {
  beforeAll(async () => { payload = await getPayload({ config: await config }) })
  beforeEach(async () => {
    await payload.delete({ collection: 'rateLimit', overrideAccess: true, where: {} })
    const pool = (payload.db as unknown as { pool: { query: (query: string) => Promise<unknown> } }).pool
    await pool.query('DELETE FROM inventory_import_previews')
  })
  afterAll(async () => { await payload?.destroy() })

  it('下载 UTF-8 BOM 模板，预检冻结唯一映射，并以同键重试只创建一个导入操作', async () => {
    const user = await signInVerifiedUser()
    const template = await templateGet(jsonRequest('/api/v1/inventory/template', 'GET', user.cookie))
    expect(template.status).toBe(200)
    expect(template.headers.get('content-type')).toContain('text/csv')
    const templateBytes = Buffer.from(await template.arrayBuffer())
    expect(templateBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(templateBytes.subarray(3).toString('utf8')).toBe('色号,数量\r\n')

    const previewKey = `preview-${randomUUID()}`
    const preview = await previewImportPost(csvRequest('/api/v1/inventory/imports/preview?beadSizeMm=2.6&colorSystem=MARD&strategy=overwrite', user.cookie, '\uFEFF色号,数量\r\nA01,100\r\n', previewKey))
    expect(preview.status, await preview.clone().text()).toBe(201)
    const previewBody = await preview.json() as { preview: { previewId: string; previewSha256: string; lines: Array<{ colorHex: string; currentQuantity: number | null; projectedQuantity: number }> } }
    expect(previewBody.preview.lines).toEqual([expect.objectContaining({ colorHex: '#FAF4C8', currentQuantity: null, projectedQuantity: 100 })])

    const commitKey = `commit-${randomUUID()}`
    const commitBody = { previewId: previewBody.preview.previewId, previewSha256: previewBody.preview.previewSha256 }
    const committed = await commitImportPost(jsonRequest('/api/v1/inventory/imports/commit', 'POST', user.cookie, commitBody, commitKey))
    expect(committed.status, await committed.clone().text()).toBe(200)
    const first = await committed.json() as { operation: { operationId: string; kind: string; lines: Array<{ after: number }> } }
    expect(first.operation).toMatchObject({ kind: 'import_overwrite', lines: [expect.objectContaining({ after: 100 })] })
    const retried = await commitImportPost(jsonRequest('/api/v1/inventory/imports/commit', 'POST', user.cookie, commitBody, commitKey))
    expect(retried.status).toBe(200)
    await expect(retried.json()).resolves.toMatchObject({ operation: { operationId: first.operation.operationId } })
  })

  it('拒绝歧义色号且不创建可提交预览', async () => {
    const user = await signInVerifiedUser()
    const response = await previewImportPost(csvRequest('/api/v1/inventory/imports/preview?beadSizeMm=5&colorSystem=漫漫&strategy=overwrite', user.cookie, '色号,数量\nS4,100\n', `preview-${randomUUID()}`))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'INVENTORY_IMPORT_INVALID', details: { issues: [expect.objectContaining({ code: 'AMBIGUOUS_COLOR_CODE', rowNumber: 2 })] } } })
  })

  it('同色余额在预览后变动，提交必须全部拒绝；缺货 CSV 保留未录入状态', async () => {
    const user = await signInVerifiedUser()
    const preview = await previewImportPost(csvRequest('/api/v1/inventory/imports/preview?beadSizeMm=2.6&colorSystem=MARD&strategy=append', user.cookie, '色号,数量\nA01,10\n', `preview-${randomUUID()}`))
    expect(preview.status).toBe(201)
    const previewBody = await preview.json() as { preview: { previewId: string; previewSha256: string } }
    const adjusted = await adjustInventoryPost(jsonRequest('/api/v1/inventory/adjustments', 'POST', user.cookie, {
      kind: 'receipt', beadSizeMm: 2.6, lines: [{ colorHex: '#FAF4C8', quantity: 1 }],
    }, `adjust-${randomUUID()}`))
    expect(adjusted.status).toBe(200)
    const rejected = await commitImportPost(jsonRequest('/api/v1/inventory/imports/commit', 'POST', user.cookie, {
      previewId: previewBody.preview.previewId,
      previewSha256: previewBody.preview.previewSha256,
    }, `commit-${randomUUID()}`))
    expect(rejected.status).toBe(409)
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'INVENTORY_IMPORT_CHANGED' } })

    const workId = await createActivePattern(user.cookie)
    const directSession = await requireActiveSession(jsonRequest(`/api/v1/works/${workId}/inventory-shortages?colorSystem=MARD`, 'GET', user.cookie), 'direct-shortage')
    await expect(getWorkInventoryShortageCsv(directSession, workId, 'MARD')).resolves.toMatchObject({ csv: expect.any(String) })
    const shortage = await shortagesGet(jsonRequest(`/api/v1/works/${workId}/inventory-shortages?colorSystem=MARD`, 'GET', user.cookie), { params: Promise.resolve({ id: workId }) })
    expect(shortage.status, await shortage.clone().text()).toBe(200)
    const csv = await shortage.text()
    expect(csv).toContain('"A01"')
    expect(csv).toContain('"1"')
    expect(csv).toContain('"库存不足"')
  })
})
