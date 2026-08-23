// 文件开头说明：M1 WorkDocument 的入站校验。pattern 与 board 都只接受冻结的
// v1 JSON；board 的文件 ID 先作格式/语义校验，再由服务层确认同 owner、同作品
// 且 ready，不能把未校验 JSON 或浏览器 Data URL 写入数据库。
import { z } from 'zod'

import { MAX_WORK_REQUEST_BYTES, sha256, stableStringify } from '@/api/business-http'

const MAX_BOARD_DIMENSION = 2_000
const MAX_BOARD_LAYERS = 20
const MAX_BOARD_LAYER_CELLS = 90_000
const MAX_BOARD_TOTAL_LAYER_CELLS = 180_000
const MAX_BOARD_SPARSE_PIXELS = 20_000
const MAX_COLOR_REPLACEMENTS = 256
const MAX_PATTERN_COLUMNS = 300
const MAX_PATTERN_ROWS = 300
const MAX_PATTERN_CELLS = 90_000
const MAX_TITLE_LENGTH = 120
const HEX_COLOR = /^#[0-9A-F]{6}$/
const PALETTE_KEY = /^(?:#[0-9A-F]{6}|[A-Za-z0-9._:-]{1,64})$/
const MATERIAL_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/
const ASSET_ID = /^asset_[a-f0-9]{32}$/
const LAYER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const COORDINATE = /^(0|[1-9]\d*),(0|[1-9]\d*)$/

const createWorkInputSchema = z
  .object({
    title: z.string(),
    kind: z.enum(['pattern', 'board']),
    document: z.unknown(),
  })
  .strict()

const updateWorkInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    document: z.unknown(),
  })
  .strict()

type JsonObject = Record<string, unknown>
type WorkKind = 'pattern' | 'board'

type DerivedColorCount = {
  color: string
  count: number
}

type ValidatedCell = {
  color: string
  isExternal: boolean
  key: string
}

type ValidatedBoardCell = ValidatedCell & {
  colorMode: 'final' | 'inherited'
}

type MatrixValidation = {
  colorCounts: JsonObject
  mappedPixelData: ValidatedCell[][]
  totalBeadCount: number
}

export type BeadSizeMm = 2.6 | 5

export type AssetReference = {
  assetId: string
  acceptedRoles: readonly ('display' | 'original' | 'thumbnail')[]
}

export type ValidatedWorkDocument = JsonObject & {
  documentRevision: number
  kind: WorkKind
  schemaVersion: 1
  title: string
}

type ValidatedDocument = {
  assetReferences: AssetReference[]
  document: ValidatedWorkDocument
}

export type ValidatedCreateWorkInput = {
  assetReferences: AssetReference[]
  document: ValidatedWorkDocument
  documentByteSize: number
  documentSha256: string
  kind: WorkKind
  requestSha256: string
  title: string
}

export class WorkDocumentValidationError extends Error {
  readonly code: 'WORK_DOCUMENT_INVALID' | 'WORK_DOCUMENT_TOO_LARGE'

  constructor(code: WorkDocumentValidationError['code']) {
    super(code)
    this.code = code
  }
}

const invalid = (): never => {
  throw new WorkDocumentValidationError('WORK_DOCUMENT_INVALID')
}

const tooLarge = (): never => {
  throw new WorkDocumentValidationError('WORK_DOCUMENT_TOO_LARGE')
}

const isObject = (value: unknown): value is JsonObject =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const expectExactObject = (value: unknown, keys: readonly string[]): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }

  const actualKeys = Object.keys(value)
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => !keys.includes(key)) ||
    keys.some((key) => !(key in value))
  ) {
    return invalid()
  }

  return value
}

const expectString = (value: unknown): string => (typeof value === 'string' ? value : invalid())

const expectNullableString = (value: unknown): string | null =>
  value === null || typeof value === 'string' ? value : invalid()

const expectBoolean = (value: unknown): boolean =>
  typeof value === 'boolean' ? value : invalid()

const expectArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : invalid())

const expectNonNegativeInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid()

const expectInteger = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : invalid()

const expectPositiveInteger = (value: unknown): number => {
  const number = expectNonNegativeInteger(value)

  return number > 0 ? number : invalid()
}

