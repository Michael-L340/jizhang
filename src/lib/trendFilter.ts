// 统计页趋势图的两个开关（用户 2026-10-09 定的，「甲 + 丙」，金额自己填）：
//   不看大额单笔：超过门槛的单笔不算进当天 / 当月（那天剩下的小钱照画，合计也跟着少）。
//   封顶：纵轴最高画到门槛，超过的那几个点画成一个小尖、顶上标真实数字——数据一笔不改。
// 纯函数，不碰 store；页面只管把状态存在 jz_stats_trendFilter。
import type { Transaction } from '../types'

export interface TrendFilter {
  big: boolean
  /** 元，整数 */
  bigYuan: number
  cap: boolean
  /** 元，整数 */
  capYuan: number
}

export const DEFAULT_TREND_FILTER: TrendFilter = { big: false, bigYuan: 500, cap: false, capYuan: 1000 }

/** 旧版本存的、或手改坏的值，补成默认；金额只收正整数 */
export function normalizeTrendFilter(v: unknown): TrendFilter {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<TrendFilter>
  const yuan = (n: unknown, d: number) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : d)
  return { big: o.big === true, bigYuan: yuan(o.bigYuan, DEFAULT_TREND_FILTER.bigYuan), cap: o.cap === true, capYuan: yuan(o.capYuan, DEFAULT_TREND_FILTER.capYuan) }
}

/**
 * 去掉金额 ≥ cents 的那几笔（只看 kind 这一边、只看正数——「抵消」换过来的负数不是一笔开销）。
 * cents ≤ 0 = 不开，原样返回同一个数组。
 */
export function dropBig(txs: Transaction[], kind: 'expense' | 'income', cents: number): { txs: Transaction[]; count: number; sum: number } {
  if (cents <= 0) return { txs, count: 0, sum: 0 }
  let count = 0
  let sum = 0
  const kept = txs.filter((t) => {
    if (t.type !== kind || t.amount < cents) return true
    count++
    sum += t.amount
    return false
  })
  return count ? { txs: kept, count, sum } : { txs, count: 0, sum: 0 }
}

/** 封顶后的点画在上限的几成处：留一点头，尖顶不贴着最上面那条网格线 */
export const CAP_PEAK = 0.93

/**
 * 封顶：值超过 cap 的点压到 cap × CAP_PEAK，纵轴上限定为 cap。
 * 没有点超过、或 cap ≤ 0 时什么都不做（max 为 undefined，让图表自己定量程）。
 * data 给图画、real 给提示框和尖顶上的数字。单位随传入的值（页面传的是元）。
 */
export function capSeries(values: number[], cap: number): { data: number[]; real: number[]; max: number | undefined; over: Set<number> } {
  const over = new Set<number>()
  if (cap > 0) values.forEach((v, i) => v > cap && over.add(i))
  if (!over.size) return { data: values, real: values, max: undefined, over }
  return { data: values.map((v, i) => (over.has(i) ? cap * CAP_PEAK : v)), real: values, max: cap, over }
}

/** 输入框里的元：只收正整数，别的一律当没填 */
export function parseYuanInt(s: string): number | null {
  const n = Number(s.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
