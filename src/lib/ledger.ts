// 流水页「看哪一段」的纯逻辑：默认看全部、按月分节、一次先画多少天。页面里只留渲染。
//
// 用户 2026-10-01：「常态应该是显示全部的流水，我可以下滑一直翻的。只有需要选定的时候才会看特定的月份」。
// 以前打开就是本月，要看上个月得点箭头翻。
import type { groupByDay } from './compute'
import { monthOf } from './date'

/** 月份选择器里的「全部月份」；流水页 ym 的默认值 */
export const ALL_MONTHS = 'all'

export type DayGroup = ReturnType<typeof groupByDay>[number]

export interface MonthSection {
  ym: string
  /** 这个月（列表里看得到的那些天）的支出、收入，分。和每天小计同一个口径：跟着筛选走 */
  expense: number
  income: number
  days: DayGroup[]
}

/**
 * 按天分好组（新的在前）的流水再按月分节，每节开头一条月份标题。
 * 等式：各节的支出之和 = 各天的支出之和（收入同理），ledger.test.ts 拿随机账本守着。
 */
export function monthSections(days: DayGroup[]): MonthSection[] {
  const out: MonthSection[] = []
  for (const d of days) {
    const ym = monthOf(d.date)
    let s = out[out.length - 1]
    if (!s || s.ym !== ym) {
      s = { ym, expense: 0, income: 0, days: [] }
      out.push(s)
    }
    s.days.push(d)
    s.expense += d.expense
    s.income += d.income
  }
  return out
}

/**
 * 从别的页跳进来该看哪一段：带 ym 的（统计页、进阶分析，看的是那个月的数）→ 那个月；
 * 只带 date 的（首页「今日开支」）→ 全部，定位到那一天。什么都没带 → null（保持原样）。
 */
export function ymFromQuery(qYm: string | null, qDate: string | null): string | null {
  if (qYm) return qYm
  return qDate ? ALL_MONTHS : null
}

/** 全部模式一次先画多少天，翻到底再接着画这么多：一年上千笔一次全画出来，手机上第一下会卡 */
export const PAGE_DAYS = 40

/** 这一轮画前多少天：至少 limit；要定位的那天必须画出来，再往后多画几天，让它能滚到顶上 */
export function daysToShow(days: DayGroup[], limit: number, target: string | null): number {
  let n = Math.min(days.length, limit)
  if (target) {
    const i = days.findIndex((d) => d.date === target)
    if (i >= n) n = Math.min(days.length, i + 11)
  }
  return n
}