const expectFiniteNumber = (value: unknown, minimum: number, maximum: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : invalid()

const expectHexColor = (value: unknown): string => {
  const color = expectString(value)

  return HEX_COLOR.test(color) ? color : invalid()
}

const expectPaletteKey = (value: unknown): string => {
  const key = expectString(value)

  return PALETTE_KEY.test(key) && key !== 'ERASE' ? key : invalid()
}

const expectAssetId = (value: unknown): string | null => {
  const assetId = expectNullableString(value)

  return assetId === null || ASSET_ID.test(assetId) ? assetId : invalid()
}

const expectJsonValue = (value: unknown, depth = 0): void => {
  if (depth > 50) {
    invalid()
  }

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      invalid()
    }
    return
  }

  if (Array.isArray(value)) {
    value.forEach((item) => expectJsonValue(item, depth + 1))
    return
  }

  if (isObject(value)) {
    Object.values(value).forEach((item) => expectJsonValue(item, depth + 1))
    return
  }

  invalid()
}

const normalizeTitle = (value: unknown): string => {
  const title = expectString(value).trim()
  const characterCount = Array.from(title).length

  return characterCount >= 1 && characterCount <= MAX_TITLE_LENGTH ? title : invalid()
}

const validateCell = (value: unknown): ValidatedCell => {
  const cell = expectExactObject(value, ['key', 'color', 'isExternal'])
  const isExternal = expectBoolean(cell.isExternal)

  if (isExternal) {
    if (cell.key !== 'ERASE' || cell.color !== '#FFFFFF') {
      invalid()
    }

    return { key: 'ERASE', color: '#FFFFFF', isExternal: true }
  }

  return {
    key: expectPaletteKey(cell.key),
    color: expectHexColor(cell.color),
    isExternal: false,
  }
}

const validateBoardCell = (value: unknown): ValidatedBoardCell => {
  if (!isObject(value)) {
    return invalid()
  }
  const actualKeys = Object.keys(value)
  if (
    actualKeys.some((key) => !['key', 'color', 'isExternal', 'colorMode'].includes(key)) ||
    !['key', 'color', 'isExternal'].every((key) => key in value)
  ) {
    return invalid()
  }

  const raw = value
  const cell = validateCell({ key: raw.key, color: raw.color, isExternal: raw.isExternal })
  const colorMode = raw.colorMode ?? 'inherited'

  if (cell.isExternal || (colorMode !== 'inherited' && colorMode !== 'final')) {
    invalid()
  }

  return { ...cell, colorMode: colorMode as 'final' | 'inherited' }
}

const validateMatrix = (
  value: unknown,
  columns: number,
  rows: number,
  colorCounts: unknown,
  totalBeadCount: unknown,
): MatrixValidation => {
  const sourceRows = expectArray(value)
  if (sourceRows.length !== rows) {
    invalid()
  }

  const derivedColorCounts = new Map<string, DerivedColorCount>()
  const mappedPixelData = sourceRows.map((row) => {
    if (!Array.isArray(row) || row.length !== columns) {
      return invalid()
    }

    return row.map((value) => {
      const cell = validateCell(value)

      if (!cell.isExternal) {
        const current = derivedColorCounts.get(cell.key)
        if (current && current.color !== cell.color) {
          invalid()
        }

        derivedColorCounts.set(cell.key, {
          color: cell.color,
          count: (current?.count ?? 0) + 1,
        })
      }

      return cell
    })
  })

  const normalizedColorCounts = expectJsonColorCounts(colorCounts, derivedColorCounts)
  const normalizedTotalBeadCount = expectNonNegativeInteger(totalBeadCount)
  const derivedTotal = Array.from(derivedColorCounts.values()).reduce(
    (sum, item) => sum + item.count,
    0,
  )

  if (normalizedTotalBeadCount !== derivedTotal) {
    invalid()
  }

  return {
    mappedPixelData,
    colorCounts: normalizedColorCounts,
    totalBeadCount: normalizedTotalBeadCount,
  }
}

const validateBeadSizeMm = (value: unknown): BeadSizeMm =>
  value === 2.6 || value === 5 ? value : invalid()

