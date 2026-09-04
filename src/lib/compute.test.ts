import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../types'
import { adjustTotal, balanceSeries, balances, bucketKeys, byCategory, dailyCumulative, firstFlowDate, groupByDay, isVerifiedAdjust, monthSummary, monthTotals, monthlySeries, OPENING_NOTE, openingAdjustIds, recentChildOrder, seriesByCategory, seriesTotals, sortTxs, totalOf, VERIFIED_MARK, withVerified, withoutVerified } from './compute'
import { addDays, daysInMonth, lastMonths, monthRange, shiftMonth, today } from './date'
import { centsFromDb, centsToDb, fmtYuan, parseYuan } from './money'

const accounts: Account[] = [
  { id: 'boc', name: '中国银行', kind: 'bank', sort: 1, is_archived: false },
  { id: 'cmb', name: '招商银行', kind: 'bank', sort: 2, is_archived: false },
  { id: 'wx', name: '微信', kind: 'wallet', sort: 4, is_archived: false },
]
const cats: Category[] = [
  { id: 'food', kind: 'expense', parent_id: null, name: '日常餐饮', icon: '🍚', sort: 1, is_archived: false, note: null },
  { id: 'lunch', kind: 'expense', parent_id: 'food', name: '午餐', icon: null, sort: 2, is_archived: false, note: null },
  { id: 'dinner', kind: 'expense', parent_id: 'food', name: '晚餐', icon: null, sort: 3, is_archived: false, note: null },
  { id: 'fun', kind: 'expense', parent_id: null, name: '娱乐消费', icon: '🎮', sort: 2, is_archived: false, note: null },
  { id: 'game', kind: 'expense', parent_id: 'fun', name: '游戏充值', icon: null, sort: 1, is_archived: false, note: null },
  { id: 'salary', kind: 'income', parent_id: null, name: '工资/实习', icon: null, sort: 1, is_archived: false, note: null },
]

let seq = 0
function tx(p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount'> & { account_id: string | null }): Transaction {
  seq++
  return {
    id: `t${seq}`,
    date: '2026-09-03',
    to_account_id: null,
    category_id: null,
    note: null,
    created_at: new Date(Date.UTC(2026, 8, 3, 0, 0, seq)).toISOString(), // 严格递增，不能用 seq % 10 那种会回绕的写法
    ...p,
  }
}

describe('money', () => {
  it('parses yuan to cents', () => {
    expect(parseYuan('12.5')).toBe(1250)
    expect(parseYuan('0.1')).toBe(10)
    expect(parseYuan('1,234.56')).toBe(123456)
    expect(parseYuan('-3')).toBe(-300)
    expect(parseYuan('')).toBeNull()
    expect(parseYuan('1.234')).toBeNull()
    expect(parseYuan('abc')).toBeNull()
  })
  it('round-trips db numeric without float drift', () => {
    expect(centsFromDb(0.1 + 0.2)).toBe(30)
    expect(centsFromDb('1234.56')).toBe(123456)
    expect(centsToDb(123456)).toBe('1234.56')
    expect(centsToDb(-5)).toBe('-0.05')
    expect(centsToDb(0)).toBe('0.00')
  })
  it('formats', () => {
    expect(fmtYuan(123456)).toBe('1,234.56')
    expect(fmtYuan(-500, { symbol: true })).toBe('-¥5.00')
    expect(fmtYuan(500, { sign: true })).toBe('+5.00')
  })
})

describe('date', () => {
  it('today is Beijing date even at UTC late evening', () => {
    // 2026-09-03 16:30 UTC = 2026-09-04 00:30 北京
    expect(today(new Date('2026-09-03T16:30:00Z'))).toBe('2026-09-04')
    expect(today(new Date('2026-09-03T15:59:00Z'))).toBe('2026-09-03')
  })
  it('month helpers', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
    expect(daysInMonth('2026-02')).toBe(28)
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(lastMonths(3, '2026-01')).toEqual(['2025-11', '2025-12', '2026-01'])
  })
})

