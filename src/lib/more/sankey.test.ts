// 钱的流向（桑基图）。输入都是「一份小账本 + 选了哪段时间」，断言的是打开那张卡看到什么：
// 哪几个节点、谁连到谁、线上多少钱。每条用例的注释里写着「变异：xxx → 红」，
// 是写完后真的把实现改坏跑过一遍、确认会红，再改回来的。
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../../types'
import { categoryColor, CHART, childShade } from '../palette'
import { LAST_LABEL_W, NO_ACCOUNT, OTHER_ACCOUNT, REST, SANKEY_FONT, SANKEY_GAP, SANKEY_MAX_SUBS, sankeyChart } from './sankey'
import type { MoreInput } from './types'

const A = (id: string, name: string, sort: number, kind: Account['kind'] = 'bank'): Account => ({
  id, name, kind, sort, is_archived: false, repay_day: kind === 'credit' ? 17 : null, defer_after_repay: null, facade_offset: null,
})
const C = (id: string, name: string, sort: number, parent_id: string | null = null, kind: Category['kind'] = 'expense'): Category => ({
  id, kind, parent_id, name, icon: null, sort, is_archived: false, note: null,
})

const boc = A('boc', '中国银行', 1)
const wx = A('wx', '微信', 2, 'wallet')
const jd = A('jd', '京东白条', 5, 'credit')
const accounts = [boc, wx, jd]
const cats: Category[] = [
  C('food', '日常餐饮', 1),
  C('lunch', '午餐', 1, 'food'),
  C('dinner', '晚餐', 2, 'food'),
  C('fun', '娱乐消费', 4),
  C('game', '游戏充值', 1, 'fun'),
  C('salary', '工资/实习', 1, null, 'income'),
]

let seq = 0
function tx(date: string, type: Transaction['type'], amount: number, account_id: string | null, category_id: string | null = null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `t${seq}`, date, type, amount, account_id, to_account_id: null, category_id, note: null,
    installments: null, settles: null, hidden: null, is_offset: null, created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(), ...over,
  }
}

const input = (txs: Transaction[], over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts, cats, ym: '2026-09', start: '2026-09-01', end: '2026-09-30', today: '2026-09-20', ...over,
})

interface SNode { id: string; name: string; value: number; itemStyle: { color: string }; label?: { width?: number; overflow?: string } }
interface SLink { source: string; target: string; value: number }
type Fmt = (p: { dataType?: string; data: Record<string, unknown> }) => string

/** 把 option 翻成人看得懂的样子：每列的节点名，和「源名→目标名 金额」 */
function view(inp: MoreInput) {
  const ch = sankeyChart(inp)
  const o = ch.option as { series: { data: SNode[]; links: SLink[] }[]; tooltip: { formatter: Fmt } }
  const { data: nodes, links } = o.series[0]
  const name = new Map(nodes.map((n) => [n.id, n.name]))
  const col = (prefix: string) => nodes.filter((n) => n.id.startsWith(prefix)).map((n) => `${n.name} ${n.value}`)
  return {
    ch,
    nodes,
    links,
    accounts: col('a:'),
    parents: col('p:'),
    subs: col('s:'),
    flows: links.map((l) => `${name.get(l.source)}→${name.get(l.target)} ${l.value}`).sort(),
    tip: o.tooltip.formatter,
  }
}

