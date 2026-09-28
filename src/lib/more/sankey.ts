// 进阶统计 · 钱的流向（桑基图）。
//
// 所选时间里的支出，三列：从哪个账户出去 → 花进哪个一级分类 → 细到哪个二级。
// 直接记在一级上（没选二级）的那部分钱**没有第三段**，不造一个「其他 / 未细分」节点去接它——
// 一级节点右边比左边短一截，短的那截就是直接记在一级上的。
//
// 节点靠 `id` 区分、`name` 只管显示：两个大类下面都有叫「其他」的二级是常事，
// 拿名字当键会被 ECharts 当成同一个节点，两边的钱糊成一条（sankey.test.ts 守着）。
import type { Account, Category } from '../../types'
import { shortLabels } from '../chart'
import { UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from '../compute'
import { fmtYuan } from '../money'
import { categoryColor, CHART, childShade } from '../palette'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput } from './types'

/** 二级最多单列几个；多出来的按金额从小往上合并成一个「其余」 */
export const SANKEY_MAX_SUBS = 12
/** 没指定账户的支出 */
export const NO_ACCOUNT = '未指定'
/** 流水上记着账户、但账户不在活跃清单里（归档了）的支出。钱不能从图上消失，单独一个节点接住 */
export const OTHER_ACCOUNT = '其他账户'
export const REST = '其余'

/** 节点标签的字号 */
export const SANKEY_FONT = 11
/**
 * 同一列两个节点之间的空隙。**不小于标签的行高**：标签竖直居中在节点上，相邻两个标签的中心距
 * = 两个节点各一半高 + 空隙 ≥ 空隙，空隙够一行字就永远叠不上。原来是 8：几张白条、现金、未指定这种
 * 小账户只有两三 px 高，五个 11 px 的标签压成一团（2026-09-29 SSR 截图量出来的）。
 */
export const SANKEY_GAP = 14
/** 图的上下留白（series 的 top + bottom） */
const PAD_Y = 16
/** 右边留给最后一列标签的宽度；标签本身再往里收 6 px（离节点 5 px 的距离 + 1 px 余量） */
const RIGHT = 76
export const LAST_LABEL_W = RIGHT - 6

const KEY = 'sankey'
const TITLE = '钱的流向'
const NOTE = '标题旁那段时间里的支出：左边从哪个账户出去，中间花进哪个大类，右边细到二级；线越粗钱越多。直接记在大类上的没有第三段。'

const yuan = (cents: number) => fmtYuan(cents, { symbol: true })

interface Agg {
  id: string
  /** 提示框里的全名 */
  full: string
  amount: number
  /** 同额时的次序：账户 / 分类的 sort */
  sort: number
}

interface SubAgg extends Agg {
  parentId: string
  cat: Category
}

const byAmount = <T extends Agg>(a: T, b: T) => b.amount - a.amount || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function bump<T extends Agg>(m: Map<string, T>, id: string, make: () => T, amount: number): void {
  let e = m.get(id)
  if (!e) {
    e = make()
    m.set(id, e)
  }
  e.amount += amount
}

function add(m: Map<string, number>, k: string, v: number): void {
  m.set(k, (m.get(k) ?? 0) + v)
}

const SEP = '\u0000'