describe('balances', () => {
  it('applies income/expense/transfer/adjust correctly', () => {
    const txs = [
      tx({ type: 'income', amount: 1300000, account_id: 'cmb', category_id: 'salary' }),
      tx({ type: 'expense', amount: 2800, account_id: 'wx', category_id: 'lunch' }),
      tx({ type: 'transfer', amount: 300000, account_id: 'cmb', to_account_id: 'wx' }),
      tx({ type: 'adjust', amount: 50000, account_id: 'boc' }),
      tx({ type: 'adjust', amount: -1200, account_id: 'wx' }),
    ]
    const b = balances(txs, accounts)
    expect(b.cmb).toBe(1000000)
    expect(b.wx).toBe(300000 - 2800 - 1200)
    expect(b.boc).toBe(50000)
    expect(totalOf(b)).toBe(1000000 + 296000 + 50000)
  })

  it('ignores transactions without an account', () => {
    const txs = [
      tx({ type: 'adjust', amount: 100000, account_id: 'boc' }),
      tx({ type: 'expense', amount: 87150, account_id: null, category_id: 'lunch' }),
    ]
    const b = balances(txs, accounts)
    expect(b.boc).toBe(100000)
    expect(totalOf(b)).toBe(100000)
    expect(monthSummary(txs, '2026-09').expense).toBe(87150)
  })

  it('user example: 中国银行 1000 → real 1500 makes +500 adjust, total 2000 → 2500', () => {
    const txs = [
      tx({ type: 'adjust', amount: 100000, account_id: 'boc' }),
      tx({ type: 'adjust', amount: 100000, account_id: 'cmb' }),
    ]
    const before = balances(txs, accounts)
    expect(totalOf(before)).toBe(200000)
    const delta = 150000 - before.boc
    expect(delta).toBe(50000)
    const after = balances([...txs, tx({ type: 'adjust', amount: delta, account_id: 'boc' })], accounts)
    expect(after.boc).toBe(150000)
    expect(totalOf(after)).toBe(250000)
  })
})

