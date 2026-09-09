// 模拟真人用一个月：记账 → 看本月应还 → 勾选还款 → 改勾选 → 撤销 → 导出导入。
//
// 单元测试各管一段，这里管「串起来还对不对」。踩过的坑都在这条链上：
// 同一笔钱扣两次、结清关系删不干净、新列在导出导入路上丢掉、余额和界面对不上。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account, Category, Snapshot, Transaction } from '../types'

const api = vi.hoisted(() => ({
  fetchAll: vi.fn(),
  insertTx: vi.fn(),
  updateTx: vi.fn(),
  deleteTx: vi.fn(),
  upsertTx: vi.fn(),
  addCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateAccount: vi.fn(),
  importAll: vi.fn(),
  wipeAll: vi.fn(),
  fetchBackupStatus: vi.fn(),
  signIn: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  hasSession: vi.fn(),
  onAuthChange: vi.fn(() => () => {}),
  friendlyError: (e: unknown) => String((e as { message?: string })?.message ?? e),
  isDuplicateName: () => false,
  isPermanentError: (e: unknown) => /^(22|23|42)/.test(String((e as { code?: string })?.code ?? '')),
  configured: true,
}))
vi.mock('./api', () => api)

class FakeStorage {
  map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
}

import { balances, creditBill, debtOf, dueNow, settledIds, splitAccounts, totalOf } from './compute'
import { buildCsv, buildJson, parseImport } from './csv'

const A = (id: string, name: string, kind: Account['kind'], sort: number, repay_day: number | null = null): Account => ({ id, name, kind, sort, is_archived: false, repay_day, facade_offset: null, defer_after_repay: null })
const boc = A('00000000-0000-4000-8000-000000000001', '中国银行', 'bank', 1)
const jd = A('00000000-0000-4000-8000-000000000002', '京东白条', 'credit', 5, 17)
jd.defer_after_repay = true // 只有京东这样（用户 2026-09-09）
const pdd = A('00000000-0000-4000-8000-000000000003', '拼多多', 'credit', 7, null)
const hb = A('00000000-0000-4000-8000-000000000004', '花呗', 'credit', 6, 1)
const accounts = [boc, jd, pdd, hb]
const cat: Category = { id: '00000000-0000-4000-8000-0000000000c1', kind: 'expense', parent_id: null, name: '非经常生活消费', icon: '🎁', sort: 4, is_archived: false, note: null }
const categories = [cat]

let n = 0
const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
/** 每笔记录时间严格递增，用来定顺序；秒位补零，别拼出非法时间戳 */
const stamp = (d: string) => `${d}T00:00:${String(n % 60).padStart(2, '0')}.000Z`
function buy(over: Partial<Transaction>): Transaction {
  return { id: uid(), date: '2026-09-06', type: 'expense', amount: 1000, account_id: jd.id, to_account_id: null, category_id: cat.id, note: null, installments: null, settles: null, created_at: stamp('2026-09-06'), ...over }
}
function pay(over: Partial<Transaction>): Transaction {
  return { id: uid(), date: '2026-09-17', type: 'transfer', amount: 1000, account_id: boc.id, to_account_id: jd.id, category_id: null, note: '还款', installments: null, settles: null, created_at: stamp('2026-09-17'), ...over }
}

let store: typeof import('./store')
const st = () => store.useStore.getState()

beforeEach(async () => {
  vi.useFakeTimers()
  Object.defineProperty(globalThis, 'localStorage', { value: new FakeStorage(), configurable: true, writable: true })
  for (const v of Object.values(api)) if (typeof v === 'function' && 'mockReset' in v) v.mockReset()
  api.onAuthChange.mockReturnValue(() => {})
  api.hasSession.mockResolvedValue(false)
  api.fetchAll.mockResolvedValue({ accounts, categories, transactions: [] } satisfies Snapshot)
  api.insertTx.mockResolvedValue(undefined)
  api.updateTx.mockResolvedValue(undefined)
  api.deleteTx.mockResolvedValue(undefined)
  api.upsertTx.mockResolvedValue(undefined)
  vi.resetModules()
  store = await import('./store')
  store.useStore.setState({ auth: 'in', loaded: true, accounts, categories })
})
afterEach(() => vi.useRealTimers())

