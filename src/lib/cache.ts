// 本机缓存的存储层：账本快照放 IndexedDB，待上传队列放 localStorage。
// 只管「一串字符串存在哪、怎么读回来」——不认识 Snapshot、不依赖 store / api，
// 所以能在 node 里拿 fake-indexeddb 测（store.test.ts、cache.test.ts）。只许 store.ts import。
//
// 为什么搬到 IndexedDB（2026-10-09）：localStorage 整个域名只有 5 MiB（按 UTF-16 算），
// 一条流水约 560 字节，每天 6 笔三年多就满；而且同一个域名下还住着交易日志，这 5 MiB 是两个 App 分的。
// IndexedDB 的配额按设备容量给（iOS 17 起、Chrome 都是一个站点最多占硬盘的六成），几十年也用不完。
//
// 待上传队列**故意不跟着搬**：它是本机唯一一份云端没有的数据，而 localStorage 是同步 API、
// 写一下就落盘，不受 IndexedDB 打不开、请求挂起、配额满的牵连；一条队列最多几十笔，永远小。
//
// 兜底，全都是为了「IndexedDB 出任何问题，用户最多看到旧账本，绝不丢账」：
//   1. 打不开（旧浏览器、隐私模式、锁定模式）就退回 localStorage，行为和 1.3.30 一样；
//   2. 连接断了（Safari 在后台被回收后会报 "Connection to Indexed Database server lost"）：
//      扔掉旧连接、重开一次再试，还不行才算失败。配额满不重试——再试也是满；
//   3. 开门或读写挂起（Safari 出过 open 永远不回调的 bug）：一次操作连开门带读写，冷启动最多等 OPEN_TIMEOUT_MS、
//      写最多等 WRITE_TIMEOUT_MS，超时就放弃，这个会话剩下的时间都走 localStorage；
//   4. 两边都可能有一份账本时（上一个会话退回过 localStorage），由 store 挑（按 at，空账本不许赢）；
//   5. 读失败和「真的没有」分开报（`failed`），store 读失败时不许拿一张白纸去盖本机那份好的。

export const DB_NAME = 'jz-cache' // 同一个域名下交易日志用的是 tj-journal，别撞
export const STORE = 'kv'
export const LEDGER_KEY = 'ledger'
/** 1.3.30 及以前：整份账本（连同待传队列）在 localStorage 的这个键里。现在只在搬家、回退和兜底时用 */
export const LEGACY_KEY = 'jz_cache_v1'
export const OUTBOX_KEY = 'jz_outbox_v1'
/**
 * 退出登录时同步写下的「待删」记号。IndexedDB 的删除是异步的，可能删不掉（挂起、页面马上被关）；
 * 记号在，下次冷启动就不认 IndexedDB 那份、再删一次。删成功、或之后有一次写入成功（同一个键被盖掉）才清
 */
export const WIPE_KEY = 'jz_cache_wipe'

/** 冷启动读缓存的上限（开门 + 读，断线重开也算在里面）。超过就当读失败往下走，别让用户盯着「加载中」 */
export const OPEN_TIMEOUT_MS = 4_000
/** 一次写入或删除的上限（开门 + 写）。超过算失败（store 会标降级），这个会话往后改写 localStorage */
export const WRITE_TIMEOUT_MS = 10_000

export type Backend = 'idb' | 'local'

export interface LedgerRead {
  /** IndexedDB 里那份；打不开、超时、没有、有待删记号都是 null */
  idb: string | null
  /** localStorage 里那份：1.3.30 及以前写的，或 IndexedDB 不可用时兜底写的；没有就是 null */
  local: string | null
  /** 这个会话往后写到哪 */
  backend: Backend
  /** IndexedDB 开得了门却读不出来（报错、超时）。和「真的没有」不是一回事：本机那份可能是好的，只是这次没读到 */
  failed: boolean
}

const TIMEOUT = Symbol('timeout')
const NO_DB = Symbol('no-db')

// ── 连接 ───────────────────────────────────────────────────────

let dbPromise: Promise<IDBDatabase | null> | null = null
/** 当前在用的连接。扔连接时核对是不是它：别的操作已经换上的新连接不能被误扔（审查 F17） */
let currentDb: IDBDatabase | null = null

/**
 * 开（或复用）数据库连接。打不开一律 resolve null——不 reject，调用方只需要问「能不能用」。
 * 连接被浏览器关掉（Safari 后台回收、别的标签页升级版本）就把记忆丢掉，下一次操作重新开。
 */
