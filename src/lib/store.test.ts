// store 的并发与缓存行为测试。
//
// 这些场景（S3/S4/S2）以前只能在手机上手动复现：记一笔立刻切走再切回、撤销失败、
// 缓存写满。它们全是纯数据层的时序问题，把 api.ts 换成可控的假实现就能在这里精确重放，
// 不需要浏览器，也不需要真的联网。
import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Category, FacadeAdjust, MeterReading, Snapshot, Transaction } from '../types'
import { CACHE_LIMIT_BYTES, IDB_LIMIT_BYTES } from './backup'
import { DB_NAME, LEDGER_KEY, LEGACY_KEY, OPEN_TIMEOUT_MS, OUTBOX_KEY, STORE } from './cache'

// ---------- 假的 api.ts ----------
// vi.hoisted 保证这个对象在 vi.mock 提升后仍是同一个引用，resetModules 之后也不会换。
const api = vi.hoisted(() => ({
  fetchAll: vi.fn(),
  insertTx: vi.fn(),
  updateTx: vi.fn(),
  deleteTx: vi.fn(),
  addCategory: vi.fn(),
  updateCategory: vi.fn(),
  updateAccount: vi.fn(),
  insertFacadeAdjust: vi.fn(),
  insertMeterReading: vi.fn(),
  deleteMeterReading: vi.fn(),
  importAll: vi.fn(),
  wipeAll: vi.fn(),
  fetchBackupStatus: vi.fn(),
  signIn: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  hasSession: vi.fn(),
  hasStoredSession: vi.fn(() => false),
  onAuthChange: vi.fn(() => () => {}),
  upsertTx: vi.fn(),
  friendlyError: (e: unknown) => String((e as { message?: string })?.message ?? e),
  // 和真的 api.ts 保持同一套判据：带 23xxx/42xxx 错误码的才是「数据被拒」，其余一律可重传
  isPermanentError: (e: unknown) => /^(22|23|42)/.test(String((e as { code?: string })?.code ?? '')),
  isDuplicateName: (e: unknown) => (e as { code?: string })?.code === '23505' || /duplicate key/i.test(String((e as { message?: string })?.message ?? e)),
  configured: true,
}))
vi.mock('./api', () => api)

// ---------- 假的 localStorage ----------
// node 环境没有 localStorage。limitChars 用来模拟配额写满。
class FakeStorage {
  map = new Map<string, string>()
  limitChars = Infinity
  writes = 0
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.writes++
    if (v.length > this.limitChars) {
      const e = new Error('QuotaExceededError')
      e.name = 'QuotaExceededError'
      throw e
    }
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

let ls: FakeStorage

// ---------- 假的 IndexedDB ----------
// fake-indexeddb 在内存里完整实现了 IndexedDB 的语义（事务顺序、异步回调），每个用例换一个全新的库。
// 它靠 setImmediate 推进，所以下面的假定时器**故意不假 setImmediate**，否则 await 一次 open 就永远回不来；
// 代价是推进完假定时器之后要再 drain() 一下，让它的回调跑完。
let putSpy: MockInstance

/** 让 fake-indexeddb 的回调跑完（它走真的 setImmediate，不归假定时器管） */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))
}

/** 越过 500ms 去抖，再让 IndexedDB 的回调跑完 */
async function flushed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(600)
  await drain()
}

function openTestDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/** IndexedDB 里那份账本的原文；没有就是 null */
async function idbGet(): Promise<string | null> {
  await drain()
  const db = await openTestDb()
  try {
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(LEDGER_KEY)
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null)
      r.onerror = () => reject(r.error)
    })
  } finally {
    db.close()
  }
}

async function idbSet(json: string): Promise<void> {
  const db = await openTestDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite')
      t.objectStore(STORE).put(json, LEDGER_KEY)
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  } finally {
    db.close()
  }
}

/** IndexedDB 里那份账本，解析好的 */
async function cached(): Promise<Record<string, any>> {
  const raw = await idbGet()
  expect(raw).not.toBeNull()
  return JSON.parse(raw as string) as Record<string, any>
}

/**
 * 让 IndexedDB 的写入失败，按真实浏览器报配额满的方式：put 本身不抛，事务提交时 abort、tx.error 是 QuotaExceededError
 * （以前这里让 put 同步抛错，done() 等 abort 的那条路就一条用例都没走到，审查 F37）
 */
function failWrites(): void {
  const orig = putSpy.getMockImplementation() ?? null
  putSpy.mockRestore()
  const real = IDBObjectStore.prototype.put
  putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const r = real.apply(this, args)
    ;(this.transaction as unknown as { _abort: (n: string) => void })._abort('QuotaExceededError')
    return r
  })
  void orig
}

/** 这条键里的待传队列（jz_outbox_v1 存的是 {at, entries}） */
function outboxIds(): string[] {
  const f = JSON.parse(ls.getItem(OUTBOX_KEY)!) as { entries: [string, unknown][] }
  return f.entries.map(([id]) => id)
}

function allowWrites(): void {
  putSpy.mockRestore()
  putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')
}

/** 换掉 indexedDB 全局：undefined = 旧浏览器没有；传对象 = 自定义的假实现 */
function setIndexedDB(v: unknown): void {
  Object.defineProperty(globalThis, 'indexedDB', { value: v, configurable: true, writable: true })
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // 挂个空 catch，免得 reject 前 vitest 报 unhandled rejection
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return {
    id,
    date: '2026-09-04',
    type: 'expense',
    amount: 1000,
    account_id: 'acc1',
    to_account_id: null,
    category_id: 'cat1',
    note: null,
    installments: null,
    settles: null,
    hidden: null,
    created_at: '2026-09-04T02:00:00.000Z',
    ...over,
  }
}

function cat(id: string, over: Partial<Category> = {}): Category {
  return { id, kind: 'expense', parent_id: null, name: id, icon: null, sort: 1, is_archived: false, note: null, ...over }
}

function snap(transactions: Transaction[] = [], categories: Category[] = []): Snapshot {
  return { accounts: [], categories, transactions, facade_adjusts: [], meter_readings: [] }
}

function fa(id: string, cents = -800000): FacadeAdjust {
  return { id, account_id: 'acc1', date: '2026-09-27', cents, created_at: '2026-09-27T02:00:00.000Z' }
}

function mr(id: string, centi_kwh = 339340): MeterReading {
  return { id, read_at: '2026-10-03T13:40:00.000Z', centi_kwh, created_at: '2026-10-03T13:40:05.000Z' }
}

let store: typeof import('./store')
const st = () => store.useStore.getState()
const ids = () => st().transactions.map((t) => t.id)

// 写入失败分两类，走的是完全不同的两条路，测试里必须挑明是哪一类：
//   offline() 没网 —— 记录留在界面上并进待传队列，返回 true（离线记账）
//   denied()  数据被服务器拒 —— 回滚并报错，返回 false（带 23xxx/42xxx 错误码）
const offline = () => Object.assign(new Error('Failed to fetch'), { name: 'TypeError' })
const denied = () => Object.assign(new Error('violates foreign key constraint'), { code: '23503' })

beforeEach(async () => {
  // 不假 setImmediate：fake-indexeddb 靠它推进（见上）
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  ls = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  setIndexedDB(new IDBFactory())
  putSpy = vi.spyOn(IDBObjectStore.prototype, 'put')

  for (const v of Object.values(api)) if (typeof v === 'function' && 'mockReset' in v) v.mockReset()
  api.onAuthChange.mockReturnValue(() => {})
  api.hasSession.mockResolvedValue(false)
  api.fetchAll.mockResolvedValue(snap())
  api.fetchBackupStatus.mockResolvedValue(null)

  // 每个用例拿一份全新的 store 模块：pendingTx / persistTimer 都是模块级单例
  vi.resetModules()
  store = await import('./store')
  store.useStore.setState({ auth: 'in', loaded: true })
})

afterEach(() => {
  putSpy.mockRestore()
  vi.useRealTimers()
})

// ══════════════════════════════════════════════════════════════
// S4 —— refresh 不能冲掉还在飞的写入
//   手工复现方式：记一笔 → 立刻切去别的 App → 切回来（触发 refresh）
// ══════════════════════════════════════════════════════════════
describe('S4 在途写入不被 refresh 冲掉', () => {
  it('新增还在飞时，服务端快照里没有它，落地后它必须还在', async () => {
    const d = deferred<void>()
    api.insertTx.mockReturnValueOnce(d.promise)
    api.fetchAll.mockResolvedValueOnce(snap([])) // 服务端还没看到这笔

    const p = st().addTx(tx('t1'))
    await st().refresh()
    expect(ids()).toContain('t1') // 修复前这里会是空数组

    d.resolve()
    expect(await p).toBe(true)
  })

  it('删除还在飞时，服务端快照里还有它，落地后它必须仍是删掉的', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    const d = deferred<void>()
    api.deleteTx.mockReturnValueOnce(d.promise)
    api.fetchAll.mockResolvedValueOnce(snap([tx('t1')])) // 服务端还没删完

    const p = st().removeTx('t1')
    await st().refresh()
    expect(ids()).not.toContain('t1') // 修复前这条会「复活」

    d.resolve()
    expect(await p).toBe(true)
  })

  it('修改还在飞时，服务端快照是旧值，落地后必须是新值', async () => {
    store.useStore.setState({ transactions: [tx('t1', { amount: 1000 })] })
    const d = deferred<void>()
    api.updateTx.mockReturnValueOnce(d.promise)
    api.fetchAll.mockResolvedValueOnce(snap([tx('t1', { amount: 1000 })]))

    const p = st().editTx(tx('t1', { amount: 8888 }))
    await st().refresh()
    expect(st().transactions[0].amount).toBe(8888) // 修复前会被打回 1000

    d.resolve()
    expect(await p).toBe(true)
  })

  it('新建分类时已经在飞的同步不会把它冲掉，之后的同步以服务端为准', async () => {
    const d = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(d.promise) // GET 先出门，此刻服务端还没有这个分类
    const rp = st().refresh()

    api.addCategory.mockResolvedValueOnce(cat('new1', { name: '新分类' }))
    await st().addCategory('expense', null, '新分类')

    d.resolve(snap([], []))
    await rp
    expect(st().categories.map((c) => c.id)).toContain('new1')

    // 而在它建好之后才出门的同步是权威的：说没有就是真没有（比如另一台设备删了）
    api.fetchAll.mockResolvedValueOnce(snap([], []))
    await st().refresh()
    expect(st().categories.map((c) => c.id)).not.toContain('new1')
  })

  it('写入完成之后，补丁必须撤销：服务端说没有就是没有', async () => {
    api.insertTx.mockResolvedValueOnce(undefined)
    await st().addTx(tx('t1'))
    expect(ids()).toContain('t1')

    // 另一台设备删了它
    api.fetchAll.mockResolvedValueOnce(snap([]))
    await st().refresh()
    expect(ids()).not.toContain('t1')
  })
})

