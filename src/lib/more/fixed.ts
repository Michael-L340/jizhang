// 进阶统计·固定开销：最近三个过完的月份里，每个月都雷打不动出现、金额也差不多、日子也差不多的那几项开销。
//
// 判定（isFixedGroup，单独测）：同一个分类 + 同一个账户，三个月
//   · 每月都有，且每月不超过 FIXED_MAX_COUNT 笔——天天一笔的吃饭、打车不是「固定开销」，是零碎开销；
//   · 拿每月最大的那一笔当代表（房租那个月又交了押金，代表还是房租；一次性多出来的那笔不搅局），
//     三个代表「最多 − 最少 ≤ 最多的 15%」；
//   · 三个代表的日子（几号）互相差不超过 FIXED_DAY_TOL 天（跨月末按圆算）：每月 1 号的房租、5 号的话费算，
//     6/18、7/20、8/8 各买一件数码不算——金额碰巧接近也不是固定开销（2026-09-29 审出来的）。
// 分类按这笔账记在哪一级就算哪一级：选了二级算二级（「房租」），直接记在一级上的算一级（「日常餐饮」）。
// 账户也要同一个：房租一直从中行扣，某个月改从微信付了，那就不是「每月固定从哪儿走」了。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只看 type === 'expense'：转账（含还白条）、校准一律不算——每月固定还一笔白条不是开销，买东西那一下才是。
import type { Account, Category, Transaction } from '../../types'
import { monthSummary, UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from '../compute'
import { lastMonths, monthOf, shiftMonth } from '../date'
import { fmtYuan } from '../money'
import { categoryColor, CHART } from '../palette'
import { esc } from './html'
import { monthSpan } from './span'
import type { MoreChart, MoreInput, MoreTile } from './types'

/** 看几个整月 */
export const FIXED_MONTHS = 3
/** 三个月的代表金额最多和最少差多少以内算「固定」：最多那个月的 15%（写成整数百分比，判定时全走整数，不碰浮点） */
export const FIXED_PCT = 15
/** 每月最多几笔（超过就是零碎开销） */
export const FIXED_MAX_COUNT = 3
/** 三个月的代表日子互相最多差几天 */
export const FIXED_DAY_TOL = 5

const RIGHT = 'float:right;margin-left:16px;font-weight:600'
const yuan = (cents: number) => fmtYuan(cents, { symbol: true })

/**
 * 看哪三个整月。所选月份已经过完 → 以它为最后一个月往前数三个；
 * 所选的是这个月（还没过完，今天是月底最后一天也算没过完）或者更往后 → 用这个月之前的三个整月。
 * 半个月的房租还没扣、话费还没交，拿进来比，每一项固定开销都会因为「这个月还没出现」被刷掉。
 */
export function fixedMonths(ym: string, today: string): string[] {
  const cur = monthOf(today)
  return lastMonths(FIXED_MONTHS, ym < cur ? ym : shiftMonth(cur, -1))
}

/**
 * 金额那一条：最多的那个月 > 0，且（最多 − 最少）× 100 ≤ 15 × 最多——整数比较，正好 15% 算固定。
 * 某个月一笔没有时代表是 0，最少的 0 离最多的差了 100%，自然过不了。
 */
export function isFixed(reps: number[]): boolean {
  if (!reps.length) return false
  const max = Math.max(...reps)
  const min = Math.min(...reps)
  return max > 0 && (max - min) * 100 <= FIXED_PCT * max
}

/** 两个「几号」隔几天（按 30 天一圈算：29 号和 2 号隔 3 天，不是 27 天） */
export function dayGap(a: number, b: number): number {
  const d = Math.abs(a - b)
  return Math.min(d, 30 - d)
}

/** 三个月的日子是不是都在 FIXED_DAY_TOL 天之内（两两比） */
export function daysClose(days: number[]): boolean {
  for (let i = 0; i < days.length; i++) for (let j = i + 1; j < days.length; j++) if (dayGap(days[i], days[j]) > FIXED_DAY_TOL) return false
  return true
}

export interface FixedGroup {
  /** 每月几笔 */
  counts: number[]
  /** 每月代表金额（那个月最大的一笔，分）；没有就是 0 */
  reps: number[]
  /** 代表那一笔的几号；没有就是 0 */
  days: number[]
}

/** 完整判定：每月 1–FIXED_MAX_COUNT 笔、代表金额差 ≤ 15%、日子差 ≤ FIXED_DAY_TOL 天 */
export function isFixedGroup(g: FixedGroup): boolean {
  if (g.counts.some((n) => n < 1 || n > FIXED_MAX_COUNT)) return false
  return isFixed(g.reps) && daysClose(g.days)
}

export interface FixedItem {
  /** 分类 id（记在几级就是几级）；查不到或没填 = UNCATEGORIZED_ID */
  categoryId: string
  /** 账户 id；null = 没指定账户 */
  accountId: string | null
  /** 条形图左边写的名字：分类名；撞名时先带一级名，再带账户名 */
  label: string
  /** 提示框里的全名：「经常生活开支 · 房租」 */
  fullName: string
  accountName: string
  /** 三个月各月的代表金额（分），和 months 一一对应 */
  monthly: number[]
  /** 代表那一笔的几号 */
  days: number[]
  /** 三个月代表金额合计（分） */
  total: number
  /** 月均（分）= total ÷ 3 四舍五入 */
  avg: number
  color: string
}

export interface FixedResult {
  months: string[]
  /** 按月均从大到小 */
  items: FixedItem[]
  /** 三个月的收入合计（分），算「占月均收入」用 */
  income: number
}

/** 分类 → 显示名、全名、颜色。颜色按一级：二级的浅色档（childShade）16px 的细条在白卡片上看不见 */
function catLook(cats: Category[]): (id: string) => { name: string; parent: string | null; full: string; color: string } {
  const byId = new Map(cats.map((c) => [c.id, c]))
  // 名字认不出的一级分类按它在分类表里的顺序取备用色，换个月份不会变色
  const roots = cats.filter((c) => !c.parent_id && c.kind === 'expense').sort((a, b) => a.sort - b.sort)
  const rootColor = (c: Category) => categoryColor(c.name, Math.max(0, roots.findIndex((r) => r.id === c.id)))
  return (id) => {
    const c = byId.get(id)
    if (!c) return { name: UNCATEGORIZED_NAME, parent: null, full: UNCATEGORIZED_NAME, color: CHART.label }
    const parent = c.parent_id ? byId.get(c.parent_id) : undefined
    if (!parent) return { name: c.name, parent: null, full: c.name, color: rootColor(c) }
    return { name: c.name, parent: parent.name, full: `${parent.name} · ${c.name}`, color: rootColor(parent) }
  }
}

export function findFixed(txs: Transaction[], cats: Category[], accounts: Account[], months: string[]): FixedResult {
  const at = new Map(months.map((m, i) => [m, i]))
  const known = new Set(cats.map((c) => c.id))
  const groups = new Map<string, { categoryId: string; accountId: string | null } & FixedGroup>()
  for (const t of txs) {
    if (t.type !== 'expense' || t.amount <= 0) continue // 「抵消」换过来的那笔是负的（compute.netFlow），不是一笔开销
    const i = at.get(monthOf(t.date))
    if (i === undefined) continue
    const categoryId = t.category_id && known.has(t.category_id) ? t.category_id : UNCATEGORIZED_ID
    const key = `${categoryId}|${t.account_id ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = { categoryId, accountId: t.account_id, counts: months.map(() => 0), reps: months.map(() => 0), days: months.map(() => 0) }
      groups.set(key, g)
    }
    g.counts[i] += 1
    const day = Number(t.date.slice(8, 10))
    // 代表 = 那个月最大的一笔；一样大取早的那笔（顺序定住，结果才可复现）
    if (t.amount > g.reps[i] || (t.amount === g.reps[i] && day < g.days[i])) {
      g.reps[i] = t.amount
      g.days[i] = day
    }
  }

  const look = catLook(cats)
  const accName = new Map(accounts.map((a) => [a.id, a.name]))
  const items: FixedItem[] = []
  for (const g of groups.values()) {
    if (!isFixedGroup(g)) continue
    const l = look(g.categoryId)
    const total = g.reps.reduce((s, v) => s + v, 0)
    items.push({
      categoryId: g.categoryId,
      accountId: g.accountId,
      label: l.name,
      fullName: l.full,
      accountName: g.accountId === null ? '未指定账户' : accName.get(g.accountId) ?? '其他账户',
      monthly: g.reps,
      days: g.days,
      total,
      avg: Math.round(total / months.length),
      color: l.color,
    })
  }
  items.sort((a, b) => b.total - a.total || (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0))
  // 撞名：两个大类下都有「其他」→ 先带一级名（「日常餐饮·其他」）；同一个分类从两个账户各固定走一笔 → 再带账户名
  // 一级名只在撞的是「别的分类」时才带：同一个分类两个账户，带上一级名也分不开，还把账户名挤到 96px 外面去
  // （「经常生活开支·房租·中国银行」「经常生活开支·房租·微信」截断后两行都是「经常生活开支·房…」）
  const clashWithOtherCat = (it: FixedItem) => items.some((o) => o !== it && o.label === it.label && o.categoryId !== it.categoryId)
  const withParent = new Set(items.filter(clashWithOtherCat))
  for (const it of withParent) it.label = it.fullName.replace(' · ', '·')
  const seen = new Map<string, number>()
  for (const it of items) seen.set(it.label, (seen.get(it.label) ?? 0) + 1)
  for (const it of items) if ((seen.get(it.label) ?? 0) > 1) it.label = `${it.label}·${it.accountName}`

  const income = months.reduce((s, m) => s + monthSummary(txs, m).income, 0)
  return { months, items, income }
}

/** 条形图每一行多高（px），加上上下留白就是整张图的高度 */
const ROW_H = 30

export function fixedChart(inp: MoreInput): MoreChart {
  const months = fixedMonths(inp.ym, inp.today)
  const base = {
    key: 'fixed',
    title: '固定开销',
    // 这张图看的不是所选月份本身（这个月没过完就往前挪一个月），标题旁写清楚是哪三个月
    span: monthSpan(months[0], months[months.length - 1]),
    note: `看最近三个过完的月份：同一个分类、同一个账户，三个月每月都有（每月不超过 ${FIXED_MAX_COUNT} 笔），每月最大的那一笔金额相差不超过 ${FIXED_PCT}%、日子相差不超过 ${FIXED_DAY_TOL} 天，就算固定开销。条上的数是三个月那一笔的月均，小方块是各条相加；转账、还白条、校准不算。`,
  }
  const r = findFixed(inp.txs, inp.cats, inp.accounts, months)
  if (!r.items.length) return { ...base, option: null, empty: '没找到每月都固定出现的开销' }

  // 小方块 = 各条月均相加（用户拿条上的数加起来要对得上）
  const avgSum = r.items.reduce((s, it) => s + it.avg, 0)
  const tiles: MoreTile[] = [
    { label: '固定开销', value: `${yuan(avgSum)}/月` },
    // 三个月代表合计 ÷ 三个月收入合计，÷3 两边约掉
    { label: '占月均收入', value: r.income > 0 ? `${Math.round((r.items.reduce((s, it) => s + it.total, 0) / r.income) * 100)}%` : '—' },
  ]
  const items = r.items
  const mName = (m: string) => `${+m.slice(5)}月`

  return {
    ...base,
    tiles,
    height: Math.max(120, items.length * ROW_H + 24),
    option: {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        confine: true,
        formatter: (ps: { dataIndex: number }[]) => {
          const it = ps.length ? items[ps[0].dataIndex] : undefined
          if (!it) return ''
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          return [
            esc(it.fullName),
            line('账户', esc(it.accountName)),
            ...it.monthly.map((v, i) => line(`${mName(months[i])} ${it.days[i]} 号`, yuan(v))),
            line('月均', yuan(it.avg)),
          ].join('<br/>')
        },
      },
      // 右边留出条尾那串金额的位置
      grid: { left: 4, right: 76, top: 4, bottom: 4, containLabel: true },
      xAxis: { type: 'value', show: false, min: 0 },
      yAxis: {
        type: 'category',
        // 从上往下是月均从大到小
        inverse: true,
        data: items.map((it) => it.label),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: CHART.axis } },
        axisLabel: { fontSize: 11, color: CHART.label, width: 96, overflow: 'truncate', ellipsis: '…' },
      },
      series: [
        {
          name: '月均',
          type: 'bar',
          barMaxWidth: 16,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', fontSize: 10, color: CHART.label, formatter: (p: { dataIndex: number }) => yuan(items[p.dataIndex]?.avg ?? 0) },
          // 单位是分；条尾和提示框自己换成元
          data: items.map((it) => ({ value: it.avg, itemStyle: { color: it.color } })),
        },
      ],
    },
    // 点一行 → 那三个月里最后一个月、这个分类、这个账户的流水（cat 必须带：流水页收到 cat 才重设筛选）
    onPoint: (dataIndex: number) => {
      const it = items[dataIndex]
      if (!it) return null
      const c = inp.cats.find((x) => x.id === it.categoryId)
      // 父类被删掉的二级：图上把它当一级显示，跳转也按一级走（带一个不存在的父类 id 过去，流水页是空的）
      const parentOk = Boolean(c?.parent_id && inp.cats.some((x) => x.id === c.parent_id))
      const cat = !c ? 'none' : parentOk ? (c.parent_id as string) : c.id
      const sub = c && parentOk ? `&sub=${c.id}` : ''
      const acc = it.accountId ? `&acc=${it.accountId}` : ''
      return `ym=${months[months.length - 1]}&type=expense&cat=${cat}${sub}${acc}`
    },
  }
}

export default fixedChart
