// 所有余额与统计的纯函数。不依赖任何其他模块（date.ts 除外），方便单测。
import type { Account, Category, Transaction, TxType } from '../types'
import { addDays, lastMonths, monthOf, monthRange, shiftMonth, today } from './date'

/** 收支统计只看这两种类型；transfer / adjust 永远不进收支 */
export function isFlow(t: Transaction): t is Transaction & { type: 'expense' | 'income' } {
  return t.type === 'expense' || t.type === 'income'
}

export function inMonth(t: Transaction, ym: string): boolean {
  return monthOf(t.date) === ym
}

/** 每个账户的当前余额（分） */
/** 把一笔流水累加进余额表。未指定账户的流水计入收支统计，但不影响任何账户余额。 */
export function applyTx(t: Transaction, out: Record<string, number>): void {
  if (!t.account_id) return
  switch (t.type) {
    case 'income':
    case 'adjust':
      out[t.account_id] = (out[t.account_id] ?? 0) + t.amount
      break
    case 'expense':
      out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
      break
    case 'transfer':
      out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
      if (t.to_account_id) out[t.to_account_id] = (out[t.to_account_id] ?? 0) + t.amount
      break
  }
}

export function balances(txs: Transaction[], accounts: Account[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of accounts) out[a.id] = 0
  for (const t of txs) applyTx(t, out)
  return out
}

export function totalOf(b: Record<string, number>): number {
  return Object.values(b).reduce((s, v) => s + v, 0)
}

export interface MonthSummary {
  income: number
  expense: number
  net: number
  /** 储蓄率 0-1；收入为 0 时 null */
  savingRate: number | null
}

export function monthSummary(txs: Transaction[], ym: string): MonthSummary {
  let income = 0
  let expense = 0
  for (const t of txs) {
    if (!isFlow(t) || !inMonth(t, ym)) continue
    if (t.type === 'income') income += t.amount
    else expense += t.amount
  }
  const net = income - expense
  return { income, expense, net, savingRate: income > 0 ? net / income : null }
}

export interface CatAgg {
  id: string
  name: string
  icon: string | null
  amount: number
  count: number
  children: { id: string; name: string; amount: number; count: number }[]
}

/** 某月某类型按一级分类汇总（二级挂在 children），按金额降序 */
export function byCategory(
  txs: Transaction[],
  cats: Category[],
  ym: string,
  type: 'expense' | 'income',
): CatAgg[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const agg = new Map<string, CatAgg>()
  const ensure = (parent: Category): CatAgg => {
    let a = agg.get(parent.id)
    if (!a) {
      a = { id: parent.id, name: parent.name, icon: parent.icon, amount: 0, count: 0, children: [] }
      agg.set(parent.id, a)
    }
    return a
  }
  for (const t of txs) {
    if (t.type !== type || !inMonth(t, ym) || !t.category_id) continue
    const c = byId.get(t.category_id)
    if (!c) continue
    const parent = c.parent_id ? byId.get(c.parent_id) ?? c : c
    const a = ensure(parent)
    a.amount += t.amount
    a.count += 1
    // 直接记在一级上（没选二级）的，归入「未细分」，否则下钻时会漏掉这部分钱
    const childId = c.id !== parent.id ? c.id : `${parent.id}:none`
    const childName = c.id !== parent.id ? c.name : '未细分'
    let ch = a.children.find((x) => x.id === childId)
    if (!ch) {
      ch = { id: childId, name: childName, amount: 0, count: 0 }
      a.children.push(ch)
    }
    ch.amount += t.amount
    ch.count += 1
  }
  const list = [...agg.values()]
  for (const a of list) a.children.sort((x, y) => y.amount - x.amount)
  return list.sort((x, y) => y.amount - x.amount)
}