// ══════════════════════════════════════════════════════════════
// S3 —— 失败回滚只能动自己那一条
//   手工复现方式：点撤销后立刻再记一笔，而撤销的请求失败了
// ══════════════════════════════════════════════════════════════
describe('S3 失败回滚不牵连并发操作', () => {
  it('新增失败只撤掉自己，期间成功的另一笔要留着', async () => {
    const d = deferred<void>()
    api.insertTx.mockReturnValueOnce(d.promise) // t1 会失败
    api.insertTx.mockResolvedValueOnce(undefined) // t2 成功

    const p1 = st().addTx(tx('t1'))
    const p2 = st().addTx(tx('t2'))
    expect(await p2).toBe(true)

    d.reject(denied())
    expect(await p1).toBe(false)
    expect(ids()).toEqual(['t2']) // 修复前整个数组被打回，t2 一起没了
  })

  it('删除失败时插回自己，期间新记的那笔要留着', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    const d = deferred<void>()
    api.deleteTx.mockReturnValueOnce(d.promise)
    api.insertTx.mockResolvedValueOnce(undefined)

    const p1 = st().removeTx('t1') // 撤销
    expect(await st().addTx(tx('t2'))).toBe(true) // 立刻再记一笔

    d.reject(denied())
    expect(await p1).toBe(false)
    expect(ids().sort()).toEqual(['t1', 't2']) // 修复前 t2 会被抹掉
  })

  it('删除失败时如果 refresh 已经把它拉回来了，不能插成两条', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    const d = deferred<void>()
    api.deleteTx.mockReturnValueOnce(d.promise)

    const p = st().removeTx('t1')
    // 模拟 refresh 之外的路径把它放了回来（在途补丁已被清掉的极端时序）
    store.useStore.setState({ transactions: [tx('t1')] })

    d.reject(denied())
    await p
    expect(ids().filter((x) => x === 't1')).toHaveLength(1)
  })

  it('修改失败换回旧值，不能把已被删掉的那条复活', async () => {
    store.useStore.setState({ transactions: [tx('t1', { amount: 1000 })] })
    const d = deferred<void>()
    api.updateTx.mockReturnValueOnce(d.promise)

    const p = st().editTx(tx('t1', { amount: 8888 }))
    // 另一条路径把它删了
    store.useStore.setState({ transactions: [] })

    d.reject(denied())
    expect(await p).toBe(false)
    expect(ids()).toEqual([]) // 若回滚写成 insert，这里会冒出一条僵尸记录
  })

  it('修改失败换回的是旧值，不是新值', async () => {
    store.useStore.setState({ transactions: [tx('t1', { amount: 1000 })] })
    api.updateTx.mockRejectedValueOnce(denied())
    expect(await st().editTx(tx('t1', { amount: 8888 }))).toBe(false)
    expect(st().transactions[0].amount).toBe(1000)
  })
})

// ══════════════════════════════════════════════════════════════
// S2 —— 本机缓存
// ══════════════════════════════════════════════════════════════
describe('S2 本机缓存（账本在 IndexedDB）', () => {
  it('连续三次写入只落一次盘（500ms 尾部去抖）', async () => {
    api.insertTx.mockResolvedValue(undefined)
    await st().addTx(tx('t1'))
    await st().addTx(tx('t2'))
    await st().addTx(tx('t3'))
    await drain()
    expect(putSpy).toHaveBeenCalledTimes(0) // 去抖窗口内一次都不写
    await flushed()
    expect(putSpy).toHaveBeenCalledTimes(1)
    expect((await cached()).transactions).toHaveLength(3)
  })

  it('只写数据表和时间戳，不把 auth/toast/syncing/队列 一起写进去', async () => {
    st().showToast('随便一句')
    st().persist()
    await flushed()
    expect(Object.keys(await cached()).sort()).toEqual(['accounts', 'at', 'categories', 'facade_adjusts', 'meter_readings', 'transactions'])
  })

  it('缓存占用按 UTF-16 算：(键长 + 值长) × 2', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await flushed()
    expect(st().cacheBytes).toBe((LEDGER_KEY.length + (await idbGet())!.length) * 2)
  })

  it('写满时标记降级并只提示一次', async () => {
    failWrites()
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await flushed()
    expect(st().cacheDegraded).toBe(true)
    const firstToast = st().toast
    expect(firstToast?.msg).toContain('缓存写不进去')

    st().persist()
    await flushed()
    expect(st().toast?.id).toBe(firstToast?.id) // 没有弹第二次
  })

  it('写通了要把降级标记清掉', async () => {
    failWrites()
    st().persist()
    await flushed()
    expect(st().cacheDegraded).toBe(true)

    allowWrites()
    st().persist()
    await flushed()
    expect(st().cacheDegraded).toBe(false)
    expect(await idbGet()).not.toBeNull()
  })

  it('队列写不进 localStorage（满了）：单独标出来，提示不能说「已存在本机」，账本写成功也不许把它清掉', async () => {
    // 审查 F3/F35：以前和账本共用 cacheDegraded，提示当场被「已存在本机」盖掉，半秒后标记又被账本写成功清掉。
    // 变异：offlineToast 不看 saved → 第二句红；persist 成功回调顺手清 outboxUnsaved → 第三句红
    ls.limitChars = 10
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    expect(st().outboxUnsaved).toBe(true)
    expect(st().toast?.msg).not.toContain('已存在本机')
    await flushed() // 账本照样写进了 IndexedDB
    expect(await idbGet()).not.toBeNull()
    expect(st().outboxUnsaved).toBe(true)

    ls.limitChars = Infinity
    api.upsertTx.mockRejectedValueOnce(offline()) // 补传还是没网，但这次队列存得进了
    await st().flushOutbox()
    expect(st().outboxUnsaved).toBe(false)
    expect(outboxIds()).toEqual(['t1'])
  })

  it('退出登录要取消在途的去抖写入，缓存不能又被写回来；两边的键都要删', async () => {
    // 队列里先放一笔：jz_outbox_v1 不存在的话「删没删」根本测不出来（审查 F36）。变异：signOut 里去掉 removeOutboxDump() → 红
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t0'))
    expect(ls.getItem(OUTBOX_KEY)).not.toBeNull()
    api.signOut.mockResolvedValueOnce(undefined)
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await flushed() // 先真的写进去一份
    expect(await idbGet()).not.toBeNull()
    ls.map.set(LEGACY_KEY, '{}')
    st().persist() // 定时器已排上
    await st().signOut()
    await flushed()
    expect(await idbGet()).toBeNull()
    expect(ls.getItem(LEGACY_KEY)).toBeNull()
    expect(ls.getItem(OUTBOX_KEY)).toBeNull()
  })

  it('退出前最后一次写入还在路上，删一定落在它后面，上一个账号的账本不能留在机器上', async () => {
    // 变异：cache.ts 的 removeLedger 不排队（直接 await openDb 再删）→ 写入排在删之后落地，红
    api.signOut.mockResolvedValueOnce(undefined)
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await vi.advanceTimersByTimeAsync(600) // 去抖到点，写入刚出发（open 还没回来）
    await st().signOut()
    await drain()
    expect(await idbGet()).toBeNull()
    // 那次写入落地时也不许再碰 state（它写的是上一个账号的账本）。变异：persist 里去掉 gen !== cacheGen 的判断 → 红
    expect(st().cacheBytes).toBe(0)
  })

  it('缓存里缺 categories 就整份作废，不能让页面拿到 undefined', async () => {
    await idbSet(JSON.stringify({ accounts: [], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    await st().init()
    expect(st().transactions).toEqual([])
    expect(st().categories).toEqual([])
  })

  it('老缓存里没有 hidden 这一列，读出来要补成 null，不能是 undefined', async () => {
    // 变异：parseCache 里去掉 `hidden: t.hidden ?? null` → 这条红。
    // undefined 会顺着 editTx 走到 txToRow，PostgREST 对 undefined 字段的处理和 null 不一样，保守起见统一成 null
    const old = { ...tx('t1') } as Record<string, unknown>
    delete old.hidden
    await idbSet(JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [old], at: '2026-09-04T00:00:00.000Z' }))
    await st().init()
    expect(st().transactions[0].hidden).toBeNull()
  })

  it('缓存完整时冷启动直接用它渲染', async () => {
    await idbSet(JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    await st().init()
    expect(ids()).toEqual(['t1'])
    expect(st().lastSync).toBe('2026-09-04T00:00:00.000Z')
    expect(st().cacheBytes).toBeGreaterThan(0)
  })

  it('冷启动把队列叠在缓存账本上：账本那份没来得及写的照样显示，队列里标删除的不显示', async () => {
    // 账本和队列分开落盘，哪份新不一定。变异：init 里 transactions 直接用 cache.transactions → 红
    await idbSet(JSON.stringify({ accounts: [], categories: [], transactions: [tx('t2')], facade_adjusts: [], meter_readings: [], at: '2026-10-08T00:00:00.000Z' }))
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-08T00:00:00.000Z', entries: [['t1', tx('t1')], ['t2', '__deleted__']] }))
    await st().init()
    expect(ids()).toEqual(['t1'])
    expect(st().outboxCount).toBe(2)
  })

  it('用 IndexedDB 时上限暂定 5 GiB；浏览器报的配额更小就按浏览器的，问不到就按 5 GiB', async () => {
    // 变异：noteBackend 不取 min → 第一段红；问不到时给 null → 第二段红
    const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: { storage: { estimate: async () => ({ quota: 123_456_789, usage: 1 }) } }, configurable: true, writable: true })
    try {
      await st().init()
      await drain()
      expect(st().cacheQuota).toBe(123_456_789)
      Object.defineProperty(globalThis, 'navigator', { value: { storage: { estimate: async () => ({ quota: 64 * 1024 ** 3 }) } }, configurable: true, writable: true })
      vi.resetModules()
      const again = await import('./store')
      await again.useStore.getState().init()
      await drain()
      expect(again.useStore.getState().cacheQuota).toBe(IDB_LIMIT_BYTES)
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true, writable: true })
      vi.resetModules()
      const third = await import('./store')
      await third.useStore.getState().init()
      await drain()
      expect(third.useStore.getState().cacheQuota).toBe(IDB_LIMIT_BYTES)
    } finally {
      if (nav) Object.defineProperty(globalThis, 'navigator', nav)
      else delete (globalThis as { navigator?: unknown }).navigator
    }
  })

})