describe('钱的流向：打开看到什么', () => {
  // 九月的一本小账：两个真账户 + 一笔没指定账户的；一笔直接记在一级上；
  // 外加转账、校准、收入、区间外的支出各一笔，它们都不该出现在图上
  const txs = [
    tx('2026-09-02', 'expense', 3000, 'boc', 'lunch'),
    tx('2026-09-03', 'expense', 5000, 'boc', 'dinner'),
    tx('2026-09-05', 'expense', 2000, 'wx', 'lunch'),
    tx('2026-09-06', 'expense', 10000, null, 'game'),
    tx('2026-09-07', 'expense', 1500, 'wx', 'food'), // 直接记在「日常餐饮」上，没选二级
    tx('2026-09-08', 'transfer', 50000, 'boc', null, { to_account_id: 'wx' }),
    tx('2026-09-09', 'adjust', -777, 'boc'),
    tx('2026-09-10', 'income', 800000, 'boc', 'salary'),
    tx('2026-08-31', 'expense', 99900, 'boc', 'lunch'), // 前一天，区间外
    tx('2026-10-01', 'expense', 88800, 'boc', 'lunch'), // 后一天，区间外
  ]

  it('三列：账户 → 一级 → 二级，每列按金额从大到小', () => {
    // 变异：type 过滤改成 isFlow（收入也算进来）→ 红；区间改成 t.date < end → 不红（这里没有 9/30 的），由下一条守
    const v = view(input(txs))
    expect(v.accounts).toEqual([`${NO_ACCOUNT} 10000`, '中国银行 8000', '微信 3500'])
    expect(v.parents).toEqual(['日常餐饮 11500', '娱乐 10000']) // 一级用短名，「娱乐消费」→「娱乐」
    expect(v.subs).toEqual(['午餐 5000', '晚餐 5000', '游戏充值 10000']) // 同大类挨着，大类按第二列的顺序
  })

  it('谁连谁、多少钱；直接记在一级上的 15 块没有第三段，不造「其他 / 未细分」', () => {
    // 变异：c.id !== root.id 的判断去掉（一级也连一条到自己的「二级」）→ 红
    const v = view(input(txs))
    expect(v.flows).toEqual(
      [
        '未指定→娱乐 10000',
        '中国银行→日常餐饮 8000',
        '微信→日常餐饮 3500',
        '日常餐饮→午餐 5000',
        '日常餐饮→晚餐 5000',
        '娱乐→游戏充值 10000',
      ].sort(),
    )
    expect(v.nodes.some((n) => /其他|未细分/.test(n.name))).toBe(false)
  })

  it('时间范围两头都算：9/1 和 9/30 的在，8/31 和 10/1 的不在', () => {
    // 变异：t.date > inp.end 改成 t.date >= inp.end → 红；t.date < inp.start 改成 <= → 红
    const v = view(input([tx('2026-09-01', 'expense', 100, 'boc', 'lunch'), tx('2026-09-30', 'expense', 200, 'boc', 'lunch'), tx('2026-08-31', 'expense', 400, 'boc', 'lunch'), tx('2026-10-01', 'expense', 800, 'boc', 'lunch')]))
    expect(v.accounts).toEqual(['中国银行 300'])
  })

  it('账户不在活跃清单里（归档了）的支出不能从图上消失，归「其他账户」', () => {
    // 变异：查不到账户就 continue → 红
    const v = view(input([tx('2026-09-02', 'expense', 700, 'gone', 'lunch'), tx('2026-09-02', 'expense', 100, 'boc', 'lunch')]))
    expect(v.accounts).toEqual([`${OTHER_ACCOUNT} 700`, '中国银行 100'])
  })

  it('没有支出 → 显示空状态，不画图（只有转账、校准、收入也算没有）', () => {
    // 变异：去掉 total<=0 那行空判断 → 红
    const ch = sankeyChart(input([tx('2026-09-08', 'transfer', 50000, 'boc', null, { to_account_id: 'wx' }), tx('2026-09-09', 'adjust', 100, 'boc'), tx('2026-09-10', 'income', 800000, 'boc', 'salary')]))
    expect(ch.option).toBeNull()
    expect(ch.empty).toBeTruthy()
    expect(ch.key).toBe('sankey')
    expect(ch.title).toBe('钱的流向')
  })

  it('提示框里是元：¥1,234.56，线上写「源 → 目标」全名', () => {
    // 变异：yuan 去掉 symbol → 红；提示框用短名（娱乐）→ 红
    const v = view(input([tx('2026-09-02', 'expense', 123456, 'boc', 'game')]))
    const link = v.links.find((l) => l.source === 'a:boc')!
    expect(v.tip({ dataType: 'edge', data: { ...link } })).toContain('中国银行 → 娱乐消费')
    expect(v.tip({ dataType: 'edge', data: { ...link } })).toContain('¥1,234.56')
    const node = v.nodes.find((n) => n.id === 'p:fun')!
    expect(v.tip({ dataType: 'node', data: { ...node } })).toContain('娱乐消费')
    expect(v.tip({ dataType: 'node', data: { ...node } })).toContain('¥1,234.56')
  })

  it('颜色：账户中性色，一级 categoryColor，二级 childShade（按二级自己的 sort）', () => {
    // 变异：二级直接用父色 → 红；账户用 categoryColor → 红
    const v = view(input(txs))
    const color = (id: string) => v.nodes.find((n) => n.id === id)!.itemStyle.color
    expect(color('a:boc')).toBe(CHART.label)
    expect(color('p:food')).toBe(categoryColor('日常餐饮'))
    expect(color('s:dinner')).toBe(childShade(categoryColor('日常餐饮'), 2))
    expect(color('s:game')).toBe(childShade(categoryColor('娱乐消费'), 1))
  })

  it('认不出名字的一级分类（自己建的「宠物」「学习」）按金额名次取备用色，两个不撞色，和饼图同一个发法', () => {
    // 变异：一级色写成 categoryColor(p.full)（不传名次）→ 两个都拿到第一个备用色，红
    const cs = [...cats, C('pet', '宠物', 6), C('study', '学习', 7)]
    const v = view({ ...input([tx('2026-09-02', 'expense', 900, 'boc', 'pet'), tx('2026-09-02', 'expense', 500, 'boc', 'study'), tx('2026-09-02', 'expense', 100, 'boc', 'lunch')]), cats: cs })
    const color = (id: string) => v.nodes.find((n) => n.id === id)!.itemStyle.color
    expect(color('p:pet')).toBe(categoryColor('宠物', 0))
    expect(color('p:study')).toBe(categoryColor('学习', 1))
    expect(color('p:pet')).not.toBe(color('p:study'))
  })

  it('提示框的占比按这段时间的支出合计算：娱乐 100 ÷ 215 = 46.5%，中国银行 → 日常餐饮 80 ÷ 215 = 37.2%', () => {
    // 变异：占比的分母写成 100（不是 total）→ 「10000.0%」→ 红
    const v = view(input(txs))
    const node = v.nodes.find((n) => n.id === 'p:fun')!
    expect(v.tip({ dataType: 'node', data: { ...node } })).toContain('占 46.5%')
    const link = v.links.find((l) => l.source === 'a:boc' && l.target === 'p:food')!
    expect(v.tip({ dataType: 'edge', data: { ...link } })).toContain('占 37.2%')
  })

  it('标题旁写这段时间（9/1–9/30 → 「26.9」）', () => {
    // 变异：sankey 的 base 不带 span → 红
    expect(view(input(txs)).ch.span).toBe('26.9')
  })

  it('标签不叠、不出界：同一列节点之间的空隙不小于一行字；最后一列的标签限宽、长的截断', () => {
    // 节点高按金额分，小账户只有两三 px 高；空隙够一行字，相邻两个标签的中心距就一定 ≥ 一行字。
    // ChartMore.test.ts 用 SSR 真画出来量过（几张白条 + 现金 + 未指定、一大笔房租的账本）
    // 变异：nodeGap 改回 8 → 红；最后一列不设 label.width → 红
    const v = view(input(txs))
    const s = (v.ch.option as { series: { nodeGap: number }[] }).series[0]
    expect(s.nodeGap).toBeGreaterThanOrEqual(SANKEY_FONT + 2)
    expect(SANKEY_GAP).toBe(s.nodeGap)
    for (const n of v.nodes) {
      if (n.id.startsWith('s:')) expect(n.label, n.name).toEqual({ width: LAST_LABEL_W, overflow: 'truncate' })
      else expect(n.label, n.name).toBeUndefined()
    }
    // 没有二级（全记在一级上）：一级就是最后一列，它来限宽
    const flat = view(input([tx('2026-09-02', 'expense', 100, 'boc', 'food'), tx('2026-09-02', 'expense', 100, 'boc', 'fun')]))
    expect(flat.nodes.filter((n) => n.id.startsWith('p:')).every((n) => n.label?.width === LAST_LABEL_W)).toBe(true)
  })
})

