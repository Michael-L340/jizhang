// 进阶统计 · 所选月份在历史里的位置：往前 12 个月每个月一条「按几号累计支出」的灰线，所选月份一条红线压在上面，
// 一眼看出这个月花得快还是慢、在历史里排第几。
//
// 标题不写「本月」（registry.test.ts 守着，用户 2026-09 定的规矩）：翻到 8 月看的是 8 月在它之前 12 个月里的位置。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'（compute.dailyCumulative 的口径）：转账（含还白条）、校准、收入一律不进。
//
// 「同一天」按几号对齐，和「累计支出 vs 上月」（race.ts）同一套规矩：
//   · 那个月没有这一号（2 月没有 30 号）→ 用它的月底合计；
//   · 所选月份已经到了月底（翻回去看的旧月份，或者今天就是月底）→ 别的月份也取整月合计，
//     不能拿 1 月 28 号的累计去和一整个 2 月比——那样 1 月 29–31 号花的钱就没了。
import { dailyCumulative, firstFlowDate } from '../compute'
import { dayInMonth, daysInMonth, monthOf, monthRange, shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { endDotOnly } from '../chart'
import { alignDays } from './race'
import { monthSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

export const POSITION_TITLE = '所选月份在历史里的位置'
/** 往前比几个月 */
export const HISTORY_MONTHS = 12
/** x 轴 1..31 号 */
export const MAX_DAYS = 31

const yuan = (cents: number) => `¥${fmtYuan(cents)}`
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))
const RIGHT = 'float:right;margin-left:16px;font-weight:600'
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const ymText = (ym: string) => `${ym.slice(2, 4)}.${+ym.slice(5, 7)}`

export interface HistoryLine {
  ym: string
  /** 整月逐日累计（分），长度 = 那个月的天数 */
  full: number[]
}

export interface Position {
  /** 所选月份逐日累计（分），长度 = 所选月份天数；当前月今天之后是 null */
  cur: (number | null)[]
  /** 比到几号：当前月是今天的几号，旧月份是月底 */
  day: number
  /** 所选月份到 day 为止花了多少（分） */
  now: number
  /** 往前 12 个月里记过账的那几个，从早到晚。还没开始用 App 的月份不算（不画、不进中位数和名次） */
  history: HistoryLine[]
  /** history 每个月「同一天」的累计（分），和 history 一一对应 */
  sameDay: number[]
  /** sameDay 的中位数（分，偶数个取中间两个的平均、四舍五入到分）；history 为空时 null */
  median: number | null
  /** 从高到低排第几：1 + 同一天比所选月份花得多的月份数（并列算靠前）。一共 history.length + 1 个 */
  rank: number
}