/** 某月每天的累计支出，返回长度 = 当月天数（未来的日子为 null） */
export function dailyCumulative(txs: Transaction[], ym: string, ref: string = today()): (number | null)[] {
  const { start, end } = monthRange(ym)
  const perDay = new Map<string, number>()
  for (const t of txs) {
    if (t.type !== 'expense' || !inMonth(t, ym)) continue
    perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amount)
  }
  const out: (number | null)[] = []
  let cum = 0
  for (let d = start; d <= end; d = addDays(d, 1)) {
    if (d > ref) {
      out.push(null)
      continue
    }
    cum += perDay.get(d) ?? 0
    out.push(cum)
  }
  return out
}

export type Unit = 'day' | 'month'

/** 生成时间桶：day 用 YYYY-MM-DD，month 用 YYYY-MM */
export function bucketKeys(start: string, end: string, unit: Unit): string[] {
  const out: string[] = []
  if (unit === 'day') {
    if (start > end) return [end]
    for (let d = start; d <= end; d = addDays(d, 1)) out.push(d)
  } else {
    const s0 = monthOf(start)
    const e0 = monthOf(end)
    if (s0 > e0) return [e0]
    for (let m = s0; m <= e0; m = shiftMonth(m, 1)) out.push(m)
  }
  return out
}

function keyOf(t: Transaction, unit: Unit): string {
  return unit === 'day' ? t.date : monthOf(t.date)
}

/** 每个时间桶的收入或支出合计 */
export function seriesTotals(txs: Transaction[], keys: string[], unit: Unit, type: 'expense' | 'income' = 'expense'): number[] {
  const idx = new Map(keys.map((k, i) => [k, i]))
  const out = new Array(keys.length).fill(0)
  for (const t of txs) {
    if (t.type !== type) continue
    const at = idx.get(keyOf(t, unit))
    if (at === undefined) continue
    out[at] += t.amount
  }
  return out
}

/** 每个时间桶、按一级分类拆分的合计；只返回区间内有金额的分类，按总额降序 */
export function seriesByCategory(
  txs: Transaction[],
  cats: Category[],
  keys: string[],
  unit: Unit,
  type: 'expense' | 'income' = 'expense',
): { id: string; name: string; total: number; data: number[] }[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const idx = new Map(keys.map((k, i) => [k, i]))
  const acc = new Map<string, { name: string; data: number[]; total: number }>()
  for (const t of txs) {
    if (t.type !== type || !t.category_id) continue
    const at = idx.get(keyOf(t, unit))
    if (at === undefined) continue
    const c = byId.get(t.category_id)
    if (!c) continue
    const root = c.parent_id ? byId.get(c.parent_id) ?? c : c
    let e = acc.get(root.id)
    if (!e) {
      e = { name: root.name, data: new Array(keys.length).fill(0), total: 0 }
      acc.set(root.id, e)
    }
    e.data[at] += t.amount
    e.total += t.amount
  }
  return [...acc.entries()]
    .map(([id, e]) => ({ id, name: e.name, total: e.total, data: e.data }))
    .sort((a, b) => b.total - a.total)
}

/** 最早一笔收支的日期，没有记录时返回今天 */
export function firstFlowDate(txs: Transaction[], ref: string = today()): string {
  let min: string | null = null
  for (const t of txs) if (isFlow(t) && (!min || t.date < min)) min = t.date
  return min ?? ref
}

/** 每个月的收入/支出合计，供月份选择器显示 */
export function monthTotals(txs: Transaction[]): Map<string, { expense: number; income: number }> {
  const m = new Map<string, { expense: number; income: number }>()
  for (const t of txs) {
    if (!isFlow(t)) continue
    const ym = monthOf(t.date)
    let e = m.get(ym)
    if (!e) {
      e = { expense: 0, income: 0 }
      m.set(ym, e)
    }
    if (t.type === 'expense') e.expense += t.amount
    else e.income += t.amount
  }
  return m
}

/** 有收支记录的月份，升序 */
export function monthsWithFlow(txs: Transaction[]): string[] {
  const set = new Set<string>()
  for (const t of txs) if (isFlow(t)) set.add(monthOf(t.date))
  return [...set].sort()
}

