import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { amountLabel, CHILD_NONE, CREDIT_ALL, describeFilter, effectiveFilter, filterFromQuery, isFiltered, matchesFilter, NO_FILTER, type LedgerFilter } from './filter'
import type { Transaction } from '../types'

const rootOf = (id: string) => ({ p1: 'p1', c1: 'p1', c2: 'p2' } as Record<string, string>)[id]

function tx(p: Partial<Transaction> = {}): Transaction {
  return {
    id: 't',
    date: '2026-09-05',
    type: 'expense',
    amount: 100,
    account_id: 'a1',
    to_account_id: null,
    category_id: 'c1',
    note: null,
    installments: null,
    settles: null,
    hidden: null, is_offset: null,
    created_at: '2026-09-05T00:00:00.000Z',
    ...p,
  }
}
const f = (p: Partial<LedgerFilter>): LedgerFilter => ({ ...NO_FILTER, ...p })

describe('matchesFilter', () => {
  it('不筛就全过', () => {
    expect(matchesFilter(tx(), NO_FILTER, rootOf)).toBe(true)
    expect(matchesFilter(tx({ type: 'transfer', category_id: null }), NO_FILTER, rootOf)).toBe(true)
    expect(isFiltered(NO_FILTER)).toBe(false)
  })

  it('分类按一级匹配，二级归到它的一级', () => {
    expect(matchesFilter(tx({ category_id: 'c1' }), f({ parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'p1' }), f({ parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'c2' }), f({ parentId: 'p1' }), rootOf)).toBe(false)
    expect(matchesFilter(tx({ category_id: null }), f({ parentId: 'p1' }), rootOf)).toBe(false)
  })

  it('「未分类」只挑没有分类的收支，转账和校准不算', () => {
    const none = f({ parentId: 'none' })
    expect(matchesFilter(tx({ category_id: null }), none, rootOf)).toBe(true)
    expect(matchesFilter(tx({ type: 'income', category_id: null }), none, rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'c1' }), none, rootOf)).toBe(false)
    expect(matchesFilter(tx({ type: 'transfer', category_id: null, to_account_id: 'a2' }), none, rootOf)).toBe(false)
    expect(matchesFilter(tx({ type: 'adjust', category_id: null }), none, rootOf)).toBe(false)
    // 分类 id 查不到的孤儿记录也算未分类，和饼图的「未分类」块是同一批
    expect(matchesFilter(tx({ category_id: 'gone' }), none, rootOf)).toBe(true)
  })

  it('二级分类：只挑那一个二级，「未细分」挑直接记在一级上的', () => {
    expect(matchesFilter(tx({ category_id: 'c1' }), f({ parentId: 'p1', childId: 'c1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'p1' }), f({ parentId: 'p1', childId: 'c1' }), rootOf)).toBe(false)
    expect(matchesFilter(tx({ category_id: 'p1' }), f({ parentId: 'p1', childId: CHILD_NONE }), rootOf)).toBe(true)
    expect(matchesFilter(tx({ category_id: 'c1' }), f({ parentId: 'p1', childId: CHILD_NONE }), rootOf)).toBe(false)
    // 没选一级时 childId 不生效；旧版本存下来的筛选没有这个字段，也不能把人挡光
    expect(matchesFilter(tx({ category_id: 'c1' }), f({ childId: 'c2' }), rootOf)).toBe(true)
    const old = { type: 'all', accountId: 'all', parentId: 'p1' } as LedgerFilter
    expect(matchesFilter(tx({ category_id: 'c1' }), old, rootOf)).toBe(true)
  })

  it('账户：转入转出两边都算；「未指定」只挑没有账户的', () => {
    const t = tx({ type: 'transfer', account_id: 'a1', to_account_id: 'a2', category_id: null })
    expect(matchesFilter(t, f({ accountId: 'a2' }), rootOf)).toBe(true)
    expect(matchesFilter(t, f({ accountId: 'a3' }), rootOf)).toBe(false)
    expect(matchesFilter(tx({ account_id: null }), f({ accountId: 'none' }), rootOf)).toBe(true)
    expect(matchesFilter(tx(), f({ accountId: 'none' }), rootOf)).toBe(false)
  })

  it('账户选「白条」：支出记在任一白条上、或还款转进任一白条的都算', () => {
    const credits = new Set(['jd', 'hb'])
    const c = f({ accountId: CREDIT_ALL })
    expect(matchesFilter(tx({ account_id: 'jd' }), c, rootOf, credits)).toBe(true)
    expect(matchesFilter(tx({ type: 'transfer', account_id: 'a1', to_account_id: 'hb', category_id: null }), c, rootOf, credits)).toBe(true)
    expect(matchesFilter(tx({ account_id: 'a1' }), c, rootOf, credits)).toBe(false)
    expect(matchesFilter(tx({ account_id: null }), c, rootOf, credits)).toBe(false)
    // 没传白条集合就什么都不匹配，不会误把普通账户当白条
    expect(matchesFilter(tx({ account_id: 'jd' }), c, rootOf)).toBe(false)
  })

  it('条件之间是「且」', () => {
    expect(matchesFilter(tx(), f({ type: 'expense', parentId: 'p1' }), rootOf)).toBe(true)
    expect(matchesFilter(tx(), f({ type: 'income', parentId: 'p1' }), rootOf)).toBe(false)
    expect(isFiltered(f({ type: 'income' }))).toBe(true)
  })
})

describe('金额范围（用户 2026-10-23）', () => {
  it('只填最低 = 这个数及以上，正好等于的那笔也算；只填最高 = 这个数及以下；都填 = 夹在中间', () => {
    // 变异：最低那头写成 <=（正好 100 的被筛掉）→ 红；最高那头写成 >= → 红
    const at = (amount: number, lo?: number, hi?: number) => matchesFilter(tx({ amount }), f({ minCents: lo, maxCents: hi }), rootOf)
    expect([9999, 10000, 10001].map((a) => at(a, 10000))).toEqual([false, true, true])
    expect([4999, 5000, 5001].map((a) => at(a, undefined, 5000))).toEqual([true, true, false])
    expect([9999, 10000, 30000, 50000, 50001].map((a) => at(a, 10000, 50000))).toEqual([false, true, true, true, false])
  })

  it('校准有正有负，看去掉正负号的大小：-200 算 200', () => {
    // 变异：去掉 Math.abs → -200 的那笔筛「150 以上」时被漏掉，红
    const adj = tx({ type: 'adjust', amount: -20000, category_id: null })
    expect(matchesFilter(adj, f({ minCents: 15000 }), rootOf)).toBe(true)
    expect(matchesFilter(adj, f({ maxCents: 15000 }), rootOf)).toBe(false)
  })

  it('和别的条件是「且」：支出 + 恋爱 + 200 以上', () => {
    const cond = f({ type: 'expense', parentId: 'p1', minCents: 20000 })
    expect(matchesFilter(tx({ amount: 26800 }), cond, rootOf)).toBe(true)
    expect(matchesFilter(tx({ amount: 1800 }), cond, rootOf)).toBe(false)
    expect(matchesFilter(tx({ amount: 26800, category_id: 'c2' }), cond, rootOf)).toBe(false)
  })

  it('只设了金额也算「已筛选」，按钮要亮', () => {
    // 变异：isFiltered 不看金额 → 红（列表少了一半，筛选按钮却不亮）
    expect(isFiltered(f({ minCents: 10000 }))).toBe(true)
    expect(isFiltered(f({ maxCents: 0 }))).toBe(true)
    expect(isFiltered(NO_FILTER)).toBe(false)
  })

  it('顶上写成「¥100 以上」「¥50 以下」「¥100–500」，零头照写', () => {
    expect(amountLabel(10000, undefined)).toBe('¥100 以上')
    expect(amountLabel(undefined, 5000)).toBe('¥50 以下')
    expect(amountLabel(10000, 50000)).toBe('¥100–500')
    expect(amountLabel(1250, 1205)).toBe('¥12.5–12.05')
    expect(amountLabel(undefined, undefined)).toBe('')
  })
})

describe('只看「外面隐藏」的记录', () => {
  it('开着时只剩打了记号的，可以和别的条件叠加', () => {
    // 变异：matchesFilter 去掉 hiddenOnly 那一行 → 红
    const on = f({ hiddenOnly: true })
    expect(matchesFilter(tx({ hidden: true }), on, rootOf)).toBe(true)
    expect(matchesFilter(tx({ hidden: null }), on, rootOf)).toBe(false)
    expect(matchesFilter(tx({ hidden: true, type: 'income' }), f({ hiddenOnly: true, type: 'expense' }), rootOf)).toBe(false)
    expect(isFiltered(on)).toBe(true) // 变异：isFiltered 不看 hiddenOnly → 红
  })

  it('旧版本存下的筛选条件没有这个字段，当没开', () => {
    const old = { type: 'all', accountId: 'all', parentId: 'all', childId: 'all' } as LedgerFilter
    expect(matchesFilter(tx({ hidden: null }), old, rootOf)).toBe(true)
    expect(isFiltered(old)).toBe(false)
  })

  it('外页面一律当没开：条件记两小时，人在里页面开着、App 自动退回外页面时不能跟过去', () => {
    // 变异：effectiveFilter 里 mode 判断去掉 → 红
    const on = f({ hiddenOnly: true, type: 'income' })
    const outer = effectiveFilter(on, 'outer')
    expect(outer.hiddenOnly).toBe(false)
    expect(outer.type).toBe('income') // 别的条件照旧
    expect(isFiltered(effectiveFilter(f({ hiddenOnly: true }), 'outer'))).toBe(false) // 标签也不能亮
    expect(effectiveFilter(on, 'inner')).toBe(on) // 里页面原样
    expect(effectiveFilter(f({ type: 'income' }), 'outer')).toEqual(f({ type: 'income' }))
  })

  it('流水页必须用 effectiveFilter 之后的条件筛列表、亮标签', () => {
    // 页面测不了，守源码。变异：matchesFilter(t, eff → matchesFilter(t, filter → 红
    const src = readFileSync(new URL('../pages/Ledger.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/effectiveFilter\(filter, mode\)/)
    expect(src).toMatch(/matchesFilter\(t, eff,/)
    expect(src).toMatch(/isFiltered\(eff\)/)
    expect(src).not.toMatch(/matchesFilter\(t, filter,/)
    expect(src).not.toMatch(/isFiltered\(filter\)/)
  })
})

describe('「已筛选」后面把条件写出来', () => {
  const names = {
    account: (id: string | null) => ({ a1: '支付宝', a2: '微信' } as Record<string, string>)[id ?? ''] ?? '',
    category: (id: string | null) => ({ p1: '日常开支', c1: '日常开支 通勤交通' } as Record<string, string>)[id ?? ''] ?? '',
  }

  it('按 类型 · 账户 · 分类 · 金额 · 藏起来的 的顺序，没选的不写', () => {
    // 变异：去掉 hiddenOnly 那一段 → 红；账户和类型顺序对调 → 红
    expect(describeFilter(NO_FILTER, names)).toEqual([])
    expect(describeFilter(f({ type: 'expense', accountId: 'a1', hiddenOnly: true }), names)).toEqual(['支出', '支付宝', '藏起来的'])
    expect(describeFilter(f({ parentId: 'p1' }), names)).toEqual(['日常开支'])
    expect(describeFilter(f({ parentId: 'p1', childId: 'c1' }), names)).toEqual(['日常开支 通勤交通'])
    expect(describeFilter(f({ parentId: 'p1', childId: CHILD_NONE }), names)).toEqual(['日常开支 未细分'])
    expect(describeFilter(f({ parentId: 'none', accountId: 'none' }), names)).toEqual(['未指定账户', '未分类'])
    expect(describeFilter(f({ accountId: CREDIT_ALL, type: 'transfer' }), names)).toEqual(['转账', '白条'])
    // 变异：describeFilter 不写金额 → 红
    expect(describeFilter(f({ type: 'expense', parentId: 'p1', minCents: 20000, hiddenOnly: true }), names)).toEqual(['支出', '日常开支', '¥200 以上', '藏起来的'])
  })

  it('外页面传的是 effectiveFilter 之后的条件，所以永远写不出「藏起来的」', () => {
    expect(describeFilter(effectiveFilter(f({ hiddenOnly: true, type: 'income' }), 'outer'), names)).toEqual(['收入'])
  })

  it('流水页必须拿 eff 去描述，不能拿原 filter', () => {
    // 变异：describeFilter(eff → describeFilter(filter → 红（外页面会把「藏起来的」写出来）
    const src = readFileSync(new URL('../pages/Ledger.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/describeFilter\(eff, names\)/)
    expect(src).not.toMatch(/describeFilter\(filter/)
  })
})

describe('filterFromQuery：从别的页带参数跳到流水页，筛选换成什么', () => {
  const q = (s: string) => filterFromQuery(new URLSearchParams(s))

  it('进阶分析瀑布图：先点「日常餐饮」→ 支出·日常餐饮；再点「收入」→ 只看收入，日常餐饮那个条件清掉', () => {
    // 流水页的筛选会记两小时（jz_ledger_filter），第二次跳过来时上一次的还在；带了 cat 就整个换掉
    // 变异：filterFromQuery 里 parentId 写死 'all'（不认 cat）→ 第一条红
    expect(q('ym=2026-09&type=expense&cat=food')).toEqual({ type: 'expense', accountId: 'all', parentId: 'food', childId: 'all', hiddenOnly: false })
    const income = q('ym=2026-09&type=income&cat=all')!
    expect(income).toEqual({ ...NO_FILTER, type: 'income' })
    expect(matchesFilter(tx({ type: 'income', category_id: null }), income, rootOf)).toBe(true)
    expect(isFiltered(q('ym=2026-09&cat=all')!)).toBe(false)
  })

  it('白条曲线点 9 月 → 9 月、账户筛成「白条」（四家一起）', () => {
    // 变异：不读 acc（accountId 写死 'all'，改前的写法）→ 红
    expect(q('ym=2026-09&cat=all&acc=credit')).toEqual({ ...NO_FILTER, accountId: CREDIT_ALL })
  })

  it('只带 ym / date、没带 cat（首页「今天」那张卡、统计页趋势图）→ 不动筛选（返回 null）', () => {
    // 变异：没带 cat 也返回 NO_FILTER → 红（首页点「今天」会把用户自己设的筛选清掉）
    expect(q('date=2026-09-28')).toBeNull()
    expect(q('ym=2026-09&date=2026-09-12')).toBeNull()
  })

  it('统计页点二级分类：type / cat / sub 原样带过来', () => {
    // 变异：parentId 写死 'all' → 红；sub 不读（childId 写死 'all'）→ 红
    expect(q(`ym=2026-09&type=expense&cat=p1&sub=${CHILD_NONE}`)).toEqual({ type: 'expense', accountId: 'all', parentId: 'p1', childId: CHILD_NONE, hiddenOnly: false })
  })

  it('流水页读参数走的是这个函数', () => {
    // 页面测不了（没有 DOM），守源码。变异：Ledger.tsx 退回自己拼筛选（不读 acc 的那版）→ 红
    const src = readFileSync(new URL('../pages/Ledger.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/const jumped = filterFromQuery\(params\)/)
    expect(src).not.toMatch(/accountId: 'all', parentId: qCat/)
  })
})