export function sankeyChart(inp: MoreInput): MoreChart {
  const base = { key: KEY, title: TITLE, span: rangeSpan(inp.start, inp.end, inp.today), note: NOTE }
  const accById = new Map<string, Account>(inp.accounts.map((a) => [a.id, a]))
  const catById = new Map<string, Category>(inp.cats.map((c) => [c.id, c]))

  const accs = new Map<string, Agg>()
  const pars = new Map<string, Agg>()
  const subs = new Map<string, SubAgg>()
  const accToPar = new Map<string, number>()
  const parToSub = new Map<string, number>()
  let total = 0

  for (const t of inp.txs) {
    // 只看支出：transfer / adjust 永远不进收支（compute.isFlow），收入不是「钱花到哪」
    if (t.type !== 'expense' || t.date < inp.start || t.date > inp.end) continue
    total += t.amount

    const a = t.account_id === null ? null : accById.get(t.account_id)
    const accId = t.account_id === null ? 'a:__none__' : a ? `a:${a.id}` : 'a:__other__'
    const accName = t.account_id === null ? NO_ACCOUNT : a ? a.name : OTHER_ACCOUNT
    // 没指定 / 查不到的排在同额的真账户后面
    bump(accs, accId, () => ({ id: accId, full: accName, amount: 0, sort: a ? a.sort : Number.MAX_SAFE_INTEGER }), t.amount)

    // 分类口径和 compute.byCategory 一样：查不到归「未分类」，二级的父类查不到就把它自己当一级
    const c = t.category_id ? catById.get(t.category_id) : undefined
    const root = c ? (c.parent_id ? catById.get(c.parent_id) ?? c : c) : undefined
    const parId = `p:${root ? root.id : UNCATEGORIZED_ID}`
    bump(pars, parId, () => ({ id: parId, full: root ? root.name : UNCATEGORIZED_NAME, amount: 0, sort: root ? root.sort : Number.MAX_SAFE_INTEGER }), t.amount)
    add(accToPar, accId + SEP + parId, t.amount)

    if (c && root && c.id !== root.id) {
      const subId = `s:${c.id}`
      bump(subs, subId, () => ({ id: subId, full: c.name, amount: 0, sort: c.sort, parentId: parId, cat: c }), t.amount)
      add(parToSub, parId + SEP + subId, t.amount)
    }
  }

  if (total <= 0) return { ...base, option: null, empty: '这段时间没有支出' }

  const accList = [...accs.values()].sort(byAmount)
  const parList = [...pars.values()].sort(byAmount)
  const parRank = new Map(parList.map((p, i) => [p.id, i]))
  // 颜色和统计页饼图一个口径：categoryColor(名字, 名次)，名次按金额
  const parColor = new Map(parList.map((p, i) => [p.id, categoryColor(p.full, i)]))

  // 二级按金额取前 SANKEY_MAX_SUBS 个，剩下的并成一个「其余」
  const subRanked = [...subs.values()].sort(byAmount)
  const kept = subRanked.slice(0, SANKEY_MAX_SUBS)
  const merged = subRanked.slice(SANKEY_MAX_SUBS)
  const keptIds = new Set(kept.map((s) => s.id))
  const REST_ID = 's:__rest__'

  // 第三列按第二列的顺序分组排：同一个大类的二级挨在一起，第二、三列之间不交叉
  const subList = [...kept].sort((a, b) => parRank.get(a.parentId)! - parRank.get(b.parentId)! || byAmount(a, b))

  const shortPar = shortLabels(parList.map((p) => p.full))
  const full = new Map<string, string>()
  type Node = { id: string; name: string; value: number; itemStyle: { color: string }; label?: object }
  const nodes: Node[] = []
  for (const a of accList) {
    full.set(a.id, a.full)
    nodes.push({ id: a.id, name: a.full, value: a.amount, itemStyle: { color: CHART.label } })
  }
  parList.forEach((p, i) => {
    full.set(p.id, p.full)
    nodes.push({ id: p.id, name: shortPar[i], value: p.amount, itemStyle: { color: parColor.get(p.id)! } })
  })
  for (const s of subList) {
    full.set(s.id, s.full)
    nodes.push({ id: s.id, name: s.full, value: s.amount, itemStyle: { color: childShade(parColor.get(s.parentId)!, s.cat.sort) } })
  }
  if (merged.length) {
    full.set(REST_ID, `${REST}（${merged.length} 个二级）`)
    nodes.push({ id: REST_ID, name: REST, value: merged.reduce((s, x) => s + x.amount, 0), itemStyle: { color: CHART.label } })
  }
  // 最后一列的标签在节点右边、只剩 RIGHT 那点宽：长名字（「话费宽带会员订阅」）截成「话费宽带会...」，
  // 不截的话会出画布、被裁成半个字。全名在提示框里。前两列的标签有整列的宽度，不截
  const lastCol = subList.length || merged.length ? 's:' : 'p:'
  for (const n of nodes) if (n.id.startsWith(lastCol)) n.label = { width: LAST_LABEL_W, overflow: 'truncate' }

  const links: { source: string; target: string; value: number }[] = []
  for (const a of accList) {
    for (const p of parList) {
      const v = accToPar.get(a.id + SEP + p.id)
      if (v) links.push({ source: a.id, target: p.id, value: v })
    }
  }
  const restByPar = new Map<string, number>()
  for (const [k, v] of parToSub) {
    const [parId, subId] = k.split(SEP)
    if (keptIds.has(subId)) links.push({ source: parId, target: subId, value: v })
    else add(restByPar, parId, v)
  }
  for (const p of parList) {
    const v = restByPar.get(p.id)
    if (v) links.push({ source: p.id, target: REST_ID, value: v })
  }

  const pct = (v: number) => `${((v / total) * 100).toFixed(1)}%`
  const tooltip = {
    trigger: 'item',
    confine: true,
    formatter: (p: { dataType?: string; data: { id?: string; source?: string; target?: string; value: number } }) => {
      const v = p.data.value
      if (p.dataType === 'edge') return `${full.get(p.data.source!)} → ${full.get(p.data.target!)}<br/><b>${yuan(v)}</b>　占 ${pct(v)}`
      return `${full.get(p.data.id!)}<br/><b>${yuan(v)}</b>　占 ${pct(v)}`
    },
  }

  // 高度跟着最挤的那一列走，一个节点给 28px，太少撑不开、太多整页都是它。
  // 但空隙是死的（SANKEY_GAP）：节点多到空隙就把 480 占满时，宁可更高，也不能让节点挤成负高度、标签叠起来
  const maxCol = Math.max(accList.length, parList.length, subList.length + (merged.length ? 1 : 0))
  const height = Math.max(220, Math.min(480, 24 + maxCol * 28), PAD_Y + (maxCol - 1) * SANKEY_GAP + maxCol * 4)

  return {
    ...base,
    height,
    option: {
      tooltip,
      series: [
        {
          type: 'sankey',
          nodeAlign: 'left',
          // 不让 ECharts 挪节点：每列按上面排好的顺序（金额从大到小）自上而下
          layoutIterations: 0,
          draggable: false,
          left: 4,
          right: RIGHT,
          top: PAD_Y / 2,
          bottom: PAD_Y / 2,
          nodeWidth: 10,
          nodeGap: SANKEY_GAP,
          // formatter 必须写：桑基图的默认标签是节点的 id（echarts SankeyView 里 defaultText: node.id），
          // 不写的话图上印的是「a:boc」「p:life」。'{b}' = 节点的 name（2026-09-28 SSR 画出来才发现）
          label: { fontSize: SANKEY_FONT, color: CHART.label, formatter: '{b}' },
          lineStyle: { color: 'target', opacity: 0.35, curveness: 0.5 },
          emphasis: { focus: 'adjacency' },
          data: nodes,
          links,
        },
      ],
    },
  }
}

export default sankeyChart
