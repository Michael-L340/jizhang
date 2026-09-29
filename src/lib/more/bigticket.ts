// 进阶统计 ·「大额消费」：这段时间里单笔 500 元及以上的支出，一笔一个圈，排在一条时间线上，圈越大钱越多。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'：转账（含还白条）、校准、收入一律不进（compute.isFlow 的口径）。
// 白条分期的订单按下单那天整笔算（CLAUDE.md：下单记支出）。
//
// 坐标用 singleAxis（一条横轴，没有 y 轴），**不用 xAxis + 只有一行的 yAxis**：
// 进阶分析页按「option 里有没有 xAxis」决定怎么接点击（registry.pointMode）。有 xAxis 就是「点绘图区、取最近的 x 下标」，
// 近一年 365 天挤在不到 300 px 里，一天不到 1 px，手指按在圈上也会落到隔几天的空日子；
// Chart 还拿那个下标去 showTip 第 0 个系列的「第几个点」——散点只有寥寥几个，下标根本对不上。
// 没有 xAxis 就走「点中哪个圈算哪个」（和消费日历同一条路），第二下落在第一下 10 px 之内就跳流水。
//
// 纵向错开（审阅 #11：一年十几个圈全压在一条线上叠成一坨）：singleAxis 没有 y，**不改坐标系**，
// 而是给每个圈一个 symbolOffset [0, dy]——按 log(金额) 在这段时间最小～最大之间的位置往上抬，钱越多越高。
// symbolOffset 挪的是圈本身（ECharts 把它记在 symbolPath 的 x / y 上），点击判定跟着挪，
// 所以「点中哪个圈算哪个」照旧成立（bigticket.test.ts 用 SSR 在每个圈画出来的圆心上点一下验过）。
// 换成 xAxis + 隐藏的 value y 轴也能错开，但 registry.pointMode 会把它当成「点绘图区取最近的 x 下标」，一天不到 1 px，点不中。
import { bucketKeys, UNCATEGORIZED_NAME } from '../compute'
import { axisLabels } from '../chart'
import { fmtDateZh, monthOf } from '../date'
import { fmtYuan } from '../money'
import { categoryColor, CHART } from '../palette'
import type { Category, Transaction } from '../../types'
import { esc } from './html'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

/** 多大算「大额」：500 元（分），正好 500 元也算 */
export const BIG_CENTS = 50000
/** 圈的直径（px）：最大那一笔 40，再小也不小于 8（手指点得中） */
export const SIZE_MIN = 8
export const SIZE_MAX = 40
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（393 − 页面和卡片内边距 64） */
export const BIGTICKET_CHART_W = 329
/**
 * 横轴左右留白（px）：最大那个圈的半径再多 2 px。没有 y 轴，但范围第一天 / 最后一天的圈会探出去半个身位，
 * 留 12 px 时 SSR 实测 40 px 的圈被卡片边切掉一块，第一个标签「25/10/1」也只剩「5/10/1」。
 */
export const AXIS_PAD = SIZE_MAX / 2 + 2
/** 卡片上这张图的高度，和 singleAxis 上下留白：中间那条 BAND 高的带子就是圈能待的地方（下沿是轴线） */
export const BIGTICKET_H = 120
const AXIS_TOP = 6
const AXIS_BOTTOM = 24
export const BAND = BIGTICKET_H - AXIS_TOP - AXIS_BOTTOM
/** 提示框里备注最多显示几个字，多的写「…」（一整段备注能把提示框撑得比屏幕还宽） */
export const NOTE_MAX = 16

const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'

/**
 * 范围内（含两端）单笔 ≥ BIG_CENTS 的支出。
 * **小的在前、大的在后**：散点按数据顺序画，后画的压在上面——大的最后画、浮在最上面（审阅 #11）。
 * 原来是大的在前（让小圈压在大圈上），可近一年十几个圈挤在一起时，最该看见的那几笔大钱反而被压在底下。
 * 现在圈按金额纵向错开（liftOf），同一天一大一小也是一高一低，小的那个露在大的下面，照样点得到。
 * 一样大按日期、录入时刻、id 排，顺序是定的：onPoint 和提示框都拿 dataIndex 回这张表里取这一笔，
 * 图上的 data 也是按这张表的顺序生成的，三处同一个下标。
 */
