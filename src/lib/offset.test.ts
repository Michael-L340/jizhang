// 0012「抵消」：勾上的收入不算收入、从支出里扣；勾上的支出不算支出、从收入里扣。余额、结余不变。
import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../types'
import { balances, byCategory, creditBill, groupByDay, monthSummary, netBook, netFlow, rawFlow } from './compute'
import { outerBook } from './facade'
import { searchSummary } from './search'
import { validateImport } from './validate'

const acc: Account[] = [
  { id: '11111111-1111-4111-8111-111111111111', name: '微信', kind: 'wallet', sort: 1, is_archived: false, repay_day: null, defer_after_repay: null, facade_offset: null },
  { id: '22222222-2222-4222-8222-222222222222', name: '京东白条', kind: 'credit', sort: 2, is_archived: false, repay_day: 17, defer_after_repay: null, facade_offset: null },
]
const cats: Category[] = [
  { id: '33333333-3333-4333-8333-333333333333', kind: 'expense', parent_id: null, name: '衣服', icon: null, sort: 1, is_archived: false, note: null },
  { id: '44444444-4444-4444-8444-444444444444', kind: 'expense', parent_id: null, name: '餐饮', icon: null, sort: 2, is_archived: false, note: null },
  { id: '55555555-5555-4555-8555-555555555555', kind: 'income', parent_id: null, name: '报销', icon: null, sort: 1, is_archived: false, note: null },
]
let n = 0
const tx = (o: Partial<Transaction>): Transaction => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, date: '2026-10-09', type: 'expense', amount: 100, account_id: '11111111-1111-4111-8111-111111111111', to_account_id: null,
  category_id: '44444444-4444-4444-8444-444444444444', note: null, installments: null, settles: null, hidden: null, is_offset: null, created_at: `2026-10-09T0${n % 10}:00:00.000Z`, ...o,
})

const lunch = tx({ amount: 3200 })
const coat = tx({ amount: 29900, category_id: '33333333-3333-4333-8333-333333333333' })
const refund = tx({ type: 'income', amount: 29900, category_id: '33333333-3333-4333-8333-333333333333', is_offset: true })
const salary = tx({ type: 'income', amount: 800000, category_id: '55555555-5555-4555-8555-555555555555' })
const advance = tx({ type: 'expense', amount: 50000, category_id: '55555555-5555-4555-8555-555555555555', is_offset: true })
const all = [lunch, coat, refund, salary, advance]

describe('抵消', () => {
  it('本月收入、支出按抵消后算，结余和余额不变', () => {
    const book = outerBook(all, acc, [], 'inner')
    expect(monthSummary(book, '2026-10')).toMatchObject({ expense: 3200, income: 750000, net: 746800 })
    expect(monthSummary(all, '2026-10').net).toBe(746800) // 不抵消时结余一样
    expect(balances(book, acc)).toEqual(balances(all, acc))
  })

  it('退款从它选的支出分类里扣；外页面同样抵消', () => {
    const agg = byCategory(outerBook(all, acc, [], 'outer'), cats, '2026-10', 'expense')
    expect(agg.map((a) => [a.id, a.amount])).toEqual([[cats[1].id, 3200], [cats[0].id, 0]])
  })

  it('流水每天小计、搜索小计也按抵消后算', () => {
    expect(groupByDay(all)[0]).toMatchObject({ expense: 3200, income: 750000 })
    expect(searchSummary(all)).toMatchObject({ expense: 3200, income: 750000 })
  })

  it('换两次和换一次一样，rawFlow 能换回原样', () => {
    const once = netFlow(refund)
    expect(netFlow(once)).toBe(once)
    expect(rawFlow(once)).toEqual(refund)
    expect(netBook([lunch])).toEqual([lunch])
  })

  it('白条账单看原始流水：白条上的退款照旧当还款抵欠款', () => {
    const order = tx({ account_id: '22222222-2222-4222-8222-222222222222', amount: 10000, date: '2026-10-01', category_id: '33333333-3333-4333-8333-333333333333' })
    const back = tx({ type: 'income', account_id: '22222222-2222-4222-8222-222222222222', amount: 10000, date: '2026-10-05', category_id: '33333333-3333-4333-8333-333333333333', is_offset: true })
    const book = outerBook([order, back], acc, [], 'inner')
    expect(creditBill(book, acc[1], '2026-10-09').left).toBe(0)
    expect(creditBill(book, acc[1], '2026-10-09')).toEqual(creditBill([order, back], acc[1], '2026-10-09'))
  })

  it('备份校验：抵消的那笔分类在另一边才对；转账不能勾抵消', () => {
    const snap = (t: Transaction[]) => ({ accounts: acc, categories: cats, transactions: t, facade_adjusts: [], meter_readings: [] })
    expect(() => validateImport(snap([refund, advance]))).not.toThrow()
    expect(() => validateImport(snap([tx({ type: 'income', category_id: '55555555-5555-4555-8555-555555555555', is_offset: true })]))).toThrow(/类型对不上/)
    expect(() => validateImport(snap([tx({ type: 'transfer', category_id: null, to_account_id: '22222222-2222-4222-8222-222222222222', is_offset: true })]))).toThrow(/抵消/)
  })
})
