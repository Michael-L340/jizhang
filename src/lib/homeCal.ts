// 首页最下面的「日历」卡（用户 2026-11-25 看效果图定的，代替原来的「最近流水」）。
// 日 / 月 / 年三档：日 = 一个月的每一天，月 = 一年的 12 个月，年 = 每一年。格子里收入（绿，+）写在上面、支出（红，-）写在下面，
// 两行一起在格子里上下居中；不画底色深浅（用户：「淡红色底太丑了，也不匹配」）。
// 纯函数，页面只管渲染。吃的是当前模式那本账（首页的 otxs = facade.outerBook），所以里外页面各算各的。
import { isFlow, netFlow } from './compute'
import { monthOf } from './date'
import type { Transaction } from '../types'

export type CalLevel = 'day' | 'month' | 'year'

export interface CalCell {
  /** 支出合计（分，统计口径：抵消的退款已经扣掉，可能是负的） */
  expense: number
  /** 收入合计（分） */
  income: number
  /** 收支笔数（转账、校准不算） */
  count: number
}

/**
 * 按 keyOf 把收支加起来。口径和统计页一样：转账、校准不算（compute.isFlow），抵消的那笔换成另一边的负数（compute.netFlow）——
 * 首页的 otxs 已经是 netBook 换过的，再过一遍 netFlow 不会重复换（换过的 amount 是负的，netFlow 原样返回）。
 */
function tally(txs: readonly Transaction[], keyOf: (t: Transaction) => string | null): Map<string, CalCell> {
  const m = new Map<string, CalCell>()
  for (const raw of txs) {
    const t = netFlow(raw)
    if (!isFlow(t)) continue
    const k = keyOf(t)
    if (k === null) continue
    let c = m.get(k)
    if (!c) {
      c = { expense: 0, income: 0, count: 0 }
      m.set(k, c)
    }
    if (t.type === 'expense') c.expense += t.amount
    else c.income += t.amount
    c.count++
  }
  return m
}

/** 「日」档：ym 这个月每一天（键是 YYYY-MM-DD） */
export function dayCells(txs: readonly Transaction[], ym: string): Map<string, CalCell> {
  return tally(txs, (t) => (monthOf(t.date) === ym ? t.date : null))
}

/** 「月」档：year 这一年每个月（键是 YYYY-MM） */
export function monthCells(txs: readonly Transaction[], year: string): Map<string, CalCell> {
  return tally(txs, (t) => (t.date.slice(0, 4) === year ? monthOf(t.date) : null))
}

/** 「年」档：每一年（键是 YYYY） */
export function yearCells(txs: readonly Transaction[]): Map<string, CalCell> {
  return tally(txs, (t) => t.date.slice(0, 4))
}

/** 「年」档列哪几年：有记录的最早那年到今年，中间空着的年份也列（不然一排年份跳着走） */
export function calYears(txs: readonly Transaction[], todayYmd: string): string[] {
  const now = Number(todayYmd.slice(0, 4))
  let first = now
  for (const t of txs) {
    if (!isFlow(t)) continue
    const y = Number(t.date.slice(0, 4))
    if (y < first) first = y
  }
  const out: string[] = []
  for (let y = first; y <= now; y++) out.push(String(y))
  return out
}

/** 一周从周一排：ym 的 1 号前面要空几格（周一 0 … 周日 6） */
export function weekLead(ym: string): number {
  const dow = new Date(`${ym}-01T00:00:00Z`).getUTCDay()
  return (dow + 6) % 7
}

/** ym 这个月有几天 */
export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 再点一下往哪走：年 → 那一年的各月，月 → 那个月的每天，日 → 流水页那一天 */
export function drillOf(level: CalLevel, key: string): { level: CalLevel; anchor: string } | { ledger: string } {
  if (level === 'year') return { level: 'month', anchor: key }
  if (level === 'month') return { level: 'day', anchor: key }
  return { ledger: `/ledger?date=${key}` }
}