describe('month stats exclude transfer and adjust', () => {
  const txs = [
    tx({ type: 'expense', amount: 2800, account_id: 'wx', category_id: 'lunch' }),
    tx({ type: 'expense', amount: 6480, account_id: 'wx', category_id: 'game' }),
    tx({ type: 'income', amount: 1300000, account_id: 'cmb', category_id: 'salary' }),
    tx({ type: 'transfer', amount: 300000, account_id: 'cmb', to_account_id: 'wx' }),
    tx({ type: 'adjust', amount: -99999, account_id: 'wx' }),
    tx({ type: 'expense', amount: 100, account_id: 'wx', category_id: 'lunch', date: '2026-08-31' }),
  ]
  it('monthSummary', () => {
    const s = monthSummary(txs, '2026-09')
    expect(s.expense).toBe(9280)
    expect(s.income).toBe(1300000)
    expect(s.net).toBe(1300000 - 9280)
    expect(s.savingRate).toBeCloseTo((1300000 - 9280) / 1300000)
    expect(monthSummary(txs, '2026-07').savingRate).toBeNull()
  })
  it('byCategory groups into parents with children', () => {
    const agg = byCategory(txs, cats, '2026-09', 'expense')
    expect(agg.map((a) => a.name)).toEqual(['娱乐消费', '日常餐饮'])
    expect(agg[1].amount).toBe(2800)
    expect(agg[1].children[0]).toMatchObject({ name: '午餐', amount: 2800 })
    expect(agg.reduce((s, a) => s + a.amount, 0)).toBe(monthSummary(txs, '2026-09').expense)
  })
  it('keeps parent-level spending visible as 未细分 when drilling', () => {
    const mixed = [
      tx({ type: 'expense', amount: 53800, account_id: null, category_id: 'food' }), // 直接记在一级
      tx({ type: 'expense', amount: 8990, account_id: 'wx', category_id: 'lunch' }), // 记在二级
    ]
    const agg = byCategory(mixed, cats, '2026-09', 'expense')
    expect(agg).toHaveLength(1)
    expect(agg[0].amount).toBe(62790)
    expect(agg[0].count).toBe(2)
    // 二级合计必须等于一级合计，否则下钻时会漏钱
    expect(agg[0].children.reduce((s, c) => s + c.amount, 0)).toBe(agg[0].amount)
    expect(agg[0].children.map((c) => c.name).sort()).toEqual(['未细分', '午餐'].sort())
  })

  it('adjustTotal reports unrecorded delta', () => {
    expect(adjustTotal(txs, '2026-09')).toBe(-99999)
  })

  describe('adjustTotal 排除开户时录的初始余额', () => {
    // 一条校准记的是「实际 − 推算」。账户还没有任何记录时推算是 0，
    // 差额就等于本金 —— 那不是漏记，不能算进「未记录差额」。
    it('账户的第一条记录就是校准时，那是本金不是漏记', () => {
      const open = [tx({ type: 'adjust', amount: 1500000, account_id: 'boc' })]
      expect(adjustTotal(open)).toBe(0)
    })

    it('备注写了「初始余额」的一律排除', () => {
      const rows = [
        tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch' }),
        tx({ type: 'adjust', amount: 1500000, account_id: 'boc', note: OPENING_NOTE }),
      ]
      expect(adjustTotal(rows)).toBe(0)
    })

    it('已经有记录之后再做的校准，仍然算漏记差额', () => {
      const rows = [
        tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch' }),
        tx({ type: 'adjust', amount: -5000, account_id: 'boc' }),
      ]
      expect(adjustTotal(rows)).toBe(-5000)
    })

    it('开户那笔排除，之后的校准照常统计', () => {
      const rows = [
        tx({ type: 'adjust', amount: 1500000, account_id: 'boc' }),
        tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch' }),
        tx({ type: 'adjust', amount: -5000, account_id: 'boc' }),
      ]
      expect(adjustTotal(rows)).toBe(-5000)
    })

    it('每个账户各认各的开户那笔', () => {
      const rows = [
        tx({ type: 'adjust', amount: 1500000, account_id: 'boc' }),
        tx({ type: 'adjust', amount: 30000, account_id: 'wx' }),
        tx({ type: 'adjust', amount: -700, account_id: 'wx' }),
      ]
      expect(adjustTotal(rows)).toBe(-700)
    })

    it('转账进来也算「已经有记录」，之后的校准是真差额', () => {
      const rows = [
        tx({ type: 'transfer', amount: 100000, account_id: 'cmb', to_account_id: 'wx' }),
        tx({ type: 'adjust', amount: -700, account_id: 'wx' }),
      ]
      expect(adjustTotal(rows)).toBe(-700)
    })

    it('补记一笔更早日期的账，不能改变谁是开户那笔', () => {
      // 用 created_at 判断而不是 date：否则今天补记上周的开销，
      // 统计页那个数字会莫名其妙地变
      const rows = [
        tx({ type: 'adjust', amount: 1500000, account_id: 'boc', date: '2026-09-03' }),
        tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch', date: '2026-08-20' }),
      ]
      expect(adjustTotal(rows)).toBe(0)
    })

    it('不指定账户的流水不影响判断', () => {
      const rows = [
        tx({ type: 'expense', amount: 53800, account_id: null, category_id: 'lunch' }),
        tx({ type: 'adjust', amount: 1500000, account_id: 'boc' }),
      ]
      expect(adjustTotal(rows)).toBe(0)
    })

    it('按月统计时也要排除', () => {
      const rows = [tx({ type: 'adjust', amount: 1500000, account_id: 'boc', date: '2026-09-03' })]
      expect(adjustTotal(rows, '2026-09')).toBe(0)
    })
  })
  it('dailyCumulative ends at month expense and nulls future days', () => {
    const arr = dailyCumulative(txs, '2026-09', '2026-09-05')
    expect(arr.length).toBe(30)
    expect(arr[2]).toBe(9280)
    expect(arr[4]).toBe(9280)
    expect(arr[5]).toBeNull()
  })
  it('monthlySeries includes empty months', () => {
    const s = monthlySeries(txs, '2026-09', 3)
    expect(s.map((r) => r.ym)).toEqual(['2026-07', '2026-08', '2026-09'])
    expect(s[0]).toMatchObject({ income: 0, expense: 0 })
    expect(s[1].expense).toBe(100)
    expect(s[2].expense).toBe(9280)
  })
})

