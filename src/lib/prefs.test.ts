import { describe, expect, it } from 'vitest'
import { AVG_DAYS, WEEKDAY_WEEKS } from './meter'
import { changedCount, NUM_PREFS, numPref, numSpec, parseNum, PRICE_PREF, pricePref, prefRow, presetLabel, valueLabel } from './prefs'
import type { Pref } from '../types'

const AT = '2026-11-09T05:00:00.000Z'
const row = (id: string, value: string): Pref => prefRow(id, 'power.avgDays', value, AT)
const AVG = numSpec('power.avgDays')

describe('参数登记表', () => {
  it('id 不重复、都是小写带横线的 uuid（登记过的 id 永远不改：改了云端那行就成了孤儿）', () => {
    const ids = [...NUM_PREFS.map((s) => s.id), PRICE_PREF.id]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const keys = [...NUM_PREFS.map((s) => s.key), PRICE_PREF.key]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('默认值 = 改成可调之前写死的数，而且在范围里、是一个常用值', () => {
    expect(numSpec('power.avgDays').def).toBe(AVG_DAYS)
    expect(numSpec('power.weekdayWeeks').def).toBe(WEEKDAY_WEEKS)
    expect(numSpec('power.hourDays').def).toBe(30)
    expect(numSpec('power.usageDays').def).toBe(30)
    expect(numSpec('power.usageSegs').def).toBe(12)
    for (const s of NUM_PREFS) {
      expect(s.def).toBeGreaterThanOrEqual(s.min)
      expect(s.def).toBeLessThanOrEqual(s.max)
      expect(presetLabel(s, s.def)).not.toBeNull()
      for (const [n] of s.presets) expect(parseNum(String(n), s)).toBe(n)
    }
  })
})

describe('parseNum：只收范围内的整数，填坏了不改值', () => {
  it('范围内的整数照收，前后空格不算', () => {
    expect(parseNum('1', AVG)).toBe(1)
    expect(parseNum(' 21 ', AVG)).toBe(21)
    expect(parseNum('90', AVG)).toBe(90)
  })
  it('范围外、小数、负数、字母、空的都不收', () => {
    for (const s of ['0', '91', '200', '1.5', '-3', '7天', 'abc', '', ' ', '1e2']) expect(parseNum(s, AVG)).toBeUndefined()
  })
})

describe('numPref：现在生效的值', () => {
  it('没设过就是默认', () => {
    expect(numPref([], 'power.avgDays')).toBe(14)
  })
  it('设过的按 id 认，不看 key', () => {
    expect(numPref([row(AVG.id, '7')], 'power.avgDays')).toBe(7)
    expect(numPref([row(numSpec('power.hourDays').id, '7')], 'power.avgDays')).toBe(14)
  })
  it('云端那行解析不了、超出范围（别的版本写的）也按默认算', () => {
    expect(numPref([row(AVG.id, 'abc')], 'power.avgDays')).toBe(14)
    expect(numPref([row(AVG.id, '500')], 'power.avgDays')).toBe(14)
  })
  it('changedCount 只数和默认不一样的', () => {
    expect(changedCount([])).toBe(0)
    expect(changedCount([row(AVG.id, '14')])).toBe(0)
    expect(changedCount([row(AVG.id, '21'), row(numSpec('power.usageSegs').id, '24')])).toBe(2)
  })
})

describe('名字怎么念', () => {
  it('常用值用胶囊上的字，别的写「数 + 单位」', () => {
    const wk = numSpec('power.weekdayWeeks')
    expect(valueLabel(wk, 26)).toBe('半年')
    expect(valueLabel(wk, 20)).toBe('20 周')
    expect(presetLabel(wk, 20)).toBeNull()
  })
})

describe('pricePref：电价', () => {
  it('没这一行 = 还没决定（undefined），和「填了空的」（null）分开', () => {
    expect(pricePref([])).toBeUndefined()
    expect(pricePref([row(PRICE_PREF.id, '')])).toBeNull()
    expect(pricePref([row(PRICE_PREF.id, '0.56')])).toBe(0.56)
    expect(pricePref([row(PRICE_PREF.id, 'abc')])).toBeNull()
  })
})
