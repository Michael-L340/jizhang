// 进阶统计 · 环比涨跌榜：所选月份比上个月，哪几类多花了最多、哪几类少花了最多（横向条形图，0 在正中间）。
//
// 按二级分类比；没选二级、直接记在一级上的钱按那个一级算（它自己一行，大类有二级时轴上写「日常餐饮·未细分」）。
// 查不到分类的归「未分类」。
// 多花的（正）五个用支出红画在右边，少花的（负）五个用收入绿画在左边；两个月花得一样的不上榜。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'：转账（含还白条）、校准、收入一律不进（compute.isFlow 的口径）。
import type { Category } from '../../types'
import { UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from '../compute'
import { shiftMonth } from '../date'
import { textWidth } from '../chart'
import { CHILD_NONE } from '../filter'
import { fmtYuan } from '../money'
import { CHART } from '../palette'
import { esc } from './html'
import { monthSpan } from './span'
import { UNSPLIT_NAME } from './treemap'
import type { MoreChart, MoreInput } from './types'

export const DELTA_TITLE = '环比涨跌榜'
/** 涨、跌各取前几名 */
export const DELTA_TOP = 5
/** 分类名、柱子头上金额的字号 */
export const NAME_FONT = 11
/**
 * 左边分类名那一列最宽多少 px，再长截断成「…」（全名在提示框）。
 * 至少放得下七个汉字 + 省略号：「非经常生活消费」「日常餐饮·未细分」要整个看得见。
 * 原来写死 72（六个半字），「日常餐饮·未细分」只剩「日常餐饮·...」，看不出是哪一部分（审阅 #8）。
 * 按八个整字宽算：「·」「…」在中文字体里常是全角，ECharts 量不到字体时（SSR）也按一个字宽算。
 * 屏幕宽就跟着放宽到三成，柱子那边照样够用（axisHalf 按实际占的宽度给柱子留地方）。
 */
export const NAME_MIN_W = 8 * NAME_FONT
export const nameWidth = (chartWidth: number) => Math.max(NAME_MIN_W, Math.floor(chartWidth * 0.3))
export const VALUE_FONT = 10
/** 纯函数量不到屏幕：没传宽度时按 393 宽的手机算（393 − 页面和卡片的内边距 64） */
export const DELTA_CHART_W = 329
const GRID_L = 4
const GRID_R = 8
/** ECharts 的默认值：轴标签离轴 8px，柱子外侧的标签离柱头 5px */
const AXIS_LABEL_MARGIN = 8
const BAR_LABEL_GAP = 5

const TAP = '<div style="margin-top:5px;font-size:11px;opacity:.6">再点一下看流水 ›</div>'
const RIGHT = 'float:right;margin-left:16px;font-weight:600'

export interface DeltaRow {
  /** 分类 id（二级，或直接记账的那个一级）；查不到分类的是 UNCATEGORIZED_ID */
  id: string
  name: string
  /** 二级的一级名；一级 / 未分类是 null */
  parent: string | null
  /**
   * 流水页把这一行的钱归到哪个一级下面（Ledger 的 rootOf = parent_id ?? id）：跳流水时的 cat。
   * 二级的父类被删了（parent 是 null）也照样是那个 parent_id——流水页认的就是它。未分类是 null
   */
  root: string | null
  /** 这一行是「直接记在一个有二级的大类上」的钱 */
  direct: boolean
  /** 所选月份 / 上个月的支出（分） */
  cur: number
  prev: number
  /** cur − prev（分） */
  diff: number
  sort: number
}

/**
 * 所选月份和上个月，每个「二级（或直接记账的一级）」各花了多少、差多少。含差额为 0 的行，按差额从大到小。
 * 等式：Σcur = 所选月份支出，Σprev = 上个月支出，Σdiff = 两个月支出之差（delta.test.ts 拿随机账本守着）。
 */
export function deltaRows(inp: Pick<MoreInput, 'txs' | 'cats' | 'ym'>): DeltaRow[] {
  const byId = new Map<string, Category>(inp.cats.map((c) => [c.id, c]))
  const hasChild = new Set(inp.cats.filter((c) => c.parent_id).map((c) => c.parent_id as string))
  const prevYm = shiftMonth(inp.ym, -1)
  const rows = new Map<string, DeltaRow>()
  for (const t of inp.txs) {
    if (t.type !== 'expense') continue
    const m = t.date.slice(0, 7)
    if (m !== inp.ym && m !== prevYm) continue
    const c = t.category_id ? byId.get(t.category_id) : undefined
    const id = c ? c.id : UNCATEGORIZED_ID
    let r = rows.get(id)
    if (!r) {
      // 二级的父类查不到：把它自己当一级（compute.byCategory 同一个口径）
      const parent = c?.parent_id ? byId.get(c.parent_id) : undefined
      r = {
        id,
        name: c ? c.name : UNCATEGORIZED_NAME,
        parent: parent ? parent.name : null,
        root: c ? c.parent_id ?? c.id : null,
        direct: Boolean(c && !parent && hasChild.has(c.id)),
        cur: 0,
        prev: 0,
        diff: 0,
        sort: c ? c.sort : Number.MAX_SAFE_INTEGER,
      }
      rows.set(id, r)
    }
    if (m === inp.ym) r.cur += t.amount
    else r.prev += t.amount
    r.diff = r.cur - r.prev
  }
  return [...rows.values()].sort((a, b) => b.diff - a.diff || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 上榜的那几行，从上往下画的顺序：多花的从多到少，接着少花的从少到多（少花最多的在最底下）。
 * 差额为 0 的不上榜。
 */
export function deltaBoard(rows: DeltaRow[]): DeltaRow[] {
  const up = rows.filter((r) => r.diff > 0).slice(0, DELTA_TOP)
  const down = rows
    .filter((r) => r.diff < 0)
    .sort((a, b) => a.diff - b.diff || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, DELTA_TOP)
    .reverse()
  return [...up, ...down]
}

/**
 * 点这一行跳到流水页带的筛选（filter.filterFromQuery 解析）：只列出这一行的那几笔支出。
 * 二级 → cat=一级&sub=二级；直接记在有二级的大类上 → sub=none（流水页的「未细分」）；
 * 没二级的一级 → cat=它；未分类 → cat=none。一律带 type=expense：「未分类」在流水页也包括没分类的收入。
 * 等式：流水页那个月列出来的钱 = 这一行「这个月」的钱（delta.test.ts 照着流水页的筛法随机验）。
 */
export function rowQuery(r: Pick<DeltaRow, 'id' | 'root' | 'direct'>): string {
  if (r.root === null) return 'type=expense&cat=none'
  if (r.root !== r.id) return `type=expense&cat=${r.root}&sub=${r.id}`
  return r.direct ? `type=expense&cat=${r.id}&sub=${CHILD_NONE}` : `type=expense&cat=${r.id}`
}

/** 柱子头上的字：带正负号；一百块以上写整数元，以下写到分（去掉「.00」）。精确的在提示框里 */
export function signedYuan(cents: number): string {
  const abs = Math.abs(cents)
  const body = abs >= 10000 ? Math.round(abs / 100).toLocaleString('en-US') : fmtYuan(abs).replace(/\.00$/, '')
  return `${cents > 0 ? '+' : cents < 0 ? '-' : ''}¥${body}`
}

/**
 * 金额轴一边的长度（元）：每根柱子头上的「+¥1,234」都得放得下。
 * 标签在柱子外侧：右边放不下就出画布，左边放不下就压到分类名上（delta.test.ts 真画出来量着）。
 * 一边的宽度 half px 里，柱子占 |d| / R，剩下的要 ≥ 标签宽 + 间隙：R ≥ |d| × half / (half − 标签宽)。
 * 按最长那根乘个固定倍数不行：宽屏上白白空一大截，窄屏上「-¥12,345」照样出界。
 */
export function axisHalf(rows: Pick<DeltaRow, 'diff'>[], names: string[], chartWidth: number): number {
  const nameCol = Math.min(nameWidth(chartWidth), Math.max(0, ...names.map((n) => textWidth(n, NAME_FONT)))) + AXIS_LABEL_MARGIN
  const half = (chartWidth - GRID_L - GRID_R - nameCol) / 2
  let r = 0
  for (const row of rows) {
    const need = textWidth(signedYuan(row.diff), VALUE_FONT) + BAR_LABEL_GAP + 2
    // 窄到连一个标签都放不下（不会真发生）：柱子至少留三成，别除以零或负数
    const room = Math.max(half - need, half * 0.3)
    r = Math.max(r, ((Math.abs(row.diff) / 100) * half) / room)
  }
  return r
}

export function delta(inp: MoreInput, chartWidth = DELTA_CHART_W): MoreChart {
  const { ym } = inp
  const prevYm = shiftMonth(ym, -1)
  const base = {
    key: 'delta',
    title: DELTA_TITLE,
    span: monthSpan(prevYm, ym),
    note: '所选月份比上个月，按二级分类（没选二级的按大类）多花最多的五个在右、红色，少花最多的五个在左、绿色。转账、还白条、校准不算。',
  }
  const all = deltaRows(inp)
  if (!all.some((r) => r.cur > 0 || r.prev > 0)) return { ...base, option: null, empty: '这个月和上个月都没有支出' }
  const board = deltaBoard(all)
  if (!board.length) return { ...base, option: null, empty: '和上个月比，每一类都花得一样多' }

  // 同名的二级（两个大类下都有「其他」）在轴上会分不清：撞名的那几行带上一级的名字。
  // 直接记在有二级的大类上的那一行写「日常餐饮·未细分」（和支出版图、流水页筛选标签同一个说法）：
  // 只写「日常餐饮」会被读成整个大类
  const count = new Map<string, number>()
  for (const r of board) count.set(r.name, (count.get(r.name) ?? 0) + 1)
  const labels = board.map((r) =>
    r.direct ? `${r.name}·${UNSPLIT_NAME}` : (count.get(r.name) ?? 0) > 1 && r.parent ? `${r.parent}·${r.name}` : r.name,
  )
  // 提示框是 HTML，分类名是用户写的字：过 esc
  const full = (r: DeltaRow) =>
    esc(r.parent ? `${r.parent} · ${r.name}` : r.direct ? `${r.name} · ${UNSPLIT_NAME}（没选二级的）` : r.name)

  const R = axisHalf(board, labels, chartWidth)
  const curName = `${+ym.slice(5)}月`
  const prevName = `${+prevYm.slice(5)}月`
  // 跳到那个月、只筛这一行的那几笔（rowQuery）。原来一律 cat=all，点「午餐 +¥300」跳去的是整月全部流水（审阅 #7）。
  // 第一下弹的是点中那一行的提示框：Chart.tsx 点绘图区时，横条图取的是 y 轴（类目轴）的下标（lib/tap.ts 的 categoryAxisOf，整合时修的；
  // 原来一律取 x，横条图上永远是第 0 行）
  const onPoint = (dataIndex: number): string | null => (dataIndex >= 0 && dataIndex < board.length ? `ym=${ym}&${rowQuery(board[dataIndex])}` : null)

  return {
    ...base,
    height: Math.max(140, board.length * 26 + 16),
    option: {
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: { type: 'shadow' },
        formatter: (ps: { dataIndex: number }[]) => {
          if (!ps.length) return ''
          const r = board[ps[0].dataIndex]
          if (!r) return ''
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          const rows = [full(r), line(curName, `¥${fmtYuan(r.cur)}`), line(prevName, `¥${fmtYuan(r.prev)}`)]
          rows.push(line(r.diff > 0 ? '多花' : '少花', `¥${fmtYuan(Math.abs(r.diff))}`))
          rows.push(line('涨跌', r.prev > 0 ? `${r.diff > 0 ? '+' : ''}${Math.round((r.diff / r.prev) * 100)}%` : '上个月没花'))
          return rows.join('<br/>') + (onPoint(ps[0].dataIndex) ? TAP : '')
        },
      },
      grid: { left: GRID_L, right: GRID_R, top: 4, bottom: 4, containLabel: true },
      xAxis: {
        type: 'value',
        // 0 在正中间：两边一样长
        min: -R,
        max: R,
        interval: R,
        axisLabel: { show: false },
        axisTick: { show: false },
        axisLine: { show: false },
        splitLine: { lineStyle: { color: CHART.axis } },
      },
      yAxis: {
        type: 'category',
        // 第一行在最上面
        inverse: true,
        data: labels,
        axisTick: { show: false },
        // onZero 关掉：否则轴（连同分类名）画在 x = 0 那条线上，压着左边的绿柱子
        axisLine: { show: false, onZero: false },
        axisLabel: { fontSize: NAME_FONT, color: CHART.label, width: nameWidth(chartWidth), overflow: 'truncate', ellipsis: '…' },
      },
      series: [
        {
          name: '比上月',
          type: 'bar',
          barMaxWidth: 14,
          data: board.map((r) => {
            const color = r.diff > 0 ? CHART.expense : CHART.income
            return {
              value: r.diff / 100,
              itemStyle: { color, borderRadius: r.diff > 0 ? [0, 3, 3, 0] : [3, 0, 0, 3] },
              label: { show: true, position: r.diff > 0 ? 'right' : 'left', fontSize: VALUE_FONT, color, formatter: () => signedYuan(r.diff) },
            }
          }),
        },
      ],
    },
    onPoint,
  }
}
