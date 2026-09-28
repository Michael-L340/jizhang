// 进阶统计 · 白条（欠款走势 + 本期该还 / 欠款合计）。
//
// 白条的算法一律用 compute.ts 现成的（balanceSeries / debtOf / dueNow），这里不另算一套：
// 另算一套迟早和账户页、首页对不上。
//
// 「欠款」口径和首页、账户页的「欠款合计」一样走 debtOf：每家白条各自 max(0, −余额) 再相加，
// **某一家还多了（余额为正）不抵别家的欠款**。直接拿几家余额之和取反的话，京东多还 100、
// 花呗欠 300，图上会画成欠 200，而首页写着欠 300。
//
// MoreInput.txs 是当前模式那本账。白条整块不参与里外页面（facade.ts 对 credit 各挡一道），
// 所以两种模式下这里的数一样。
import { balances, balanceSeries, bucketKeys, debtOf, dueNow, splitAccounts } from '../compute'
import { axisLabels } from '../chart'
import { CREDIT_ALL } from '../filter'
import { fmtMonthZh, monthOf } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'

const KEY = 'credit'
const TITLE = '白条'
const NOTE = '每月月底几家白条的欠款之和，还多了的不抵别家；本期该还按今天算，含逾期没还完的。'

/**
 * 纯函数量不到屏幕宽，x 轴标签按这个宽度排（和统计页在没有 window 时的兜底一致：393 − 64 − 44）。
 * 页面知道实际宽度时从第二个参数传进来。
 */
export const CREDIT_AXIS_W = 285

const yuan = (cents: number) => fmtYuan(cents, { symbol: true })
/** 同统计页：点一下只出提示框，得告诉用户还能再点一下（Chart 的 onAxisClick 要点两下才跳） */
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
/** 坐标轴上的数：分 → 元，过万写「1.2万」，和统计页一个写法 */
const axisMoney = (cents: number) => {
  const v = cents / 100
  return Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v)
}

export function creditChart(inp: MoreInput, axisWidth = CREDIT_AXIS_W): MoreChart {
  // 按月底取点：半截月份也是按整月画的，所以标题旁写整月（「25.10–26.9」）
  const base = { key: KEY, title: TITLE, span: monthSpan(monthOf(inp.start), monthOf(inp.end)), note: NOTE }
  const { credits } = splitAccounts(inp.accounts)
  if (!credits.length) return { ...base, option: null, empty: '还没有白条账户' }

  const keys = bucketKeys(inp.start, inp.end, 'month')
  const { byAccount } = balanceSeries(inp.txs, credits, keys, 'month')
  const debt = keys.map((_, i) => debtOf(Object.fromEntries(credits.map((a) => [a.id, byAccount[a.id][i]])), credits))

  const due = [...dueNow(inp.txs, credits, inp.today).values()].reduce((s, v) => s + v, 0)
  const owed = debtOf(balances(inp.txs, credits), credits)

  if (owed === 0 && due === 0 && debt.every((v) => v === 0)) return { ...base, option: null, empty: '白条没有欠款' }

  const tiles = [
    { label: '本期该还', value: yuan(due) },
    { label: '欠款合计', value: yuan(owed) },
  ]
  const axis = axisLabels(keys, 'month', axisWidth)

  return {
    ...base,
    tiles,
    // 流水页筛成「白条」那个月（四家一起）：只带月份的话是那个月所有账户的流水，还得自己再筛一遍；
    // cat=all 让流水页重设筛选（它只有收到 cat 才换筛选条件，acc 跟着 cat 一起读）
    onPoint: (i) => (keys[i] ? `ym=${keys[i]}&cat=all&acc=${CREDIT_ALL}` : null),
    option: {
      color: [CHART.expense],
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number; marker: string; value: number }[]) => {
          if (!ps.length) return ''
          const p = ps[0]
          return `${fmtMonthZh(keys[p.dataIndex])}底<br/>${p.marker}欠款<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value)}</span>${TAP}`
        },
      },
      grid: { left: 4, right: 14, top: 16, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: axis.text,
        boundaryGap: keys.length === 1,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => axis.show[i] ?? false },
      },
      yAxis: {
        type: 'value',
        min: 0,
        splitLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney },
      },
      series: [
        {
          name: '欠款',
          type: 'line',
          showSymbol: keys.length <= 40,
          symbolSize: 7,
          lineStyle: { width: 2.5 },
          areaStyle: { opacity: 0.1 },
          // 单位是分；轴和提示框自己换成元
          data: debt,
        },
      ],
    },
  }
}

export default creditChart
