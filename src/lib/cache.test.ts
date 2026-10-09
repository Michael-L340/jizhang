// cache.ts 的存储层测试：IndexedDB 出问题时的每一条兜底。
// store.test.ts 从 App 的视角测「断网冷启动看到什么」，这里直接撬存储层，专测 store 够不着的时序：
// 挂起的事务、断线重接、配额满、老缓存什么时候才能删、退出登录的待删记号。
import 'fake-indexeddb/auto'
import { IDBDatabase as FakeDB, IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class FakeStorage {
  map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

let ls: FakeStorage
let cache: typeof import('./cache')
const ok = { dropLegacy: true }

function setIndexedDB(v: unknown): void {
  Object.defineProperty(globalThis, 'indexedDB', { value: v, configurable: true, writable: true })
}

/** fake-indexeddb 靠真的 setImmediate 推进，假定时器不管它 */
async function drain(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r))
}

/**
 * 一个「开得了门、事务永远不提交」的假 IndexedDB：Safari 的连接丢了之后就是这副样子，
 * 请求发出去没有任何回调。
 */
function hangingFactory() {
  const tx = { objectStore: () => ({ put: () => ({}), get: () => ({}), delete: () => ({}) }), abort: () => {} }
  const db = { transaction: () => tx, close: () => {} }
  return {
    open: () => {
      const req: { result: unknown; onsuccess?: () => void } = { result: db }
      setImmediate(() => req.onsuccess?.())
      return req
    },
  }
}

/** 真实浏览器报配额满的方式：put 本身不抛，事务在提交时 abort，tx.error 是 QuotaExceededError */
function quotaOnCommit() {
  const orig = IDBObjectStore.prototype.put
  return vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const r = orig.apply(this, args)
    ;(this.transaction as unknown as { _abort: (n: string) => void })._abort('QuotaExceededError')
    return r
  })
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  ls = new FakeStorage()
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true, writable: true })
  setIndexedDB(new IDBFactory())
  vi.resetModules() // dbPromise / chain 都是模块级单例
  cache = await import('./cache')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('老缓存什么时候才能删', () => {
  it('写进 IndexedDB 之后、而且队列已经落盘（dropLegacy），才删 localStorage 里的老缓存', async () => {
    // 变异：writeLedger 里不看 dropLegacy 直接删 → 第一段红。
    // 老缓存里还包着一份待传队列，队列没落到新地方之前它是唯一的备份，删了就是丢账
    ls.setItem(cache.LEGACY_KEY, '{"old":true}')
    expect(await cache.writeLedger('{"a":1}', { ...ok, dropLegacy: false })).toBe('idb')
    expect(ls.getItem(cache.LEGACY_KEY)).toBe('{"old":true}')

    expect(await cache.writeLedger('{"a":2}', ok)).toBe('idb')
    expect(ls.getItem(cache.LEGACY_KEY)).toBeNull()
    expect((await cache.readLedger()).idb).toBe('{"a":2}')
  })

  it('写进 IndexedDB 失败时老缓存一定不删', async () => {
    // 变异：把删老缓存挪到写之前 → 红
    ls.setItem(cache.LEGACY_KEY, '{"old":true}')
    quotaOnCommit()
    await expect(cache.writeLedger('{"a":1}', ok)).rejects.toBeTruthy()
    expect(ls.getItem(cache.LEGACY_KEY)).toBe('{"old":true}')
  })
})

describe('断线重接', () => {
  it('连接断了（Safari 后台回收后的第一次读写）：扔掉旧连接、重开一次，写成功，不报错', async () => {
    // 变异：withDb 不重试（i >= 1 改成 i >= 0）→ 红
    await cache.writeLedger('{"a":1}', ok) // 先开出一条连接
    const orig = FakeDB.prototype.transaction
    let n = 0
    vi.spyOn(FakeDB.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (n++ === 0) {
        const e = new Error('Connection to Indexed Database server lost. Refresh the page to try again')
        e.name = 'UnknownError'
        throw e
      }
      return orig.apply(this, args)
    })
    expect(await cache.writeLedger('{"a":2}', ok)).toBe('idb')
    expect(n).toBe(2)
    vi.restoreAllMocks()
    expect((await cache.readLedger()).idb).toBe('{"a":2}')
  })

  it('读也一样：第一次读断线，重开再读，拿到的是本机那份（不是当成没有）', async () => {
    await cache.writeLedger('{"a":1}', ok)
    const orig = FakeDB.prototype.transaction
    let n = 0
    vi.spyOn(FakeDB.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
      if (n++ === 0) throw Object.assign(new Error('connection lost'), { name: 'UnknownError' })
      return orig.apply(this, args)
    })
    const r = await cache.readLedger()
    expect(r).toMatchObject({ idb: '{"a":1}', failed: false })
  })

  it('配额满（事务提交时 abort）不重试：再试也是满，只试一次就报失败', async () => {
    // 变异：withDb 里去掉 isQuota(e) 的判断 → put 被调两次，红
    const spy = quotaOnCommit()
    const err = await cache.writeLedger('{"a":1}', ok).then(
      () => null,
      (e: unknown) => e as { name?: string },
    )
    expect(err?.name).toBe('QuotaExceededError')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('重开之后还是失败才算失败（抛给 store 去标降级）', async () => {
    await cache.writeLedger('{"a":0}', ok) // 先把库建好：fake-indexeddb 建库那一步自己也要建事务
    vi.spyOn(FakeDB.prototype, 'transaction').mockImplementation(() => {
      throw Object.assign(new Error('connection lost'), { name: 'UnknownError' })
    })
    await expect(cache.writeLedger('{"a":1}', ok)).rejects.toBeTruthy()
    const r = await cache.readLedger()
    expect(r.failed).toBe(true) // 读失败要标出来，不能当成「没有缓存」
  })
})

