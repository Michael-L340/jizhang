/// <reference types="node" />
// 钱去哪了（瀑布图）。输入一律是「用户记了这些账，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { monthRange } from '../date'
import { textWidth } from '../chart'
import { categoryColor, CHART } from '../palette'
import { MAX_CATS, waterfall, waterfallSteps, wrapLabel } from './waterfall'
import type { MoreChart, MoreInput } from './types'

const CATS: Category[] = [
  { id: 'food', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'lunch', kind: 'expense', parent_id: 'food', name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'dinner', kind: 'expense', parent_id: 'food', name: '晚餐', icon: null, sort: 2, is_archived: false, note: null },
  { id: 'fun', kind: 'expense', parent_id: null, name: '娱乐消费', icon: null, sort: 2, is_archived: false, note: null },
  { id: 'game', kind: 'expense', parent_id: 'fun', name: '游戏', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `w${seq}`,
    account_id: 'boc',
    to_account_id: null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...p,
  }
}
const Y = (yuan: number) => Math.round(yuan * 100)
const spend = (date: string, yuan: number, cat: string | null) => tx({ type: 'expense', amount: Y(yuan), date, category_id: cat })
const earn = (date: string, yuan: number) => tx({ type: 'income', amount: Y(yuan), date, category_id: 'salary' })

const inputOf = (txs: Transaction[], ym = '2026-09', cats = CATS): MoreInput => ({
  txs, accounts: [], cats, ym, start: `${ym}-01`, end: monthRange(ym).end, today: '2026-09-28',
})
const open = (txs: Transaction[], ym = '2026-09', cats = CATS, axisWidth?: number): MoreChart => waterfall(inputOf(txs, ym, cats), axisWidth)

type Bar = { value: number; itemStyle: { color: string } }
type Opt = {
  xAxis: { data: string[]; axisLabel: { formatter: (v: string) => string; width: number } }
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
  series: [{ data: number[]; stackStrategy?: string; itemStyle: { color: string } }, { data: Bar[]; stackStrategy?: string }]
}
const opt = (c: MoreChart) => c.option as unknown as Opt

/** 9 月：工资 5000；午餐 800 + 晚餐 400、游戏 300、一笔没分类的 100；还白条 2000、校准 -50；8 月有一笔不相干的 */
const SEPT: Transaction[] = [
  earn('2026-09-10', 5000),
  spend('2026-09-02', 800, 'lunch'),
  spend('2026-09-03', 400, 'dinner'),
  spend('2026-09-04', 300, 'game'),
  spend('2026-09-05', 100, null),
  tx({ type: 'transfer', amount: Y(2000), date: '2026-09-17', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: Y(-50), date: '2026-09-18' }),
  spend('2026-08-30', 9999, 'lunch'),
]

