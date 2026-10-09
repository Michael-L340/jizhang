/// <reference types="node" />
// 支出版图（矩形树图）。输入一律是「用户记了这些账，选了这段时间，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import * as echarts from 'echarts/core'
import { TreemapChart } from 'echarts/charts'
import { TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { describe, expect, it, vi } from 'vitest'
import type { Category, Transaction } from '../../types'
import { byCategory, UNCATEGORIZED_ID, UNCATEGORIZED_NAME } from '../compute'
import { addDays, monthRange } from '../date'
import { categoryColor, CHART, childShade, contrast, readableOn } from '../palette'
import { sampleInput } from './sample'
import { rangeSpan } from './span'
import { blockIcon, blockMoney, BLOCK_ICON_PX, boxWidth, ROOT_NAME, TREEMAP_TITLE, treemap, treeOf, UNSPLIT_NAME } from './treemap'
import type { MoreChart, MoreInput } from './types'

echarts.use([TreemapChart, TooltipComponent, SVGRenderer])

const C = (id: string, name: string, sort: number, parent_id: string | null = null, kind: Category['kind'] = 'expense'): Category => ({
  id, kind, parent_id, name, icon: null, sort, is_archived: false, note: null,
})
const CATS: Category[] = [
  C('food', '日常餐饮', 1),
  C('lunch', '午餐', 1, 'food'),
  C('dinner', '晚餐', 2, 'food'),
  C('life', '经常生活开支', 2),
  C('rent', '房租', 1, 'life'),
  C('big', '非经常生活消费', 3),
  C('fun', '娱乐消费', 4),
  C('game', '游戏充值', 1, 'fun'),
  C('salary', '工资/实习', 1, null, 'income'),
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `m${seq}`, account_id: 'boc', to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, is_offset: null, created_at: '2026-09-01T00:00:00.000Z', ...p,
  }
}
const Y = (yuan: number) => Math.round(yuan * 100)
const spend = (date: string, yuan: number, cat: string | null) => tx({ type: 'expense', amount: Y(yuan), date, category_id: cat })

const inputOf = (txs: Transaction[], start: string, end: string, today = '2026-09-20'): MoreInput => ({
  txs, accounts: [], cats: CATS, ym: end.slice(0, 7), start, end, today,
})
const open = (txs: Transaction[], start = '2026-09-01', end = '2026-09-20'): MoreChart => treemap(inputOf(txs, start, end))

type Leaf = { id: string; name: string; value: number; itemStyle: { color: string }; label: { color: string } }
type Node = Leaf & { children?: Leaf[]; upperLabel: { color: string } }
type Series = {
  data: Node[]; leafDepth: number; nodeClick: string | false; roam: boolean; breadcrumb: { show: boolean }
  label: { formatter: (p: unknown) => string; rich: Record<string, { width?: number; backgroundColor?: { image: string } }> }
  levels: { upperLabel?: { formatter: (p: unknown) => string } }[]
}
type Opt = { series: Series[]; tooltip: { formatter: (p: unknown) => string } }
const opt = (c: MoreChart) => c.option as unknown as Opt
/** 「名字 金额」一行一个，子块缩进，读起来就是用户在图上看到的两层 */
const view = (c: MoreChart) =>
  opt(c).series[0].data.flatMap((n) => [`${n.name} ${n.value}`, ...(n.children ?? []).map((ch) => `  ${ch.name} ${ch.value}`)])

/**
 * 真画出来（SSR）：先是第一屏（大类），再依次钻进每个有二级的大类各画一屏（和用户点进去看到的一样）。
 * 返回每一屏的 SVG。
 */