// ══════════════════════════════════════════════════════════════
// 缓存搬家：1.3.30 及以前整份账本（连同待传队列）在 localStorage 的 jz_cache_v1 里。
// 升级后第一次打开要把账本接过来写进 IndexedDB、把队列写成自己的键，老的那份要等两样都稳了才删。
// ══════════════════════════════════════════════════════════════
describe('缓存搬家（localStorage → IndexedDB）', () => {
  const legacy = () => ({
    accounts: [],
    categories: [cat('c1')],
    transactions: [tx('t1')],
    facade_adjusts: [],
    meter_readings: [],
    at: '2026-10-08T00:00:00.000Z',
    outbox: [['t1', tx('t1')]],
  })

  it('老缓存还在 localStorage 里：账本和包在里面的队列都接过来，队列当场写成自己的键', async () => {
    ls.map.set(LEGACY_KEY, JSON.stringify(legacy()))
    await st().init()
    expect(ids()).toEqual(['t1'])
    expect(st().outboxCount).toBe(1)
    // 变异：init 里去掉 `if (!dump.found) saveOutbox()` → 红
    expect(JSON.parse(ls.getItem(OUTBOX_KEY)!).entries).toEqual([['t1', tx('t1')]])
  })

  it('第一次写进 IndexedDB 之后才删老缓存', async () => {
    ls.map.set(LEGACY_KEY, JSON.stringify(legacy()))
    await st().init()
    expect(ls.getItem(LEGACY_KEY)).not.toBeNull() // 还没写过新的，不能删
    st().persist()
    await flushed()
    expect((await cached()).transactions).toHaveLength(1)
    expect(ls.getItem(LEGACY_KEY)).toBeNull()
  })

  it('自己的键比老缓存新：就认它（空的也算），老缓存里那份队列已经过时，不再并', async () => {
    // 自己的键是上次读老缓存时并出来的；再并一次会把传过的旧版本又传一遍。变异：mergeOutbox 一律并 → 红
    ls.map.set(LEGACY_KEY, JSON.stringify(legacy())) // at = 10-08
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-09T00:00:00.000Z', entries: [] }))
    await st().init()
    expect(st().outboxCount).toBe(0)
  })

  it('回退到旧版本又升回来：旧代码在这期间离线记的（只在老缓存里）要并进队列，回退前留下的也不丢', async () => {
    // 审查 F8/F13/F20。老缓存比自己的键新 = 旧代码后写的。
    // 变异：mergeOutbox 只认自己的键 → t9 不在队列里，红；改成只认老缓存 → t7 丢了，红
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-01T00:00:00.000Z', entries: [['t7', tx('t7')]] }))
    ls.map.set(LEGACY_KEY, JSON.stringify({ ...legacy(), transactions: [tx('t1'), tx('t9')], outbox: [['t9', tx('t9')]], at: '2026-10-08T00:00:00.000Z' }))
    await st().init()
    expect(st().outboxCount).toBe(2)
    expect(outboxIds().sort()).toEqual(['t7', 't9'])
    // 并完、落了盘，下一次写进 IndexedDB 才删老缓存
    st().persist()
    await flushed()
    expect(ls.getItem(LEGACY_KEY)).toBeNull()
    api.upsertTx.mockResolvedValue(undefined)
    store.useStore.setState({ auth: 'in' })
    await st().flushOutbox()
    expect(api.upsertTx.mock.calls.map((c) => c[0].id).sort()).toEqual(['t7', 't9'])
  })

  it('两边都有账本（上一个会话退回过 localStorage）：用 at 新的那份，不管它在哪边', async () => {
    // 变异：readCache 一律用 IndexedDB 那份 → 第一段红；一律用 localStorage 那份 → 第二段红
    await idbSet(JSON.stringify({ ...legacy(), transactions: [tx('old')], at: '2026-10-01T00:00:00.000Z', outbox: undefined }))
    ls.map.set(LEGACY_KEY, JSON.stringify({ ...legacy(), transactions: [tx('new')], at: '2026-10-08T00:00:00.000Z', outbox: [] }))
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-09T00:00:00.000Z', entries: [] }))
    await st().init()
    expect(ids()).toEqual(['new'])

    await idbSet(JSON.stringify({ ...legacy(), transactions: [tx('newer')], at: '2026-10-09T00:00:00.000Z', outbox: undefined }))
    vi.resetModules()
    const again = await import('./store')
    await again.useStore.getState().init()
    expect(again.useStore.getState().transactions.map((t) => t.id)).toEqual(['newer'])
  })
})

// ══════════════════════════════════════════════════════════════
// IndexedDB 不可用：行为必须和 1.3.30 一样（写 localStorage、5 MiB 上限），绝不能卡死或丢账
// ══════════════════════════════════════════════════════════════
describe('IndexedDB 不可用时退回 localStorage', () => {
  it('没有 indexedDB（旧浏览器 / 隐私模式）：缓存照旧写 localStorage，冷启动照旧能读，上限照旧 5 MiB', async () => {
    setIndexedDB(undefined)
    await st().init()
    expect(st().cacheQuota).toBe(CACHE_LIMIT_BYTES)
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await flushed()
    expect(JSON.parse(ls.getItem(LEGACY_KEY)!).transactions).toHaveLength(1)
    expect(st().cacheDegraded).toBe(false)

    vi.resetModules()
    const again = await import('./store')
    await again.useStore.getState().init()
    expect(again.useStore.getState().transactions.map((t) => t.id)).toEqual(['t1'])
  })

  it('open 挂起不回调：等 OPEN_TIMEOUT_MS 就放弃，冷启动不卡死，这个会话往后都走 localStorage、不再等', async () => {
    // Safari 出过「indexedDB.open 永远不回调」的 bug。变异：cache.ts 的 openOrGiveUp 超时后不 giveUp → 第二段红（又等了 4 秒）
    setIndexedDB({ open: () => ({}) })
    ls.map.set(LEGACY_KEY, JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], at: '2026-10-08T00:00:00.000Z' }))
    const p = st().init()
    await vi.advanceTimersByTimeAsync(OPEN_TIMEOUT_MS + 10)
    await p
    expect(ids()).toEqual(['t1']) // localStorage 那份照样读到
    expect(st().cacheQuota).toBe(CACHE_LIMIT_BYTES)

    // 读失败了，同步成功之前不往本机写（IndexedDB 里那份可能更新）；同步成功之后照写，而且不用再等 4 秒
    store.useStore.setState({ transactions: [tx('t1'), tx('t2')] })
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(JSON.parse(ls.getItem(LEGACY_KEY)!).transactions).toHaveLength(1)
    api.fetchAll.mockResolvedValueOnce({ ...snap([tx('t1'), tx('t2')]), accounts: [{ id: 'acc1' }] })
    store.useStore.setState({ auth: 'in' }) // init 里没联网，被判成了没登录
    await st().refresh()
    await vi.advanceTimersByTimeAsync(600)
    expect(JSON.parse(ls.getItem(LEGACY_KEY)!).transactions).toHaveLength(2)
  })

  it('冷启动读 IndexedDB 失败：内存里那张白纸不许盖掉本机的好账本（离线点「立即上传」也不行），队列照样显示', async () => {
    // 审查 F9/F14。变异：persist 里去掉 `if (!ledgerTrusted) return` → IndexedDB 那份被盖成空的，红
    await idbSet(JSON.stringify({ accounts: [{ id: 'acc1' }], categories: [cat('c1')], transactions: [tx('t1')], facade_adjusts: [], meter_readings: [], at: '2026-10-08T00:00:00.000Z' }))
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-08T00:00:00.000Z', entries: [['q1', tx('q1')]] }))
    const real = IDBObjectStore.prototype.get
    const getSpy = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(() => {
      throw Object.assign(new Error('connection lost'), { name: 'UnknownError' })
    })
    await st().init()
    getSpy.mockRestore()
    void real
    expect(ids()).toEqual(['q1']) // 队列那笔照样显示，不是一张让人以为丢了账的白纸
    expect(st().toast?.msg).toContain('没读出来')
    api.upsertTx.mockRejectedValueOnce(offline())
    store.useStore.setState({ auth: 'in' }) // 本机存着会话钥匙、按登录着渲染的那种（init 里没联网判成了没登录）
    await st().flushOutbox() // 网没真通，补传失败，finally 里会 persist
    expect(api.upsertTx).toHaveBeenCalled()
    await flushed()
    expect((await cached()).transactions.map((t: Transaction) => t.id)).toEqual(['t1'])
  })

  it('两边都有账本时，没有账户的那份不许赢（哪怕它的 at 更新）', async () => {
    // 变异：readCache 只按 at 比 → 红
    await idbSet(JSON.stringify({ accounts: [{ id: 'acc1' }], categories: [], transactions: [tx('good')], facade_adjusts: [], meter_readings: [], at: '2026-10-01T00:00:00.000Z' }))
    ls.map.set(LEGACY_KEY, JSON.stringify({ accounts: [], categories: [], transactions: [], at: '2026-10-09T00:00:00.000Z' }))
    ls.map.set(OUTBOX_KEY, JSON.stringify({ at: '2026-10-09T00:00:00.000Z', entries: [] }))
    await st().init()
    expect(ids()).toEqual(['good'])
  })
})

