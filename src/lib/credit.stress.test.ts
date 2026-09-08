// 白条账单的压力测试：随机生成账本，用**不变量**去撞，而不是挑一个已知答案去问。
//
// 为什么要有这个文件：2026-09-08 用户实测撞出三个 bug（提前还清之后每个月还继续要钱、
// 拼多多跨月还款不算数、京东逾期那期下个月从账单里消失），而当时的单测**全是绿的**。
// 原因是那些测试拿代码内部的口径（`ym`）当输入、每个用例只问一帧，等于让实现给自己判卷。
//
// 这里反过来：日期是输入，答案不写死，只断言几条无论如何都必须成立的等式。
// 随机数用固定种子的 LCG，红了以后把种子打出来就能原样复现。
import { describe, expect, it } from 'vitest'
import type { Account, Transaction } from '../types'
import { balances, creditBill, dueNow, installmentPlan } from './compute'
import { addDays } from './date'

/** 固定种子的线性同余，node 各版本行为一致，红了能复现 */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

const REPAY_DAYS = [1, 17, 31, null] as const
const START = '2026-01-05'

interface Ledger {
  acc: Account
  txs: Transaction[]
  /** 抽查的日子：随机日 + 每一期到期日的前一天/当天/后一天 */
  days: string[]
}

function makeLedger(seed: number): Ledger {
  const r = rng(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

  const acc: Account = { id: 'c', name: '白条', kind: 'credit', sort: 0, is_archived: false, repay_day: pick(REPAY_DAYS), facade_offset: null }
  const txs: Transaction[] = []
  let n = 0
  const stamp = () => `2026-01-01T00:00:${String(++n % 60).padStart(2, '0')}.${String(n).padStart(3, '0')}Z`

  // 1) 若干笔下单
  const buys: Transaction[] = []
  for (let i = 0; i < int(1, 8); i++) {
    const t: Transaction = {
      id: `b${i}`,
      date: addDays(START, int(0, 200)),
      type: 'expense',
      amount: int(1, 200000),
      account_id: acc.id,
      to_account_id: null,
      category_id: 'cat',
      note: null,
      installments: r() < 0.4 ? int(2, 12) : null,
      settles: null,
      created_at: stamp(),
    }
    buys.push(t)
    txs.push(t)
  }

  // 2) 若干笔还款。一部分指名结清某一单（只对「一次还清」的单，和界面一致），
  //    金额必须 ≥ 被结清的金额——「勾了却没给够钱」是另一回事，单独有用例守。
  const settled = new Set<string>()
  for (let i = 0; i < int(0, 5); i++) {
    const single = buys.filter((b) => (b.installments ?? 1) === 1 && !settled.has(b.id))
    const useSettles = single.length > 0 && r() < 0.4
    const target = useSettles ? single[Math.floor(r() * single.length)] : null
    if (target) settled.add(target.id)
    txs.push({
      id: `p${i}`,
      date: addDays(START, int(0, 260)),
      type: 'transfer',
      amount: target ? target.amount + (r() < 0.3 ? int(0, 5000) : 0) : int(1, 250000),
      account_id: 'boc',
      to_account_id: acc.id,
      category_id: null,
      note: null,
      installments: null,
      settles: target ? [target.id] : null,
      created_at: stamp(),
    })
  }

  // 3) 抽查的日子：每一期到期日的前后各一天一定要问到——账单窗口正是在那里换页的
  const days = new Set<string>()
  for (let i = 0; i < 6; i++) days.add(addDays(START, int(0, 700)))
  for (const b of buys) {
    for (const p of installmentPlan(b, acc.repay_day)) {
      days.add(addDays(p.date, -1))
      days.add(p.date)
      days.add(addDays(p.date, 1))
    }
  }
  // 抽查日封顶。一份账本能生成几百个日子，但账单窗口的行为只在「换页那一天」变，
  // 均匀抽 60 个足够踩到每一次换页，再多只是重复跑同一条分支
  const all = [...days].sort()
  const step = Math.max(1, Math.ceil(all.length / 60))
  return { acc, txs, days: all.filter((_, i) => i % step === 0) }
}

/**
 * 无论账本长什么样、无论哪一天问，都必须成立的几条。
 * 第一条是核心：**「所有还没被抵掉的期」加起来 ≡ 这个账户的欠款**。
 * 它把「账单」和「余额」两套各算各的东西钉死在一起，三个 bug 全部会当场违反它。
 */
function check(l: Ledger, seed: number) {
  const owed = Math.max(0, -(balances(l.txs, [l.acc])[l.acc.id] ?? 0))
  for (const d of l.days) {
    const b = creditBill(l.txs, l.acc, d)
    // 只在不等时才拼错误信息：expect(x, `模板串`) 会每次都求值，几万次下来能把测试拖超时
    const bad = (msg: string) => expect.fail(`seed=${seed} 日期=${d} 还款日=${l.acc.repay_day}：${msg}`)

    const all = [...b.rows, ...b.upcoming]
    for (const row of all) {
      if (row.paid < 0 || row.paid > row.due.amount) bad(`单期已还 ${row.paid} 越界（这一期 ${row.due.amount}）`)
    }
    const unpaid = all.reduce((s, row) => s + row.due.amount - row.paid, 0)
    if (unpaid !== owed) bad(`未还合计 ${unpaid} ≠ 欠款 ${owed}`)

    // 面板的契约：勾选加总必须正好等于「本期该还」，否则用户全选一下金额就错了
    const sum = b.rows.reduce((s, row) => s + row.due.amount, 0)
    if (sum !== b.total) bad(`各行之和 ${sum} ≠ 本期该还 ${b.total}`)
    if (b.left !== Math.max(0, b.total - b.paid)) bad(`还差 ${b.left} 算错了`)
    if (b.paid > b.total) bad(`已还 ${b.paid} 超过该还 ${b.total}`)
    if ((dueNow(l.txs, [l.acc], d).get(l.acc.id) ?? 0) !== b.left) bad('dueNow 和面板对不上')

    // 分段互斥且按到期日单调：逾期 < 本期 = dueDate < 往后
    if (b.dueDate !== null) {
      for (const row of b.rows) {
        if (row.state === 'overdue' ? !(row.due.date < b.dueDate) : row.due.date !== b.dueDate) bad(`${row.state} 行的到期日 ${row.due.date} 站错了段`)
      }
      for (const row of b.upcoming) if (!(row.due.date > b.dueDate)) bad(`往后行的到期日 ${row.due.date} 没在本期之后`)
    }
    // 已经还完的逾期期数要退场，不能堆在账单里
    for (const row of b.rows) if (row.state === 'overdue' && row.paid >= row.due.amount) bad('还完的逾期期数还挂着')
  }
  expect(l.days.length).toBeGreaterThan(0)
}

describe('白条账单：随机账本压力测试', () => {
  it('未还合计 ≡ 欠款余额，换哪一天问都成立（400 份随机账本）', () => {
    for (let seed = 1; seed <= 400; seed++) check(makeLedger(seed), seed)
  })

  it('每一期的金额之和 ≡ 整单金额，一分不多一分不少', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const l = makeLedger(seed)
      for (const t of l.txs) {
        if (t.type !== 'expense') continue
        const plan = installmentPlan(t, l.acc.repay_day)
        if (plan.reduce((s, p) => s + p.amount, 0) !== t.amount) expect.fail(`seed=${seed} ${t.id}：各期之和 ≠ 整单金额`)
        expect(plan.length).toBe(Math.max(1, t.installments ?? 1))
        expect(plan.every((p) => p.amount >= 0)).toBe(true)
      }
    }
  })

  it('再还一笔钱，未还合计正好少这么多——提前还、逾期补还、还多了，一视同仁', () => {
    // 这一条就是那个 bug 的正面表达：以前只有「还款日期和账单同月」才算数，
    // 于是提前还的钱对未来的期毫无作用，未还合计纹丝不动。
    for (let seed = 1; seed <= 300; seed++) {
      const l = makeLedger(seed)
      const r = rng(seed * 7919)
      const before = Math.max(0, -(balances(l.txs, [l.acc])[l.acc.id] ?? 0))
      const extra = 1 + Math.floor(r() * 300000)
      const day = l.days[Math.floor(r() * l.days.length)]
      const withPay: Transaction[] = [
        ...l.txs,
        { id: 'extra', date: day, type: 'transfer', amount: extra, account_id: 'boc', to_account_id: l.acc.id, category_id: null, note: null, installments: null, settles: null, created_at: '2026-01-01T23:59:59.999Z' },
      ]
      for (const d of l.days) {
        const b = creditBill(withPay, l.acc, d)
        const unpaid = [...b.rows, ...b.upcoming].reduce((s, row) => s + row.due.amount - row.paid, 0)
        if (unpaid !== Math.max(0, before - extra)) expect.fail(`seed=${seed} 还款日=${day} 抽查=${d}：未还合计 ${unpaid} ≠ ${Math.max(0, before - extra)}`)
      }
    }
  })

  it('删掉一笔还款，未还合计正好加回来', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const l = makeLedger(seed)
      const pays = l.txs.filter((t) => t.type === 'transfer')
      if (!pays.length) continue
      const drop = pays[seed % pays.length]
      // 指名结清的那笔删掉后，被它结清的订单要整单回到账单里
      const rest = l.txs.filter((t) => t.id !== drop.id)
      const owed = Math.max(0, -(balances(rest, [l.acc])[l.acc.id] ?? 0))
      for (const d of l.days) {
        const b = creditBill(rest, l.acc, d)
        const unpaid = [...b.rows, ...b.upcoming].reduce((s, row) => s + row.due.amount - row.paid, 0)
        if (unpaid !== owed) expect.fail(`seed=${seed} 删=${drop.id} 抽查=${d}：未还合计 ${unpaid} ≠ 欠款 ${owed}`)
      }
    }
  })

  it('改某笔还款时把它自己排除掉，效果等于把它删了', () => {
    // 面板上点一笔还款进去改勾选，看到的必须是「当它不存在」的账单，
    // 否则被它结清的订单根本不显示，想取消都取消不了。
    for (let seed = 1; seed <= 300; seed++) {
      const l = makeLedger(seed)
      const pays = l.txs.filter((t) => t.type === 'transfer')
      if (!pays.length) continue
      const editing = pays[seed % pays.length]
      const rest = l.txs.filter((t) => t.id !== editing.id)
      for (const d of l.days) {
        const a = creditBill(l.txs, l.acc, d, editing.id)
        const b = creditBill(rest, l.acc, d)
        if (a.total !== b.total || a.paid !== b.paid || a.left !== b.left || String(a.rows.map((x) => x.tx.id)) !== String(b.rows.map((x) => x.tx.id))) {
          expect.fail(`seed=${seed} ${d}：ignoreRepayId 的效果不等于把它删掉`)
        }
      }
    }
  })

  it('已知的例外：勾了结清却没给够钱，账单会比余额少算——不拦，但要有数', () => {
    // 界面上勾了 5.99 却手填 3.00，底下有黄字提醒「对不上」但不拦（平台合并扣款、收零头都可能）。
    // 这时「未还合计 ≡ 欠款」不再成立：那单整单退出账单，而钱只给了一部分。
    // 写在这里是为了把它钉成**已知行为**，哪天有人顺手改掉了会红。
    const acc: Account = { id: 'c', name: '白条', kind: 'credit', sort: 0, is_archived: false, repay_day: null, facade_offset: null }
    const cup: Transaction = { id: 'cup', date: '2026-09-01', type: 'expense', amount: 599, account_id: 'c', to_account_id: null, category_id: 'x', note: null, installments: null, settles: null, created_at: '2026-09-01T00:00:01.000Z' }
    const short: Transaction = { id: 'p', date: '2026-09-02', type: 'transfer', amount: 300, account_id: 'boc', to_account_id: 'c', category_id: null, note: null, installments: null, settles: ['cup'], created_at: '2026-09-02T00:00:01.000Z' }
    const b = creditBill([cup, short], acc, '2026-09-10')
    expect(b.rows).toEqual([]) // 杯子被当成整单结清，退出账单
    expect(b.left).toBe(0)
    expect(balances([cup, short], [acc]).c).toBe(-299) // 余额诚实：还欠 2.99
  })
})