/**
 * 抽查用的日子：跨半年，覆盖还款日当天、前一天、后一天。
 * 以前每个情景只在 ym='2026-09' 这一帧上问一次，而白条的 bug 全部只在时间推进时才现形。
 */
const DAYS = [
  '2026-08-16', '2026-08-17', '2026-08-18',
  '2026-09-01', '2026-09-08', '2026-09-16', '2026-09-17', '2026-09-18',
  '2026-10-01', '2026-10-02', '2026-10-17', '2026-10-20',
  '2026-11-01', '2026-11-02', '2026-12-01', '2026-12-31', '2027-03-01',
]

/**
 * 每一步都要成立的铁律。前两条一直都在；**第三条是这次补的**，也正是三个白条 bug
 * 一起漏掉的那条：
 *
 *   「所有还没被抵掉的期」加起来 ≡ 这个账户的欠款余额，**换哪一天问都成立**。
 *
 * 它把「账单」和「余额」这两套本来各算各的东西钉在一起。提前还清之后账单还继续要钱、
 * 拼多多跨月还款不算数、京东逾期那期从账单里消失——三个都会当场违反它。
 * 旧测试没有这条，而且拿代码内部的 ym 当输入、每个情景只问一帧，等于让实现给自己判卷。
 */
function invariants(txs: Transaction[], days: readonly string[] = DAYS) {
  const bal = balances(txs, accounts)
  const { assets, credits } = splitAccounts(accounts)
  const assetTotal = assets.reduce((s, a) => s + (bal[a.id] ?? 0), 0)
  const creditTotal = credits.reduce((s, c) => s + (bal[c.id] ?? 0), 0)
  expect(totalOf(bal), '总额 ≠ 资产 + 白条').toBe(assetTotal + creditTotal)
  // debtOf 只数欠款：白条余额是正的（多还了、或者有退款）不算负债，也不能倒扣回去
  expect(debtOf(bal, credits), 'debtOf 的口径').toBe(-credits.reduce((s, c) => s + Math.min(0, bal[c.id] ?? 0), 0) || 0) // -0 也要归一，Object.is(-0, 0) 是 false
  for (const c of credits) {
    const owed = Math.max(0, -(bal[c.id] ?? 0))
    for (const d of days) {
      const b = creditBill(txs, c, d)
      const where = `${c.name} 在 ${d}`
      expect(b.rows.reduce((s, r) => s + r.due.amount, 0), `${where}：各行之和 ≠ 本期该还`).toBe(b.total)
      expect(b.left, `${where}：还差`).toBe(Math.max(0, b.total - b.paid))
      for (const r of [...b.rows, ...b.upcoming]) {
        expect(r.paid, `${where}：单期已还是负的`).toBeGreaterThanOrEqual(0)
        expect(r.paid, `${where}：单期已还超过这一期的金额`).toBeLessThanOrEqual(r.due.amount)
      }
      const unpaid = [...b.rows, ...b.upcoming].reduce((s, r) => s + r.due.amount - r.paid, 0)
      expect(unpaid, `${where}：未还合计 ≠ 欠款`).toBe(owed)
    }
  }
}

/** 这些情景里的「今天」。京东还款日 17 号，当天打开面板面对的就是今天要扣的这笔 */
const TODAY = '2026-09-17'