// ══════════════════════════════════════════════════════════════
// 同步失败不再静默
// ══════════════════════════════════════════════════════════════
describe('同步失败留痕', () => {
  it('首次加载之后同步失败要标记 syncFailed，但不弹 toast 打断', async () => {
    api.fetchAll.mockRejectedValueOnce(new Error('Failed to fetch'))
    await st().refresh()
    expect(st().syncFailed).toBe(true)
    expect(st().toast).toBeNull() // 已经有数据在看，不打断
  })

  it('首次加载就失败：重试期间不打断，三次都失败才明确告诉用户', async () => {
    store.useStore.setState({ loaded: false })
    api.fetchAll.mockRejectedValue(new Error('Failed to fetch'))
    await st().refresh()
    // 第一下失败先自动重试，别急着甩个 toast——手机刚唤醒第一下失败太常见了
    expect(st().syncFailed).toBe(true)
    expect(st().syncRetrying).toBe(true)
    expect(st().toast).toBeNull()

    // 2s / 6s / 15s 三档跑完还是失败，这才是真的连不上
    for (const ms of [2_000, 6_000, 15_000]) await vi.advanceTimersByTimeAsync(ms)
    expect(api.fetchAll).toHaveBeenCalledTimes(4) // 1 次 + 3 次重试
    expect(st().syncRetrying).toBe(false)
    expect(st().toast?.msg).toContain('同步失败')
  })

  it('自动重试成功就把红条收掉，不用用户动手', async () => {
    // 这条正是用户 2026-09-10 的抱怨：隔一阵点开就说刷新失败，手动点一下又好了
    store.useStore.setState({ loaded: false })
    api.fetchAll.mockRejectedValueOnce(new Error('Failed to fetch'))
    api.fetchAll.mockResolvedValueOnce(snap([tx('t1')]))
    await st().refresh()
    expect(st().syncRetrying).toBe(true)
    // store 只负责把原因记下来，翻成人话是 api.friendlyError 的活（那边单独测）
    expect(st().syncError).toBe('Failed to fetch')

    await vi.advanceTimersByTimeAsync(2_000)
    expect(st().syncFailed).toBe(false)
    expect(st().syncError).toBeNull()
    expect(st().syncRetrying).toBe(false)
    expect(st().toast).toBeNull()
    expect(ids()).toEqual(['t1'])
  })

  it('失败原因要留下来给人看，否则下次还是只能猜', async () => {
    api.fetchAll.mockRejectedValue(new Error('JWT expired'))
    await st().refresh()
    expect(st().syncError).toBe('JWT expired')
  })

  it('拉回来是空的就当没登录，绝不能把界面和缓存一起清空', async () => {
    // supabase-js 在 session 失效时会用 anon key 发请求，RLS 一挡返回「零行、无错误」。
    // 当真收下的话：界面变空账本，persist() 顺手把本机缓存也覆盖成空的，全程零报错。
    // （这个文件里 snap() 的 accounts 一直是空的，所以这条得自己先塞一个账户进去）
    const acc = { id: 'a1', name: '中国银行', kind: 'bank' as const, sort: 1, is_archived: false, repay_day: null, facade_offset: null, defer_after_repay: null }
    store.useStore.setState({ accounts: [acc] })
    api.fetchAll.mockResolvedValueOnce({ accounts: [], categories: [], transactions: [] })
    await st().refresh()
    expect(st().accounts).toEqual([acc]) // 本地那份必须原封不动
    expect(st().syncFailed).toBe(true)
    expect(st().syncError).toContain('session')

    // 换回正常的一次同步，数据照常落地
    api.fetchAll.mockResolvedValueOnce({ accounts: [acc], categories: [], transactions: [tx('t1')] })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(st().syncFailed).toBe(false)
    expect(ids()).toEqual(['t1'])
  })

  it('第一次装 App 时账户本来就是空的，这时候空快照是真的', async () => {
    store.useStore.setState({ accounts: [], categories: [], transactions: [], loaded: false })
    api.fetchAll.mockResolvedValueOnce({ accounts: [], categories: [], transactions: [] })
    await st().refresh()
    expect(st().syncFailed).toBe(false)
    expect(st().loaded).toBe(true)
  })

  it('明确断网时不空转重试——网回来时 online 事件会接上', async () => {
    // node 环境的 navigator 上压根没有 onLine，spyOn 会直接报「属性不存在」，得自己装一个
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true })
    store.useStore.setState({ loaded: false })
    api.fetchAll.mockRejectedValue(new Error('Failed to fetch'))
    await st().refresh()
    expect(st().syncRetrying).toBe(false)
    expect(st().toast?.msg).toContain('同步失败')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(api.fetchAll).toHaveBeenCalledTimes(1) // 一次都没重试
    Reflect.deleteProperty(navigator, 'onLine')
  })

  it('用户手动同步会把退避阶梯清零，重新给三次机会', async () => {
    api.fetchAll.mockRejectedValue(new Error('Failed to fetch'))
    await st().refresh()
    for (const ms of [2_000, 6_000, 15_000]) await vi.advanceTimersByTimeAsync(ms)
    expect(st().syncRetrying).toBe(false)
    expect(api.fetchAll).toHaveBeenCalledTimes(4)

    await st().refresh() // 用户点「重试」
    expect(st().syncRetrying).toBe(true)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(api.fetchAll).toHaveBeenCalledTimes(6) // 手动那次 + 又一次自动重试
  })


  it('下一次同步成功要把标记清掉', async () => {
    api.fetchAll.mockRejectedValueOnce(new Error('Failed to fetch'))
    await st().refresh()
    expect(st().syncFailed).toBe(true)

    api.fetchAll.mockResolvedValueOnce(snap([tx('t1')]))
    await st().refresh()
    expect(st().syncFailed).toBe(false)
    expect(ids()).toEqual(['t1'])
  })

  it('没登录时不发同步请求', async () => {
    store.useStore.setState({ auth: 'out' })
    await st().refresh()
    expect(api.fetchAll).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════
// 导入与整库恢复
//   「合并导入」只覆盖同 id 的行；「整库恢复」先清空再重建。
//   恢复是唯一会主动删数据的路径，顺序错一步就是删了没导回来。
// ══════════════════════════════════════════════════════════════
describe('导入与整库恢复', () => {
  const snapshot: Snapshot = { accounts: [], categories: [], transactions: [tx('t1')] , facade_adjusts: [], meter_readings: [] }

  it('整库恢复必须先清空再导入，最后把界面拉到云端', async () => {
    const order: string[] = []
    api.wipeAll.mockImplementationOnce(async () => {
      order.push('wipe')
    })
    api.importAll.mockImplementationOnce(async () => {
      order.push('import')
    })
    api.fetchAll.mockImplementationOnce(async () => {
      order.push('fetch')
      return snap([tx('t1')])
    })
    await st().restoreSnapshot(snapshot)
    expect(order).toEqual(['wipe', 'import', 'fetch'])
    expect(ids()).toEqual(['t1'])
  })

  it('清空的第一句就失败：云端一行都没删，不许吓唬人，也没什么可回滚的', async () => {
    // wipeAll 的六条 DELETE 不是一个事务。api.ts 给错误挂了 step，
    // step==='meter_readings'（0011 起排第一句）表示第一条就没发出去，云端还是原样
    store.useStore.setState({ transactions: [tx('old1')] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'meter_readings' }))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/一条数据都没删/)
    expect(api.importAll).not.toHaveBeenCalled()
  })

  it('删外页面校准那句失败：0011 起它是第二句，电表读数已经删掉了，必须回滚、不能说「一条都没删」', async () => {
    // 变异：store 里的判断留在 step === 'facade_adjusts' → 这里被当成「一条都没删」、不回滚，红
    store.useStore.setState({ transactions: [tx('old1')], meter_readings: [mr('m1')] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'facade_adjusts' }))
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce({ ...snap([tx('old1')]), meter_readings: [mr('m1')] })
    const e = (await st()
      .restoreSnapshot(snapshot)
      .catch((x: unknown) => x)) as Error
    expect(e.message).not.toMatch(/一条数据都没删/)
    expect(e.message).toMatch(/退回操作前/)
    expect(api.importAll).toHaveBeenCalledTimes(1)
    expect(api.importAll.mock.calls[0][0].meter_readings.map((m: MeterReading) => m.id)).toEqual(['m1'])
  })

  it('只记过电表、一笔账都没有：清空到一半失败也要把读数写回去，「没有丢东西」不能是假话', async () => {
    // 变异：hadData 不看 meter_readings → 不回滚，读数就真没了，红
    store.useStore.setState({ meter_readings: [mr('m1'), mr('m2', 339500)] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'transactions' }))
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce({ ...snap(), meter_readings: [mr('m1'), mr('m2', 339500)] })
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/退回操作前/)
    expect(api.importAll).toHaveBeenCalledTimes(1)
    expect(api.importAll.mock.calls[0][0].meter_readings).toEqual([mr('m1'), mr('m2', 339500)])
  })

  it('清空到一半失败：绝不能接着导入新文件，只能拿操作前的快照往回填', async () => {
    store.useStore.setState({ transactions: [tx('old1')] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'accounts' }))
    // 变异：store 里的判断改回 step === 'transactions' → 下面这条会被当成「第一句就失败」而不回滚，红
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'transactions' }))
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce(snap([tx('old1')]))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/退回操作前/)
    expect(api.importAll).toHaveBeenCalledTimes(1)
    expect(api.importAll.mock.calls[0][0].transactions.map((t: Transaction) => t.id)).toEqual(['old1'])
    // 删流水那句失败：电表读数和外页面校准记录已经删掉了，同样要回滚
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce(snap([tx('old1')]))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/退回操作前/)
    expect(api.importAll).toHaveBeenCalledTimes(2)
  })

  it('回滚写回去的快照要带上外页面校准记录和电表读数，不然恢复失败一次它们就没了', async () => {
    // 变异：before 里不带 meter_readings → 回滚的那份没有读数，红
    store.useStore.setState({ transactions: [tx('old1')], facade_adjusts: [fa('f1')], meter_readings: [mr('m1')] })
    api.wipeAll.mockResolvedValueOnce(undefined)
    api.importAll.mockRejectedValueOnce(new Error('网络不通'))
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce({ ...snap([tx('old1')]), facade_adjusts: [fa('f1')], meter_readings: [mr('m1')] })
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/退回操作前/)
    expect(api.importAll.mock.calls[1][0].facade_adjusts.map((f: FacadeAdjust) => f.id)).toEqual(['f1'])
    expect(api.importAll.mock.calls[1][0].meter_readings.map((m: MeterReading) => m.id)).toEqual(['m1'])
  })

  it('导入中途失败：立刻用操作前的快照回滚，并明确告诉用户没丢东西', async () => {
    // 这是最要命的一条：wipeAll 已经执行完，云端是空的。
    // 修复前这里只会抛个错就走人，账本就真没了
    store.useStore.setState({ transactions: [tx('old1'), tx('old2')] })
    api.wipeAll.mockResolvedValueOnce(undefined)
    api.importAll.mockRejectedValueOnce(new Error('网络不通')) // 导新文件炸了
    api.importAll.mockResolvedValueOnce(undefined) // 回滚成功
    api.fetchAll.mockResolvedValueOnce(snap([tx('old1'), tx('old2')]))

    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow('恢复失败：网络不通。你的账本已经退回操作前的样子（')
    expect(api.importAll).toHaveBeenCalledTimes(2)
    // 回滚写回去的必须是「操作前」那份，不是要恢复的那份
    expect(api.importAll.mock.calls[1][0].transactions.map((t: Transaction) => t.id)).toEqual(['old1', 'old2'])
    expect(ids()).toEqual(['old1', 'old2'])
  })

  it('回滚也失败：必须给出可操作的下一步，不能只说「失败了」', async () => {
    store.useStore.setState({ transactions: [tx('old1')] })
    api.wipeAll.mockResolvedValueOnce(undefined)
    api.importAll.mockRejectedValueOnce(new Error('网络不通'))
    api.importAll.mockRejectedValueOnce(new Error('还是没网'))
    api.fetchAll.mockResolvedValueOnce(snap([]))

    const e = (await st()
      .restoreSnapshot(snapshot)
      .catch((x: unknown) => x)) as Error
    expect(e.message).toContain('自动退回也没成功')
    expect(e.message).toContain('备份文件先别删')
    expect(e.message).toContain('再走一次「整库恢复」')
  })

  it('导入中途失败，界面也要拉到云端真实状态，不能停在「什么都没发生」', async () => {
    // 不是事务：失败时前面的批次已经进了云端，用户必须看得见实际进了多少。
    // 这里 store 里本来就是空的，没什么可回滚
    api.wipeAll.mockResolvedValueOnce(undefined)
    api.importAll.mockRejectedValueOnce(new Error('网络不通'))
    api.fetchAll.mockResolvedValueOnce(snap([tx('half')]))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow('网络不通')
    expect(ids()).toEqual(['half'])
  })

  it('合并导入绝不能碰清空', async () => {
    api.importAll.mockResolvedValueOnce(undefined)
    await st().importSnapshot(snapshot)
    expect(api.wipeAll).not.toHaveBeenCalled()
  })

  it('合并导入失败也要拉一次，让用户看见实际进了多少', async () => {
    api.importAll.mockRejectedValueOnce(new Error('网络不通'))
    api.fetchAll.mockResolvedValueOnce(snap([tx('half')]))
    await expect(st().importSnapshot(snapshot)).rejects.toThrow('网络不通')
    expect(ids()).toEqual(['half'])
  })
})

