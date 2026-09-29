/// <reference types="node" />
// 固定开销。输入一律是「用户记了这些账，今天几号、顶上停在哪个月，打开看到什么」。
// 判定规则（isFixed）单独一组；随机账本按定义现算，和图上列出来的逐项对账。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../../types'
import { addDays, monthOf, shiftMonth } from '../date'
import { UNCATEGORIZED_ID } from '../compute'
import { categoryColor } from '../palette'
import { dayGap, findFixed, fixedChart, fixedMonths, isFixed, isFixedGroup } from './fixed'
import type { MoreChart, MoreInput } from './types'

const cat = (id: string, kind: Category['kind'], parent_id: string | null, name: string, sort: number): Category => ({
  id, kind, parent_id, name, icon: null, sort, is_archived: false, note: null,
})
const CATS: Category[] = [
  cat('food', 'expense', null, '日常餐饮', 1),
  cat('lunch', 'expense', 'food', '午餐', 1),
  cat('life', 'expense', null, '经常生活开支', 2),
  cat('rent', 'expense', 'life', '房租', 1),
  cat('phone', 'expense', 'life', '话费', 3),
  cat('food_other', 'expense', 'food', '其他', 2),
  cat('big', 'expense', null, '非经常生活消费', 3),
  cat('digital', 'expense', 'big', '数码', 1),
  cat('fun', 'expense', null, '娱乐消费', 4),
  cat('gym', 'expense', 'fun', '健身', 1),
  cat('vip', 'expense', 'fun', '会员', 2),
  cat('fun_other', 'expense', 'fun', '其他', 3),
  cat('salary', 'income', null, '工资/实习', 1),
]
const acc = (id: string, name: string, kind: Account['kind'], sort: number): Account => ({
  id, name, kind, sort, is_archived: false, repay_day: kind === 'credit' ? 17 : null, defer_after_repay: null, facade_offset: null,
})
const ACCOUNTS = [acc('boc', '中国银行', 'bank', 1), acc('wx', '微信', 'wallet', 2), acc('zfb', '支付宝', 'wallet', 3), acc('jd', '京东白条', 'credit', 5)]

let seq = 0
function tx(date: string, type: Transaction['type'], yuan: number, account_id: string | null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `f${seq}`, date, type, amount: Math.round(yuan * 100), account_id, to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: '2026-06-01T00:00:00.000Z', ...over,
  }
}
const spend = (date: string, yuan: number, category_id: string | null, account_id: string | null) => tx(date, 'expense', yuan, account_id, { category_id })

/**
 * 从 6 月开始记的一本账。今天 9/29（9 月还没过完）。
 *   房租：每月 1 号中行 3500（9 月也扣了，但 9 月不在看的范围里）
 *   话费（二级）：每月 5 号支付宝 50 / 52 / 55
 *   日常餐饮（直接记在一级上）：微信 6 月 1000、7 月两笔 400 + 600、8 月 950
 *   会员：每月 25，但 7 月改从支付宝付了（账户不一样 → 不算固定）
 *   午餐：300 / 800 / 500（每月都有但差得多）
 *   健身：6 月、8 月各 200，7 月没去
 *   每月 17 号中行还京东 1000（转账）、20 号微信校准 −100、10 号工资 1 万（9 月涨到 1.2 万）
 */
const BOOK: Transaction[] = []
for (const m of ['2026-06', '2026-07', '2026-08', '2026-09']) {
  BOOK.push(spend(`${m}-01`, 3500, 'rent', 'boc'))
  BOOK.push(tx(`${m}-17`, 'transfer', 1000, 'boc', { to_account_id: 'jd' }))
  BOOK.push(tx(`${m}-20`, 'adjust', -100, 'wx'))
  BOOK.push(tx(`${m}-10`, 'income', m === '2026-09' ? 12000 : 10000, 'boc', { category_id: 'salary' }))
}
BOOK.push(spend('2026-06-05', 50, 'phone', 'zfb'), spend('2026-07-05', 52, 'phone', 'zfb'), spend('2026-08-05', 55, 'phone', 'zfb'))
BOOK.push(spend('2026-06-10', 1000, 'food', 'wx'), spend('2026-07-10', 400, 'food', 'wx'), spend('2026-07-11', 600, 'food', 'wx'), spend('2026-08-10', 950, 'food', 'wx'))
BOOK.push(spend('2026-06-12', 25, 'vip', 'wx'), spend('2026-07-12', 25, 'vip', 'zfb'), spend('2026-08-12', 25, 'vip', 'wx'))
BOOK.push(spend('2026-06-13', 300, 'lunch', 'wx'), spend('2026-07-13', 800, 'lunch', 'wx'), spend('2026-08-13', 500, 'lunch', 'wx'))
BOOK.push(spend('2026-06-15', 200, 'gym', 'wx'), spend('2026-08-15', 200, 'gym', 'wx'))

