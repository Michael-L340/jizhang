// 白条卡（欠款走势 + 本期该还 / 欠款合计）。
//
// 输入是「今天几号 + 一本小账」，断言打开那张卡看到的数；而且让时间往前走——
// 白条的 bug（2026-09-08 那三个）无一例外只在跨月之后才现形。
// 期望值都是按 CLAUDE.md 的白条规则手算的，不拿 creditBill 自己的输出当答案。
// 每条用例注释里的「变异：xxx → 红」都真的跑过。
import { describe, expect, it } from 'vitest'
import type { Account, Transaction } from '../../types'
import { CHART } from '../palette'
import { creditChart } from './credit'
import type { MoreInput } from './types'

const A = (id: string, name: string, kind: Account['kind'], sort: number, repay_day: number | null = null, defer = false): Account => ({
  id, name, kind, sort, is_archived: false, repay_day, defer_after_repay: defer, facade_offset: null,
})
const boc = A('boc', '中国银行', 'bank', 1)
const wx = A('wx', '微信', 'wallet', 2)
const jd = A('jd', '京东白条', 'credit', 5, 17, true) // 还款日 17，本期还过款之后下的单归下一期
const hb = A('hb', '花呗', 'credit', 6, 1)
const pdd = A('pdd', '拼多多', 'credit', 7, null) // 先用后付，没有固定还款日
const accounts = [boc, wx, jd, hb, pdd]

let seq = 0
function tx(date: string, type: Transaction['type'], amount: number, account_id: string | null, over: Partial<Transaction> = {}): Transaction {
  seq++
  return {
    id: `t${seq}`, date, type, amount, account_id, to_account_id: null, category_id: null, note: null,
    installments: null, settles: null, hidden: null, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), ...over,
  }
}
const repay = (date: string, amount: number, to: string, over: Partial<Transaction> = {}) => tx(date, 'transfer', amount, 'boc', { to_account_id: to, ...over })

const input = (txs: Transaction[], today: string, over: Partial<MoreInput> = {}): MoreInput => ({
  txs, accounts, cats: [], ym: today.slice(0, 7), start: '2026-07-01', end: today, today, ...over,
})

function view(inp: MoreInput) {
  const ch = creditChart(inp)
  const o = ch.option as null | {
    xAxis: { data: string[] }
    series: { data: number[] }[]
    color: string[]
    tooltip: { formatter: (ps: { dataIndex: number; marker: string; value: number }[]) => string }
  }
  return {
    ch,
    months: o?.xAxis.data ?? [],
    debt: o?.series[0].data ?? [],
    tiles: Object.fromEntries((ch.tiles ?? []).map((t) => [t.label, t.value])),
    o,
  }
}

// 一本从七月开始的账：
//   8/5  京东下单 300（到期 8/17）
//   8/10 中行还京东 300
//   9/1  京东下单 600 分 3 期（9/17、10/17、11/17 各 200；8/17 之后没还过款，不顺延）
//   9/2  中行买东西 50（不是白条，不该出现在任何数里）
//   9/10 花呗下单 100（还款日 1 号 → 10/1 到期）
const ledger = () => [
  tx('2026-08-05', 'expense', 30000, 'jd'),
  repay('2026-08-10', 30000, 'jd'),
  tx('2026-09-01', 'expense', 60000, 'jd', { installments: 3 }),
  tx('2026-09-02', 'expense', 5000, 'boc'),
  tx('2026-09-10', 'expense', 10000, 'hb'),
]