describe('二级重名 / 太多', () => {
  it('两个大类下都有「其他」：是两个节点，钱不糊在一起', () => {
    // 变异：节点 id 用名字（s:${c.name}）→ 红
    const cs = [...cats, C('food-x', '其他', 9, 'food'), C('fun-x', '其他', 9, 'fun')]
    const v = view({ ...input([tx('2026-09-02', 'expense', 300, 'boc', 'food-x'), tx('2026-09-02', 'expense', 500, 'boc', 'fun-x')]), cats: cs })
    expect(v.subs).toEqual(['其他 500', '其他 300'])
    expect(v.flows).toEqual(['娱乐→其他 500', '日常餐饮→其他 300', '中国银行→娱乐 500', '中国银行→日常餐饮 300'].sort())
  })

  it(`二级超过 ${SANKEY_MAX_SUBS} 个：留金额前 ${SANKEY_MAX_SUBS}，其余并成一个「${REST}」，各大类各连一条`, () => {
    // 变异：SANKEY_MAX_SUBS 当 13 用（slice(0, 13)）→ 红；「其余」只连第一个大类 → 红
    const cs = [...cats]
    const txs: Transaction[] = []
    // 日常餐饮下 9 个、娱乐下 6 个，金额 1..15 元互不相同。最小的三个：1、2 元在餐饮，3 元在娱乐
    for (let i = 1; i <= 15; i++) {
      const parent = i <= 2 || (i > 6 && i <= 13) ? 'food' : 'fun'
      cs.push(C(`c${i}`, `二级${i}`, i, parent))
      txs.push(tx('2026-09-02', 'expense', i * 100, 'boc', `c${i}`))
    }
    const v = view({ ...input(txs), cats: cs })
    const subIds = v.nodes.filter((n) => n.id.startsWith('s:')).map((n) => n.name)
    expect(subIds.length).toBe(SANKEY_MAX_SUBS + 1)
    expect(subIds.at(-1)).toBe(REST)
    expect(subIds).not.toContain('二级1')
    expect(subIds).not.toContain('二级2')
    expect(subIds).not.toContain('二级3')
    const rest = v.nodes.find((n) => n.name === REST)!
    expect(rest.value).toBe(600)
    expect(rest.itemStyle.color).toBe(CHART.label)
    expect(v.flows.filter((f) => f.includes(REST))).toEqual([`日常餐饮→${REST} 300`, `娱乐→${REST} 300`].sort())
  })

  it(`正好 ${SANKEY_MAX_SUBS} 个二级：一个都不并`, () => {
    // 变异：slice 留 11 个 → 红
    const cs = [...cats]
    const txs: Transaction[] = []
    for (let i = 1; i <= SANKEY_MAX_SUBS; i++) {
      cs.push(C(`c${i}`, `二级${i}`, i, 'food'))
      txs.push(tx('2026-09-02', 'expense', i * 100, 'boc', `c${i}`))
    }
    const v = view({ ...input(txs), cats: cs })
    expect(v.subs.length).toBe(SANKEY_MAX_SUBS)
    expect(v.nodes.some((n) => n.name === REST)).toBe(false)
  })
})

