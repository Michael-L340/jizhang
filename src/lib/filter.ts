import type { Transaction } from '../types'
import { isFlow } from './compute'

/** 账户筛选里的「白条」：四个平台一起筛 */
export const CREDIT_ALL = 'credit'

/** 流水页筛选。'all' 不限；账户 'none' = 未指定账户、'credit' = 任一白条；分类 'none' = 未分类 */
export interface LedgerFilter {
  type: string
  accountId: string
  parentId: string
}

export const NO_FILTER: LedgerFilter = { type: 'all', accountId: 'all', parentId: 'all' }

export function isFiltered(f: LedgerFilter): boolean {
  return f.type !== 'all' || f.accountId !== 'all' || f.parentId !== 'all'
}

/**
 * @param rootOf 二级分类 id → 一级 id；一级返回自己；查不到返回 undefined
 * @param creditIds 白条账户 id；accountId 为 CREDIT_ALL 时，任一边碰到白条就算
 */
export function matchesFilter(t: Transaction, f: LedgerFilter, rootOf: (catId: string) => string | undefined, creditIds: ReadonlySet<string> = new Set()): boolean {
  if (f.type !== 'all' && t.type !== f.type) return false
  if (f.accountId === 'none') {
    if (t.account_id) return false
  } else if (f.accountId === CREDIT_ALL) {
    if (!(t.account_id && creditIds.has(t.account_id)) && !(t.to_account_id && creditIds.has(t.to_account_id))) return false
  } else if (f.accountId !== 'all' && t.account_id !== f.accountId && t.to_account_id !== f.accountId) return false
  if (f.parentId === 'none') {
    // 「未分类」只指该有分类却没有的收支；转账和校准本来就没有分类，不算
    if (!isFlow(t) || t.category_id) return false
  } else if (f.parentId !== 'all') {
    if (!t.category_id) return false
    if (rootOf(t.category_id) !== f.parentId) return false
  }
  return true
}
