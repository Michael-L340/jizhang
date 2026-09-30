/// <reference types="node" />
// 流水页默认看全部（用户 2026-10-01：「常态应该是显示全部的流水，我可以下滑一直翻的。只有需要选定的时候才会看特定的月份」）。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Transaction } from '../types'
import { groupByDay, isFlow } from './compute'
import { addDays, monthOf } from './date'
import { ALL_MONTHS, daysToShow, monthSections, PAGE_DAYS, ymFromQuery } from './ledger'

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `l${seq}`, account_id: 'wx', to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: `${p.date}T04:00:00.000Z`, ...p,
  }
}

describe('流水页：全部月份按月分节', () => {
  it('8 月底、9 月、10 月初各记了几笔 → 打开看到「10 月 / 9 月 / 8 月」三节，新的在上；每节的支出、收入是那个月的，转账和校准不算', () => {
    // 变异：每换一天就开新的一节（不看月份）→ 9 月被拆成两节，红
    const txs = [
      tx({ type: 'expense', amount: 1200, date: '2026-08-31' }),
      tx({ type: 'income', amount: 800000, date: '2026-09-10' }),
      tx({ type: 'expense', amount: 3000, date: '2026-09-10' }),
      tx({ type: 'transfer', amount: 50000, date: '2026-09-17', to_account_id: 'jd' }),
      tx({ type: 'expense', amount: 4500, date: '2026-09-30' }),
      tx({ type: 'adjust', amount: -700, date: '2026-10-01' }),
      tx({ type: 'expense', amount: 1800, date: '2026-10-01' }),
    ]
    const secs = monthSections(groupByDay(txs))
    expect(secs.map((s) => [s.ym, s.days.map((d) => d.date), s.expense, s.income])).toEqual([
      ['2026-10', ['2026-10-01'], 1800, 0],
      ['2026-09', ['2026-09-30', '2026-09-17', '2026-09-10'], 7500, 800000],
      ['2026-08', ['2026-08-31'], 1200, 0],
    ])
  })

  it('不变量（随机账本）：每一天正好落在它那个月的一节里、顺序不变；各节支出之和 = 列表里所有支出，收入同理', () => {
    let s = 20261001
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 200; k++) {
      const txs = Array.from({ length: 1 + Math.floor(rnd() * 80) }, () =>
        tx({ type: TYPES[Math.floor(rnd() * TYPES.length)], amount: 1 + Math.floor(rnd() * 90000), date: addDays('2025-01-01', Math.floor(rnd() * 640)) }),
      )
      const days = groupByDay(txs)
      const secs = monthSections(days)
      if (JSON.stringify(secs.flatMap((x) => x.days.map((d) => d.date))) !== JSON.stringify(days.map((d) => d.date))) expect.fail(`第 ${k} 份：天的顺序变了`)
      for (const x of secs) if (x.days.some((d) => monthOf(d.date) !== x.ym)) expect.fail(`第 ${k} 份：${x.ym} 里混进了别的月`)
      if (new Set(secs.map((x) => x.ym)).size !== secs.length) expect.fail(`第 ${k} 份：同一个月出现了两节`)
      const flows = txs.filter(isFlow)
      const want = [flows.filter((t) => t.type === 'expense'), flows.filter((t) => t.type === 'income')].map((a) => a.reduce((n, t) => n + t.amount, 0))
      const got = [secs.reduce((n, x) => n + x.expense, 0), secs.reduce((n, x) => n + x.income, 0)]
      if (got[0] !== want[0] || got[1] !== want[1]) expect.fail(`第 ${k} 份：各节合计 ${got} ≠ 列表 ${want}`)
    }
  })
})

describe('流水页：从别的页跳进来看哪一段', () => {
  it('首页点「今日开支」（只带 date）→ 全部、定位到今天；统计页 / 进阶分析（带 ym）→ 那个月；什么都没带 → 不动', () => {
    // 变异：只带 date 时还按 monthOf(date) 选那个月（改前的行为）→ 红
    expect(ymFromQuery(null, '2026-10-01')).toBe(ALL_MONTHS)
    expect(ymFromQuery('2026-09', '2026-09-12')).toBe('2026-09')
    expect(ymFromQuery('2026-08', null)).toBe('2026-08')
    expect(ymFromQuery(null, null)).toBeNull()
  })
})

describe('流水页：全部模式一次先画一批', () => {
  const days = Array.from({ length: 200 }, (_, i) => ({ date: addDays('2026-10-01', -i), items: [], expense: 0, income: 0 }))

  it('先画 PAGE_DAYS 天，翻到底再加；记录不够就全画', () => {
    expect(daysToShow(days, PAGE_DAYS, null)).toBe(PAGE_DAYS)
    expect(daysToShow(days, PAGE_DAYS * 2, null)).toBe(PAGE_DAYS * 2)
    expect(daysToShow(days.slice(0, 7), PAGE_DAYS, null)).toBe(7)
  })

  it('要定位的那天在第一批之外（比如 120 天前）→ 画到它再往后多 10 天，能滚过去；找不到那天就照常', () => {
    // 变异：不管 target → 那天没画出来，滚不过去、只弹「没有记录」，红
    const target = days[120].date
    expect(daysToShow(days, PAGE_DAYS, target)).toBe(131)
    expect(daysToShow(days, PAGE_DAYS, days[5].date)).toBe(PAGE_DAYS)
    expect(daysToShow(days, PAGE_DAYS, '1999-01-01')).toBe(PAGE_DAYS)
  })
})

describe('流水页源码：默认全部', () => {
  const src = readFileSync(new URL('../pages/Ledger.tsx', import.meta.url), 'utf8')
  it('打开默认看全部（不是本月）；再点一下「流水」也回到全部；月份选择器开着「全部月份」', () => {
    // 变异：useRecentState 的默认改回 monthOf(today()) → 红
    // 变异：useTabReset 里改回 setYm(monthOf(today())) → 红
    expect(src).toMatch(/useRecentState\('jz_ledger_ym', \(\) => ymFromQuery\(params\.get\('ym'\), params\.get\('date'\)\) \?\? ALL_MONTHS\)/)
    expect(src).toMatch(/useTabReset\(\(\) => \{\s*setYm\(ALL_MONTHS\)/)
    expect(src).toMatch(/<MonthPicker\s+allowAll/)
    expect(src).not.toMatch(/monthOf\(today\(\)\)/)
  })
})
