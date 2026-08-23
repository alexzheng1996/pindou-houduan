// 文件开头说明：M1.1 个人豆仓的服务端账本真值。所有会改变余额的入口都经由本
// 模块在同一 PostgreSQL 事务中写入余额、操作头、不可变明细、幂等记录和审计。
// 前端只读取安全投影，绝不提交 ownerId、直接余额或图纸颜色用量作为可信事实。
import { randomUUID } from 'crypto'

import { sql } from '@payloadcms/db-postgres'

import { BusinessApiError, sha256, stableStringify } from '@/api/business-http'
import type { ActiveSessionContext } from '@/auth/require-session'
import { recordAuthenticatedAuditEvent } from '@/security/audit'
import { withIdempotentWrite } from '@/works/idempotency'

import {
  createColorLookup,
  inventoryColorMapping,
  isInventoryColorSystem,
  parseInventoryCsv,
  resolveImportedColorCode,
  type InventoryColorSystem,
} from './color-mapping'

const operationIdPattern = /^inventory_operation_[a-f0-9]{32}$/
const workIdPattern = /^work_[a-f0-9]{32}$/
const maxQuantity = 10_000_000
const maxNoteLength = 500
const maxAdjustmentLines = 200
const maxImportLines = 200
const importPreviewLifetimeMilliseconds = 10 * 60 * 1000
const colorMappingSha256 = '32dad53ae0a650730df91480f5304691ce0c4661c4f49056f1d7261a22e5456d'

export type BeadSizeMm = 2.6 | 5
type Health = 'normal' | 'out_of_stock' | 'warning'
type OperationKind =
  | 'import_append'
  | 'import_overwrite'
  | 'manual_decrement'
  | 'production_decrement'
  | 'receipt'
  | 'stocktake'

type DatabaseRow = Record<string, unknown>
type DatabaseResult = { rows: DatabaseRow[] }
type TransactionDatabase = {
  execute: (query: unknown) => Promise<DatabaseResult>
}

type InventoryItemRow = {
  colorHex: string
  id: number
  publicId: string
  quantity: number
  revision: number
  beadSizeMm: BeadSizeMm
  updatedAt: string
}

type OperationLine = {
  after: number
  before: number
  colorHex: string
  delta: number
  beadSizeMm: BeadSizeMm
  itemId: string
  revision: number
}

type OperationProjection = {
  createdAt: string
  kind: OperationKind | 'deletion_reversal'
  lines: OperationLine[]
  note: string | null
  operationId: string
  sourceWork?: {
    documentRevision: number
    title: string
    workId: string
  }
}

type OperationHistoryRow = {
  createdAt: string
  deletionReversalOfOperationId: number | null
  deletedAt: string | null
  id: number
  kind: OperationProjection['kind']
  note: string | null
  publicId: string
  sourceDocumentRevision: number | null
  sourceWorkId: string | null
  sourceWorkTitle: string | null
}

type AdjustmentLineInput = {
  colorHex: string
  expectedRevision?: number | null
  quantity?: number
  targetQuantity?: number
}

type AdjustmentInput = {
  beadSizeMm: BeadSizeMm
  kind: 'manual_decrement' | 'receipt' | 'stocktake'
  lines: AdjustmentLineInput[]
  note: string | null
}

type WorkUsageLine = {
  colorHex: string
  requiredQuantity: number
}

type WorkInventorySource = {
  beadSizeMm: BeadSizeMm
  documentRevision: number
  documentSha256: string
  title: string
  usage: WorkUsageLine[]
  workId: string
}

type ImportStrategy = 'append' | 'overwrite'

type ImportPreviewLine = {
  colorCode: string
  colorHex: string
  currentQuantity: number | null
  expectedRevision: number | null
  itemId: string | null
  quantity: number
  rowNumber: number
}

type ImportPreviewRow = {
  beadSizeMm: BeadSizeMm
  colorSystem: InventoryColorSystem
  consumedAt: string | null
  consumedOperationId: number | null
  expiresAt: string
  id: number
  mappingSha256: string
  normalizedLines: ImportPreviewLine[]
  ownerId: number
  previewSha256: string
  publicId: string
  sourceSha256: string
  strategy: ImportStrategy
}

type ImportIssue = {
  code: 'AMBIGUOUS_COLOR_CODE' | 'DUPLICATE_COLOR' | 'INVALID_QUANTITY' | 'UNKNOWN_COLOR_CODE'
  message: string
  rowNumber: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const asInteger = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null

const parseDbInteger = (value: unknown): number => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : typeof value === 'bigint'
        ? Number(value)
        : NaN
  if (!Number.isSafeInteger(parsed)) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return parsed
}

const parseDbString = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return value
}

const parseDbTimestamp = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
}

const validateBeadSizeMm = (value: unknown): BeadSizeMm =>
  value === 2.6 || value === 5
    ? value
    : (() => {
        throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存规格无效。', 422)
      })()

const normalizeColorHex = (value: unknown): string => {
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存颜色格式无效。', 422)
  }
  return value.toUpperCase()
}

const validateBoundedInteger = (value: unknown): number => {
  const integer = asInteger(value)
  if (integer === null || Math.abs(integer) > maxQuantity) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存数量必须是安全范围内的整数。', 422)
  }
  return integer
}

const validateExpectedRevision = (value: unknown): number | null => {
  if (value === undefined || value === null) {
    return null
  }
  const revision = asInteger(value)
  if (revision === null || revision < 0) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存版本无效。', 422)
  }
  return revision
}

const validateNote = (value: unknown): string | null => {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存备注无效。', 422)
  }
  const note = value.trim()
  if (Array.from(note).length > maxNoteLength) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存备注过长。', 422)
  }
  return note || null
}

const createItemId = (): string => `inventory_${randomUUID().replaceAll('-', '')}`
const createOperationId = (): string => `inventory_operation_${randomUUID().replaceAll('-', '')}`
const createImportPreviewId = (): string => `inventory_import_${randomUUID().replaceAll('-', '')}`

const getTransactionDatabase = async (context: ActiveSessionContext): Promise<TransactionDatabase> => {
  const transactionId = await context.req.transactionID
  const db = transactionId
    ? context.payload.db.sessions?.[transactionId]?.db
    : context.payload.db.drizzle
  if (!db) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }
  return db as TransactionDatabase
}

const lockOwnerInventory = async (context: ActiveSessionContext): Promise<TransactionDatabase> => {
  const db = await getTransactionDatabase(context)
  // 同一账号的多色余额需要以一致的锁顺序更新。用户级事务锁避免两台设备分别按
  // 不同颜色顺序写入时死锁；乐观 revision 仍负责给前端可处理的冲突结果。
  await db.execute(sql`SELECT pg_advisory_xact_lock(${context.user.id}::integer, 11::integer)`)
  return db
}