function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  const mine: Promise<IDBDatabase | null> = new Promise((resolve) => {
    let req: IDBOpenDBRequest
    try {
      const factory = globalThis.indexedDB
      if (!factory) {
        resolve(null)
        return
      }
      req = factory.open(DB_NAME, 1)
    } catch {
      // Firefox 隐私窗口的老版本会在这里同步抛 InvalidStateError
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => {
      const db = req.result
      // 超时之后才开出来的连接没人要了（dbPromise 已经被钉成别的），关掉别漏
      if (dbPromise !== mine) {
        db.close()
        resolve(null)
        return
      }
      currentDb = db
      const forget = () => {
        if (currentDb === db) currentDb = null
        if (dbPromise === mine) dbPromise = null
      }
      db.onversionchange = () => {
        db.close()
        forget()
      }
      db.onclose = forget
      resolve(db)
    }
    req.onerror = () => {
      if (dbPromise === mine) dbPromise = null // 下一次操作再试着开
      resolve(null)
    }
    // onblocked 不处理：版本号一直是 1，不会有升级等别人让路的事；真有也由超时兜底
  })
  dbPromise = mine
  return mine
}

/** 这个连接坏了：关掉、忘掉。只忘「它」——别的操作已经换上的新连接不动 */
function dropConn(db: IDBDatabase): void {
  if (currentDb === db) {
    currentDb = null
    dbPromise = null
  }
  try {
    db.close()
  } catch {
    /* 本来就断了 */
  }
}

/** 这个会话剩下的时间都不再碰 IndexedDB。挂起过一次的东西，再等一次只是再浪费一次超时 */
function giveUp(): void {
  dbPromise = Promise.resolve(null)
  currentDb = null
}

function isQuota(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'QuotaExceededError'
}

/**
 * 拿连接跑一次。连接类错误（不是配额满）扔掉旧连接、重开、再跑一次——Safari 后台回收之后第一次读写
 * 报「连接丢失」，苹果的口径就是重开连接再试。打不开返回 NO_DB，第二次还失败就抛。
 */
async function withDb<T>(attempt: (db: IDBDatabase) => Promise<T>): Promise<T | typeof NO_DB> {
  for (let i = 0; ; i++) {
    const db = await openDb()
    if (!db) return NO_DB
    try {
      return await attempt(db)
    } catch (e) {
      dropConn(db)
      if (isQuota(e) || i >= 1) throw e
    }
  }
}

// ── 串行化 ─────────────────────────────────────────────────────
// 读、写、删全部排成一队，**连开门、连退回 localStorage 的那一步都在队里**。
// IndexedDB 自己只保证「同一时刻已经创建的事务」按创建顺序执行，而创建事务之前还要先 await 开门——
// 两个调用各 await 各的，谁先落地取决于开门什么时候回来。「退出登录删缓存」落在「退出前最后一次写缓存」
// 之前，就会把上一个账号的账本留在机器上。排队之后完成顺序就是调用顺序。
//
// 挂起的操作到了超时就让位（不会把后面的全卡死），并且**作废**：它自己还在跑的话，
// 落笔之前看一眼 ctl.dead 就不写了；已经发出去的 IndexedDB 事务直接 abort。
interface Ctl {
  dead: boolean
  /** 超时时调：用来 abort 还在跑的事务 */
  onDead?: () => void
}

let chain: Promise<unknown> = Promise.resolve()

function serial<T>(op: (ctl: Ctl) => Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  const run = chain.then(
    () =>
      new Promise<T | typeof TIMEOUT>((resolve, reject) => {
        const ctl: Ctl = { dead: false }
        const timer = setTimeout(() => {
          ctl.dead = true
          try {
            ctl.onDead?.()
          } catch {
            /* ignore */
          }
          resolve(TIMEOUT)
        }, ms)
        op(ctl).then(
          (v) => {
            clearTimeout(timer)
            resolve(v)
          },
          (e: unknown) => {
            clearTimeout(timer)
            reject(e)
          },
        )
      }),
  )
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** 等事务真正提交。put 的 onsuccess 不等于落盘，配额满是在事务 abort 时才报出来的 */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'))
  })
}

function getLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function removeLocal(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** 删 IndexedDB 那份（排在队里）。删成功才清待删记号 */
function queueDelete(): Promise<unknown> {
  return serial(async (ctl) => {
    const r = await withDb((db) => {
      const tx = db.transaction(STORE, 'readwrite')
      ctl.onDead = () => tx.abort()
      tx.objectStore(STORE).delete(LEDGER_KEY)
      return done(tx)
    })
    if (r !== NO_DB && !ctl.dead) removeLocal(WIPE_KEY)
  }, WRITE_TIMEOUT_MS).then(
    (r) => {
      if (r === TIMEOUT) giveUp()
    },
    () => {
      /* 删不掉：记号留着，下次冷启动再删 */
    },
  )
}

/** 读两边。绝不抛：缓存读不到对 App 只是「没有缓存」，但读失败要标出来（failed） */
export async function readLedger(): Promise<LedgerRead> {
  // 有待删记号：上一个账号退出时没删干净。IndexedDB 那份一律不认，再删一次
  if (getLocal(WIPE_KEY) !== null) {
    removeLocal(LEGACY_KEY)
    void queueDelete()
    return { idb: null, local: null, backend: 'idb', failed: false }
  }
  const local = getLocal(LEGACY_KEY)
  let v: string | null | typeof NO_DB | typeof TIMEOUT
  try {
    v = await serial(
      () =>
        withDb(async (db) => {
          const got = await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(LEDGER_KEY))
          return typeof got === 'string' ? got : null
        }),
      OPEN_TIMEOUT_MS,
    )
  } catch {
    // 重开一次还是读不出来
    return { idb: null, local, backend: 'idb', failed: true }
  }
  if (v === TIMEOUT) {
    giveUp()
    return { idb: null, local, backend: 'local', failed: true }
  }
  if (v === NO_DB) return { idb: null, local, backend: 'local', failed: false }
  return { idb: v, local, backend: 'idb', failed: false }
}

