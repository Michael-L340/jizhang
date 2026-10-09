// 进阶统计 · 支出大类对比：所选月份 vs 上个月（雷达图）。
// 标题不写「五大类」「本月」：用户加了第六个一级分类就是六条轴，翻到 8 月看的就是 8 月（月份写在标题旁）。
//
// 轴 = 没归档的一级支出分类，按分类管理页里的顺序（sort）排——轴的位置要固定，
// 按金额排的话每个月轴都在转，两个月的形状根本没法比。
// 两个多边形：所选月份实线填充（支出色），上个月虚线（muted）不填充。
// **几条轴共用一把尺子**：最大值取两个月所有类里最大的那个，向上取整到整百元。
// 各轴各自缩放的话，花 30 块的类和花 3000 块的类会画得一样满，形状就是假的。
import { shortLabels } from '../chart'
import { byCategory } from '../compute'
import { shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'
import { esc } from './html'

const KEY = 'radar'
const TITLE = '支出大类对比'
const NOTE = '实线是所选月份，虚线是上个月；只算没归档的一级支出分类。几条轴用同一把尺子，花得多的类就画得远。'

/** 少于这么多条轴画不成雷达图：两条轴是一根线，一条轴是一个点 */
export const RADAR_MIN_AXES = 3
/** 轴最大值向上取整的单位：100 元 = 10000 分 */
export const RADAR_STEP = 10000

const yuan = (cents: number) => fmtYuan(cents, { symbol: true })
const monthLabel = (ym: string) => `${+ym.slice(5)}月`

export function radarChart(inp: MoreInput): MoreChart {
  const base = { key: KEY, title: TITLE, span: monthSpan(inp.ym, inp.ym), note: NOTE }
  const axes = inp.cats
    .filter((c) => c.kind === 'expense' && c.parent_id === null && !c.is_archived)
    .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (axes.length < RADAR_MIN_AXES) return { ...base, option: null, empty: '一级支出分类不到 3 个，画不成雷达图' }

  const prevYm = shiftMonth(inp.ym, -1)
  // 二级算进它的一级、transfer / adjust / 收入不算：全交给 byCategory，和统计页饼图同一个口径
  const valuesOf = (ym: string) => {
    const m = new Map(byCategory(inp.txs, inp.cats, ym, 'expense').map((a) => [a.id, a.amount]))
    // 「抵消」能让某一类净额为负，雷达图从 0 画起，负的按 0
    return axes.map((c) => Math.max(0, m.get(c.id) ?? 0))
  }
  const cur = valuesOf(inp.ym)
  const prev = valuesOf(prevYm)
  const top = Math.max(...cur, ...prev)
  if (top <= 0) return { ...base, option: null, empty: '这个月和上个月都没有支出' }
  const max = Math.ceil(top / RADAR_STEP) * RADAR_STEP

  const curName = monthLabel(inp.ym)
  const prevName = monthLabel(prevYm)
  const fullNames = axes.map((c) => c.name)
  const short = shortLabels(fullNames)

  return {
    ...base,
    height: 260,
    option: {
      legend: { data: [curName, prevName], bottom: 0, itemWidth: 14, itemHeight: 8, itemGap: 16, textStyle: { fontSize: 11, color: CHART.label } },
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { name: string; value: number[] }) =>
          [esc(p.name), ...fullNames.map((n, i) => `${esc(n)}<span style="float:right;margin-left:16px;font-weight:600">${yuan(p.value[i] ?? 0)}</span>`)].join('<br/>'),
      },
      radar: {
        indicator: axes.map((_, i) => ({ name: short[i], max, min: 0 })),
        center: ['50%', '48%'],
        radius: '64%',
        splitNumber: 4,
        axisName: { color: CHART.label, fontSize: 11 },
        axisLine: { lineStyle: { color: CHART.axis } },
        splitLine: { lineStyle: { color: CHART.axis } },
        splitArea: { show: false },
      },
      series: [
        {
          type: 'radar',
          symbolSize: 5,
          // 上个月先画、本月后画：本月压在上面
          data: [
            {
              name: prevName,
              value: prev,
              lineStyle: { color: CHART.label, type: 'dashed', width: 1.5 },
              itemStyle: { color: CHART.label },
            },
            {
              name: curName,
              value: cur,
              lineStyle: { color: CHART.expense, type: 'solid', width: 2 },
              itemStyle: { color: CHART.expense },
              areaStyle: { color: CHART.expense, opacity: 0.2 },
            },
          ],
        },
      ],
    },
  }
}

export default radarChart
