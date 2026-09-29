// 进阶统计 · 支出版图（矩形树图；标题原定「钱去哪了」，和第一批的瀑布图撞名，整合时改）：所选时间段里的支出，一块面积 = 一笔钱有多大。
//
// 两层：一级分类 → 二级分类。先只看大类（leafDepth 1），点有二级的那块钻进去看二级。
// 没有二级的一级（只直接记在大类上）就是一整块，没有第二层、点它不动。
// 一级下面既有二级、又有直接记在一级上的钱：那部分单列一块「未细分」（和 compute.byCategory 同名），
// 不能省——ECharts 钻进去之后按子块之和铺满整块，省掉的话直接记在一级上的那部分钱在里面就看不见了，
// 其余几块还会被按比例放大。
//
// 只吃 MoreInput.txs（当前模式那本账），不看 hidden、不碰 store。
// 只算 type === 'expense'：转账（含还白条）、校准、收入一律不进（compute.isFlow 的口径）。
// 分类的口径和 compute.byCategory 一样：查不到分类的归「未分类」，二级的父类查不到就把它自己当一级。
import type { Category } from '../../types'
import { artUrl, imgKey, isImgIcon } from '../art'
import { UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from '../compute'
import { fmtYuan } from '../money'
import { categoryColor, CHART, childShade, readableOn } from '../palette'
import { esc } from './html'
import { rangeSpan } from './span'
import type { MoreChart, MoreInput } from './types'

export const TREEMAP_TITLE = '支出版图'
/** 直接记在一级上、没选二级的那部分钱（有二级的大类里才单列） */
export const UNSPLIT_NAME = '未细分'

/** 最外面那一层的名字：底下那条「面包屑」的第一格，点它从二级退回大类 */
export const ROOT_NAME = '全部支出'
/** 面包屑那条的高度（px）；图的下沿给它让出这么多再加 6 */
const CRUMB_H = 20

const NOTE = `标题旁那段时间里的支出，一块的面积就是花了多少。先看大类，点一个大类看它的二级，点底下的「${ROOT_NAME}」回到大类；块太小写不下的不写字，点一下看。直接记在大类上的算「未细分」。转账、还白条、校准不算。`

const RIGHT = 'float:right;margin-left:16px;font-weight:600'

export interface TreeLeaf {
  /** 分类 id；「未细分」是 `<一级 id>:none`，和 byCategory 一样 */
  id: string
  name: string
  cents: number
  color: string
  /** 分类自己的图标（emoji 或 `img:<key>`，和 App 别处同一个）；「未细分」「未分类」没有 */
  icon: string | null
}

export interface TreeNode extends TreeLeaf {
  /** 空数组 = 只有一层（没有二级，或者只直接记在大类上） */
  children: TreeLeaf[]
}

const byCents = <T extends { cents: number; sort: number; id: string }>(a: T, b: T) =>
  b.cents - a.cents || a.sort - b.sort || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * 时间段 [start, end]（含两端）里的支出，按一级 → 二级汇总。一级按金额从大到小，二级也是。
 * 等式：各一级之和 = 这段时间的支出合计；有二级的一级 = 它的二级（含「未细分」）之和。treemap.test.ts 拿随机账本守着。
 */
export function treeOf(inp: Pick<MoreInput, 'txs' | 'cats' | 'start' | 'end'>): TreeNode[] {
  const byId = new Map<string, Category>(inp.cats.map((c) => [c.id, c]))
  type Acc = { id: string; name: string; icon: string | null; sort: number; cents: number; subs: Map<string, { id: string; name: string; icon: string | null; sort: number; cents: number }> }
  const roots = new Map<string, Acc>()
  for (const t of inp.txs) {
    if (t.type !== 'expense' || t.date < inp.start || t.date > inp.end) continue
    const c = t.category_id ? byId.get(t.category_id) : undefined
    const root = c ? (c.parent_id ? byId.get(c.parent_id) ?? c : c) : undefined
    const rid = root ? root.id : UNCATEGORIZED_ID
    let r = roots.get(rid)
    if (!r) {
      // 查不到的「未分类」排在同额的真分类后面
      r = { id: rid, name: root ? root.name : UNCATEGORIZED_NAME, icon: root?.icon ?? null, sort: root ? root.sort : Number.MAX_SAFE_INTEGER, cents: 0, subs: new Map() }
      roots.set(rid, r)
    }
    r.cents += t.amount
    // 直接记在一级上的（含未分类）进「未细分」；排在同额的真二级后面
    const sub = c && root && c.id !== root.id ? c : null
    const sid = sub ? sub.id : `${rid}:none`
    let s = r.subs.get(sid)
    if (!s) {
      s = { id: sid, name: sub ? sub.name : UNSPLIT_NAME, icon: sub?.icon ?? null, sort: sub ? sub.sort : Number.MAX_SAFE_INTEGER, cents: 0 }
      r.subs.set(sid, s)
    }
    s.cents += t.amount
  }
  // 颜色和统计页饼图一个口径：一级 categoryColor(名字, 按金额的名次)；二级 childShade(一级色, 二级的 sort)。
  // 「未细分」就用一级自己的颜色：它就是「这个大类本身」，和几个二级的深浅都分得开
  return [...roots.values()].sort(byCents).map((r, i) => {
    const color = categoryColor(r.name, i)
    const subs = [...r.subs.values()].sort(byCents)
    const onlyDirect = subs.length === 1 && subs[0].id === `${r.id}:none`
    return {
      id: r.id,
      name: r.name,
      icon: r.icon,
      cents: r.cents,
      color,
      children: onlyDirect
        ? []
        : subs.map((s) => ({ id: s.id, name: s.name, icon: s.icon, cents: s.cents, color: s.id === `${r.id}:none` ? color : childShade(color, s.sort) })),
    }
  })
}

/** 块上字的字号（px） */
const FONT = 11
/** 块上图标的边长（px）：和 11px 的字差不多高 */
export const BLOCK_ICON_PX = 13
/** 图标和名字之间、钻进去之后顶上那条里名字和金额之间的空隙（px） */
const ICON_GAP = 3
const MONEY_GAP = 8

const EMOJI = /\p{Extended_Pictographic}/u
/** 不占宽度的：ZWJ、变体选择符、肤色 */
const ZERO = /[\u200d\ufe0e\ufe0f\u{1f3fb}-\u{1f3ff}]/u

/**
 * 块上一格字要占多宽（px），宁宽勿窄：声明得比实际窄，字会伸出自己的格子；声明宽了只是早一点不写。
 * iPhone 上图表的字是 Helvetica（汉字落到苹方）：汉字正好一个字宽；数字、「¥」0.56，按 0.58 算；
 * 逗号 0.28，按 0.35 算；emoji 按 1.3 算；再留 1px。
 * （chart.ts 的 textWidth 是估平均的，数字按 0.55、emoji 当半个字，拿来声明格子会偏窄）
 */
export function boxWidth(s: string, fontSize = FONT): number {
  let em = 0
  for (const ch of s) {
    em += ZERO.test(ch) ? 0 : EMOJI.test(ch) ? 1.3 : ch === '¥' ? 0.58 : ch > '\x7f' ? 1 : /[A-Z]/.test(ch) ? 0.72 : /\w/.test(ch) ? 0.58 : 0.35
  }
  return Math.ceil(em * fontSize) + 1
}

/**
 * 块上名字前面的图标：分类自己的那个（和流水行、记账页同一个）。
 * 3D 图（`img:<key>`）是 ECharts 富文本的图片格子（rich 里登记一格 backgroundColor.image）；emoji 是一格字，交给 treemap 里的 cell。
 * 原来是 ECharts 默认的「▶」，每个大类前面都一样，iPhone 上还被画成一个蓝色方块 emoji
 * （用户 2026-09-29：「怎么都是一样的，而且好丑」）。
 * 没设图标、或者 img 指到登记表里没有的图（art.ts 撤掉过）→ null，只写名字。
 */
export function blockIcon(icon: string | null, richKey: string): { image: string; rich: Record<string, object> } | { emoji: string } | null {
  if (!icon) return null
  if (isImgIcon(icon)) {
    const url = artUrl(imgKey(icon) ?? '')
    if (!url) return null
    return { image: `{${richKey}|}`, rich: { [richKey]: { width: BLOCK_ICON_PX, height: BLOCK_ICON_PX, backgroundColor: { image: url } } } }
  }
  return { emoji: icon }
}

/** 块上的金额：整数元带千分位（块小，写不下分；精确到分的在提示框里） */
export const blockMoney = (cents: number) => `¥${Math.round(cents / 100).toLocaleString('en-US')}`

/** 名字里的花括号会被 ECharts 当成富文本的格子标记，换成全角的 */
const plainText = (s: string) => s.replace(/\{/g, '｛').replace(/\}/g, '｝')

export function treemap(inp: MoreInput): MoreChart {
  const base = { key: 'treemap', title: TREEMAP_TITLE, span: rangeSpan(inp.start, inp.end, inp.today), note: NOTE }
  const tree = treeOf(inp)
  const total = tree.reduce((s, n) => s + n.cents, 0)
  if (total <= 0) return { ...base, option: null, empty: '这段时间没有支出' }

  // 块上的字一段一格（ECharts 富文本），每格都声明好宽度：块里剩的地方放得下就整格画，放不下就整格不画——
  // zrender 对声明了宽度的格子就是这么处理的（parseText.js：声明了 width 又放不下 → token.text = ''），
  // 块多大是 ECharts 排完版才知道的，这样它自己按每一块的实际大小取舍，不用这边猜。
  // 原来是整串字交给 ECharts 截断：小块上印出「日常…」「¥1,2...」，省略号放不下时「¥3,456」还会印成「¥3」
  // （用户 2026-09-29：「如果太小的，字或数字无法显示全的，就不显示了」）。
  // 一格宽度一个样式（w38 = 宽 38），块上的字和钻进去之后顶上那条共用
  const rich: Record<string, object> = {}
  const cell = (text: string, width = boxWidth(text)) => {
    rich[`w${width}`] = { width }
    return `{w${width}|${text}}`
  }
  // 图标、空隙、名字各一格：名字放不下时图标照样画（小块上只剩一个图标，比截成半个名字好认）。
  // anchor：认得出是哪一块的那一格有多宽，金额那格用得着
  let nth = 0
  const head = (icon: string | null, name: string) => {
    const b = blockIcon(icon, `i${nth++}`)
    const nameW = boxWidth(plainText(name))
    const nameCell = cell(plainText(name), nameW)
    if (!b) return { text: nameCell, anchor: nameW }
    if ('rich' in b) Object.assign(rich, b.rich)
    const iconW = 'emoji' in b ? boxWidth(b.emoji) : BLOCK_ICON_PX
    return { text: `${'emoji' in b ? cell(b.emoji, iconW) : b.image}${cell('', ICON_GAP)}${nameCell}`, anchor: iconW }
  }
  // 块上：第一行图标 + 名字，第二行金额；高度不够两行时第二行整行不画（lineOverflow）。
  // 金额不单独出现：那格至少声明得和「认得出是哪块」的那格一样宽——有图标比图标，没图标比名字。
  // 放得下金额的块一定放得下它，不会只剩一个没头没尾的数。
  // 钻进去之后顶上那条是一行：图标、名字、金额（那条和整张图一样宽，放不下名字的情况实际碰不到）
  const texts = (icon: string | null, name: string, cents: number) => {
    const h = head(icon, name)
    const money = blockMoney(cents)
    return {
      label: `${h.text}\n${cell(money, Math.max(boxWidth(money), h.anchor))}`,
      upper: `${h.text}${cell('', MONEY_GAP)}${cell(money)}`,
    }
  }

  // ECharts 那边只认 id；提示框、块上的字要的全名和精确的分从这里查
  const info = new Map<string, { name: string; cents: number; parent?: TreeNode; label: string; upper: string }>()
  const data = tree.map((n) => {
    info.set(`p:${n.id}`, { name: n.name, cents: n.cents, ...texts(n.icon, n.name, n.cents) })
    for (const ch of n.children) info.set(`s:${ch.id}`, { name: ch.name, cents: ch.cents, parent: n, ...texts(ch.icon, ch.name, ch.cents) })
    return {
      id: `p:${n.id}`,
      name: n.name,
      value: n.cents / 100,
      // borderColor 也是大类色：钻进去之后，顶上那条写着大类名字的横条、二级之间的缝，露出来的都是它
      itemStyle: { color: n.color, borderColor: n.color },
      // 字色按这一块的底色挑（readableOn）：二级那几档浅色上白字只有 1.3–1.8 的对比度，看不清（审阅 #6）。
      // 顶上那条横条的底也是大类色，跟着大类走
      label: { color: readableOn(n.color) },
      upperLabel: { color: readableOn(n.color) },
      ...(n.children.length
        ? {
            children: n.children.map((ch) => ({
              id: `s:${ch.id}`,
              name: ch.name,
              value: ch.cents / 100,
              itemStyle: { color: ch.color },
              label: { color: readableOn(ch.color) },
            })),
          }
        : {}),
    }
  })

  const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)}%`
  const label = (p: { data?: { id?: string } }) => (p.data?.id ? info.get(p.data.id)?.label : undefined) ?? ''
  const upper = (p: { data?: { id?: string } }) => (p.data?.id ? info.get(p.data.id)?.upper : undefined) ?? ''

  return {
    ...base,
    height: 260,
    option: {
      tooltip: {
        trigger: 'item',
        confine: true,
        formatter: (p: { data?: { id?: string } }) => {
          const x = p.data?.id ? info.get(p.data.id) : undefined
          if (!x) return ''
          const line = (k: string, v: string) => `<span style="opacity:.75">${k}</span><span style="${RIGHT}">${v}</span>`
          // 提示框是 HTML，分类名是用户写的字：过 esc
          const rows = [esc(x.parent ? `${x.parent.name} · ${x.name}` : x.name), line('金额', `¥${fmtYuan(x.cents)}`), line('占这段时间支出', pct(x.cents, total))]
          if (x.parent) rows.push(line(esc(`占${x.parent.name}`), pct(x.cents, x.parent.cents)))
          return rows.join('<br/>')
        },
      },
      series: [
        {
          type: 'treemap',
          // 虚根的名字：面包屑第一格写的就是它（不写的话 ECharts 印「series0」）
          name: ROOT_NAME,
          left: 0,
          right: 0,
          top: 0,
          bottom: CRUMB_H + 6,
          // 先只看大类，点进去看二级
          leafDepth: 1,
          // 'link' 而不是默认的 'zoomToNode'：有二级的块（ECharts 叫 leafRoot）不管这项都会钻进去；
          // 'zoomToNode' 会把点中的叶子块（没二级的大类）放大到占满整张图，又没有面包屑能退回来。
          // 'link' 在叶子上找 data 的 link 字段，这里一个都没写，点叶子就什么都不做
          nodeClick: 'link',
          // 不要 ECharts 默认的「▶」：每个大类前面都一样，iPhone 上还被画成蓝色方块 emoji（用户 2026-09-29 嫌丑）。
          // 名字前面换成分类自己的图标（blockIcon），能不能点进去看 note 里写的「点一个大类看它的二级」
          drillDownIcon: '',
          // 手机上拖一下就把图平移走了，还和页面滚动抢手势
          roam: false,
          // 面包屑要开着：钻进某个大类之后，ECharts 往回退只有点它这一条路。
          // 关掉的那一版（2026-09-29 整合前）点进去就回不来——Chart.tsx 只在 option 变了才重设，
          // 换个月份再换回来都不行（缓存里还是同一份 option）
          breadcrumb: {
            show: true,
            left: 'center',
            bottom: 0,
            height: CRUMB_H,
            emptyItemWidth: 25,
            itemStyle: { color: CHART.axis, borderColor: CHART.axis, textStyle: { color: CHART.label, fontSize: 11 } },
            emphasis: { itemStyle: { color: CHART.axis, textStyle: { color: CHART.brandInk } } },
          },
          animationDurationUpdate: 400,
          label: {
            show: true,
            formatter: label,
            rich,
            fontSize: FONT,
            lineHeight: 14,
            // ECharts 默认四周 5：左右各让 1px 给字，小块多放得下一点
            padding: [5, 4],
            // 兜底的白字（卡片底色）；每一块实际的字色在 data 里按底色单独给（readableOn）
            color: CHART.gap,
            // 'truncate' 不能去掉：zrender 只在这个模式下才去比「放不放得下」。格子都声明了宽度，
            // 所以它不会截出半截字，放不下的格子整格不画（见上面 cell）
            overflow: 'truncate',
            lineOverflow: 'truncate',
          },
          levels: [
            // 第 0 层是 ECharts 的虚根：大类之间的缝露出卡片底色
            { itemStyle: { borderColor: CHART.gap, borderWidth: 0, gapWidth: 2 } },
            // 第 1 层 = 一级分类。钻进去之后顶上一条写着是哪个大类（没有面包屑，得告诉人现在在哪）
            {
              itemStyle: { borderWidth: 0, gapWidth: 1 },
              upperLabel: { show: true, height: 22, padding: [0, 6], color: CHART.gap, fontSize: FONT, formatter: upper, rich },
            },
            // 第 2 层 = 二级分类：一圈细白边，挨着的两块同色系也分得开
            { itemStyle: { borderColor: CHART.gap, borderWidth: 1 } },
          ],
          data,
        },
      ],
    },
  }
}
