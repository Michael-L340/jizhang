// 进阶统计·累计支出 vs 上月：同一个「几号」上，所选月份已经花了多少、上个月这时候花了多少、再往前三个月平均花了多少。
// 标题不写「本月」：翻到 8 月看的是 8 月 vs 7 月（月份写在标题旁）。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'（compute.dailyCumulative 的口径）：转账（含还白条）、校准、收入一律不进。
import { dailyCumulative, firstFlowDate } from '../compute'
import { dayInMonth, daysInMonth, monthOf, monthRange, shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'

const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'

/**
 * 三条线三个颜色：所选月份支出红、上个月灰、均值线深焦糖（CHART.brandInk）。
 * 原来均值线退回坐标轴灰，和上个月那条一个颜色——图例只画实线加圆点、不画虚线，
 * 「8月」和「近三月平均」两个图标一模一样，看图例对不上哪条是哪条。
 */
const AVG_COLOR = CHART.brandInk

const CN_NUM = ['', '一', '两', '三']

/**
 * 把别的月份的「整月逐日累计」对齐到 n 天长（按几号对齐）：
 * - 那个月短（2 月 28 天对 3 月 31 天）：29–31 号接着用它的月底累计，线走平；
 * - 那个月长（1 月 31 天对 2 月 28 天）：**最后一个点放它的整月合计**，不是 28 号的累计——
 *   月底那一点的意思是「整个月花了多少」，截掉 29–31 号那几天的钱，上月线就永远比上月实际花的少一截。
 */
export function alignDays(full: number[], n: number): number[] {
  const last = full[full.length - 1] ?? 0
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? last : full[Math.min(i, full.length - 1)] ?? 0))
}

/** 某个整月的逐日累计（分），长度 = 那个月的天数 */
function fullMonth(txs: MoreInput['txs'], ym: string): number[] {
  return dailyCumulative(txs, ym, monthRange(ym).end) as number[]
}

export interface RaceLines {
  /** x 轴 1..当月天数 */
  n: number
  /** 选中月份每天的累计（分）；当前月今天之后为 null */
  cur: (number | null)[]
  /** 上个月按几号对齐的累计（分）；上个月还没开始记账就是 null（不画） */
  prev: number[] | null
  /** 往前三个整月（记过账的那几个）按几号对齐的平均累计（分）；少于两个月不画 */
  avg: number[] | null
  /** 均值用了几个月（2 或 3），0 = 不画 */
  avgMonths: number
  /** 今天在 x 轴上的下标；选中的不是当前月就是 null */
  todayIdx: number | null
}

export function raceLines(inp: Pick<MoreInput, 'txs' | 'ym' | 'today'>): RaceLines {
  const { txs, ym, today } = inp
  const n = daysInMonth(ym)
  const isNow = ym === monthOf(today)
  // 当前月画到今天；别的月份画整月
  const cur = dailyCumulative(txs, ym, isNow ? today : monthRange(ym).end)
  // 还没开始记账的月份不算：头一个月用 App 的人，上月线和均值线全是 0，读起来像「上个月一分没花」
  const firstYm = monthOf(firstFlowDate(txs, today))
  const tracked = (m: string) => m >= firstYm
  const prevYm = shiftMonth(ym, -1)
  const prev = tracked(prevYm) ? alignDays(fullMonth(txs, prevYm), n) : null
  const back = [1, 2, 3].map((k) => shiftMonth(ym, -k)).filter(tracked)
  let avg: number[] | null = null
  // 只有一个月能平均时，均值线和上月线是同一条，画出来是两条叠在一起的线
  if (back.length >= 2) {
    const rows = back.map((m) => alignDays(fullMonth(txs, m), n))
    avg = Array.from({ length: n }, (_, i) => Math.round(rows.reduce((s, r) => s + r[i], 0) / rows.length))
  }
  return {
    n,
    cur,
    prev,
    avg,
    avgMonths: avg ? back.length : 0,
    todayIdx: isNow ? Number(today.slice(8)) - 1 : null,
  }
}

