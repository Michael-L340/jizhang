// 进阶统计 ·「吃饭占多少」：到所选月份为止的 12 个月，每个月吃饭的钱占当月全部支出的几成（恩格尔系数那个意思）。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 分母 = 当月全部支出（compute.monthSummary 的口径：转账、还白条、校准、收入一律不进，查不到分类的也算支出）。
// 分子 = 「像吃饭」的分类的支出：**二级也认**。用户真实的分类是「日常开支 › 午餐 / 早餐 / 通勤交通」，
// 只认一级的话一个都对不上（2026-09-29 审出来的）：一级名字像吃饭 → 它底下全算；二级名字像吃饭 → 只算它那一笔。
import { monthSummary, UNCATEGORIZED_ID } from '../compute'
import { axisLabels } from '../chart'
import { lastMonths, monthOf } from '../date'
import { fmtYuan } from '../money'
import { categoryColor, CHART } from '../palette'
import type { Category, Transaction } from '../../types'
import { esc } from './html'
import { monthSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

export const ENGEL_MONTHS = 12
/** 「吃饭」认名字：分类名里带这几个词之一（「日常餐饮」「午餐」「早饭」「夜宵」「外卖」「奶茶」「咖啡」） */
export const FOOD_WORDS = ['餐', '饮', '吃', '饭', '早', '午', '晚', '宵', '外卖', '奶茶', '咖啡', '零食', '水果'] as const
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（393 − 64 − 44，和统计页的兜底一致） */
export const ENGEL_AXIS_W = 285
export const ENGEL_TITLE = '吃饭占多少'

const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'
const pct = (r: number) => `${Math.round(r * 100)}%`

export const isFoodName = (name: string): boolean => FOOD_WORDS.some((w) => name.includes(w))

/**
 * 名字像吃饭的支出分类，一级二级都算，**归档了的也算**：归档只是不再往里记，以前记在里面的饭钱还是饭钱——
 * 漏掉的话，换过一次分类的人，换之前那几个月的吃饭占比全成了 0。
 */
export function foodCats(cats: Category[]): Category[] {
  return cats.filter((c) => c.kind === 'expense' && isFoodName(c.name))
}

export interface EngelPick {
  /** 算进分子的分类 id（一级或二级，一级命中时它的二级不再单列） */
  ids: string[]
  /** 它们的名字（提示框、说明用），12 个月合计大的在前 */
  names: string[]
  /** true = 没有名字像吃饭的分类，退而看 12 个月花得最多的那个一级分类 */
  fallback: boolean
  /** 跳流水时能筛到的那一级：命中的正好是一个一级分类（含它的二级）时是它的 id，否则 null（只能筛到「支出」） */
  rootId: string | null
}

export interface EngelRow {
  ym: string
  /** 分子：这几类的支出（分） */
  part: number
  /** 分母：当月全部支出（分）= monthSummary(txs, ym).expense */
  total: number
  /** 0–1；当月一分支出都没有时 null（图上断开） */
  rate: number | null
}

/** 一笔支出的一级 / 自己：查不到分类就都是 undefined；二级的父类查不到就把它自己当一级（compute.byCategory 同一个口径） */
function catsOf(t: Transaction, byId: Map<string, Category>): { cat: Category | undefined; root: Category | undefined } {
  const cat = t.category_id ? byId.get(t.category_id) : undefined
  const root = cat ? (cat.parent_id ? byId.get(cat.parent_id) ?? cat : cat) : undefined
  return { cat, root }
}

export function engelRows(inp: Pick<MoreInput, 'txs' | 'cats' | 'ym'>): { pick: EngelPick | null; rows: EngelRow[] } {
  const months = lastMonths(ENGEL_MONTHS, inp.ym)
  const at = new Map(months.map((m, i) => [m, i]))
  const byId = new Map(inp.cats.map((c) => [c.id, c]))
  const food = foodCats(inp.cats)
  const foodIds = new Set(food.map((c) => c.id))
  // 一级命中 → 底下全算；二级命中 → 只算它。这一笔算不算，看它自己或它的一级在不在命中的名单里
  const isFood = (t: Transaction): boolean => {
    const { cat, root } = catsOf(t, byId)
    return Boolean((cat && foodIds.has(cat.id)) || (root && foodIds.has(root.id)))
  }

  // 12 个月里每个一级分类一共花了多少（选退路用）；每个命中的分类各花了多少（名字排序用）
  const rootYearly = new Map<string, { name: string; amount: number }>()
  const hitYearly = new Map<string, number>()
  const totals = months.map(() => 0)
  const parts = months.map(() => 0)
  for (const t of inp.txs) {
    if (t.type !== 'expense') continue
    const i = at.get(monthOf(t.date))
    if (i === undefined) continue
    totals[i] += t.amount
    const { cat, root } = catsOf(t, byId)
    const rid = root ? root.id : UNCATEGORIZED_ID
    const e = rootYearly.get(rid) ?? { name: root ? root.name : '', amount: 0 }
    e.amount += t.amount
    rootYearly.set(rid, e)
    if (isFood(t)) {
      parts[i] += t.amount
      // 一级命中就记在一级头上：「日常餐饮 › 午餐」两个都像吃饭，午餐的钱要算进「日常餐饮」排名次（它不单列）
      const hit = root && foodIds.has(root.id) ? root.id : cat!.id
      hitYearly.set(hit, (hitYearly.get(hit) ?? 0) + t.amount)
    }
  }

  let pick: EngelPick | null = null
  if (food.length) {
    // 一级命中了，它的二级不再单列（说明里写「日常餐饮」就够了，不用再列午餐晚餐）
    const top = food.filter((c) => !(c.parent_id && foodIds.has(c.parent_id)))
    const sorted = [...top].sort((a, b) => (hitYearly.get(b.id) ?? 0) - (hitYearly.get(a.id) ?? 0) || a.sort - b.sort || (a.id < b.id ? -1 : 1))
    const rootId = sorted.length === 1 && sorted[0].parent_id === null ? sorted[0].id : null
    pick = { ids: sorted.map((c) => c.id), names: sorted.map((c) => c.name), fallback: false, rootId }
  } else {
    // 一个都认不出来：取 12 个月合计最大的那个一级分类。「未分类」不是一个分类，不当候选
    const best = [...rootYearly.entries()]
      .filter(([id, e]) => id !== UNCATEGORIZED_ID && e.amount > 0)
      .sort((a, b) => b[1].amount - a[1].amount || (a[0] < b[0] ? -1 : 1))[0]
    if (best) {
      pick = { ids: [best[0]], names: [best[1].name], fallback: true, rootId: best[0] }
      for (const t of inp.txs) {
        if (t.type !== 'expense') continue
        const i = at.get(monthOf(t.date))
        if (i === undefined) continue
        const { root } = catsOf(t, byId)
        if (root?.id === best[0]) parts[i] += t.amount
      }
    }
  }

  const rows = months.map((ym, i) => ({ ym, part: parts[i], total: totals[i], rate: totals[i] > 0 ? parts[i] / totals[i] : null }))
  return { pick, rows }
}

/** 12 个月合起来 = 分子合计 ÷ 分母合计（按钱算，不是 12 个百分比直接平均）；12 个月一分支出都没有 → null */
export function overallShare(rows: EngelRow[]): number | null {
  const total = rows.reduce((s, r) => s + r.total, 0)
  return total > 0 ? rows.reduce((s, r) => s + r.part, 0) / total : null
}

export function engel(inp: MoreInput, axisWidth = ENGEL_AXIS_W): MoreChart {
  const { pick, rows } = engelRows(inp)
  const quoted = (pick?.names ?? []).map((n) => `「${n}」`).join('')
  const how = '一级命中的整个大类都算，二级命中的只算它那一项；没有支出的月份线断开。12 个月平均按钱算：这 12 个月它的合计 ÷ 全部支出合计。转账、还白条、校准不算。'
  const base = {
    key: 'engel',
    // 标题固定：「自定义」清单和卡片上得是同一个名字，找不到「吃饭」时在说明里写清楚改看了什么
    title: ENGEL_TITLE,
    // 不看时间段按钮：永远是到所选月份为止的 12 个月
    span: monthSpan(rows[0].ym, inp.ym),
    note: pick?.fallback
      ? `没有名字像吃饭的支出分类（带「餐」「饮」「吃」「饭」「早」「午」「晚」「宵」「外卖」这类字），改看这 12 个月花得最多的${quoted}占全部支出的几成。${how}`
      : `名字像吃饭的支出分类${quoted ? `（${quoted}）` : ''}每个月占全部支出的几成。${how}`,
  }
  if (rows.every((r) => r.total === 0)) return { ...base, option: null, empty: `这 ${ENGEL_MONTHS} 个月没有支出记录` }
  if (!pick) return { ...base, option: null, empty: `这 ${ENGEL_MONTHS} 个月的支出都没记分类，算不出占比` }

  const cur = rows[rows.length - 1]
  const all = overallShare(rows)
  // 看的不是这个月时别写「本月」：翻到 8 月写「本月」，说的是 8 月还是 9 月？
  const curLabel = inp.ym === monthOf(inp.today) ? '本月' : `${+inp.ym.slice(5)}月`
  const tiles: MoreTile[] = [
    { label: curLabel, value: cur.rate === null ? '—' : pct(cur.rate) },
    { label: `${ENGEL_MONTHS} 个月平均`, value: all === null ? '—' : pct(all) },
  ]

  const keys = rows.map((r) => r.ym)
  const axis = axisLabels(keys, 'month', axisWidth)
  // 线的颜色 = 这一类在饼图上的颜色（名字认色；认不出按名次兜底，它是 12 个月里最大的，名次记 0）
  // 颜色跟着排第一那一项的**一级**走：命中的是二级「午餐」时，名字认不出颜色、饼图上也没有「午餐」这一块，
  // 用它的一级（「日常开支」）才和饼图对得上
  const firstCat = inp.cats.find((c) => c.id === pick.ids[0])
  const firstRoot = firstCat?.parent_id ? inp.cats.find((c) => c.id === firstCat.parent_id) ?? firstCat : firstCat
  const color = categoryColor(firstRoot?.name ?? pick.names[0], 0)
  const partName = pick.fallback ? pick.names[0] : pick.names.length === 1 ? pick.names[0] : '吃饭'
  // 流水页：正好命中一个一级分类就筛到它；别的情况只能筛到「支出」。cat 必须带（流水页收到 cat 才重设筛选）
  const catQ = pick.rootId ? `type=expense&cat=${pick.rootId}` : 'type=expense&cat=all'
  // 没有支出的月份不跳：跳过去是一页空的流水
  const onPoint = (dataIndex: number): string | null => (rows[dataIndex] && rows[dataIndex].rate !== null ? `ym=${keys[dataIndex]}&${catQ}` : null)

  return {
    ...base,
    tiles,
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        formatter: (ps: { dataIndex: number }[]) => {
          if (!ps.length) return ''
          const r = rows[ps[0].dataIndex]
          if (!r) return ''
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          return (
            [
              `${r.ym.slice(0, 4)}年${+r.ym.slice(5)}月`,
              line('占比', r.rate === null ? '这个月没有支出' : pct(r.rate)),
              line(esc(partName), `¥${fmtYuan(r.part)}`),
              line('全部支出', `¥${fmtYuan(r.total)}`),
            ].join('<br/>') + (onPoint(ps[0].dataIndex) ? TAP : '')
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
        min: 0,
        splitLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 10, color: CHART.label, formatter: (v: number) => `${v}%` },
      },
      series: [
        {
          name: partName,
          type: 'line',
          color,
          // 没支出的月份是 null：断开，不连过去——连过去等于替那个月编了一个占比
          connectNulls: false,
          showSymbol: true,
          symbolSize: 6,
          lineStyle: { width: 2.5 },
          areaStyle: { opacity: 0.1 },
          data: rows.map((r) => (r.rate === null ? null : Math.round(r.rate * 1000) / 10)),
        },
      ],
    },
    onPoint,
  }
}

/** 分母口径的自查：和 monthSummary 一致（测试用） */
export const expenseOf = (txs: Transaction[], ym: string): number => monthSummary(txs, ym).expense