const toHealth = (quantity: number): Health =>
  quantity < 50 ? 'out_of_stock' : quantity < 100 ? 'warning' : 'normal'

const asInventoryItem = (row: DatabaseRow): InventoryItemRow => ({
  id: parseDbInteger(row.id),
  publicId: parseDbString(row.public_id),
  beadSizeMm: validateBeadSizeMm(Number(row.bead_size_mm)),
  colorHex: normalizeColorHex(row.color_hex),
  quantity: parseDbInteger(row.quantity),
  revision: parseDbInteger(row.revision),
  updatedAt: parseDbTimestamp(row.updated_at),
})

const findItemForUpdate = async (
  db: TransactionDatabase,
  ownerId: number,
  beadSizeMm: BeadSizeMm,
  colorHex: string,
): Promise<InventoryItemRow | null> => {
  const result = await db.execute(sql`
    SELECT id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at
    FROM inventory_items
    WHERE owner_id = ${ownerId} AND bead_size_mm = ${beadSizeMm} AND color_hex = ${colorHex}
    FOR UPDATE`)
  return result.rows[0] ? asInventoryItem(result.rows[0]) : null
}

const createItem = async (
  context: ActiveSessionContext,
  db: TransactionDatabase,
  beadSizeMm: BeadSizeMm,
  colorHex: string,
): Promise<InventoryItemRow> => {
  const publicId = createItemId()
  const result = await db.execute(sql`
    INSERT INTO inventory_items (public_id, owner_id, bead_size_mm, color_hex, quantity, revision, updated_at)
    VALUES (${publicId}, ${context.user.id}, ${beadSizeMm}, ${colorHex}, 0, 0, NOW())
    RETURNING id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at`)
  if (!result.rows[0]) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return asInventoryItem(result.rows[0])
}

const updateItemBalance = async (
  db: TransactionDatabase,
  item: InventoryItemRow,
  expectedRevision: number | null,
  nextQuantity: number,
): Promise<InventoryItemRow> => {
  if (nextQuantity < -maxQuantity || nextQuantity > maxQuantity) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存变动超出安全范围。', 422)
  }
  if (expectedRevision !== null && item.revision !== expectedRevision) {
    throw new BusinessApiError('INVENTORY_REVISION_CONFLICT', '库存已在其他位置更新，请刷新后重试。', 409)
  }
  const result = await db.execute(sql`
    UPDATE inventory_items
    SET quantity = ${nextQuantity}, revision = revision + 1, updated_at = NOW()
    WHERE id = ${item.id} AND revision = ${item.revision}
    RETURNING id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at`)
  if (!result.rows[0]) {
    throw new BusinessApiError('INVENTORY_REVISION_CONFLICT', '库存已在其他位置更新，请刷新后重试。', 409)
  }
  return asInventoryItem(result.rows[0])
}

const createOperation = async (
  db: TransactionDatabase,
  input: {
    kind: OperationKind | 'deletion_reversal'
    note: string | null
    ownerId: number
    reversalOfOperationId?: number
    source?: WorkInventorySource
  },
): Promise<{ id: number; publicId: string; createdAt: string }> => {
  const publicId = createOperationId()
  const result = await db.execute(sql`
    INSERT INTO inventory_operations (
      public_id, owner_id, kind, note, source_work_public_id, source_work_title,
      source_document_revision, source_document_sha256, reversal_of_operation_id, updated_at
    ) VALUES (
      ${publicId}, ${input.ownerId}, ${input.kind}, ${input.note},
      ${input.source?.workId ?? null}, ${input.source?.title ?? null},
      ${input.source?.documentRevision ?? null}, ${input.source?.documentSha256 ?? null},
      ${input.reversalOfOperationId ?? null}, NOW()
    ) RETURNING id, public_id, created_at`)
  const row = result.rows[0]
  if (!row) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return { id: parseDbInteger(row.id), publicId: parseDbString(row.public_id), createdAt: parseDbString(row.created_at) }
}

const createTransactionLine = async (
  db: TransactionDatabase,
  operationId: number,
  item: InventoryItemRow,
  before: number,
  after: number,
): Promise<void> => {
  await db.execute(sql`
    INSERT INTO inventory_transaction_lines (
      operation_id, item_id, bead_size_mm, color_hex, delta, quantity_before, quantity_after
    ) VALUES (
      ${operationId}, ${item.id}, ${item.beadSizeMm}, ${item.colorHex},
      ${after - before}, ${before}, ${after}
    )`)
}

const asOperationHistoryRow = (row: DatabaseRow): OperationHistoryRow => ({
  id: parseDbInteger(row.id),
  publicId: parseDbString(row.public_id),
  kind: parseDbString(row.kind) as OperationProjection['kind'],
  note: row.note === null ? null : parseDbString(row.note),
  createdAt: parseDbTimestamp(row.created_at),
  deletedAt: row.deleted_at === null ? null : parseDbTimestamp(row.deleted_at),
  deletionReversalOfOperationId:
    row.reversal_of_operation_id === null ? null : parseDbInteger(row.reversal_of_operation_id),
  sourceWorkId: row.source_work_public_id === null ? null : parseDbString(row.source_work_public_id),
  sourceWorkTitle: row.source_work_title === null ? null : parseDbString(row.source_work_title),
  sourceDocumentRevision:
    row.source_document_revision === null ? null : parseDbInteger(row.source_document_revision),
})

const listOperationLines = async (
  db: TransactionDatabase,
  operationId: number,
): Promise<OperationLine[]> => {
  const result = await db.execute(sql`
    SELECT item.public_id AS item_public_id, line.bead_size_mm, line.color_hex,
      line.delta, line.quantity_before, line.quantity_after, item.revision
    FROM inventory_transaction_lines AS line
    JOIN inventory_items AS item ON item.id = line.item_id
    WHERE line.operation_id = ${operationId}
    ORDER BY line.color_hex ASC`)
  return result.rows.map((row) => ({
    itemId: parseDbString(row.item_public_id),
    beadSizeMm: validateBeadSizeMm(Number(row.bead_size_mm)),
    colorHex: normalizeColorHex(row.color_hex),
    delta: parseDbInteger(row.delta),
    before: parseDbInteger(row.quantity_before),
    after: parseDbInteger(row.quantity_after),
    revision: parseDbInteger(row.revision),
  }))
}

