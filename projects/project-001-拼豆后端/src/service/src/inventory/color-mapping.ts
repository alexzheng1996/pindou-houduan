// 文件开头说明：个人豆仓 CSV 导入不能直接调用前端的“取第一项”色号转换。这里把
// 色号映射定义为服务端可审查的 0/1/多匹配结果；当前只登记已核对的 5 套系统，
// 美国品牌在业务确认实际品牌、版本和可追溯来源前不得加入。映射快照随项目归档，
// 导入只读取本仓库版本，避免前端色表变化后把旧文件静默记到另一种颜色。
import colorSystemMapping from './data/pixomosaic-color-system-mapping-2026-08-22.json'

import { parse } from 'csv-parse/sync'

export type InventoryColorSystem = 'COCO' | 'MARD' | '咪小窝' | '漫漫' | '盼盼'

export type ColorMapping = Record<string, Record<InventoryColorSystem, string>>

type ParsedCsvRow = {
  colorCode: string
  quantity: string
  rowNumber: number
}

export type ParsedInventoryCsv =
  | { error: 'invalid_csv' | 'invalid_header'; rows: [] }
  | { rows: ParsedCsvRow[] }

const knownSystems: readonly InventoryColorSystem[] = ['MARD', 'COCO', '漫漫', '盼盼', '咪小窝']

export const inventoryColorMapping = colorSystemMapping as ColorMapping

const normalizeCode = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, '')

export const isInventoryColorSystem = (value: unknown): value is InventoryColorSystem =>
  typeof value === 'string' && knownSystems.includes(value as InventoryColorSystem)

export const createColorLookup = (
  mapping: ColorMapping,
  system: InventoryColorSystem,
): Map<string, string[]> => {
  const lookup = new Map<string, string[]>()
  for (const [rawHex, codes] of Object.entries(mapping)) {
    const code = codes[system]
    if (!code) {
      continue
    }
    const normalizedHex = rawHex.toUpperCase()
    const normalizedCode = normalizeCode(code)
    const entries = lookup.get(normalizedCode) ?? []
    entries.push(normalizedHex)
    lookup.set(normalizedCode, entries)
  }
  return lookup
}

export const resolveImportedColorCode = (
  lookup: Map<string, string[]>,
  code: string,
): { colorHex?: string; normalizedCode: string; status: 'ambiguous' | 'unknown' | 'unique' } => {
  const normalizedCode = normalizeCode(code)
  const matches = lookup.get(normalizedCode) ?? []
  if (matches.length === 1) {
    return { status: 'unique', normalizedCode, colorHex: matches[0] }
  }
  return { status: matches.length === 0 ? 'unknown' : 'ambiguous', normalizedCode }
}

export const parseInventoryCsv = (text: string): ParsedInventoryCsv => {
  try {
    const rows = parse(text, {
      bom: true,
      columns: true,
      group_columns_by_name: false,
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
    }) as Array<Record<string, unknown>>
    const header = parse(text, {
      bom: true,
      from_line: 1,
      relax_column_count: false,
      to_line: 1,
      trim: true,
    }) as string[][]
    if (header.length !== 1 || header[0]?.length !== 2 || header[0][0] !== '色号' || header[0][1] !== '数量') {
      return { error: 'invalid_header', rows: [] }
    }
    return {
      rows: rows.map((row, index) => ({
        rowNumber: index + 2,
        colorCode: typeof row.色号 === 'string' ? row.色号.trim() : '',
        quantity: typeof row.数量 === 'string' ? row.数量.trim() : '',
      })),
    }
  } catch {
    return { error: 'invalid_csv', rows: [] }
  }
}
