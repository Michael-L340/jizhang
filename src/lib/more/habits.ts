// 进阶统计 ·「记账习惯」：不画图，只有三个小数字。
import { isFlow } from '../compute'
import { addDays, daysBetween, monthOf, monthRange } from '../date'
import type { Transaction } from '../../types'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput } from './types'

/**
 * 「记过账」的记录：收入、支出、转账。**校准不算**——校准是核对余额，不是记一笔账；
 * 而且外页面那本账里混着外页面校准记录（facade_adjusts 换成的 adjust），外页面流水从来不列它们。
 * 算进来的话，外页面上会出现「那天流水是空的，连续天数却照样算上了」，里外两边的天数也对不上。
 */
const isRecord = (t: Transaction) => t.type !== 'adjust'

/**
 * 连续记账几天：从今天往前数，每天至少记了一笔收入、支出或转账（校准不算，理由见 isRecord）。
 * 今天还没记的话从昨天开始数——早上打开看到「连续 0 天」会以为断了，其实今天还没过完。
 * 记在未来日期上的（提前录的）不影响：只从今天往回走，碰不到它们。
 */
export function streakDays(txs: Transaction[], today: string): number {
  const days = new Set<string>()
  for (const t of txs) if (isRecord(t)) days.add(t.date)
  let d = days.has(today) ? today : addDays(today, -1)
  let n = 0
  while (days.has(d)) {
    n++
    d = addDays(d, -1)
  }
  return n
}

/**
 * 平均每天几笔：范围内 收入 + 支出 的笔数 ÷ 天数（含两端）。转账和校准不算。
 * 范围的尾巴超过今天的截到今天：还没到的日子不能拿来摊薄。整个范围都在未来就返回 null。
 */
export function perDay(txs: Transaction[], start: string, end: string, today: string): number | null {
  const last = end > today ? today : end
  const days = daysBetween(start, last) + 1
  if (days <= 0) return null
  let n = 0
  for (const t of txs) if (isFlow(t) && t.date >= start && t.date <= last) n++
  return n / days
}

/**
 * 某月零支出的天数：「这个月 1 号和开始记账那天取晚的」到「月底和今天取早的」之间，一笔支出都没有的天数。
 * 开始记账 = 第一笔收入 / 支出 / 转账的日子（校准不算，同 isRecord）：9/20 才开始用 App，
 * 9/1–9/19 不是「没花钱」，是还没记——算进来卡片上就是「本月零支出 26 天」。
 * of = 算了几天；整段都在未来、或者这个月还没开始记账时 of = 0。
 */
export function zeroSpendDays(txs: Transaction[], ym: string, today: string): { days: number; of: number } {
  const { start: monthStart, end } = monthRange(ym)
  let first: string | null = null
  for (const t of txs) if (isRecord(t) && (first === null || t.date < first)) first = t.date
  const start = first !== null && first > monthStart ? first : monthStart
  const last = end > today ? today : end
  if (first === null || last < start) return { days: 0, of: 0 }
  const spent = new Set<string>()
  for (const t of txs) if (t.type === 'expense' && t.amount > 0 && t.date >= start && t.date <= last) spent.add(t.date)
  const of = daysBetween(start, last) + 1
  return { days: of - spent.size, of }
}

export function habits(input: MoreInput): MoreChart {
  const { txs, start, end, ym, today } = input
  const streak = streakDays(txs, today)
  const avg = perDay(txs, start, end, today)
  const zero = zeroSpendDays(txs, ym, today)
  // 选的不是本月时别写「本月」：看 8 月的时候写「本月零支出」是在说 8 月还是 9 月？
  const zeroLabel = ym === monthOf(today) ? '本月零支出' : `${Number(ym.slice(5))}月零支出`
  return {
    key: 'habits',
    title: '记账习惯',
    // 标题旁写的是「平均每天」那段时间；连续记账永远数到今天、零支出的月份写在它自己的格子上
    span: rangeSpan(start, end, today),
    note: '连续记账：从今天往前数、每天至少记了一笔收入、支出或转账（校准不算；今天还没记就从昨天数）。平均每天：这段时间收入和支出的笔数 ÷ 天数，算到今天。零支出：这个月开始记账以后、到今天为止一笔支出都没有的天数。',
    option: null,
    tiles: [
      { label: '连续记账', value: `${streak} 天` },
      { label: '平均每天', value: avg === null ? '—' : `${avg.toFixed(1)} 笔` },
      { label: zeroLabel, value: zero.of === 0 ? '—' : `${zero.days} 天` },
    ],
  }
}