describe('balanceSeries', () => {
  it('walks day by day', () => {
    const txs = [
      tx({ type: 'adjust', amount: 10000, account_id: 'wx', date: '2026-08-01' }),
      tx({ type: 'expense', amount: 1000, account_id: 'wx', category_id: 'lunch', date: '2026-09-02' }),
      tx({ type: 'income', amount: 5000, account_id: 'cmb', category_id: 'salary', date: '2026-09-03' }),
    ]
    const keys = bucketKeys('2026-09-01', '2026-09-03', 'day')
    const h = balanceSeries(txs, accounts, keys, 'day')
    expect(keys).toEqual(['2026-09-01', '2026-09-02', '2026-09-03'])
    expect(h.byAccount.wx).toEqual([10000, 9000, 9000])
    expect(h.byAccount.cmb).toEqual([0, 0, 5000])
    expect(h.total).toEqual([10000, 9000, 14000])
  })

  it('month buckets close at month end and carry earlier balances', () => {
    const txs = [
      tx({ type: 'adjust', amount: 10000, account_id: 'wx', date: '2026-07-15' }),
      tx({ type: 'expense', amount: 3000, account_id: 'wx', category_id: 'lunch', date: '2026-08-20' }),
    ]
    const keys = bucketKeys('2026-08-01', '2026-09-30', 'month')
    const h = balanceSeries(txs, accounts, keys, 'month')
    expect(keys).toEqual(['2026-08', '2026-09'])
    expect(h.byAccount.wx).toEqual([7000, 7000])
  })
})

describe('recentChildOrder', () => {
  it('puts most recently used first, unused by sort', () => {
    const txs = [
      tx({ type: 'expense', amount: 1, account_id: 'wx', category_id: 'dinner', date: '2026-09-01' }),
      tx({ type: 'expense', amount: 1, account_id: 'wx', category_id: 'lunch', date: '2026-08-01' }),
    ]
    expect(recentChildOrder(txs, cats, 'food').map((c) => c.name)).toEqual(['晚餐', '午餐'])
    expect(recentChildOrder([], cats, 'food').map((c) => c.name)).toEqual(['午餐', '晚餐'])
  })
})

// 趋势图和流水列表靠这几个函数撑着，以前一行单测都没有。
describe('趋势序列', () => {
  const rows = [
    tx({ type: 'expense', amount: 1000, account_id: 'wx', category_id: 'lunch', date: '2026-03-10' }),
    tx({ type: 'expense', amount: 2000, account_id: 'wx', category_id: 'game', date: '2026-03-20' }),
    tx({ type: 'expense', amount: 400, account_id: 'wx', category_id: 'lunch', date: '2026-04-05' }),
    tx({ type: 'income', amount: 9000, account_id: 'cmb', category_id: 'salary', date: '2026-03-15' }),
    tx({ type: 'transfer', amount: 5000, account_id: 'cmb', to_account_id: 'wx', date: '2026-03-15' }),
    tx({ type: 'adjust', amount: -700, account_id: 'wx', date: '2026-03-15' }),
  ]

  it('按月分桶，transfer 和 adjust 一律不进', () => {
    const keys = bucketKeys('2026-03-01', '2026-04-30', 'month')
    expect(keys).toEqual(['2026-03', '2026-04'])
    expect(seriesTotals(rows, keys, 'month')).toEqual([3000, 400])
    expect(seriesTotals(rows, keys, 'month', 'income')).toEqual([9000, 0])
  })

  it('空桶出 0，不能变成缺项', () => {
    const keys = bucketKeys('2026-01-01', '2026-03-31', 'month')
    expect(seriesTotals(rows, keys, 'month')).toEqual([0, 0, 3000])
  })

  it('只按桶键匹配，不看区间端点——调用方必须自己裁', () => {
    // 这是 Stats.tsx 那个「自定义 3/15–3/31 却算了整个 3 月」的根因。
    // 函数本身的口径就是整月，所以裁剪的责任在调用方，这里把契约锁下来。
    const keys = bucketKeys('2026-03-15', '2026-03-31', 'month')
    expect(keys).toEqual(['2026-03'])
    expect(seriesTotals(rows, keys, 'month')).toEqual([3000]) // 3/10 那笔也算进来了
    const clipped = rows.filter((r) => r.date >= '2026-03-15' && r.date <= '2026-03-31')
    expect(seriesTotals(clipped, keys, 'month')).toEqual([2000]) // 裁过之后才只剩 3/20
  })

  it('闰年 2 月按日分桶是 29 天', () => {
    expect(bucketKeys('2024-02-01', '2024-02-29', 'day')).toHaveLength(29)
    expect(bucketKeys('2026-02-01', '2026-02-28', 'day')).toHaveLength(28)
  })

  it('按分类拆分时二级归到一级，各线之和等于总额', () => {
    const keys = bucketKeys('2026-03-01', '2026-04-30', 'month')
    const byCat = seriesByCategory(rows, cats, keys, 'month')
    expect(byCat.map((s) => s.name)).toEqual(['娱乐消费', '日常餐饮']) // 按区间总额降序：2000 > 1400
    const total = seriesTotals(rows, keys, 'month')
    for (let i = 0; i < keys.length; i++) {
      expect(byCat.reduce((s, c) => s + c.data[i], 0)).toBe(total[i])
    }
  })

  it('分类已被删掉的流水不会让它崩，只是不进分类拆分', () => {
    const orphan = [tx({ type: 'expense', amount: 100, account_id: 'wx', category_id: 'gone', date: '2026-03-01' })]
    const keys = bucketKeys('2026-03-01', '2026-03-31', 'month')
    expect(() => seriesByCategory(orphan, cats, keys, 'month')).not.toThrow()
    expect(seriesTotals(orphan, keys, 'month')).toEqual([100]) // 总额仍然算得对
  })
})

