// 进阶统计·储蓄率 12 个月：以选中月份为终点往前 12 个月，每个月存下了收入的几成。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 储蓄率 = (收入 − 支出) ÷ 收入，走 compute.monthSummary：转账（含还白条）、校准一律不进。
import { monthSummary } from '../compute'
import { axisLabels } from '../chart'
import { lastMonths } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

export const SAVING_MONTHS = 12
/**
 * y 轴最低画到 -100%。储蓄率没有下限：一个月只进了一笔 10 块的退款（退款算收入）、花了 2000，
 * 储蓄率是 -19900%，整根 y 轴被它拉到 -20000，其余月份全挤成 0 附近一条直线。
 * 低于这条线的月份画在线上、换成朝下的三角，提示框里照样是真实的数。
 */
export const RATE_FLOOR = -100
/**
 * 估 x 轴能用多宽：统计页的算法（屏宽封顶 430、默认 393，减去页面和卡片内边距 64、y 轴那列 44）。
 * 纯函数拿不到真实宽度，按常见手机宽度估；降密度的判断差几个像素不要紧。
 */
const AXIS_WIDTH = 393 - 64 - 44
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'
const pct = (r: number) => `${Math.round(r * 100)}%`

export interface SavingRow {
  ym: string
  income: number
  expense: number
  /** 0-1；收入为 0 时 null（图上断开） */
  rate: number | null
}

export function savingRows(inp: Pick<MoreInput, 'txs' | 'ym'>): SavingRow[] {
  return lastMonths(SAVING_MONTHS, inp.ym).map((ym) => {
    const s = monthSummary(inp.txs, ym)
    return { ym, income: s.income, expense: s.expense, rate: s.savingRate }
  })
}

/**
 * 12 个月合起来的储蓄率 = 12 个月总结余 ÷ 总收入（按收入加权），不是 12 个百分比直接平均。
 * 直接平均会被上面那种「只进了一笔退款」的月份一票拉到负几千；按钱算，一年到底存下了收入的几成才是用户想知道的。
 * 没收入的月份的支出也照样扣（钱是真花出去了）。12 个月一分收入都没有 → null。
 */
export function overallRate(rows: SavingRow[]): number | null {
  const income = rows.reduce((s, r) => s + r.income, 0)
  const expense = rows.reduce((s, r) => s + r.expense, 0)
  return income > 0 ? (income - expense) / income : null
}

export function saving(inp: MoreInput): MoreChart {
  const rows = savingRows(inp)
  const base = {
    key: 'saving',
    title: '储蓄率 12 个月',
    // 不看时间段按钮：永远是到所选月份为止的 12 个月，所以标题旁写清楚是哪 12 个月
    span: monthSpan(rows[0].ym, inp.ym),
    note: '储蓄率 =（收入 − 支出）÷ 收入；没收入的月份算不出，线断开。12 个月平均按钱算：总结余 ÷ 总收入。转账、还白条、校准不算。',
  }
  if (rows.every((r) => r.rate === null)) {
    return { ...base, option: null, empty: `这 ${SAVING_MONTHS} 个月没有收入记录，算不出储蓄率` }
  }

  const cur = rows[rows.length - 1]
  const all = overallRate(rows)
  const tiles: MoreTile[] = [
    { label: `${+cur.ym.slice(5)}月储蓄率`, value: cur.rate === null ? '—' : pct(cur.rate) },
    { label: `${SAVING_MONTHS} 个月平均`, value: all === null ? '—' : pct(all) },
  ]

  const keys = rows.map((r) => r.ym)
  const axis = axisLabels(keys, 'month', AXIS_WIDTH)
  // 线是收入绿；花超了（储蓄率 < 0）的那几个点单独染成支出红，存下钱和花超了一眼分开。
  // 没用 visualMap 分段上色（lt 0 红 / gte 0 绿）：2026-09-28 用 ECharts 6 的 SSR 实测，setOption 时
  // 折线的 getVisualGradient 抛 TypeError（colorStopsInRange[0] 是 undefined），整张图画不出来。没追根因，换成逐点染色。
  const red = { color: CHART.expense }
  const data = rows.map((r) => {
    if (r.rate === null) return null
    const v = Math.round(r.rate * 1000) / 10
    if (v < RATE_FLOOR) return { value: RATE_FLOOR, symbol: 'triangle', symbolRotate: 180, symbolSize: 9, itemStyle: red }
    return v < 0 ? { value: v, itemStyle: red } : v
  })
  // cat=all：流水页收到 cat 才重设筛选，不带的话上次留下的分类筛选还在
  const onPoint = (dataIndex: number): string | null => (keys[dataIndex] ? `ym=${keys[dataIndex]}&cat=all` : null)

  return {
    ...base,
    tiles,
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number }[]) => {
          if (!ps.length) return ''
          const i = ps[0].dataIndex
          const r = rows[i]
          if (!r) return ''
          const head = `${r.ym.slice(0, 4)}年${+r.ym.slice(5)}月`
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          return (
            [
              head,
              line('储蓄率', r.rate === null ? '没有收入，算不出' : pct(r.rate)),
              line('收入', `¥${fmtYuan(r.income)}`),
              line('支出', `¥${fmtYuan(r.expense)}`),
              line('结余', `${r.income - r.expense < 0 ? '-' : ''}¥${fmtYuan(Math.abs(r.income - r.expense))}`),
            ].join('<br/>') + TAP
          )
        },
      },
      grid: { left: 4, right: 14, top: 16, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: axis.text,
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => axis.show[i] ?? false },
      },
      yAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, formatter: (v: number) => `${v}%` },
      },
      series: [
        {
          name: '储蓄率',
          type: 'line',
          color: CHART.income,
          // 收入为 0 的月份是 null：断开，不连过去——连过去就等于替那个月编了一个储蓄率
          connectNulls: false,
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { width: 2.5 },
          areaStyle: { opacity: 0.1 },
          data,
        },
      ],
    },
    onPoint,
  }
}