describe('真人使用：京东白条整体还', () => {
  it('下单 → 本月应还 → 全额还清 → 撤销，每一步账都对', async () => {
    const mouse = buy({ amount: 599 })
    const fan = buy({ amount: 6579 })
    expect(await st().addTx(mouse)).toBe(true)
    expect(await st().addTx(fan)).toBe(true)
    let txs = st().transactions
    invariants(txs)

    // 9/6 下单，京东 17 号还款 → 这个月就要还，不是下个月
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([[jd.id, 7178]])
    const bill = creditBill(txs, jd, TODAY)
    expect(bill.rows.map((r) => r.due.date)).toEqual(['2026-09-17', '2026-09-17'])
    expect(bill.total).toBe(7178)
    expect(balances(txs, accounts)[jd.id]).toBe(-7178)

    // 整体还：不勾具体哪几单（京东就是这么还的）
    const repay = pay({ amount: 7178 })
    expect(await st().addTx(repay)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(creditBill(txs, jd, TODAY).left).toBe(0)
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([]) // 还清了就不再列
    expect(balances(txs, accounts)[jd.id]).toBe(0)
    expect(balances(txs, accounts)[boc.id]).toBe(-7178)

    // 撤销这笔还款
    expect(await st().removeTx(repay.id)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([[jd.id, 7178]])
  })

  it('只还一部分：还差多少算得对，不会因为已还过就把剩下的也抹掉', async () => {
    await st().addTx(buy({ amount: 599 }))
    await st().addTx(buy({ amount: 6579 }))
    await st().addTx(pay({ amount: 599, date: '2026-09-10' }))
    const txs = st().transactions
    invariants(txs)
    const bill = creditBill(txs, jd, TODAY)
    expect(bill.total).toBe(7178)
    expect(bill.paid).toBe(599)
    expect(bill.left).toBe(6579)
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([[jd.id, 6579]])
  })
})

describe('真人使用：拼多多先用后付逐笔勾选', () => {
  it('勾选结清一单：那单消失，另一单还在，同一笔钱不会扣两次', async () => {
    const cup = buy({ account_id: pdd.id, date: '2026-09-01', amount: 1900 })
    const cable = buy({ account_id: pdd.id, date: '2026-09-03', amount: 900 })
    await st().addTx(cup)
    await st().addTx(cable)
    expect([...dueNow(st().transactions, [jd, pdd], TODAY)]).toEqual([[pdd.id, 2800]])

    // 平台扣了 19，勾上杯子
    const deduct = pay({ to_account_id: pdd.id, amount: 1900, date: '2026-09-08', settles: [cup.id] })
    expect(await st().addTx(deduct)).toBe(true)
    let txs = st().transactions
    invariants(txs)
    expect([...settledIds(txs)]).toEqual([cup.id])
    const bill = creditBill(txs, pdd, TODAY)
    expect(bill.rows.map((r) => r.tx.id)).toEqual([cable.id]) // 杯子不再列
    expect(bill.total).toBe(900)
    // 这一条最要紧：杯子已经被排除，那 19 块不能再从剩下的 9 块里扣一遍
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([[pdd.id, 900]])
    expect(balances(txs, accounts)[pdd.id]).toBe(-900)

    // 勾错了：改成结清数据线（面板上点那笔扣款进去改）
    expect(await st().editTx({ ...deduct, settles: [cable.id] })).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(creditBill(txs, pdd, TODAY).rows.map((r) => r.tx.id)).toEqual([cup.id])

    // 干脆删掉那笔扣款：结清关系跟着一起没，两单都回到未结清
    expect(await st().removeTx(deduct.id)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(settledIds(txs).size).toBe(0)
    expect(creditBill(txs, pdd, TODAY).rows.map((r) => r.tx.id).sort()).toEqual([cable.id, cup.id].sort())
    expect([...dueNow(txs, [jd, pdd], TODAY)]).toEqual([[pdd.id, 2800]])
  })
})

describe('真人使用：改一笔已经勾过结清的还款', () => {
  it('改勾选时，被这笔结清的订单要重新出现在账单里，否则取消都取消不了', async () => {
    const cup = buy({ account_id: pdd.id, date: '2026-09-01', amount: 1900 })
    const cable = buy({ account_id: pdd.id, date: '2026-09-03', amount: 900 })
    await st().addTx(cup)
    await st().addTx(cable)
    const deduct = pay({ to_account_id: pdd.id, amount: 1900, date: '2026-09-08', settles: [cup.id] })
    await st().addTx(deduct)
    const txs = st().transactions

    // 平时：杯子已结清，账单里没有它
    expect(creditBill(txs, pdd, TODAY).rows.map((r) => r.tx.id)).toEqual([cable.id])
    // 点进这笔扣款要改勾选时：杯子必须重新出现，否则界面上根本没有那个勾可以取消
    const editing = creditBill(txs, pdd, TODAY, deduct.id)
    expect(editing.rows.map((r) => r.tx.id).sort()).toEqual([cable.id, cup.id].sort())
    // 别的还款结清的不受影响
    expect(settledIds(txs, deduct.id).size).toBe(0)
  })

  it('从流水页改一笔还款的金额，不能把勾过的结清悄悄抹掉', async () => {
    const cup = buy({ account_id: pdd.id, amount: 1900 })
    await st().addTx(cup)
    const deduct = pay({ to_account_id: pdd.id, amount: 1900, settles: [cup.id] })
    await st().addTx(deduct)
    // 流水页改金额时会重建整条记录，settles 必须原样带回去
    expect(await st().editTx({ ...deduct, amount: 2000, settles: deduct.settles })).toBe(true)
    expect([...settledIds(st().transactions)]).toEqual([cup.id])
  })
})

describe('真人使用：删掉一笔还款再撤销', () => {
  it('删掉还款：被它结清的订单回到账单；撤销：结清关系原样回来', async () => {
    const cup = buy({ account_id: pdd.id, date: '2026-09-01', amount: 1900 })
    const cable = buy({ account_id: pdd.id, date: '2026-09-03', amount: 900 })
    await st().addTx(cup)
    await st().addTx(cable)
    const deduct = pay({ to_account_id: pdd.id, amount: 1900, date: '2026-09-08', settles: [cup.id] })
    await st().addTx(deduct)
    expect(creditBill(st().transactions, pdd, TODAY).rows.map((r) => r.tx.id)).toEqual([cable.id])

    // 面板里「删掉这笔还款」
    expect(await st().removeTx(deduct.id)).toBe(true)
    let txs = st().transactions
    invariants(txs)
    expect(settledIds(txs).size).toBe(0)
    expect(creditBill(txs, pdd, TODAY).rows.map((r) => r.tx.id).sort()).toEqual([cable.id, cup.id].sort())
    expect(balances(txs, accounts)[pdd.id]).toBe(-2800)

    // 撤销：原样加回去，id 和 settles 都不变
    expect(await st().addTx(deduct)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect([...settledIds(txs)]).toEqual([cup.id])
    expect(creditBill(txs, pdd, TODAY).rows.map((r) => r.tx.id)).toEqual([cable.id])
    expect(balances(txs, accounts)[pdd.id]).toBe(-900)
  })
})

describe('真人使用：花呗分期，时间往前走', () => {
  // 用户 2026-09-08 实测出来的那一串。还款日 1 号 → 9 月下的单第 1 期落在 10/1，
  // 旧口径按日历月算「9 月账单」，于是面板整块空白、金额栏兜底填了全部欠款。
  const order = () => buy({ account_id: hb.id, date: '2026-09-08', amount: 2000, installments: 3, created_at: stamp('2026-09-08') })

  it('9/8 下单当天打开：本期是 10/1 那一期，往后两期看得见但不算进本期', async () => {
    const o = order()
    expect(await st().addTx(o)).toBe(true)
    const txs = st().transactions
    invariants(txs)

    const b = creditBill(txs, hb, '2026-09-08')
    expect(b.dueDate).toBe('2026-10-01')
    expect(b.rows.map((r) => [r.due.seq, r.due.amount])).toEqual([[1, 666]])
    expect(b.total).toBe(666)
    expect(b.left).toBe(666)
    expect(b.upcoming.map((r) => [r.due.seq, r.due.date])).toEqual([
      [2, '2026-11-01'],
      [3, '2026-12-01'],
    ])
    // 面板金额栏预填的是本期该还，不是全部欠款
    expect([...dueNow(txs, [hb], '2026-09-08')]).toEqual([[hb.id, 666]])
    expect(balances(txs, accounts)[hb.id]).toBe(-2000)
  })

  it('9/8 提前还清 20 块：往后每个月打开都是已还清，不再冒出来', async () => {
    await st().addTx(order())
    const repay = pay({ to_account_id: hb.id, amount: 2000, date: '2026-09-08', created_at: stamp('2026-09-08') })
    expect(await st().addTx(repay)).toBe(true)
    const txs = st().transactions
    invariants(txs)

    expect(balances(txs, accounts)[hb.id]).toBe(0)
    // 当天：本期抵完，剩下的顶到后两期
    const now = creditBill(txs, hb, '2026-09-08')
    expect([now.left, now.prepaid]).toEqual([0, 1334])
    expect(now.upcoming.map((r) => r.paid)).toEqual([666, 668])
    // 之后每一期打开都是 0。这三条只要有一条红，就是「余额说已还清、账单说还差」那个 bug 回来了
    for (const d of ['2026-10-01', '2026-10-02', '2026-11-02', '2026-12-02', '2027-01-05']) {
      expect(creditBill(txs, hb, d).left, d).toBe(0)
      expect([...dueNow(txs, [hb], d)], d).toEqual([])
    }
  })

  it('只还 10 块：零头顶到下一期，逐月推进都对得上', async () => {
    await st().addTx(order())
    await st().addTx(pay({ to_account_id: hb.id, amount: 1000, date: '2026-09-08', created_at: stamp('2026-09-08') }))
    const txs = st().transactions
    invariants(txs)
    expect(balances(txs, accounts)[hb.id]).toBe(-1000)

    // 10/2：第 1 期已还完退场，本期换成第 2 期，它已经被顶掉 3.34
    const oct = creditBill(txs, hb, '2026-10-02')
    expect(oct.rows.map((r) => [r.due.seq, r.state])).toEqual([[2, 'current']])
    expect([oct.total, oct.paid, oct.left]).toEqual([666, 334, 332])
    // 11/2：第 2 期没还完的 332 变成逾期滚进来，和第 3 期一起
    const nov = creditBill(txs, hb, '2026-11-02')
    expect(nov.rows.map((r) => [r.due.seq, r.state])).toEqual([
      [2, 'overdue'],
      [3, 'current'],
    ])
    expect(nov.left).toBe(1000) // 正好等于欠款
  })

  it('拖着不还：逾期的期数一直滚进本期，不会从账单里消失', async () => {
    await st().addTx(order())
    const txs = st().transactions
    invariants(txs)
    // 2027 年 3 月再打开，三期全逾期，一条都没丢
    const late = creditBill(txs, hb, '2027-03-05')
    expect(late.rows.map((r) => [r.due.seq, r.state])).toEqual([
      [1, 'overdue'],
      [2, 'overdue'],
      [3, 'overdue'],
    ])
    expect([late.total, late.overdueTotal, late.left]).toEqual([2000, 2000, 2000])
    expect(late.upcoming).toEqual([])
  })
})

describe('真人使用：提前还款的三种还法', () => {
  // 花呗 20 元分 3 期，9/8 下单 → 10/1 ¥6.66、11/1 ¥6.66、12/1 ¥6.68
  const order = () => buy({ account_id: hb.id, date: '2026-09-08', amount: 2000, installments: 3, created_at: stamp('2026-09-08') })
  /** 面板上勾中的那几行加起来是多少——「金额跟着勾选自动变」的那个数 */
  const pickSum = (rows: { due: { amount: number } }[]) => rows.reduce((s, r) => s + r.due.amount, 0)

  it('只还本期一期：往后两期原样等着，不会被提前抵掉', async () => {
    await st().addTx(order())
    const b0 = creditBill(st().transactions, hb, '2026-09-08')
    // 面板默认只勾本期那一行，金额栏就是 6.66
    expect(pickSum(b0.rows)).toBe(666)
    await st().addTx(pay({ to_account_id: hb.id, amount: 666, date: '2026-09-08', created_at: stamp('2026-09-08') }))
    const txs = st().transactions
    invariants(txs)

    const b = creditBill(txs, hb, '2026-09-08')
    expect([b.left, b.prepaid]).toEqual([0, 0]) // 一分钱都没顶到后面去
    expect(b.upcoming.map((r) => r.paid)).toEqual([0, 0])
    expect(balances(txs, accounts)[hb.id]).toBe(-1334)
    // 10/2 打开：轮到第 2 期，一分没还
    const oct = creditBill(txs, hb, '2026-10-02')
    expect([oct.rows[0].due.seq, oct.total, oct.paid, oct.left]).toEqual([2, 666, 0, 666])
  })

  it('提前还一期：本期 + 往后勾一行，两期一起还，第三期还欠着', async () => {
    await st().addTx(order())
    const b0 = creditBill(st().transactions, hb, '2026-09-08')
    // 面板上勾本期那行 + 往后的第 1 行，金额自动变成两期之和
    const picked = [...b0.rows, b0.upcoming[0]]
    expect(pickSum(picked)).toBe(1332)
    await st().addTx(pay({ to_account_id: hb.id, amount: 1332, date: '2026-09-08', created_at: stamp('2026-09-08') }))
    const txs = st().transactions
    invariants(txs)

    const b = creditBill(txs, hb, '2026-09-08')
    expect([b.left, b.prepaid]).toEqual([0, 666])
    expect(b.upcoming.map((r) => [r.due.seq, r.paid])).toEqual([
      [2, 666], // 提前还掉了
      [3, 0],
    ])
    expect(balances(txs, accounts)[hb.id]).toBe(-668)
    // 10/2 打开：本期是第 2 期，已经提前还掉了
    expect(creditBill(txs, hb, '2026-10-02').left).toBe(0)
    // 11/2 打开：窗口推到 12/1，第 3 期成了本期，它还欠着 6.68（第 2 期已还完，退场）
    const nov = creditBill(txs, hb, '2026-11-02')
    expect([nov.rows.map((r) => [r.due.seq, r.state]), nov.left]).toEqual([[[3, 'current']], 668])
    // 12/2 打开：第 3 期变成逾期，还是那 6.68，不会翻倍也不会消失
    const dec = creditBill(txs, hb, '2026-12-02')
    expect([dec.rows.map((r) => [r.due.seq, r.state]), dec.left]).toEqual([[[3, 'overdue']], 668])
  })

  it('提前还全部：三行全勾，一次结清，往后每期打开都是 0', async () => {
    await st().addTx(order())
    const b0 = creditBill(st().transactions, hb, '2026-09-08')
    const picked = [...b0.rows, ...b0.upcoming]
    expect(pickSum(picked)).toBe(2000) // 全勾 = 整单欠款，一分不多一分不少
    await st().addTx(pay({ to_account_id: hb.id, amount: 2000, date: '2026-09-08', created_at: stamp('2026-09-08') }))
    const txs = st().transactions
    invariants(txs)

    expect(balances(txs, accounts)[hb.id]).toBe(0)
    const b = creditBill(txs, hb, '2026-09-08')
    expect([b.left, b.prepaid]).toEqual([0, 1334])
    expect(b.upcoming.every((r) => r.paid === r.due.amount)).toBe(true)
    for (const d of ['2026-10-01', '2026-10-02', '2026-11-02', '2026-12-02', '2027-06-01']) {
      expect(creditBill(txs, hb, d).left, d).toBe(0)
    }
  })

  it('提前还多了：余额变成正的，多的那部分不会凭空消失', async () => {
    await st().addTx(order())
    await st().addTx(pay({ to_account_id: hb.id, amount: 2500, date: '2026-09-08', created_at: stamp('2026-09-08') }))
    const txs = st().transactions
    invariants(txs)
    // 平台那边等于存了 5 块进去（有退款时会这样）
    expect(balances(txs, accounts)[hb.id]).toBe(500)
    const b = creditBill(txs, hb, '2026-09-08')
    expect([b.left, b.prepaid]).toEqual([0, 1334])
    expect([...dueNow(txs, [hb], '2026-09-08')]).toEqual([])
  })

  it('提前还了又反悔，删掉那笔还款：三期原样回来', async () => {
    await st().addTx(order())
    const repay = pay({ to_account_id: hb.id, amount: 2000, date: '2026-09-08', created_at: stamp('2026-09-08') })
    await st().addTx(repay)
    expect(creditBill(st().transactions, hb, '2026-12-02').left).toBe(0)

    expect(await st().removeTx(repay.id)).toBe(true)
    const txs = st().transactions
    invariants(txs)
    expect(balances(txs, accounts)[hb.id]).toBe(-2000)
    const b = creditBill(txs, hb, '2026-09-08')
    expect([b.left, b.prepaid]).toEqual([666, 0])
    expect(b.upcoming.map((r) => r.paid)).toEqual([0, 0])
  })
})

describe('真人使用：京东逾期没还，下个月打开', () => {
  it('9/17 那期拖到 10/20 还没还，必须还在账单里', async () => {
    // 旧口径 installmentPlan(...).find(p => p.ym === ym) 在 10 月找不到 9/17 那期，
    // 于是两笔从账单里凭空消失，只剩标题那个「欠 ¥71.78」
    await st().addTx(buy({ amount: 599, date: '2026-09-06' }))
    await st().addTx(buy({ amount: 6579, date: '2026-09-06' }))
    const txs = st().transactions
    invariants(txs)

    const b = creditBill(txs, jd, '2026-10-20')
    expect(b.dueDate).toBe('2026-11-17')
    expect(b.rows.every((r) => r.state === 'overdue')).toBe(true)
    expect([b.total, b.overdueTotal, b.left]).toEqual([7178, 7178, 7178])
    expect([...dueNow(txs, [jd], '2026-10-20')]).toEqual([[jd.id, 7178]])

    // 11/2 补还上：从最早一期往后顶，抵掉的正是逾期那两笔
    await st().addTx(pay({ amount: 7178, date: '2026-11-02', created_at: stamp('2026-11-02') }))
    const after = st().transactions
    invariants(after)
    expect(creditBill(after, jd, '2026-11-02').left).toBe(0)
    expect(balances(after, accounts)[jd.id]).toBe(0)
  })
})

describe('真人使用：拼多多跨月还款', () => {
  it('8/20 下单 8/25 还清，9 月不能再显示欠着', async () => {
    await st().addTx(buy({ account_id: pdd.id, date: '2026-08-20', amount: 1000, created_at: stamp('2026-08-20') }))
    await st().addTx(pay({ to_account_id: pdd.id, date: '2026-08-25', amount: 1000, created_at: stamp('2026-08-25') }))
    const txs = st().transactions
    invariants(txs)
    expect(balances(txs, accounts)[pdd.id]).toBe(0)
    for (const d of ['2026-08-26', '2026-09-15', '2026-12-31']) {
      expect(creditBill(txs, pdd, d).left, d).toBe(0)
      expect([...dueNow(txs, [pdd], d)], d).toEqual([])
    }
  })
})

describe('真人使用：京东还清本期之后当天再打白条', () => {
  it('9/9 还清 9/17 那期 → 当天下单排到 10/17 → 10 月再打开才要还', async () => {
    // 用户 2026-09-09 实测：京东那边算的是 10/17，而 App 原来算 9/17，
    // 面板会追着要一笔平台根本没要的钱
    const mouse = buy({ amount: 599, date: '2026-09-06', created_at: stamp('2026-09-06') })
    const fan = buy({ amount: 6579, date: '2026-09-06', created_at: stamp('2026-09-06') })
    await st().addTx(mouse)
    await st().addTx(fan)
    // 9/9 之前：本期该还 71.78，还没还过款
    const before = creditBill(st().transactions, jd, '2026-09-09')
    expect([before.dueDate, before.total, before.left]).toEqual(['2026-09-17', 7178, 7178])

    // 9/9 还清
    const repay = pay({ amount: 7178, date: '2026-09-09', created_at: stamp('2026-09-09') })
    expect(await st().addTx(repay)).toBe(true)
    // 9/9 当天再打白条
    const fresh = buy({ amount: 3000, date: '2026-09-09', created_at: stamp('2026-09-09') })
    expect(await st().addTx(fresh)).toBe(true)
    const txs = st().transactions
    invariants(txs)

    const b = creditBill(txs, jd, '2026-09-09')
    expect([b.total, b.paid, b.left]).toEqual([7178, 7178, 0]) // 本期清了，面板不再要钱
    expect(b.upcoming.map((r) => [r.tx.id, r.due.date])).toEqual([[fresh.id, '2026-10-17']])
    expect(balances(txs, accounts)[jd.id]).toBe(-3000) // 但钱确实还欠着

    // 10 月打开：新单成了本期
    const oct = creditBill(txs, jd, '2026-10-05')
    expect([oct.dueDate, oct.total, oct.left]).toEqual(['2026-10-17', 3000, 3000])
    expect([...dueNow(txs, [jd], '2026-10-05')]).toEqual([[jd.id, 3000]])
  })

  it('把那笔还款删掉，顺延跟着撤销——到期日只由流水决定', async () => {
    const repay = pay({ amount: 1000, date: '2026-09-09', created_at: stamp('2026-09-09') })
    await st().addTx(repay)
    const fresh = buy({ amount: 3000, date: '2026-09-09', created_at: stamp('2026-09-09') })
    await st().addTx(fresh)
    expect(creditBill(st().transactions, jd, '2026-09-09').upcoming[0].due.date).toBe('2026-10-17')

    expect(await st().removeTx(repay.id)).toBe(true)
    const txs = st().transactions
    invariants(txs)
    expect(creditBill(txs, jd, '2026-09-09').rows[0].due.date).toBe('2026-09-17')
  })

  it('拼多多和花呗不受影响：开关只在京东上开着', async () => {
    await st().addTx(pay({ to_account_id: pdd.id, amount: 500, date: '2026-09-05', created_at: stamp('2026-09-05') }))
    const p1 = buy({ account_id: pdd.id, amount: 900, date: '2026-09-09', created_at: stamp('2026-09-09') })
    await st().addTx(p1)
    const txs = st().transactions
    invariants(txs)
    // 拼多多没有还款日，到期日就是下单日，还过款也不顺延
    expect(creditBill(txs, pdd, '2026-09-09').rows.map((r) => r.due.date)).toEqual(['2026-09-09'])
  })
})

describe('真人使用：导出、导入、备份格式', () => {
  it('带 settles 和 repay_day 的账本，导出再导入逐字段一致', async () => {
    const cup = buy({ account_id: pdd.id, amount: 1900 })
    await st().addTx(cup)
    await st().addTx(pay({ to_account_id: pdd.id, amount: 1900, settles: [cup.id] }))
    await st().addTx(buy({ amount: 60000, installments: 6 }))
    const snap: Snapshot = { accounts, categories, transactions: st().transactions }

    const back = parseImport(buildJson(snap, { synced: true, lastSync: null }))
    expect(back.accounts).toEqual(accounts) // repay_day 要原样回来
    expect(back.transactions.find((t) => t.settles)?.settles).toEqual([cup.id])
    expect(back.transactions.find((t) => t.installments === 6)).toBeTruthy()
    // 金额必须还是整数分。这里错一次就是全库金额变成百分之一
    expect(back.transactions.every((t) => Number.isInteger(t.amount))).toBe(true)
    invariants(back.transactions)
  })

  it('CSV 导出不炸，分期和结清都有列', async () => {
    const cup = buy({ account_id: pdd.id, amount: 1900 })
    await st().addTx(cup)
    await st().addTx(pay({ to_account_id: pdd.id, amount: 1900, settles: [cup.id] }))
    await st().addTx(buy({ amount: 60000, installments: 6 }))
    const csv = buildCsv({ accounts, categories, transactions: st().transactions })
    const head = csv.split('\n')[0]
    expect(head).toContain('分期')
    expect(head).toContain('结清')
    expect(csv).toContain('6期')
    expect(csv).toContain('1单')
  })
})

describe('真人使用：地铁里没网', () => {
  it('断网记一笔白条 → 留在界面和账单里 → 联网自动补传', async () => {
    api.insertTx.mockRejectedValueOnce(Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }))
    const t = buy({ amount: 6579 })
    expect(await st().addTx(t)).toBe(true) // 对用户来说这笔账已经记下了
    expect(st().outboxCount).toBe(1)
    // 没网也照样能看本月应还
    expect([...dueNow(st().transactions, [jd, pdd], TODAY)]).toEqual([[jd.id, 6579]])
    invariants(st().transactions)

    // 网回来了：refresh 拉回的快照里还没有这笔，不能被冲掉，然后自动补传
    api.fetchAll.mockResolvedValueOnce({ accounts, categories, transactions: [] })
    await st().refresh()
    expect(st().transactions.map((x) => x.id)).toContain(t.id)
    await vi.waitFor(() => expect(st().outboxCount).toBe(0))
    expect(api.upsertTx).toHaveBeenCalledTimes(1)
  })
})
