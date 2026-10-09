// 支出大类对比（雷达图）。输入是一份小账本 + 统计页顶上选的月份，
// 断言的是打开那张卡看到的：几条轴、叫什么、两个多边形各落在哪、尺子多长。
// 每条用例注释里的「变异：xxx → 红」都真的跑过。
import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../../types'
import { CHART } from '../palette'
import { RADAR_MIN_AXES, radarChart } from './radar'
import type { MoreInput } from './types'

const C = (id: string, name: string, sort: number, parent_id: string | null = null, over: Partial<Category> = {}): Category => ({
  id, kind: 'expense', parent_id, name, icon: null, sort, is_archived: false, note: null, ...over,
})
const boc: Account = { id: 'boc', name: '中国银行', kind: 'bank', sort: 1, is_archived: false, repay_day: null, defer_after_repay: null, facade_offset: null }

// 故意不按 sort 的顺序建：轴的顺序只能来自 sort
const cats: Category[] = [
  C('fun', '娱乐消费', 4),
  C('food', '日常餐饮', 1),
  C('lunch', '午餐', 1, 'food'),
  C('big', '非经常生活消费', 3),
  C('reg', '经常生活开支', 2),
  C('oops', '意外开支', 5),
  C('old', '旧分类', 6, null, { is_archived: true }),
  C('salary', '工资/实习', 1, null, { kind: 'income' }),
]

let seq = 0
function tx(date: string, type: Transaction['type'], amount: number, category_id: string | null = null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `t${seq}`, date, type, amount, account_id: 'boc', to_account_id: null, category_id, note: null,
    installments: null, settles: null, hidden: null, is_offset: null, created_at: new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(), ...over,
  }
}

const input = (txs: Transaction[], over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts: [boc], cats, ym: '2026-09', start: '2026-09-01', end: '2026-09-30', today: '2026-09-20', ...over,
})

interface RItem { name: string; value: number[]; lineStyle: { color: string; type: string }; itemStyle: { color: string }; areaStyle?: { color: string } }
function view(inp: MoreInput) {
  const ch = radarChart(inp)
  const o = ch.option as {
    radar: { indicator: { name: string; max: number }[] }
    series: { data: RItem[] }[]
    legend: { data: string[] }
    tooltip: { formatter: (p: { name: string; value: number[] }) => string }
  }
  const [prev, cur] = o.series[0].data
  return { ch, axes: o.radar.indicator.map((i) => i.name), max: o.radar.indicator.map((i) => i.max), cur, prev, legend: o.legend.data, tip: o.tooltip.formatter }
}

describe('雷达图：打开看到什么', () => {
  const txs = [
    // 九月（所选月份）
    tx('2026-09-02', 'expense', 3000, 'lunch'), // 二级，算进「日常餐饮」
    tx('2026-09-03', 'expense', 2000, 'food'),
    tx('2026-09-04', 'expense', 45678, 'reg'),
    tx('2026-09-05', 'expense', 9900, 'old'), // 归档的一级：不是轴，钱不在图上
    tx('2026-09-06', 'expense', 1200, null), // 未分类：同上
    tx('2026-09-07', 'transfer', 500000, null, { to_account_id: 'wx' }),
    tx('2026-09-08', 'adjust', 700000, null),
    tx('2026-09-09', 'income', 800000, 'salary'),
    // 八月（上个月）
    tx('2026-08-01', 'expense', 8000, 'fun'),
    tx('2026-08-31', 'expense', 12345, 'oops'),
    // 七月：不在这两个月里
    tx('2026-07-31', 'expense', 999999, 'fun'),
  ]

  it('轴 = 没归档的一级支出分类，按 sort 排，用短名', () => {
    // 变异：去掉 !c.is_archived → 红；轴改按名字排 → 红；轴名用全名 → 红
    expect(view(input(txs)).axes).toEqual(['日常餐饮', '经常', '非经常', '娱乐', '意外'])
  })

  it('本月、上月各一个多边形：二级算进一级；转账 / 校准 / 收入 / 归档 / 未分类 / 别的月都不算', () => {
    // 变异：上个月取 shiftMonth(ym, +1) → 红；byCategory 换成 'income' → 红；二级不往一级上归 → 红
    const v = view(input(txs))
    expect(v.cur.name).toBe('9月')
    expect(v.cur.value).toEqual([5000, 45678, 0, 0, 0])
    expect(v.prev.name).toBe('8月')
    expect(v.prev.value).toEqual([0, 0, 0, 8000, 12345])
    expect(v.legend).toEqual(['9月', '8月'])
  })

  it('几条轴共用一把尺子：两个月里最大的那一类（456.78 元）向上取整到 500 元', () => {
    // 变异：Math.ceil 改成 Math.round（→ 500 不变，但下一条红）；max 按各轴各自算 → 红
    expect(view(input(txs)).max).toEqual([50000, 50000, 50000, 50000, 50000])
  })

  it('取整的边界：正好 1,200.00 元就是 1,200；1,200.01 元是 1,300', () => {
    // 变异：Math.ceil 改成 Math.round → 红（1,200.01 会变 1,200）；改成 floor+1 → 红（1,200 会变 1,300）
    expect(view(input([tx('2026-09-02', 'expense', 120000, 'reg')])).max[0]).toBe(120000)
    expect(view(input([tx('2026-09-02', 'expense', 120001, 'reg')])).max[0]).toBe(130000)
    // 上个月更大时尺子跟着上个月走
    expect(view(input([tx('2026-09-02', 'expense', 100, 'reg'), tx('2026-08-02', 'expense', 30001, 'fun')])).max[0]).toBe(40000)
  })

  it('跨年：选 2026 年 1 月，对比的是 2025 年 12 月', () => {
    // 变异：上个月用 `${year}-${month-1}` 手拼 → 红
    const v = view(input([tx('2026-01-05', 'expense', 100, 'fun'), tx('2025-12-31', 'expense', 200, 'fun')], { ym: '2026-01' }))
    expect(v.cur.name).toBe('1月')
    expect(v.prev.name).toBe('12月')
    expect(v.cur.value[3]).toBe(100)
    expect(v.prev.value[3]).toBe(200)
  })

  it('本月实线填充支出色，上月虚线 muted 不填充', () => {
    // 变异：两边样式对调 → 红；上月也加 areaStyle → 红
    const v = view(input(txs))
    expect(v.cur.lineStyle).toMatchObject({ color: CHART.expense, type: 'solid' })
    expect(v.cur.areaStyle?.color).toBe(CHART.expense)
    expect(v.prev.lineStyle).toMatchObject({ color: CHART.label, type: 'dashed' })
    expect(v.prev.areaStyle).toBeUndefined()
  })

  it('提示框里是全名 + 元', () => {
    // 变异：提示框用短名 → 红；yuan 不带 symbol → 红
    const v = view(input(txs))
    const s = v.tip({ name: v.cur.name, value: v.cur.value })
    expect(s).toContain('9月')
    expect(s).toContain('经常生活开支')
    expect(s).toContain('¥456.78')
  })
})

