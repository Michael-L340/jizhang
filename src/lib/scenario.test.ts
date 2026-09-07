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

import { balances, debtOf, dueInMonth, monthBill, settledIds, splitAccounts, totalOf } from './compute'
import { buildCsv, buildJson, parseImport } from './csv'

const A = (id: string, name: string, kind: Account['kind'], sort: number, repay_day: number | null = null): Account => ({ id, name, kind, sort, is_archived: false, repay_day })
const boc = A('00000000-0000-4000-8000-000000000001', '中国银行', 'bank', 1)
const jd = A('00000000-0000-4000-8000-000000000002', '京东白条', 'credit', 5, 17)
const pdd = A('00000000-0000-4000-8000-000000000003', '拼多多', 'credit', 7, null)
const accounts = [boc, jd, pdd]
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

/** 每一步都要成立的两条铁律：余额只来自流水；账单各行之和 = 本月该还 */
function invariants(txs: Transaction[], ym = '2026-09') {
  const bal = balances(txs, accounts)
  const { assets, credits } = splitAccounts(accounts)
  const assetTotal = assets.reduce((s, a) => s + (bal[a.id] ?? 0), 0)
  expect(totalOf(bal)).toBe(assetTotal - debtOf(bal, credits))
  for (const c of credits) {
    const bill = monthBill(txs, c, ym)
    expect(bill.rows.reduce((s, r) => s + r.due.amount, 0)).toBe(bill.total)
    expect(bill.left).toBe(Math.max(0, bill.total - bill.paid))
  }
}

describe('真人使用：京东白条整体还', () => {
  it('下单 → 本月应还 → 全额还清 → 撤销，每一步账都对', async () => {
    const mouse = buy({ amount: 599 })
    const fan = buy({ amount: 6579 })
    expect(await st().addTx(mouse)).toBe(true)
    expect(await st().addTx(fan)).toBe(true)
    let txs = st().transactions
    invariants(txs)

    // 9/6 下单，京东 17 号还款 → 这个月就要还，不是下个月
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([[jd.id, 7178]])
    const bill = monthBill(txs, jd, '2026-09')
    expect(bill.rows.map((r) => r.due.date)).toEqual(['2026-09-17', '2026-09-17'])
    expect(bill.total).toBe(7178)
    expect(balances(txs, accounts)[jd.id]).toBe(-7178)

    // 整体还：不勾具体哪几单（京东就是这么还的）
    const repay = pay({ amount: 7178 })
    expect(await st().addTx(repay)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(monthBill(txs, jd, '2026-09').left).toBe(0)
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([]) // 还清了就不再列
    expect(balances(txs, accounts)[jd.id]).toBe(0)
    expect(balances(txs, accounts)[boc.id]).toBe(-7178)

    // 撤销这笔还款
    expect(await st().removeTx(repay.id)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([[jd.id, 7178]])
  })

  it('只还一部分：还差多少算得对，不会因为已还过就把剩下的也抹掉', async () => {
    await st().addTx(buy({ amount: 599 }))
    await st().addTx(buy({ amount: 6579 }))
    await st().addTx(pay({ amount: 599, date: '2026-09-10' }))
    const txs = st().transactions
    invariants(txs)
    const bill = monthBill(txs, jd, '2026-09')
    expect(bill.total).toBe(7178)
    expect(bill.paid).toBe(599)
    expect(bill.left).toBe(6579)
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([[jd.id, 6579]])
  })
})

describe('真人使用：拼多多先用后付逐笔勾选', () => {
  it('勾选结清一单：那单消失，另一单还在，同一笔钱不会扣两次', async () => {
    const cup = buy({ account_id: pdd.id, date: '2026-09-01', amount: 1900 })
    const cable = buy({ account_id: pdd.id, date: '2026-09-03', amount: 900 })
    await st().addTx(cup)
    await st().addTx(cable)
    expect([...dueInMonth(st().transactions, [jd, pdd], '2026-09')]).toEqual([[pdd.id, 2800]])

    // 平台扣了 19，勾上杯子
    const deduct = pay({ to_account_id: pdd.id, amount: 1900, date: '2026-09-08', settles: [cup.id] })
    expect(await st().addTx(deduct)).toBe(true)
    let txs = st().transactions
    invariants(txs)
    expect([...settledIds(txs)]).toEqual([cup.id])
    const bill = monthBill(txs, pdd, '2026-09')
    expect(bill.rows.map((r) => r.tx.id)).toEqual([cable.id]) // 杯子不再列
    expect(bill.total).toBe(900)
    // 这一条最要紧：杯子已经被排除，那 19 块不能再从剩下的 9 块里扣一遍
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([[pdd.id, 900]])
    expect(balances(txs, accounts)[pdd.id]).toBe(-900)

    // 勾错了：改成结清数据线（面板上点那笔扣款进去改）
    expect(await st().editTx({ ...deduct, settles: [cable.id] })).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(monthBill(txs, pdd, '2026-09').rows.map((r) => r.tx.id)).toEqual([cup.id])

    // 干脆删掉那笔扣款：结清关系跟着一起没，两单都回到未结清
    expect(await st().removeTx(deduct.id)).toBe(true)
    txs = st().transactions
    invariants(txs)
    expect(settledIds(txs).size).toBe(0)
    expect(monthBill(txs, pdd, '2026-09').rows.map((r) => r.tx.id).sort()).toEqual([cable.id, cup.id].sort())
    expect([...dueInMonth(txs, [jd, pdd], '2026-09')]).toEqual([[pdd.id, 2800]])
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
    expect(monthBill(txs, pdd, '2026-09').rows.map((r) => r.tx.id)).toEqual([cable.id])
    // 点进这笔扣款要改勾选时：杯子必须重新出现，否则界面上根本没有那个勾可以取消
    const editing = monthBill(txs, pdd, '2026-09', deduct.id)
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
    expect([...dueInMonth(st().transactions, [jd, pdd], '2026-09')]).toEqual([[jd.id, 6579]])
    invariants(st().transactions)

    // 网回来了：refresh 拉回的快照里还没有这笔，不能被冲掉，然后自动补传
    api.fetchAll.mockResolvedValueOnce({ accounts, categories, transactions: [] })
    await st().refresh()
    expect(st().transactions.map((x) => x.id)).toContain(t.id)
    await vi.waitFor(() => expect(st().outboxCount).toBe(0))
    expect(api.upsertTx).toHaveBeenCalledTimes(1)
  })
})