export function race(inp: MoreInput): MoreChart {
  const base = {
    key: 'race',
    title: '累计支出 vs 上月',
    span: monthSpan(inp.ym, inp.ym),
    note: '同一个几号，所选月份累计花了多少、上个月和再往前三个月平均这时候花了多少。按几号对齐，月底那一点是整月合计；转账、还白条、校准不算。',
  }
  const L = raceLines(inp)
  const { ym } = inp
  const prevYm = shiftMonth(ym, -1)
  const curName = `${+ym.slice(5)}月`
  const prevName = `${+prevYm.slice(5)}月`
  const avgName = `近${CN_NUM[L.avgMonths]}月平均`

  const spent = (a: (number | null)[] | null) => (a ? a.some((v) => (v ?? 0) > 0) : false)
  if (!spent(L.cur) && !spent(L.prev) && !spent(L.avg)) {
    return { ...base, option: null, empty: '这几个月没有支出记录' }
  }

  const onPoint = (dataIndex: number): string | null => {
    if (dataIndex < 0 || dataIndex >= L.n) return null
    const d = dayInMonth(ym, dataIndex + 1)
    // 还没到的日子没有流水可看。cat=all：流水页收到 cat 才重设筛选，不带的话上次留下的分类筛选还在
    return d > inp.today ? null : `ym=${ym}&date=${d}&cat=all`
  }
  const toYuan = (a: (number | null)[]) => a.map((v) => (v === null ? null : v / 100))
  const days = Array.from({ length: L.n }, (_, i) => String(i + 1))

  const series: object[] = [
    {
      name: curName,
      type: 'line',
      color: CHART.expense,
      showSymbol: false,
      lineStyle: { width: 2.5 },
      areaStyle: { opacity: 0.08 },
      z: 3,
      data: toYuan(L.cur),
      ...(L.todayIdx !== null && L.cur[L.todayIdx] !== null
        ? {
            markPoint: {
              symbol: 'circle',
              symbolSize: 8,
              itemStyle: { color: CHART.expense, borderColor: CHART.gap, borderWidth: 2 },
              label: { show: true, position: 'top', formatter: '今天', fontSize: 10, color: CHART.expense },
              data: [{ name: '今天', coord: [days[L.todayIdx], (L.cur[L.todayIdx] as number) / 100] }],
            },
          }
        : {}),
    },
  ]
  if (L.prev) {
    series.push({ name: prevName, type: 'line', color: CHART.label, showSymbol: false, lineStyle: { width: 1.5 }, data: toYuan(L.prev) })
  }
  if (L.avg) {
    series.push({ name: avgName, type: 'line', color: AVG_COLOR, showSymbol: false, lineStyle: { width: 1.5, type: 'dashed' }, data: toYuan(L.avg) })
  }

  return {
    ...base,
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number | null }[]) => {
          if (!ps.length) return ''
          const i = ps[0].dataIndex
          const rows = ps
            .filter((p) => p.value !== null && p.value !== undefined)
            .map((p) => `${p.marker}${p.seriesName}<span style="${RIGHT}">${yuan(p.value as number)}</span>`)
          const c = L.cur[i]
          const p = L.prev?.[i]
          if (c !== null && c !== undefined && p !== undefined) {
            const diff = c - p
            rows.push(`<span style="opacity:.75">比${prevName}同期${diff >= 0 ? '多' : '少'}</span><span style="${RIGHT}">¥${fmtYuan(Math.abs(diff))}</span>`)
          }
          return [`${i + 1} 号`, ...rows].join('<br/>') + (onPoint(i) ? TAP : '')
        },
      },
      legend: { top: 0, itemWidth: 14, itemHeight: 8, itemGap: 10, textStyle: { fontSize: 11 } },
      grid: { left: 4, right: 14, top: 34, bottom: 0, containLabel: true },
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