describe('IndexedDB 挂起', () => {
  it('写入超过 WRITE_TIMEOUT_MS 算失败（抛错），这个会话往后直接写 localStorage', async () => {
    // 变异：serial 里去掉超时 → 第一个 await 永远不回来，用例超时红
    setIndexedDB(hangingFactory())
    const p = cache.writeLedger('{"a":1}', ok)
    const outcome = p.then(
      () => 'ok',
      () => 'failed',
    )
    await vi.advanceTimersByTimeAsync(cache.WRITE_TIMEOUT_MS + 10)
    expect(await outcome).toBe('failed')

    // 变异：超时后不 giveUp → 这一句又要等 WRITE_TIMEOUT_MS，下面 advance 600 不够，红
    const p2 = cache.writeLedger('{"a":2}', ok)
    await vi.advanceTimersByTimeAsync(600)
    expect(await p2).toBe('local')
    expect(ls.getItem(cache.LEGACY_KEY)).toBe('{"a":2}')
  })

  it('读超过 OPEN_TIMEOUT_MS 就标读失败，localStorage 那份照样给', async () => {
    setIndexedDB(hangingFactory())
    ls.setItem(cache.LEGACY_KEY, '{"local":true}')
    const p = cache.readLedger()
    await vi.advanceTimersByTimeAsync(cache.OPEN_TIMEOUT_MS + 10)
    expect(await p).toEqual({ idb: null, local: '{"local":true}', backend: 'local', failed: true })
  })

  it('超时作废的那次写入，晚些醒过来也不许再落笔（不能盖掉后面写的新账本）', async () => {
    // 变异：writeLedger 里落 localStorage 之前不看 ctl.dead → 红
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    setIndexedDB({
      open: () => {
        const req: { result: unknown; onsuccess?: () => void; onerror?: () => void } = { result: null }
        // 门一直不开，等放行时报打不开 → 这次写入会退回 localStorage
        void gate.then(() => req.onerror?.())
        return req
      },
    })
    const p = cache.writeLedger('{"old":1}', ok).catch(() => 'failed')
    await vi.advanceTimersByTimeAsync(cache.WRITE_TIMEOUT_MS + 10)
    expect(await p).toBe('failed')
    expect(await cache.writeLedger('{"new":1}', ok)).toBe('local')
    release()
    await drain()
    expect(ls.getItem(cache.LEGACY_KEY)).toBe('{"new":1}')
  })
})

describe('打不开 IndexedDB', () => {
  it('没有 indexedDB（旧浏览器）：读写删全走 localStorage，和 1.3.30 一样', async () => {
    setIndexedDB(undefined)
    expect(await cache.writeLedger('{"a":1}', ok)).toBe('local')
    expect(await cache.readLedger()).toEqual({ idb: null, local: '{"a":1}', backend: 'local', failed: false })
    await cache.removeLedger()
    expect(ls.getItem(cache.LEGACY_KEY)).toBeNull()
  })

  it('open 报错（安卓存储快满时 Chrome 报 Internal error opening backing store）：退回 localStorage', async () => {
    setIndexedDB({
      open: () => {
        const req: { onerror?: () => void } = {}
        setImmediate(() => req.onerror?.())
        return req
      },
    })
    expect(await cache.writeLedger('{"a":1}', ok)).toBe('local')
    expect(ls.getItem(cache.LEGACY_KEY)).toBe('{"a":1}')
  })

  it('open 同步抛错（老版 Firefox 隐私窗口的 InvalidStateError）：退回 localStorage', async () => {
    setIndexedDB({
      open: () => {
        throw Object.assign(new Error('A mutation operation was attempted on a database that did not allow mutations.'), { name: 'InvalidStateError' })
      },
    })
    expect(await cache.writeLedger('{"a":1}', ok)).toBe('local')
  })
})

describe('退出登录', () => {
  it('删除排在之前的写入后面：退出前最后一次写入还在路上，删完 IndexedDB 里也不能留着上一个账号的账本', async () => {
    // 变异：queueDelete 不走 serial（直接开门就删）→ 删先落地、写后落地，红
    const p = cache.writeLedger('{"user":"A"}', ok)
    const del = cache.removeLedger()
    await p
    await del
    expect((await cache.readLedger()).idb).toBeNull()
    expect(ls.getItem(cache.LEGACY_KEY)).toBeNull()
  })

  it('删不掉 IndexedDB 那份时留下待删记号：下次冷启动不认它，再删一次', async () => {
    // 变异：readLedger 不看 WIPE_KEY → 第二段读到 A 的账本，红
    await cache.writeLedger('{"user":"A"}', ok)
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw Object.assign(new Error('connection lost'), { name: 'UnknownError' })
    })
    await cache.removeLedger()
    expect(ls.getItem(cache.WIPE_KEY)).toBe('1')
    vi.restoreAllMocks()

    vi.resetModules()
    const again = await import('./cache')
    expect((await again.readLedger()).idb).toBeNull()
    await drain()
    // 那次补删成功了，记号清掉，IndexedDB 里也真没了
    expect(ls.getItem(again.WIPE_KEY)).toBeNull()
    vi.resetModules()
    const third = await import('./cache')
    expect((await third.readLedger()).idb).toBeNull()
  })

  it('删成功就清掉待删记号；之后新账号写成功也清', async () => {
    await cache.writeLedger('{"user":"A"}', ok)
    await cache.removeLedger()
    expect(ls.getItem(cache.WIPE_KEY)).toBeNull()
    ls.setItem(cache.WIPE_KEY, '1')
    await cache.writeLedger('{"user":"B"}', ok)
    expect(ls.getItem(cache.WIPE_KEY)).toBeNull()
  })
})