const validatePattern = (value: unknown): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }
  const allowedKeys = [
    'gridDimensions',
    'mappedPixelData',
    'colorCounts',
    'totalBeadCount',
    'beadSizeMm',
  ]
  const requiredKeys = ['gridDimensions', 'mappedPixelData', 'colorCounts', 'totalBeadCount']
  const actualKeys = Object.keys(value)
  if (
    actualKeys.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !(key in value))
  ) {
    return invalid()
  }
  const pattern = value
  const dimensions = expectExactObject(pattern.gridDimensions, ['columns', 'rows'])
  const columns = expectPositiveInteger(dimensions.columns)
  const rows = expectPositiveInteger(dimensions.rows)

  if (
    columns > MAX_PATTERN_COLUMNS ||
    rows > MAX_PATTERN_ROWS ||
    columns * rows > MAX_PATTERN_CELLS
  ) {
    tooLarge()
  }

  const matrix = validateMatrix(
    pattern.mappedPixelData,
    columns,
    rows,
    pattern.colorCounts,
    pattern.totalBeadCount,
  )

  return {
    gridDimensions: { columns, rows },
    ...matrix,
    ...(pattern.beadSizeMm === undefined ? {} : { beadSizeMm: validateBeadSizeMm(pattern.beadSizeMm) }),
  }
}

const expectJsonColorCounts = (
  value: unknown,
  derived: Map<string, DerivedColorCount>,
): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }

  const entries = Object.entries(value)
  if (entries.length !== derived.size) {
    return invalid()
  }

  const normalized: JsonObject = {}
  for (const [key, entry] of entries) {
    const expected = derived.get(key) ?? invalid()
    const item = expectExactObject(entry, ['count', 'color'])

    if (expectNonNegativeInteger(item.count) !== expected.count) {
      invalid()
    }

    if (expectHexColor(item.color) !== expected.color) {
      invalid()
    }

    normalized[key] = { count: expected.count, color: expected.color }
  }

  return normalized
}

const validateMaterialList = (value: unknown, derived: JsonObject, revision: number): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }

  const status = value.status
  if (status === 'not_generated') {
    const list = expectExactObject(value, ['status', 'items'])
    if (!Array.isArray(list.items) || list.items.length !== 0) {
      invalid()
    }

    return { status, items: [] }
  }

  if (status === 'failed') {
    const list = expectExactObject(value, ['status', 'items', 'errorCode'])
    if (
      !Array.isArray(list.items) ||
      list.items.length !== 0 ||
      !MATERIAL_ERROR_CODE.test(expectString(list.errorCode))
    ) {
      invalid()
    }

    return { status, items: [], errorCode: list.errorCode }
  }

  if (status !== 'generated') {
    return invalid()
  }

  const list = expectExactObject(value, ['status', 'items', 'generatedFromRevision'])
  const sourceItems = expectArray(list.items)
  if (expectNonNegativeInteger(list.generatedFromRevision) !== revision) {
    invalid()
  }

  const expectedEntries = Object.entries(derived)
  if (sourceItems.length !== expectedEntries.length) {
    invalid()
  }

  const itemsByKey = new Map<string, JsonObject>()
  for (const value of sourceItems) {
    const item = expectExactObject(value, ['colorKey', 'color', 'count'])
    const colorKey = expectPaletteKey(item.colorKey)
    if (itemsByKey.has(colorKey)) {
      invalid()
    }
    itemsByKey.set(colorKey, item)
  }

  const items = expectedEntries.map(([colorKey, expected]) => {
    const expectedItem = expectExactObject(expected, ['count', 'color'])
    const item = itemsByKey.get(colorKey)

    if (
      !item ||
      expectHexColor(item.color) !== expectedItem.color ||
      expectNonNegativeInteger(item.count) !== expectedItem.count
    ) {
      return invalid()
    }

    return {
      colorKey,
      color: expectedItem.color,
      count: expectedItem.count,
    }
  })

  return { status, generatedFromRevision: revision, items }
}

const validateCoordinate = (key: string, width: number, height: number): void => {
  const matches = COORDINATE.exec(key)
  if (!matches) {
    invalid()
  }

  const [, rawX, rawY] = matches ?? invalid()
  const x = Number(rawX)
  const y = Number(rawY)
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x >= width || y >= height) {
    invalid()
  }
}

