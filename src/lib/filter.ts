import type { Transaction } from '../types'
import { isFlow } from './compute'
import type { Mode } from './facade'
import type { SearchNames } from './search'

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
  /** 只看打了「外面隐藏」记号的记录。只在里页面有意义；旧版本存下的筛选条件没有这个字段，当 false */
  hiddenOnly?: boolean
}

export const NO_FILTER: LedgerFilter = { type: 'all', accountId: 'all', parentId: 'all', childId: 'all', hiddenOnly: false }

/**
 * 当前模式下真正生效的筛选。**外页面一律当「只看隐藏的」没开**：
 * 筛选条件会记住两小时，用户在里页面开着它、60 秒后 App 自动退回外页面，
 * 要是条件跟过去，外页面就是一个空列表加一个亮着的「已筛选」标签——等于告诉别人有东西被筛掉了。
 * 里页面原样返回同一个对象。
 */
export function effectiveFilter(f: LedgerFilter, mode: Mode): LedgerFilter {
  if (mode === 'inner' || !f.hiddenOnly) return f
  return { ...f, hiddenOnly: false }
}

const TYPE_LABEL: Record<string, string> = { expense: '支出', income: '收入', transfer: '转账', adjust: '校准' }

/**
 * 把筛选条件写成人能读的几段，给流水页顶上的「已筛选：…」用。
 * 顺序固定：类型 · 账户 · 分类 · 藏起来的；没选的不写。
 * 用户 2026-09-18 在里页面开着「只看藏起来的」忘了，看到「已筛选 · 0 笔」以为记录丢了。
 * 传进来的要是 effectiveFilter 之后的条件——外页面那边「藏起来的」被当没开，这里自然也不会写出来。
 */
export function describeFilter(f: LedgerFilter, names: SearchNames): string[] {
  const out: string[] = []
  if (f.type !== 'all') out.push(TYPE_LABEL[f.type] ?? f.type)
  if (f.accountId === 'none') out.push('未指定账户')
  else if (f.accountId === CREDIT_ALL) out.push('白条')
  else if (f.accountId !== 'all') out.push(names.account(f.accountId) || '账户')
  if (f.parentId === 'none') out.push('未分类')
  else if (f.parentId !== 'all') {
    const parent = names.category(f.parentId) || '分类'
    if (f.childId && f.childId !== 'all') out.push(f.childId === CHILD_NONE ? `${parent} 未细分` : names.category(f.childId) || parent)
    else out.push(parent)
  }
  if (f.hiddenOnly) out.push('藏起来的')
  return out
}

export function isFiltered(f: LedgerFilter): boolean {
  return f.type !== 'all' || f.accountId !== 'all' || f.parentId !== 'all' || Boolean(f.hiddenOnly)
}

/**
 * @param rootOf 二级分类 id → 一级 id；一级返回自己；查不到返回 undefined
 * @param creditIds 白条账户 id；accountId 为 CREDIT_ALL 时，任一边碰到白条就算
 */
export function matchesFilter(t: Transaction, f: LedgerFilter, rootOf: (catId: string) => string | undefined, creditIds: ReadonlySet<string> = new Set()): boolean {
  if (f.type !== 'all' && t.type !== f.type) return false
  if (f.hiddenOnly && !t.hidden) return false
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
