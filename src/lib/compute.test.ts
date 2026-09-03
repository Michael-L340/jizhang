import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../types'
import { adjustTotal, balanceHistory, balances, byCategory, dailyCumulative, monthSummary, monthlySeries, recentChildOrder, totalOf } from './compute'
import { addDays, daysInMonth, lastMonths, monthRange, shiftMonth, today } from './date'
import { centsFromDb, centsToDb, fmtYuan, parseYuan } from './money'

const accounts: Account[] = [
  { id: 'boc', name: '中国银行', kind: 'bank', sort: 1, is_archived: false },
  { id: 'cmb', name: '招商银行', kind: 'bank', sort: 2, is_archived: false },
  { id: 'wx', name: '微信', kind: 'wallet', sort: 4, is_archived: false },
]
const cats: Category[] = [
  { id: 'food', kind: 'expense', parent_id: null, name: '日常餐饮', icon: '🍚', sort: 1, is_archived: false },
  { id: 'lunch', kind: 'expense', parent_id: 'food', name: '午餐', icon: null, sort: 2, is_archived: false },
  { id: 'dinner', kind: 'expense', parent_id: 'food', name: '晚餐', icon: null, sort: 3, is_archived: false },
  { id: 'fun', kind: 'expense', parent_id: null, name: '娱乐消费', icon: '🎮', sort: 2, is_archived: false },
  { id: 'game', kind: 'expense', parent_id: 'fun', name: '游戏充值', icon: null, sort: 1, is_archived: false },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'account_id'>): Transaction {
  seq++
  return {
    id: `t${seq}`,
    date: '2026-09-03',
    to_account_id: null,
    category_id: null,
    note: null,
    created_at: `2026-09-03T0${seq % 10}:00:00.000Z`,
    ...p,
  }
}

describe('money', () => {
  it('parses yuan to cents', () => {
    expect(parseYuan('12.5')).toBe(1250)
    expect(parseYuan('0.1')).toBe(10)
    expect(parseYuan('1,234.56')).toBe(123456)
    expect(parseYuan('-3')).toBe(-300)
    expect(parseYuan('')).toBeNull()
    expect(parseYuan('1.234')).toBeNull()
    expect(parseYuan('abc')).toBeNull()
  })
  it('round-trips db numeric without float drift', () => {
    expect(centsFromDb(0.1 + 0.2)).toBe(30)
    expect(centsFromDb('1234.56')).toBe(123456)
    expect(centsToDb(123456)).toBe('1234.56')
    expect(centsToDb(-5)).toBe('-0.05')
    expect(centsToDb(0)).toBe('0.00')
  })
  it('formats', () => {
    expect(fmtYuan(123456)).toBe('1,234.56')
    expect(fmtYuan(-500, { symbol: true })).toBe('-¥5.00')
    expect(fmtYuan(500, { sign: true })).toBe('+5.00')
  })
})

