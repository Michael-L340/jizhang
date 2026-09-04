// store 的并发与缓存行为测试。
//
// 这些场景（S3/S4/S2）以前只能在手机上手动复现：记一笔立刻切走再切回、撤销失败、
// 缓存写满。它们全是纯数据层的时序问题，把 api.ts 换成可控的假实现就能在这里精确重放，
// 不需要浏览器，也不需要真的联网。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Category, Snapshot, Transaction } from '../types'

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
  importAll: vi.fn(),
  wipeAll: vi.fn(),
  signIn: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  hasSession: vi.fn(),
  onAuthChange: vi.fn(() => () => {}),
  friendlyError: (e: unknown) => String((e as { message?: string })?.message ?? e),
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

const CACHE_KEY = 'jz_cache_v1'
let ls: FakeStorage

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
    created_at: '2026-09-04T02:00:00.000Z',
    ...over,
  }
}

function cat(id: string, over: Partial<Category> = {}): Category {
  return { id, kind: 'expense', parent_id: null, name: id, icon: null, sort: 1, is_archived: false, note: null, ...over }
}

function snap(transactions: Transaction[] = [], categories: Category[] = []): Snapshot {
  return { accounts: [], categories, transactions }
}

let store: typeof import('./store')
const st = () => store.useStore.getState()
const ids = () => st().transactions.map((t) => t.id)

beforeEach(async () => {
  vi.useFakeTimers()
  ls = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })

  for (const v of Object.values(api)) if (typeof v === 'function' && 'mockReset' in v) v.mockReset()
  api.onAuthChange.mockReturnValue(() => {})
  api.hasSession.mockResolvedValue(false)
  api.fetchAll.mockResolvedValue(snap())

  // 每个用例拿一份全新的 store 模块：pendingTx / persistTimer 都是模块级单例
  vi.resetModules()
  store = await import('./store')
  store.useStore.setState({ auth: 'in', loaded: true })
})

afterEach(() => {
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

  it('刚建的分类在 10 秒窗口内不会被 refresh 冲掉，窗口过后以服务端为准', async () => {
    api.addCategory.mockResolvedValueOnce(cat('new1', { name: '新分类' }))
    await st().addCategory('expense', null, '新分类')
    expect(st().categories.map((c) => c.id)).toContain('new1')

    api.fetchAll.mockResolvedValueOnce(snap([], [])) // 服务端还没返回这个分类
    await st().refresh()
    expect(st().categories.map((c) => c.id)).toContain('new1')

    // 窗口过后补丁必须撤销，否则一个真被删掉的分类会永远钉在界面上
    await vi.advanceTimersByTimeAsync(11_000)
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

    d.reject(new Error('网络不通'))
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

    d.reject(new Error('网络不通'))
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

    d.reject(new Error('网络不通'))
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

    d.reject(new Error('网络不通'))
    expect(await p).toBe(false)
    expect(ids()).toEqual([]) // 若回滚写成 insert，这里会冒出一条僵尸记录
  })

  it('修改失败换回的是旧值，不是新值', async () => {
    store.useStore.setState({ transactions: [tx('t1', { amount: 1000 })] })
    api.updateTx.mockRejectedValueOnce(new Error('网络不通'))
    expect(await st().editTx(tx('t1', { amount: 8888 }))).toBe(false)
    expect(st().transactions[0].amount).toBe(1000)
  })
})

// ══════════════════════════════════════════════════════════════
// S2 —— 本机缓存
// ══════════════════════════════════════════════════════════════
describe('S2 本机缓存', () => {
  it('连续三次写入只落一次盘（500ms 尾部去抖）', async () => {
    api.insertTx.mockResolvedValue(undefined)
    await st().addTx(tx('t1'))
    await st().addTx(tx('t2'))
    await st().addTx(tx('t3'))
    expect(ls.writes).toBe(0) // 去抖窗口内一次都不写
    await vi.advanceTimersByTimeAsync(600)
    expect(ls.writes).toBe(1)
    expect(JSON.parse(ls.getItem(CACHE_KEY)!).transactions).toHaveLength(3)
  })

  it('只写三张表和时间戳，不把 auth/toast/syncing 一起写进去', async () => {
    st().showToast('随便一句')
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(Object.keys(JSON.parse(ls.getItem(CACHE_KEY)!)).sort()).toEqual(['accounts', 'at', 'categories', 'transactions'])
  })

  it('缓存占用按 UTF-16 算：(键长 + 值长) × 2', async () => {
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(st().cacheBytes).toBe((CACHE_KEY.length + ls.getItem(CACHE_KEY)!.length) * 2)
  })

  it('写满时标记降级并只提示一次', async () => {
    ls.limitChars = 10
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(st().cacheDegraded).toBe(true)
    const firstToast = st().toast
    expect(firstToast?.msg).toContain('缓存已满')

    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(st().toast?.id).toBe(firstToast?.id) // 没有弹第二次
  })

  it('写通了要把降级标记清掉', async () => {
    ls.limitChars = 10
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(st().cacheDegraded).toBe(true)

    ls.limitChars = Infinity
    st().persist()
    await vi.advanceTimersByTimeAsync(600)
    expect(st().cacheDegraded).toBe(false)
  })

  it('退出登录要取消在途的去抖写入，缓存不能又被写回来', async () => {
    api.signOut.mockResolvedValueOnce(undefined)
    store.useStore.setState({ transactions: [tx('t1')] })
    st().persist() // 定时器已排上
    await st().signOut()
    await vi.advanceTimersByTimeAsync(600)
    expect(ls.getItem(CACHE_KEY)).toBeNull()
  })

  it('缓存里缺 categories 就整份作废，不能让页面拿到 undefined', async () => {
    ls.map.set(CACHE_KEY, JSON.stringify({ accounts: [], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    await st().init()
    expect(st().transactions).toEqual([])
    expect(st().categories).toEqual([])
  })

  it('缓存完整时冷启动直接用它渲染', async () => {
    ls.map.set(CACHE_KEY, JSON.stringify({ accounts: [], categories: [cat('c1')], transactions: [tx('t1')], at: '2026-09-04T00:00:00.000Z' }))
    await st().init()
    expect(ids()).toEqual(['t1'])
    expect(st().lastSync).toBe('2026-09-04T00:00:00.000Z')
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

  it('首次加载就失败要明确告诉用户', async () => {
    store.useStore.setState({ loaded: false })
    api.fetchAll.mockRejectedValueOnce(new Error('Failed to fetch'))
    await st().refresh()
    expect(st().syncFailed).toBe(true)
    expect(st().toast?.msg).toContain('同步失败')
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
  const snapshot = { accounts: [], categories: [], transactions: [tx('t1')] }

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

  it('清空失败就不要再导入了，否则可能删了一半又写一半', async () => {
    api.wipeAll.mockRejectedValueOnce(new Error('网络不通'))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow('网络不通')
    expect(api.importAll).not.toHaveBeenCalled()
  })

  it('导入中途失败，界面也要拉到云端真实状态，不能停在「什么都没发生」', async () => {
    // 不是事务：失败时前面的批次已经进了云端，用户必须看得见实际进了多少
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