describe('雷达图：什么时候不画', () => {
  it('两个月都是 0 → 空状态（只有转账、收入、归档分类的钱也算 0）', () => {
    // 变异：只看本月是不是 0 → 不红；去掉 top<=0 判断 → 红
    const ch = radarChart(input([tx('2026-09-02', 'transfer', 100, null, { to_account_id: 'wx' }), tx('2026-09-03', 'expense', 100, 'old'), tx('2026-07-01', 'expense', 100, 'fun')]))
    expect(ch.option).toBeNull()
    expect(ch.empty).toBeTruthy()
    expect(ch.key).toBe('radar')
    // 变异：TITLE 改回「五大类：本月 vs 上月」→ 红；base 不带 span → 红
    expect(ch.title).toBe('支出大类对比')
    expect(ch.span).toBe('26.9')
  })

  it('本月 0、上月有 → 照样画（「这个月还没花」本身就是信息）', () => {
    // 变异：空判断改成只看本月 cur 全 0 → 红
    const ch = radarChart(input([tx('2026-08-02', 'expense', 100, 'fun')]))
    expect(ch.option).not.toBeNull()
    expect(ch.empty).toBeUndefined()
  })

  it(`没归档的一级支出分类不到 ${RADAR_MIN_AXES} 个 → 空状态`, () => {
    // 变异：RADAR_MIN_AXES 判断去掉 → 红
    const two = [C('a', '日常餐饮', 1), C('b', '娱乐消费', 2), C('c', '意外开支', 3, null, { is_archived: true })]
    const ch = radarChart({ ...input([tx('2026-09-02', 'expense', 100, 'a')]), cats: two })
    expect(ch.option).toBeNull()
    expect(ch.empty).toBeTruthy()
  })
})

describe('雷达图：不变量', () => {
  it('每条轴上的数 ≡ 这一类（含它的二级）当月支出；没有哪个点越过尺子', () => {
    // 变异：二级不往一级上归（只数直接记在一级上的）→ 红
    const kids = [...cats, C('dinner', '晚餐', 2, 'food'), C('game', '游戏', 1, 'fun')]
    const ids = ['food', 'lunch', 'dinner', 'reg', 'big', 'fun', 'game', 'oops', 'old', null]
    let s = 7
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0), s / 4294967296)
    for (let round = 0; round < 100; round++) {
      const txs: Transaction[] = []
      for (let i = 0; i < 40; i++) {
        const m = r() < 0.5 ? '2026-09' : r() < 0.7 ? '2026-08' : '2026-07'
        txs.push(tx(`${m}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`, r() < 0.8 ? 'expense' : 'transfer', 1 + Math.floor(r() * 90000), ids[Math.floor(r() * ids.length)]))
      }
      const inp = { ...input(txs), cats: kids }
      const ch = radarChart(inp)
      if (!ch.option) continue
      const v = view(inp)
      const rootOf = (id: string | null) => (id === 'lunch' || id === 'dinner' ? 'food' : id === 'game' ? 'fun' : id)
      const axisIds = ['food', 'reg', 'big', 'fun', 'oops']
      for (const [ym, poly] of [['2026-09', v.cur], ['2026-08', v.prev]] as const) {
        const want = axisIds.map((a) => txs.filter((t) => t.type === 'expense' && t.date.startsWith(ym) && rootOf(t.category_id) === a).reduce((x, t) => x + t.amount, 0))
        if (JSON.stringify(poly.value) !== JSON.stringify(want)) expect.fail(`round ${round} ${ym}: ${poly.value} ≠ ${want}`)
        if (poly.value.some((x) => x > v.max[0])) expect.fail(`round ${round}: 有点越过了尺子 ${v.max[0]}`)
      }
      if (v.max[0] % 10000 !== 0) expect.fail(`round ${round}: 尺子 ${v.max[0]} 不是整百元`)
      if (v.max[0] - Math.max(...v.cur.value, ...v.prev.value) >= 10000) expect.fail(`round ${round}: 尺子留了超过 100 元的空`)
    }
  })
})
