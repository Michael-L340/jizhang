// 助手查账、分析用的数：全部在手机上用当前模式那本账算（首页的 otxs），AI 只拿结果说话。纯函数。
// 口径和统计页一样：只算收支（转账、校准不算），抵消过 netFlow（退款从那一类支出里扣）。
import { catMapOf, catPathOf } from './book'
import { normNote, oneoffSpends } from './oneoff'
import { isFlow, netFlow } from '../compute'
import { addDays, daysBetween } from '../date'
import type { Category, CatKind, Transaction } from '../../types'

export interface Query {
  kind: CatKind
  from: string
  to: string
  parentId: string | null
  childId: string | null
  keyword: string | null
}

export interface Part {
  id: string
  name: string
  total: number
  count: number
}

export interface Facts {
  q: Query
  /** 合计（分，净额：退款已扣） */
  total: number
  count: number
  /** 天数（含两头；到今天为止） */
  days: number
  dailyAvg: number
  /** 没限定一级时按一级拆；限定了一级就按它的二级拆（「不细分」= 直接记在一级上的） */
  parts: (Part & { sharePct: number })[]
  top2SharePct: number
  top3SharePct: number
  /** 金额最大的几笔（原始记录，正向的） */
  top: Transaction[]
  prev: { from: string; to: string; total: number }
  /** 只在看支出、没限定一级时给 */
  oneoff: { total: number; count: number; items: Transaction[] } | null
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0)

/** 上一段同样长的时间：同一个月里的一段比上个月同样的几号；其余往前挪同样天数 */
export function prevRange(from: string, to: string): { from: string; to: string } {
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const back = (d: string) => {
      const [y, m, day] = d.split('-').map(Number)
      const last = new Date(Date.UTC(y, m - 1, 0)).getUTCDate()
      const pm = new Date(Date.UTC(y, m - 2, 1))
      return `${pm.getUTCFullYear()}-${String(pm.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`
    }
    return { from: back(from), to: back(to) }
  }
  const n = daysBetween(from, to) + 1
  return { from: addDays(from, -n), to: addDays(from, -1) }
}

/** 这一笔（统计口径）在不在查询里 */
function matcher(q: Query, byId: ReadonlyMap<string, Category>) {
  const kw = q.keyword ? normNote(q.keyword) : ''
  return (t: Transaction): boolean => {
    if (!isFlow(t) || t.type !== q.kind || t.date < q.from || t.date > q.to) return false
    if (!q.parentId && !q.childId && !kw) return true
    const p = catPathOf(t, byId)
    if (q.parentId && p?.parent.id !== q.parentId) return false
    if (q.childId && p?.child?.id !== q.childId) return false
    if (kw && !(normNote(t.note).includes(kw) || (p?.child?.name ?? '').includes(kw) || (p?.parent.name ?? '').includes(kw))) return false
    return true
  }
}

export function factsOf(txs: readonly Transaction[], cats: readonly Category[], q: Query, todayYmd: string): Facts {
  const byId = catMapOf(cats)
  const flows = txs.map(netFlow)
  const hit = matcher(q, byId)
  const cur = flows.filter(hit)
  const total = cur.reduce((s, t) => s + t.amount, 0)
  const end = q.to < todayYmd ? q.to : todayYmd
  const days = Math.max(1, daysBetween(q.from, end) + 1)
  const parts = new Map<string, Part>()
  for (const t of cur) {
    const p = catPathOf(t, byId)
    const key = q.parentId ? p?.child?.id ?? 'none' : p?.parent.id ?? 'none'
    const name = q.parentId ? p?.child?.name ?? '不细分' : p?.parent.name ?? '未分类'
    const x = parts.get(key) ?? { id: key, name, total: 0, count: 0 }
    x.total += t.amount
    x.count++
    parts.set(key, x)
  }
  const sorted = [...parts.values()].filter((p) => p.total > 0).sort((a, b) => b.total - a.total)
  const top2 = sorted.slice(0, 2).reduce((s, p) => s + p.total, 0)
  const top3 = sorted.slice(0, 3).reduce((s, p) => s + p.total, 0)
  // 「最大的几笔」用原始记录（退款那笔换过之后是负的，不列）
  const top = txs.filter((t) => t.amount > 0 && hit(netFlow(t)) && netFlow(t).amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 8)
  const pr = prevRange(q.from, q.to)
  const prevTotal = flows.filter(matcher({ ...q, ...pr }, byId)).reduce((s, t) => s + t.amount, 0)
  let oneoff: Facts['oneoff'] = null
  if (q.kind === 'expense' && !q.parentId && !q.childId && !q.keyword) {
    const items = oneoffSpends(txs, cats, q.from, q.to)
    oneoff = { total: items.reduce((s, t) => s + t.amount, 0), count: items.length, items }
  }
  return {
    q,
    total,
    count: cur.length,
    days,
    dailyAvg: Math.round(total / days),
    parts: sorted.map((p) => ({ ...p, sharePct: pct(p.total, total) })),
    top2SharePct: pct(top2, total),
    top3SharePct: pct(top3, total),
    top,
    prev: { ...pr, total: prevTotal },
    oneoff,
  }
}

/** 每天一个数（走势小柱子用）。超过 62 天不画（柱子太细） */
export function dailySeries(txs: readonly Transaction[], cats: readonly Category[], q: Query, todayYmd: string): { date: string; total: number }[] | null {
  const end = q.to < todayYmd ? q.to : todayYmd
  const n = daysBetween(q.from, end) + 1
  if (n < 2 || n > 62) return null
  const hit = matcher(q, catMapOf(cats))
  const sums = new Map<string, number>()
  for (const raw of txs) {
    const t = netFlow(raw)
    if (hit(t)) sums.set(t.date, (sums.get(t.date) ?? 0) + t.amount)
  }
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(q.from, i)
    return { date, total: sums.get(date) ?? 0 }
  })
}

/**
 * 「在流水里看」跳到哪：日期范围 + 分类（流水页 filterFromQuery 认 from / to / type / cat / sub）。
 * 限定了分类时不带 type：退款那笔原始类型是收入、分类却是支出那边的，带了 type=expense 就被筛掉了。
 */
export function ledgerLinkOf(q: Query): string {
  const p = new URLSearchParams({ from: q.from, to: q.to })
  if (q.parentId) {
    p.set('cat', q.parentId)
    if (q.childId) p.set('sub', q.childId)
  } else {
    p.set('type', q.kind)
    p.set('cat', 'all')
  }
  return `/ledger?${p.toString()}`
}