describe('流水分组与排序', () => {
  const mk = (date: string, created: string, over: Partial<Transaction> = {}) =>
    tx({ type: 'expense', amount: 100, account_id: 'wx', category_id: 'lunch', date, created_at: created, ...over })

  it('组间日期倒序，组内创建时间倒序', () => {
    const rows = [
      mk('2026-09-01', '2026-09-01T01:00:00.000Z'),
      mk('2026-09-03', '2026-09-03T01:00:00.000Z'),
      mk('2026-09-03', '2026-09-03T05:00:00.000Z'),
    ]
    const g = groupByDay(rows)
    expect(g.map((x) => x.date)).toEqual(['2026-09-03', '2026-09-01'])
    expect(g[0].items.map((x) => x.created_at)).toEqual(['2026-09-03T05:00:00.000Z', '2026-09-03T01:00:00.000Z'])
    expect(sortTxs(rows).map((x) => x.date)).toEqual(['2026-09-03', '2026-09-03', '2026-09-01'])
  })

  it('每日小计排除转账和校准', () => {
    const rows = [
      mk('2026-09-03', '2026-09-03T01:00:00.000Z', { amount: 800 }),
      mk('2026-09-03', '2026-09-03T02:00:00.000Z', { type: 'income', amount: 5000, category_id: 'salary' }),
      mk('2026-09-03', '2026-09-03T03:00:00.000Z', { type: 'transfer', amount: 9999, to_account_id: 'cmb', category_id: null }),
      mk('2026-09-03', '2026-09-03T04:00:00.000Z', { type: 'adjust', amount: -777, category_id: null }),
    ]
    const g = groupByDay(rows)
    expect(g[0].expense).toBe(800)
    expect(g[0].income).toBe(5000)
    expect(g[0].items).toHaveLength(4) // 四条都要显示，只是不进小计
  })
})

describe('月份选择器与起点', () => {
  const rows = [
    tx({ type: 'expense', amount: 300, account_id: 'wx', category_id: 'lunch', date: '2026-08-31' }),
    tx({ type: 'income', amount: 900, account_id: 'cmb', category_id: 'salary', date: '2026-09-02' }),
    tx({ type: 'transfer', amount: 5000, account_id: 'cmb', to_account_id: 'wx', date: '2026-07-01' }),
  ]

  it('monthTotals 只统计收支，转账不生成月份', () => {
    const m = monthTotals(rows)
    expect([...m.keys()].sort()).toEqual(['2026-08', '2026-09'])
    expect(m.get('2026-08')).toEqual({ expense: 300, income: 0 })
    expect(m.get('2026-09')).toEqual({ expense: 0, income: 900 })
  })

  it('「自有记录以来」的起点是最早一笔收支，不算转账', () => {
    expect(firstFlowDate(rows)).toBe('2026-08-31')
    expect(firstFlowDate([], '2026-09-04')).toBe('2026-09-04')
  })
})