describe('钱去哪了', () => {
  it('9 月：收入 5000 起步，餐饮 1200 → 娱乐 300 → 未分类 100 从大到小往下扣，落在结余 3400；还白条、校准、8 月的账都不算', () => {
    // 变异：大类按从小到大扣（aggs 反过来）→ 红
    const c = open(SEPT)
    expect(c.key).toBe('waterfall')
    // 变异：标题改回「这个月的钱去哪了」→ 红；base 不带 span → 红
    expect(c.title).toBe('钱去哪了')
    expect(c.span).toBe('26.9')
    expect(opt(c).xAxis.data).toEqual(['收入', '日常餐饮', '娱乐', '未分类', '结余'])
    expect(opt(c).series[1].data.map((b) => b.value)).toEqual([5000, 1200, 300, 100, 3400])
    expect(opt(c).series[0].data).toEqual([0, 3800, 3500, 3400, 0])
  })

  it('不变量（随机账本）：相邻两根首尾相接；大类之和 = 本月支出；最后落点 = 收入 − 支出（收支按 t.type 自己加，不借实现的 monthSummary）', () => {
    // 变异：每个大类的柱子都从 0 起（`lo: 0, hi: amount`，不再往下扣）→ 红
    // 变异：waterfallSteps 的收入把转账也加进去（monthSummary 换成自己按 type !== 'expense' 加）→ 红
    let s = 17
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    const CAT_IDS = ['lunch', 'dinner', 'food', 'game', 'fun', null, 'ghost']
    for (let k = 0; k < 300; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 1 + Math.floor(rnd() * 25); i++) {
        const type = TYPES[Math.floor(rnd() * TYPES.length)]
        const day = String(1 + Math.floor(rnd() * 30)).padStart(2, '0')
        txs.push(tx({ type, amount: 1 + Math.floor(rnd() * 200000), date: `2026-09-${day}`, category_id: CAT_IDS[Math.floor(rnd() * CAT_IDS.length)] }))
      }
      const st = waterfallSteps({ txs, cats: CATS, ym: '2026-09' })
      // 自己按 type 加，不调 monthSummary（实现的收入就取自它，拿它对账等于让实现给自己判卷）
      const sumOf = (type: string) => txs.filter((t) => t.type === type && t.date.startsWith('2026-09')).reduce((a, t) => a + t.amount, 0)
      const income = sumOf('income')
      const expense = sumOf('expense')
      if (!st) {
        if (income || expense) expect.fail('有收支却没画')
        continue
      }
      const mid = st.slice(1, -1)
      if (st[0].hi !== income || st[0].lo !== 0) expect.fail('收入那根不是 0 → 收入')
      if (mid.reduce((t, x) => t + x.amount, 0) !== expense) expect.fail('大类之和 ≠ 本月支出')
      let top = income
      for (const x of mid) {
        if (x.hi !== top || x.hi - x.lo !== x.amount) expect.fail(`${x.name} 没接上前一根`)
        top = x.lo
      }
      const net = st[st.length - 1]
      if (net.amount !== income - expense || top !== income - expense) expect.fail(`结余 ${net.amount} ≠ ${income - expense}`)
      // 画到图上：垫底 + 实体 = 顶
      const c = waterfall(inputOf(txs))
      const o = opt(c)
      o.series[1].data.forEach((b, i) => {
        if (b.value < 0) expect.fail('实体柱出现负高度')
        if (Math.round((o.series[0].data[i] + b.value) * 100) !== st[i].hi) expect.fail('垫底 + 实体 ≠ 顶')
      })
    }
  })

  it('花超了（收入 1000，花 800 + 500）：跨过 0 的那根照样接上，结余 -300 是一根红柱挂在 0 下面', () => {
    // 变异：去掉实体柱那个 series 的 stackStrategy: 'all'（ECharts 默认同号才叠，跨 0 那根会断）→ 红
    // 变异：结余颜色不分正负（恒为 CHART.income）→ 红
    const c = open([earn('2026-09-01', 1000), spend('2026-09-02', 800, 'lunch'), spend('2026-09-03', 500, 'game')])
    const o = opt(c)
    expect(o.series[0].stackStrategy).toBe('all')
    expect(o.series[1].stackStrategy).toBe('all')
    // 娱乐那根：从 200 扣到 -300
    expect(o.series[0].data[2]).toBe(-300)
    expect(o.series[1].data[2].value).toBe(500)
    // 结余：从 -300 到 0，支出红
    expect(o.series[0].data[3]).toBe(-300)
    expect(o.series[1].data[3].value).toBe(300)
    expect(o.series[1].data[3].itemStyle.color).toBe(CHART.expense)
    expect(o.series[1].data[0].itemStyle.color).toBe(CHART.income)
  })

  it('大类颜色和饼图一样（categoryColor 按名字认、按名次兜底）；垫底柱是透明的', () => {
    // 变异：大类颜色改用 categoryColor(a.name)（不传名次，认不出的名字全撞成同一个备用色）→ 红
    const cats: Category[] = [
      { id: 'a', kind: 'expense', parent_id: null, name: '宠物', icon: null, sort: 1, is_archived: false, note: null },
      { id: 'b', kind: 'expense', parent_id: null, name: '学习', icon: null, sort: 2, is_archived: false, note: null },
      ...CATS,
    ]
    const c = open([spend('2026-09-01', 300, 'a'), spend('2026-09-01', 200, 'b'), spend('2026-09-01', 100, 'lunch')], '2026-09', cats)
    const colors = opt(c).series[1].data.map((b) => b.itemStyle.color)
    expect(colors.slice(1, 4)).toEqual([categoryColor('宠物', 0), categoryColor('学习', 1), categoryColor('日常餐饮', 2)])
    expect(colors[1]).not.toBe(colors[2])
    expect(opt(c).series[0].itemStyle.color).toBe('transparent')
  })

  it('八个大类：前六个单列，剩下两个并成「其余 2 类」，钱一分不少', () => {
    // 变异：不并（去掉 slice(0, MAX_CATS)，全单列）→ 红
    const cats: Category[] = Array.from({ length: 8 }, (_, i) => ({
      id: `k${i}`, kind: 'expense' as const, parent_id: null, name: `类${i}`, icon: null, sort: i, is_archived: false, note: null,
    }))
    const txs = cats.map((k, i) => spend('2026-09-09', 100 * (8 - i), k.id))
    const c = open(txs, '2026-09', cats)
    const o = opt(c)
    expect(MAX_CATS).toBe(6)
    expect(o.xAxis.data).toHaveLength(1 + 6 + 1 + 1)
    expect(o.xAxis.data[7]).toBe('其余 2 类')
    // 最小的两类：200 + 100
    expect(o.series[1].data[7].value).toBe(300)
    expect(o.series[1].data[8].value).toBe(3600)
    expect(o.series[1].data[7].itemStyle.color).toBe(CHART.label)
  })

  it('只有收入没有支出：两根柱子，收入和结余一样高', () => {
    // 变异：结余取成 0 → 红
    const c = open([earn('2026-09-10', 3000)])
    expect(opt(c).xAxis.data).toEqual(['收入', '结余'])
    expect(opt(c).series[1].data.map((b) => b.value)).toEqual([3000, 3000])
  })

  it('这个月没有收入也没有支出（只有还白条、校准）→ 显示一句话，不画图', () => {
    // 变异：删掉 `if (sum.income === 0 && sum.expense === 0) return null` → 红
    const c = open([tx({ type: 'transfer', amount: Y(2000), date: '2026-09-17', to_account_id: 'jd' }), tx({ type: 'adjust', amount: Y(5), date: '2026-09-18' })])
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
  })

  it('点餐饮那根 → 流水页筛好 9 月、支出、日常餐饮；点「未分类」→ cat=none；点收入 → 只看收入；点结余 → 不筛', () => {
    // 每根都带 cat：流水页只有收到 cat 才重设筛选。收入 / 结余只带月份的话，先点过「日常餐饮」再点「收入」，
    // 流水页还筛着日常餐饮，一笔收入都看不到（lib/filter.test.ts 有流水页那一头）。
    // 变异：去掉 UNCATEGORIZED_ID → 'none' 的翻译 → 红；收入 / 结余退回只带 ym（改前的写法）→ 红
    const c = open(SEPT)
    expect(c.onPoint!(1, 1)).toBe('ym=2026-09&type=expense&cat=food')
    expect(c.onPoint!(3, 1)).toBe('ym=2026-09&type=expense&cat=none')
    expect(c.onPoint!(0, 1)).toBe('ym=2026-09&type=income&cat=all')
    expect(c.onPoint!(4, 1)).toBe('ym=2026-09&cat=all')
    expect(c.onPoint!(9, 1)).toBeNull()
  })

  it('八个大类挤在 375 宽的手机上：「日常餐饮」折成两行「日常 / 餐饮」，不截成「日常…」；柱子少时一行放得下就不折', () => {
    // 变异：formatter 不折行（原样返回）→ 红；标签宽度写死 36（改前的写法）→ 红
    const cats: Category[] = ['日常餐饮', '学习提升', '经常生活开支', '非经常生活消费', '娱乐消费', '意外开支', '宠物', '人情往来'].map((name, i) => ({
      id: `k${i}`, kind: 'expense' as const, parent_id: null, name, icon: null, sort: i, is_archived: false, note: null,
    }))
    const txs = [earn('2026-09-01', 9000), ...cats.map((k, i) => spend('2026-09-09', 100 * (8 - i), k.id))]
    const narrow = opt(open(txs, '2026-09', cats, 311 - 44))
    const fmt = narrow.xAxis.axisLabel.formatter
    expect(narrow.xAxis.data[1]).toBe('日常餐饮')
    expect(fmt('日常餐饮')).toBe('日常\n餐饮')
    expect(fmt('学习提升')).toBe('学习\n提升')
    // 折完每行都装得下这根柱子的宽度
    expect(narrow.xAxis.axisLabel.width).toBeGreaterThanOrEqual(20)
    // 五根柱子（收入、三类、结余）：一行放得下
    const wide = opt(open(SEPT, '2026-09', CATS, 311 - 44))
    expect(wide.xAxis.axisLabel.formatter('日常餐饮')).toBe('日常餐饮')
    // 一行放得下时，ECharts 的截断宽度也得放得下这一行（写死 36 就又截成「日常…」）
    expect(wide.xAxis.axisLabel.width).toBeGreaterThanOrEqual(textWidth('日常餐饮', 10))
    expect(wrapLabel('其余 2 类', 30)).toBe('其余\n2 类')
  })

  it('提示框：扣完还剩多少（花超了带负号）；结余那根写储蓄率 = 结余 ÷ 收入', () => {
    // 变异：「扣完还剩」去掉负号 → 花超了显示成正数 → 红
    // 变异：结余的储蓄率除以支出 → 3400 ÷ 1600 = 213% → 红
    const over = opt(open([earn('2026-09-01', 1000), spend('2026-09-02', 800, 'lunch'), spend('2026-09-03', 500, 'game')]))
    const game = over.tooltip.formatter([{ dataIndex: 2 }])
    expect(game).toContain('扣完还剩')
    expect(game).toContain('-¥300.00')
    const net = over.tooltip.formatter([{ dataIndex: 3 }])
    expect(net).toContain('-¥300.00')
    expect(net).toContain('-30%')
    const sept = opt(open(SEPT))
    const s = sept.tooltip.formatter([{ dataIndex: 4 }])
    expect(s).toContain('¥3,400.00')
    expect(s).toContain('68%')
    // 餐饮占支出 1200 ÷ 1600 = 75%
    expect(sept.tooltip.formatter([{ dataIndex: 1 }])).toContain('75%')
  })

  it('源码守卫：不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 waterfall.ts 里加一行 `const X = '#c95a4e'` → 红；轴线色写成 3 位的 '#eee' → 红
    const src = readFileSync(new URL('./waterfall.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