const rectanglesOverlap = (
  first: { height: number; width: number; x: number; y: number },
  second: { height: number; width: number; x: number; y: number },
): boolean =>
  !(
    first.x + first.width <= second.x ||
    first.y + first.height <= second.y ||
    second.x + second.width <= first.x ||
    second.y + second.height <= first.y
  )

type ValidatedBoardLayer = {
  assetReferences: AssetReference[]
  height: number
  mappedPixelData: ValidatedCell[][]
  output: JsonObject
  width: number
  x: number
  y: number
  zIndex: number
}

export const isAllowedAssetRole = (
  value: 'display' | 'original' | 'thumbnail',
  acceptedRoles: readonly ('display' | 'original' | 'thumbnail')[],
): boolean => acceptedRoles.includes(value)

const validateBoardLayer = (
  value: unknown,
  boardWidth: number,
  boardHeight: number,
): ValidatedBoardLayer => {
  const layer = expectExactObject(value, [
    'layerId',
    'name',
    'x',
    'y',
    'width',
    'height',
    'zIndex',
    'gridDimensions',
    'mappedPixelData',
    'colorCounts',
    'totalBeadCount',
    'selectedColorSystem',
    'sourceImportMode',
    'templateImportConfidence',
    'sourceAssetId',
    'thumbnailAssetId',
    'generation',
    'regenerationCapability',
  ])
  const layerId = expectString(layer.layerId)
  if (!LAYER_ID.test(layerId)) {
    invalid()
  }

  const x = expectNonNegativeInteger(layer.x)
  const y = expectNonNegativeInteger(layer.y)
  const width = expectPositiveInteger(layer.width)
  const height = expectPositiveInteger(layer.height)
  const zIndex = expectInteger(layer.zIndex)
  if (x + width > boardWidth || y + height > boardHeight) {
    invalid()
  }

  const dimensions = expectExactObject(layer.gridDimensions, ['columns', 'rows'])
  const columns = expectPositiveInteger(dimensions.columns)
  const rows = expectPositiveInteger(dimensions.rows)
  if (
    columns > MAX_PATTERN_COLUMNS ||
    rows > MAX_PATTERN_ROWS ||
    columns * rows > MAX_BOARD_LAYER_CELLS
  ) {
    tooLarge()
  }
  if (width !== columns || height !== rows) {
    invalid()
  }

  const matrix = validateMatrix(
    layer.mappedPixelData,
    columns,
    rows,
    layer.colorCounts,
    layer.totalBeadCount,
  )
  const selectedColorSystem = expectString(layer.selectedColorSystem)
  if (!/^\S{1,64}$/u.test(selectedColorSystem)) {
    invalid()
  }

  if (layer.sourceImportMode !== 'image' && layer.sourceImportMode !== 'template') {
    invalid()
  }
  const sourceImportMode = layer.sourceImportMode
  const templateImportConfidence = layer.templateImportConfidence
  if (
    (sourceImportMode === 'template' &&
      templateImportConfidence !== null &&
      (typeof templateImportConfidence !== 'number' ||
        !Number.isFinite(templateImportConfidence) ||
        templateImportConfidence < 0 ||
        templateImportConfidence > 1)) ||
    (sourceImportMode === 'image' && templateImportConfidence !== null)
  ) {
    invalid()
  }

  const sourceAssetId = expectAssetId(layer.sourceAssetId)
  const thumbnailAssetId = expectAssetId(layer.thumbnailAssetId)
  const regenerationCapability = sourceImportMode === 'template'
    ? 'template_locked'
    : sourceAssetId
      ? 'available'
      : 'unavailable'
  if (layer.regenerationCapability !== regenerationCapability) {
    invalid()
  }

  const generation = expectExactObject(layer.generation, [
    'subjectWidth',
    'similarityThreshold',
    'backgroundTolerance',
    'colorLimit',
    'pixelationMode',
    'preprocessMode',
    'removeBackgroundOnRegenerate',
  ])
  const subjectWidth = expectPositiveInteger(generation.subjectWidth)
  const similarityThreshold = expectFiniteNumber(generation.similarityThreshold, 0, 100)
  const backgroundTolerance = expectFiniteNumber(generation.backgroundTolerance, 0, 255)
  const colorLimit = expectNonNegativeInteger(generation.colorLimit)
  if (subjectWidth > MAX_PATTERN_COLUMNS || colorLimit > 64) {
    invalid()
  }
  if (generation.pixelationMode !== 'dominant' && generation.pixelationMode !== 'average') {
    invalid()
  }
  if (generation.preprocessMode !== 'crisp' && generation.preprocessMode !== 'natural') {
    invalid()
  }
  const removeBackgroundOnRegenerate = expectBoolean(generation.removeBackgroundOnRegenerate)

  const assetReferences: AssetReference[] = []
  if (sourceAssetId) {
    assetReferences.push({ assetId: sourceAssetId, acceptedRoles: ['original'] })
  }
  if (thumbnailAssetId) {
    assetReferences.push({ assetId: thumbnailAssetId, acceptedRoles: ['display', 'thumbnail'] })
  }

  return {
    assetReferences,
    height,
    mappedPixelData: matrix.mappedPixelData,
    width,
    x,
    y,
    zIndex,
    output: {
      layerId,
      name: normalizeTitle(layer.name),
      x,
      y,
      width,
      height,
      zIndex,
      gridDimensions: { columns, rows },
      mappedPixelData: matrix.mappedPixelData,
      colorCounts: matrix.colorCounts,
      totalBeadCount: matrix.totalBeadCount,
      selectedColorSystem,
      sourceImportMode,
      templateImportConfidence,
      sourceAssetId,
      thumbnailAssetId,
      generation: {
        subjectWidth,
        similarityThreshold,
        backgroundTolerance,
        colorLimit,
        pixelationMode: generation.pixelationMode,
        preprocessMode: generation.preprocessMode,
        removeBackgroundOnRegenerate,
      },
      regenerationCapability,
    },
  }
}

