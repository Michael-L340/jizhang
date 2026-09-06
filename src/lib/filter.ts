import type { Transaction } from '../types'
import { isFlow } from './compute'

/** 账户筛选里的「白条」：四个平台一起筛 */
export const CREDIT_ALL = 'credit'

/**
 * 二级分类筛选里的「未细分」：直接记在一级上、没选二级的那几笔。
 * 统计页的 byCategory 把它们放进 `${一级id}:none` 这个桶，跳过来时只传后半截。
 */
export const CHILD_NONE = 'none'

/**
 * 流水页筛选。'all' 不限；账户 'none' = 未指定账户、'credit' = 任一白条；
 * 分类 'none' = 未分类；childId 只在选了具体一级分类时才生效。
 */
export interface LedgerFilter {
  type: string
  accountId: string
  parentId: string
  childId: string
}

export const NO_FILTER: LedgerFilter = { type: 'all', accountId: 'all', parentId: 'all', childId: 'all' }

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
    // 「未分类」只指该有分类却没有的收支；转账和校准本来就没有分类，不算。
    // 分类 id 查不到（孤儿记录）也算未分类，和统计页饼图的「未分类」块保持同一批记录。
    if (!isFlow(t)) return false
    if (t.category_id && rootOf(t.category_id)) return false
  } else if (f.parentId !== 'all') {
    if (!t.category_id) return false
    if (rootOf(t.category_id) !== f.parentId) return false
    // childId 可能来自旧版本存下的筛选条件（那时没这个字段），当成不限处理
    if (f.childId && f.childId !== 'all') {
      const want = f.childId === CHILD_NONE ? f.parentId : f.childId
      if (t.category_id !== want) return false
    }
  }
  return true
}
