// 吃饭占多少。输入一律是「用户记了这些账，今天几号、翻到哪个月，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category, Transaction } from '../../types'
import { monthSummary } from '../compute'
import { addDays, lastMonths, shiftMonth } from '../date'
import { categoryColor } from '../palette'
import { engel, engelRows, foodCats, overallShare } from './engel'
import { sampleInput } from './sample'
import type { MoreChart, MoreInput } from './types'

const cat = (id: string, parent_id: string | null, name: string, sort = 1, over: Partial<Category> = {}): Category => ({
  id, kind: 'expense', parent_id, name, icon: null, sort, is_archived: false, note: null, ...over,
})
const CATS: Category[] = [
  cat('food', null, '日常餐饮', 1),
  cat('lunch', 'food', '午餐', 1),
  cat('dinner', 'food', '晚餐', 2),
  cat('life', null, '经常生活开支', 2),
  cat('rent', 'life', '房租', 1),
  cat('fun', null, '娱乐消费', 3),
  cat('salary', null, '工资', 1, { kind: 'income' }),
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `e${seq}`, type: 'expense', account_id: 'boc', to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: `${p.date}T04:00:00.000Z`, ...p,
  }
}
const spend = (date: string, yuan: number, category_id: string | null) => tx({ date, amount: Math.round(yuan * 100), category_id })

const inputOf = (txs: Transaction[], ym = '2026-09', cats = CATS, today = '2026-09-28'): MoreInput => ({
  txs, accounts: [], cats, ym, start: '2025-10-01', end: today, today,
})