// ══════════════════════════════════════════════════════════════
// 反向时序：同步先出门，写入先完成
//   手工复现方式：切回 App（触发后台同步）后立刻记一笔。
//   补丁一写完就删的话，那份「比写入更早出门」的快照落地时会把它冲掉。
//   正确的退休判据是「有没有一次在写完之后才出门的同步回来过」。
// ══════════════════════════════════════════════════════════════
describe('反向时序：同步先出门、写入先完成', () => {
  it('新增：那份更早出门的快照落地后，这笔必须还在', async () => {
    const fetchD = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(fetchD.promise)
    const rp = st().refresh()

    api.insertTx.mockResolvedValueOnce(undefined)
    await st().addTx(tx('t1'))
    expect(ids()).toContain('t1')

    fetchD.resolve(snap([])) // 早于这次写入的快照现在才落地
    await rp
    expect(ids()).toContain('t1')
  })

  it('删除：那份更早出门的快照落地后，这条不能复活', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    const fetchD = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(fetchD.promise)
    const rp = st().refresh()

    api.deleteTx.mockResolvedValueOnce(undefined)
    await st().removeTx('t1')

    fetchD.resolve(snap([tx('t1')]))
    await rp
    expect(ids()).not.toContain('t1')
  })

  it('修改：那份更早出门的快照落地后，不能被打回旧值', async () => {
    store.useStore.setState({ transactions: [tx('t1', { amount: 1000 })] })
    const fetchD = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(fetchD.promise)
    const rp = st().refresh()

    api.updateTx.mockResolvedValueOnce(undefined)
    await st().editTx(tx('t1', { amount: 8888 }))

    fetchD.resolve(snap([tx('t1', { amount: 1000 })]))
    await rp
    expect(st().transactions[0].amount).toBe(8888)
  })

  it('写入失败时补丁必须立刻删，不能冒出一笔幽灵记录', async () => {
    // 用户明明看到「保存失败」，账本里却多出一笔——这是「成功才退休」写歪了的典型后果
    const fetchD = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(fetchD.promise)
    const rp = st().refresh()

    api.insertTx.mockRejectedValueOnce(denied())
    expect(await st().addTx(tx('ghost'))).toBe(false)

    fetchD.resolve(snap([]))
    await rp
    expect(ids()).not.toContain('ghost')
  })

  it('删除失败时补丁也要立刻删，不能让已回滚的记录再次消失', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    const fetchD = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(fetchD.promise)
    const rp = st().refresh()

    api.deleteTx.mockRejectedValueOnce(denied())
    expect(await st().removeTx('t1')).toBe(false)

    fetchD.resolve(snap([tx('t1')]))
    await rp
    expect(ids()).toContain('t1')
  })

  it('补丁最终会退休：写完之后才出门的同步说没有，就是真没有', async () => {
    api.insertTx.mockResolvedValueOnce(undefined)
    await st().addTx(tx('t1'))

    api.fetchAll.mockResolvedValueOnce(snap([])) // 这次 GET 在写入落库之后才出门
    await st().refresh()
    expect(ids()).not.toContain('t1')
  })
})

// ══════════════════════════════════════════════════════════════
// 同步卡死
//   「正在同步」曾经是一把没有超时的锁：请求永远不返回，此后整个会话的同步
//   都被静默丢弃，杀掉 App 才恢复。
// ══════════════════════════════════════════════════════════════
describe('同步卡死不再锁死整个会话', () => {
  it('卡住 45 秒后允许重新发起', async () => {
    const stuck = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(stuck.promise)
    void st().refresh()
    expect(st().syncing).toBe(true)

    // 紧接着再来一次会被守卫挡掉，这是对的：正常情况下不该并发同步
    api.fetchAll.mockResolvedValueOnce(snap([tx('a')]))
    await st().refresh()
    expect(ids()).toEqual([])

    // 超过 45 秒就认定上一次已经死了
    await vi.advanceTimersByTimeAsync(46_000)
    api.fetchAll.mockResolvedValueOnce(snap([tx('a')]))
    await st().refresh()
    expect(ids()).toEqual(['a'])
  })

  it('被取代的那一轮即使后来返回了，也不许落地', async () => {
    const slow = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(slow.promise)
    const first = st().refresh()

    await vi.advanceTimersByTimeAsync(46_000)
    api.fetchAll.mockResolvedValueOnce(snap([tx('new')]))
    await st().refresh()
    expect(ids()).toEqual(['new'])

    slow.resolve(snap([tx('old')])) // 那一轮这时才返回
    await first
    expect(ids()).toEqual(['new']) // 不能被更旧的快照盖掉
    expect(st().syncing).toBe(false)
  })

  it('同步失败后锁要放开，下一次能正常发起', async () => {
    api.fetchAll.mockRejectedValueOnce(new Error('Failed to fetch'))
    await st().refresh()
    expect(st().syncing).toBe(false)
    expect(st().syncingSince).toBeNull()

    api.fetchAll.mockResolvedValueOnce(snap([tx('a')]))
    await st().refresh()
    expect(ids()).toEqual(['a'])
  })
})

