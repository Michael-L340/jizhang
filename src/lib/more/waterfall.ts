// 进阶统计·钱去哪了（瀑布图）：所选月份的收入一根柱起步，按支出大类从大到小一段段往下扣，最后落在「结余」。
// 标题不写「这个月」：翻到 8 月看的是 8 月（月份写在标题旁）。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 收入 / 支出走 compute.monthSummary / byCategory：转账（含还白条）、校准一律不进。
import { byCategory, monthSummary, UNCATEGORIZED_ID } from '../compute'
import { shortLabels, textWidth } from '../chart'
import { fmtYuan } from '../money'
import { categoryColor, CHART } from '../palette'
import { monthSpan } from './span'
import type { MoreChart, MoreInput } from './types'

const yuan = (v: number) => `¥${fmtYuan(Math.round(v * 100))}`
const axisMoney = (v: number) => (Math.abs(v) >= 10000 ? `${+(v / 10000).toFixed(1)}万` : String(v))
const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'

/** 最多单列几个大类；再多的并成一根「其余」，一屏八根柱子已经是手机宽度的上限 */
export const MAX_CATS = 6
export const REST_ID = '__rest__'
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（393 − 64 − 44，和统计页的兜底一致） */
export const WATERFALL_AXIS_W = 285
/** x 轴标签字号 */
const LABEL_FONT = 10

/**
 * x 轴标签：一根柱子分到的宽度装得下就一行，装不下就从中间折成两行（「日常\n餐饮」）。
 * 原来写死 width 36 + truncate，10 px 的四个汉字要 40 px，用户五大类里的「日常餐饮」「学习提升」
 * 每次都只剩「日常…」。shortLabels 只会剥「消费 / 开支 / 支出 / 生活」这几个后缀，这两个剥不短。
 * 折成两行还装不下（七八个字的自建分类）才交给 ECharts 截断，全名在提示框里。
 */
export function wrapLabel(name: string, slot: number, fontSize = LABEL_FONT): string {
  const room = slot - 4
  const chars = [...name]
  if (textWidth(name, fontSize) <= room || chars.length < 2) return name
  const cut = Math.ceil(chars.length / 2)
  return `${chars.slice(0, cut).join('').trimEnd()}\n${chars.slice(cut).join('').trimStart()}`
}

export interface Step {
  /** 'income' | 分类 id | REST_ID | 'net' */
  id: string
  /** 全名（提示框用） */
  name: string
  /** 这一根柱子的底和顶（分）。收入：0→收入；每个大类：扣完之后→扣之前；结余：0→结余（可能为负，顶在 0） */
  lo: number
  hi: number
  /** 这一段的金额（分）：收入 / 该类支出 / 结余（可为负） */
  amount: number
  color: string
}

/**
 * 算出每一根柱子的上下沿。**相邻两根首尾相接**：第 k 个大类的顶 = 前一根的底（收入那根的顶），
 * 最后一个大类的底 = 结余。这是瀑布图的全部意思，waterfall.test.ts 拿随机账本守着它。
 */
export function waterfallSteps(inp: Pick<MoreInput, 'txs' | 'cats' | 'ym'>): Step[] | null {
  const sum = monthSummary(inp.txs, inp.ym)
  if (sum.income === 0 && sum.expense === 0) return null
  const aggs = byCategory(inp.txs, inp.cats, inp.ym, 'expense')
  const steps: Step[] = [{ id: 'income', name: '收入', lo: 0, hi: sum.income, amount: sum.income, color: CHART.income }]
  let running = sum.income
  const push = (id: string, name: string, amount: number, color: string) => {
    steps.push({ id, name, lo: running - amount, hi: running, amount, color })
    running -= amount
  }
  // 颜色按饼图的发法：名字认色，认不出来按名次取备用色——同一个月里和饼图同一个颜色
  aggs.slice(0, MAX_CATS).forEach((a, i) => push(a.id, a.name, a.amount, categoryColor(a.name, i)))
  const rest = aggs.slice(MAX_CATS)
  if (rest.length) push(REST_ID, `其余 ${rest.length} 类`, rest.reduce((s, a) => s + a.amount, 0), CHART.label)
  steps.push({
    id: 'net',
    name: '结余',
    lo: Math.min(0, running),
    hi: Math.max(0, running),
    amount: running,
    color: running >= 0 ? CHART.income : CHART.expense,
  })
  return steps
}

