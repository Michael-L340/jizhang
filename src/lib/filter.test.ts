import { describe, expect, it } from 'vitest'
import { isFiltered, matchesFilter, NO_FILTER, type LedgerFilter } from './filter'
import type { Transaction } from '../types'

const rootOf = (id: string) => ({ p1: 'p1', c1: 'p1', c2: 'p2' } as Record<string, string>)[id]

function tx(p: Partial<Transaction> = {}): Transaction {
  return {
    id: 't',
    date: '2026-09-05',
    type: 'expense',
    amount: 100,
    account_id: 'a1',
    to_account_id: null,
    category_id: 'c1',
    note: null,
    created_at: '2026-09-05T00:00:00.000Z',
    ...p,
  }
}
const f = (p: Partial<LedgerFilter>): LedgerFilter => ({ ...NO_FILTER, ...p })

describe('matchesFilter', () => {
  it('不筛就全过', () => {
    expect(matchesFilter(tx(), NO_FILTER, rootOf)).toBe(true)
    expect(matchesFilter(tx({ type: 'transfer', category_id: null }), NO_FILTER, rootOf)).toBe(true)
    expect(isFiltered(NO_FILTER)).toBe(false)
  })

  it('分类按一级匹配，二级归到它的一级', () => {
    expect(matchesFilter(tx({ category_id: 'c1' }), f({ parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'p1' }), f({ parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'c2' }), f({ parentId: 'p1' }), rootOf)).toBe(false)
    expect(matchesFilter(tx({ category_id: null }), f({ parentId: 'p1' }), rootOf)).toBe(false)
  })

  it('「未分类」只挑没有分类的收支，转账和校准不算', () => {
    const none = f({ parentId: 'none' })
    expect(matchesFilter(tx({ category_id: null }), none, rootOf)).toBe(true)
    expect(matchesFilter(tx({ type: 'income', category_id: null }), none, rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'c1' }), none, rootOf)).toBe(false)
    expect(matchesFilter(tx({ type: 'transfer', category_id: null, to_account_id: 'a2' }), none, rootOf)).toBe(false)
    expect(matchesFilter(tx({ type: 'adjust', category_id: null }), none, rootOf)).toBe(false)
  })

  it('账户：转入转出两边都算；「未指定」只挑没有账户的', () => {
    const t = tx({ type: 'transfer', account_id: 'a1', to_account_id: 'a2', category_id: null })
    expect(matchesFilter(t, f({ accountId: 'a2' }), rootOf)).toBe(true)
    expect(matchesFilter(t, f({ accountId: 'a3' }), rootOf)).toBe(false)
    expect(matchesFilter(tx({ account_id: null }), f({ accountId: 'none' }), rootOf)).toBe(true)
    expect(matchesFilter(tx(), f({ accountId: 'none' }), rootOf)).toBe(false)
  })

  it('条件之间是「且」', () => {
    expect(matchesFilter(tx(), f({ type: 'expense', parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx(), f({ type: 'income', parentId: 'p1' }), rootOf)).toBe(false)
    expect(isFiltered(f({ type: 'income' }))).toBe(true)
  })
})
