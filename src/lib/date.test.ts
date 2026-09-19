import { describe, expect, it } from 'vitest'
import { clampYm, shiftMonth, yearGridStart, YEAR_GRID } from './date'

describe('日历的年那层', () => {
  it('起点对齐到 12 的倍数：同一年不管从哪个月上来，看到的都是同一屏', () => {
    // 变异：yearGridStart 改成 year - 6 → 红
    expect(yearGridStart(2026)).toBe(2016)
    expect(yearGridStart(2016)).toBe(2016)
    expect(yearGridStart(2027)).toBe(2016)
    expect(yearGridStart(2028)).toBe(2028)
    expect(yearGridStart(2023)).toBe(2016)
    expect(YEAR_GRID).toBe(12)
  })

  it('翻一屏正好接上，不重叠不漏', () => {
    const a = yearGridStart(2026)
    expect(yearGridStart(a + YEAR_GRID)).toBe(a + YEAR_GRID)
    expect(yearGridStart(a - 1)).toBe(a - YEAR_GRID)
  })

  it('点某月回到日那层，月份不能超过今天所在月', () => {
    // 变异：clampYm 直接返回 ym → 红
    expect(clampYm('2026-12', '2026-09')).toBe('2026-09')
    expect(clampYm('2026-09', '2026-09')).toBe('2026-09')
    expect(clampYm('2023-03', '2026-09')).toBe('2023-03')
  })

  it('翻月跨年', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
  })
})
