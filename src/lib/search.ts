// 流水搜索。纯函数，不依赖 store / api / DOM。
import type { Transaction } from '../types'
import { fmtYuan } from './money'

/** 把一笔流水身上所有「能被搜到」的文字拼成一条。名字由调用方提供，这里不认识 store。 */
export interface SearchNames {
  /** 分类 id → 「一级 · 二级」，找不到给空串 */
  category: (id: string | null) => string
  /** 账户 id → 账户名，找不到给空串 */
  account: (id: string | null) => string
}

/**
 * 搜索命中的范围：备注、分类名（一级和二级都算）、账户名、金额。
 *
 * **故意不含日期**：日期里有年份，搜「26」会把 2026 年的每一笔都捞出来，
 * 而选日期本来就有月份选择器，不需要靠搜索。
 */
export function haystack(t: Transaction, names: SearchNames): string {
  return [
    t.note ?? '',
    names.category(t.category_id),
    names.account(t.account_id),
    names.account(t.to_account_id),
    fmtYuan(t.amount),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

/**
 * 空格分词，每个词都要命中（AND）。「窗帘 定金」比「窗帘定金」宽松，
 * 因为备注里这两个词未必挨着。
 */
export function searchTx(txs: Transaction[], query: string, names: SearchNames): Transaction[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return txs
  return txs.filter((t) => {
    const h = haystack(t, names)
    return terms.every((w) => h.includes(w))
  })
}

/**
 * 搜索结果的小计。不能用 monthSummary——那个只算某一个月，
 * 而搜索是跨月的，用它会得出 0。转账和校准照旧不进收支。
 */
export function searchSummary(txs: Transaction[]): { income: number; expense: number; count: number } {
  let income = 0
  let expense = 0
  for (const t of txs) {
    if (t.type === 'income') income += t.amount
    else if (t.type === 'expense') expense += t.amount
  }
  return { income, expense, count: txs.length }
}