const input = (txs: Transaction[], ym: string, today: string, over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts: ACCOUNTS, cats: CATS, ym, start: `${ym}-01`, end: today, today, ...over,
})

type Opt = {
  yAxis: { data: string[] }
  series: { type: string; data: { value: number; itemStyle: { color: string } }[] }[]
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const tiles = (c: MoreChart) => Object.fromEntries((c.tiles ?? []).map((t) => [t.label, t.value]))

describe('看哪三个月', () => {
  it('今天 9/29 停在 9 月：9 月没过完，看 6、7、8 月；月底最后一天（9/30）也还没过完', () => {
    // 变异：`ym < cur` 写成 `ym <= cur`（当月也算过完）→ 红
    expect(fixedMonths('2026-09', '2026-09-29')).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(fixedMonths('2026-09', '2026-09-30')).toEqual(['2026-06', '2026-07', '2026-08'])
  })

  it('翻回 8 月（已经过完）：看 6、7、8 月；翻回 1 月：去年 11、12 月加今年 1 月', () => {
    // 变异：过完的月份也往前挪一个（恒用 shiftMonth(ym, -1) 结尾）→ 红
    expect(fixedMonths('2026-08', '2026-09-29')).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(fixedMonths('2026-01', '2026-09-29')).toEqual(['2025-11', '2025-12', '2026-01'])
  })

  it('标题旁写的是实际看的那三个月（停在 9 月写「26.6–26.8」，不是「26.9」）', () => {
    // 变异：span 写成 monthSpan(inp.ym, inp.ym) → 红
    expect(fixedChart(input(BOOK, '2026-09', '2026-09-29')).span).toBe('26.6–26.8')
  })
})

describe('判定规则 isFixed', () => {
  it('三个月一样 → 固定；最少的正好是最多的 85%（差 15%）→ 还算固定；再少一分 → 不算', () => {
    // 变异：`<=` 写成 `<`（正好 15% 不算）→ 红
    // 变异：按最少的那个月算百分比（`FIXED_PCT * min`）→ 8500 / 10000 那组差了 17.6%，红
    expect(isFixed([350000, 350000, 350000])).toBe(true)
    expect(isFixed([8500, 10000, 9000])).toBe(true)
    expect(isFixed([8499, 10000, 10000])).toBe(false)
  })

  it('某个月一笔没有（合计 0）→ 不算；三个月全是 0 → 不算；没有月份 → 不算', () => {
    // 变异：去掉 `max > 0`（全 0 时 0 ≤ 0 成立）→ 红
    expect(isFixed([10000, 0, 10000])).toBe(false)
    expect(isFixed([0, 0, 0])).toBe(false)
    expect(isFixed([])).toBe(false)
  })

  it('日子按 30 天一圈算：29 号和 2 号只隔 3 天；18 号和 8 号隔 10 天', () => {
    // 变异：dayGap 写成 `Math.abs(a - b)` → 29 和 2 隔 27，红
    expect(dayGap(29, 2)).toBe(3)
    expect(dayGap(2, 29)).toBe(3)
    expect(dayGap(18, 8)).toBe(10)
    expect(dayGap(31, 1)).toBe(0)
  })

  it('isFixedGroup：每月 1–3 笔、代表差 ≤ 15%、日子两两差 ≤ 5 天（正好 5 天还算）', () => {
    // 变异：`dayGap(...) > FIXED_DAY_TOL` 写成 `>=`（正好 5 天不算）→ 第二条红
    // 变异：`n > FIXED_MAX_COUNT` 写成 `n >= FIXED_MAX_COUNT`（3 笔就不算）→ 第四条红
    const g = (counts: number[], reps: number[], days: number[]) => isFixedGroup({ counts, reps, days })
    expect(g([1, 1, 1], [100, 100, 100], [1, 1, 1])).toBe(true)
    expect(g([1, 1, 1], [100, 100, 100], [1, 6, 3])).toBe(true)
    expect(g([1, 1, 1], [100, 100, 100], [1, 7, 3])).toBe(false)
    expect(g([3, 3, 3], [100, 100, 100], [1, 1, 1])).toBe(true)
    expect(g([4, 1, 1], [100, 100, 100], [1, 1, 1])).toBe(false)
    expect(g([1, 0, 1], [100, 0, 100], [1, 0, 1])).toBe(false)
  })
})

describe('今天 9/29 打开（停在 9 月）', () => {
  const c = fixedChart(input(BOOK, '2026-09', '2026-09-29'))

  it('列出房租、话费两项，按月均从大到小；日常餐饮（7 月最大那笔只有 600）、会员（7 月换了账户）、午餐（差太多）、健身（7 月没有）不算', () => {
    // 变异：分组键不带账户（只按分类）→ 会员三个月都 25，被算成固定，红
    // 变异：按一级分类归（二级并进一级）→ 房租和话费并成「经常生活开支」，红
    // 变异：代表改回月合计（`g.reps[i] += t.amount`）→ 日常餐饮 1000 / 1000 / 950 又成了固定，红
    expect(c.key).toBe('fixed')
    expect(c.title).toBe('固定开销')
    expect(opt(c).yAxis.data).toEqual(['房租', '话费'])
    // 月均（分）：3500；(50 + 52 + 55) / 3 = 52.33
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([350000, 5233])
    expect(opt(c).series[0].type).toBe('bar')
  })

  it('还白条（转账）、校准、工资不算开销：每月一样的 1000 块还款不会出现在固定开销里', () => {
    // 变异：只排除收入（`t.type === 'income'` 才跳过）→ 转账和校准进来，还白条那 1000 每月一样，红
    const r = findFixed(BOOK, CATS, ACCOUNTS, fixedMonths('2026-09', '2026-09-29'))
    expect(r.items.map((it) => it.categoryId)).toEqual(['rent', 'phone'])
  })

  it('小方块：固定开销 ¥3,552.33/月（= 条上 3,500 + 52.33）；占月均收入 36%（(10,500 + 157) ÷ 30,000）', () => {
    // 变异：收入按 9 月（所选月份，工资 1.2 万）× 3 算而不是那三个月 → 30%，红
    // 变异：分母用三个月收入之和、分子用月均（少除了一个 3）→ 12%，红
    expect(tiles(c)).toEqual({ 固定开销: '¥3,552.33/月', 占月均收入: '36%' })
  })

  it('颜色一律用一级的色：房租、话费都是「经常生活开支」那个绿，不是二级的浅色档', () => {
    // 变异：二级改回 `childShade(rootColor(parent), c.sort)` → 红
    const colors = opt(c).series[0].data.map((d) => d.itemStyle.color)
    expect(colors).toEqual([categoryColor('经常生活开支', 1), categoryColor('经常生活开支', 1)])
  })

  it('提示框：房租那一行写全名、账户、三个月各几号多少和月均', () => {
    // 变异：提示框取 items[dataIndex + 1] → 红
    const s = opt(c).tooltip.formatter([{ dataIndex: 0 }])
    for (const want of ['经常生活开支 · 房租', '中国银行', '6月 1 号', '7月 1 号', '8月 1 号', '¥3,500.00', '月均']) expect(s).toContain(want)
    expect(s).not.toContain('9月')
  })

  it('点房租那条 → 8 月（三个月的最后一个）、支出、经常生活开支 › 房租、中国银行的流水', () => {
    // 变异：ym 用 months[0] → 6 月，红
    // 变异：去掉 `&sub=` → 筛成整个经常生活开支，红
    // 变异：去掉 `&acc=` → 红
    expect(c.onPoint!(0, 0)).toBe('ym=2026-08&type=expense&cat=life&sub=rent&acc=boc')
    expect(c.onPoint!(1, 0)).toBe('ym=2026-08&type=expense&cat=life&sub=phone&acc=zfb')
    expect(c.onPoint!(2, 0)).toBeNull()
  })
})

describe('审出来的三个场景（2026-09-29）', () => {
  it('6/18、7/20、8/8 各买一次数码 2999 / 2699 / 2799：金额差 10% 但日子差太多 → 不算固定开销', () => {
    // 变异：isFixedGroup 去掉 `&& daysClose(g.days)` → 数码成了固定开销，红
    const txs = [spend('2026-06-18', 2999, 'digital', 'boc'), spend('2026-07-20', 2699, 'digital', 'boc'), spend('2026-08-08', 2799, 'digital', 'boc')]
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('没找到每月都固定出现的开销')
  })

  it('天天一笔吃饭（每笔 30，月合计 900 / 930 / 930 很接近）→ 笔数超了，不算；每月正好 3 笔会员 → 还算', () => {
    // 变异：isFixedGroup 去掉笔数那条（`n > FIXED_MAX_COUNT`）→ 吃饭成了固定开销，红
    const txs: Transaction[] = []
    for (let d = 0; d < 92; d++) txs.push(spend(addDays('2026-06-01', d), 30, 'lunch', 'wx'))
    for (const m of ['2026-06', '2026-07', '2026-08']) txs.push(spend(`${m}-12`, 25, 'vip', 'zfb'), spend(`${m}-12`, 15, 'vip', 'zfb'), spend(`${m}-13`, 6, 'vip', 'zfb'))
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['会员'])
    // 代表是每月最大那笔 25，不是 25 + 15 + 6
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([2500])
  })

  it('房租每月 1 号 3500，7/2 又在房租下记了一笔押金 3500 → 房租照样算固定；7 月代表取早的那笔（1 号）', () => {
    // 变异：代表改回月合计 → 7 月 7000，差 50%，房租没了，红
    // 变异：一样大时不取早的（去掉 `|| (t.amount === g.reps[i] && day < g.days[i])`）→ 押金先记进来，7 月写成 2 号，红
    const txs = [
      spend('2026-06-01', 3500, 'rent', 'boc'),
      spend('2026-07-02', 3500, 'rent', 'boc'),
      spend('2026-07-01', 3500, 'rent', 'boc'),
      spend('2026-08-01', 3500, 'rent', 'boc'),
    ]
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['房租'])
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([350000])
    const r = findFixed(txs, CATS, ACCOUNTS, fixedMonths('2026-09', '2026-09-29'))
    expect(r.items[0].monthly).toEqual([350000, 350000, 350000])
    expect(r.items[0].days).toEqual([1, 1, 1])
    expect(opt(c).tooltip.formatter([{ dataIndex: 0 }])).toContain('7月 1 号')
  })

  it('月底交房租：6/29、7/2（晚了几天）、8/1 → 按 30 天一圈，29 号和 2 号只差 3 天，算固定', () => {
    // 变异：dayGap 写成 `Math.abs(a - b)` → 差 27 天，房租没了，红
    const txs = [spend('2026-06-29', 3500, 'rent', 'boc'), spend('2026-07-02', 3500, 'rent', 'boc'), spend('2026-08-01', 3500, 'rent', 'boc')]
    expect(opt(fixedChart(input(txs, '2026-09', '2026-09-29'))).yAxis.data).toEqual(['房租'])
  })
})