const deduplicateAssetReferences = (references: AssetReference[]): AssetReference[] => {
  const merged = new Map<string, Set<'display' | 'original' | 'thumbnail'>>()
  for (const reference of references) {
    const roles = merged.get(reference.assetId) ?? new Set<'display' | 'original' | 'thumbnail'>()
    reference.acceptedRoles.forEach((role) => roles.add(role))
    merged.set(reference.assetId, roles)
  }

  return Array.from(merged, ([assetId, roles]) => ({
    assetId,
    acceptedRoles: Array.from(roles),
  }))
}

const validateDirectPixels = (value: unknown, width: number, height: number): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }
  if (Object.keys(value).length > MAX_BOARD_SPARSE_PIXELS) {
    tooLarge()
  }

  const result: JsonObject = {}
  for (const [coordinate, rawCell] of Object.entries(value)) {
    validateCoordinate(coordinate, width, height)
    result[coordinate] = validateBoardCell(rawCell)
  }
  return result
}

const validateErasePixels = (value: unknown, width: number, height: number): JsonObject => {
  if (!isObject(value)) {
    return invalid()
  }
  if (Object.keys(value).length > MAX_BOARD_SPARSE_PIXELS) {
    tooLarge()
  }

  const result: JsonObject = {}
  for (const [coordinate, rawValue] of Object.entries(value)) {
    validateCoordinate(coordinate, width, height)
    if (rawValue !== true) {
      invalid()
    }
    result[coordinate] = true
  }
  return result
}

const validateColorReplacements = (value: unknown): Map<string, ValidatedCell> => {
  if (!isObject(value)) {
    return invalid()
  }
  const entries = Object.entries(value)
  if (entries.length > MAX_COLOR_REPLACEMENTS) {
    tooLarge()
  }

  const replacements = new Map<string, ValidatedCell>()
  for (const [sourceColor, rawCell] of entries) {
    if (!HEX_COLOR.test(sourceColor)) {
      invalid()
    }
    const cell = validateCell(rawCell)
    if (cell.isExternal || cell.color === sourceColor) {
      invalid()
    }
    replacements.set(sourceColor, cell)
  }

  for (const cell of replacements.values()) {
    if (replacements.has(cell.color)) {
      // A target which is also another source would be a chain or a cycle.
      invalid()
    }
  }

  return replacements
}