describe('date', () => {
  it('today is Beijing date even at UTC late evening', () => {
    // 2026-09-03 16:30 UTC = 2026-09-04 00:30 北京
    expect(today(new Date('2026-09-03T16:30:00Z'))).toBe('2026-09-04')
    expect(today(new Date('2026-09-03T15:59:00Z'))).toBe('2026-09-03')
  })
  it('month helpers', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(daysInMonth('2026-02')).toBe(28)
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(lastMonths(3, '2026-01')).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('balances', () => {
  it('applies income/expense/transfer/adjust correctly', () => {
    const txs = [
      tx({ type: 'income', amount: 1300000, account_id: 'cmb', category_id: 'salary' }),
      tx({ type: 'expense', amount: 2800, account_id: 'wx', category_id: 'lunch' }),
      tx({ type: 'transfer', amount: 300000, account_id: 'cmb', to_account_id: 'wx' }),
      tx({ type: 'adjust', amount: 50000, account_id: 'boc' }),
      tx({ type: 'adjust', amount: -1200, account_id: 'wx' }),
    ]
    const b = balances(txs, accounts)
    expect(b.cmb).toBe(1000000)
    expect(b.wx).toBe(300000 - 2800 - 1200)
    expect(b.boc).toBe(50000)
    expect(totalOf(b)).toBe(1000000 + 296000 + 50000)
  })

  it('user example: 中国银行 1000 → real 1500 makes +500 adjust, total 2000 → 2500', () => {
    const txs = [
      tx({ type: 'adjust', amount: 100000, account_id: 'boc' }),
      tx({ type: 'adjust', amount: 100000, account_id: 'cmb' }),
    ]
    const before = balances(txs, accounts)
    expect(totalOf(before)).toBe(200000)
    const delta = 150000 - before.boc
    expect(delta).toBe(50000)
    const after = balances([...txs, tx({ type: 'adjust', amount: delta, account_id: 'boc' })], accounts)
    expect(after.boc).toBe(150000)
    expect(totalOf(after)).toBe(250000)
  })
})

describe('month stats exclude transfer and adjust', () => {
  const txs = [
    tx({ type: 'expense', amount: 2800, account_id: 'wx', category_id: 'lunch' }),
    tx({ type: 'expense', amount: 6480, account_id: 'wx', category_id: 'game' }),
    tx({ type: 'income', amount: 1300000, account_id: 'cmb', category_id: 'salary' }),
    tx({ type: 'transfer', amount: 300000, account_id: 'cmb', to_account_id: 'wx' }),
    tx({ type: 'adjust', amount: -99999, account_id: 'wx' }),
    tx({ type: 'expense', amount: 100, account_id: 'wx', category_id: 'lunch', date: '2026-08-31' }),
  ]
  it('monthSummary', () => {
    const s = monthSummary(txs, '2026-09')
    expect(s.expense).toBe(9280)
    expect(s.income).toBe(1300000)
    expect(s.net).toBe(1300000 - 9280)
    expect(s.savingRate).toBeCloseTo((1300000 - 9280) / 1300000)
    expect(monthSummary(txs, '2026-07').savingRate).toBeNull()
  })
  it('byCategory groups into parents with children', () => {
    const agg = byCategory(txs, cats, '2026-09', 'expense')
    expect(agg.map((a) => a.name)).toEqual(['娱乐消费', '日常餐饮'])
    expect(agg[1].amount).toBe(2800)
    expect(agg[1].children[0]).toMatchObject({ name: '午餐', amount: 2800 })
    expect(agg.reduce((s, a) => s + a.amount, 0)).toBe(monthSummary(txs, '2026-09').expense)
  })
  it('adjustTotal reports unrecorded delta', () => {
    expect(adjustTotal(txs, '2026-09')).toBe(-99999)
  })
  it('dailyCumulative ends at month expense and nulls future days', () => {
    const arr = dailyCumulative(txs, '2026-09', '2026-09-05')
    expect(arr.length).toBe(30)
    expect(arr[2]).toBe(9280)
    expect(arr[4]).toBe(9280)
    expect(arr[5]).toBeNull()
  })
  it('monthlySeries includes empty months', () => {
    const s = monthlySeries(txs, '2026-09', 3)
    expect(s.map((r) => r.ym)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(s[0]).toMatchObject({ income: 0, expense: 0 })
    expect(s[1].expense).toBe(100)
    expect(s[2].expense).toBe(9280)
  })
})

describe('balanceHistory', () => {
  it('walks day by day', () => {
    const txs = [
      tx({ type: 'adjust', amount: 10000, account_id: 'wx', date: '2026-08-01' }),
      tx({ type: 'expense', amount: 1000, account_id: 'wx', category_id: 'lunch', date: '2026-09-02' }),
      tx({ type: 'income', amount: 5000, account_id: 'cmb', category_id: 'salary', date: '2026-09-03' }),
    ]
    const h = balanceHistory(txs, accounts, 3, '2026-09-03')
    expect(h.dates).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(h.series.wx).toEqual([10000, 9000, 9000])
    expect(h.series.cmb).toEqual([0, 0, 5000])
    expect(h.total).toEqual([10000, 9000, 14000])
  })
})

describe('recentChildOrder', () => {
  it('puts most recently used first, unused by sort', () => {
    const txs = [
      tx({ type: 'expense', amount: 1, account_id: 'wx', category_id: 'dinner', date: '2026-09-01' }),
      tx({ type: 'expense', amount: 1, account_id: 'wx', category_id: 'lunch', date: '2026-08-01' }),
    ]
    expect(recentChildOrder(txs, cats, 'food').map((c) => c.name)).toEqual(['晚餐', '午餐'])
    expect(recentChildOrder([], cats, 'food').map((c) => c.name)).toEqual(['午餐', '晚餐'])
  })
})
