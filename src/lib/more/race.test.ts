/// <reference types="node" />
// 累计支出 vs 上月。输入一律是「用户记了这些账，今天几号，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { monthSummary } from '../compute'
import { addDays, daysInMonth, monthRange, shiftMonth } from '../date'
import { CHART } from '../palette'
import { race, raceLines } from './race'
import type { MoreChart, MoreInput } from './types'

const CATS: Category[] = [
  { id: 'lunch', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `r${seq}`,
    account_id: 'boc',
    to_account_id: null,
    category_id: null,
    note: null,
    installments: null,
    settles: null,
    hidden: null, is_offset: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...p,
  }
}
const spend = (date: string, yuan: number) => tx({ type: 'expense', amount: Math.round(yuan * 100), date, category_id: 'lunch' })

const inputOf = (txs: Transaction[], ym: string, today: string): MoreInput => ({
  txs, accounts: [], cats: CATS, ym, start: `${ym}-01`, end: monthRange(ym).end, today,
})
const open = (txs: Transaction[], ym: string, today: string): MoreChart => race(inputOf(txs, ym, today))

type Series = { name: string; color: string; data: (number | null)[]; lineStyle: { type?: string }; markPoint?: { data: { coord: [string, number] }[] } }
type Opt = { series: Series[]; xAxis: { data: string[] }; tooltip: { formatter: (ps: unknown[]) => string } }
const opt = (c: MoreChart) => c.option as unknown as Opt

/**
 * 一本从 5 月开始记的账。今天 9/12。
 * 9 月：1 号 100、5 号 50、12 号 20，20 号记了一笔预支 999（还没到）；另有同月的还白条、校准、工资。
 * 8 月：1 号 300、31 号 40（9 月只有 30 天，这笔要算进上月线最后一点）
 * 7 月：10 号 600；6 月：15 号 900；5 月：1 号 10
 */
const BOOK: Transaction[] = [
  spend('2026-09-01', 100),
  spend('2026-09-05', 50),
  spend('2026-09-12', 20),
  spend('2026-09-20', 999),
  tx({ type: 'transfer', amount: 500000, date: '2026-09-03', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: -20000, date: '2026-09-04' }),
  tx({ type: 'income', amount: 800000, date: '2026-09-10', category_id: 'salary' }),
  spend('2026-08-01', 300),
  spend('2026-08-31', 40),
  spend('2026-07-10', 600),
  spend('2026-06-15', 900),
  spend('2026-05-01', 10),
]