// ══════════════════════════════════════════════════════════════
// 新增分类
//   手工复现方式：网慢时连点两次「确定」；以及归档「午餐」之后再新建一个「午餐」
// ══════════════════════════════════════════════════════════════
describe('新增分类', () => {
  /** 数据库唯一索引挡下重复名字时抛的错 */
  function dupErr(): Error {
    return Object.assign(new Error('duplicate key value violates unique constraint "cat_root_uniq"'), { code: '23505' })
  }

  it('连点两次：第二次被数据库挡下，本地已经有了 → 当成建好了，不弹红字', async () => {
    // 第二次点击的请求先出门（此刻本地还什么都没有），挂住不返回
    const d = deferred<Category>()
    api.addCategory.mockReturnValueOnce(d.promise)
    const p2 = st().addCategory('expense', null, '午餐')

    // 等它被挡下的这段时间里，第一次点击的结果落了地
    store.useStore.setState({ categories: [cat('c1', { name: '午餐' })] })
    d.reject(dupErr())

    expect((await p2)?.id).toBe('c1') // 修复前这里是 null
    expect(st().toast).toBeNull() // 修复前会弹「新增分类失败：已有同名的账户或分类」
    expect(api.fetchAll).not.toHaveBeenCalled() // 本地找得到就别多跑一趟网络
    expect(st().categories).toHaveLength(1) // 不能变出第二个「午餐」
  })

  it('被挡下时本地还没有 → 同步一次再找，找到了照样算成功', async () => {
    api.addCategory.mockRejectedValueOnce(dupErr())
    api.fetchAll.mockResolvedValueOnce(snap([], [cat('c9', { name: '午餐' })]))

    const got = await st().addCategory('expense', null, '午餐')
    expect(got?.id).toBe('c9')
    expect(api.fetchAll).toHaveBeenCalled()
    expect(st().toast).toBeNull()
  })

  it('被挡下、同步之后还是找不到 → 这才是真的失败，要报错', async () => {
    api.addCategory.mockRejectedValueOnce(dupErr())
    api.fetchAll.mockResolvedValueOnce(snap())

    expect(await st().addCategory('expense', null, '午餐')).toBeNull()
    expect(st().toast?.msg).toContain('新增分类失败')
  })

  it('不是重名的错（断网之类）仍然照常报错，不许被吞掉', async () => {
    api.addCategory.mockRejectedValueOnce(new Error('Failed to fetch'))

    expect(await st().addCategory('expense', null, '午餐')).toBeNull()
    expect(st().toast?.msg).toContain('新增分类失败')
    expect(api.fetchAll).not.toHaveBeenCalled() // 别拿网络故障去空跑一次同步
  })

  it('同名分类归档过 → 恢复它，并且必须告诉用户历史记录跟着回来了', async () => {
    store.useStore.setState({ categories: [cat('c1', { name: '午餐', is_archived: true })] })

    const got = await st().addCategory('expense', null, '午餐')
    expect(got?.id).toBe('c1') // 行为不变：复用旧分类，不建新的
    expect(api.addCategory).not.toHaveBeenCalled()
    expect(st().categories[0].is_archived).toBe(false)
    expect(st().toast?.msg).toContain('午餐')
    expect(st().toast?.msg).toContain('已经恢复') // 修复前一声不吭
  })

  it('同名分类没归档 → 直接复用，什么都不用提示', async () => {
    store.useStore.setState({ categories: [cat('c1', { name: '午餐' })] })

    expect((await st().addCategory('expense', null, '午餐'))?.id).toBe('c1')
    expect(st().toast).toBeNull()
    expect(api.updateCategory).not.toHaveBeenCalled()
  })

  it('被挡下、同步回来发现那个同名分类是归档的 → 一样要恢复并提示', async () => {
    api.addCategory.mockRejectedValueOnce(dupErr())
    api.fetchAll.mockResolvedValueOnce(snap([], [cat('c9', { name: '午餐', is_archived: true })]))

    expect((await st().addCategory('expense', null, '午餐'))?.id).toBe('c9')
    expect(st().categories[0].is_archived).toBe(false)
    expect(st().toast?.msg).toContain('已经恢复')
  })
})


// ══════════════════════════════════════════════════════════════
// 每日自动备份的状态（另一个私有仓库跑完写进 user_metadata）
// ══════════════════════════════════════════════════════════════
describe('loadBackupStatus', () => {
  const good = { at: '2026-09-04T17:37:00.000Z', transactions: 1234 }

  it('读到就放进 store', async () => {
    api.fetchBackupStatus.mockResolvedValueOnce(good)
    await st().loadBackupStatus()
    expect(st().backup).toEqual(good)
    expect(st().backupFailed).toBe(false)
  })

  it('读失败要留痕：「读不到」和「从来没备份过」显示的话完全不同', async () => {
    // 两种情况 api 都返回 null。不记这一笔的话，断网时设置页会说「还没有过自动备份」，
    // 而备份其实每天都在跑——用户会跑去重配一遍
    api.fetchBackupStatus.mockImplementationOnce((onFail?: (e: unknown) => void) => {
      onFail?.(new Error('Failed to fetch'))
      return Promise.resolve(null)
    })
    await st().loadBackupStatus()
    expect(st().backup).toBeNull()
    expect(st().backupFailed).toBe(true)
  })

  it('「没备份过」不算失败', async () => {
    store.useStore.setState({ backupFailed: true })
    api.fetchBackupStatus.mockResolvedValueOnce(null)
    await st().loadBackupStatus()
    expect(st().backupFailed).toBe(false)
  })

  it('不碰同步那套时序：不发 fetchAll、不动 syncing / lastSync', async () => {
    // 故意不走 refresh() 的 fetchSeq / 在途补丁机制。混进去只会让那套本来就难的
    // 时序更难，而它连账本都不改
    api.fetchBackupStatus.mockResolvedValueOnce(good)
    const before = { syncing: st().syncing, lastSync: st().lastSync }
    await st().loadBackupStatus()
    expect(api.fetchAll).not.toHaveBeenCalled()
    expect(st().syncing).toBe(before.syncing)
    expect(st().lastSync).toBe(before.lastSync)
  })

  it('同步（refresh）不会顺手去读备份状态', async () => {
    await st().refresh()
    expect(api.fetchBackupStatus).not.toHaveBeenCalled()
  })

  it('退出登录要清掉，否则换账号后显示的是上一个账号的备份时间', async () => {
    store.useStore.setState({ backup: good, backupFailed: true })
    await st().signOut()
    expect(st().backup).toBeNull()
    expect(st().backupFailed).toBe(false)
  })

  it('慢的旧请求晚回来，不许把刚读到的「正常」覆盖成「读不到」', async () => {
    // 设置页每次挂载都发一次。来回切一下页就有两次在飞，网差时先发的可能后回来。
    // 第一次慢且最后失败、第二次快且成功 —— 没有编号的话用户会看着「正常」跳成
    // 「读不到备份状态」，而备份其实好好的，他会跑去重配一遍
    let failFirst!: () => void
    let endFirst!: () => void
    api.fetchBackupStatus.mockImplementationOnce(
      (onFail?: (e: unknown) => void) =>
        new Promise<null>((res) => {
          failFirst = () => onFail?.(new Error('Failed to fetch'))
          endFirst = () => res(null)
        }),
    )
    api.fetchBackupStatus.mockResolvedValueOnce(good)

    const first = st().loadBackupStatus()
    const second = st().loadBackupStatus()
    await second
    expect(st().backup).toEqual(good)

    failFirst()
    endFirst()
    await first
    expect(st().backup).toEqual(good)
    expect(st().backupFailed).toBe(false)
  })

  it('退出登录时还在飞的那次回来，不许把备份时间写回来', async () => {
    // signOut 特意清了 backup（换账号不能看到上一个账号的备份时间），
    // 但在途的那次回来会把它原样写回去，等于那行清理没发生过
    let land!: () => void
    api.fetchBackupStatus.mockImplementationOnce(
      () =>
        new Promise((res) => {
          land = () => res(good)
        }),
    )
    const flying = st().loadBackupStatus()
    await st().signOut()
    expect(st().backup).toBeNull()

    land()
    await flying
    expect(st().backup).toBeNull()
    expect(st().backupFailed).toBe(false)
  })
})

