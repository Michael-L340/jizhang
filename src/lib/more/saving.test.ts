/// <reference types="node" />
// 储蓄率 12 个月。输入一律是「用户记了这些账，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { lastMonths, monthRange } from '../date'
import { CHART } from '../palette'
import { overallRate, RATE_FLOOR, saving, savingRows } from './saving'
import type { MoreChart, MoreInput } from './types'

const CATS: Category[] = [
  { id: 'lunch', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'refund', kind: 'income', parent_id: null, name: '退款', icon: null, sort: 2, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `s${seq}`,
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
const Y = (yuan: number) => Math.round(yuan * 100)
const spend = (date: string, yuan: number) => tx({ type: 'expense', amount: Y(yuan), date, category_id: 'lunch' })
const earn = (date: string, yuan: number, cat = 'salary') => tx({ type: 'income', amount: Y(yuan), date, category_id: cat })

const open = (txs: Transaction[], ym = '2026-09'): MoreChart => {
  const inp: MoreInput = { txs, accounts: [], cats: CATS, ym, start: `${ym}-01`, end: monthRange(ym).end, today: '2026-09-28' }
  return saving(inp)
}

type Point = number | null | { value: number; symbol?: string; itemStyle?: { color: string } }
type Opt = {
  xAxis: { data: string[] }
  series: { data: Point[]; connectNulls: boolean; color: string }[]
  tooltip: { formatter: (ps: { dataIndex: number }[]) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
/** 图上画在哪个高度（染了色的点是对象，其余是数） */
const at = (p: Point) => (p !== null && typeof p === 'object' ? p.value : p)

/**
 * 看 9 月，窗口是 2025-10 → 2026-09。
 * 9 月：工资 5000、花 3000 → 40%（另有转账、校准，不算）
 * 8 月：工资 4000、花 5000 → -25%
 * 7 月：没收入、花 200 → 算不出（断开）
 * 6 月：只进了一笔 10 块退款、花 2000 → -19900%（画在 -100% 那条线上）
 * 2025-10：工资 1000、没花 → 100%
 * 2025-09（窗口外）：工资 99999
 */
const BOOK: Transaction[] = [
  earn('2026-09-10', 5000),
  spend('2026-09-12', 3000),
  tx({ type: 'transfer', amount: Y(1000), date: '2026-09-17', to_account_id: 'jd' }),
  tx({ type: 'adjust', amount: Y(500), date: '2026-09-18' }),
  earn('2026-08-10', 4000),
  spend('2026-08-12', 5000),
  spend('2026-07-12', 200),
  earn('2026-06-03', 10, 'refund'),
  spend('2026-06-05', 2000),
  earn('2025-10-10', 1000),
  earn('2025-09-10', 99999),
]

describe('储蓄率 12 个月', () => {
  it('看 9 月：2025 年 10 月到今年 9 月每月一个点；9 月 40%、8 月 -25%，还白条和校准不算', () => {
    // 变异：窗口写成 lastMonths(13, ym) → 红
    const c = open(BOOK)
    expect(c.key).toBe('saving')
    // 变异：span 写成 monthSpan(inp.ym, inp.ym)（只写所选月）→ 红
    expect(c.title).toBe('储蓄率 12 个月')
    expect(c.span).toBe('25.10–26.9')
    const d = opt(c).series[0].data.map(at)
    expect(d).toHaveLength(12)
    expect(d[11]).toBe(40)
    expect(d[10]).toBe(-25)
    expect(d[0]).toBe(100)
    // x 轴年份带着
    expect(opt(c).xAxis.data[0]).toBe('25.10')
  })

  it('7 月没收入：那个月是断点，不连过去，也不画成 0%', () => {
    // 变异：没收入的月份画成 0（`return null` → `return 0`）→ 红
    const c = open(BOOK)
    expect(opt(c).series[0].data[9]).toBeNull()
    expect(opt(c).series[0].connectNulls).toBe(false)
    expect(opt(c).tooltip.formatter([{ dataIndex: 9 }])).toContain('没有收入')
  })

  it('6 月只进了一笔 10 块退款、花了 2000：点画在 -100% 那条线上（朝下的三角），提示框里是真实的 -19900%', () => {
    // 变异：去掉 RATE_FLOOR 封底（`if (v < RATE_FLOOR) return …` 那行删掉）→ 红
    const c = open(BOOK)
    const p = opt(c).series[0].data[8] as { value: number; symbol: string }
    expect(RATE_FLOOR).toBe(-100)
    expect(p.value).toBe(-100)
    expect(p.symbol).toBe('triangle')
    expect(opt(c).tooltip.formatter([{ dataIndex: 8 }])).toContain('-19900%')
  })

  it('小方块：「9月储蓄率 40%」；「12 个月平均」按钱算（总结余 ÷ 总收入 = -2%），不被那个退款月拉到负几千', () => {
    // 变异：overallRate 改成各月储蓄率直接平均 → 红
    const c = open(BOOK)
    expect(c.tiles).toEqual([
      { label: '9月储蓄率', value: '40%' },
      { label: '12 个月平均', value: '-2%' },
    ])
  })

  it('9/5 打开、这个月工资还没发（只花了 300）：「9月储蓄率」是「—」，不是 0%；那个点断开', () => {
    // 变异：小方块写成 pct(cur.rate ?? 0) → 「0%」→ 红
    const c = open([...BOOK.filter((t) => !t.date.startsWith('2026-09')), spend('2026-09-03', 300)])
    expect(c.tiles![0]).toEqual({ label: '9月储蓄率', value: '—' })
    expect(opt(c).series[0].data[11]).toBeNull()
  })

  it('正好 -100%（收入 1000、花 2000）：画成普通的红点，不是封底的三角；低于 -100% 才是三角', () => {
    // 变异：`v < RATE_FLOOR` 改成 `<=` → 正好 -100% 的也成了三角 → 红
    const c = open([earn('2026-09-01', 1000), spend('2026-09-02', 2000)])
    const p = opt(c).series[0].data[11] as { value: number; symbol?: string; itemStyle?: { color: string } }
    expect(p.value).toBe(-100)
    expect(p.symbol).toBeUndefined()
    expect(p.itemStyle?.color).toBe(CHART.expense)
  })

  it('提示框：8 月花超了，结余写「-¥1,000.00」（带负号）', () => {
    // 变异：结余去掉负号 → 「¥1,000.00」→ 红
    const tip = opt(open(BOOK)).tooltip.formatter([{ dataIndex: 10 }])
    expect(tip).toContain('-¥1,000.00')
    expect(tip).toContain('-25%')
  })

  it('点 2025 年 10 月那个点 → 跳到那个月的流水（cat=all 清掉上次的筛选）；点 9 月 → 9 月', () => {
    // 变异：onPoint 下标错一位（keys[dataIndex + 1]）→ 红；不带 cat=all → 红
    const c = open(BOOK)
    expect(c.onPoint!(0, 0)).toBe('ym=2025-10&cat=all')
    expect(c.onPoint!(11, 0)).toBe('ym=2026-09&cat=all')
    expect(c.onPoint!(12, 0)).toBeNull()
  })

  it('12 个月一分收入都没有（只记了支出）→ 显示一句话，不画图', () => {
    // 变异：删掉 empty 分支 → 红
    const c = open([spend('2026-09-01', 30), spend('2026-03-01', 40), earn('2025-09-30', 5000)])
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
  })

  it('线是收入绿；花超了的月份（8 月 -25%、6 月封底那个）点是支出红，存下钱的月份不染（颜色都来自 palette.CHART）', () => {
    // 变异：负数点不染色（`v < 0 ? { value: v, itemStyle: red } : v` → `v`）→ 红
    const c = open(BOOK)
    const s0 = opt(c).series[0]
    expect(s0.color).toBe(CHART.income)
    const colorAt = (i: number) => (s0.data[i] as { itemStyle?: { color: string } } | number | null)
    expect((colorAt(10) as { itemStyle: { color: string } }).itemStyle.color).toBe(CHART.expense)
    expect((colorAt(8) as { itemStyle: { color: string } }).itemStyle.color).toBe(CHART.expense)
    expect(colorAt(11)).toBe(40)
  })

  it('不变量（随机账本）：图上每个点 ≡ 自己按 t.type 算的储蓄率（null ⇔ 没收入；否则 max(-100, 一位小数)、负的染红、低于 -100 才是三角）；12 个月平均 ≡ Σ结余 ÷ Σ收入', () => {
    // 收入、支出自己按 t.type 加，不调 monthSummary——savingRows 本身就是调它，拿它对账等于让实现给自己判卷。
    // 变异：overallRate 不扣没收入月份的支出（只加 income > 0 的月）→ 红
    // 变异：点的取整写成 Math.round(r.rate * 100)（整数）→ 12.3% 画成 12，红
    // 变异：savingRows 的收入把转账也算进去 → 红
    let s = 2026
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 200; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 40; i++) {
        const m = String(1 + Math.floor(rnd() * 12)).padStart(2, '0')
        const y = 2025 + Math.floor(rnd() * 2)
        txs.push(tx({ type: TYPES[Math.floor(rnd() * TYPES.length)], amount: 1 + Math.floor(rnd() * 400000), date: `${y}-${m}-15` }))
      }
      const ym = `2026-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}`
      const c = open(txs, ym)
      const months = lastMonths(12, ym)
      const sumOf = (type: string, m: string) => txs.filter((t) => t.type === type && t.date.startsWith(m)).reduce((a, t) => a + t.amount, 0)
      let inc = 0
      let exp = 0
      const pts = c.option ? opt(c).series[0].data : null
      months.forEach((m, i) => {
        const mi = sumOf('income', m)
        const me = sumOf('expense', m)
        inc += mi
        exp += me
        if (!pts) return
        const p = pts[i]
        if (mi === 0) {
          if (p !== null) expect.fail(`第 ${k} 份 ${m}：没收入却画了点`)
          return
        }
        const v = Math.round(((mi - me) / mi) * 1000) / 10
        const want = Math.max(RATE_FLOOR, v)
        if (at(p) !== want) expect.fail(`第 ${k} 份 ${m}：点在 ${at(p)}，应为 ${want}`)
        const o = typeof p === 'object' && p !== null ? p : null
        if ((v < 0) !== (o?.itemStyle?.color === CHART.expense)) expect.fail(`第 ${k} 份 ${m}：${v}% 的染色不对`)
        if ((v < RATE_FLOOR) !== (o?.symbol === 'triangle')) expect.fail(`第 ${k} 份 ${m}：${v}% 的三角不对`)
      })
      if (!pts && inc > 0) expect.fail(`第 ${k} 份：有收入却没画`)
      const want = inc > 0 ? (inc - exp) / inc : null
      const got = overallRate(savingRows({ txs, ym }))
      if (got === null ? want !== null : want === null || Math.abs(got - want) > 1e-12) expect.fail(`12 个月平均 ${got} ≠ ${want}`)
    }
  })

  it('源码守卫：不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 saving.ts 里加一行 `const X = '#c95a4e'` → 红；轴线色写成 8 位的 '#ece6dd80' → 红
    const src = readFileSync(new URL('./saving.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
