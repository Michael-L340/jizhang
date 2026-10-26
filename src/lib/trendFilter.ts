// 统计页趋势图的两个开关（用户 2026-10-09 定的，「甲 + 丙」，金额自己填）：
//   不看大额单笔：超过门槛的单笔不算进当天 / 当月（那天剩下的小钱照画，合计也跟着少）。
//   封顶：超过门槛的点画成顶到门槛那条线的小尖、顶上标真实数字——数据一笔不改。
//   两个开关合计 / 分类 / 堆叠三档都管（封顶 2026-10-26 前只管合计，用户：「封顶，在分类中，没有用」）。
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

/**
 * 封顶时被压的尖正好顶到门槛那条线，纵轴最高画到 门槛 ÷ CAP_PEAK：尖顶落在纵轴的九成多一点，不冲顶（用户「不冲顶」）。
 * 2026-10-26 前反过来：尖压到 门槛 × 0.93、纵轴最高 = 门槛，没超过门槛的普通一天（比如 761 对 800）反而画得比被压的尖还高。
 */
export const CAP_PEAK = 0.93

/** 1 / 2 / 2.5 / 5 × 10 的几次方 */
function isNiceStep(s: number): boolean {
  if (!(s > 0) || !Number.isFinite(s)) return false
  const f = s / 10 ** Math.floor(Math.log10(s))
  return [1, 2, 2.5, 5, 10].some((n) => Math.abs(f - n) < 1e-9)
}

/**
 * 封顶时的纵轴。最高刻度取整：带一长串小数的最大刻度就算不写字，也会被 containLabel 量进去、把左边的刻度栏撑宽；
 * 它也不写字（页面设 showMaxLabel: false）。刻度间隔尽量让门槛正好落在一条线上：在 1 / 2 / 2.5 / 5 × 10ⁿ 里
 * 找能把门槛分成 4、5、3、6、2 格的第一个，都不行（比如 999）就交给 ECharts 自己定。
 */
export function capAxis(cap: number): { max: number; interval: number | undefined } {
  const max = Math.round(cap / CAP_PEAK)
  for (const parts of [4, 5, 3, 6, 2]) if (isNiceStep(cap / parts)) return { max, interval: cap / parts }
  return { max, interval: undefined }
}

/**
 * 封顶：值超过 cap 的点压到 cap（图上是顶到门槛那条线的一个小尖），数据一笔不改。
 * 没有点超过、或 cap ≤ 0 时什么都不做（data 就是传进来的那个数组）。
 * data 给图画、real 给提示框和尖顶上的数字。单位随传入的值（页面传的是元）。
 */
export function capSeries(values: number[], cap: number): { data: number[]; real: number[]; over: Set<number> } {
  const over = new Set<number>()
  if (cap > 0) values.forEach((v, i) => v > cap && over.add(i))
  if (!over.size) return { data: values, real: values, over }
  return { data: values.map((v, i) => (over.has(i) ? cap : v)), real: values, over }
}

/**
 * 堆叠柱封顶：一根柱子的合计超过 cap，各段按同一个比例压到合计正好 = cap，各段占比不变；没超过的柱子原样。
 * series[j][i] = 第 j 类、第 i 根柱子。totals 是每根柱子真实的合计（尖顶数字用）。
 */
export function capStack(series: number[][], cap: number): { data: number[][]; totals: number[]; over: Set<number> } {
  const n = series[0]?.length ?? 0
  const totals = Array.from({ length: n }, (_, i) => series.reduce((t, s) => t + s[i], 0))
  const over = new Set<number>()
  if (cap > 0) totals.forEach((t, i) => t > cap && over.add(i))
  if (!over.size) return { data: series, totals, over }
  return { data: series.map((s) => s.map((v, i) => (over.has(i) ? (v * cap) / totals[i] : v))), totals, over }
}

/** 尖顶上的数字：整数元、不带 ¥ 和角分（和纵轴一个写法，宽度省一半），上万写「1.2万」（用户 2026-10-26：「▲¥1,035.37」和「▲¥1,336.40」挤成一团） */
export function peakText(yuan: number): string {
  return '▲' + (Math.abs(yuan) >= 10000 ? `${+(yuan / 10000).toFixed(1)}万` : String(Math.round(yuan)))
}

export interface Peak {
  /** 横轴第几个点 */
  i: number
  /** 真实数字（元） */
  real: number
  /** 哪条线的：同一天几条线都超了，靠它分开 */
  key: string
}
export interface PeakLabel extends Peak {
  text: string
  /** 0 = 紧挨着尖顶；1 = 往上错开一行 */
  row: 0 | 1
  align: 'left' | 'center' | 'right'
}
/** 错开一行往上挪多少像素（10px 的字） */
export const PEAK_ROW_PX = 12

/**
 * 尖顶数字怎么摆（用户 2026-10-26 看过原型：「还不错可以去做」）：
 * - 从左往右摆；同一天几条线都超了，大的先摆。
 * - 先试紧挨着尖顶那一行；和这一行上一个数字隔不到 4px 就试上面一行；两行都挤就不标，点那天在提示框里看。
 * - 以那一点为中心放不下（左边会压住纵轴的字、右边出图）就往里收：从那一点往右写 / 往左写。
 * xOf：第 i 个点的横坐标；plotL / plotR：绘图区左右边（trendGeometry）；measure：量 10px 的字宽（页面用 canvas，测试给假的）。
 */
export function layoutPeaks(peaks: Peak[], xOf: (i: number) => number, plotL: number, plotR: number, measure: (s: string) => number): PeakLabel[] {
  const GAP = 4
  const rowEnd = [-Infinity, -Infinity]
  const out: PeakLabel[] = []
  for (const p of [...peaks].sort((a, b) => a.i - b.i || b.real - a.real)) {
    const text = peakText(p.real)
    const w = measure(text)
    const x = xOf(p.i)
    let align: PeakLabel['align'] = 'center'
    let left = x - w / 2
    if (left < plotL) {
      align = 'left'
      left = x
    } else if (left + w > plotR) {
      align = 'right'
      left = x - w
    }
    const row = rowEnd.findIndex((end) => left >= end + GAP)
    if (row < 0) continue
    rowEnd[row] = left + w
    out.push({ ...p, text, row: row as 0 | 1, align })
  }
  return out
}

/**
 * 趋势图里第 i 个点的横坐标（页面画之前就要摆尖顶数字，没法先问 ECharts）：
 * 绘图区左边 = grid.left + 纵轴刻度字宽 + 8（ECharts 默认的刻度字到轴的间距），右边 = 宽 − grid.right。
 * boundaryGap（柱子、点很少时的折线）：每个点在一格中间；否则头尾贴着绘图区两边。
 */
export function trendGeometry(width: number, n: number, boundaryGap: boolean, yLabelW: number, gridLeft = 4, gridRight = 14): { plotL: number; plotR: number; xOf: (i: number) => number } {
  const plotL = gridLeft + yLabelW + 8
  const plotR = width - gridRight
  const span = plotR - plotL
  const xOf = boundaryGap || n < 2 ? (i: number) => plotL + (span / n) * (i + 0.5) : (i: number) => plotL + (span / (n - 1)) * i
  return { plotL, plotR, xOf }
}

/** 输入框里的元：只收正整数，别的一律当没填 */
export function parseYuanInt(s: string): number | null {
  const n = Number(s.trim())
  return Number.isInteger(n) && n > 0 ? n : null
}