/** 最近 n 个月的收入/支出序列（含空月） */
export function monthlySeries(txs: Transaction[], endYm: string, n = 12): { ym: string; income: number; expense: number }[] {
  const months = lastMonths(n, endYm)
  const map = new Map(months.map((ym) => [ym, { ym, income: 0, expense: 0 }]))
  for (const t of txs) {
    if (!isFlow(t)) continue
    const row = map.get(monthOf(t.date))
    if (!row) continue
    if (t.type === 'income') row.income += t.amount
    else row.expense += t.amount
  }
  return months.map((ym) => map.get(ym)!)
}

/** 时间桶的结束日期：按日就是当天，按月是当月最后一天 */
export function bucketEnd(key: string, unit: Unit): string {
  return unit === 'day' ? key : monthRange(key).end
}

/** 每个时间桶结束时的各账户余额与总额（从有记录以来累计，不受区间起点影响） */
export function balanceSeries(
  txs: Transaction[],
  accounts: Account[],
  keys: string[],
  unit: Unit,
): { total: number[]; byAccount: Record<string, number[]> } {
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const running: Record<string, number> = {}
  const byAccount: Record<string, number[]> = {}
  for (const a of accounts) {
    running[a.id] = 0
    byAccount[a.id] = []
  }
  const total: number[] = []
  let i = 0
  for (const k of keys) {
    const end = bucketEnd(k, unit)
    while (i < sorted.length && sorted[i].date <= end) {
      applyTx(sorted[i], running)
      i++
    }
    for (const a of accounts) byAccount[a.id].push(running[a.id] ?? 0)
    total.push(totalOf(running))
  }
  return { total, byAccount }
}

/** 某个一级分类下的二级，按最近使用倒序，从未用过的按 sort */
export function recentChildOrder(txs: Transaction[], cats: Category[], parentId: string): Category[] {
  const children = cats.filter((c) => c.parent_id === parentId && !c.is_archived)
  const lastUse = new Map<string, string>()
  for (const t of txs) {
    if (!t.category_id) continue
    const prev = lastUse.get(t.category_id)
    const key = `${t.date}T${t.created_at}`
    if (!prev || key > prev) lastUse.set(t.category_id, key)
  }
  return children.sort((a, b) => {
    const ua = lastUse.get(a.id)
    const ub = lastUse.get(b.id)
    if (ua && ub) return ua < ub ? 1 : -1
    if (ua) return -1
    if (ub) return 1
    return a.sort - b.sort
  })
}

/** 账户最近一次核对/校准的时间（ISO），没有则 null */
export function lastCheck(txs: Transaction[], accountId: string): string | null {
  let best: string | null = null
  for (const t of txs) {
    if (t.type === 'adjust' && t.account_id === accountId && (!best || t.created_at > best)) best = t.created_at
  }
  return best
}

/** 流水按日期分组（降序），附每日收支小计 */
export function groupByDay(txs: Transaction[]): { date: string; items: Transaction[]; expense: number; income: number }[] {
  const map = new Map<string, Transaction[]>()
  for (const t of txs) {
    const arr = map.get(t.date)
    if (arr) arr.push(t)
    else map.set(t.date, [t])
  }
  const days = [...map.keys()].sort().reverse()
  return days.map((date) => {
    const items = map.get(date)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    let expense = 0
    let income = 0
    for (const t of items) {
      if (t.type === 'expense') expense += t.amount
      if (t.type === 'income') income += t.amount
    }
    return { date, items, expense, income }
  })
}

/** 排序：日期降序，同日按创建时间降序 */
export function sortTxs(txs: Transaction[]): Transaction[] {
  return [...txs].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1
    return a.created_at < b.created_at ? 1 : -1
  })
}

export function typeSign(type: TxType): 1 | -1 | 0 {
  if (type === 'income') return 1
  if (type === 'expense') return -1
  return 0
}