const toOperationProjection = async (
  db: TransactionDatabase,
  operation: OperationHistoryRow,
): Promise<OperationProjection> => ({
  operationId: operation.publicId,
  kind: operation.kind,
  note: operation.note,
  createdAt: operation.createdAt,
  lines: await listOperationLines(db, operation.id),
  ...(operation.sourceWorkId && operation.sourceWorkTitle && operation.sourceDocumentRevision !== null
    ? {
        sourceWork: {
          workId: operation.sourceWorkId,
          title: operation.sourceWorkTitle,
          documentRevision: operation.sourceDocumentRevision,
        },
      }
    : {}),
})

const parseAdjustmentInput = (value: unknown): AdjustmentInput => {
  if (!isRecord(value)) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存调整格式无效。', 422)
  }
  const { beadSizeMm, kind, lines, note } = value
  if (kind !== 'receipt' && kind !== 'manual_decrement' && kind !== 'stocktake') {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存调整类型无效。', 422)
  }
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > maxAdjustmentLines) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存调整颜色数量无效。', 422)
  }
  const parsedLines = lines.map((line) => {
    if (!isRecord(line)) {
      throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存调整颜色格式无效。', 422)
    }
    const base = {
      colorHex: normalizeColorHex(line.colorHex),
      expectedRevision: validateExpectedRevision(line.expectedRevision),
    }
    if (kind === 'stocktake') {
      return { ...base, targetQuantity: validateBoundedInteger(line.targetQuantity) }
    }
    const quantity = validateBoundedInteger(line.quantity)
    if (quantity <= 0) {
      throw new BusinessApiError('INVENTORY_INPUT_INVALID', '入库或扣减数量必须为正整数。', 422)
    }
    return { ...base, quantity }
  })
  const uniqueColors = new Set(parsedLines.map((line) => line.colorHex))
  if (uniqueColors.size !== parsedLines.length) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '同一次调整不能重复同一颜色。', 422)
  }
  return { beadSizeMm: validateBeadSizeMm(beadSizeMm), kind, lines: parsedLines, note: validateNote(note) }
}

const operationResponse = (
  operation: { createdAt: string; publicId: string },
  kind: OperationProjection['kind'],
  note: string | null,
  lines: OperationLine[],
  source?: WorkInventorySource,
): { operation: OperationProjection } => ({
  operation: {
    operationId: operation.publicId,
    kind,
    note,
    createdAt: operation.createdAt,
    lines,
    ...(source
      ? {
          sourceWork: {
            workId: source.workId,
            title: source.title,
            documentRevision: source.documentRevision,
          },
        }
      : {}),
  },
})

const parseStoredOperationResponse = (value: unknown): { operation: OperationProjection } | null => {
  if (!isRecord(value) || !isRecord(value.operation)) {
    return null
  }
  const operation = value.operation
  if (
    typeof operation.operationId !== 'string' ||
    !operationIdPattern.test(operation.operationId) ||
    typeof operation.createdAt !== 'string' ||
    !Array.isArray(operation.lines)
  ) {
    return null
  }
  return value as { operation: OperationProjection }
}

export const adjustInventory = async (
  context: ActiveSessionContext,
  rawInput: unknown,
  keySha256: string,
): Promise<{ operation: OperationProjection }> => {
  const input = parseAdjustmentInput(rawInput)
  const route = 'POST /api/v1/inventory/adjustments'
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify(input)),
    responseStatus: 200,
    parseStoredResponse: parseStoredOperationResponse,
    execute: async () => {
      const db = await lockOwnerInventory(context)
      const operation = await createOperation(db, {
        ownerId: context.user.id,
        kind: input.kind,
        note: input.note,
      })
      const outputLines: OperationLine[] = []
      for (const line of [...input.lines].sort((a, b) => a.colorHex.localeCompare(b.colorHex))) {
        let item = await findItemForUpdate(db, context.user.id, input.beadSizeMm, line.colorHex)
        if (!item) {
          item = await createItem(context, db, input.beadSizeMm, line.colorHex)
        }
        const before = item.quantity
        const nextQuantity =
          input.kind === 'stocktake'
            ? (line as AdjustmentLineInput).targetQuantity!
            : before + (input.kind === 'receipt' ? (line as AdjustmentLineInput).quantity! : -(line as AdjustmentLineInput).quantity!)
        const updated = await updateItemBalance(
          db,
          item,
          line.expectedRevision ?? null,
          nextQuantity,
        )
        await createTransactionLine(db, operation.id, updated, before, updated.quantity)
        outputLines.push({
          itemId: updated.publicId,
          beadSizeMm: updated.beadSizeMm,
          colorHex: updated.colorHex,
          before,
          after: updated.quantity,
          delta: updated.quantity - before,
          revision: updated.revision,
        })
      }
      await recordAuthenticatedAuditEvent(context, {
        action: 'inventory.adjusted',
        outcome: 'allowed',
        resourcePublicId: operation.publicId,
        resourceType: 'inventory_operation',
        route,
      })
      return operationResponse(operation, input.kind, input.note, outputLines)
    },
  }) as Promise<{ operation: OperationProjection }>
}

const parseImportStrategy = (value: unknown): ImportStrategy =>
  value === 'append' || value === 'overwrite'
    ? value
    : (() => {
        throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入策略无效。', 422)
      })()

const parseImportPreviewOptions = (searchParams: URLSearchParams): {
  beadSizeMm: BeadSizeMm
  colorSystem: InventoryColorSystem
  strategy: ImportStrategy
} => {
  const colorSystem = searchParams.get('colorSystem')
  if (!isInventoryColorSystem(colorSystem)) {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存色号系统无效。', 422)
  }
  return {
    beadSizeMm: validateBeadSizeMm(Number(searchParams.get('beadSizeMm'))),
    colorSystem,
    strategy: parseImportStrategy(searchParams.get('strategy') ?? 'overwrite'),
  }
}

const parseImportedQuantity = (value: string, strategy: ImportStrategy): number | null => {
  if (!/^-?(0|[1-9]\d*)$/.test(value)) {
    return null
  }
  const quantity = Number(value)
  if (!Number.isSafeInteger(quantity) || Math.abs(quantity) > maxQuantity) {
    return null
  }
  return strategy === 'append' && quantity <= 0 ? null : quantity
}

const inventoryItemProjection = (item: InventoryItemRow | null): {
  currentQuantity: number | null
  expectedRevision: number | null
  itemId: string | null
} => item
  ? { itemId: item.publicId, currentQuantity: item.quantity, expectedRevision: item.revision }
  : { itemId: null, currentQuantity: null, expectedRevision: null }

