import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { CHART } from '../palette'
import { BUCKETS, bucketOf, histogram, histogramOf, topAmount } from './histogram'
import type { MoreInput } from './types'

const cats: Category[] = [
  { id: 'food', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'lunch', kind: 'expense', parent_id: 'food', name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'rent', kind: 'expense', parent_id: null, name: '经常生活开支', icon: null, sort: 2, is_archived: false, note: null },
  { id: 'fun', kind: 'expense', parent_id: null, name: '娱乐消费', icon: null, sort: 3, is_archived: false, note: null },
]

let seq = 0
function tx(date: string, amount: number, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `h${seq}`,
    date,
    type: 'expense',
    amount,
    account_id: 'wx',
    to_account_id: null,
    category_id: 'lunch',
    note: null,
    installments: null,
    settles: null,
    hidden: null,
    created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    ...over,
  }
}

function input(txs: Transaction[], start = '2026-09-01', end = '2026-09-28'): MoreInput {
  return { txs, accounts: [], cats, ym: '2026-09', start, end, today: '2026-09-28' }
}

type Opt = { xAxis: { data: string[] }; series: { data: number[]; label: { formatter: (p: { value: number }) => string } }[]; color: string[] }

describe('histogram：打开「单笔多大」看到什么', () => {
  it('九月这些支出，每一档几笔（正好 20 / 50 / 100 / 200 / 500 元落在右边那档）', () => {
    // 变异：bucketOf 里 `cents < max` 改成 `cents <= max` → 20.00 落进「<20」→ 红
    const yuan = [5, 19.99, 20, 49.99, 50, 99.99, 100, 150, 200, 499.99, 500, 1200]
    const txs = yuan.map((y, i) => tx(`2026-09-${String(1 + i).padStart(2, '0')}`, Math.round(y * 100)))
    const c = histogram(input(txs))
    const o = c.option as Opt
    expect(o.xAxis.data).toEqual(['<20', '20–50', '50–100', '100–200', '200–500', '500+'])
    expect(o.series[0].data).toEqual([2, 2, 2, 2, 2, 2])
  })

  it('收入、转账、校准不算；范围外的支出不算，范围两端当天算', () => {
    // 变异：histogramOf 的过滤把 `t.type !== 'expense'` 去掉 → 工资 8000 进了「500+」→ 红
    // 变异：`t.date < start` 改成 `t.date <= start` → 第一天那笔丢了 → 红
    const txs = [
      tx('2026-09-10', 800000, { type: 'income', category_id: null }),
      tx('2026-09-10', 300000, { type: 'transfer', to_account_id: 'boc', category_id: null }),
      tx('2026-09-10', 60000, { type: 'adjust', category_id: null }),
      tx('2026-08-31', 1000), // 范围前一天
      tx('2026-09-01', 1500), // 第一天
      tx('2026-09-28', 3000), // 最后一天
      tx('2026-09-29', 4000), // 范围后一天
    ]
    const h = histogramOf(txs, '2026-09-01', '2026-09-28')
    expect(h.count).toEqual([1, 1, 0, 0, 0, 0])
    expect(h.cents).toEqual([1500, 3000, 0, 0, 0, 0])
  })

  it('柱子上标笔数，0 笔的柱子不标；柱子颜色是 palette.CHART.expense', () => {
    // 变异：formatter 去掉 0 笔的判断（一律 `${p.value} 笔`）→ 一排「0 笔」→ 红；color 换成 CHART.income → 红
    const c = histogram(input([tx('2026-09-02', 1000), tx('2026-09-03', 1200), tx('2026-09-04', 88800)]))
    const o = c.option as Opt
    const fmt = o.series[0].label.formatter
    expect(o.series[0].data.map((v) => fmt({ value: v }))).toEqual(['2 笔', '', '', '', '', '1 笔'])
    expect(o.color).toEqual([CHART.expense])
    expect(c.key).toBe('histogram')
    expect(c.title).toBe('单笔多大')
  })

  it('下面的小方块是最大的五笔：大的在前，写日期 + 分类（有备注带备注）和金额；分类查不到写「未分类」；点一下跳那天的流水', () => {
    // 变异：排序写反成 a.amount - b.amount → 第一块成了最小的 → 红
    // 变异：slice(0, 5) 写成 slice(0, 6) → 多出一块 → 红
    // 变异：note 里删掉「下面几格是最大的几笔」那句 → 红（进阶分析页把 5 块排成上三下二，不说的话看不出是什么）
    // 变异：标签只写分类（去掉日期）→ 红；跳转不带 cat=all → 红
    const txs = [
      tx('2026-09-01', 350000, { category_id: 'rent', note: '交房租' }),
      tx('2026-09-02', 1500),
      tx('2026-09-03', 29900, { category_id: 'fun' }),
      tx('2026-09-04', 2200),
      tx('2026-09-05', 12800, { category_id: 'food', note: '  ' }), // 空白备注当没有
      tx('2026-09-06', 45600, { category_id: null }),
      tx('2026-09-07', 3300),
      tx('2026-08-20', 9999900, { category_id: 'rent' }), // 范围外，再大也不进前五
    ]
    const c = histogram(input(txs))
    expect(c.tiles).toEqual([
      { label: '9/1 经常生活开支 · 交房租', value: '¥3,500.00', go: 'ym=2026-09&date=2026-09-01&cat=all' },
      { label: '9/6 未分类', value: '¥456.00', go: 'ym=2026-09&date=2026-09-06&cat=all' },
      { label: '9/3 娱乐消费', value: '¥299.00', go: 'ym=2026-09&date=2026-09-03&cat=all' },
      { label: '9/5 日常餐饮', value: '¥128.00', go: 'ym=2026-09&date=2026-09-05&cat=all' },
      { label: '9/7 午餐', value: '¥33.00', go: 'ym=2026-09&date=2026-09-07&cat=all' },
    ])
    expect(c.note).toContain('下面几格是最大的几笔')
  })

  it('每月 1 号交一次房租、范围近一年：最大五笔里的几格房租分得出是哪几个月，各跳各的那天', () => {
    // 变异：标签只写分类 → 三格一模一样的「经常生活开支」，Set 去重后少了 → 红
    const txs = ['2026-07-01', '2026-08-01', '2026-09-01'].map((d) => tx(d, 350000, { category_id: 'rent' }))
    const c = histogram(input(txs, '2025-10-01', '2026-09-28'))
    expect(new Set(c.tiles!.map((t) => t.label)).size).toBe(3)
    expect(new Set(c.tiles!.map((t) => t.go)).size).toBe(3)
    expect(c.tiles![2].go).toBe('ym=2026-07&date=2026-07-01&cat=all')
  })

  it('过万的写「¥1.23万」：一行三格，375 宽一格只有 80 px 左右，「¥12,345.67」会被截成「¥12,34…」', () => {
    // 变异：去掉过万的写法 → 「¥12,345.67」→ 红；门槛写成 > 1_000_000 → 正好一万元那笔成了「¥10,000.00」→ 红
    expect(topAmount(1234567)).toBe('¥1.23万')
    expect(topAmount(1_000_000)).toBe('¥1.00万')
    expect(topAmount(999_999)).toBe('¥9,999.99')
    expect(topAmount(123456789)).toBe('¥123.46万')
  })

  it('一样大的几笔：日期新的在前', () => {
    // 变异：同额时的日期比较写反 → 9/3 那笔排到最后 → 红
    const txs = [tx('2026-09-01', 5000), tx('2026-09-03', 5000, { category_id: 'fun' }), tx('2026-09-02', 5000, { category_id: 'rent' })]
    expect(histogramOf(txs, '2026-09-01', '2026-09-28').top.map((t) => t.date)).toEqual(['2026-09-03', '2026-09-02', '2026-09-01'])
  })

  it('同一天、一样大的几笔：后记的在前（按录入时刻）', () => {
    // 变异：同一天时 created_at 的比较写反 → 先记的排到前面 → 红
    const early = tx('2026-09-05', 5000, { id: 'early', created_at: '2026-09-05T01:00:00.000Z' })
    const late = tx('2026-09-05', 5000, { id: 'late', created_at: '2026-09-05T09:00:00.000Z' })
    expect(histogramOf([early, late], '2026-09-01', '2026-09-28').top.map((t) => t.id)).toEqual(['late', 'early'])
    expect(histogramOf([late, early], '2026-09-01', '2026-09-28').top.map((t) => t.id)).toEqual(['late', 'early'])
  })

  it('这段时间只有收入 → 空状态，不画图、没有小方块', () => {
    // 变异：去掉 `if (n === 0) return … empty` → 画出一张全 0 的图、还有 tiles: [] → 红
    const c = histogram(input([tx('2026-09-10', 800000, { type: 'income', category_id: null })]))
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
    expect(c.tiles).toBeUndefined()
  })
})