type Opt = {
  series: { name: string; color: string; data: (number | null)[]; connectNulls: boolean }[]
  xAxis: { data: string[] }
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const line = (c: MoreChart) => opt(c).series[0].data

/**
 * 从 8 月开始记的账，今天 9/28：
 *   9 月：午餐 30、晚餐 70、直接记在「日常餐饮」上 50（= 吃饭 150）；房租 400；没分类 50 → 全部支出 600
 *         另有还白条 2000、校准 +300、工资 8000（都不是支出）
 *   8 月：晚餐 100；娱乐 900 → 全部 1000
 */
const BOOK: Transaction[] = [
  spend('2026-09-02', 30, 'lunch'),
  spend('2026-09-03', 70, 'dinner'),
  spend('2026-09-04', 50, 'food'),
  spend('2026-09-01', 400, 'rent'),
  spend('2026-09-05', 50, null),
  tx({ type: 'transfer', amount: 200000, date: '2026-09-17', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: 30000, date: '2026-09-20' }),
  tx({ type: 'income', amount: 800000, date: '2026-09-10', category_id: 'salary' }),
  spend('2026-08-10', 100, 'dinner'),
  spend('2026-08-12', 900, 'fun'),
]

afterEach(() => vi.restoreAllMocks())

describe('吃饭占多少：打开看到什么', () => {
  it('今天 9/28 看 9 月：吃饭 150 ÷ 全部支出 600 = 25%（二级算进一级；没分类的算进分母；还白条、校准、工资都不算）', () => {
    // 变异：分母漏掉「未分类」（`if (t.category_id) totals[i] += t.amount`）→ 150 ÷ 550，红
    const c = engel(inputOf(BOOK))
    expect(c.key).toBe('engel')
    expect(c.title).toBe('吃饭占多少')
    expect(c.span).toBe('25.10–26.9')
    const d = line(c)
    expect(d).toHaveLength(12)
    expect(d[11]).toBe(25)
    expect(d[10]).toBe(10)
    expect(c.tiles?.[0]).toEqual({ label: '本月', value: '25%' })
    const tip = opt(c).tooltip.formatter([{ dataIndex: 11 }])
    expect(tip).toContain('2026年9月')
    expect(tip).toContain('25%')
    expect(tip).toContain('日常餐饮')
    expect(tip).toContain('¥150.00')
    expect(tip).toContain('¥600.00')
  })

  it('8 月才开始记账：之前那 10 个月没有支出，线断开（null），不是画成 0%', () => {
    // 变异：rate 在分母为 0 时写成 0 → 前十个点成了 0，红
    const c = engel(inputOf(BOOK))
    expect(line(c).slice(0, 10).every((v) => v === null)).toBe(true)
    expect(opt(c).series[0].connectNulls).toBe(false)
  })

  it('12 个月平均按钱算：8 月 10%（100/1000）、9 月 25%（150/600）→ 250 ÷ 1600 = 16%，不是两个百分比平均的 18%', () => {
    // 变异：overallShare 改成对有数的月份的 rate 直接取平均 → 18%，红
    const c = engel(inputOf(BOOK))
    expect(c.tiles?.[1]).toEqual({ label: '12 个月平均', value: '16%' })
  })

  it('翻回 8 月看（今天 9/28）：格子写「8月」不写「本月」；区间是 25.9–26.8', () => {
    // 变异：格子一律写「本月」→ 红
    const c = engel(inputOf(BOOK, '2026-08'))
    expect(c.tiles?.[0]).toEqual({ label: '8月', value: '10%' })
    expect(c.span).toBe('25.9–26.8')
    expect(line(c)[11]).toBe(10)
  })

  it('名字像吃饭的分类好几个，一级二级都有（日常餐饮、外卖饭、归档了的饮品、挂在经常生活开支下的午饭）→ 合起来算；收入里叫「饭补」的不算', () => {
    // 变异：foodCats 加回 `c.parent_id === null`（只认一级，旧规则）→ 「午饭」那 200 不算，(60+100+40) ÷ 1000 = 20%，红
    // 变异：foodCats 去掉 `c.kind === 'expense'` → 说明里冒出「饭补」，红
    // 变异：foodCats 加上 `!c.is_archived` → 归档的「饮品」那 40 块不算了（36%），红
    // 变异：`const top = food`（一级命中了，它底下的午餐晚餐也单列）→ 说明里冒出「午餐」「晚餐」，红
    const cats = [
      ...CATS,
      cat('takeout', null, '外卖饭', 4),
      cat('drink', null, '饮品', 5, { is_archived: true }),
      cat('noon', 'life', '午饭', 2),
      cat('bonus', null, '饭补', 2, { kind: 'income' }),
    ]
    const txs = [
      spend('2026-09-01', 60, 'food'),
      spend('2026-09-02', 100, 'takeout'),
      spend('2026-09-03', 40, 'drink'),
      spend('2026-09-04', 200, 'noon'),
      spend('2026-09-05', 600, 'fun'),
      tx({ type: 'income', amount: 30000, date: '2026-09-06', category_id: 'bonus' }),
    ]
    expect(foodCats(cats).map((c) => c.id).sort()).toEqual(['dinner', 'drink', 'food', 'lunch', 'noon', 'takeout'])
    const c = engel(inputOf(txs, '2026-09', cats))
    // (60 + 100 + 40 + 200) ÷ (60 + 100 + 40 + 200 + 600) = 40%
    expect(line(c)[11]).toBe(40)
    expect(c.title).toBe('吃饭占多少')
    // 按 12 个月各花多少排：午饭 200、外卖饭 100、日常餐饮 60、饮品 40
    expect(c.note).toContain('「午饭」「外卖饭」「日常餐饮」「饮品」')
    expect(c.note).not.toContain('饭补')
    expect(c.note).not.toContain('午餐')
    expect(c.note).not.toContain('晚餐')
    expect(opt(c).series[0].name).toBe('吃饭')
  })

  it('用户真实的分类（一级「日常开支」…「意外开支」，日常开支下「午餐」「早餐」「通勤交通」）：认得出吃饭，只算午餐早餐，不算通勤交通、也不算直接记在「日常开支」上的', () => {
    // 这是 2026-09-29 审出来的 high 级 bug：只认一级名字时这五个一级一个都不像吃饭，永远走退路
    // 变异：foodCats 加回 `c.parent_id === null`（只认一级）→ fallback = true、改看「经常生活开支」，红
    // 变异：isFood 只看一级（去掉 `(cat && foodIds.has(cat.id)) ||`）→ 分子 0，红
    // 变异：isFood 改成「一级底下有像吃饭的二级就整个一级都算」→ 通勤交通 200、直接记在日常开支上的 50 混进来（32.5%），红
    const cats = [
      cat('daily', null, '日常开支', 1),
      cat('lunch', 'daily', '午餐', 1),
      cat('breakfast', 'daily', '早餐', 2),
      cat('commute', 'daily', '通勤交通', 3),
      cat('life', null, '经常生活开支', 2),
      cat('big', null, '非经常生活消费', 3),
      cat('fun', null, '娱乐消费', 4),
      cat('oops', null, '意外开支', 5),
      cat('salary', null, '工资', 1, { kind: 'income' }),
    ]
    // 今天 9/28 打开，停在 9 月：午餐 300、早餐 100、通勤交通 200、直接记在日常开支上 50、经常生活开支 800、娱乐 550 → 全部 2000
    const txs = [
      spend('2026-09-02', 300, 'lunch'),
      spend('2026-09-03', 100, 'breakfast'),
      spend('2026-09-04', 200, 'commute'),
      spend('2026-09-05', 50, 'daily'),
      spend('2026-09-06', 800, 'life'),
      spend('2026-09-07', 550, 'fun'),
      tx({ type: 'income', amount: 800000, date: '2026-09-10', category_id: 'salary' }),
    ]
    const { pick, rows } = engelRows({ txs, cats, ym: '2026-09' })
    expect(pick?.fallback).toBe(false)
    expect(pick?.ids).toEqual(['lunch', 'breakfast'])
    expect(rows[11].part).toBe(40000)
    expect(rows[11].total).toBe(200000)
    const c = engel(inputOf(txs, '2026-09', cats))
    expect(c.title).toBe('吃饭占多少')
    expect(line(c)[11]).toBe(20)
    expect(c.note).toContain('「午餐」「早餐」')
    expect(c.note).not.toContain('通勤交通')
    expect(c.note).not.toContain('没有名字像吃饭')
    const tip = opt(c).tooltip.formatter([{ dataIndex: 11 }])
    expect(tip).toContain('吃饭')
    expect(tip).toContain('¥400.00')
    expect(tip).toContain('¥2,000.00')
    // 两个二级合起来，流水页筛不到「只看午餐和早餐」，也不能筛「日常开支」（会带上通勤交通）→ 只筛到支出
    expect(c.onPoint!(11, 0)).toBe('ym=2026-09&type=expense&cat=all')
  })

  it('只命中一个二级（经常生活开支 › 午饭）→ 点了只筛到支出（cat=all），不筛整个「经常生活开支」', () => {
    // 变异：rootId 去掉 `&& sorted[0].parent_id === null` → cat=noon（拿二级 id 当一级筛），红
    const cats = [cat('life', null, '经常生活开支', 1), cat('noon', 'life', '午饭', 1), cat('rent', 'life', '房租', 2)]
    const c = engel(inputOf([spend('2026-09-01', 20, 'noon'), spend('2026-09-02', 80, 'rent')], '2026-09', cats))
    expect(line(c)[11]).toBe(20)
    expect(c.onPoint!(11, 0)).toBe('ym=2026-09&type=expense&cat=all')
  })

  it('日常餐饮底下的午餐花得多、另一个一级「外卖」花得少 → 说明先写「日常餐饮」，线是日常餐饮的颜色', () => {
    // 午餐同时像吃饭、它的一级也像吃饭：钱记在一级头上排名次（午餐不单列）
    // 变异：`hit` 先看二级（`cat && foodIds.has(cat.id) ? cat.id : root!.id`，原来的写法）→ 日常餐饮 12 个月只记到 0，排到外卖后面，颜色成了外卖的，红
    const cats = [...CATS, cat('takeout', null, '外卖', 4)]
    const c = engel(inputOf([spend('2026-09-01', 500, 'lunch'), spend('2026-09-02', 100, 'takeout'), spend('2026-09-03', 400, 'fun')], '2026-09', cats))
    expect(c.note).toContain('「日常餐饮」「外卖」')
    expect(opt(c).series[0].color).toBe(categoryColor('日常餐饮'))
    expect(line(c)[11]).toBe(60)
  })

  it('一个像吃饭的分类都没有 → 看 12 个月花得最多的那个一级分类（不是这个月最多的、也不是「未分类」）；标题照样叫「吃饭占多少」，说明里写改看了哪一类', () => {
    // 变异：退路只看所选月份（按 9 月最大的挑）→ 挑成「房租水电」，红
    // 变异：退路不排除「未分类」→ 没分类的 5000 块成了候选，红
    // 变异：标题改回 `${pick.names[0]}占多少` → 「娱乐占多少」，红（「自定义」清单和卡片上得是同一个名字）
    // 变异：退路的 rootId 写成 null → 点了 cat=all，红
    const cats = [cat('home', null, '房租水电', 1), cat('fun', null, '娱乐', 2), cat('pet', null, '宠物', 3)]
    const txs = [
      spend('2026-03-01', 3000, 'fun'),
      spend('2026-09-01', 1000, 'home'),
      spend('2026-09-02', 500, 'fun'),
      spend('2026-09-03', 500, 'pet'),
      spend('2026-05-01', 5000, null),
    ]
    const c = engel(inputOf(txs, '2026-09', cats))
    expect(c.title).toBe('吃饭占多少')
    expect(c.note).toContain('没有名字像吃饭的支出分类')
    expect(c.note).toContain('「娱乐」')
    // 9 月：500 ÷ 2000 = 25%；3 月：100%；5 月：全是没分类的 → 0%
    expect(line(c)[11]).toBe(25)
    expect(line(c)[5]).toBe(100)
    expect(line(c)[7]).toBe(0)
    expect(opt(c).series[0].color).toBe(categoryColor('娱乐', 0))
    expect(opt(c).series[0].name).toBe('娱乐')
    expect(c.onPoint!(11, 0)).toBe('ym=2026-09&type=expense&cat=fun')
  })

  it('线的颜色 = 日常餐饮在饼图上的颜色', () => {
    // 变异：颜色写成 CHART.expense → 红
    expect(opt(engel(inputOf(BOOK))).series[0].color).toBe(categoryColor('日常餐饮'))
  })

  it('点 9 月那个点 → 9 月流水、筛到「日常餐饮」；好几个一级合起来的 → 只筛到支出（cat=all）', () => {
    // 变异：一律 cat=all → 第一条红；一律 cat=ids[0] → 最后一条红
    expect(engel(inputOf(BOOK)).onPoint!(11, 0)).toBe('ym=2026-09&type=expense&cat=food')
    expect(engel(inputOf(BOOK)).onPoint!(10, 0)).toBe('ym=2026-08&type=expense&cat=food')
    expect(engel(inputOf(BOOK)).onPoint!(12, 0)).toBeNull()
    const cats = [...CATS, cat('takeout', null, '外卖饭', 4)]
    expect(engel(inputOf(BOOK, '2026-09', cats)).onPoint!(11, 0)).toBe('ym=2026-09&type=expense&cat=all')
  })

  it('8 月才开始记账：点 25 年 10 月那个空点 → 不跳（跳过去是一页空流水），提示框也不写「再点一下看流水」；有支出的 9 月照常写', () => {
    // 变异：onPoint 去掉 `rows[dataIndex].rate !== null` → 25.10 返回 'ym=2025-10…'，红
    // 变异：提示框一律加「再点一下看流水」→ 25.10 的提示框里有它，红
    const c = engel(inputOf(BOOK))
    expect(c.onPoint!(0, 0)).toBeNull()
    const tip0 = opt(c).tooltip.formatter([{ dataIndex: 0 }])
    expect(tip0).toContain('这个月没有支出')
    expect(tip0).not.toContain('再点一下看流水')
    expect(opt(c).tooltip.formatter([{ dataIndex: 11 }])).toContain('再点一下看流水')
  })

  it('分类名里有尖括号（「<Steam>饭卡」）：提示框里转义，不被浏览器当标签吞掉', () => {
    // 变异：提示框里 partName 不过 esc() → 原样出现「<Steam>」，红
    const cats = [cat('steam', null, '<Steam>饭卡', 1), cat('fun', null, '娱乐消费', 2)]
    const c = engel(inputOf([spend('2026-09-01', 30, 'steam'), spend('2026-09-02', 70, 'fun')], '2026-09', cats))
    const tip = opt(c).tooltip.formatter([{ dataIndex: 11 }])
    expect(tip).toContain('&lt;Steam&gt;饭卡')
    expect(tip).not.toContain('<Steam>')
  })

  it('横轴 12 个月，年份带着：25.10 … 26.9', () => {
    // 变异：x 轴直接用 YYYY-MM → 红
    const x = opt(engel(inputOf(BOOK))).xAxis.data
    expect(x[0]).toBe('25.10')
    expect(x[11]).toBe('26.9')
  })

  it('12 个月一笔支出都没有 → 一句话不画图；支出全没记分类、又没有像吃饭的分类 → 另一句话', () => {
    // 变异：删掉第一个 empty 分支 → 落到第二句「都没记分类」，原因说错了，红
    const c = engel(inputOf([tx({ type: 'income', amount: 100, date: '2026-09-01', category_id: 'salary' })]))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('这 12 个月没有支出记录')
    expect(c.span).toBe('25.10–26.9')
    expect(c.note.endsWith('。')).toBe(true)
    const c2 = engel(inputOf([spend('2026-09-01', 30, null)], '2026-09', [cat('pet', null, '宠物')]))
    expect(c2.option).toBeNull()
    expect(c2.empty).toMatch(/没记分类/)
  })
})

describe('吃饭占多少：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  }
  // 分类里有：一级、二级、归档的、收入的、查不到的 id（孤儿）、一级不像吃饭但二级像的、一级像吃饭它底下的二级不像的、父类被删了的二级
  const RCATS = [
    ...CATS,
    cat('drink', null, '饮品', 4, { is_archived: true }),
    cat('noon', 'life', '午饭', 2),
    cat('bus', 'life', '通勤交通', 3),
    cat('snack', 'fun', '零食', 1),
    cat('tip', 'food', '小费', 3),
    cat('late', 'gone', '宵夜', 1),
    cat('bonus', null, '饭补', 2, { kind: 'income' }),
  ]
  const PICK = ['food', 'lunch', 'dinner', 'rent', 'fun', 'drink', 'noon', 'bus', 'snack', 'tip', 'late', 'bonus', null, 'ghost']
  // 规则照抄需求，不 import 实现里的常量
  const WORDS = ['餐', '饮', '吃', '饭', '早', '午', '晚', '宵', '外卖', '奶茶', '咖啡', '零食', '水果']

  it('随机账本 × 随机月份：每个月分母 ≡ monthSummary 的支出；分子 ≡ 自己或它的一级像吃饭的支出（自己按分类表走一遍）；图上的点 ≡ 分子 ÷ 分母；没支出的月份点了不跳', () => {
    // 变异：分母只加认得的分类（漏掉「未分类」）→ 分母 ≠ monthSummary，红
    // 变异：foodCats 加回 `c.parent_id === null`（只认一级）→ 午饭、零食、宵夜漏掉，红
    // 变异：isFood 只看自己（去掉 `(root && foodIds.has(root.id))`）→ 日常餐饮 › 小费漏掉，红
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    const byId = new Map(RCATS.map((c) => [c.id, c]))
    const like = (c: Category | undefined) => Boolean(c && c.kind === 'expense' && WORDS.some((w) => c.name.includes(w)))
    for (let k = 0; k < 150; k++) {
      const r = rng(k + 11)
      const txs: Transaction[] = []
      for (let i = 0; i < 60; i++) {
        const type = TYPES[Math.floor(r() * TYPES.length)]
        txs.push(tx({ type, amount: 1 + Math.floor(r() * 50000), date: addDays('2025-06-01', Math.floor(r() * 480)), category_id: PICK[Math.floor(r() * PICK.length)] }))
      }
      const ym = shiftMonth('2026-09', -Math.floor(r() * 6))
      const { pick, rows } = engelRows({ txs, cats: RCATS, ym })
      if (pick?.fallback !== false) expect.fail('分类表里有像吃饭的，却走了退路')
      const c = engel(inputOf(txs, ym, RCATS))
      const months = lastMonths(12, ym)
      rows.forEach((row, i) => {
        if (row.ym !== months[i]) expect.fail('月份不对')
        const total = monthSummary(txs, row.ym).expense
        if (row.total !== total) expect.fail(`${row.ym}：分母 ${row.total} ≠ 支出 ${total}`)
        let part = 0
        for (const t of txs) {
          if (t.type !== 'expense' || t.date.slice(0, 7) !== row.ym) continue
          const cc = t.category_id ? byId.get(t.category_id) : undefined
          const root = cc ? (cc.parent_id ? byId.get(cc.parent_id) ?? cc : cc) : undefined
          if (like(cc) || like(root)) part += t.amount
        }
        if (row.part !== part) expect.fail(`${row.ym}：分子 ${row.part} ≠ ${part}`)
        if (c.option) {
          const v = line(c)[i]
          const want = total ? Math.round((part / total) * 1000) / 10 : null
          if (v !== want) expect.fail(`${row.ym}：图上 ${v} ≠ ${want}`)
          if ((c.onPoint!(i, 0) === null) !== (total === 0)) expect.fail(`${row.ym}：支出 ${total}，点了却${total ? '不跳' : '跳了'}`)
        }
      })
      const share = overallShare(rows)
      const T = rows.reduce((s, x) => s + x.total, 0)
      if (T ? share !== rows.reduce((s, x) => s + x.part, 0) / T : share !== null) expect.fail('12 个月平均不是按钱算的')
    }
  })
})