const previewResponse = (preview: {
  beadSizeMm: BeadSizeMm
  colorSystem: InventoryColorSystem
  expiresAt: string
  lines: ImportPreviewLine[]
  previewId: string
  previewSha256: string
  strategy: ImportStrategy
}): Record<string, unknown> => ({
  preview: {
    previewId: preview.previewId,
    previewSha256: preview.previewSha256,
    expiresAt: preview.expiresAt,
    mappingSha256: colorMappingSha256,
    beadSizeMm: preview.beadSizeMm,
    colorSystem: preview.colorSystem,
    strategy: preview.strategy,
    rowCount: preview.lines.length,
    lines: preview.lines.map((line) => ({
      rowNumber: line.rowNumber,
      colorCode: line.colorCode,
      colorHex: line.colorHex,
      quantity: line.quantity,
      currentQuantity: line.currentQuantity,
      projectedQuantity: preview.strategy === 'overwrite'
        ? line.quantity
        : (line.currentQuantity ?? 0) + line.quantity,
    })),
    summary: {
      recordedColorCount: preview.lines.filter((line) => line.currentQuantity !== null).length,
      unrecordedColorCount: preview.lines.filter((line) => line.currentQuantity === null).length,
    },
  },
})

const parseStoredPreviewResponse = (value: unknown): Record<string, unknown> | null =>
  isRecord(value) && isRecord(value.preview) && typeof value.preview.previewId === 'string'
    ? value
    : null

const asImportPreviewLine = (value: unknown): ImportPreviewLine => {
  if (!isRecord(value)) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  const rowNumber = asInteger(value.rowNumber)
  const quantity = asInteger(value.quantity)
  const expectedRevision = value.expectedRevision === null ? null : asInteger(value.expectedRevision)
  const currentQuantity = value.currentQuantity === null ? null : asInteger(value.currentQuantity)
  if (
    rowNumber === null || rowNumber < 2 ||
    quantity === null || Math.abs(quantity) > maxQuantity ||
    expectedRevision === null && value.expectedRevision !== null ||
    currentQuantity === null && value.currentQuantity !== null ||
    typeof value.colorCode !== 'string' ||
    typeof value.itemId !== 'string' && value.itemId !== null
  ) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return {
    rowNumber,
    colorCode: value.colorCode,
    colorHex: normalizeColorHex(value.colorHex),
    quantity,
    itemId: value.itemId,
    expectedRevision,
    currentQuantity,
  }
}

const asImportPreviewRow = (row: DatabaseRow): ImportPreviewRow => {
  const strategy = row.strategy
  if (strategy !== 'append' && strategy !== 'overwrite' || !isInventoryColorSystem(row.color_system)) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  if (!Array.isArray(row.normalized_lines)) {
    throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
  }
  return {
    id: parseDbInteger(row.id),
    publicId: parseDbString(row.public_id),
    ownerId: parseDbInteger(row.owner_id),
    beadSizeMm: validateBeadSizeMm(Number(row.bead_size_mm)),
    colorSystem: row.color_system,
    strategy,
    sourceSha256: parseDbString(row.source_sha256),
    mappingSha256: parseDbString(row.mapping_sha256),
    previewSha256: parseDbString(row.preview_sha256),
    normalizedLines: row.normalized_lines.map(asImportPreviewLine),
    expiresAt: parseDbTimestamp(row.expires_at),
    consumedAt: row.consumed_at === null ? null : parseDbTimestamp(row.consumed_at),
    consumedOperationId: row.consumed_operation_id === null ? null : parseDbInteger(row.consumed_operation_id),
  }
}

const createImportPreview = async (
  db: TransactionDatabase,
  input: {
    beadSizeMm: BeadSizeMm
    colorSystem: InventoryColorSystem
    lines: ImportPreviewLine[]
    ownerId: number
    sourceSha256: string
    strategy: ImportStrategy
  },
): Promise<{ expiresAt: string; previewId: string; previewSha256: string }> => {
  const previewId = createImportPreviewId()
  const expiresAt = new Date(Date.now() + importPreviewLifetimeMilliseconds).toISOString()
  const previewSha256 = sha256(stableStringify({
    previewId,
    sourceSha256: input.sourceSha256,
    mappingSha256: colorMappingSha256,
    beadSizeMm: input.beadSizeMm,
    colorSystem: input.colorSystem,
    strategy: input.strategy,
    lines: input.lines,
  }))
  await db.execute(sql`
    INSERT INTO inventory_import_previews (
      public_id, owner_id, bead_size_mm, color_system, strategy, source_sha256,
      mapping_sha256, preview_sha256, normalized_lines, expires_at
    ) VALUES (
      ${previewId}, ${input.ownerId}, ${input.beadSizeMm}, ${input.colorSystem}, ${input.strategy},
      ${input.sourceSha256}, ${colorMappingSha256}, ${previewSha256},
      ${JSON.stringify(input.lines)}::jsonb, ${expiresAt}
    )`)
  return { previewId, previewSha256, expiresAt }
}

