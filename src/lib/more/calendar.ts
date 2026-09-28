// 进阶统计·消费日历：以选中月份为终点往前 12 个月，每天花了多少，格子越红花得越多。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'：转账（含还白条）、校准、收入一律不进（compute.isFlow 的口径）。
import { textWidth } from '../chart'
import { addDays, daysBetween, fmtDateZh, lastMonths, monthOf, monthRange, shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'

/** 往前画几个月（含选中的那个月） */
export const CALENDAR_MONTHS = 12

/** 日历在图里的左右留白（左边是「一 三 五」那列字） */
const CAL_LEFT = 20
const CAL_RIGHT = 6
/** 月份标签的字号 */
export const MONTH_LABEL_FONT = 9
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（393 − 页面和卡片内边距 64） */
export const CALENDAR_CHART_W = 329

const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
/** 同统计页：点一下只出提示框，要告诉用户还能再点一下 */
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'

/** 两个 #rrggbb 按 t 混合（0 = a，1 = b）。浅色端从主题色里调出来，不另写色值 */
function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

/**
 * 颜色的上限：第 95 百分位（最近秩法），不是最大值。
 *
 * 取最大值的话，一年里交一次房租（3000）就把其余 300 多天（几十块）全压成最浅的那一档，
 * 整张日历看着是白的。封在 95 分位，超过的那几天顶格最红，剩下的日子才分得出深浅。
 * 天数少（≤ 19 天）时 95 分位就是最大值本身，不会误伤。
 */
export function colorCap(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(s.length * 0.95) - 1)]
}

/** 日历的首尾日期：ym 往前 11 个月的 1 号 → ym 月末 */
export function calendarRange(ym: string): [string, string] {
  return [`${shiftMonth(ym, -(CALENDAR_MONTHS - 1))}-01`, monthRange(ym).end]
}

/** YYYY-MM-DD 那一周的周一（日历一列 = 一周，周一在最上面） */
function mondayOf(d: string): string {
  const [y, m, day] = d.split('-').map(Number)
  const wd = (new Date(Date.UTC(y, m - 1, day)).getUTCDay() + 6) % 7
  return addDays(d, -wd)
}

/**
 * 月份标签标哪几个、写什么。**年份永远带着**（统计页 x 轴的规矩）：每个都是「25.10」「26.1」这样。
 *
 * 位置照 ECharts 6 日历的画法算（CalendarView._renderMonthText，monthLabel.align 默认 center）：
 * 标签居中在「这个月 1 号那一列的左边」和「下个月第一个周一那一列的左边」之间。
 * 一个月只有四五列，窄屏上一列 5 px 出头，「25.10」却要 25 px——全标就是「25.1011月」那样连成一串。
 * 所以学 chart.axisLabels 逐级降密度，取第一个装得下的：
 *   全标 → 隔月（从选中的那个月往前数，它自己永远标着）→ 每季度（1/4/7/10 月）→ 每半年（1/7 月）
 * 「装得下」= 相邻两个标出来的，中心距 ≥ 两个半宽之和 + 4 px（和 axisLabels 同一个余量）。
 * ChartMore.test.ts 用 ECharts 的 SSR 真画出来量过，这里算的位置和它画的对得上。
 */
export function monthLabels(ym: string, chartWidth: number, fontSize = MONTH_LABEL_FONT): { ym: string; text: string; show: boolean; x: number }[] {
  const months = lastMonths(CALENDAR_MONTHS, ym)
  const [start, end] = calendarRange(ym)
  const week0 = mondayOf(start)
  const weeks = Math.floor(daysBetween(week0, end) / 7) + 1
  const cell = (chartWidth - CAL_LEFT - CAL_RIGHT) / weeks
  const col = (d: string, round: (v: number) => number) => round(daysBetween(week0, d) / 7) * cell
  // 1 号所在那一列 ~ 下个月 1 号之后第一个周一那一列，取中点
  const x = months.map((m) => (col(`${m}-01`, Math.floor) + col(`${shiftMonth(m, 1)}-01`, Math.ceil)) / 2)
  const text = months.map((m) => `${m.slice(2, 4)}.${+m.slice(5)}`)
  const n = months.length
  const levels: boolean[][] = [
    months.map(() => true),
    months.map((_, i) => (n - 1 - i) % 2 === 0),
    months.map((m) => [1, 4, 7, 10].includes(+m.slice(5))),
    months.map((m) => [1, 7].includes(+m.slice(5))),
  ]
  const fits = (lv: boolean[]) => {
    const idx = lv.flatMap((s, i) => (s ? [i] : []))
    const w = (i: number) => textWidth(text[i], fontSize)
    for (let k = 1; k < idx.length; k++) if (x[idx[k]] - x[idx[k - 1]] < (w(idx[k]) + w(idx[k - 1])) / 2 + 4) return false
    return true
  }
  const show = levels.find(fits) ?? levels[levels.length - 1]
  return months.map((m, i) => ({ ym: m, text: text[i], show: show[i], x: CAL_LEFT + x[i] }))
}