describe('吃饭占多少：真画一遍（ECharts SSR）', () => {
  // 要的模块：LineChart + GridComponent + TooltipComponent（Chart.tsx 本来就注册了，不用另加）
  echarts.use([LineChart, GridComponent, TooltipComponent, SVGRenderer])

  it('一年的样例账：不报错，画出来的不是一张白纸', () => {
    // 变异：series 的 type 写成 'lines'（没注册的系列）→ 报「没注册」，红
    const errors: string[] = []
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(' ')))
    const c = engel(sampleInput())
    expect(c.option).not.toBeNull()
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 329, height: c.height ?? 220 })
    try {
      chart.setOption(c.option as echarts.EChartsCoreOption, true)
      const svg = chart.renderToSVGString()
      expect(errors, errors.join('\n')).toEqual([])
      expect(svg.length).toBeGreaterThan(3000)
      expect(svg).toContain(opt(c).series[0].color)
    } finally {
      chart.dispose()
    }
  })
})

describe('吃饭占多少：线的颜色跟着一级走', () => {
  it('只命中二级「午餐」时，线用它的一级「日常开支」的颜色，和饼图对得上', () => {
    // 变异：color 改回 categoryColor(pick.names[0], 0) → 用了「午餐」的备用色，红
    const cats = [cat('daily', null, '日常开支', 1), cat('lunch2', 'daily', '午餐', 1), cat('bus2', 'daily', '通勤交通', 2)]
    const c = engel(inputOf([spend('2026-09-02', 30, 'lunch2'), spend('2026-09-03', 10, 'bus2')], '2026-09', cats))
    expect(opt(c).series[0].color).toBe(categoryColor('日常开支', 0))
  })
})