export interface WriteOpts {
  /**
   * 待传队列已经落在自己的键里了（store 的 saveOutbox 最近一次成功）。只有这时才能删老缓存：
   * 1.3.30 写的老缓存里还包着一份队列，队列没落到新地方之前它是唯一的备份
   */
  dropLegacy: boolean
}

/**
 * 写账本。成功返回写到了哪（作废了返回 null）；失败抛错（配额满、重开也写不进、超时），由 store 标降级并提示。
 * 开门、写 IndexedDB、退回 localStorage 都在同一个排队的操作里，完成顺序等于调用顺序。
 */
export async function writeLedger(json: string, opts: WriteOpts): Promise<Backend | null> {
  const r = await serial(async (ctl): Promise<Backend | null> => {
    const w = await withDb((db) => {
      if (ctl.dead) return Promise.resolve(false)
      const tx = db.transaction(STORE, 'readwrite')
      ctl.onDead = () => tx.abort()
      tx.objectStore(STORE).put(json, LEDGER_KEY)
      return done(tx).then(() => true)
    })
    if (ctl.dead) return null
    if (w === NO_DB) {
      localStorage.setItem(LEGACY_KEY, json)
      removeLocal(WIPE_KEY)
      return 'local'
    }
    if (!w) return null
    // 同一个键被新账本盖掉了，上一个账号的那份已经不在：待删记号可以清了
    removeLocal(WIPE_KEY)
    if (opts.dropLegacy) removeLocal(LEGACY_KEY)
    return 'idb'
  }, WRITE_TIMEOUT_MS)
  if (r === TIMEOUT) {
    giveUp()
    throw new Error('IndexedDB write timed out')
  }
  return r
}

/**
 * 退出登录：两边都删。先同步写下待删记号、删掉 localStorage 那份（这两步一定成功），
 * IndexedDB 那份排在队里删——一定落在之前的写入后面；删不掉（挂起、页面马上被关）有记号兜着，
 * 下次冷启动 readLedger 不认它并再删一次。不抛：退出登录不该因为这个失败。
 */
export function removeLedger(): Promise<unknown> {
  try {
    localStorage.setItem(WIPE_KEY, '1')
  } catch {
    /* 连这个都写不进去，只能靠下面那次删除了 */
  }
  removeLocal(LEGACY_KEY)
  return queueDelete()
}

/**
 * 删掉老缓存，给待传队列腾地方（localStorage 被它占满、队列写不进去时用）。
 * 只在账本已经写进 IndexedDB、队列又在内存里的时候调；排在队里，不会和正在落笔的写入撞
 */
export function dropLegacy(): Promise<unknown> {
  return serial(async () => removeLocal(LEGACY_KEY), WRITE_TIMEOUT_MS)
}

// ── 待上传队列（localStorage，同步）────────────────────────────

/** jz_outbox_v1 的形状。at = 写下的时刻，回退再升级时拿它和老缓存比谁新 */
export interface OutboxFile {
  at: string
  entries: unknown
}

export interface OutboxRead {
  /** 键在不在。不在 = 1.3.30 及以前的机器，队列还包在老缓存里 */
  found: boolean
  /** 写下的时刻；坏的、没有就是 null */
  at: string | null
  /** 条目，由 outbox.ts 的 unpackOutbox 逐条认；坏的就是 null */
  entries: unknown
}

export function readOutboxDump(): OutboxRead {
  let s: string | null
  try {
    s = localStorage.getItem(OUTBOX_KEY)
  } catch {
    return { found: false, at: null, entries: null }
  }
  if (s === null) return { found: false, at: null, entries: null }
  try {
    const v = JSON.parse(s) as unknown
    if (Array.isArray(v)) return { found: true, at: null, entries: v }
    const o = v as Partial<OutboxFile> | null
    return { found: true, at: typeof o?.at === 'string' ? o.at : null, entries: o?.entries ?? null }
  } catch {
    return { found: true, at: null, entries: null }
  }
}

/** 抛错（配额满、被禁）交给调用方 */
export function writeOutboxDump(f: OutboxFile): void {
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(f))
}

export function removeOutboxDump(): void {
  removeLocal(OUTBOX_KEY)
}

/** 浏览器给这个域名的存储配额（字节）。不支持 estimate 的（iOS 17 之前）就是 null，设置页据此只报占了多少 */
export async function storageQuota(): Promise<number | null> {
  try {
    const est = await globalThis.navigator?.storage?.estimate?.()
    const q = est?.quota
    return typeof q === 'number' && Number.isFinite(q) && q > 0 ? q : null
  } catch {
    return null
  }
}
