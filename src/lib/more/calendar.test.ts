/// <reference types="node" />
// 消费日历。输入一律是「用户记了这些账，今天几号，打开看到什么」。
// 每条用例都先把实现改坏跑过一次，确认它会红（注释里的「变异：… → 红」）。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Category, Transaction } from '../../types'
import { monthSummary } from '../compute'
import { lastMonths, monthRange } from '../date'
import { CHART } from '../palette'
import { calendar, CALENDAR_MONTHS, monthLabels } from './calendar'
import type { MoreChart, MoreInput } from './types'

const CATS: Category[] = [
  { id: 'food', kind: 'expense', parent_id: null, name: '日常餐饮', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'lunch', kind: 'expense', parent_id: 'food', name: '午餐', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount' | 'date'>): Transaction {
  seq++
  return {
    id: `c${seq}`,
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
const spend = (date: string, yuan: number) => tx({ type: 'expense', amount: Math.round(yuan * 100), date, category_id: 'lunch' })

function open(txs: Transaction[], ym = '2026-09', today = '2026-09-28', chartWidth?: number): MoreChart {
  const inp: MoreInput = { txs, accounts: [], cats: CATS, ym, start: `${ym}-01`, end: monthRange(ym).end, today }
  return calendar(inp, chartWidth)
}

// option 是 object，测试里按 ECharts 的形状读
type Opt = {
  calendar: { range: [string, string]; monthLabel: { formatter: (p: { yyyy: number; MM: number }) => string } }
  visualMap: { max: number; inRange: { color: string[] } }
  series: { data: [string, number][] }[]
  tooltip: { formatter: (p: { data?: [string, number] }) => string }
}
const opt = (c: MoreChart) => c.option as unknown as Opt
const cells = (c: MoreChart) => opt(c).series[0].data
const cellOf = (c: MoreChart, d: string) => cells(c).find(([x]) => x === d)?.[1]

describe('消费日历', () => {
  it('今天 9/28 看 9 月：日历从去年 10/1 画到今年 9/30，整整 12 个月', () => {
    // 变异：起点改成 shiftMonth(ym, -CALENDAR_MONTHS)（多画一个月）→ 红
    const c = open([spend('2026-09-03', 20)])
    expect(c.key).toBe('calendar')
    expect(c.title).toBe('消费日历')
    expect(opt(c).calendar.range).toEqual(['2025-10-01', '2026-09-30'])
    // 不看时间段按钮，标题旁写清楚是哪 12 个月
    expect(c.span).toBe('25.10–26.9')
  })

  it('月份标签年份永远带着：每一个都是「25.11」「26.1」这样，没有「11月」「3月」', () => {
    // 变异：formatter 退回「第一个月和 1 月带年份、其余写 M月」（改前的写法）→ 红
    const lab = opt(open([spend('2026-09-03', 20)], '2026-09', '2026-09-28', 900)).calendar.monthLabel.formatter
    const texts = Array.from({ length: 12 }, (_, i) => {
      const m = ((9 + i) % 12) + 1 // 10, 11, 12, 1, … 9
      return lab({ yyyy: m >= 10 ? 2025 : 2026, MM: m })
    })
    // 900 宽（平板）装得下，12 个全标
    expect(texts).toEqual(['25.10', '25.11', '25.12', '26.1', '26.2', '26.3', '26.4', '26.5', '26.6', '26.7', '26.8', '26.9'])
  })

  it('375 宽的手机（图宽 311）：装不下 12 个，隔月标，选中的 9 月一定标着；标出来的个个带年份', () => {
    // ChartMore.test.ts 用 SSR 真画出来量过它们不叠在一起，这里只看标哪几个
    // 变异：降密度那几级去掉（永远全标）→ 12 个全标，红
    // 变异：隔月从最早的那个月数起（不从选中的月份往前数）→ 9 月没标，红
    const ls = monthLabels('2026-09', 311)
    const shown = ls.filter((l) => l.show).map((l) => l.text)
    expect(shown).toEqual(['25.11', '26.1', '26.3', '26.5', '26.7', '26.9'])
    const lab = opt(open([spend('2026-09-03', 20)], '2026-09', '2026-09-28', 311)).calendar.monthLabel.formatter
    expect(lab({ yyyy: 2025, MM: 10 })).toBe('')
    expect(lab({ yyyy: 2025, MM: 11 })).toBe('25.11')
    // 换一个月看：选中的 2 月照样标着
    expect(monthLabels('2026-02', 311).filter((l) => l.show).map((l) => l.text).at(-1)).toBe('26.2')
  })

  it('一天记了午饭和奶茶，格子里是两笔之和；同一天还白条、校准、发工资都不算', () => {
    // 变异：去掉 `t.type !== 'expense' ||`（什么类型都加进去）→ 红
    const c = open([
      spend('2026-09-12', 35),
      spend('2026-09-12', 12.5),
      tx({ type: 'transfer', amount: 200000, date: '2026-09-12', to_account_id: 'jd' }),
      tx({ type: 'adjust', amount: -5000, date: '2026-09-12' }),
      tx({ type: 'income', amount: 800000, date: '2026-09-12', category_id: 'salary' }),
      tx({ type: 'income', amount: 300000, date: '2026-09-13', category_id: 'salary' }),
    ])
    expect(cellOf(c, '2026-09-12')).toBe(47.5)
    // 只有收入的那天不出格子（空着），不是一个 0 元的浅色格子
    expect(cellOf(c, '2026-09-13')).toBeUndefined()
    expect(cells(c)).toHaveLength(1)
  })

  it('窗口两端：去年 9/30 那笔不在，10/1 那笔在；记在下个月的预支不在', () => {
    // 变异：去掉 `|| t.date > end` → 红（10/1 那笔预支混进来）
    const c = open([spend('2025-09-30', 1), spend('2025-10-01', 2), spend('2026-09-30', 3), spend('2026-10-01', 4)])
    expect(cells(c).map(([d]) => d)).toEqual(['2025-10-01', '2026-09-30'])
  })

  it('不变量：格子加起来 ≡ 这 12 个月每月「本月支出」之和（随机账本，换哪个月看都成立）', () => {
    // 变异：calendarRange 的起点改成 -(CALENDAR_MONTHS) → 红
    let s = 20260928
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
    const TYPES = ['expense', 'expense', 'income', 'transfer', 'adjust'] as const
    for (let k = 0; k < 60; k++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 80; i++) {
        const y = 2025 + Math.floor(rnd() * 2)
        const m = 1 + Math.floor(rnd() * 12)
        const d = 1 + Math.floor(rnd() * 28)
        const type = TYPES[Math.floor(rnd() * TYPES.length)]
        txs.push(tx({ type, amount: 1 + Math.floor(rnd() * 50000), date: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` }))
      }
      const ym = `2026-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}`
      const c = open(txs, ym, `${ym}-15`)
      const want = lastMonths(CALENDAR_MONTHS, ym).reduce((t, m) => t + monthSummary(txs, m).expense, 0)
      if (want === 0) {
        if (c.option !== null) expect.fail(`${ym} 没支出却画了图`)
        continue
      }
      const got = cells(c).reduce((t, [, v]) => t + Math.round(v * 100), 0)
      if (got !== want) expect.fail(`第 ${k} 份账本看 ${ym}：格子合计 ${got} ≠ 12 个月支出 ${want}`)
      const ds = cells(c).map(([d]) => d)
      if (new Set(ds).size !== ds.length) expect.fail('同一天出了两个格子')
    }
  })

  it('这 12 个月一笔支出都没有（只有收入、转账，或者支出都在一年多以前）→ 显示一句话，不画图', () => {
    // 变异：删掉 `if (!days.length) return … empty` → 红
    const c = open([
      tx({ type: 'income', amount: 100000, date: '2026-09-01', category_id: 'salary' }),
      tx({ type: 'transfer', amount: 5000, date: '2026-09-02', to_account_id: 'wx' }),
      spend('2025-09-15', 99),
    ])
    expect(c.option).toBeNull()
    expect(c.empty).toBeTruthy()
  })

  it('点去年 12/31 那一格 → 跳到 2025 年 12 月那天的流水，不是跳到选中的 9 月', () => {
    // 变异：onPoint 里 `ym=${monthOf(d)}` 改成 `ym=${inp.ym}` → 红
    const c = open([spend('2025-12-31', 50), spend('2026-09-12', 10)])
    const i = cells(c).findIndex(([d]) => d === '2025-12-31')
    const j = cells(c).findIndex(([d]) => d === '2026-09-12')
    // cat=all：流水页收到 cat 才重设筛选，上次留下的分类筛选会把那天别的支出筛掉
    // 变异：去掉 &cat=all（改前的写法）→ 红
    expect(c.onPoint!(i, 0)).toBe('ym=2025-12&date=2025-12-31&cat=all')
    expect(c.onPoint!(j, 0)).toBe('ym=2026-09&date=2026-09-12&cat=all')
    expect(c.onPoint!(99, 0)).toBeNull()
    expect(opt(c).tooltip.formatter({ data: cells(c)[i] })).toContain('12月31日')
  })

  it('一年交一次 3000 的房租，其余每天几十块：颜色上限不被房租拉到 3000，平常日子还分得出深浅', () => {
    // 变异：colorCap 直接返回最大值 → 红
    const txs = [spend('2026-09-01', 3000)]
    for (let d = 2; d <= 28; d++) txs.push(spend(`2026-08-${String(d).padStart(2, '0')}`, 20 + d))
    for (let d = 2; d <= 28; d++) txs.push(spend(`2026-07-${String(d).padStart(2, '0')}`, 20 + d))
    const c = open(txs)
    expect(opt(c).visualMap.max).toBeLessThan(3000)
    expect(opt(c).visualMap.max).toBeGreaterThanOrEqual(48)
  })

  it('颜色从浅到支出红：深的那一端就是 palette.CHART 的支出色', () => {
    // 变异：inRange 最后一个颜色换成 CHART.balance → 红
    const c = open([spend('2026-09-12', 10)])
    const cs = opt(c).visualMap.inRange.color
    expect(cs[cs.length - 1]).toBe(CHART.expense)
    expect(cs[0]).toMatch(/^#[0-9a-f]{6}$/)
    expect(cs[0]).not.toBe(CHART.expense)
  })

  it('源码守卫：不写死颜色、不看 hidden、不碰 store / api / facade', () => {
    // 变异：往 calendar.ts 里加一行 `const X = '#c95a4e'` → 红；格子边框写成 3 位的 '#fff' → 红
    const src = readFileSync(new URL('./calendar.ts', import.meta.url), 'utf8')
    expect(src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([])
    expect(src).not.toMatch(/\.hidden\b/)
    expect(src).not.toMatch(/from '\.\.\/(store|api|supabase|facade)'/)
  })
})