export const previewInventoryImport = async (
  context: ActiveSessionContext,
  rawCsv: string,
  searchParams: URLSearchParams,
  keySha256: string,
): Promise<Record<string, unknown>> => {
  const input = parseImportPreviewOptions(searchParams)
  const sourceSha256 = sha256(rawCsv)
  const route = 'POST /api/v1/inventory/imports/preview'
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify({ ...input, sourceSha256 })),
    responseStatus: 201,
    parseStoredResponse: parseStoredPreviewResponse,
    execute: async () => {
      const parsed = parseInventoryCsv(rawCsv)
      if ('error' in parsed) {
        throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入 CSV 格式或列头无效。', 422, { issues: [{ code: parsed.error, rowNumber: 1 }] })
      }
      if (parsed.rows.length < 1 || parsed.rows.length > maxImportLines) {
        throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入行数无效。', 422)
      }
      const lookup = createColorLookup(inventoryColorMapping, input.colorSystem)
      const issues: ImportIssue[] = []
      const resolved = parsed.rows.map((row) => {
        const mapping = resolveImportedColorCode(lookup, row.colorCode)
        const quantity = parseImportedQuantity(row.quantity, input.strategy)
        if (mapping.status === 'unknown') {
          issues.push({ rowNumber: row.rowNumber, code: 'UNKNOWN_COLOR_CODE', message: '色号无法映射。' })
        }
        if (mapping.status === 'ambiguous') {
          issues.push({ rowNumber: row.rowNumber, code: 'AMBIGUOUS_COLOR_CODE', message: '色号对应多个颜色，无法安全导入。' })
        }
        if (quantity === null) {
          issues.push({ rowNumber: row.rowNumber, code: 'INVALID_QUANTITY', message: '数量不符合当前导入策略或安全范围。' })
        }
        return { row, mapping, quantity }
      })
      const uniqueHexes = new Map<string, number>()
      for (const entry of resolved) {
        if (entry.mapping.status !== 'unique' || !entry.mapping.colorHex) {
          continue
        }
        const firstRow = uniqueHexes.get(entry.mapping.colorHex)
        if (firstRow) {
          issues.push({ rowNumber: entry.row.rowNumber, code: 'DUPLICATE_COLOR', message: `与第 ${firstRow} 行映射为同一颜色。` })
        } else {
          uniqueHexes.set(entry.mapping.colorHex, entry.row.rowNumber)
        }
      }
      if (issues.length > 0) {
        throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入预检未通过。', 422, { issues })
      }
      const db = await lockOwnerInventory(context)
      const lines: ImportPreviewLine[] = []
      for (const entry of resolved) {
        if (entry.mapping.status !== 'unique' || !entry.mapping.colorHex || entry.quantity === null) {
          throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
        }
        const item = await findItemForUpdate(db, context.user.id, input.beadSizeMm, entry.mapping.colorHex)
        lines.push({
          rowNumber: entry.row.rowNumber,
          colorCode: entry.mapping.normalizedCode,
          colorHex: entry.mapping.colorHex,
          quantity: entry.quantity,
          ...inventoryItemProjection(item),
        })
      }
      const preview = await createImportPreview(db, {
        ownerId: context.user.id,
        beadSizeMm: input.beadSizeMm,
        colorSystem: input.colorSystem,
        strategy: input.strategy,
        sourceSha256,
        lines,
      })
      await recordAuthenticatedAuditEvent(context, {
        action: 'inventory.import_previewed',
        outcome: 'allowed',
        resourcePublicId: preview.previewId,
        resourceType: 'inventory_import',
        route,
      })
      return previewResponse({ ...input, ...preview, lines })
    },
  })
}

const parseImportCommitInput = (value: unknown): { previewId: string; previewSha256: string } => {
  if (!isRecord(value) || typeof value.previewId !== 'string' || typeof value.previewSha256 !== 'string') {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入确认格式无效。', 422)
  }
  if (!/^inventory_import_[a-f0-9]{32}$/.test(value.previewId) || !/^[a-f0-9]{64}$/.test(value.previewSha256)) {
    throw new BusinessApiError('INVENTORY_IMPORT_INVALID', '库存导入确认参数无效。', 422)
  }
  return { previewId: value.previewId, previewSha256: value.previewSha256 }
}

const parseStoredImportCommitResponse = (value: unknown): { operation: OperationProjection } | null =>
  parseStoredOperationResponse(value)

export const commitInventoryImport = async (
  context: ActiveSessionContext,
  rawInput: unknown,
  keySha256: string,
): Promise<{ operation: OperationProjection }> => {
  const input = parseImportCommitInput(rawInput)
  const route = 'POST /api/v1/inventory/imports/commit'
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify(input)),
    responseStatus: 200,
    parseStoredResponse: parseStoredImportCommitResponse,
    execute: async () => {
      const db = await lockOwnerInventory(context)
      const result = await db.execute(sql`
        SELECT id, public_id, owner_id, bead_size_mm, color_system, strategy, source_sha256,
          mapping_sha256, preview_sha256, normalized_lines, expires_at, consumed_at, consumed_operation_id
        FROM inventory_import_previews
        WHERE public_id = ${input.previewId} AND owner_id = ${context.user.id}
        FOR UPDATE`)
      const rawPreview = result.rows[0]
      if (!rawPreview) {
        throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存导入预览不存在或无法访问。', 409)
      }
      const preview = asImportPreviewRow(rawPreview)
      if (preview.previewSha256 !== input.previewSha256 || preview.mappingSha256 !== colorMappingSha256) {
        throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存导入预览已变化，请重新预检。', 409)
      }
      if (preview.consumedAt || preview.consumedOperationId !== null) {
        throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存导入预览已提交，请刷新后查看历史。', 409)
      }
      if (new Date(preview.expiresAt).getTime() <= Date.now()) {
        throw new BusinessApiError('INVENTORY_IMPORT_EXPIRED', '库存导入预览已过期，请重新预检。', 410)
      }
      const operation = await createOperation(db, {
        ownerId: context.user.id,
        kind: preview.strategy === 'append' ? 'import_append' : 'import_overwrite',
        note: null,
      })
      const outputLines: OperationLine[] = []
      for (const line of [...preview.normalizedLines].sort((a, b) => a.colorHex.localeCompare(b.colorHex))) {
        let item = await findItemForUpdate(db, context.user.id, preview.beadSizeMm, line.colorHex)
        if (!item) {
          if (line.itemId !== null || line.expectedRevision !== null || line.currentQuantity !== null) {
            throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存已在其他位置更新，请重新预检。', 409)
          }
          item = await createItem(context, db, preview.beadSizeMm, line.colorHex)
        } else if (item.publicId !== line.itemId || item.revision !== line.expectedRevision || item.quantity !== line.currentQuantity) {
          throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存已在其他位置更新，请重新预检。', 409)
        }
        const before = item.quantity
        const nextQuantity = preview.strategy === 'overwrite' ? line.quantity : before + line.quantity
        const updated = await updateItemBalance(db, item, line.expectedRevision, nextQuantity)
        await createTransactionLine(db, operation.id, updated, before, updated.quantity)
        outputLines.push({
          itemId: updated.publicId,
          beadSizeMm: updated.beadSizeMm,
          colorHex: updated.colorHex,
          before,
          after: updated.quantity,
          delta: updated.quantity - before,
          revision: updated.revision,
        })
      }
      const consumed = await db.execute(sql`
        UPDATE inventory_import_previews
        SET consumed_at = NOW(), consumed_operation_id = ${operation.id}
        WHERE id = ${preview.id} AND consumed_at IS NULL AND consumed_operation_id IS NULL
        RETURNING id`)
      if (!consumed.rows[0]) {
        throw new BusinessApiError('INVENTORY_IMPORT_CHANGED', '库存导入预览已在其他位置提交。', 409)
      }
      await recordAuthenticatedAuditEvent(context, {
        action: 'inventory.import_committed',
        outcome: 'allowed',
        resourcePublicId: operation.publicId,
        resourceType: 'inventory_operation',
        route,
      })
      return operationResponse(operation, preview.strategy === 'append' ? 'import_append' : 'import_overwrite', null, outputLines)
    },
  }) as Promise<{ operation: OperationProjection }>
}

