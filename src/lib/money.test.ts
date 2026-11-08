import { describe, expect, it } from 'vitest'
import { fmtYuanWhole } from './money'

describe('fmtYuanWhole：只写到元（趋势卡的日均）', () => {
  it('四舍五入到元、千分位、带 ¥', () => {
    // 变异：Math.round → Math.floor，25450 写成 ¥254，红；去掉 toLocaleString，¥1234568，红
    expect(fmtYuanWhole(25425)).toBe('¥254')
    expect(fmtYuanWhole(123456789)).toBe('¥1,234,568')
    expect(fmtYuanWhole(25450)).toBe('¥255')
  })
  it('负数减号在 ¥ 前面；零是 ¥0', () => {
    expect(fmtYuanWhole(-500)).toBe('-¥5')
    expect(fmtYuanWhole(0)).toBe('¥0')
  })
})
