import { describe, expect, it } from 'vitest'
import { haystack, searchTx, searchSummary, type SearchNames } from './search'
import type { Transaction } from '../types'

const NAMES: SearchNames = {
  category: (id) => (id === 'c1' ? '日常开支 · 晚餐' : id === 'c2' ? '非经常生活消费 · 家居' : ''),
  account: (id) => (id === 'a1' ? '中国银行' : id === 'a2' ? '微信' : ''),
}

let n = 0
function tx(p: Partial<Transaction> = {}): Transaction {
  n += 1
  return {
    id: `t${n}`,
    date: '2026-09-05',
    type: 'expense',
    amount: 2540,
    account_id: 'a1',
    to_account_id: null,
    category_id: 'c1',
    note: null,
    created_at: `2026-09-05T00:00:${String(n).padStart(2, '0')}.000Z`,
    ...p,
  }
}

describe('haystack', () => {
  it('备注、分类、账户、金额都在里面', () => {
    const h = haystack(tx({ note: '安装窗帘定金', amount: 50000, category_id: 'c2' }), NAMES)
    expect(h).toContain('窗帘')
    expect(h).toContain('非经常生活消费')
    expect(h).toContain('家居')
    expect(h).toContain('中国银行')
    expect(h).toContain('500.00')
  })
  it('转账的两个账户都能搜到', () => {
    const h = haystack(tx({ type: 'transfer', account_id: 'a1', to_account_id: 'a2', category_id: null }), NAMES)
    expect(h).toContain('中国银行')
    expect(h).toContain('微信')
  })
  it('故意不含日期：搜年份不该把整年捞出来', () => {
    expect(haystack(tx({ date: '2026-09-05' }), NAMES)).not.toContain('2026')
  })
})

describe('searchTx', () => {
  const rows = [
    tx({ note: '安装窗帘定金', amount: 50000 }),
    tx({ note: '窗帘尾款', amount: 50000 }),
    tx({ note: '晚餐', amount: 2540 }),
    tx({ note: null, amount: 1800, category_id: 'c2' }),
  ]
  it('搜备注', () => {
    expect(searchTx(rows, '窗帘', NAMES).map((t) => t.note)).toEqual(['安装窗帘定金', '窗帘尾款'])
  })
  it('搜分类名', () => {
    expect(searchTx(rows, '家居', NAMES)).toHaveLength(1)
  })
  it('搜金额', () => {
    expect(searchTx(rows, '25.40', NAMES).map((t) => t.note)).toEqual(['晚餐'])
  })
  it('金额可以只输前几位', () => {
    expect(searchTx(rows, '500', NAMES)).toHaveLength(2)
  })
  it('空格分词是「都要命中」', () => {
    expect(searchTx(rows, '窗帘 定金', NAMES).map((t) => t.note)).toEqual(['安装窗帘定金'])
  })
  it('大小写不敏感', () => {
    const named: SearchNames = { category: () => 'Coffee', account: () => '' }
    expect(searchTx([tx()], 'coffee', named)).toHaveLength(1)
  })
  it('空查询原样返回，不是返回空', () => {
    expect(searchTx(rows, '   ', NAMES)).toHaveLength(4)
  })
  it('没有备注的那笔不会因为 null 崩掉', () => {
    expect(() => searchTx(rows, 'x', NAMES)).not.toThrow()
  })
})

describe('searchSummary', () => {
  it('只算收支，转账和校准不进', () => {
    const rows = [
      tx({ type: 'expense', amount: 100 }),
      tx({ type: 'income', amount: 900 }),
      tx({ type: 'transfer', amount: 5000, category_id: null, to_account_id: 'a2' }),
      tx({ type: 'adjust', amount: -300, category_id: null }),
    ]
    expect(searchSummary(rows)).toEqual({ income: 900, expense: 100, count: 4 })
  })
  it('笔数是全部命中的笔数，不只是收支那几笔', () => {
    expect(searchSummary([tx({ type: 'transfer', category_id: null, to_account_id: 'a2' })]).count).toBe(1)
  })
})