/** 区间内每天的支出合计（分），只留 > 0 的天，按日期升序 */
export function dailyExpense(inp: Pick<MoreInput, 'txs' | 'ym'>): [string, number][] {
  const [start, end] = calendarRange(inp.ym)
  const perDay = new Map<string, number>()
  for (const t of inp.txs) {
    if (t.type !== 'expense' || t.date < start || t.date > end) continue
    perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amount)
  }
  return [...perDay.entries()].filter(([, v]) => v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

export function calendar(inp: MoreInput, chartWidth = CALENDAR_CHART_W): MoreChart {
  const [start, end] = calendarRange(inp.ym)
  const base = {
    key: 'calendar',
    title: '消费日历',
    span: monthSpan(monthOf(start), inp.ym),
    note: `到所选月份为止的 ${CALENDAR_MONTHS} 个月，每天花了多少，越红花得越多。花得最多的那 5% 的日子（比如交房租）都按最红画；转账、还白条、校准不算。`,
  }
  const days = dailyExpense(inp)
  if (!days.length) return { ...base, option: null, empty: `这 ${CALENDAR_MONTHS} 个月没有支出记录` }

  const labels = new Map(monthLabels(inp.ym, chartWidth).map((l) => [l.ym, l]))
  // 图上的数字一律是元（和统计页一样），跳转和换算只认 days 里的分
  const data = days.map(([d, cents]) => [d, cents / 100] as [string, number])
  const cap = colorCap(days.map(([, v]) => v)) / 100

  return {
    ...base,
    height: 150,
    option: {
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { data?: [string, number] }) => {
          if (!p.data) return ''
          const [d, v] = p.data
          return `${fmtDateZh(d)}<br/>支出<span style="float:right;margin-left:16px;font-weight:600">${yuan(v)}</span>${TAP}`
        },
      },
      visualMap: {
        type: 'continuous',
        min: 0,
        max: cap,
        calculable: false,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        itemWidth: 10,
        itemHeight: 120,
        text: [yuan(cap), '¥0'],
        textGap: 6,
        textStyle: { fontSize: 10, color: CHART.label },
        inRange: { color: [mix(CHART.gap, CHART.expense, 0.25), CHART.expense] },
        seriesIndex: 0,
      },
      calendar: {
        range: [start, end],
        orient: 'horizontal',
        top: 20,
        left: CAL_LEFT,
        right: CAL_RIGHT,
        height: 70,
        cellSize: ['auto', 'auto'],
        // 空着的日子是浅米色的格子，格子之间留白缝——和堆叠柱的缝同一个色
        itemStyle: { color: mix(CHART.gap, CHART.axis, 0.6), borderColor: CHART.gap, borderWidth: 1 },
        splitLine: { show: true, lineStyle: { color: CHART.label, width: 1, opacity: 0.45 } },
        yearLabel: { show: false },
        // 年份永远带着（统计页的规矩），装不下就隔月 / 按季度标，见 monthLabels
        monthLabel: {
          fontSize: MONTH_LABEL_FONT,
          color: CHART.label,
          margin: 4,
          formatter: (p: { yyyy: string | number; MM: string | number }) => {
            const l = labels.get(`${p.yyyy}-${String(p.MM).padStart(2, '0')}`)
            return l?.show ? l.text : ''
          },
        },
        // 周一在最上面；只标一三五，七个字全标在 10px 高的格子旁边挤成一团
        dayLabel: { firstDay: 1, fontSize: 9, color: CHART.label, margin: 4, nameMap: ['', '一', '', '三', '', '五', ''] },
      },
      series: [{ type: 'heatmap', coordinateSystem: 'calendar', data }],
    },
    // cat=all：流水页收到 cat 才会重设筛选，不带的话上次在流水页留下的分类筛选还在，那天别的支出看不见
    onPoint: (dataIndex) => {
      const d = days[dataIndex]?.[0]
      return d ? `ym=${monthOf(d)}&date=${d}&cat=all` : null
    },
  }
}