const normalizeUsageFromColorCounts = (value: unknown): WorkUsageLine[] => {
  if (!isRecord(value)) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }
  const usage = new Map<string, number>()
  for (const entry of Object.values(value)) {
    if (!isRecord(entry)) {
      throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
    }
    const colorHex = normalizeColorHex(entry.color)
    const count = validateBoundedInteger(entry.count)
    if (count <= 0) {
      continue
    }
    usage.set(colorHex, (usage.get(colorHex) ?? 0) + count)
  }
  return [...usage.entries()]
    .map(([colorHex, requiredQuantity]) => ({ colorHex, requiredQuantity }))
    .sort((first, second) => first.colorHex.localeCompare(second.colorHex))
}

const malformedStoredWork = (): never => {
  throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
}

const asStoredCoordinate = (value: string): { x: number; y: number } => {
  const match = /^(0|[1-9]\d*),(0|[1-9]\d*)$/.exec(value)
  if (!match) {
    return malformedStoredWork()
  }
  return { x: Number(match[1]), y: Number(match[2]) }
}

const asStoredColorCell = (value: unknown): { colorHex: string; colorMode: 'final' | 'inherited' } => {
  if (!isRecord(value) || value.isExternal !== false) {
    return malformedStoredWork()
  }
  const colorMode = value.colorMode === 'final' ? 'final' : 'inherited'
  if (value.colorMode !== undefined && colorMode !== value.colorMode) {
    return malformedStoredWork()
  }
  return { colorHex: normalizeColorHex(value.color), colorMode }
}

const deriveBoardUsage = (board: Record<string, unknown>): WorkUsageLine[] => {
  if (!Array.isArray(board.layers) || !isRecord(board.directPixels) || !isRecord(board.erasePixels) || !isRecord(board.colorReplacements)) {
    return malformedStoredWork()
  }
  const visible = new Map<string, { colorHex: string; colorMode: 'final' | 'inherited' }>()
  const layers = board.layers.map((layer) => {
    if (!isRecord(layer) || !Array.isArray(layer.mappedPixelData)) {
      return malformedStoredWork()
    }
    const x = asInteger(layer.x)
    const y = asInteger(layer.y)
    const zIndex = asInteger(layer.zIndex)
    if (x === null || y === null || zIndex === null) {
      return malformedStoredWork()
    }
    return { layer, x, y, zIndex }
  }).sort((first, second) => first.zIndex - second.zIndex)
  for (const { layer, x, y } of layers) {
    ;(layer.mappedPixelData as unknown[]).forEach((row, rowIndex) => {
      if (!Array.isArray(row)) {
        return malformedStoredWork()
      }
      row.forEach((cell, columnIndex) => {
        if (!isRecord(cell)) {
          return malformedStoredWork()
        }
        if (cell.isExternal === true) {
          return
        }
        visible.set(`${x + columnIndex},${y + rowIndex}`, {
          ...asStoredColorCell(cell),
          colorMode: 'inherited',
        })
      })
    })
  }
  for (const [coordinate, cell] of Object.entries(board.directPixels)) {
    asStoredCoordinate(coordinate)
    visible.set(coordinate, asStoredColorCell(cell))
  }
  for (const [coordinate, erased] of Object.entries(board.erasePixels)) {
    asStoredCoordinate(coordinate)
    if (erased !== true) {
      return malformedStoredWork()
    }
    visible.delete(coordinate)
  }
  const replacements = new Map<string, string>()
  for (const [source, cell] of Object.entries(board.colorReplacements)) {
    replacements.set(normalizeColorHex(source), asStoredColorCell(cell).colorHex)
  }
  const usage = new Map<string, number>()
  for (const cell of visible.values()) {
    const colorHex = cell.colorMode === 'final' ? cell.colorHex : replacements.get(cell.colorHex) ?? cell.colorHex
    usage.set(colorHex, (usage.get(colorHex) ?? 0) + 1)
  }
  return [...usage.entries()]
    .map(([colorHex, requiredQuantity]) => ({ colorHex, requiredQuantity }))
    .sort((first, second) => first.colorHex.localeCompare(second.colorHex))
}

const findWorkInventorySource = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<WorkInventorySource> => {
  if (!workIdPattern.test(publicId)) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }
  const result = await context.payload.find({
    collection: 'works',
    depth: 0,
    limit: 1,
    overrideAccess: false,
    req: context.req,
    where: {
      and: [
        { owner: { equals: context.user.id } },
        { publicId: { equals: publicId } },
        { state: { equals: 'active' } },
      ],
    },
  })
  const work = result.docs[0]
  if (!work || typeof work.currentDocument !== 'number') {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }
  const snapshot = await context.payload.findByID({
    collection: 'work-documents',
    id: work.currentDocument,
    depth: 0,
    overrideAccess: false,
    req: context.req,
  })
  if (!isRecord(snapshot.document) || snapshot.revision !== work.documentRevision) {
    throw new BusinessApiError('WORK_NOT_FOUND', '无法访问该作品。', 404)
  }
  const document = snapshot.document
  let beadSizeMm: BeadSizeMm | undefined
  let colorCounts: unknown
  if (document.kind === 'pattern' && isRecord(document.pattern)) {
    beadSizeMm = document.pattern.beadSizeMm === undefined ? undefined : validateBeadSizeMm(document.pattern.beadSizeMm)
    colorCounts = document.pattern.colorCounts
  } else if (document.kind === 'board' && isRecord(document.board)) {
    beadSizeMm = validateBeadSizeMm(document.board.beadSizeMm)
    colorCounts = undefined
  }
  if (!beadSizeMm) {
    throw new BusinessApiError('WORK_BEAD_SIZE_REQUIRED', '该单图尚未确认拼豆规格，请选择规格后重新保存。', 422)
  }
  const usage = document.kind === 'board'
    ? deriveBoardUsage(document.board as Record<string, unknown>)
    : normalizeUsageFromColorCounts(colorCounts)
  if (usage.length === 0) {
    throw new BusinessApiError('WORK_HAS_NO_COLORS', '该作品没有可扣减的拼豆颜色。', 422)
  }
  return {
    workId: work.publicId,
    title: work.title,
    documentRevision: work.documentRevision,
    documentSha256: work.documentSha256,
    beadSizeMm,
    usage,
  }
}

