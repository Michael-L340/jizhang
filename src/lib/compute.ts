// 所有余额与统计的纯函数。不依赖任何其他模块（date.ts 除外），方便单测。
import type { Account, Category, Transaction, TxType } from '../types'
import { addDays, lastMonths, monthOf, monthRange, today } from './date'

/** 收支统计只看这两种类型；transfer / adjust 永远不进收支 */
export function isFlow(t: Transaction): t is Transaction & { type: 'expense' | 'income' } {
  return t.type === 'expense' || t.type === 'income'
}

export function inMonth(t: Transaction, ym: string): boolean {
  return monthOf(t.date) === ym
}

/** 每个账户的当前余额（分） */
export function balances(txs: Transaction[], accounts: Account[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of accounts) out[a.id] = 0
  for (const t of txs) {
    // 未指定账户的流水计入收支统计，但不影响任何账户余额
    if (!t.account_id) continue
    switch (t.type) {
      case 'income':
        out[t.account_id] = (out[t.account_id] ?? 0) + t.amount
        break
      case 'expense':
        out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
        break
      case 'adjust':
        out[t.account_id] = (out[t.account_id] ?? 0) + t.amount
        break
      case 'transfer':
        out[t.account_id] = (out[t.account_id] ?? 0) - t.amount
        if (t.to_account_id) out[t.to_account_id] = (out[t.to_account_id] ?? 0) + t.amount
        break
    }
  }
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
    if (c.id !== parent.id) {
      let ch = a.children.find((x) => x.id === c.id)
      if (!ch) {
        ch = { id: c.id, name: c.name, amount: 0, count: 0 }
        a.children.push(ch)
      }
      ch.amount += t.amount
      ch.count += 1
    }
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

/** 某月每天的累计支出，按一级分类分组；只返回本月有金额的分类 */
export function dailyCumulativeByCategory(
  txs: Transaction[],
  cats: Category[],
  ym: string,
  type: 'expense' | 'income' = 'expense',
  ref: string = today(),
): { id: string; name: string; total: number; data: (number | null)[] }[] {
  const byId = new Map(cats.map((c) => [c.id, c]))
  const { start, end } = monthRange(ym)
  const perCat = new Map<string, { name: string; sort: number; perDay: Map<string, number>; total: number }>()
  for (const t of txs) {
    if (t.type !== type || !inMonth(t, ym) || !t.category_id) continue
    const c = byId.get(t.category_id)
    if (!c) continue
    const root = c.parent_id ? byId.get(c.parent_id) ?? c : c
    let e = perCat.get(root.id)
    if (!e) {
      e = { name: root.name, sort: root.sort, perDay: new Map(), total: 0 }
      perCat.set(root.id, e)
    }
    e.perDay.set(t.date, (e.perDay.get(t.date) ?? 0) + t.amount)
    e.total += t.amount
  }
  const out: { id: string; name: string; total: number; data: (number | null)[] }[] = []
  for (const [id, e] of perCat) {
    const data: (number | null)[] = []
    let cum = 0
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (d > ref) {
        data.push(null)
        continue
      }
      cum += e.perDay.get(d) ?? 0
      data.push(cum)
    }
    out.push({ id, name: e.name, total: e.total, data })
  }
  return out.sort((a, b) => b.total - a.total)
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

/** 最近 days 天，每天收盘时各账户余额（含总额） */
export function balanceHistory(
  txs: Transaction[],
  accounts: Account[],
  days = 90,
  ref: string = today(),
): { dates: string[]; series: Record<string, number[]>; total: number[] } {
  const startDay = addDays(ref, -(days - 1))
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  // 起点：startDay 之前的全部流水
  const before = sorted.filter((t) => t.date < startDay)
  const running = balances(before, accounts)
  let i = before.length
  const dates: string[] = []
  const series: Record<string, number[]> = {}
  for (const a of accounts) series[a.id] = []
  const total: number[] = []
  for (let d = startDay; d <= ref; d = addDays(d, 1)) {
    while (i < sorted.length && sorted[i].date <= d) {
      const delta = balances([sorted[i]], accounts)
      for (const k of Object.keys(delta)) running[k] = (running[k] ?? 0) + delta[k]
      i++
    }
    dates.push(d)
    for (const a of accounts) series[a.id].push(running[a.id] ?? 0)
    total.push(totalOf(running))
  }
  return { dates, series, total }
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

/** 校准差额合计（可按月），正数 = 有漏记收入，负数 = 有漏记支出 */
export function adjustTotal(txs: Transaction[], ym?: string): number {
  let s = 0
  for (const t of txs) if (t.type === 'adjust' && (!ym || inMonth(t, ym))) s += t.amount
  return s
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
