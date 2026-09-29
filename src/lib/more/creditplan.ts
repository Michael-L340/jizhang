// 进阶统计·白条未来负担：往后 12 个月，每个月各家白条还要还多少。
//
// 每一期欠多少、哪天到期、有没有被还款抵掉，全部照搬 compute.creditBill（面板用的就是它）：
// 分期按期摊、京东「本期还过款之后下的单归下一期」、勾选结清、还款从最早一期往后顶，这里一条都不另算。
// 另算一套迟早和白条面板对不上。
//
// 这里只做一件事：把每一期**还没被抵掉的那部分**（due.amount − paid）按「哪个月得还」归到月份上——
//   · 本期和往后的期：就是它自己的到期日；
//   · 逾期没还完的：CLAUDE.md 的规矩是「滚进本期」，所以算在本期到期日那个月，不画在已经过去的月份上；
//   · 没有固定还款日的（拼多多先用后付）：已经下单、还没结清的就是「现在欠着」，算在今天这个月。
//
// 12 个月从哪个月起：这个月还有要还的（今天之后到月底前有还款日、或者有逾期 / 先用后付滚进来的）就从这个月起，
// 否则从下个月起。今天 9/29、京东 17 号、花呗 1 号还款，9 月已经没有要还的了，头一根柱子画个空的 9 月没意思。
// 每一期的「哪个月得还」都不早于今天这个月，所以起点只可能是这个月或下个月。
// 12 个月之后才到期的（24 期分期的后半截）不画，单独一个小方块写「12 个月以后」，一分钱不藏。
//
// MoreInput.txs 是当前模式那本账。白条整块不参与里外页面，两种模式下这里的数一样。
import type { Account, Transaction } from '../../types'
import { axisLabels, gridTopFor, legendRows } from '../chart'
import { creditBill, splitAccounts, type BillRow, type CreditBill } from '../compute'
import { fmtMonthZh, monthOf, shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { accountColors, type ColorOf } from './acctcolor'
import { esc } from './html'
import { monthSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

export const PLAN_MONTHS = 12

const KEY = 'creditplan'
const TITLE = '白条未来负担'
const NOTE = '往后 12 个月每月各家白条还要还多少：分期按期摊，提前还过的扣掉，逾期没还的算进本期，先用后付没结清的算这个月。这个月已经没有要还的就从下个月起。'

/** 同统计页堆叠柱：整根柱子从下往上长完用多久 */
const GROW_MS = 620
const RIGHT = 'float:right;margin-left:16px;font-weight:600'
const yuan = (cents: number) => fmtYuan(cents, { symbol: true })
const axisMoney = (cents: number) => {
  const v = cents / 100
  return Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v)
}
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（和统计页、白条卡的兜底一致） */
export const PLAN_AXIS_W = 285
export const PLAN_CHART_W = 329

/** 这一期哪天得还（见文件头三条） */
export function payBy(row: BillRow, bill: CreditBill, today: string): string {
  if (row.state === 'upcoming') return row.due.date
  // 逾期 / 本期：有还款日的算本期到期日；没有还款日的就是现在
  return bill.dueDate ?? today
}

export interface CreditPlan {
  /** 12 个月，YYYY-MM 升序 */
  months: string[]
  /** 每家白条每个月还要还多少（分），和 credits 一一对应（包括一分不欠的） */
  byAccount: { account: Account; data: number[] }[]
  /** 每个月合计（分） */
  total: number[]
  /** 12 个月以后才到期、还没还的（分） */
  beyond: number
}

export function creditPlan(txs: Transaction[], credits: Account[], today: string): CreditPlan {
  const owe = credits.map((account) => {
    const bill = creditBill(txs, account, today)
    const items: { ym: string; cents: number }[] = []
    for (const row of [...bill.rows, ...bill.upcoming]) {
      const left = row.due.amount - row.paid
      if (left > 0) items.push({ ym: monthOf(payBy(row, bill, today)), cents: left })
    }
    return { account, items }
  })
  const cur = monthOf(today)
  const dueThisMonth = owe.some((o) => o.items.some((x) => x.ym <= cur))
  const first = dueThisMonth ? cur : shiftMonth(cur, 1)
  const months = Array.from({ length: PLAN_MONTHS }, (_, i) => shiftMonth(first, i))
  const at = new Map(months.map((m, i) => [m, i]))
  let beyond = 0
  const byAccount = owe.map(({ account, items }) => {
    const data = months.map(() => 0)
    for (const x of items) {
      const i = at.get(x.ym)
      if (i !== undefined) data[i] += x.cents
      else beyond += x.cents
    }
    return { account, data }
  })
  const total = months.map((_, i) => byAccount.reduce((s, r) => s + r.data[i], 0))
  return { months, byAccount, total, beyond }
}

export interface CreditPlanOpts {
  /** 图里 x 轴能用的宽度（px） */
  axisWidth?: number
  /** 整张图的宽度（px），图例排几行按它算 */
  chartWidth?: number
  /** 账户名 → 品牌色（页面传 components/AccountIcon 的 accountColor）；不传用深焦糖（白条分组那个色）的同色系 */
  colorOf?: ColorOf
}

export function creditPlanChart(inp: MoreInput, opts: CreditPlanOpts = {}): MoreChart {
  const { credits } = splitAccounts(inp.accounts)
  const P = creditPlan(inp.txs, credits, inp.today)
  const base = { key: KEY, title: TITLE, span: monthSpan(P.months[0], P.months[P.months.length - 1]), note: NOTE }
  if (!credits.length) return { ...base, option: null, empty: '还没有白条账户' }
  const sum = P.total.reduce((s, v) => s + v, 0)
  if (sum === 0) return { ...base, option: null, empty: '往后 12 个月白条没有要还的' }

  // 颜色按整张白条表发，再筛掉 12 个月里一分不欠的那几家
  const colors = accountColors(credits, opts.colorOf, CHART.brandInk)
  const rows = P.byAccount.map((r, i) => ({ ...r, color: colors[i] })).filter((r) => r.data.some((v) => v > 0))

  let top = 0
  P.total.forEach((v, i) => {
    if (v > P.total[top]) top = i
  })
  const tiles: MoreTile[] = [
    { label: `未来 ${PLAN_MONTHS} 个月合计`, value: yuan(sum) },
    // 月份放标签里、值只放金额：「10月 ¥12,345.00」塞在一格里，手机上被截成「10月 ¥12,3…」。
    // 12 个月里月份数字不会重复，写「10月」不用带年份
    { label: `最重：${+P.months[top].slice(5)}月`, value: yuan(P.total[top]) },
  ]
  if (P.beyond > 0) tiles.push({ label: `${PLAN_MONTHS} 个月以后`, value: yuan(P.beyond) })

  const names = rows.map((r) => r.account.name)
  const chartW = opts.chartWidth ?? PLAN_CHART_W
  // x 轴标签年份永远带着（「26.10」），装不下按宽度逐级降密度（同统计页）
  const axis = axisLabels(P.months, 'month', opts.axisWidth ?? PLAN_AXIS_W)

  // 入场动画和统计页的堆叠柱一样：整根柱子当一个整体自下而上长，每一段按它占的高度接力，缓动 linear
  const below: number[][] = []
  let acc = P.months.map(() => 0)
  for (const r of rows) {
    below.push(acc)
    acc = acc.map((v, i) => v + r.data[i])
  }

  return {
    ...base,
    tiles,
    option: {
      color: rows.map((r) => r.color),
      legend: { data: names, top: 0, width: chartW, itemWidth: 14, itemHeight: 8, itemGap: 10, textStyle: { fontSize: 11 } },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        confine: true,
        formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => {
          if (!ps.length) return ''
          const i = ps[0].dataIndex
          // 账户名是用户自己起的，拼进 HTML 前转义（lib/more/html.ts）
          const lines = ps.filter((p) => p.value > 0).map((p) => `${p.marker}${esc(p.seriesName)}<span style="${RIGHT}">${yuan(p.value)}</span>`)
          if (!lines.length) return `${fmtMonthZh(P.months[i])}<br/>没有要还的`
          const all = `<span style="opacity:.75">合计</span><span style="${RIGHT}">${yuan(P.total[i])}</span>`
          return [fmtMonthZh(P.months[i]), ...lines, all].join('<br/>')
        },
      },
      grid: { left: 4, right: 14, top: gridTopFor(legendRows(names, chartW)), bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: axis.text,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => axis.show[i] ?? false },
      },
      yAxis: { type: 'value', min: 0, splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
      series: rows.map((r, j) => ({
        name: r.account.name,
        type: 'bar',
        stack: 'plan',
        barMaxWidth: 22,
        animationEasing: 'linear',
        animationDelay: (i: number) => (P.total[i] > 0 ? (below[j][i] / P.total[i]) * GROW_MS : 0),
        animationDuration: (i: number) => (P.total[i] > 0 ? Math.max(1, (r.data[i] / P.total[i]) * GROW_MS) : 1),
        // 段与段之间留一道白缝（同统计页堆叠柱）
        itemStyle: { borderColor: CHART.gap, borderWidth: 1 },
        // 单位是分；轴和提示框自己换成元
        data: r.data,
      })),
    },
  }
}

export default creditPlanChart
