/// <reference types="node" />
// 环比涨跌榜。输入一律是「用户这个月和上个月记了这些账，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { describe, expect, it, vi } from 'vitest'
import type { Category, Transaction } from '../../types'
import { textWidth } from '../chart'
import { monthSummary } from '../compute'
import { addDays, monthRange, shiftMonth } from '../date'
import { filterFromQuery, matchesFilter } from '../filter'
import { CHART } from '../palette'
import { DELTA_TOP, delta, deltaBoard, deltaRows, NAME_FONT, NAME_MIN_W, nameWidth, signedYuan, VALUE_FONT } from './delta'
import type { MoreChart, MoreInput } from './types'

echarts.use([BarChart, GridComponent, TooltipComponent, SVGRenderer])

const C = (id: string, name: string, sort: number, parent_id: string | null = null, kind: Category['kind'] = 'expense'): Category => ({
  id, kind, parent_id, name, icon: null, sort, is_archived: false, note: null,
})
const CATS: Category[] = [
  C('food', '日常餐饮', 1),
  C('lunch', '午餐', 1, 'food'),
  C('dinner', '晚餐', 2, 'food'),
  C('foodOther', '其他', 3, 'food'),
  C('life', '经常生活开支', 2),
  C('rent', '房租', 1, 'life'),
  C('bus', '通勤', 2, 'life'),
  C('big', '非经常生活消费', 3),
  C('fun', '娱乐消费', 4),
  C('game', '游戏充值', 1, 'fun'),
  C('funOther', '其他', 2, 'fun'),
  C('oops', '意外开支', 5),
  C('salary', '工资/实习', 1, null, 'income'),
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `d${seq}`, account_id: 'boc', to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, is_offset: null, created_at: '2026-09-01T00:00:00.000Z', ...p,
  }
}
const Y = (yuan: number) => Math.round(yuan * 100)
const spend = (date: string, yuan: number, cat: string | null) => tx({ type: 'expense', amount: Y(yuan), date, category_id: cat })

const inputOf = (txs: Transaction[], ym = '2026-09', today = '2026-09-28'): MoreInput => ({
  txs, accounts: [], cats: CATS, ym, start: `${ym}-01`, end: monthRange(ym).end, today,
})
const open = (txs: Transaction[], ym = '2026-09'): MoreChart => delta(inputOf(txs, ym))