function renderScreens(c: MoreChart, width: number): string[] {
  const errors: string[] = []
  const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height: c.height ?? 220 })
  const out: string[] = []
  try {
    chart.setOption(c.option as echarts.EChartsCoreOption, true)
    out.push(chart.renderToSVGString())
    for (const n of opt(c).series[0].data) {
      if (!n.children) continue
      chart.dispatchAction({ type: 'treemapRootToNode', seriesIndex: 0, targetNodeId: n.id })
      out.push(chart.renderToSVGString())
      chart.dispatchAction({ type: 'treemapRootToNode', seriesIndex: 0 })
    }
  } finally {
    chart.dispose()
    spy.mockRestore()
    warn.mockRestore()
  }
  if (errors.length) expect.fail(errors.join('\n'))
  return out
}
/** 图上印着的、「¥」开头的字 */
const moneyTexts = (svg: string) => [...svg.matchAll(/>(¥[^<]*)</g)].map((m) => m[1])
/** 图上印着的每一段字 */
const svgTexts = (svg: string) => [...svg.matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1])
/** 块上的字读成人看到的样子：一格一段，图片格子写「[图]」，空隙格写一个空格 */
const plain = (s: string) => s.replace(/\{(\w+)\|([^}]*)\}/g, (_m, k: string, t: string) => (k.startsWith('i') ? '[图]' : t || ' '))

/**
 * 9/1–9/20 这段时间：午餐 30、晚餐 20、直接记在「日常餐饮」上的 10；房租 3500；手机 800（非经常，没二级）；
 * 游戏充值 5。另有同段的转账（还白条）、校准、工资，以及段外 8/31、9/21 各一笔支出，都不该算。
 */
const BOOK: Transaction[] = [
  spend('2026-09-01', 30, 'lunch'),
  spend('2026-09-05', 20, 'dinner'),
  spend('2026-09-20', 10, 'food'),
  spend('2026-09-03', 3500, 'rent'),
  spend('2026-09-08', 800, 'big'),
  spend('2026-09-09', 5, 'game'),
  tx({ type: 'transfer', amount: Y(600), date: '2026-09-10', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: Y(-200), date: '2026-09-11' }),
  tx({ type: 'income', amount: Y(8000), date: '2026-09-10', category_id: 'salary' }),
  spend('2026-08-31', 999, 'lunch'),
  spend('2026-09-21', 999, 'lunch'),
]

