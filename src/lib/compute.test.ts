import { describe, expect, it } from 'vitest'
import type { Account, Category, Transaction } from '../types'
import { applyTx, balanceSeries, balances, bucketKeys, byCategory, dailyCumulative, firstFlowDate, groupByDay, lastCheck, monthSummary, monthTotals, monthlySeries, recentChildOrder, seriesByCategory, seriesTotals, sortTxs, totalOf } from './compute'
import { addDays, daysInMonth, lastMonths, monthRange, shiftMonth, today } from './date'
import { calcDelta, centsFromDb, centsToDb, fmtYuan, parseYuan } from './money'

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

// 「差额 = 实际余额 − 推算余额」是账户页余额核对的核心算式。
// 它原来写在 Accounts.tsx 里，node 环境没有 DOM 测不到，改错了没人拦；
// 现在挪进 money.ts，下面这一组就是拦它的人。
describe('calcDelta（差额 = 实际余额 − 推算余额）', () => {
  it('正常差额：实际比推算多 → 正数；单位是分', () => {
    expect(calcDelta('5000', 480000)).toBe(20000) // 5000.00 − 4800.00 = +200.00
    expect(calcDelta('4800.5', 480000)).toBe(50) // 只差 5 毛
  })

  it('差额为 0：一分不差时必须是 0，不是 null 也不是别的数', () => {
    expect(calcDelta('5000', 500000)).toBe(0)
    expect(calcDelta('5,000.00', 500000)).toBe(0) // 带千分位逗号同样认
    expect(calcDelta('0', 0)).toBe(0) // 空账户核对空余额
  })

  it('差额为负：实际比推算少 → 负数，符号不能反', () => {
    expect(calcDelta('4800', 500000)).toBe(-20000) // 4800.00 − 5000.00 = −200.00
    expect(calcDelta('0', 150075)).toBe(-150075) // 花光了
  })

  it('输入非法：空 / abc / 三位小数 / 只有负号 → null，页面据此把按钮置灰', () => {
    expect(calcDelta('', 500000)).toBeNull()
    expect(calcDelta('   ', 500000)).toBeNull()
    expect(calcDelta('abc', 500000)).toBeNull()
    expect(calcDelta('1.234', 500000)).toBeNull() // 超过 2 位小数，分以下没法存
    expect(calcDelta('-', 500000)).toBeNull()
    expect(calcDelta('12.5abc', 500000)).toBeNull()
  })

  it('推算余额为负（信用卡欠款）：差额要跨过 0 正确算出来', () => {
    expect(calcDelta('-1000', -170075)).toBe(70075) // 欠得比推算少 → 正差额
    expect(calcDelta('-1500.75', 0)).toBe(-150075) // 从 0 变成欠款 → 负差额
    expect(calcDelta('0', -150075)).toBe(150075) // 还清了
    expect(calcDelta('-1500.75', -150075)).toBe(0) // 负余额也能核对出无差异
  })

  it('大额：999999.99 元不丢精度，正反两个方向都对', () => {
    expect(calcDelta('999999.99', 0)).toBe(99999999)
    expect(calcDelta('999999.99', 99999999)).toBe(0)
    expect(calcDelta('0', 99999999)).toBe(-99999999)
    expect(calcDelta('999999.99', 1)).toBe(99999998)
    expect(centsFromDb(centsToDb(calcDelta('999999.99', 1)!))).toBe(99999998) // 存进 numeric(12,2) 再读回来
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


// ─────────────────────────────────────────────────────────────────────
// 修改账户余额 —— 用户的核心需求，原话：
// 「我可以根据实时情况更改四个账户的余额，然后后续的收支会调整余额。
//   如果我发现不对了我再更改余额。然后更改后，余额跟着收支调整。」
//
// 下面的 calibrate() 是 Accounts.tsx 里 confirm() 的等价复刻：
//   推算余额 = balances(txs, accounts)[账户]
//   差额     = calcDelta(用户输入的元, 推算余额)  ← 这一步两边共用 lib/money.ts 的同一份代码
//   差额不为 0 才写一条 { type:'adjust', amount: 差额, account_id: 该账户, note:'余额校准' }；
//   差额为 0 什么都不写（以前会写 0 元「余额核对」，用户嫌流水里碍眼）。
// 页面本身在 node 环境测不到（没有 DOM），所以「写不写」这个判断只能复刻在这里；
// 算式本身已经搬进 money.ts，由上面的 calcDelta 一组直接看着。
// ─────────────────────────────────────────────────────────────────────
describe('修改账户余额（校准链路）', () => {
  /** 复刻 Accounts.tsx 的 confirm()：输入「实际余额（元）」，有差额才追加一条 adjust */
  function calibrate(txs: Transaction[], accountId: string, realYuan: string): Transaction[] {
    const computed = balances(txs, accounts)[accountId] ?? 0
    const delta = calcDelta(realYuan, computed)
    if (delta === null) throw new Error(`输入 ${realYuan} 解析不了，页面上按钮会是灰的`)
    if (delta === 0) return txs // 无差异 → 只弹个提示，不落任何记录
    return [...txs, tx({ type: 'adjust', amount: delta, account_id: accountId, note: '余额校准' })]
  }
  const bal = (txs: Transaction[], id: string) => balances(txs, accounts)[id] ?? 0
  const last = (txs: Transaction[]) => txs[txs.length - 1]

  it('场景1 基本四步：0 → 录 5000 → 花 80 → 4920 → 录 4800（生成 −120）→ 收 20 → 4820', () => {
    let rows: Transaction[] = []
    expect(bal(rows, 'boc')).toBe(0) // 一条记录都没有时是 0，没有「初始余额」字段

    rows = calibrate(rows, 'boc', '5000')
    expect(last(rows)).toMatchObject({ type: 'adjust', amount: 500000, account_id: 'boc', note: '余额校准' })
    expect(bal(rows, 'boc')).toBe(500000)

    rows = [...rows, tx({ type: 'expense', amount: 8000, account_id: 'boc', category_id: 'lunch' })]
    expect(bal(rows, 'boc')).toBe(492000) // 4920.00

    rows = calibrate(rows, 'boc', '4800')
    expect(last(rows).amount).toBe(-12000) // 差额 = 480000 − 492000 = −120 元
    expect(bal(rows, 'boc')).toBe(480000)

    rows = [...rows, tx({ type: 'income', amount: 2000, account_id: 'boc', category_id: 'salary' })]
    expect(bal(rows, 'boc')).toBe(482000)
    expect(fmtYuan(bal(rows, 'boc'))).toBe('4,820.00')

    // 两次校准（+5000 / −120）一分都不能漏进收支统计
    expect(monthSummary(rows, '2026-09')).toMatchObject({ expense: 8000, income: 2000 })
  })

  it('场景2 反复改：三次校准夹着收支，每一步余额都要对', () => {
    let rows: Transaction[] = []
    rows = calibrate(rows, 'wx', '1000') // 第一次：+1000.00
    expect(last(rows).amount).toBe(100000)
    expect(bal(rows, 'wx')).toBe(100000)

    rows = [...rows, tx({ type: 'expense', amount: 350, account_id: 'wx', category_id: 'lunch' })] // −3.50
    rows = [...rows, tx({ type: 'income', amount: 12000, account_id: 'wx', category_id: 'salary' })] // +120.00
    expect(bal(rows, 'wx')).toBe(111650) // 1116.50

    rows = calibrate(rows, 'wx', '1200') // 第二次：差额为正
    expect(last(rows).amount).toBe(8350) // +83.50
    expect(bal(rows, 'wx')).toBe(120000)

    rows = [...rows, tx({ type: 'expense', amount: 99999, account_id: 'wx', category_id: 'game' })] // −999.99
    expect(bal(rows, 'wx')).toBe(20001) // 200.01

    rows = calibrate(rows, 'wx', '150.5') // 第三次：差额为负
    expect(last(rows).amount).toBe(-4951) // −49.51
    expect(bal(rows, 'wx')).toBe(15050)

    rows = [...rows, tx({ type: 'income', amount: 4950, account_id: 'wx', category_id: 'salary' })] // +49.50
    expect(bal(rows, 'wx')).toBe(20000)
    expect(fmtYuan(bal(rows, 'wx'))).toBe('200.00')

    // 统计页底部的「未记录差额」= Σadjust，三次校准的和
    const sumAdjust = rows.filter((t) => t.type === 'adjust').reduce((s, t) => s + t.amount, 0)
    expect(sumAdjust).toBe(100000 + 8350 - 4951)
    // 收支统计里没有任何一分校准的钱
    expect(monthSummary(rows, '2026-09')).toMatchObject({ expense: 350 + 99999, income: 12000 + 4950 })
  })

  it('场景3 改小改大：差额为负要减、为正要加，符号不能反', () => {
    const base = calibrate([], 'boc', '1000') // 1000.00
    const down = calibrate(base, 'boc', '600')
    expect(last(down).amount).toBe(-40000) // 改小 → 负差额
    expect(bal(down, 'boc')).toBe(60000)

    const up = calibrate(base, 'boc', '1600')
    expect(last(up).amount).toBe(60000) // 改大 → 正差额
    expect(bal(up, 'boc')).toBe(160000)
  })

  it('场景4a 改成 0：清空账户余额', () => {
    let rows = calibrate([], 'boc', '5000')
    rows = calibrate(rows, 'boc', '0')
    expect(last(rows)).toMatchObject({ amount: -500000, note: '余额校准' }) // 差额不为 0，仍是「校准」
    expect(bal(rows, 'boc')).toBe(0)
    // 归零之后照样能继续记账
    rows = [...rows, tx({ type: 'expense', amount: 1500, account_id: 'boc', category_id: 'lunch' })]
    expect(bal(rows, 'boc')).toBe(-1500)
  })

  it('场景4b 改成负数：信用卡欠款 −1500.75，再记支出、再校准', () => {
    let rows = calibrate([], 'cmb', '-1500.75')
    expect(last(rows).amount).toBe(-150075)
    expect(bal(rows, 'cmb')).toBe(-150075)
    expect(fmtYuan(bal(rows, 'cmb'))).toBe('-1,500.75')

    rows = [...rows, tx({ type: 'expense', amount: 20000, account_id: 'cmb', category_id: 'lunch' })] // 又刷了 200
    expect(bal(rows, 'cmb')).toBe(-170075)

    rows = calibrate(rows, 'cmb', '-1000') // 还了一部分，账单显示 −1000
    expect(last(rows).amount).toBe(70075)
    expect(bal(rows, 'cmb')).toBe(-100000)

    // 负余额也要正确进总额
    expect(totalOf(balances(rows, accounts))).toBe(-100000)
  })

  it('场景5 差额为 0：一条记录都不写，流水里不留 0 元行', () => {
    const before = calibrate([], 'boc', '5000')
    const n0 = before.length
    const check0 = lastCheck(before, 'boc')

    const after = calibrate(before, 'boc', '5000')
    expect(calcDelta('5000', bal(before, 'boc'))).toBe(0) // 确实是无差异这一支
    expect(after).toHaveLength(n0) // 没有多写任何一条
    expect(after.filter((t) => t.type === 'adjust' && t.amount === 0)).toHaveLength(0) // 流水里没有 0 元行
    expect(bal(after, 'boc')).toBe(500000) // 余额一分不变
    expect(bal(before, 'boc')).toBe(bal(after, 'boc'))
    // 代价：不写记录 → 「上次校准时间」不会因为一次无差异核对而前进，这是有意的
    expect(lastCheck(after, 'boc')).toBe(check0)
    expect(monthSummary(after, '2026-09')).toMatchObject({ expense: 0, income: 0 })
  })

  it('场景5b 连着核对十次无差异：流水条数一条都不涨', () => {
    let rows = calibrate([], 'wx', '200')
    const n0 = rows.length
    for (let i = 0; i < 10; i++) rows = calibrate(rows, 'wx', '200')
    expect(rows).toHaveLength(n0)
    expect(bal(rows, 'wx')).toBe(20000)
  })

  it('场景6 转账不影响这条链路：转完两边各自对，各自再校准一次仍然对', () => {
    let rows = calibrate([], 'boc', '5000')
    rows = calibrate(rows, 'cmb', '1000')
    expect(totalOf(balances(rows, accounts))).toBe(600000)

    rows = [...rows, tx({ type: 'transfer', amount: 80000, account_id: 'boc', to_account_id: 'cmb' })] // boc → cmb 800
    expect(bal(rows, 'boc')).toBe(420000)
    expect(bal(rows, 'cmb')).toBe(180000)
    expect(totalOf(balances(rows, accounts))).toBe(600000) // 转账不改变总额
    expect(monthSummary(rows, '2026-09')).toMatchObject({ expense: 0, income: 0 }) // 转账不是收支

    rows = calibrate(rows, 'boc', '4150') // 转出方少了 50
    expect(last(rows).amount).toBe(-5000)
    expect(bal(rows, 'boc')).toBe(415000)
    expect(bal(rows, 'cmb')).toBe(180000) // 校准 boc 不碰 cmb

    rows = calibrate(rows, 'cmb', '1850') // 转入方多了 50
    expect(last(rows).amount).toBe(5000)
    expect(bal(rows, 'cmb')).toBe(185000)
    expect(bal(rows, 'boc')).toBe(415000)
    expect(totalOf(balances(rows, accounts))).toBe(600000)
  })

  it('场景7 不指定账户的收支：一分钱都不进任何账户余额，也不制造差额', () => {
    let rows = calibrate([], 'boc', '5000')
    rows = [...rows, tx({ type: 'expense', amount: 8000, account_id: null, category_id: 'lunch' })]
    rows = [...rows, tx({ type: 'income', amount: 3000, account_id: null, category_id: 'salary' })]

    expect(bal(rows, 'boc')).toBe(500000)
    expect(totalOf(balances(rows, accounts))).toBe(500000)
    expect(monthSummary(rows, '2026-09')).toMatchObject({ expense: 8000, income: 3000 }) // 但要进收支统计

    // 再核对一次实际余额 5000：差额必须是 0，不能被那两笔无账户流水带偏
    expect(calcDelta('5000', bal(rows, 'boc'))).toBe(0)
    const n0 = rows.length
    rows = calibrate(rows, 'boc', '5000')
    expect(rows).toHaveLength(n0) // 无差异 → 不写记录
  })

  it('场景8 多账户互不干扰：给中国银行校准，微信一分不变', () => {
    let rows = calibrate([], 'boc', '5000')
    rows = calibrate(rows, 'wx', '200')
    const wxBefore = bal(rows, 'wx')

    rows = calibrate(rows, 'boc', '4321.09')
    expect(bal(rows, 'boc')).toBe(432109)
    expect(bal(rows, 'wx')).toBe(wxBefore)
    expect(bal(rows, 'wx')).toBe(20000)
    expect(bal(rows, 'cmb')).toBe(0) // 从没动过的账户还是 0

    // 反过来校准微信，中国银行也不能动
    rows = calibrate(rows, 'wx', '0.01')
    expect(bal(rows, 'wx')).toBe(1)
    expect(bal(rows, 'boc')).toBe(432109)
    expect(totalOf(balances(rows, accounts))).toBe(432109 + 1)
  })

  it('场景9 金额边界：0.01 / 4846.42 / 负数，元→分→numeric→分 往返零误差', () => {
    for (const [input, cents] of [['0.01', 1], ['4846.42', 484642], ['-10.84', -1084], ['0', 0], ['999999.99', 99999999]] as const) {
      expect(parseYuan(input)).toBe(cents)
      expect(centsFromDb(centsToDb(cents))).toBe(cents) // 存进 numeric(12,2) 再读回来
    }

    // 整条链路走一遍：每一步的 adjust 金额都过一次数据库往返
    let rows = calibrate([], 'wx', '0.01')
    expect(last(rows).amount).toBe(1)
    rows = calibrate(rows, 'wx', '4846.42')
    expect(last(rows).amount).toBe(484641) // 484642 − 1
    expect(centsFromDb(centsToDb(last(rows).amount))).toBe(484641)
    rows = [...rows, tx({ type: 'expense', amount: 1084, account_id: 'wx', category_id: 'lunch' })]
    rows = calibrate(rows, 'wx', '4800')
    expect(last(rows).amount).toBe(480000 - (484642 - 1084))
    expect(bal(rows, 'wx')).toBe(480000)

    // 所有校准记录往返后余额必须一模一样
    const roundTripped = rows.map((t) => ({ ...t, amount: centsFromDb(centsToDb(t.amount)) }))
    expect(balances(roundTripped, accounts)).toEqual(balances(rows, accounts))
  })

  it('applyTx：adjust 是加不是减，负数和 0 都要按原样累加，没账户的直接跳过', () => {
    const out: Record<string, number> = { boc: 100000 }
    applyTx(tx({ type: 'adjust', amount: 5000, account_id: 'boc' }), out)
    expect(out.boc).toBe(105000) // 正差额往上加
    applyTx(tx({ type: 'adjust', amount: -7000, account_id: 'boc' }), out)
    expect(out.boc).toBe(98000) // 负差额往下减
    applyTx(tx({ type: 'adjust', amount: 0, account_id: 'boc' }), out)
    expect(out.boc).toBe(98000) // 0 差额不动
    applyTx(tx({ type: 'adjust', amount: 999, account_id: null }), out)
    expect(out.boc).toBe(98000) // 没有账户的直接跳过
    applyTx(tx({ type: 'adjust', amount: 3000, account_id: 'newacc' }), out)
    expect(out.newacc).toBe(3000) // 之前没出现过的账户从 0 起算
  })

  it('lastCheck：只认 adjust，只认这个账户，取最新一条', () => {
    const rows = [
      tx({ type: 'adjust', amount: 100, account_id: 'boc' }),
      tx({ type: 'adjust', amount: 200, account_id: 'wx' }),
      tx({ type: 'adjust', amount: 0, account_id: 'boc' }), // 历史遗留的 0 元核对记录，仍然算「校准过」
      tx({ type: 'expense', amount: 300, account_id: 'boc', category_id: 'lunch' }), // 收支不算核对
    ]
    expect(lastCheck(rows, 'boc')).toBe(rows[2].created_at)
    expect(lastCheck(rows, 'wx')).toBe(rows[1].created_at)
    expect(lastCheck(rows, 'cmb')).toBeNull()
  })
})