const toColorCounts = (cells: Iterable<ValidatedCell>): JsonObject => {
  const derived = new Map<string, DerivedColorCount>()
  for (const cell of cells) {
    if (cell.isExternal) {
      continue
    }
    const current = derived.get(cell.key)
    if (current && current.color !== cell.color) {
      invalid()
    }
    derived.set(cell.key, { color: cell.color, count: (current?.count ?? 0) + 1 })
  }

  const result: JsonObject = {}
  for (const [key, item] of derived) {
    result[key] = item
  }
  return result
}

const validateBoard = (value: unknown): { assetReferences: AssetReference[]; board: JsonObject; colorCounts: JsonObject } => {
  const board = expectExactObject(value, [
    'size',
    'overlapMode',
    'beadSizeMm',
    'layers',
    'directPixels',
    'erasePixels',
    'colorReplacements',
  ])
  const size = expectExactObject(board.size, ['width', 'height'])
  const width = expectPositiveInteger(size.width)
  const height = expectPositiveInteger(size.height)
  if (
    width > MAX_BOARD_DIMENSION ||
    height > MAX_BOARD_DIMENSION
  ) {
    tooLarge()
  }
  if (board.overlapMode !== 'cover' && board.overlapMode !== 'avoid') {
    invalid()
  }
  if (board.beadSizeMm !== 2.6 && board.beadSizeMm !== 5) {
    invalid()
  }

  const rawLayers = expectArray(board.layers)
  if (rawLayers.length > MAX_BOARD_LAYERS) {
    tooLarge()
  }
  const layers = rawLayers.map((layer) => validateBoardLayer(layer, width, height))
  const layerIds = new Set<string>()
  const zIndexes = new Set<number>()
  let totalLayerCells = 0
  for (const layer of layers) {
    const layerId = layer.output.layerId as string
    if (layerIds.has(layerId) || zIndexes.has(layer.zIndex)) {
      invalid()
    }
    layerIds.add(layerId)
    zIndexes.add(layer.zIndex)
    totalLayerCells += layer.width * layer.height
    if (totalLayerCells > MAX_BOARD_TOTAL_LAYER_CELLS) {
      tooLarge()
    }
  }

  if (board.overlapMode === 'avoid') {
    for (let index = 0; index < layers.length; index += 1) {
      const layer = layers[index]
      if (!layer) {
        continue
      }
      for (const other of layers.slice(index + 1)) {
        if (rectanglesOverlap(layer, other)) {
          invalid()
        }
      }
    }
  }

  const directPixels = validateDirectPixels(board.directPixels, width, height)
  const erasePixels = validateErasePixels(board.erasePixels, width, height)
  if (Object.keys(directPixels).length + Object.keys(erasePixels).length > MAX_BOARD_SPARSE_PIXELS) {
    tooLarge()
  }
  if (Object.keys(directPixels).some((coordinate) => coordinate in erasePixels)) {
    invalid()
  }

  const replacements = validateColorReplacements(board.colorReplacements)
  const visible = new Map<string, ValidatedBoardCell>()
  for (const layer of [...layers].sort((first, second) => first.zIndex - second.zIndex)) {
    layer.mappedPixelData.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (!cell.isExternal) {
          visible.set(`${layer.x + columnIndex},${layer.y + rowIndex}`, {
            ...cell,
            colorMode: 'inherited',
          })
        }
      })
    })
  }
  for (const [coordinate, cell] of Object.entries(directPixels)) {
    visible.set(coordinate, cell as ValidatedBoardCell)
  }
  for (const coordinate of Object.keys(erasePixels)) {
    visible.delete(coordinate)
  }

  const finalCells = Array.from(visible.values(), (cell) =>
    cell.colorMode === 'final' ? cell : replacements.get(cell.color) ?? cell,
  )
  const colorCounts = toColorCounts(finalCells)
  const colorReplacements: JsonObject = {}
  for (const [sourceColor, cell] of replacements) {
    colorReplacements[sourceColor] = cell
  }

  return {
    assetReferences: deduplicateAssetReferences(layers.flatMap((layer) => layer.assetReferences)),
    colorCounts,
    board: {
      size: { width, height },
      overlapMode: board.overlapMode,
      beadSizeMm: board.beadSizeMm,
      layers: layers.map((layer) => layer.output),
      directPixels,
      erasePixels,
      colorReplacements,
    },
  }
}