describe('把校准标记成「已核实」', () => {
  it('标记后不再计入未记录差额，取消后又计入', () => {
    const rows = [
      tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch' }),
      tx({ type: 'adjust', amount: -5000, account_id: 'boc', note: '余额校准' }),
    ]
    expect(adjustTotal(rows)).toBe(-5000)
    rows[1] = { ...rows[1], note: withVerified(rows[1].note) }
    expect(adjustTotal(rows)).toBe(0)
    rows[1] = { ...rows[1], note: withoutVerified(rows[1].note) }
    expect(adjustTotal(rows)).toBe(-5000)
  })

  it('保留用户自己写的备注，不能把它冲掉', () => {
    expect(withVerified('银行给的利息')).toBe(`银行给的利息 · ${VERIFIED_MARK}`)
    expect(withoutVerified(`银行给的利息 · ${VERIFIED_MARK}`)).toBe('银行给的利息')
  })

  it('没有备注时来回切换要干净，不能留下一个孤零零的点', () => {
    expect(withVerified(null)).toBe(VERIFIED_MARK)
    expect(withoutVerified(VERIFIED_MARK)).toBeNull()
    expect(withoutVerified(withVerified(null))).toBeNull()
  })

  it('重复标记不会越加越长', () => {
    const once = withVerified('余额校准')
    expect(withVerified(once)).toBe(once)
    expect(withVerified(withVerified(withVerified(null)))).toBe(VERIFIED_MARK)
  })

  it('来回切换任意次，备注都能回到原样', () => {
    for (const start of [null, '余额校准', '银行利息', '  前后有空格  ', '利息 · 招行']) {
      let n: string | null = start
      for (let i = 0; i < 3; i++) n = withoutVerified(withVerified(n))
      expect(n).toBe(start === null ? null : start.trim())
    }
  })

  it('标记在开头时取消也要干净，不能留下孤零零的分隔符', () => {
    expect(withoutVerified(`${VERIFIED_MARK} · 银行利息`)).toBe('银行利息')
    expect(withoutVerified(`银行利息 · ${VERIFIED_MARK} · 招行`)).toBe('银行利息 · 招行')
  })

  it('用户自己写的「银行已核实的利息」不算我们的标记', () => {
    // 整段相等才算，否则用户的正常文字会被误判，而且取消时无从下手
    // 先建支出再建校准：tx() 按调用顺序发 created_at，反过来的话这笔校准会成为
    // 该账户的第一条记录，被当成开户本金排除，测不到我们想测的东西
    const first = tx({ type: 'expense', amount: 1, account_id: 'boc', category_id: 'lunch' })
    const t1 = tx({ type: 'adjust', amount: -1, account_id: 'boc', note: '银行已核实的利息' })
    expect(isVerifiedAdjust(t1)).toBe(false)
    expect(adjustTotal([first, t1])).toBe(-1)
  })

  it('isVerifiedAdjust 认得出标记', () => {
    expect(isVerifiedAdjust(tx({ type: 'adjust', amount: -1, account_id: 'boc', note: withVerified('余额校准') }))).toBe(true)
    expect(isVerifiedAdjust(tx({ type: 'adjust', amount: -1, account_id: 'boc', note: '余额校准' }))).toBe(false)
  })

  it('开户本金是自动排除的，不需要也不允许用户去标记', () => {
    const rows = [
      tx({ type: 'adjust', amount: 1500000, account_id: 'boc' }),
      tx({ type: 'expense', amount: 2800, account_id: 'boc', category_id: 'lunch' }),
      tx({ type: 'adjust', amount: -5000, account_id: 'boc' }),
    ]
    const opening = openingAdjustIds(rows)
    expect(opening.has(rows[0].id)).toBe(true)
    expect(opening.has(rows[2].id)).toBe(false)
  })

  it('按月统计时也认「已核实」', () => {
    const rows = [
      tx({ type: 'expense', amount: 100, account_id: 'boc', category_id: 'lunch', date: '2026-09-01' }),
      tx({ type: 'adjust', amount: -5000, account_id: 'boc', date: '2026-09-03', note: withVerified(null) }),
    ]
    expect(adjustTotal(rows, '2026-09')).toBe(0)
  })
})