describe('支出版图（矩形树图）', () => {
  it('9/1–9/20：大类按金额从大到小，有二级的挂着二级；直接记在「日常餐饮」上的 10 块单列「未细分」；转账、校准、工资、段外的都不算', () => {
    // 变异：「未细分」不单列（直接记在一级上的不进二级）→ 日常餐饮 60 底下只有 50 块的二级，红
    // 变异：只挡转账和校准、收入也收 → 多出工资那块，红
    // 变异：区间右端写成 `t.date >= inp.end`（不含 9/20）→ 未细分那 10 块没了，红
    const c = open(BOOK)
    expect(c.key).toBe('treemap')
    expect(c.title).toBe(TREEMAP_TITLE)
    expect(c.span).toBe(rangeSpan('2026-09-01', '2026-09-20', '2026-09-20'))
    expect(view(c)).toEqual([
      '经常生活开支 3500',
      '  房租 3500',
      '非经常生活消费 800',
      '日常餐饮 60',
      '  午餐 30',
      '  晚餐 20',
      `  ${UNSPLIT_NAME} 10`,
      '娱乐消费 5',
      '  游戏充值 5',
    ])
  })

  it('「非经常生活消费」只直接记在大类上：一整块，没有第二层（不造一个只有「未细分」的子块，点它不动）', () => {
    // 变异：去掉 onlyDirect 判断 → 非经常下面挂一个「未细分 800」，红
    const big = opt(open(BOOK)).series[0].data.find((n) => n.name === '非经常生活消费')!
    expect(big.children).toBeUndefined()
  })

  it('先看大类、点进去看二级：leafDepth 1；点叶子不放大、不能拖；底下有面包屑，第一格「全部支出」点了回到大类', () => {
    // 变异：nodeClick 改回默认的 'zoomToNode' → 点「非经常」那种没二级的块会被放大到占满整张图，红
    // 面包屑（整合时加的）：ECharts 钻进去之后往回退只有面包屑这一条路，关掉就回不来。
    // 变异：breadcrumb.show 改回 false → 红；去掉 series 的 name → 第一格印「series0」，红；
    // 变异：series 的 bottom 改回 0 → 面包屑压在块上，红
    const s = opt(open(BOOK)).series[0] as Series & { name?: string; bottom: number; breadcrumb: { show: boolean; bottom: number; height: number } }
    expect(s.leafDepth).toBe(1)
    expect(s.breadcrumb.show).toBe(true)
    expect(s.name).toBe(ROOT_NAME)
    expect(s.bottom).toBeGreaterThanOrEqual(s.breadcrumb.bottom + s.breadcrumb.height)
    expect(s.nodeClick).toBe('link')
    expect(s.roam).toBe(false)
  })

  it('颜色：大类和饼图一样 categoryColor(名字, 按金额的名次)；二级 childShade(大类色, 二级的 sort)；「未细分」就是大类色', () => {
    // 让晚餐花得比午餐多：按金额的名次（晚餐第 1、午餐第 2）和 sort（午餐 1、晚餐 2）正好反过来。
    // 变异：二级按名次取色（childShade(color, i + 1)）→ 晚餐拿到午餐的颜色，红
    const txs = [spend('2026-09-01', 30, 'lunch'), spend('2026-09-02', 90, 'dinner'), spend('2026-09-03', 10, 'food'), spend('2026-09-04', 5000, 'rent')]
    const data = opt(open(txs)).series[0].data
    const food = data.find((n) => n.name === '日常餐饮')!
    const foodColor = categoryColor('日常餐饮', 1)
    expect(data[0].itemStyle.color).toBe(categoryColor('经常生活开支', 0))
    expect(food.itemStyle.color).toBe(foodColor)
    expect(food.children!.map((ch) => [ch.name, ch.itemStyle.color])).toEqual([
      ['晚餐', childShade(foodColor, 2)],
      ['午餐', childShade(foodColor, 1)],
      [UNSPLIT_NAME, foodColor],
    ])
  })

  it('分类查不到（孤儿记录）→「未分类」一整块；二级的大类被删了 → 把它自己当大类，钱一分不少', () => {
    // 变异：查不到分类就 continue（当它不存在）→ 没有「未分类」、总额少 7 块，红
    const cats = [...CATS, C('orphan', '宵夜', 3, 'gone')]
    const txs = [spend('2026-09-01', 7, 'deleted-cat'), spend('2026-09-02', 4, 'orphan'), spend('2026-09-03', 1, null)]
    const c = treemap({ ...inputOf(txs, '2026-09-01', '2026-09-20'), cats })
    expect(view(c)).toEqual([`${UNCATEGORIZED_NAME} 8`, '宵夜 4'])
    expect(opt(c).series[0].data[0].id).toBe(`p:${UNCATEGORIZED_ID}`)
  })

  it('提示框：分类名里有尖括号、& 和引号 → 原样显示，不被浏览器当成标签吞掉', () => {
    // 审阅 #2。变异：去掉全名那行的 esc → 「娱乐消费 · <Steam>充值」原样进 HTML，<Steam> 被吞，红
    // 变异：去掉「占…」那行的 esc → 「占<游戏>&娱乐」原样进 HTML，红
    const cats = [...CATS.filter((c) => c.id !== 'fun'), C('fun', '<游戏>&娱乐', 4), C('steam', '<Steam>充值', 2, 'fun')]
    const c = treemap({ ...inputOf([spend('2026-09-02', 60, 'steam'), spend('2026-09-03', 40, 'game')], '2026-09-01', '2026-09-20'), cats })
    const html = opt(c).tooltip.formatter({ data: { id: 's:steam' } })
    expect(html.split('<br/>')[0]).toBe('&lt;游戏&gt;&amp;娱乐 · &lt;Steam&gt;充值')
    expect(html).toContain('占&lt;游戏&gt;&amp;娱乐')
    expect(html).not.toMatch(/<(Steam|游戏)>/)
    expect(opt(c).tooltip.formatter({ data: { id: 'p:fun' } }).split('<br/>')[0]).toBe('&lt;游戏&gt;&amp;娱乐')
  })

  it('提示框：点「午餐」→ 全名「日常餐饮 · 午餐」、¥30.00、占这段时间支出、占日常餐饮 50%', () => {
    // 变异：二级的「占大类」拿总支出当分母 → 0.7%，红
    const c = open(BOOK)
    const html = opt(c).tooltip.formatter({ data: { id: 's:lunch' } })
    expect(html).toContain('日常餐饮 · 午餐')
    expect(html).toContain('¥30.00')
    // 30 / 4365 = 0.69%
    expect(html).toMatch(/占这段时间支出<\/span><span[^>]*>0\.7%/)
    expect(html).toMatch(/占日常餐饮<\/span><span[^>]*>50\.0%/)
    // 大类没有「占大类」那一行
    expect(opt(c).tooltip.formatter({ data: { id: 'p:life' } })).not.toContain('占经常')
  })

  it('块上的字：第一行名字、第二行「¥金额（整数元）」，每一段都是声明了宽度的一整格——放不下就整格不画，不会截成半截', () => {
    // 用户 2026-09-29：「如果太小的，字或数字无法显示全的，就不显示了」。
    // 变异：cell 不声明宽度（rich 里登记成 {}）→ 红
    // 变异：金额那格不和名字比宽（去掉 Math.max）→「午餐 / ¥30」那块金额比名字窄，红
    const s = opt(open(BOOK)).series[0]
    const fmt = s.label.formatter
    const upper = s.levels[1].upperLabel!.formatter
    expect(plain(fmt({ data: { id: 'p:life' } }))).toBe('经常生活开支\n¥3,500')
    expect(plain(fmt({ data: { id: 's:lunch' } }))).toBe('午餐\n¥30')
    expect(plain(upper({ data: { id: 'p:food' } }))).toBe('日常餐饮 ¥60')
    expect(blockMoney(123456)).toBe('¥1,235')
    const ids = s.data.flatMap((n) => [n.id, ...(n.children ?? []).map((ch) => ch.id)])
    for (const id of ids) {
      for (const t of [fmt({ data: { id } }), upper({ data: { id } })]) {
        // 格子外面只有换行
        expect(t.replace(/\{\w+\|[^}]*\}/g, '')).toMatch(/^\n?$/)
        for (const [, k] of t.matchAll(/\{(\w+)\|/g)) expect(typeof s.label.rich[k]?.width, `${id} 的 ${k}`).toBe('number')
      }
      // 金额那格至少和名字那格一样宽（没图标时认块靠名字）：名字放不下的块，金额也放不下，不会只剩一个数
      const [nameCell, moneyCell] = [...fmt({ data: { id } }).matchAll(/\{w(\d+)\|/g)].map((m) => Number(m[1]))
      expect(moneyCell, id).toBeGreaterThanOrEqual(nameCell)
    }
  })

  it('boxWidth（一格声明多宽）宁宽勿窄：汉字正好一个字宽，数字、¥、emoji 都不比 iPhone 上实际画的窄', () => {
    // 声明窄了，字会伸出自己的格子压到隔壁块上。iPhone 上图表的字是 Helvetica：数字、¥ 0.556 个字宽，逗号 0.278；emoji 约 1.25。
    // 变异：emoji 按 chart.textWidth 的 0.55 算 → 红；数字按 0.5 算 → 红
    expect(boxWidth('日常餐饮')).toBe(45)
    expect(boxWidth('¥3,456')).toBeGreaterThanOrEqual(Math.ceil((0.556 * 5 + 0.278) * 11))
    expect(boxWidth('¥3,456')).toBeLessThanOrEqual(40)
    expect(boxWidth('🍚')).toBeGreaterThanOrEqual(Math.ceil(1.25 * 11))
    expect(boxWidth('🕹️')).toBe(boxWidth('🍚'))
  })

  it('真画出来（SSR）：一年的示例账本，第一屏的金额都是完整的（没有截断），底下面包屑第一格是「全部支出」', () => {
    // 这条守的是「示例账本在 393 宽的手机上画得出来、不报错、面包屑在」。
    // 注意：它**守不住** moneyFits——示例账本里没有窄到会截断的块，把 moneyFits 改成恒为 true 它照样绿
    // （原注释写「意外开支画成 ¥3 → 红」，实测不红，审阅 #19）。截断由下面两条守。
    // 变异：去掉 series 的 name → 面包屑印成 series0，红
    const [svg] = renderScreens(treemap(sampleInput()), 329)
    const money = moneyTexts(svg)
    expect(money.length).toBeGreaterThan(0)
    const whole = new Set(treeOf(sampleInput()).map((n) => blockMoney(n.cents)))
    for (const m of money) if (!whole.has(m)) expect.fail(`图上印着「${m}」，是被截断的金额`)
    expect(svg).toContain(`>${ROOT_NAME}<`)
  })

  it('真画出来（SSR，302 宽）：房租 ¥153、意外开支 ¥1,226 → 房租那条窄块金额放不下就整格不写，不印成「¥1」', () => {
    // 房租占 11%，那条块三十来 px 宽。原来整串交给 ECharts 截断，省略号放不下时被扔掉，「¥153」印成「¥1」。
    // 变异：cell 不声明宽度 → 印出「¥1」，红
    const txs = [spend('2026-09-01', 153.4, 'rent'), spend('2026-09-02', 1226.4, 'oops')]
    const c = treemap({ ...inputOf(txs, '2026-09-01', '2026-09-20'), cats: [...CATS, C('oops', '意外开支', 5)] })
    const money = renderScreens(c, 302).flatMap(moneyTexts)
    expect(money).toContain('¥1,226')
    expect(money).not.toContain('¥1')
    expect(money.every((m) => m === '¥153' || m === '¥1,226')).toBe(true)
  })

  it('真画出来（SSR，随机账本 × 随机屏宽 110–330，大类一屏 + 钻进每个大类各一屏）：图上每一段字都是完整的名字、金额或图标，没有一处被截断', () => {
    // 用户 2026-09-29：「如果太小的，字或数字无法显示全的，就不显示了」。
    // 变异：cell 不声明宽度（交给 ECharts 截断）→ 印出「日常...」「¥1,2...」，红
    // 变异：boxWidth 把汉字按半个字宽算 → 名字格声明得比实际窄，ECharts 照画整格，SSR 量出来伸出块外——这条管不到，由上面 boxWidth 那条管
    const cats: Category[] = [
      ...CATS.map((c) => (c.id === 'food' ? { ...c, icon: '🍚' } : c.id === 'lunch' ? { ...c, icon: 'img:lunch' } : c.id === 'fun' ? { ...c, icon: '🕹️' } : c)),
      { ...C('oops', '意外开支', 5), icon: '⚡' },
    ]
    const IDS = ['rent', 'oops', 'big', 'game', 'lunch', 'dinner']
    for (let k = 0; k < 150; k++) {
      let seed = k * 7919 + 13
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32)
      const txs = IDS.slice(0, 2 + Math.floor(rnd() * 5)).map((id, i) => spend(`2026-09-0${i + 1}`, Math.round(100 + rnd() ** 3 * 20000) + 0.4, id))
      const w = 110 + Math.floor(rnd() * 220)
      const c = treemap({ ...inputOf(txs, '2026-09-01', '2026-09-20'), cats })
      const nodes = treeOf({ txs, cats, start: '2026-09-01', end: '2026-09-20' }).flatMap((n) => [n, ...n.children])
      const whole = new Set([...nodes.flatMap((n) => [n.name, blockMoney(n.cents)]), '🍚', '🕹️', '⚡', ROOT_NAME])
      for (const t of renderScreens(c, w).flatMap(svgTexts)) {
        if (!whole.has(t)) expect.fail(`第 ${k} 张（${w} 宽）：图上印着「${t}」，是被截断的字`)
      }
    }
  }, 30000)

  it('块上的字色跟着底色走：大类块是白字；钻进「日常餐饮」，浅黄的「晚餐」块上是深字（白字只有 1.8:1），深棕的「午餐」块上还是白字', () => {
    // 审阅 #6：原来一律白字，钻进大类后二级浅色块上的白字对比度只有 1.3–1.8，看不清。
    // 变异：data 里不给每块单独的 label.color（全用 series 的白字）→ 晚餐那块是白字，红
    // 变异：readableOn 恒返回 CHART.ink → 大类块成了深字，红
    const c = open(BOOK)
    const data = opt(c).series[0].data
    const food = data.find((n) => n.id === 'p:food')!
    const shade = (id: string) => food.children!.find((ch) => ch.id === id)!
    expect(food.label.color).toBe(CHART.gap)
    expect(food.upperLabel.color).toBe(CHART.gap)
    expect(shade('s:dinner').itemStyle.color).toBe(childShade(food.itemStyle.color, 2))
    expect(shade('s:dinner').label.color).toBe(CHART.ink)
    expect(contrast(CHART.ink, shade('s:dinner').itemStyle.color)).toBeGreaterThanOrEqual(4.5)
    expect(shade('s:lunch').label.color).toBe(CHART.gap)
    // 每一块：字色就是 readableOn(底色)
    for (const n of data) {
      expect(n.label.color).toBe(readableOn(n.itemStyle.color))
      for (const ch of n.children ?? []) expect(ch.label.color).toBe(readableOn(ch.itemStyle.color))
    }
    // 真画出来：钻进日常餐饮那一屏，「晚餐」那行字用的是深字
    const screens = renderScreens(c, 329)
    const foodScreen = screens.find((svg) => svg.includes('>晚餐'))!
    const dinner = [...foodScreen.matchAll(/<text([^>]*)>晚餐/g)].map((m) => m[1])
    expect(dinner.length).toBeGreaterThan(0)
    for (const attrs of dinner) expect(attrs).toContain(`fill="${CHART.ink}"`)
  })

  it('这段时间只有工资和还白条 → 一句话，不画图', () => {
    // 变异：删掉 empty 分支 → option 是一棵空树，红
    const c = open([tx({ type: 'income', amount: Y(5000), date: '2026-09-10', category_id: 'salary' }), tx({ type: 'transfer', amount: Y(300), date: '2026-09-11', to_account_id: 'jd' })])
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
  })

  it('不变量（随机账本 × 随机时间段）：大类之和 = 段内支出；有二级的大类 = 二级之和；整月时每个大类的钱和 compute.byCategory（饼图）一分不差', () => {
    // 变异：「未细分」不单列 → 有二级的大类 ≠ 二级之和，红
    // 变异：大类金额只加二级（直接记在一级上的不进 r.cents）→ 和 byCategory 对不上，红
    let s = 20260929
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    const CAT_IDS = ['lunch', 'dinner', 'food', 'rent', 'life', 'big', 'game', 'fun', null, 'nope']
    for (let k = 0; k < 300; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 50; i++) {
        const type = TYPES[Math.floor(rnd() * TYPES.length)]
        txs.push(tx({ type, amount: 1 + Math.floor(rnd() * 50000), date: addDays('2026-01-01', Math.floor(rnd() * 240)), category_id: type === 'expense' ? CAT_IDS[Math.floor(rnd() * CAT_IDS.length)] : null }))
      }
      const whole = rnd() < 0.5
      const ym = `2026-0${1 + Math.floor(rnd() * 8)}`
      const start = whole ? `${ym}-01` : addDays('2026-01-01', Math.floor(rnd() * 200))
      const end = whole ? monthRange(ym).end : addDays(start, Math.floor(rnd() * 90))
      const tree = treeOf({ txs, cats: CATS, start, end })
      const want = txs.filter((t) => t.type === 'expense' && t.date >= start && t.date <= end).reduce((a, t) => a + t.amount, 0)
      const got = tree.reduce((a, n) => a + n.cents, 0)
      if (got !== want) expect.fail(`${start}–${end}：大类之和 ${got} ≠ 段内支出 ${want}`)
      for (const n of tree) {
        if (n.children.length && n.children.reduce((a, ch) => a + ch.cents, 0) !== n.cents) expect.fail(`${n.name} ≠ 二级之和`)
        if (n.children.length === 1 && n.children[0].name === UNSPLIT_NAME) expect.fail(`${n.name} 只挂了一个「未细分」`)
      }
      for (let i = 1; i < tree.length; i++) if (tree[i].cents > tree[i - 1].cents) expect.fail('大类没按金额从大到小')
      if (whole) {
        // 按 id 排了再比：同额的两类谁先谁后，两边的规矩不一样（这里按 sort，byCategory 按出现先后）
        const pie = byCategory(txs, CATS, ym, 'expense').map((a) => `${a.id} ${a.amount}`).sort()
        if (JSON.stringify(tree.map((n) => `${n.id} ${n.cents}`).sort()) !== JSON.stringify(pie)) expect.fail(`${ym}：和饼图对不上`)
      }
    }
  })

  it('源码不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 treemap.ts 里加一行 `const X = '#ffffff'` → 红
    const src = readFileSync(new URL('./treemap.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(CHART.gap).toBeTruthy()
  })
})