/** 某个月「按所选月份的几号」的累计：那个月没有这一号就用月底合计；day 是所选月份的月底就取整月合计 */
export function sameDayOf(full: number[], day: number, ymDays: number): number {
  return alignDays(full, ymDays)[Math.min(day, ymDays) - 1] ?? 0
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

export function position(inp: Pick<MoreInput, 'txs' | 'ym' | 'today'>): Position {
  const { txs, ym, today } = inp
  const n = daysInMonth(ym)
  const isNow = ym === monthOf(today)
  const cur = dailyCumulative(txs, ym, isNow ? today : monthRange(ym).end)
  const day = isNow ? Number(today.slice(8, 10)) : n
  const now = cur[day - 1] ?? 0
  // 还没开始记账的月份不算：头几个月用 App 的人，前面全是 0 的灰线会把中位数拉成 0、名次永远第一
  const firstYm = monthOf(firstFlowDate(txs, today))
  const history: HistoryLine[] = []
  for (let k = HISTORY_MONTHS; k >= 1; k--) {
    const m = shiftMonth(ym, -k)
    if (m < firstYm) continue
    history.push({ ym: m, full: dailyCumulative(txs, m, monthRange(m).end) as number[] })
  }
  const sameDay = history.map((h) => sameDayOf(h.full, day, n))
  return { cur, day, now, history, sameDay, median: median(sameDay), rank: 1 + sameDay.filter((v) => v > now).length }
}

export function positionChart(inp: MoreInput): MoreChart {
  const P = position(inp)
  const { ym } = inp
  const first = P.history[0]?.ym ?? ym
  const base = {
    key: 'position',
    title: POSITION_TITLE,
    span: monthSpan(first, ym),
    note: `灰线是往前 ${HISTORY_MONTHS} 个月（还没开始记账的月份不算）每个月按几号累计花了多少，红线是所选月份。「同期」按几号对齐，所选月份到了月底就和整月比；名次从花得多的往下数。转账、还白条、校准不算。`,
  }
  if (!P.history.length) return { ...base, option: null, empty: '往前还没有记过账的月份，没得比' }
  const monthTotal = (a: (number | null)[]) => a.reduce<number>((m, v) => Math.max(m, v ?? 0), 0)
  if (monthTotal(P.cur) <= 0 && P.history.every((h) => monthTotal(h.full) <= 0)) {
    return { ...base, option: null, empty: '这几个月没有支出记录' }
  }

  const isNow = ym === monthOf(inp.today)
  const curName = `${+ym.slice(5)}月`
  const histName = `往前 ${P.history.length} 个月`
  // 标签要短：三格排一行，一格才一百来 px，「6 个月同期中位数」「排第几（从高到低）」在手机上被截掉（审阅 #12）。
  // 比了几个月看标题旁的区间和「第 4 / 7」的分母；从高到低写在底下那行字里
  const tiles: MoreTile[] = [
    { label: isNow ? `${curName}到今天` : `${curName}整月`, value: yuan(P.now) },
    { label: '同期中位数', value: P.median === null ? '—' : yuan(P.median) },
    { label: '名次', value: `第 ${P.rank} / ${P.history.length + 1}` },
  ]

  // 点哪一号跳所选月份那一天的流水（同「累计支出 vs 上月」race.ts）。x 轴固定 31 格：这个月没有的那几号、
  // 今天之后的日子没有流水可看，不跳。cat=all：流水页收到 cat 才重设筛选，不带的话上次留下的分类筛选还在
  const onPoint = (dataIndex: number): string | null => {
    if (dataIndex < 0 || dataIndex >= daysInMonth(ym)) return null
    const d = dayInMonth(ym, dataIndex + 1)
    return d > inp.today ? null : `ym=${ym}&date=${d}&cat=all`
  }

  const days = Array.from({ length: MAX_DAYS }, (_, i) => String(i + 1))
  const pad = (a: (number | null)[]) => days.map((_, i) => (i < a.length && a[i] !== null ? (a[i] as number) / 100 : null))
  const curLen = P.cur.filter((v) => v !== null).length

  const series: object[] = P.history.map((h) => ({
    name: histName,
    type: 'line',
    color: CHART.label,
    showSymbol: false,
    silent: true,
    emphasis: { disabled: true },
    lineStyle: { width: 1, opacity: 0.35 },
    data: pad(h.full),
  }))
  series.push({
    name: curName,
    type: 'line',
    color: CHART.expense,
    // 只画末点（统计页曲线同一个做法，用户 2026-09-28 选的「丙」）：线头在哪一眼看得见
    showSymbol: true,
    symbol: 'circle',
    symbolSize: endDotOnly(curLen, 7),
    lineStyle: { width: 2.5 },
    z: 3,
    data: pad(P.cur),
  })

  return {
    ...base,
    height: 240,
    tiles,
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number }[]) => {
          if (!ps.length) return ''
          const i = ps[0].dataIndex
          const d = i + 1
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          const rows = [`${d} 号`]
          const c = P.cur[i]
          if (c !== null && c !== undefined) rows.push(line(curName, yuan(c)))
          // 这一号往前每个月累计了多少：所选月份有这一号就按「同期」的规矩（和下面三个小数字一个算法）；
          // 所选月份没有这一号（2 月看 30 号）就是灰线本身在这一号的高度
          const n = P.cur.length
          const vals = P.history.map((h) => ({ ym: h.ym, v: d <= n ? sameDayOf(h.full, d, n) : h.full[Math.min(d, h.full.length) - 1] }))
          const med = median(vals.map((x) => x.v))
          if (med !== null) rows.push(line('同期中位数', yuan(med)))
          const hi = vals.reduce((a, b) => (b.v > a.v ? b : a))
          const lo = vals.reduce((a, b) => (b.v < a.v ? b : a))
          rows.push(line(`最多（${ymText(hi.ym)}）`, yuan(hi.v)), line(`最少（${ymText(lo.ym)}）`, yuan(lo.v)))
          return rows.join('<br/>') + (onPoint(i) ? TAP : '')
        },
      },
      legend: { top: 0, data: [curName, histName], itemWidth: 14, itemHeight: 8, itemGap: 10, textStyle: { fontSize: 11 } },
      grid: { left: 4, right: 14, top: 30, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: days,
        boundaryGap: false,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        // 标 1、5、10、15…号
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => i === 0 || (i + 1) % 5 === 0 },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
      series,
    },
    onPoint,
  }
}