type Item = { value: number; itemStyle: { color: string }; label: { position: string; formatter: () => string } }
type Opt = {
  series: { data: Item[] }[]
  xAxis: { min: number; max: number; interval: number }
  yAxis: { data: string[]; inverse: boolean; axisLine: { onZero: boolean } }
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
/** 从上往下每一行：「分类名 ±金额」，就是用户在图上读到的 */
const view = (c: MoreChart) => opt(c).yAxis.data.map((name, i) => `${name} ${opt(c).series[0].data[i].label.formatter()}`)

/**
 * 点一行跳到流水页，流水页列出来的是哪几笔：照着 Ledger.tsx 的做法——月份取 ym，筛选取 filterFromQuery，
 * 一级是 rootOf（parent_id ?? id，查不到是 undefined），逐笔过 matchesFilter。
 */
function ledgerList(txs: Transaction[], cats: Category[], query: string): Transaction[] {
  const q = new URLSearchParams(query)
  const f = filterFromQuery(q)
  if (!f) throw new Error(`「${query}」没带 cat，流水页不换筛选`)
  const byId = new Map(cats.map((c) => [c.id, c]))
  const rootOf = (id: string) => {
    const c = byId.get(id)
    return c ? (c.parent_id ?? c.id) : undefined
  }
  return txs.filter((t) => t.date.slice(0, 7) === q.get('ym') && matchesFilter(t, f, rootOf))
}
const sum = (txs: Transaction[]) => txs.reduce((a, t) => a + t.amount, 0)

/**
 * 9 月 vs 8 月：
 *   多花：游戏充值 50→300（+250）、午餐 300→500（+200）、通勤 0→80（+80）、直接记在「日常餐饮」上的 20→60（+40）、
 *         意外开支 0→30（+30）、娱乐消费下的「其他」0→5（+5，第六名，上不了榜）
 *   少花：非经常生活消费 1000→0（-1000）、晚餐 200→150（-50）、没分类的 10→0（-10）
 *   不变：房租 3500→3500（不上榜）
 * 另有 9 月的还白条、校准、工资，7 月和 10 月各一笔午餐：都不算。
 */
const BOOK: Transaction[] = [
  spend('2026-08-03', 50, 'game'), spend('2026-09-03', 300, 'game'),
  spend('2026-08-04', 300, 'lunch'), spend('2026-09-04', 500, 'lunch'),
  spend('2026-09-05', 80, 'bus'),
  spend('2026-08-06', 20, 'food'), spend('2026-09-06', 60, 'food'),
  spend('2026-09-07', 30, 'oops'),
  spend('2026-09-08', 5, 'funOther'),
  spend('2026-08-09', 1000, 'big'),
  spend('2026-08-10', 200, 'dinner'), spend('2026-09-10', 150, 'dinner'),
  spend('2026-08-11', 10, null),
  spend('2026-08-01', 3500, 'rent'), spend('2026-09-01', 3500, 'rent'),
  tx({ type: 'transfer', amount: Y(5000), date: '2026-09-17', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: Y(-200), date: '2026-09-20' }),
  tx({ type: 'income', amount: Y(8000), date: '2026-09-10', category_id: 'salary' }),
  spend('2026-07-31', 999, 'lunch'),
  spend('2026-10-01', 999, 'lunch'),
]

describe('环比涨跌榜', () => {
  it('9 月 vs 8 月：上面是多花最多的五个（从多到少），下面是少花最多的（少花最多的在最底下）；房租没变、「其他」+5 是第六名，都不上榜', () => {
    // 变异：少花那半边不 reverse → 非经常生活消费跑到少花那组的最上面，红
    // 变异：取前 DELTA_TOP + 1 个 → 「其他 +¥5」上榜，红
    // 变异：上个月写成「所选月份之前的都算」（`m > inp.ym` 才跳过）→ 7/31 那笔午餐 999 进了上个月，午餐成了少花 799，红
    const c = open(BOOK)
    expect(c.key).toBe('delta')
    expect(c.title).toBe('环比涨跌榜')
    expect(c.span).toBe('26.8–26.9')
    expect(view(c)).toEqual([
      '游戏充值 +¥250',
      '午餐 +¥200',
      '通勤 +¥80',
      '日常餐饮·未细分 +¥40',
      '意外开支 +¥30',
      '未分类 -¥10',
      '晚餐 -¥50',
      '非经常生活消费 -¥1,000',
    ])
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([250, 200, 80, 40, 30, -10, -50, -1000])
  })

  it('多花的支出红、朝右，字在柱子右边；少花的收入绿、朝左，字在柱子左边', () => {
    // 变异：颜色写反（diff > 0 用 CHART.income）→ 红
    // 变异：少花的字也放 'right' → 压在 0 线右边的红柱子那一侧，红
    const data = opt(open(BOOK)).series[0].data
    for (const d of data) {
      expect(d.itemStyle.color).toBe(d.value > 0 ? CHART.expense : CHART.income)
      expect(d.label.position).toBe(d.value > 0 ? 'right' : 'left')
    }
  })

  it('0 在正中间：金额轴两边一样长；分类名那根轴不压在 0 线上', () => {
    // 变异：xAxis 不设 min（让 ECharts 自己定，从 -1000 那头开始）→ 红
    // 变异：去掉 axisLine.onZero: false → 分类名画在 0 线上压着绿柱子，红
    const o = opt(open(BOOK))
    expect(o.xAxis.min).toBe(-o.xAxis.max)
    expect(o.xAxis.interval).toBe(o.xAxis.max)
    expect(o.xAxis.max).toBeGreaterThan(1000)
    expect(o.yAxis.axisLine.onZero).toBe(false)
    expect(o.yAxis.inverse).toBe(true)
  })

  it('提示框：「日常餐饮」那一行写明是没选二级的那部分，9 月 ¥60、8 月 ¥20、多花 ¥40、+200%；「通勤」上个月没花', () => {
    // 变异：direct 恒为 false → 提示框里只写「日常餐饮」，和「日常餐饮」整个大类分不清，红
    // 变异：上个月是 0 时照样算百分比 → 「Infinity%」，红
    const o = opt(open(BOOK))
    const food = o.tooltip.formatter([{ dataIndex: 3 }])
    expect(food).toContain('日常餐饮 · 未细分（没选二级的）')
    expect(food).toMatch(/9月<\/span><span[^>]*>¥60\.00/)
    expect(food).toMatch(/8月<\/span><span[^>]*>¥20\.00/)
    expect(food).toMatch(/多花<\/span><span[^>]*>¥40\.00/)
    expect(food).toMatch(/涨跌<\/span><span[^>]*>\+200%/)
    const bus = o.tooltip.formatter([{ dataIndex: 2 }])
    expect(bus).toContain('经常生活开支 · 通勤')
    expect(bus).toContain('上个月没花')
    expect(o.tooltip.formatter([{ dataIndex: 7 }])).toMatch(/少花<\/span><span[^>]*>¥1,000\.00/)
  })

  it('提示框：本来就没有二级的大类（意外开支、非经常生活消费）、未分类，第一行就是它的名字，不写「（没选二级的）」', () => {
    // 它们根本没有二级可选，写「没选二级的」是在暗示还有另一部分钱没列出来（审阅 #22）
    // 变异：direct 不看这个大类有没有二级（`Boolean(c && !parent)`）→ 意外开支写成「意外开支 · 未细分（没选二级的）」，红
    const o = opt(open(BOOK))
    expect(o.yAxis.data[4]).toBe('意外开支')
    for (const [i, name] of [[4, '意外开支'], [5, '未分类'], [7, '非经常生活消费']] as const) {
      const html = o.tooltip.formatter([{ dataIndex: i }])
      expect(html.split('<br/>')[0]).toBe(name)
      expect(html).not.toContain('没选二级')
    }
  })

  it('分类名里有尖括号、引号：提示框里原样显示，不被浏览器当成标签吞掉', () => {
    // 变异：full() 不过 esc → 提示框里是「<Steam>充值」原文，浏览器把 <Steam> 当标签吞了，只剩「充值」，红
    const cats = [...CATS, C('steam', '<Steam>充值', 3, 'fun'), C('q', '"周末"&聚餐', 6)]
    const c = delta({ ...inputOf([spend('2026-09-02', 60, 'steam'), spend('2026-09-03', 30, 'q')]), cats })
    const o = opt(c)
    expect(o.yAxis.data).toEqual(['<Steam>充值', '"周末"&聚餐'])
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).toContain('娱乐消费 · &lt;Steam&gt;充值')
    expect(o.tooltip.formatter([{ dataIndex: 0 }])).not.toContain('<Steam>')
    expect(o.tooltip.formatter([{ dataIndex: 1 }]).split('<br/>')[0]).toBe('&quot;周末&quot;&amp;聚餐')
  })

  it('点哪一行就跳 9 月里这一行的那几笔：二级带 sub、直接记在大类上的 sub=none、没二级的大类只带 cat、未分类 cat=none；下标越界不跳', () => {
    // 审阅 #7：原来一律 `cat=all`，点「午餐 +¥200」跳去的是 9 月全部流水。
    // 变异：rowQuery 一律返回 `cat=all`（改回去）→ 红
    // 变异：直接记在大类上的那行不带 `&sub=none` → 跳过去是整个日常餐饮（午餐、晚餐都在），红
    const c = open(BOOK)
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => c.onPoint!(i, 0))).toEqual([
      'ym=2026-09&type=expense&cat=fun&sub=game',
      'ym=2026-09&type=expense&cat=food&sub=lunch',
      'ym=2026-09&type=expense&cat=life&sub=bus',
      'ym=2026-09&type=expense&cat=food&sub=none',
      'ym=2026-09&type=expense&cat=oops',
      'ym=2026-09&type=expense&cat=none',
      'ym=2026-09&type=expense&cat=food&sub=dinner',
      'ym=2026-09&type=expense&cat=big',
    ])
    expect(c.onPoint!(8, 0)).toBeNull()
    expect(c.onPoint!(-1, 0)).toBeNull()
  })

  it('跳过去流水页真列出这几笔：点「日常餐饮·未细分」只有 9/6 那 60 块，点「午餐」只有 500 那笔；点「未分类」不混进没分类的工资', () => {
    // 用流水页自己的筛法（filterFromQuery + matchesFilter）过一遍，不是只比字符串。
    // 变异：不带 `type=expense` → 9 月那笔没分类的收入 8888 也列在「未分类」底下，红
    // 变异：sub=none 写成 sub=food（一级自己的 id）→ matchesFilter 认得，这条不红；写成 `sub=${UNSPLIT_NAME}` → 一笔都筛不出，红
    const txs = [...BOOK, tx({ type: 'income', amount: Y(8888), date: '2026-09-12', category_id: null }), spend('2026-09-13', 45, null)]
    const c = open(txs)
    const at = (label: string) => c.onPoint!(opt(c).yAxis.data.indexOf(label), 0)!
    expect(ledgerList(txs, CATS, at('日常餐饮·未细分')).map((t) => [t.date, t.amount])).toEqual([['2026-09-06', Y(60)]])
    expect(ledgerList(txs, CATS, at('午餐')).map((t) => [t.date, t.amount])).toEqual([['2026-09-04', Y(500)]])
    expect(ledgerList(txs, CATS, at('未分类')).map((t) => [t.date, t.amount])).toEqual([['2026-09-13', Y(45)]])
    expect(ledgerList(txs, CATS, at('非经常生活消费'))).toEqual([])
  })

  it('跨年：1 月比去年 12 月，标题旁写「25.12–26.1」，柱子是 1 月减 12 月；11 月和 2 月的不算', () => {
    // 审阅 #18：月份减一在 1 月要退到去年 12 月。
    // 变异：上个月写成 `${年}-${月 - 1}`（2026-00）→ 上个月一笔都没有，午餐成了 +¥80、晚餐 +¥0 不上榜，红
    const txs = [
      spend('2025-12-05', 120, 'lunch'), spend('2026-01-05', 200, 'lunch'),
      spend('2025-12-20', 300, 'dinner'), spend('2026-01-20', 90, 'dinner'),
      spend('2025-12-31', 50, 'game'),
      spend('2025-11-30', 999, 'lunch'), spend('2026-02-01', 999, 'dinner'),
    ]
    const c = open(txs, '2026-01')
    expect(c.span).toBe('25.12–26.1')
    expect(view(c)).toEqual(['午餐 +¥80', '游戏充值 -¥50', '晚餐 -¥210'])
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([80, -50, -210])
    expect(opt(c).tooltip.formatter([{ dataIndex: 0 }])).toMatch(/12月<\/span><span[^>]*>¥120\.00/)
    expect(c.onPoint!(0, 0)).toBe('ym=2026-01&type=expense&cat=food&sub=lunch')
  })

  it('两个大类下都有叫「其他」的二级，都上了榜：轴上写「日常餐饮·其他」「娱乐消费·其他」，不是两个「其他」', () => {
    // 变异：轴上直接用二级名（不处理撞名）→ 两个「其他」，红
    const c = open([spend('2026-09-02', 100, 'foodOther'), spend('2026-08-02', 100, 'funOther'), spend('2026-09-03', 9, 'lunch')])
    expect(opt(c).yAxis.data).toEqual(['日常餐饮·其他', '午餐', '娱乐消费·其他'])
  })

  it('两个月都没支出（只有工资、还白条、7 月的一笔）→ 一句话；两个月每一类花得一样 → 也是一句话，不画空图', () => {
    // 变异：删掉「都没支出」那个 empty 分支 → 走到下一个分支，说成「每一类都花得一样多」，红
    // 变异：删掉「花得一样」那个 empty 分支 → 画了一张没有柱子的图，红
    // 变异：多花那组用 `r.diff >= 0` → 午餐 +¥0 上榜，没走到这句话，红
    const none = open([tx({ type: 'income', amount: Y(5000), date: '2026-09-10', category_id: 'salary' }), tx({ type: 'transfer', amount: Y(300), date: '2026-09-11', to_account_id: 'jd' }), spend('2026-07-02', 50, 'lunch')])
    expect(none.option).toBeNull()
    expect(none.empty).toBe('这个月和上个月都没有支出')
    const same = open([spend('2026-08-02', 50, 'lunch'), spend('2026-09-20', 50, 'lunch')])
    expect(same.option).toBeNull()
    expect(same.empty).toBe('和上个月比，每一类都花得一样多')
  })

  it('柱子头上的字：带正负号，一百块以上写整数元，以下写到分（整数去掉「.00」）', () => {
    // 变异：门槛写成 1000 分（十块）→ 「+¥56.87」成了「+¥57」，红
    expect(signedYuan(25000)).toBe('+¥250')
    expect(signedYuan(-100000)).toBe('-¥1,000')
    expect(signedYuan(5687)).toBe('+¥56.87')
    expect(signedYuan(350)).toBe('+¥3.50')
    expect(signedYuan(-12345678)).toBe('-¥123,457')
  })

  for (const w of [311, 329, 366]) {
    it(`真画出来量（SSR，${w + 64} 宽的手机）：柱子头上的金额不出画布、不压到左边的分类名`, () => {
      // 变异：axisHalf 不给标签留地方（直接返回最长那根的金额）→ 「+¥123,456」出画布、「-¥98,765」压到分类名上，红
      const txs = [
        spend('2026-09-02', 123456, 'rent'), spend('2026-08-02', 98765, 'big'),
        spend('2026-09-03', 40, 'lunch'), spend('2026-08-03', 7.5, 'dinner'),
        spend('2026-09-04', 30000, 'game'), spend('2026-08-04', 20000, 'oops'),
      ]
      const c = delta({ ...inputOf(txs), cats: [...CATS.filter((x) => x.id !== 'rent'), C('rent', '房租物业水电燃气', 1, 'life')] }, w)
      const errors: string[] = []
      const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
      const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: w, height: c.height ?? 220 })
      let svg = ''
      try {
        chart.setOption(c.option as echarts.EChartsCoreOption, true)
        svg = chart.renderToSVGString()
      } finally {
        chart.dispose()
        spy.mockRestore()
        warn.mockRestore()
      }
      expect(errors).toEqual([])
      const texts = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((m) => ({
        text: m[2],
        x: Number(m[1].match(/translate\(([-\d.]+) /)?.[1] ?? 0),
        size: Number(m[1].match(/font-size:([\d.]+)px/)?.[1] ?? 12),
        anchor: m[1].match(/text-anchor="(\w+)"/)?.[1] ?? 'start',
      }))
      const names = texts.filter((t) => t.size === NAME_FONT)
      const values = texts.filter((t) => t.size === VALUE_FONT && /¥/.test(t.text))
      expect(names).toHaveLength(6)
      expect(values.map((v) => v.text).sort()).toEqual(['+¥123,456', '+¥30,000', '+¥40', '-¥7.50', '-¥20,000', '-¥98,765'].sort())
      // 分类名右对齐在轴左边：x 就是它们的右边沿
      const nameRight = Math.max(...names.map((n) => n.x))
      for (const v of values) {
        const tw = textWidth(v.text, VALUE_FONT)
        if (v.anchor === 'end' && v.x - tw < nameRight + 2) expect.fail(`「${v.text}」左边到 ${(v.x - tw).toFixed(1)}，压到分类名（右沿 ${nameRight.toFixed(1)}）`)
        if (v.anchor !== 'end' && v.x + tw > w) expect.fail(`「${v.text}」右边到 ${(v.x + tw).toFixed(1)}，出了 ${w} 宽的画布`)
      }
    })
  }

  for (const w of [311, 329]) {
    it(`轴上的分类名（SSR，${w + 64} 宽的手机）：「日常餐饮·未细分」「非经常生活消费」整个写得下；再长的截成「…」`, () => {
      // 审阅 #8：原来那一列写死 72px，「日常餐饮·未细分」只剩「日常餐饮·...」，看不出是哪一部分。
      // 变异：nameWidth 改回写死 72 → 「日常餐饮·未细分」被截，红
      // 变异：去掉 axisLabel 的 `ellipsis: '…'` → 长名字截成「...」，红
      const cats = [...CATS, C('long', '宿舍水电燃气网费物业', 6)]
      const txs = [spend('2026-09-02', 60, 'food'), spend('2026-08-02', 900, 'big'), spend('2026-09-03', 30, 'long')]
      const c = delta({ ...inputOf(txs), cats }, w)
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: w, height: c.height ?? 220 })
      let svg = ''
      try {
        chart.setOption(c.option as echarts.EChartsCoreOption, true)
        svg = chart.renderToSVGString()
      } finally {
        chart.dispose()
      }
      const names = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)]
        .filter((m) => Number(m[1].match(/font-size:([\d.]+)px/)?.[1]) === NAME_FONT)
        .map((m) => m[2])
      expect(names).toHaveLength(3)
      expect(names).toContain('日常餐饮·未细分')
      expect(names).toContain('非经常生活消费')
      const long = names.find((n) => n.startsWith('宿舍'))!
      expect(long.endsWith('…')).toBe(true)
      expect(long).not.toContain('...')
      // 至少七个字 + 省略号那么宽
      expect(nameWidth(w)).toBeGreaterThanOrEqual(NAME_MIN_W)
      expect(NAME_MIN_W).toBeGreaterThanOrEqual(8 * NAME_FONT)
    })
  }

  it('不变量（随机账本 × 随机月份，含跨年的 1–3 月）：各行的这个月之和 = 这个月支出，上个月之和 = 上个月支出；上榜的多花那几行正是差额最大的几个，一行 0 都没有；点每一行，流水页那个月列出来的钱 = 这一行这个月的钱', () => {
    // 变异：deltaRows 不挡转账（`t.type === 'adjust'` 才跳过）→ 和 monthSummary 对不上，红
    // 变异：少花那组按差额从大到小排（`b.diff - a.diff`）再取前五 → 取到的是少花最少的几个，红
    // 变异：上个月写成 `${年}-${月 - 1}`（1 月退成 2026-00）→ 抽到 1 月时上个月之和对不上，红（原来 ym 只在 6–9 月里抽，这条不红）
    // 变异：rowQuery 不带 type=expense → 没分类的收入混进「未分类」，红
    // 变异：二级的父类被删了（「宵夜」）时带 `cat=<它自己>` → 流水页的 rootOf 认的是那个删掉的父类 id，一笔都筛不出，红
    const cats = [...CATS, C('orphan', '宵夜', 3, 'deleted-parent')]
    let s = 929
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    const IDS = ['lunch', 'dinner', 'foodOther', 'food', 'rent', 'bus', 'life', 'big', 'game', 'funOther', 'oops', null, 'gone', 'orphan']
    const months = new Set<string>()
    for (let k = 0; k < 300; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 40; i++) {
        const type = TYPES[Math.floor(rnd() * TYPES.length)]
        // 2025-10 到 2026-06：跨一次年
        txs.push(tx({ type, amount: 1 + Math.floor(rnd() * 40000), date: addDays('2025-10-01', Math.floor(rnd() * 270)), category_id: type === 'expense' ? IDS[Math.floor(rnd() * IDS.length)] : null }))
      }
      // 2025-11 到 2026-06，1–3 月都抽得到
      const ym = shiftMonth('2025-11', Math.floor(rnd() * 8))
      months.add(ym)
      const rows = deltaRows({ txs, cats, ym })
      const cur = rows.reduce((a, r) => a + r.cur, 0)
      const prev = rows.reduce((a, r) => a + r.prev, 0)
      if (cur !== monthSummary(txs, ym).expense) expect.fail(`${ym}：各行之和 ${cur} ≠ 这个月支出`)
      if (prev !== monthSummary(txs, shiftMonth(ym, -1)).expense) expect.fail(`${ym}：上个月各行之和 ${prev} ≠ 上个月支出`)
      const board = deltaBoard(rows)
      const up = board.filter((r) => r.diff > 0)
      const down = board.filter((r) => r.diff < 0)
      if (board.some((r) => r.diff === 0)) expect.fail('差额为 0 的上了榜')
      if (up.length > DELTA_TOP || down.length > DELTA_TOP) expect.fail('一边超过五个')
      const ups = rows.filter((r) => r.diff > 0).map((r) => r.diff).sort((a, b) => b - a).slice(0, DELTA_TOP)
      const downs = rows.filter((r) => r.diff < 0).map((r) => r.diff).sort((a, b) => a - b).slice(0, DELTA_TOP)
      if (JSON.stringify(up.map((r) => r.diff)) !== JSON.stringify(ups)) expect.fail('多花的不是最大的那几个，或者没从大到小排')
      if (JSON.stringify(down.map((r) => r.diff)) !== JSON.stringify([...downs].reverse())) expect.fail('少花的不是最多的那几个，或者顺序不对')
      const c = delta({ ...inputOf(txs, ym), cats })
      board.forEach((r, i) => {
        const q = c.onPoint!(i, 0)!
        if (sum(ledgerList(txs, cats, q)) !== r.cur) expect.fail(`${ym}「${r.name}」跳「${q}」，流水页列出 ${sum(ledgerList(txs, cats, q))}，这一行这个月是 ${r.cur}`)
      })
    }
    for (const m of ['2026-01', '2026-02', '2026-03']) expect(months.has(m)).toBe(true)
  })

  it('源码不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 delta.ts 里加一行 `const X = '#4d8a5e'` → 红
    const src = readFileSync(new URL('./delta.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