describe('支出版图：块上的图标是分类自己的，不是一排一样的「▶」', () => {
  // 用户 2026-09-29：「支出版图，一级分类的 logo，怎么都是一样的，而且好丑」——ECharts 默认在能点进去的块前面加「▶」，
  // iPhone 上还画成蓝色方块 emoji。换成每个分类自己的图标（emoji 或 3D 图），和流水行、记账页同一个
  const ICON_CATS: Category[] = [
    { ...C('food', '日常餐饮', 1), icon: '🍚' },
    { ...C('lunch', '午餐', 1, 'food'), icon: 'img:lunch' },
    { ...C('dinner', '晚餐', 2, 'food'), icon: 'img:gone' },
    { ...C('fun', '娱乐消费', 4), icon: null },
  ]
  const txs = [spend('2026-09-02', 300, 'lunch'), spend('2026-09-03', 200, 'dinner'), spend('2026-09-04', 100, 'fun')]
  const c = treemap({ ...inputOf(txs, '2026-09-01', '2026-09-20'), cats: ICON_CATS })
  const series = opt(c).series[0] as Series & { drillDownIcon: string }
  const fmt = series.label.formatter

  it('一级用 emoji 的：名字前面就是那个 emoji；没设图标的只写名字', () => {
    // 变异：head 不拼图标那格 → 「日常餐饮」前面没有 🍚，红
    expect(plain(fmt({ data: { id: 'p:food' } }))).toBe('🍚 日常餐饮\n¥500')
    expect(plain(fmt({ data: { id: 'p:fun' } }))).toBe('娱乐消费\n¥100')
  })

  it('用 3D 图的：富文本图片格子，图就是「我的图」里那一张；图被撤掉了（登记表里没有）就只写名字', () => {
    // 变异：不把 rich 交给 label → 图片格子没登记，ECharts 印出「{i1|}」字样，红
    const lunch = fmt({ data: { id: 's:lunch' } })
    const key = lunch.match(/^\{(i\d+)\|\}/)?.[1]
    expect(key).toBeTruthy()
    expect(plain(lunch)).toBe('[图] 午餐\n¥300')
    expect(series.label.rich[key!].backgroundColor!.image).toMatch(/art\/lunch-v1\.png$/)
    expect(series.label.rich[key!].width).toBe(BLOCK_ICON_PX)
    expect(plain(fmt({ data: { id: 's:dinner' } }))).toBe('晚餐\n¥200')
  })

  it('默认的「▶」关掉了', () => {
    // 变异：drillDownIcon 改回 '▶' → 红
    expect(series.drillDownIcon).toBe('')
    expect(c.note).not.toContain('▶')
  })

  it('blockIcon 本身：emoji、3D 图、撤掉的图、没设', () => {
    expect(blockIcon('🎮', 'i0')).toEqual({ emoji: '🎮' })
    expect(blockIcon('img:bag', 'i7')).toMatchObject({ image: '{i7|}' })
    expect(blockIcon('img:nope', 'i1')).toBeNull()
    expect(blockIcon(null, 'i2')).toBeNull()
  })
})
