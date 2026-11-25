import { describe, expect, it } from 'vitest'
import { calYears, dayCells, daysInMonth, drillOf, monthCells, weekLead, yearCells } from './homeCal'
import { netBook } from './compute'
import { fmtShortYuan } from './money'
import type { Transaction } from '../types'

let n = 0
const tx = (date: string, type: Transaction['type'], amount: number, extra: Partial<Transaction> = {}): Transaction => ({
  id: `t${++n}`,
  date,
  type,
  amount,
  account_id: 'a',
  to_account_id: type === 'transfer' ? 'b' : null,
  category_id: type === 'expense' || type === 'income' ? 'c' : null,
  note: null,
  installments: null,
  settles: null,
  hidden: null,
  is_offset: null,
  created_at: `${date}T12:00:00Z`,
  ...extra,
})

describe('首页日历：按日 / 月 / 年加收支', () => {
  const book = [
    tx('2026-11-24', 'expense', 22900),
    tx('2026-11-24', 'expense', 600),
    tx('2026-11-23', 'income', 1200000),
    tx('2026-11-23', 'expense', 18600),
    tx('2026-11-23', 'transfer', 50000), // 转账不算收支
    tx('2026-11-22', 'adjust', -3000), // 校准不算
    tx('2026-11-21', 'income', 500, { is_offset: true }), // 午餐退款 5 元：从支出里扣
    tx('2026-11-21', 'expense', 2800),
    tx('2026-10-31', 'expense', 10000),
    tx('2025-12-31', 'expense', 7000),
  ]

  it('日：每天的收入、支出、笔数；转账、校准不进', () => {
    const m = dayCells(book, '2026-11')
    expect(m.get('2026-11-24')).toEqual({ expense: 23500, income: 0, count: 2 })
    expect(m.get('2026-11-23')).toEqual({ expense: 18600, income: 1200000, count: 2 })
    expect(m.has('2026-11-22')).toBe(false)
    expect(m.has('2026-10-31')).toBe(false)
  })

  it('抵消的退款从当天支出里扣，不算收入；原始账本和 netBook 换过的结果一样', () => {
    // 变异：tally 里不过 netFlow → 21 号变成收入 5 元、支出 28 元 → 红
    expect(dayCells(book, '2026-11').get('2026-11-21')).toEqual({ expense: 2300, income: 0, count: 2 })
    expect(dayCells(netBook(book), '2026-11')).toEqual(dayCells(book, '2026-11'))
  })

  it('月、年：同一口径往上加', () => {
    const m = monthCells(book, '2026')
    expect(m.get('2026-11')).toEqual({ expense: 23500 + 18600 + 2300, income: 1200000, count: 6 })
    expect(m.get('2026-10')).toEqual({ expense: 10000, income: 0, count: 1 })
    expect(m.has('2025-12')).toBe(false)
    const y = yearCells(book)
    expect(y.get('2026')?.expense).toBe(23500 + 18600 + 2300 + 10000)
    expect(y.get('2025')).toEqual({ expense: 7000, income: 0, count: 1 })
  })

  it('年档列从最早有收支那年到今年，中间空年也列', () => {
    expect(calYears(book, '2026-11-25')).toEqual(['2025', '2026'])
    expect(calYears([tx('2023-05-01', 'expense', 100)], '2026-01-01')).toEqual(['2023', '2024', '2025', '2026'])
    expect(calYears([], '2026-11-25')).toEqual(['2026'])
    // 只有转账的年份不算「有记录」
    expect(calYears([tx('2020-01-01', 'transfer', 100)], '2026-11-25')).toEqual(['2026'])
  })

  it('周一开头：前面空几格；每月几天', () => {
    expect(weekLead('2026-11')).toBe(6) // 2026-11-01 周日
    expect(weekLead('2026-06')).toBe(0) // 2026-06-01 周一
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2024-02')).toBe(29)
    expect(daysInMonth('2026-11')).toBe(30)
  })

  it('再点一下：年 → 各月 → 每天 → 流水页那一天', () => {
    expect(drillOf('year', '2025')).toEqual({ level: 'month', anchor: '2025' })
    expect(drillOf('month', '2026-10')).toEqual({ level: 'day', anchor: '2026-10' })
    expect(drillOf('day', '2026-11-24')).toEqual({ ledger: '/ledger?date=2026-11-24' })
  })
})

describe('格子里的短写', () => {
  it('整数元、不带千分位；上万写「万」；不到 1 元留小数', () => {
    expect(fmtShortYuan(234500)).toBe('2345')
    expect(fmtShortYuan(8650)).toBe('87')
    expect(fmtShortYuan(1200000)).toBe('1.2万')
    expect(fmtShortYuan(2000000)).toBe('2万')
    expect(fmtShortYuan(50)).toBe('0.5')
    expect(fmtShortYuan(-22900)).toBe('229')
  })
})