describe('本月累计 vs 上月', () => {
  it('今天 9/12 看 9 月：9 月那条线画到 12 号（= 170），13 号起空着；还白条、校准、工资不算，20 号那笔预支不画', () => {
    // 变异：当前月也画整月（ref 恒为 monthRange(ym).end）→ 红
    // 变异：自己累计时把转账也算成支出（`t.type !== 'income'`）→ 红
    const c = open(BOOK, '2026-09', '2026-09-12')
    expect(c.key).toBe('race')
    // 变异：标题改回「本月累计 vs 上月」→ 红；base 不带 span → 红
    expect(c.title).toBe('累计支出 vs 上月')
    expect(c.span).toBe('26.9')
    const cur = opt(c).series[0]
    expect(cur.name).toBe('9月')
    expect(cur.data).toHaveLength(30)
    expect(cur.data[0]).toBe(100)
    expect(cur.data[10]).toBe(150)
    expect(cur.data[11]).toBe(170)
    expect(cur.data.slice(12).every((v) => v === null)).toBe(true)
    // 「今天」那一点
    expect(cur.markPoint?.data[0].coord).toEqual(['12', 170])
  })

  it('上月线按几号对齐，最后一点是 8 月整月合计 340——8/31 那笔不能因为 9 月没有 31 号就丢掉', () => {
    // 变异：alignDays 去掉「最后一点放整月合计」（`i === n - 1 ? last :`）→ 红
    const c = open(BOOK, '2026-09', '2026-09-12')
    const prev = opt(c).series.find((s) => s.name === '8月')!
    expect(prev.color).toBe(CHART.label)
    expect(prev.data).toHaveLength(30)
    expect(prev.data[0]).toBe(300)
    expect(prev.data[28]).toBe(300)
    expect(prev.data[29]).toBe(340)
  })

  it('反过来 3 月对 2 月：2 月只有 28 天，29–31 号接着用 2 月的月底合计，线走平', () => {
    // 变异：alignDays 里短月越界取 0（`full[i] ?? 0`，不夹到最后一天）→ 红
    const txs = [spend('2026-01-05', 1), spend('2026-02-03', 10), spend('2026-02-28', 5), spend('2026-03-02', 7)]
    const L = raceLines({ txs, ym: '2026-03', today: '2026-03-20' })
    expect(L.prev).toHaveLength(31)
    expect(L.prev!.slice(27)).toEqual([1500, 1500, 1500, 1500])
  })

  it('均值线 = 往前三个整月（6/7/8 月）同一个几号的平均；月底那一点 = 三个月合计的平均', () => {
    // 变异：往前取的月份写成 [0, 1, 2]（把 9 月自己也算进去）→ 红
    const c = open(BOOK, '2026-09', '2026-09-12')
    const avg = opt(c).series.find((s) => s.name === '近三月平均')!
    expect(avg.lineStyle.type).toBe('dashed')
    // 9 号：6 月 0（15 号才花）、7 月 0（10 号才花）、8 月 300 → 100
    expect(avg.data[8]).toBe(100)
    // 月底：(340 + 600 + 900) / 3 = 613.33
    expect(avg.data[29]).toBe(613.33)
  })

  it('8 月才开始记账，看 9 月：只有 9 月和 8 月两条线，没有均值线（没有「上个月一分没花」的假象）', () => {
    // 变异：均值线门槛从 `back.length >= 2` 改成 `>= 1` → 红
    const txs = [spend('2026-08-03', 30), spend('2026-09-02', 10)]
    const c = open(txs, '2026-09', '2026-09-12')
    expect(opt(c).series.map((s) => s.name)).toEqual(['9月', '8月'])
  })

  it('7 月才开始记账：均值只平均 7、8 两个月，名字叫「近两月平均」', () => {
    // 变异：不管记没记账都往前取三个月（去掉 `.filter(tracked)`）→ 红
    const txs = [spend('2026-07-01', 100), spend('2026-08-01', 300)]
    const c = open(txs, '2026-09', '2026-09-12')
    const avg = opt(c).series.find((s) => s.name === '近两月平均')
    expect(avg).toBeDefined()
    expect(avg!.data[29]).toBe(200)
  })

  it('翻回去看 8 月（今天 9/12）：8 月那条线画满 31 天，没有「今天」标记', () => {
    // 变异：非当前月也截到今天的几号（ref = dayInMonth(ym, 今天的几号)）→ 红
    // 变异：todayIdx 不看是不是当前月（恒为今天的几号 - 1）→ 红
    const c = open(BOOK, '2026-08', '2026-09-12')
    const cur = opt(c).series[0]
    expect(cur.name).toBe('8月')
    expect(cur.data).toHaveLength(31)
    expect(cur.data[30]).toBe(340)
    expect(cur.markPoint).toBeUndefined()
  })

  it('点 12 号 → 9 月 12 号的流水；点 13 号（还没到）→ 不跳；翻回 8 月点 31 号 → 8/31', () => {
    // 变异：去掉 `d > inp.today ? null :` → 红
    const c = open(BOOK, '2026-09', '2026-09-12')
    expect(c.onPoint!(11, 0)).toBe('ym=2026-09&date=2026-09-12&cat=all')
    expect(c.onPoint!(11, 2)).toBe('ym=2026-09&date=2026-09-12&cat=all')
    expect(c.onPoint!(12, 0)).toBeNull()
    expect(c.onPoint!(30, 0)).toBeNull()
    expect(open(BOOK, '2026-08', '2026-09-12').onPoint!(30, 1)).toBe('ym=2026-08&date=2026-08-31&cat=all')
  })

  it('提示框：12 号那一格写着和 8 月同期差多少（9 月 170、8 月 300 → 少 ¥130）', () => {
    // 变异：差额写反（p - c）→ 红
    const c = open(BOOK, '2026-09', '2026-09-12')
    const ps = opt(c).series.map((s, i) => ({ dataIndex: 11, marker: '', seriesName: s.name, value: s.data[11], seriesIndex: i }))
    // 12 号：9 月 170，8 月同期 300 → 少 130
    expect(opt(c).tooltip.formatter(ps)).toContain('比8月同期少')
    expect(opt(c).tooltip.formatter(ps)).toContain('¥130.00')
  })

  it('什么支出都没记（只有工资）→ 显示一句话，不画图', () => {
    // 变异：删掉 empty 分支 → 红
    const c = open([tx({ type: 'income', amount: 100000, date: '2026-09-01', category_id: 'salary' })], '2026-09', '2026-09-12')
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
  })

  it('不变量（随机账本 × 随机今天）：线单调不减；本月线最后一个点 = 到今天为止的支出；上月线最后一点 = 上月整月支出', () => {
    // 变异：alignDays 去掉「最后一点放整月合计」→ 红
    let s = 912
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 200; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 60; i++) {
        const d = addDays('2025-12-01', Math.floor(rnd() * 330))
        txs.push(tx({ type: TYPES[Math.floor(rnd() * TYPES.length)], amount: 1 + Math.floor(rnd() * 30000), date: d }))
      }
      const today = addDays('2026-03-01', Math.floor(rnd() * 200))
      const ym = shiftMonth(today.slice(0, 7), -Math.floor(rnd() * 3))
      const L = raceLines({ txs, ym, today })
      const n = daysInMonth(ym)
      const cur = L.cur.filter((v): v is number => v !== null)
      const ref = ym === today.slice(0, 7) ? today : monthRange(ym).end
      const want = txs.filter((t) => t.type === 'expense' && t.date >= `${ym}-01` && t.date <= ref).reduce((a, t) => a + t.amount, 0)
      if (L.cur.length !== n) expect.fail(`本月线长度 ${L.cur.length} ≠ ${n}`)
      if (cur[cur.length - 1] !== want) expect.fail(`${ym} 今天 ${today}：本月线末点 ${cur[cur.length - 1]} ≠ ${want}`)
      for (const line of [cur, L.prev ?? [], L.avg ?? []]) {
        for (let i = 1; i < line.length; i++) if (line[i] < line[i - 1]) expect.fail('累计线往下走了')
      }
      if (L.prev) {
        if (L.prev.length !== n) expect.fail('上月线长度不对')
        const pm = shiftMonth(ym, -1)
        if (L.prev[n - 1] !== monthSummary(txs, pm).expense) expect.fail(`上月线末点 ${L.prev[n - 1]} ≠ ${pm} 整月支出`)
      }
    }
  })

  it('配色：这个月支出红、上月灰、均值线深焦糖，三条线颜色两两不同（图例只画实线加圆点，颜色一样就对不上）', () => {
    // 变异：均值线退回 CHART.label（改前的写法）→ 和上月线同色，红
    const c = open(BOOK, '2026-09', '2026-09-12')
    const colors = opt(c).series.map((s) => s.color)
    expect(colors).toEqual([CHART.expense, CHART.label, CHART.brandInk])
    expect(new Set(colors).size).toBe(3)
  })

  it('源码不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 race.ts 里加一行 `const X = '#c95a4e'` → 红；写成 3 位的 '#eee' → 红
    const src = readFileSync(new URL('./race.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