describe('别的情况', () => {
  it('房租一半中行一半微信、两边都每月固定：同一个分类，直接带账户名（「房租·中国银行」），不带一级名', () => {
    // 变异：一级名一律先带上（`nameDup` 只看名字撞没撞，原来的写法）→ 「经常生活开支·房租·中国银行」，96px 截断后两行都是「经常生活开支·房…」，红
    const txs = ['2026-06', '2026-07', '2026-08'].flatMap((m) => [spend(`${m}-01`, 1750, 'rent', 'boc'), spend(`${m}-01`, 1700, 'rent', 'wx')])
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['房租·中国银行', '房租·微信'])
  })

  it('日常餐饮和娱乐消费底下各有一个「其他」，都从中行每月固定走：带一级名（「日常餐饮·其他」），不带账户名', () => {
    // 变异：删掉「带一级名」那步 → 两行成了「其他·中国银行」，分不清，红
    const txs = ['2026-06', '2026-07', '2026-08'].flatMap((m) => [spend(`${m}-03`, 200, 'food_other', 'boc'), spend(`${m}-04`, 100, 'fun_other', 'boc')])
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['日常餐饮·其他', '娱乐消费·其他'])
  })

  it('三个「其他」：日常餐饮·其他 走中行和微信、娱乐消费·其他 走中行 → 前两个带了一级名还撞，再带账户名', () => {
    // 变异：删掉「还撞再带账户名」那步 → 两行都是「日常餐饮·其他」，红
    const txs = ['2026-06', '2026-07', '2026-08'].flatMap((m) => [
      spend(`${m}-03`, 300, 'food_other', 'boc'),
      spend(`${m}-03`, 200, 'food_other', 'wx'),
      spend(`${m}-04`, 100, 'fun_other', 'boc'),
    ])
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['日常餐饮·其他·中国银行', '日常餐饮·其他·微信', '娱乐消费·其他'])
  })

  it('直接记在一级上的（日常餐饮 每月 10 号微信 1000）：颜色是日常餐饮色，点了筛 cat=food、不带 sub', () => {
    // 变异：onPoint 一律带 `&sub=${c.id}` → 红
    const txs = ['2026-06', '2026-07', '2026-08'].map((m) => spend(`${m}-10`, 1000, 'food', 'wx'))
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).series[0].data[0].itemStyle.color).toBe(categoryColor('日常餐饮', 0))
    expect(c.onPoint!(0, 0)).toBe('ym=2026-08&type=expense&cat=food&acc=wx')
  })

  it('删掉了的分类（id 查不到）和没分类的记在同一个账户：合成一行「未分类」；点了筛 cat=none', () => {
    // 变异：分组时不看分类还在不在（`t.category_id ?? UNCATEGORIZED_ID`）→ 查不到的和没分类的各成一行、都叫「未分类」，红
    const txs = ['2026-06', '2026-07', '2026-08'].flatMap((m) => [
      spend(`${m}-03`, 100, 'ghost', 'boc'),
      spend(`${m}-04`, 80, null, 'boc'),
    ])
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).yAxis.data).toEqual(['未分类'])
    // 每月两笔，代表是 100 那笔（3 号）
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([10000])
    expect(findFixed(txs, CATS, ACCOUNTS, fixedMonths('2026-09', '2026-09-29')).items.map((it) => it.categoryId)).toEqual([UNCATEGORIZED_ID])
    expect(c.onPoint!(0, 0)).toBe('ym=2026-08&type=expense&cat=none&acc=boc')
  })

  it('话费 50 / 52 / 55（支付宝）加会员 50 / 52 / 55（微信）：条上各 ¥52.33，小方块 ¥104.66，加起来对得上（不是三个月合计 ÷ 3 的 ¥104.67）', () => {
    // 变异：小方块改成 `Math.round(items 的 total 之和 ÷ 3)` → ¥104.67，红
    const txs = ['2026-06', '2026-07', '2026-08'].flatMap((m, i) => [spend(`${m}-05`, [50, 52, 55][i], 'phone', 'zfb'), spend(`${m}-12`, [50, 52, 55][i], 'vip', 'wx')])
    const c = fixedChart(input(txs, '2026-09', '2026-09-29'))
    expect(opt(c).series[0].data.map((d) => d.value)).toEqual([5233, 5233])
    expect(tiles(c)['固定开销']).toBe('¥104.66/月')
  })

  it('那三个月一分收入没有：占月均收入写「—」，不写 Infinity%', () => {
    // 变异：去掉 `r.income > 0` 的判断 → 「Infinity%」，红
    const txs = ['2026-06', '2026-07', '2026-08'].map((m) => spend(`${m}-01`, 3500, 'rent', 'boc'))
    expect(tiles(fixedChart(input(txs, '2026-09', '2026-09-29')))['占月均收入']).toBe('—')
  })

  it('只有变来变去的开销 → 一句话，不画图；区间照写，说明以句号结尾', () => {
    // 变异：删掉 empty 分支 → 红
    const c = fixedChart(input(BOOK.filter((t) => t.category_id === 'lunch'), '2026-09', '2026-09-29'))
    expect(c.option).toBeNull()
    expect(c.empty).toBe('没找到每月都固定出现的开销')
    expect(c.tiles).toBeUndefined()
    expect(c.span).toBe('26.6–26.8')
    expect(c.note.endsWith('。')).toBe(true)
  })
})