// ══════════════════════════════════════════════════════════════
// 离线记账 —— 断网时写不进云端的那几笔进待传队列，联网后自动补
//   手工复现方式：开飞行模式记一笔，关掉飞行模式看它自己传上去
// ══════════════════════════════════════════════════════════════
describe('外页面校准记录（0010）', () => {
  it('写成功：进 state、落缓存、返回 true', async () => {
    api.insertFacadeAdjust.mockResolvedValueOnce(undefined)
    expect(await st().addFacadeAdjust(fa('f1'))).toBe(true)
    expect(st().facade_adjusts.map((f) => f.id)).toEqual(['f1'])
    expect(api.insertFacadeAdjust.mock.calls[0][0]).toEqual(fa('f1'))
    await vi.advanceTimersByTimeAsync(600)
    expect((await cached()).facade_adjusts).toEqual([fa('f1')])
  })

  it('写失败：state 不动、返回 false、报错不带「外页面」三个字（这条 toast 会在外页面上弹）', async () => {
    // 变异：catch 里也 set 进 state → 红；toast 文案写成「外页面校准失败」→ 红
    api.insertFacadeAdjust.mockRejectedValueOnce(offline())
    expect(await st().addFacadeAdjust(fa('f1'))).toBe(false)
    expect(st().facade_adjusts).toEqual([])
    expect(st().toast?.msg).toMatch(/校准失败/)
    expect(st().toast?.msg).not.toMatch(/外页面/)
  })

  it('已经在飞的同步不会把刚写的冲掉，之后的同步以服务端为准', async () => {
    // 变异：addFacadeAdjust 不登记 pendingFa → 第一个断言红
    const d = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(d.promise) // GET 先出门，此刻服务端还没有这条
    const rp = st().refresh()
    api.insertFacadeAdjust.mockResolvedValueOnce(undefined)
    await st().addFacadeAdjust(fa('f1'))
    d.resolve(snap())
    await rp
    expect(st().facade_adjusts.map((f) => f.id)).toEqual(['f1'])

    api.fetchAll.mockResolvedValueOnce(snap())
    await st().refresh()
    expect(st().facade_adjusts).toEqual([])
  })

  it('同步拉回来的记录进 state；0010 之前写的缓存没有这一节，读出来是空数组不是 undefined', async () => {
    ls.map.set(LEGACY_KEY, JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    api.hasSession.mockResolvedValue(true)
    api.fetchAll.mockResolvedValueOnce({ ...snap([tx('t1')]), facade_adjusts: [fa('f9')] })
    await st().init()
    expect(st().facade_adjusts.map((f) => f.id)).toEqual(['f9'])
    await vi.advanceTimersByTimeAsync(600)
    expect((await cached()).facade_adjusts).toHaveLength(1)
  })

  it('退出登录要清掉，换个账号登进来不能看到上一个人的外页面校准', async () => {
    store.useStore.setState({ facade_adjusts: [fa('f1')] })
    await st().signOut()
    expect(st().facade_adjusts).toEqual([])
  })
})

describe('电表读数（0011）', () => {
  it('记一条成功：进 state、落缓存、返回 true', async () => {
    api.insertMeterReading.mockResolvedValueOnce(undefined)
    expect(await st().addMeterReading(mr('m1'))).toBe(true)
    expect(st().meter_readings).toEqual([mr('m1')])
    expect(api.insertMeterReading.mock.calls[0][0]).toEqual(mr('m1'))
    await vi.advanceTimersByTimeAsync(600)
    expect((await cached()).meter_readings).toEqual([mr('m1')])
  })

  it('记一条失败（没网也一样）：state 不动、返回 false、告诉用户；没有离线队列', async () => {
    // 变异：catch 里也 set 进 state → 红
    api.insertMeterReading.mockRejectedValueOnce(offline())
    expect(await st().addMeterReading(mr('m1'))).toBe(false)
    expect(st().meter_readings).toEqual([])
    expect(st().toast?.msg).toMatch(/记录读数失败/)
    expect(st().outboxCount).toBe(0)
  })

  it('记的时候已经在飞的同步不会把它冲掉，之后的同步以服务端为准', async () => {
    // 变异：addMeterReading 不登记 pendingMr → 第一个断言红
    const d = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(d.promise) // GET 先出门，此刻服务端还没有这条
    const rp = st().refresh()
    api.insertMeterReading.mockResolvedValueOnce(undefined)
    await st().addMeterReading(mr('m1'))
    d.resolve(snap())
    await rp
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m1'])

    api.fetchAll.mockResolvedValueOnce(snap())
    await st().refresh()
    expect(st().meter_readings).toEqual([])
  })

  it('删一条成功：从 state 和缓存里拿掉、返回 true', async () => {
    store.useStore.setState({ meter_readings: [mr('m1'), mr('m2', 339500)] })
    api.deleteMeterReading.mockResolvedValueOnce(undefined)
    expect(await st().removeMeterReading('m1')).toBe(true)
    expect(api.deleteMeterReading).toHaveBeenCalledWith('m1')
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m2'])
    await vi.advanceTimersByTimeAsync(600)
    expect((await cached()).meter_readings.map((m: MeterReading) => m.id)).toEqual(['m2'])
  })

  it('删失败：这条还在、返回 false、告诉用户', async () => {
    // 变异：先从 state 拿掉、失败也不放回 → 红
    store.useStore.setState({ meter_readings: [mr('m1')] })
    api.deleteMeterReading.mockRejectedValueOnce(offline())
    expect(await st().removeMeterReading('m1')).toBe(false)
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m1'])
    expect(st().toast?.msg).toMatch(/删除读数失败/)
  })

  it('删的时候已经在飞的同步还带着这条：落地后不许复活；之后的同步以服务端为准', async () => {
    // 变异：removeMeterReading 不登记「已删除」补丁 → 那份更早出门的快照把 m1 带回来，红
    store.useStore.setState({ meter_readings: [mr('m1'), mr('m2', 339500)] })
    const d = deferred<Snapshot>()
    api.fetchAll.mockReturnValueOnce(d.promise) // GET 先出门，此刻服务端还有 m1
    const rp = st().refresh()
    api.deleteMeterReading.mockResolvedValueOnce(undefined)
    await st().removeMeterReading('m1')
    d.resolve({ ...snap(), meter_readings: [mr('m1'), mr('m2', 339500)] })
    await rp
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m2'])

    // 删完之后才出门的同步说有，那就是真有（比如另一台设备又补记了同一条）——补丁已经退休
    api.fetchAll.mockResolvedValueOnce({ ...snap(), meter_readings: [mr('m1'), mr('m2', 339500)] })
    await st().refresh()
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('冷启动：缓存里的读数直接拿来渲染；0011 之前写的缓存没有这一节，读出来是空数组不是 undefined', async () => {
    // 变异：readCache 不补这一节 → 第二段拿到 undefined，红
    ls.map.set(LEGACY_KEY, JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], facade_adjusts: [], meter_readings: [mr('m1')], at: '2026-10-03T00:00:00.000Z' }))
    await st().init()
    expect(st().meter_readings).toEqual([mr('m1')])

    ls.map.set(LEGACY_KEY, JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    vi.resetModules()
    const again = await import('./store')
    await again.useStore.getState().init()
    expect(again.useStore.getState().meter_readings).toEqual([])
  })

  it('同步拉回来的读数进 state 并落缓存', async () => {
    api.hasSession.mockResolvedValue(true)
    api.fetchAll.mockResolvedValueOnce({ ...snap([tx('t1')]), meter_readings: [mr('m9')] })
    await st().init()
    expect(st().meter_readings.map((m) => m.id)).toEqual(['m9'])
    await vi.advanceTimersByTimeAsync(600)
    expect((await cached()).meter_readings).toEqual([mr('m9')])
  })

  it('退出登录要清掉，换个账号登进来不能看到上一个人的电表', async () => {
    // 变异：signOut 的 set 里漏掉 meter_readings → 红
    store.useStore.setState({ meter_readings: [mr('m1')] })
    await st().signOut()
    expect(st().meter_readings).toEqual([])
  })
})

describe('旧版本写的缓存', () => {
  it('缺少新列的旧缓存要在入口补成 null，不能让 undefined 流进算式', async () => {
    // 加列之前的缓存长这样：账户没有 repay_day，流水没有 settles / installments
    ls.map.set(
      LEGACY_KEY,
      JSON.stringify({
        at: '2026-09-01T00:00:00.000Z',
        accounts: [{ id: 'jd', name: '京东白条', kind: 'credit', sort: 5, is_archived: false }],
        categories: [],
        transactions: [{ id: 't1', date: '2026-09-06', type: 'expense', amount: 599, account_id: 'jd', to_account_id: null, category_id: null, note: null, created_at: '2026-09-06T00:00:00.000Z' }],
      }),
    )
    vi.resetModules()
    const again = await import('./store')
    api.hasSession.mockResolvedValue(false)
    await again.useStore.getState().init()
    const s2 = again.useStore.getState()
    // undefined 会让 dayInMonth 算出 "2026-09-NaN"，首屏的「本月应还」就是错的
    expect(s2.accounts[0].repay_day).toBeNull()
    expect(s2.transactions[0].settles).toBeNull()
    expect(s2.transactions[0].installments).toBeNull()
  })
})

describe('离线记账：待上传队列', () => {
  it('断网记一笔：留在界面上、进队列、算保存成功', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    expect(await st().addTx(tx('t1'))).toBe(true) // 修复前是 false，那笔会被删掉
    expect(ids()).toContain('t1')
    expect(st().outboxCount).toBe(1)
  })

  it('数据被服务器拒了：照旧回滚并报错，不进队列', async () => {
    api.insertTx.mockRejectedValueOnce(denied())
    expect(await st().addTx(tx('t1'))).toBe(false)
    expect(ids()).not.toContain('t1')
    expect(st().outboxCount).toBe(0)
  })

  it('队列里的那笔不会被 refresh 冲掉（服务端快照里根本没有它）', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.fetchAll.mockResolvedValueOnce(snap([tx('t2')]))
    api.upsertTx.mockResolvedValue(undefined)
    await st().refresh()
    expect(ids()).toContain('t1') // 只叠在途补丁的话这里会没有——补丁 60 秒就过期了
    expect(ids()).toContain('t2')
  })

  it('refresh 成功后自动补传，传完队列清空', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.upsertTx.mockResolvedValue(undefined)
    api.fetchAll.mockResolvedValueOnce(snap([]))
    await st().refresh()
    await vi.waitFor(() => expect(st().outboxCount).toBe(0))
    expect(api.upsertTx).toHaveBeenCalledTimes(1)
    expect(api.upsertTx.mock.calls[0][0].id).toBe('t1')
  })

  it('断网记一笔又改一笔金额：队列里只有一条，传的是改完的值', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1', { amount: 100 }))
    // 这个 id 还在队列里：改动不走 updateTx（云端还没有这一行，命中 0 行会被当成功），直接换队列里的版本、马上试一次补传
    api.upsertTx.mockRejectedValueOnce(offline())
    await st().editTx(tx('t1', { amount: 999 }))
    expect(api.updateTx).not.toHaveBeenCalled()
    expect(st().outboxCount).toBe(1)
    api.upsertTx.mockResolvedValue(undefined)
    await st().flushOutbox()
    expect(api.upsertTx).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 999 }))
    expect(st().outboxCount).toBe(0)
  })

  it('队列里的那笔在线改一下、删一下：不直接发 update / delete，队列换成新状态，补传后云端是新值（2026-10-09 审出来的）', async () => {
    // 变异：去掉 editTx/removeTx 开头的 outboxTx.has 分支 → updateTx 被调用、队列里还是 100，红
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1', { amount: 100 }))
    api.upsertTx.mockRejectedValueOnce(offline())
    await st().editTx(tx('t1', { amount: 2000 }))
    expect(api.updateTx).not.toHaveBeenCalled()
    api.fetchAll.mockResolvedValueOnce(snap([]))
    await st().refresh()
    expect(st().transactions.find((t) => t.id === 't1')?.amount).toBe(2000)
    api.deleteTx.mockRejectedValueOnce(offline())
    await st().removeTx('t1')
    expect(ids()).not.toContain('t1')
    api.deleteTx.mockResolvedValue(undefined)
    await st().flushOutbox()
    expect(api.deleteTx).toHaveBeenLastCalledWith('t1')
    expect(st().outboxCount).toBe(0)
    expect(ids()).not.toContain('t1')
  })

  it('补传成功的那几笔要登记在途补丁：和补传同时出门的那次同步落地时不能把它们冲掉（2026-10-09 审出来的）', async () => {
    // 变异：flushOutbox 成功后不 pendingTx.set/settle → 同步落地后 t1 消失，红
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1', { amount: 100 }))
    let release!: () => void
    api.fetchAll.mockReturnValueOnce(new Promise((r) => (release = () => r(snap([])))))
    const sync = st().refresh()
    api.upsertTx.mockResolvedValue(undefined)
    await st().flushOutbox()
    expect(st().outboxCount).toBe(0)
    release()
    await sync
    expect(ids()).toContain('t1')
  })

  it('断网记一笔又删掉：不该 upsert，只发一次 delete', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.deleteTx.mockRejectedValueOnce(offline())
    await st().removeTx('t1')
    expect(ids()).not.toContain('t1')
    api.deleteTx.mockResolvedValue(undefined)
    await st().flushOutbox()
    expect(api.upsertTx).not.toHaveBeenCalled()
    expect(api.deleteTx).toHaveBeenLastCalledWith('t1')
    expect(st().outboxCount).toBe(0)
  })

  it('补传到一半又断网：传成功的删掉，剩下的留着', async () => {
    api.insertTx.mockRejectedValue(offline())
    await st().addTx(tx('t1'))
    await st().addTx(tx('t2'))
    expect(st().outboxCount).toBe(2)
    api.upsertTx.mockResolvedValueOnce(undefined).mockRejectedValueOnce(offline())
    await st().flushOutbox()
    expect(st().outboxCount).toBe(1)
  })

  it('补传时被服务器拒：从队列和界面上一起去掉，不留幽灵记录', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.upsertTx.mockRejectedValueOnce(denied())
    await st().flushOutbox()
    expect(st().outboxCount).toBe(0)
    expect(ids()).not.toContain('t1') // 留着就是一条云端永远不会有的记录
  })

  it('断网记的那笔立刻写进 jz_outbox_v1，不等 500ms 去抖：这半秒里 App 被杀掉也不丢', async () => {
    // 变异：enqueue 里去掉 saveOutbox() → 红
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    expect(outboxIds()).toEqual(['t1'])
  })

  it('补传成功后队列文件也要跟着更新，否则重开 App 又传一遍', async () => {
    // 变异：flushOutbox 的 finally 里去掉 saveOutbox() → 红
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.upsertTx.mockResolvedValueOnce(undefined)
    await st().flushOutbox()
    expect(outboxIds()).toEqual([])
  })

  it('补传到一半：传完的那笔马上从本机队列里划掉，不等整轮结束（中途被杀不会再传一遍旧版本）', async () => {
    // 审查 F19。变异：flushOutbox 循环里去掉逐笔的 saveOutbox() → 红
    api.insertTx.mockRejectedValue(offline())
    await st().addTx(tx('t1'))
    await st().addTx(tx('t2'))
    api.insertTx.mockReset()
    const d = deferred<void>()
    api.upsertTx.mockResolvedValueOnce(undefined).mockReturnValueOnce(d.promise)
    const p = st().flushOutbox()
    await vi.advanceTimersByTimeAsync(0)
    expect(outboxIds()).toHaveLength(1) // 第一笔传完了，第二笔还在路上
    d.resolve()
    await p
    expect(outboxIds()).toEqual([])
  })

  it('队列写进本机，重开 App 还在', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    await flushed()

    vi.resetModules()
    const again = await import('./store')
    api.hasSession.mockResolvedValue(false) // 不联网，只看缓存装回来没有
    await again.useStore.getState().init()
    expect(again.useStore.getState().outboxCount).toBe(1)
    expect(again.useStore.getState().transactions.map((t) => t.id)).toContain('t1')
  })

  it('退出登录会清掉队列（换账号后补传过去是灾难）', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    api.signOut.mockResolvedValue(undefined)
    await st().signOut()
    expect(st().outboxCount).toBe(0)
    // 光看计数器不算数：它和清队列写在同一条语句里，队列没清干净照样显示 0。
    // 真正要证的是「再登进来也传不出去」，所以直接让它补传一次。
    api.upsertTx.mockResolvedValue(undefined)
    store.useStore.setState({ auth: 'in' })
    await st().flushOutbox()
    expect(api.upsertTx).not.toHaveBeenCalled()
    expect(api.deleteTx).not.toHaveBeenCalled()
  })

  it('补传途中这一条又被改了：不能把新版本一起删掉', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1', { amount: 100 }))
    const d = deferred<void>()
    api.upsertTx.mockReturnValueOnce(d.promise)
    const p = st().flushOutbox()
    // 旧值还在路上时，用户又改了这一笔，而改的那次也没网
    api.updateTx.mockRejectedValueOnce(offline())
    await st().editTx(tx('t1', { amount: 999 }))
    d.resolve() // 旧值这时才传成功
    await p
    // 修复前这里会变成 0：云端是 100、界面是 999、队列空了，再没有东西会纠正它
    expect(st().outboxCount).toBe(1)
    api.upsertTx.mockResolvedValue(undefined)
    await st().flushOutbox()
    expect(api.upsertTx.mock.calls[api.upsertTx.mock.calls.length - 1][0].amount).toBe(999)
  })

  it('同一时刻两次补传只发一轮请求', async () => {
    api.insertTx.mockRejectedValueOnce(offline())
    await st().addTx(tx('t1'))
    const d = deferred<void>()
    api.upsertTx.mockReturnValueOnce(d.promise)
    const a = st().flushOutbox()
    const b = st().flushOutbox() // 第二次应该直接早退
    d.resolve()
    await Promise.all([a, b])
    expect(api.upsertTx).toHaveBeenCalledTimes(1)
  })
})