describe('histogram：不变量', () => {
  function rng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 2 ** 32
    }
  }

  it('随机账本：各档笔数之和 ≡ 范围内支出笔数；各档金额之和 ≡ 范围内支出合计；每一笔都落在自己那档的上下界之间', () => {
    // 变异：`count[b] += 1` 写成 `count[b] = 1` → 笔数之和对不上 → 红
    // 变异：bucketOf 的 `cents < max` 改成 `<=` → 正好 20 元那笔落在「<20」，上下界那条断 → 红
    const types: Transaction['type'][] = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust']
    for (let k = 0; k < 300; k++) {
      const r = rng(k + 7)
      const txs: Transaction[] = []
      const n = Math.floor(r() * 60)
      for (let i = 0; i < n; i++) {
        const date = `2026-${r() < 0.3 ? '08' : '09'}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`
        // 金额取在边界附近的多一些：边界 ±1 分最容易出错
        const edge = [2000, 5000, 10000, 20000, 50000][Math.floor(r() * 5)]
        const amount = r() < 0.4 ? edge + Math.floor(r() * 3) - 1 : 1 + Math.floor(r() * 200000)
        txs.push(tx(date, amount, { type: types[Math.floor(r() * types.length)] }))
      }
      const h = histogramOf(txs, '2026-09-01', '2026-09-28')
      const spent = txs.filter((t) => t.type === 'expense' && t.date >= '2026-09-01' && t.date <= '2026-09-28')
      const cnt = h.count.reduce((s, v) => s + v, 0)
      const sum = h.cents.reduce((s, v) => s + v, 0)
      if (cnt !== spent.length) expect.fail(`第 ${k} 份：笔数 ${cnt} ≠ ${spent.length}`)
      if (sum !== spent.reduce((s, t) => s + t.amount, 0)) expect.fail(`第 ${k} 份：金额对不上`)
      for (const t of spent) {
        const b = bucketOf(t.amount)
        const lo = b === 0 ? 0 : BUCKETS[b - 1].max
        if (!(t.amount >= lo && t.amount < BUCKETS[b].max)) expect.fail(`第 ${k} 份：${t.amount} 分落在了「${BUCKETS[b].label}」`)
      }
      if (h.top.length !== Math.min(5, spent.length)) expect.fail(`第 ${k} 份：前五块数不对`)
      const maxAll = spent.reduce((m, t) => Math.max(m, t.amount), 0)
      if (spent.length && h.top[0].amount !== maxAll) expect.fail(`第 ${k} 份：第一块不是最大那笔`)
    }
  })
})

describe('histogram：守规矩', () => {
  const src = readFileSync(new URL('./histogram.ts', import.meta.url), 'utf8')
  it('不看 hidden、不碰 store / api、不写死十六进制颜色', () => {
    // 变异：循环里加 `if (t.hidden) continue` → 红；color 写成 ['#c95a4e'] → 红；import store → 红
    expect(src).not.toMatch(/\bhidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
