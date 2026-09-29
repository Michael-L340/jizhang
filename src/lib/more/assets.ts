// 进阶统计·资产结构变化：每月月底各资产账户（白条以外）的余额叠在一起，看钱放在哪儿、怎么挪的。
//
// 余额走 compute.balanceSeries（和统计页「总资产」那张卡同一个函数、同一个口径：
// 从有记录以来累计，每个点取那个月的月底），只传资产账户进去——白条的欠款不混进来。
// MoreInput.txs 已经是当前模式那本账：外页面下这里就是外页面的余额（外页面校准记录是 adjust，
// 在它那天起一级台阶），和统计页、账户页是同一本账，不另算。
//
// 余额可能为负（账户透支）：照画不改。ECharts 的堆叠默认「同号才叠」，负的那块画在 0 线下面，
// 不会把别的账户那块往下压；提示框里的合计是加减之后的总资产。
import type { Account } from '../../types'
import { balanceSeries, bucketKeys, splitAccounts } from '../compute'
import { axisLabels, gridTopFor, legendRows } from '../chart'
import { fmtMonthZh, monthOf } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { accountColors, type ColorOf } from './acctcolor'
import { esc } from './html'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'

const KEY = 'assets'
const TITLE = '资产结构变化'
const NOTE = '每月月底各资产账户的余额叠在一起，不扣白条欠款。某个账户余额为负（透支）时，那一块画在 0 线下面，提示框里的合计照减。'

/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（和统计页、白条卡的兜底一致） */
export const ASSETS_AXIS_W = 285
export const ASSETS_CHART_W = 329

export interface AssetsOpts {
  /** 图里 x 轴能用的宽度（px） */
  axisWidth?: number
  /** 整张图的宽度（px），图例排几行按它算 */
  chartWidth?: number
  /** 账户名 → 品牌色（页面传 components/AccountIcon 的 accountColor）；不传用余额蓝的同色系 */
  colorOf?: ColorOf
}

const yuan = (cents: number) => fmtYuan(cents, { symbol: true })
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'
/** 坐标轴上的数：分 → 元，过万写「1.2万」，和统计页一个写法 */
const axisMoney = (cents: number) => {
  const v = cents / 100
  return Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v)
}

export interface AssetsSeries {
  keys: string[]
  /** 这段时间里余额不全是 0 的资产账户，按账户顺序 */
  rows: { account: Account; color: string; data: number[] }[]
  /** 每个月底的总资产（分）= 所有资产账户余额之和（含全是 0 的那几个，它们本来就是 0） */
  total: number[]
}

export function assetsSeries(inp: Pick<MoreInput, 'txs' | 'accounts' | 'start' | 'end'>, colorOf?: ColorOf): AssetsSeries {
  const { assets } = splitAccounts(inp.accounts)
  const keys = bucketKeys(inp.start, inp.end, 'month')
  const { byAccount, total } = balanceSeries(inp.txs, assets, keys, 'month')
  // 颜色按整张资产账户表发：某个账户这段时间没数被筛掉，别的账户不跟着换色
  const colors = accountColors(assets, colorOf, CHART.balance)
  const rows = assets
    .map((account, i) => ({ account, color: colors[i], data: byAccount[account.id] }))
    // 一直是 0 的账户叠上去是一条看不见的线，却在图例里占一格
    .filter((r) => r.data.some((v) => v !== 0))
  return { keys, rows, total }
}

export function assetsChart(inp: MoreInput, opts: AssetsOpts = {}): MoreChart {
  const base = { key: KEY, title: TITLE, span: monthSpan(monthOf(inp.start), monthOf(inp.end)), note: NOTE }
  if (!splitAccounts(inp.accounts).assets.length) return { ...base, option: null, empty: '还没有资产账户' }
  const S = assetsSeries(inp, opts.colorOf)
  if (!S.rows.length) return { ...base, option: null, empty: '这段时间资产账户都没有余额' }

  const { keys, rows, total } = S
  const names = rows.map((r) => r.account.name)
  const axis = axisLabels(keys, 'month', opts.axisWidth ?? ASSETS_AXIS_W)
  // 只有一个月（时间段选了「本月」）：一个点的面积图什么都画不出来，换成一根堆叠柱
  const single = keys.length === 1

  return {
    ...base,
    // cat=all：流水页收到 cat 才重设筛选，不带的话上次留下的分类筛选还在
    onPoint: (i) => (keys[i] ? `ym=${keys[i]}&cat=all` : null),
    option: {
      color: rows.map((r) => r.color),
      legend: {
        data: names,
        top: 0,
        width: opts.chartWidth ?? ASSETS_CHART_W,
        itemWidth: 14,
        itemHeight: 8,
        itemGap: 10,
        textStyle: { fontSize: 11 },
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number; marker: string; seriesName: string; value: number }[]) => {
          if (!ps.length) return ''
          const i = ps[0].dataIndex
          const lines = ps
            .filter((p) => p.value !== 0)
            // 账户名是用户自己起的：叫「<Steam>钱包」不转义，提示框里就只剩「钱包」
            .map((p) => `${p.marker}${esc(p.seriesName)}<span style="${RIGHT}">${yuan(p.value)}</span>`)
          const sum = `<span style="opacity:.75">合计</span><span style="${RIGHT}">${yuan(total[i] ?? 0)}</span>`
          return [`${fmtMonthZh(keys[i])}底`, ...lines, sum].join('<br/>') + TAP
        },
      },
      grid: { left: 4, right: 14, top: gridTopFor(legendRows(names, opts.chartWidth ?? ASSETS_CHART_W)), bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: axis.text,
        boundaryGap: single,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => axis.show[i] ?? false },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
      series: rows.map((r) =>
        single
          ? { name: r.account.name, type: 'bar', stack: 'assets', barMaxWidth: 40, itemStyle: { borderColor: CHART.gap, borderWidth: 1 }, data: r.data }
          : {
              name: r.account.name,
              type: 'line',
              stack: 'assets',
              showSymbol: false,
              lineStyle: { width: 1 },
              areaStyle: { opacity: 0.75 },
              // 单位是分；轴和提示框自己换成元
              data: r.data,
            },
      ),
    },
  }
}

export default assetsChart