export const getWorkInventoryStatus = async (
  context: ActiveSessionContext,
  publicId: string,
): Promise<Record<string, unknown>> => {
  const source = await findWorkInventorySource(context, publicId)
  const db = await getTransactionDatabase(context)
  const colors = source.usage.map((line) => line.colorHex)
  const rows = colors.length === 0 ? { rows: [] } : await db.execute(sql`
    SELECT id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at
    FROM inventory_items
    WHERE owner_id = ${context.user.id} AND bead_size_mm = ${source.beadSizeMm}
      AND color_hex IN (${sql.join(colors.map((color) => sql`${color}`), sql`, `)})`)
  const byColor = new Map(rows.rows.map((row) => {
    const item = asInventoryItem(row)
    return [item.colorHex, item]
  }))
  const colorsStatus = source.usage.map((line) => {
    const item = byColor.get(line.colorHex)
    const availableQuantity = item?.quantity ?? null
    const projectedQuantity = availableQuantity === null ? -line.requiredQuantity : availableQuantity - line.requiredQuantity
    return {
      colorHex: line.colorHex,
      requiredQuantity: line.requiredQuantity,
      availableQuantity,
      projectedQuantity,
      health: availableQuantity === null ? 'not_recorded' : toHealth(availableQuantity),
      producible: availableQuantity !== null && availableQuantity >= line.requiredQuantity,
      shortageQuantity: availableQuantity === null ? null : Math.max(0, line.requiredQuantity - availableQuantity),
      ...(item ? { itemId: item.publicId, revision: item.revision } : {}),
    }
  })
  return {
    work: {
      workId: source.workId,
      title: source.title,
      documentRevision: source.documentRevision,
      beadSizeMm: source.beadSizeMm,
    },
    colors: colorsStatus,
    summary: {
      outOfStockColorCount: colorsStatus.filter((item) => item.health === 'out_of_stock').length,
      warningColorCount: colorsStatus.filter((item) => item.health === 'warning').length,
      insufficientColorCount: colorsStatus.filter((item) => item.producible === false).length,
      unrecordedColorCount: colorsStatus.filter((item) => item.health === 'not_recorded').length,
    },
  }
}

const inventoryHealth = (quantity: number): 'negative' | Health =>
  quantity < 0 ? 'negative' : toHealth(quantity)

const csvCell = (value: string | number): string => {
  const raw = String(value)
  const protectedValue = /^[=+\-@]/.test(raw) ? `'${raw}` : raw
  return `"${protectedValue.replaceAll('"', '""')}"`
}

export const getWorkInventoryShortageCsv = async (
  context: ActiveSessionContext,
  publicId: string,
  colorSystem: InventoryColorSystem,
): Promise<{ csv: string }> => {
  const status = await getWorkInventoryStatus(context, publicId) as {
    colors: Array<{
      availableQuantity: number | null
      colorHex: string
      health: 'normal' | 'not_recorded' | 'out_of_stock' | 'warning'
      producible: boolean
      requiredQuantity: number
      shortageQuantity: number | null
    }>
    work: { beadSizeMm: BeadSizeMm; workId: string }
  }
  const header = ['色号系统', '色号', '底层HEX', '规格(mm)', '库存(颗)', '本图需求(颗)', '缺口(颗)', '库存状态', '图纸状态']
  const rows = status.colors.map((line) => {
    const displayCode = inventoryColorMapping[line.colorHex]?.[colorSystem] ?? '未映射'
    if (line.availableQuantity === null) {
      return [colorSystem, displayCode, line.colorHex, status.work.beadSizeMm, '未录入', line.requiredQuantity, '', '未录入', '需录入库存']
    }
    const shortage = line.shortageQuantity ?? 0
    return [
      colorSystem,
      displayCode,
      line.colorHex,
      status.work.beadSizeMm,
      line.availableQuantity,
      line.requiredQuantity,
      shortage,
      inventoryHealth(line.availableQuantity),
      line.producible ? '本图可完成' : '库存不足',
    ]
  })
  const csv = `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`
  return { csv }
}

export const listInventoryItems = async (
  context: ActiveSessionContext,
  searchParams: URLSearchParams,
): Promise<Record<string, unknown>> => {
  const rawBeadSizeMm = searchParams.get('beadSizeMm')
  const beadSizeMm = rawBeadSizeMm === null ? null : validateBeadSizeMm(Number(rawBeadSizeMm))
  const health = searchParams.get('health')
  if (health !== null && health !== 'normal' && health !== 'warning' && health !== 'out_of_stock' && health !== 'negative') {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存筛选条件无效。', 422)
  }
  const rawLimit = searchParams.get('limit') ?? '50'
  if (!/^\d+$/.test(rawLimit)) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存分页参数无效。', 422)
  }
  const limit = Number(rawLimit)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '库存分页参数无效。', 422)
  }
  const pool = (context.payload.db as unknown as {
    pool?: { query: (query: string, parameters: readonly unknown[]) => Promise<DatabaseResult> }
  }).pool
  if (!pool) {
    throw new BusinessApiError('TRANSACTION_UNAVAILABLE', '服务器暂时无法处理请求。', 500)
  }
  const result = await pool.query(
    `SELECT id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at
     FROM inventory_items
     WHERE owner_id = $1
     ORDER BY updated_at DESC, public_id ASC
     LIMIT $2`,
    [context.user.id, 100],
  )
  const items = result.rows.map(asInventoryItem).map((item) => ({
    itemId: item.publicId,
    beadSizeMm: item.beadSizeMm,
    colorHex: item.colorHex,
    quantity: item.quantity,
    revision: item.revision,
    health: item.quantity < 0 ? 'negative' : toHealth(item.quantity),
    updatedAt: item.updatedAt,
  }))
  const filteredItems = items
    .filter((item) => beadSizeMm === null || item.beadSizeMm === beadSizeMm)
    .filter((item) => health === null || item.health === health)
    .slice(0, limit)
  return { items: filteredItems, nextCursor: null }
}

export const listInventoryOperations = async (
  context: ActiveSessionContext,
): Promise<{ operations: OperationProjection[] }> => {
  const db = await getTransactionDatabase(context)
  const result = await db.execute(sql`
    SELECT id, public_id, kind, note, created_at, deleted_at, reversal_of_operation_id,
      source_work_public_id, source_work_title, source_document_revision
    FROM inventory_operations
    WHERE owner_id = ${context.user.id} AND deleted_at IS NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 100`)
  return { operations: await Promise.all(result.rows.map(asOperationHistoryRow).map((operation) => toOperationProjection(db, operation))) }
}