describe('白条：打开看到什么，时间往前走', () => {
  it('9/20 打开：八月借了又还上 → 八月底欠 0；九月底欠 700；本期该还 500（京东逾期 200 + 本期 200，花呗 100）', () => {
    // 变异：本期该还用 creditBill.total（不减已还）→ 不红（这一帧还没还过）；由下面「10/26 还完」那条守
    // 变异：序列走资产账户（splitAccounts.assets）→ 红
    const v = view(input(ledger(), '2026-09-20'))
    expect(v.ch.key).toBe('credit')
    expect(v.ch.title).toBe('白条')
    // 变异：base 不带 span → 红
    expect(v.ch.span).toBe('26.7–26.9')
    expect(v.months).toEqual(['26.7', '26.8', '26.9'])
    expect(v.debt).toEqual([0, 0, 70000])
    expect(v.tiles).toEqual({ 本期该还: '¥500.00', 欠款合计: '¥700.00' })
  })

  it('10/20 再看（一分没还）：京东 9/17、10/17 两期逾期 + 11/17 本期，花呗 10/1 逾期，本期该还 700', () => {
    // 变异：dueNow 的 today 传 inp.end 以外的东西（比如 inp.start）→ 红
    const v = view(input(ledger(), '2026-10-20'))
    expect(v.debt).toEqual([0, 0, 70000, 70000])
    expect(v.tiles).toEqual({ 本期该还: '¥700.00', 欠款合计: '¥700.00' })
  })

  it('10/25 还京东 600、10/26 再看：京东这期还完了（本期该还只剩花呗 100），欠款合计 100', () => {
    // 变异：本期该还用 creditBill.total 代替 left → 红（京东 11/17 那行已还清但还留在 rows 里，会多出 200）
    const v = view(input([...ledger(), repay('2026-10-25', 60000, 'jd')], '2026-10-26'))
    expect(v.debt).toEqual([0, 0, 70000, 10000])
    expect(v.tiles).toEqual({ 本期该还: '¥100.00', 欠款合计: '¥100.00' })
  })

  it('月底 / 月初的边界：9/30 下的单算九月底，10/1 下的单算十月底', () => {
    // 变异：bucketKeys 用 'day' → 红；balanceSeries 换成按月初取 → 红
    const v = view(input([tx('2026-09-30', 'expense', 100, 'pdd'), tx('2026-10-01', 'expense', 200, 'pdd')], '2026-10-05', { start: '2026-09-01' }))
    expect(v.debt).toEqual([100, 300])
  })

  it('京东还多了（余额 +100）不抵花呗的欠款：欠款合计 300，不是 200；标题照首页的口径', () => {
    // 变异：欠款改成 −(几家余额之和) → 红（会算成 200）
    const v = view(input([repay('2026-09-01', 10000, 'jd'), tx('2026-09-10', 'expense', 30000, 'hb')], '2026-09-20'))
    expect(v.debt).toEqual([0, 0, 30000])
    expect(v.tiles).toEqual({ 本期该还: '¥300.00', 欠款合计: '¥300.00' })
  })

  it('退款（收入记在白条上）会冲掉欠款；银行之间转账和白条无关', () => {
    // 变异：applyTx 口径之外自己只数 expense / transfer → 红
    const v = view(input([tx('2026-09-05', 'expense', 50000, 'pdd'), tx('2026-09-06', 'income', 20000, 'pdd'), tx('2026-09-07', 'transfer', 99999, 'boc', { to_account_id: 'wx' })], '2026-09-20'))
    expect(v.debt).toEqual([0, 0, 30000])
    expect(v.tiles['欠款合计']).toBe('¥300.00')
  })
})

describe('白条：什么时候不画', () => {
  it('没有白条账户 → 空状态', () => {
    // 变异：去掉 credits.length 判断 → 红（空状态会落到「白条没有欠款」那句，可人家根本没开白条）
    const ch = creditChart({ ...input([tx('2026-09-02', 'expense', 100, 'boc')], '2026-09-20'), accounts: [boc, wx] })
    expect(ch.option).toBeNull()
    expect(ch.empty).toBe('还没有白条账户')
  })

  it('有白条账户但一直是 0（只在银行之间转账、用银行卡买东西）→ 空状态', () => {
    // 变异：去掉「全为 0」的判断 → 红
    const ch = creditChart(input([tx('2026-09-02', 'expense', 100, 'boc'), tx('2026-09-07', 'transfer', 100, 'boc', { to_account_id: 'wx' })], '2026-09-20'))
    expect(ch.option).toBeNull()
    expect(ch.empty).toBeTruthy()
    expect(ch.tiles).toBeUndefined()
  })

  it('区间里一直是 0 但现在还欠着（看的是去年那段）→ 照样画，底下的数按今天', () => {
    // 变异：只看序列全 0 就判空 → 红
    const v = view(input([tx('2026-09-10', 'expense', 10000, 'hb')], '2026-09-20', { start: '2026-01-01', end: '2026-03-31' }))
    expect(v.ch.option).not.toBeNull()
    expect(v.debt).toEqual([0, 0, 0])
    expect(v.tiles).toEqual({ 本期该还: '¥100.00', 欠款合计: '¥100.00' })
  })
})