// ---------- 不变量：随机账本 ----------

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('不变量（随机账本 × 300）', () => {
  it('按定义现算：一项（分类, 账户）出现在图上 ⇔ 那三个月每月 1–3 笔、每月最大那笔差 ≤ 最多的 15%、那笔的日子两两差 ≤ 5 天；代表、日子、月均、排序都对得上；小方块 ≡ 条上的数相加', () => {
    // 变异：isFixed 按最少的月份算百分比 → 红
    // 变异：分组键不带账户 → 红
    // 变异：月均不四舍五入（Math.floor）→ 红
    // 变异：代表改回月合计 → 红
    // 变异：isFixedGroup 去掉日子那条 / 去掉笔数那条 → 红
    // 变异：分组时不看分类还在不在（ghost 和没分类的分成两组）→ 红
    // 变异：小方块改成 round(三个月合计 ÷ 3) → 红
    const catIds = ['lunch', 'food', 'rent', 'phone', 'gym', 'vip', 'ghost', null]
    const accIds = ['boc', 'wx', 'zfb', 'jd', null]
    const known = new Set(CATS.map((c) => c.id))
    const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 30 - Math.abs(a - b))
    const dd = (n: number) => String(n).padStart(2, '0')
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
      const today = addDays('2026-03-01', Math.floor(r() * 300))
      const ym = shiftMonth(monthOf(today), -Math.floor(r() * 4))
      const txs: Transaction[] = []
      // 几项「差不多每月都有」的：金额在 ±20% 里晃（有的正好卡在 15% 线两边），日子在固定那天 ±4 天里晃（偶尔乱跳、跨月末绕一圈），
      // 偶尔漏一个月、偶尔一个月多记一两笔
      for (let k = 0; k < 6; k++) {
        const c = pick(catIds)
        const a = pick(accIds)
        const base = 1000 + Math.floor(r() * 400000)
        const day0 = 1 + Math.floor(r() * 28)
        for (let m = -8; m <= 0; m++) {
          if (r() < 0.1) continue
          const mon = shiftMonth(monthOf(today), m)
          const n = r() < 0.75 ? 1 : 1 + Math.floor(r() * 4)
          for (let j = 0; j < n; j++) {
            const day = r() < 0.85 ? ((day0 - 1 + Math.floor(r() * 9) - 4 + 28) % 28) + 1 : 1 + Math.floor(r() * 28)
            txs.push(tx(`${mon}-${dd(day)}`, 'expense', 0, a, { category_id: c, amount: Math.round(base * (0.8 + r() * 0.4)) }))
          }
        }
      }
      // 杂七杂八：零散支出、每月一样的工资（收入）、每月一样的还款（转账）、校准
      for (let i = 0; i < 40; i++) {
        const d = addDays(today, -Math.floor(r() * 250))
        const k = r()
        if (k < 0.6) txs.push(tx(d, 'expense', 0, pick(accIds), { category_id: pick(catIds), amount: 1 + Math.floor(r() * 50000) }))
        else if (k < 0.8) txs.push(tx(d, 'transfer', 0, 'boc', { to_account_id: 'jd', amount: 100000 }))
        else txs.push(tx(d, 'adjust', 0, pick(['boc', 'wx']), { amount: Math.floor(r() * 2000) - 1000 }))
      }
      for (let m = -8; m <= 0; m++) txs.push(tx(`${shiftMonth(monthOf(today), m)}-10`, 'income', 0, 'boc', { category_id: 'salary', amount: 800000 }))

      // 按定义现算：查不到的分类和没分类的并成「未分类」
      const months = fixedMonths(ym, today)
      const want = new Map<string, { reps: number[]; days: number[] }>()
      const keys = new Set(catIds.map((c) => (c && known.has(c) ? c : '__uncategorized__')))
      for (const c of keys)
        for (const a of accIds) {
          const per = months.map((m) =>
            txs.filter((t) => t.type === 'expense' && (t.category_id && known.has(t.category_id) ? t.category_id : '__uncategorized__') === c && t.account_id === a && monthOf(t.date) === m),
          )
          if (per.some((l) => l.length < 1 || l.length > 3)) continue
          // 每月最大那笔；一样大取早的
          const top = per.map((l) => [...l].sort((x, y) => y.amount - x.amount || (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))[0])
          const reps = top.map((t) => t.amount)
          const days = top.map((t) => Number(t.date.slice(8)))
          const max = Math.max(...reps)
          const min = Math.min(...reps)
          if (!(max > 0 && (max - min) / max <= 0.15 + 1e-12)) continue
          if (days.some((x, i) => days.some((y, j) => j > i && gap(x, y) > 5))) continue
          want.set(`${c}|${a ?? ''}`, { reps, days })
        }
      const got = findFixed(txs, CATS, ACCOUNTS, months)
      const gotKeys = got.items.map((it) => `${it.categoryId}|${it.accountId ?? ''}`)
      if (gotKeys.length !== want.size || gotKeys.some((k) => !want.has(k))) expect.fail(`seed ${seed}: 图上 ${gotKeys.sort()} ≠ 按定义 ${[...want.keys()].sort()}`)
      for (const it of got.items) {
        const w = want.get(`${it.categoryId}|${it.accountId ?? ''}`)!
        const total = w.reps.reduce((s, v) => s + v, 0)
        if (it.monthly.join() !== w.reps.join() || it.days.join() !== w.days.join()) expect.fail(`seed ${seed}: ${it.fullName} 代表 ${it.monthly}/${w.reps} 日子 ${it.days}/${w.days}`)
        if (it.total !== total || it.avg !== Math.round(total / 3)) expect.fail(`seed ${seed}: ${it.fullName} 合计 ${it.total}/${total} 月均 ${it.avg}`)
      }
      for (let i = 1; i < got.items.length; i++) if (got.items[i].avg > got.items[i - 1].avg) expect.fail(`seed ${seed}: 没按月均从大到小`)
      const c = fixedChart({ txs, accounts: ACCOUNTS, cats: CATS, ym, start: `${ym}-01`, end: today, today })
      if (!got.items.length) {
        if (c.option !== null || !c.empty) expect.fail(`seed ${seed}: 没有固定开销却画了图`)
        continue
      }
      // 条上的数（series 的值）加起来 ≡ 小方块
      const bars = opt(c).series[0].data.reduce((s, d) => s + d.value, 0)
      const yuan = (bars / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      const tile = tiles(c)['固定开销']
      if (tile !== `¥${yuan}/月`) expect.fail(`seed ${seed}: 小方块 ${tile}，条上相加 ¥${yuan}/月`)
    }
  })
})

describe('源码', () => {
  it('不写死颜色、不看 hidden、不碰 store / api / facade / components', () => {
    // 变异：往 fixed.ts 里加一行 `const X = '#c95a4e'` → 红
    const src = readFileSync(new URL('./fixed.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(src).not.toMatch(/^import[^\n]*['"][./]*\/?components\//m)
  })
})

describe('父类被删掉的二级', () => {
  it('图上按一级显示，点了也按一级跳（不带不存在的父类 id）', () => {
    // 变异：去掉 parentOk 判断（照旧 c.parent_id ?? c.id）→ 跳成 cat=gone&sub=orphan，红
    const cats = [...CATS, cat('orphan', 'expense', 'gone', '孤儿', 1)]
    const txs = ['2026-06', '2026-07', '2026-08'].map((m) => spend(`${m}-03`, 88, 'orphan', 'wx'))
    const c = fixedChart(input(txs, '2026-09', '2026-09-29', { cats }))
    expect(c.onPoint!(0, 0)).toBe('ym=2026-08&type=expense&cat=orphan&acc=wx')
  })
})