export const reverseInventoryOperation = async (
  context: ActiveSessionContext,
  publicId: string,
  rawInput: unknown,
  keySha256: string,
): Promise<{ operation: OperationProjection }> => {
  if (!operationIdPattern.test(publicId)) {
    throw new BusinessApiError('INVENTORY_OPERATION_NOT_FOUND', '无法访问该库存历史。', 404)
  }
  const note = isRecord(rawInput) ? validateNote(rawInput.reason) : (() => {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '删除库存历史请求格式无效。', 422)
  })()
  const route = `DELETE /api/v1/inventory/operations/${publicId}`
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify({ reason: note })),
    responseStatus: 200,
    parseStoredResponse: parseStoredOperationResponse,
    execute: async () => {
      const db = await lockOwnerInventory(context)
      const result = await db.execute(sql`
        SELECT id, public_id, kind, note, created_at, deleted_at, reversal_of_operation_id,
          source_work_public_id, source_work_title, source_document_revision
        FROM inventory_operations
        WHERE owner_id = ${context.user.id} AND public_id = ${publicId}
        FOR UPDATE`)
      const rawOperation = result.rows[0]
      if (!rawOperation) {
        throw new BusinessApiError('INVENTORY_OPERATION_NOT_FOUND', '无法访问该库存历史。', 404)
      }
      const operation = asOperationHistoryRow(rawOperation)
      if (operation.deletedAt || operation.kind === 'deletion_reversal' || operation.deletionReversalOfOperationId !== null) {
        throw new BusinessApiError('INVENTORY_OPERATION_NOT_REVERSIBLE', '该库存历史不能再次删除或回滚。', 409)
      }
      const sourceLines = await db.execute(sql`
        SELECT item_id, bead_size_mm, color_hex, delta
        FROM inventory_transaction_lines
        WHERE operation_id = ${operation.id}
        ORDER BY color_hex ASC`)
      if (sourceLines.rows.length === 0) {
        throw new BusinessApiError('INVENTORY_OPERATION_NOT_REVERSIBLE', '该库存历史没有可回滚的明细。', 409)
      }
      const reversal = await createOperation(db, {
        ownerId: context.user.id,
        kind: 'deletion_reversal',
        note,
        reversalOfOperationId: operation.id,
      })
      const outputLines: OperationLine[] = []
      for (const line of sourceLines.rows) {
        const itemId = parseDbInteger(line.item_id)
        const itemResult = await db.execute(sql`
          SELECT id, public_id, bead_size_mm, color_hex, quantity, revision, updated_at
          FROM inventory_items
          WHERE id = ${itemId} AND owner_id = ${context.user.id}
          FOR UPDATE`)
        const rawItem = itemResult.rows[0]
        if (!rawItem) {
          throw new BusinessApiError('INTERNAL_ERROR', '服务器暂时无法处理请求。', 500)
        }
        const item = asInventoryItem(rawItem)
        const originalDelta = parseDbInteger(line.delta)
        const before = item.quantity
        const updated = await updateItemBalance(db, item, null, before - originalDelta)
        await createTransactionLine(db, reversal.id, updated, before, updated.quantity)
        outputLines.push({
          itemId: updated.publicId,
          beadSizeMm: updated.beadSizeMm,
          colorHex: updated.colorHex,
          before,
          after: updated.quantity,
          delta: updated.quantity - before,
          revision: updated.revision,
        })
      }
      const deleted = await db.execute(sql`
        UPDATE inventory_operations
        SET deleted_at = NOW(), deleted_by_id = ${context.user.id}, deletion_reason = ${note}, updated_at = NOW()
        WHERE id = ${operation.id} AND deleted_at IS NULL
        RETURNING id`)
      if (!deleted.rows[0]) {
        throw new BusinessApiError('INVENTORY_OPERATION_NOT_REVERSIBLE', '该库存历史已被其他位置删除。', 409)
      }
      await recordAuthenticatedAuditEvent(context, {
        action: 'inventory.operation_reversed',
        outcome: 'allowed',
        resourcePublicId: reversal.publicId,
        resourceType: 'inventory_operation',
        route,
      })
      return operationResponse(reversal, 'deletion_reversal', note, outputLines)
    },
  }) as Promise<{ operation: OperationProjection }>
}

export const completeWorkInventory = async (
  context: ActiveSessionContext,
  publicId: string,
  rawInput: unknown,
  keySha256: string,
): Promise<{ operation: OperationProjection }> => {
  const note = isRecord(rawInput) ? validateNote(rawInput.note) : (() => {
    throw new BusinessApiError('INVENTORY_INPUT_INVALID', '完成制作请求格式无效。', 422)
  })()
  const source = await findWorkInventorySource(context, publicId)
  const route = `POST /api/v1/works/${publicId}/complete`
  return withIdempotentWrite(context, {
    route,
    keySha256,
    requestSha256: sha256(stableStringify({ note, sourceRevision: source.documentRevision, sourceSha256: source.documentSha256 })),
    responseStatus: 200,
    parseStoredResponse: parseStoredOperationResponse,
    execute: async () => {
      const db = await lockOwnerInventory(context)
      const currentSource = await findWorkInventorySource(context, publicId)
      if (
        currentSource.documentRevision !== source.documentRevision ||
        currentSource.documentSha256 !== source.documentSha256 ||
        currentSource.beadSizeMm !== source.beadSizeMm
      ) {
        throw new BusinessApiError('WORK_REVISION_CONFLICT', '作品已在其他位置更新，请刷新后重试。', 409)
      }
      const operation = await createOperation(db, {
        ownerId: context.user.id,
        kind: 'production_decrement',
        note,
        source: currentSource,
      })
      const outputLines: OperationLine[] = []
      for (const usage of currentSource.usage) {
        let item = await findItemForUpdate(db, context.user.id, currentSource.beadSizeMm, usage.colorHex)
        if (!item) {
          item = await createItem(context, db, currentSource.beadSizeMm, usage.colorHex)
        }
        const before = item.quantity
        const updated = await updateItemBalance(db, item, null, before - usage.requiredQuantity)
        await createTransactionLine(db, operation.id, updated, before, updated.quantity)
        outputLines.push({
          itemId: updated.publicId,
          beadSizeMm: updated.beadSizeMm,
          colorHex: updated.colorHex,
          before,
          after: updated.quantity,
          delta: updated.quantity - before,
          revision: updated.revision,
        })
      }
      await recordAuthenticatedAuditEvent(context, {
        action: 'inventory.work_completed',
        outcome: 'allowed',
        resourcePublicId: operation.publicId,
        resourceType: 'inventory_operation',
        route,
      })
      return operationResponse(operation, 'production_decrement', note, outputLines, currentSource)
    },
  }) as Promise<{ operation: OperationProjection }>
}