// ══════════════════════════════════════════════════════════════
// 里外页面
//   外页面（平时用的）显示修饰过的余额，里页面显示真的。两条安全性质在这里守：
//   冷启动必须是外页面；里页面有时效，手机放下走开 60 秒回来就自动退回外页面。
// ══════════════════════════════════════════════════════════════
describe('里外页面', () => {
  it('默认是外页面', () => {
    expect(st().mode).toBe('outer')
  })

  it('模式绝不能进缓存——否则冷启动会停在里页面，这个开关就白做了', async () => {
    st().setMode('inner')
    st().persist()
    await flushed()
    const raw = await idbGet()
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw as string)).not.toHaveProperty('mode')
    expect(raw).not.toContain('inner')
    // localStorage 里自己的那几个键也不许带
    for (const [k, v] of ls.map) if (k.startsWith('jz_')) expect(v).not.toContain('inner')
  })

  it('切走不到 60 秒再回来，还在里页面', () => {
    st().setMode('inner')
    st().noteHidden()
    vi.advanceTimersByTime(59_000)
    st().noteVisible()
    expect(st().mode).toBe('inner')
  })

  it('切走满 60 秒再回来，自动退回外页面', () => {
    st().setMode('inner')
    st().noteHidden()
    vi.advanceTimersByTime(60_000)
    st().noteVisible()
    expect(st().mode).toBe('outer')
  })

  it('连着切走两次，只按最后一次离开的时间算', () => {
    // 漏掉 noteVisible 里那句 hiddenAt = null 的话，第一次离开的时间会一直留着，
    // 之后随便切走再回来都会被判成「离开很久」，里页面根本待不住
    st().setMode('inner')
    st().noteHidden()
    vi.advanceTimersByTime(120_000)
    st().noteVisible()
    expect(st().mode).toBe('outer')

    st().setMode('inner')
    st().noteVisible() // 没有 noteHidden 就直接回前台（比如首次加载）
    expect(st().mode).toBe('inner')
  })

  it('本来就在外页面时，切走多久回来都不受影响', () => {
    st().noteHidden()
    vi.advanceTimersByTime(600_000)
    st().noteVisible()
    expect(st().mode).toBe('outer')
  })

  it('退出登录复位成外页面', async () => {
    st().setMode('inner')
    await st().signOut()
    expect(st().mode).toBe('outer')
  })
})
