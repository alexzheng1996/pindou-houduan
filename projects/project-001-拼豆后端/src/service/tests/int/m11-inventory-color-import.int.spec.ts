// 文件开头说明：CSV 导入映射只验证“唯一匹配才可写入”的基础规则。测试固定包含
// 当前已知的漫漫 S4 双 HEX 情况，防止后续重用前端首项匹配逻辑导致静默错账。
import { describe, expect, it } from 'vitest'

import { createColorLookup, parseInventoryCsv, resolveImportedColorCode } from '@/inventory/color-mapping'

describe('M1.1 库存色号导入映射', () => {
  const mapping = {
    '#123456': { MARD: 'M1', COCO: 'C1', 漫漫: 'S4', 盼盼: 'P1', 咪小窝: 'X1' },
    '#ABCDEF': { MARD: 'M2', COCO: 'C2', 漫漫: 'S4', 盼盼: 'P2', 咪小窝: 'X2' },
  }

  it('只接受唯一映射；未知和漫漫 S4 歧义必须被预检拦截', () => {
    const lookup = createColorLookup(mapping, '漫漫')
    expect(resolveImportedColorCode(lookup, 'S4')).toMatchObject({ status: 'ambiguous', normalizedCode: 'S4' })
    expect(resolveImportedColorCode(lookup, 'S404')).toMatchObject({ status: 'unknown', normalizedCode: 'S404' })
    expect(resolveImportedColorCode(createColorLookup(mapping, 'MARD'), ' m1 ')).toEqual({
      status: 'unique', normalizedCode: 'M1', colorHex: '#123456',
    })
  })

  it('按 RFC4180 解析 CSV，拒绝缺失或额外的模板列', () => {
    expect(parseInventoryCsv('\uFEFF色号,数量\r\n" A01 ","100"\r\n')).toEqual({
      rows: [{ rowNumber: 2, colorCode: 'A01', quantity: '100' }],
    })
    expect(parseInventoryCsv('色号,数量,备注\nA01,100,x\n')).toMatchObject({ error: 'invalid_header' })
    expect(parseInventoryCsv('编号,数量\nA01,100\n')).toMatchObject({ error: 'invalid_header' })
  })
})