export function waterfall(inp: MoreInput, axisWidth = WATERFALL_AXIS_W): MoreChart {
  const base = {
    key: 'waterfall',
    title: '钱去哪了',
    span: monthSpan(inp.ym, inp.ym),
    note: '收入起步，按支出大类从大到小一段段扣掉，最后剩下的是结余（负数 = 花超了）。转账、还白条、校准不算。',
  }
  const steps = waterfallSteps(inp)
  if (!steps) return { ...base, option: null, empty: '这个月没有收入也没有支出' }

  const income = steps[0].amount
  const expense = steps.filter((s) => s.id !== 'income' && s.id !== 'net').reduce((t, s) => t + s.amount, 0)
  // x 轴用缩写（「非经常生活消费」→「非经常」），提示框里是全名
  const mid = steps.slice(1, -1)
  const short = shortLabels(mid.map((s) => s.name))
  const labels = ['收入', ...short, '结余']
  // 每根柱子分到的宽度：绘图区宽 ÷ 柱数（category 轴每格等宽）
  const slot = axisWidth / labels.length

  // 流水页只有带着 cat 时才重设筛选（lib/filter.ts 的 filterFromQuery），所以每根柱子都带 cat：
  // 不带的话，先点过「日常餐饮」再点「收入」，流水页还筛着日常餐饮，一笔收入都看不到。
  // cat=all = 不筛分类；收入那根再带 type=income，其余 / 未分类那几根带 type=expense
  const onPoint = (dataIndex: number): string | null => {
    const s = steps[dataIndex]
    if (!s) return null
    if (s.id === 'income') return `ym=${inp.ym}&type=income&cat=all`
    if (s.id === 'net') return `ym=${inp.ym}&cat=all`
    if (s.id === REST_ID) return `ym=${inp.ym}&type=expense&cat=all`
    return `ym=${inp.ym}&type=expense&cat=${s.id === UNCATEGORIZED_ID ? 'none' : s.id}`
  }

  return {
    ...base,
    height: 240,
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          if (!ps.length) return ''
          const s = steps[ps[0].dataIndex]
          if (!s) return ''
          const head = `${s.name}<span style="${RIGHT}">${s.id === 'net' && s.amount < 0 ? '-' : ''}${yuan(Math.abs(s.amount) / 100)}</span>`
          const rows = [head]
          if (s.id !== 'income' && s.id !== 'net') {
            if (expense > 0) rows.push(`<span style="opacity:.75">占支出</span><span style="${RIGHT}">${Math.round((s.amount / expense) * 100)}%</span>`)
            rows.push(`<span style="opacity:.75">扣完还剩</span><span style="${RIGHT}">${s.lo < 0 ? '-' : ''}${yuan(Math.abs(s.lo) / 100)}</span>`)
          } else if (s.id === 'net' && income > 0) {
            rows.push(`<span style="opacity:.75">储蓄率</span><span style="${RIGHT}">${Math.round((s.amount / income) * 100)}%</span>`)
          }
          return rows.join('<br/>') + (onPoint(ps[0].dataIndex) ? TAP : '')
        },
      },
      grid: { left: 4, right: 10, top: 20, bottom: 0, containLabel: true },
      xAxis: {
        type: 'category',
        data: labels,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: {
          fontSize: LABEL_FONT,
          color: CHART.label,
          interval: 0,
          lineHeight: 12,
          width: Math.max(12, Math.floor(slot) - 2),
          overflow: 'truncate',
          formatter: (v: string) => wrapLabel(v, slot),
        },
      },
      yAxis: { type: 'value', splitLine: { lineStyle: { color: CHART.axis } }, axisLabel: { fontSize: 10, color: CHART.label, formatter: axisMoney } },
      series: [
        // 透明垫底：把实体柱托到「扣之前」那个高度。
        // stackStrategy 'all'：ECharts 默认只把同号的值叠在一起，花超了之后垫底是负的、实体是正的，
        // 默认策略下两段各自从 0 起画，跨过 0 的那一根会断开。'all' 让它们照样首尾相接。
        {
          name: '垫底',
          type: 'bar',
          stack: 'w',
          stackStrategy: 'all',
          silent: true,
          itemStyle: { color: 'transparent' },
          emphasis: { disabled: true },
          tooltip: { show: false },
          data: steps.map((s) => s.lo / 100),
        },
        {
          name: '金额',
          type: 'bar',
          stack: 'w',
          stackStrategy: 'all',
          barMaxWidth: 28,
          label: {
            show: true,
            position: 'top',
            fontSize: 9,
            color: CHART.label,
            formatter: (p: { dataIndex: number }) => {
              const s = steps[p.dataIndex]
              return s ? axisMoney(Math.round(s.amount / 100)) : ''
            },
          },
          data: steps.map((s) => ({ value: (s.hi - s.lo) / 100, itemStyle: { color: s.color } })),
        },
      ],
    },
    onPoint,
  }
}