const validateWorkDocument = (
  value: unknown,
  expectedRevision: number,
  materialListRevision: number,
): ValidatedDocument => {
  const document = expectExactObject(value, [
    'schemaVersion',
    'kind',
    'title',
    'documentRevision',
    'settings',
    'pattern',
    'board',
    'materialList',
  ])
  if (
    document.schemaVersion !== 1 ||
    (document.kind !== 'pattern' && document.kind !== 'board') ||
    document.documentRevision !== expectedRevision ||
    !isObject(document.settings)
  ) {
    invalid()
  }
  expectJsonValue(document.settings)

  const title = normalizeTitle(document.title)
  if (document.kind === 'pattern') {
    if (document.board !== null) {
      invalid()
    }
    const pattern = validatePattern(document.pattern)
    return {
      assetReferences: [],
      document: {
        schemaVersion: 1,
        kind: 'pattern',
        title,
        documentRevision: expectedRevision,
        settings: document.settings,
        pattern,
        board: null,
        materialList: validateMaterialList(
          document.materialList,
          pattern.colorCounts as JsonObject,
          materialListRevision,
        ),
      },
    }
  }

  if (document.pattern !== null) {
    invalid()
  }
  const validatedBoard = validateBoard(document.board)
  return {
    assetReferences: validatedBoard.assetReferences,
    document: {
      schemaVersion: 1,
      kind: 'board',
      title,
      documentRevision: expectedRevision,
      settings: document.settings,
      pattern: null,
      board: validatedBoard.board,
      materialList: validateMaterialList(
        document.materialList,
        validatedBoard.colorCounts,
        materialListRevision,
      ),
    },
  }
}

const withDocumentMetrics = (
  value: ValidatedDocument,
): Pick<ValidatedCreateWorkInput, 'assetReferences' | 'document' | 'documentByteSize' | 'documentSha256' | 'kind' | 'title'> => {
  const canonicalDocument = stableStringify(value.document)
  const documentByteSize = Buffer.byteLength(canonicalDocument, 'utf8')
  if (documentByteSize > MAX_WORK_REQUEST_BYTES) {
    tooLarge()
  }

  return {
    assetReferences: value.assetReferences,
    document: value.document,
    documentByteSize,
    documentSha256: sha256(canonicalDocument),
    kind: value.document.kind,
    title: value.document.title,
  }
}

export const validateCreateWorkInput = (value: unknown): ValidatedCreateWorkInput => {
  const parsed = createWorkInputSchema.safeParse(value)
  if (!parsed.success) {
    invalid()
  }

  const parsedData = parsed.data ?? invalid()
  const title = normalizeTitle(parsedData.title)
  const validated = validateWorkDocument(parsedData.document, 0, 0)
  if (
    validated.document.kind !== parsedData.kind ||
    validated.document.title !== title ||
    validated.assetReferences.length > 0
  ) {
    // WorkAsset has to belong to an existing Work, so initial creation cannot
    // contain an asset ID. The documented flow creates a draft first.
    invalid()
  }

  const metrics = withDocumentMetrics(validated)
  return {
    ...metrics,
    requestSha256: sha256(
      stableStringify({ title, kind: metrics.kind, document: metrics.document }),
    ),
  }
}

export type ValidatedUpdateWorkInput = Omit<ValidatedCreateWorkInput, 'requestSha256'> & {
  expectedRevision: number
  requestSha256: string
}

export const validateUpdateWorkInput = (value: unknown): ValidatedUpdateWorkInput => {
  const parsed = updateWorkInputSchema.safeParse(value)
  if (!parsed.success) {
    invalid()
  }

  const parsedData = parsed.data ?? invalid()
  const metrics = withDocumentMetrics(
    validateWorkDocument(
      parsedData.document,
      parsedData.expectedRevision,
      parsedData.expectedRevision + 1,
    ),
  )
  return {
    ...metrics,
    expectedRevision: parsedData.expectedRevision,
    requestSha256: sha256(
      stableStringify({ expectedRevision: parsedData.expectedRevision, document: metrics.document }),
    ),
  }
}