describe('白条：样子', () => {
  it('提示框写「2026年9月底 欠款 ¥700.00」；点第 3 个点去 9 月的流水', () => {
    // 变异：提示框不带 ¥ → 红；onPoint 返回 keys[i+1] → 红；提示框去掉「再点一下看流水」→ 红
    const v = view(input(ledger(), '2026-09-20'))
    const s = v.o!.tooltip.formatter([{ dataIndex: 2, marker: '', value: 70000 }])
    expect(s).toContain('2026年9月底')
    expect(s).toContain('¥700.00')
    expect(s).toContain('再点一下看流水')
    // 变异：不带 acc=credit（改前的写法）→ 流水页是那个月全部账户，红
    expect(v.ch.onPoint?.(2, 0)).toBe('ym=2026-09&cat=all&acc=credit')
    expect(v.ch.onPoint?.(9, 0)).toBeNull()
    expect(v.o!.color).toEqual([CHART.expense])
  })
})

// ---------- 不变量：随机账本 ----------

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

describe('白条：不变量（随机账本 × 150）', () => {
  it('每个点 ≡ 那个月底各家白条 max(0, −余额) 之和（按定义现算）；区间到今天时末点 ≡ 欠款合计', () => {
    // 变异：欠款改成 −(几家余额之和) → 红；序列漏掉 adjust（白条的真实校准）→ 红
    const credits = [jd, hb, pdd]
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed)
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
      const day = () => `2026-${String(1 + Math.floor(r() * 9)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`
      const txs: Transaction[] = []
      for (let i = 0; i < 30; i++) {
        const k = r()
        if (k < 0.45) txs.push(tx(day(), 'expense', 1 + Math.floor(r() * 50000), pick(['jd', 'hb', 'pdd', 'boc']), { installments: r() < 0.3 ? pick([3, 6, 12]) : null }))
        else if (k < 0.75) txs.push(repay(day(), 1 + Math.floor(r() * 60000), pick(['jd', 'hb', 'pdd', 'wx'])))
        else if (k < 0.85) txs.push(tx(day(), 'income', 1 + Math.floor(r() * 10000), pick(['jd', 'hb', 'pdd', 'boc']))) // 退款
        else txs.push(tx(day(), 'adjust', Math.floor(r() * 20000) - 10000, pick(['jd', 'hb', 'pdd', 'boc'])))
      }
      const today = '2026-09-28'
      const v = view(input(txs, today, { start: '2026-01-01' }))
      // 按定义现算：月底之前（含）所有动过这家白条余额的流水
      const effect = (t: Transaction, id: string): number => {
        if (t.type === 'transfer') return (t.to_account_id === id ? t.amount : 0) - (t.account_id === id ? t.amount : 0)
        if (t.account_id !== id) return 0
        return t.type === 'expense' ? -t.amount : t.amount
      }
      const owedAt = (end: string) => credits.reduce((s, a) => s + Math.max(0, -txs.filter((t) => t.date <= end).reduce((x, t) => x + effect(t, a.id), 0)), 0)
      const want = ['01', '02', '03', '04', '05', '06', '07', '08', '09'].map((m) => owedAt(m === '09' ? '2026-09-30' : `2026-${m}-31`))
      if (!v.ch.option) {
        if (want.some((x) => x !== 0)) expect.fail(`seed ${seed}: 有欠款却没画`)
        continue
      }
      if (JSON.stringify(v.debt) !== JSON.stringify(want)) expect.fail(`seed ${seed}: ${v.debt} ≠ ${want}`)
      const owedNow = owedAt(today)
      const tile = v.tiles['欠款合计']
      if (v.debt.at(-1) !== owedNow || tile !== `¥${(owedNow / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) {
        expect.fail(`seed ${seed}: 末点 ${v.debt.at(-1)} / 欠款合计 ${tile}，按定义是 ${owedNow}`)
      }
    }
  })
})
