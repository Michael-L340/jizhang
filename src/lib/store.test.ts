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
  fetchBackupStatus: vi.fn(),
  signIn: vi.fn(),
  changePassword: vi.fn(),
  signOut: vi.fn(),
  hasSession: vi.fn(),
  onAuthChange: vi.fn(() => () => {}),
  friendlyError: (e: unknown) => String((e as { message?: string })?.message ?? e),
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
  api.fetchBackupStatus.mockResolvedValue(null)

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

  it('清空的第一句就失败：云端一行都没删，不许吓唬人，也没什么可回滚的', async () => {
    // wipeAll 的四条 DELETE 不是一个事务。api.ts 给错误挂了 step，
    // step==='transactions' 表示第一条就没发出去，云端还是原样
    store.useStore.setState({ transactions: [tx('old1')] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'transactions' }))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/一条数据都没删/)
    expect(api.importAll).not.toHaveBeenCalled()
  })

  it('清空到一半失败：绝不能接着导入新文件，只能拿操作前的快照往回填', async () => {
    store.useStore.setState({ transactions: [tx('old1')] })
    api.wipeAll.mockRejectedValueOnce(Object.assign(new Error('网络不通'), { step: 'accounts' }))
    api.importAll.mockResolvedValueOnce(undefined)
    api.fetchAll.mockResolvedValueOnce(snap([tx('old1')]))
    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow(/退回操作前/)
    expect(api.importAll).toHaveBeenCalledTimes(1)
    expect(api.importAll.mock.calls[0][0].transactions.map((t: Transaction) => t.id)).toEqual(['old1'])
  })

  it('导入中途失败：立刻用操作前的快照回滚，并明确告诉用户没丢东西', async () => {
    // 这是最要命的一条：wipeAll 已经执行完，云端是空的。
    // 修复前这里只会抛个错就走人，账本就真没了
    store.useStore.setState({ transactions: [tx('old1'), tx('old2')] })
    api.wipeAll.mockResolvedValueOnce(undefined)
    api.importAll.mockRejectedValueOnce(new Error('网络不通')) // 导新文件炸了
    api.importAll.mockResolvedValueOnce(undefined) // 回滚成功
    api.fetchAll.mockResolvedValueOnce(snap([tx('old1'), tx('old2')]))

    await expect(st().restoreSnapshot(snapshot)).rejects.toThrow('恢复失败：网络不通。你的账本已经退回操作前的样子，没有丢东西。')
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

    api.insertTx.mockRejectedValueOnce(new Error('网络不通'))
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

    api.deleteTx.mockRejectedValueOnce(new Error('网络不通'))
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