export function bigTickets(txs: Transaction[], start: string, end: string): Transaction[] {
  return txs
    .filter((t) => t.type === 'expense' && t.date >= start && t.date <= end && t.amount >= BIG_CENTS)
    .sort(
      (a, b) =>
        a.amount - b.amount ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
}

/**
 * 圈的直径：**面积**跟金额成正比（直径 ∝ √金额），最大那一笔 = SIZE_MAX，小到 SIZE_MIN 为止。
 * 不按直径正比：那样 2000 块的圈看上去是 1000 块的四倍大。
 * 也不把「最小那笔 → 8、最大那笔 → 40」线性拉满：只有 500 和 600 两笔时，一个 8 一个 40，差 20% 画成差 25 倍。
 */
export function symbolSizeOf(amount: number, max: number): number {
  if (max <= 0) return SIZE_MIN
  const d = SIZE_MAX * Math.sqrt(amount / max)
  return Math.round(Math.max(SIZE_MIN, Math.min(SIZE_MAX, d)) * 10) / 10
}

/**
 * 圈心离带子中线往下多少 px（负 = 往上），给 symbolOffset 用。
 * 按 log(金额) 在这段时间最小（lo）～最大（hi）之间的位置 f：f = 1 的圈心在「最大的圈贴着带子顶」那一高度，
 * f = 0 的圈底贴着轴线（留 1 px）。用 log：5000 和 500 差十倍，线性的话中间那几笔全挤在底下。
 * 上端点对谁都一样、下端点按这个圈自己的大小算，所以**钱越多圈心越高**（f 和圈的大小都跟着钱涨，两头都往上推），
 * 任何一个圈都不探出带子。只有一种金额（lo = hi）就放在一半的高度。
 */
export function liftOf(amount: number, lo: number, hi: number, size: number): number {
  const f = hi > lo ? Math.max(0, Math.min(1, Math.log(amount / lo) / Math.log(hi / lo))) : 0.5
  const top = SIZE_MAX / 2 + 1
  const bottom = BAND - size / 2 - 1
  const y = top + (1 - f) * (bottom - top)
  return Math.round((y - BAND / 2) * 10) / 10
}

/** 备注截到 NOTE_MAX 个字（按字数，不按 UTF-16：「𠮷」是一个字），多的写「…」 */
export function clipNote(s: string): string {
  const chars = [...s]
  return chars.length > NOTE_MAX ? `${chars.slice(0, NOTE_MAX).join('')}…` : s
}

/** 分类的一级（记在二级上的往上找一层）；查不到就是 undefined（未分类） */
function rootOf(t: Transaction, byId: Map<string, Category>): { cat: Category | undefined; root: Category | undefined } {
  const cat = t.category_id ? byId.get(t.category_id) : undefined
  const root = cat ? (cat.parent_id ? byId.get(cat.parent_id) ?? cat : cat) : undefined
  return { cat, root }
}

/** 提示框里的分类：记在二级上写「日常餐饮 · 晚餐」，一级写「日常餐饮」，查不到写「未分类」 */
export function catLabel(t: Transaction, byId: Map<string, Category>): string {
  const { cat, root } = rootOf(t, byId)
  if (!cat || !root) return UNCATEGORIZED_NAME
  return cat.id === root.id ? cat.name : `${root.name} · ${cat.name}`
}

export function bigticket(inp: MoreInput, chartWidth = BIGTICKET_CHART_W): MoreChart {
  const { start, end } = inp
  const base = {
    key: 'bigticket',
    title: '大额消费',
    span: rangeSpan(start, end, inp.today),
    note: '这段时间每一笔 500 元及以上的支出（正好 500 也算），一笔一个圈，圈的面积跟金额成正比，颜色是它的一级分类。白条分期按下单那天整笔算；转账、还白条、校准不算。',
  }
  const list = bigTickets(inp.txs, start, end)
  if (!list.length) return { ...base, option: null, empty: '这段时间没有 500 元以上的单笔' }

  const byId = new Map(inp.cats.map((c) => [c.id, c]))
  // 颜色按一级分类：名字认得的用固定色，认不出来的按「这几笔里谁的合计大」排名次取备用色（和饼图同一个发法）
  const rootTotals = new Map<string, number>()
  for (const t of list) {
    const r = rootOf(t, byId).root
    if (r) rootTotals.set(r.id, (rootTotals.get(r.id) ?? 0) + t.amount)
  }
  const rank = new Map([...rootTotals.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([id], i) => [id, i]))
  const colorOf = (t: Transaction) => {
    const r = rootOf(t, byId).root
    return r ? categoryColor(r.name, rank.get(r.id) ?? 0) : CHART.label
  }

  const keys = bucketKeys(start, end, 'day')
  const at = new Map(keys.map((k, i) => [k, i]))
  const axis = axisLabels(keys, 'day', Math.max(1, chartWidth - AXIS_PAD * 2))
  const lo = list[0].amount
  const max = list[list.length - 1].amount
  // 时间段跨年（近一年、自定义跨年）时提示框里的日期带年份：「10月3日」看不出是哪一年的 10 月（年份永远带着是统计页规矩）
  const withYear = start.slice(0, 4) !== end.slice(0, 4)
  const dateText = (d: string) => (withYear ? `${+d.slice(0, 4)}年${fmtDateZh(d)}` : fmtDateZh(d))
  const sum = list.reduce((s, t) => s + t.amount, 0)

  const data = list.map((t) => {
    const size = symbolSizeOf(t.amount, max)
    return {
      // 图上的数一律是元（和统计页一样）；第二个值只给 ECharts 看，跳转和提示框都回 list 里取分
      value: [at.get(t.date) ?? 0, t.amount / 100],
      symbolSize: size,
      symbolOffset: [0, liftOf(t.amount, lo, max, size)],
      itemStyle: { color: colorOf(t) },
    }
  })

  const tiles: MoreTile[] = [
    { label: '大额笔数', value: `${list.length} 笔` },
    { label: '合计', value: `¥${fmtYuan(sum)}` },
  ]

  // cat=all：流水页收到 cat 才重设筛选，不带的话上次留下的分类筛选可能把这一笔筛掉
  const onPoint = (dataIndex: number): string | null => {
    const t = list[dataIndex]
    return t ? `ym=${monthOf(t.date)}&date=${t.date}&cat=all` : null
  }

  return {
    ...base,
    tiles,
    height: BIGTICKET_H,
    option: {
      tooltip: {
        trigger: 'item',
        confine: true,
        // 备注再长也折行、不把提示框撑出屏幕（ECharts 的提示框默认 white-space: nowrap）
        extraCssText: 'white-space:normal;max-width:240px',
        formatter: (p: { dataIndex: number }) => {
          const t = list[p.dataIndex]
          if (!t) return ''
          const note = t.note?.trim()
          // 先截再转义：反过来会把「&amp;」这种转义串从中间截断
          return (
            `${dateText(t.date)}<br/>${esc(catLabel(t, byId))}<span style="${RIGHT}">¥${fmtYuan(t.amount)}</span>` +
            (note ? `<br/><span style="opacity:.75">${esc(clipNote(note))}</span>` : '') +
            TAP
          )
        },
      },
      singleAxis: {
        type: 'category',
        data: axis.text,
        left: AXIS_PAD,
        right: AXIS_PAD,
        top: AXIS_TOP,
        bottom: AXIS_BOTTOM,
        boundaryGap: true,
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        splitLine: { show: false },
        // 年份永远带着（26/9/1），装不下就逐级降密度，同统计页 x 轴（chart.axisLabels）
        axisLabel: { fontSize: 10, color: CHART.label, interval: (i: number) => axis.show[i] ?? false },
      },
      series: [
        {
          name: '大额消费',
          type: 'scatter',
          coordinateSystem: 'singleAxis',
          // 半透明 + 白边：错开了高低还是会有叠着的（每月的房租一样高、挨着），叠住的那部分还看得出是两个圈
          itemStyle: { opacity: 0.65, borderColor: CHART.gap, borderWidth: 1.5 },
          emphasis: { scale: false, itemStyle: { opacity: 1 } },
          data,
        },
      ],
    },
    onPoint,
  }
}