// ---------- 不变量：随机账本 ----------

/** 固定种子的线性同余，红了把种子打出来就能复现 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('钱的流向：守恒（随机账本 × 200）', () => {
  it('第一列之和 ≡ 区间内支出合计；每个节点 = max(流入, 流出)；二级那段 ≡ 记在二级上的支出', () => {
    // 变异：未指定账户的支出 continue 掉 → 红（第一列之和对不上）；「其余」的连线漏加 → 红
    const types: Transaction['type'][] = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust']
    const catIds = [null, 'food', 'lunch', 'dinner', 'fun', 'game', 'nope']
    // 走到「并成其余」那条路的账本数：太少说明随机账本没覆盖到它，这条不变量就是摆设
    let mergedSeeds = 0
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
      // 每份账本随机加 8~20 个二级（连原有 3 个共 11~23 个），「超过 12 个要合并」和「不用合并」两条路都走得到
      const cs = [...cats]
      const extra = 8 + Math.floor(r() * 13)
      for (let i = 0; i < extra; i++) cs.push(C(`x${i}`, `二级${i}`, i, pick(['food', 'fun'])))
      const allCat = [...catIds, ...cs.filter((c) => c.id.startsWith('x')).map((c) => c.id)]
      const txs: Transaction[] = []
      // 笔数给足、多数落在区间里：第三列超过 12 个、要并「其余」的路要经常走到
      for (let i = 0; i < 150; i++) {
        const type = pick(types)
        const day = String(1 + Math.floor(r() * 30)).padStart(2, '0')
        const month = pick(['2026-08', '2026-09', '2026-09', '2026-09', '2026-10'])
        txs.push(tx(`${month}-${day}`, type, 1 + Math.floor(r() * 50000), pick([null, 'boc', 'wx', 'jd', 'gone']), type === 'expense' ? pick(allCat) : null, type === 'transfer' ? { to_account_id: 'wx' } : {}))
      }
      const inp = { ...input(txs), cats: cs }
      const inRange = txs.filter((t) => t.type === 'expense' && t.date >= inp.start && t.date <= inp.end)
      const total = inRange.reduce((s, t) => s + t.amount, 0)
      const ch = sankeyChart(inp)
      if (total === 0) {
        if (ch.option !== null) expect.fail(`seed ${seed}: 没支出却画了图`)
        continue
      }
      const { data: nodes, links } = (ch.option as { series: { data: SNode[]; links: SLink[] }[] }).series[0]
      const inOf = new Map<string, number>()
      const outOf = new Map<string, number>()
      for (const l of links) {
        if (l.value <= 0) expect.fail(`seed ${seed}: 有一条 ${l.value} 的线`)
        outOf.set(l.source, (outOf.get(l.source) ?? 0) + l.value)
        inOf.set(l.target, (inOf.get(l.target) ?? 0) + l.value)
      }
      const fromAccounts = links.filter((l) => l.source.startsWith('a:')).reduce((s, l) => s + l.value, 0)
      if (fromAccounts !== total) expect.fail(`seed ${seed}: 第一列 ${fromAccounts} ≠ 支出合计 ${total}`)
      const byId = new Map(cs.map((c) => [c.id, c]))
      const onSub = inRange.filter((t) => t.category_id && byId.get(t.category_id)?.parent_id).reduce((s, t) => s + t.amount, 0)
      const toSubs = links.filter((l) => l.source.startsWith('p:')).reduce((s, l) => s + l.value, 0)
      if (toSubs !== onSub) expect.fail(`seed ${seed}: 第三段 ${toSubs} ≠ 记在二级上的 ${onSub}`)
      for (const n of nodes) {
        const want = Math.max(inOf.get(n.id) ?? 0, outOf.get(n.id) ?? 0)
        if (n.value !== want) expect.fail(`seed ${seed}: 节点 ${n.name} 标 ${n.value}，流入流出算出来 ${want}`)
        if ((outOf.get(n.id) ?? 0) > (inOf.get(n.id) ?? Infinity)) expect.fail(`seed ${seed}: 节点 ${n.name} 流出比流入多`)
      }
      const subCount = nodes.filter((n) => n.id.startsWith('s:')).length
      if (subCount > SANKEY_MAX_SUBS + 1) expect.fail(`seed ${seed}: 第三列 ${subCount} 个节点`)
      if (nodes.some((n) => n.name === REST)) mergedSeeds++
      if (new Set(nodes.map((n) => n.id)).size !== nodes.length) expect.fail(`seed ${seed}: 节点 id 重复`)
    }
    expect(mergedSeeds).toBeGreaterThan(20)
    expect(mergedSeeds).toBeLessThan(180)
  })
})

describe('颜色只有一个来源', () => {
  it('进阶统计这三张图的源码里不许写死十六进制颜色', () => {
    // 变异：sankey.ts 里账户色写成 '#918a80' → 红；写成 8 位的 '#918a80cc' → 红（原来的 {3,6} 漏掉它）
    for (const f of ['sankey.ts', 'radar.ts', 'credit.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      const hits = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
      expect(hits, `${f} 里写死了颜色：${hits.join(' ')}`).toEqual([])
    }
  })

  it('也不许偷看 hidden、不许碰 store / api', () => {
    // 变异：sankey.ts 里加一句 t.hidden 判断 → 红
    for (const f of ['sankey.ts', 'radar.ts', 'credit.ts']) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toMatch(/\.hidden\b/)
      expect(src, f).not.toMatch(/from '\.\.\/(store|api|supabase)'/)
    }
  })
})
