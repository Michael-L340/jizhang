// 全局状态。页面只从这里读数据、只调这里的动作；这里是唯一调用 api.ts 的地方。
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Account, CatKind, Category, Snapshot, Transaction } from '../types'
import * as api from './api'
import { cacheBytes, type BackupStatus } from './backup'
import { nowIso } from './date'
import { applyPending, DELETED, type Pending } from './pending'
import { packOutbox, unpackOutbox, type Outbox, type OutboxDump } from './outbox'
import { INNER_TTL_MS, type Mode } from './facade'

const CACHE_KEY = 'jz_cache_v1'

interface Cache extends Snapshot {
  at: string
  /** 待上传队列。旧版本写的缓存没有这个键，unpackOutbox 会返回空队列 */
  outbox?: OutboxDump
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cache
    if (!Array.isArray(c.accounts) || !Array.isArray(c.categories) || !Array.isArray(c.transactions)) return null
    // 冷启动先拿缓存渲染，而这份缓存可能是加新列之前的版本写的，那些键根本不存在。
    // undefined 不等于 null，会一路走进算式：dayInMonth(ym, undefined) 算出 "2026-09-NaN"，
    // 「本月应还」在首屏就是错的（等一次同步回来才会自愈）。在入口补齐，别让 undefined 流出去。
    return {
      ...c,
      accounts: c.accounts.map((a) => ({ ...a, repay_day: a.repay_day ?? null, facade_offset: a.facade_offset ?? null, defer_after_repay: a.defer_after_repay ?? null })),
      transactions: c.transactions.map((t) => ({ ...t, installments: t.installments ?? null, settles: t.settles ?? null })),
    }
  } catch {
    return null
  }
}

/**
 * 写缓存。只写三张表，不要把整个 store 展开进来（否则 auth/syncing/toast 也会被写）。
 * 返回占用的字节数（口径见 backup.ts 的 cacheBytes：UTF-16，键也算）。
 * 抛错交给调用方处理，不再静默吞掉。
 */
function writeCache(s: Snapshot, outbox: Outbox): number {
  const c: Cache = { accounts: s.accounts, categories: s.categories, transactions: s.transactions, at: nowIso(), outbox: packOutbox(outbox) }
  const json = JSON.stringify(c)
  localStorage.setItem(CACHE_KEY, json)
  return cacheBytes([[CACHE_KEY, json]])
}

export interface Toast {
  id: number
  msg: string
  undo?: () => void | Promise<void>
}

export interface State extends Snapshot {
  auth: 'loading' | 'out' | 'in'
  /** 本次会话是否已从云端成功拉取过 */
  loaded: boolean
  syncing: boolean
  /** 本次同步开始的时间戳；卡死超过 STALE_SYNC_MS 就允许重新发起 */
  syncingSince: number | null
  lastSync: string | null
  /** 上次同步是否失败（首次加载成功后失败不再静默） */
  syncFailed: boolean
  toast: Toast | null
  /** 本机缓存占用字节数（UTF-16），0 表示还没写过 */
  cacheBytes: number
  /** 缓存写不进去了（配额满或被禁用），离线看到的数据可能是旧的 */
  cacheDegraded: boolean
  /** 每日自动备份的状态（另一个私有仓库跑的，见 backup.ts）。null = 没备份过或还没读到 */
  backup: BackupStatus | null
  /** 备份状态读失败（网络不通 / 登录过期）。和「从来没备份过」要分开显示 */
  backupFailed: boolean
  /** 还没传上云端的记录条数。>0 说明本机比云端多／少几笔，备份里也还没有 */
  outboxCount: number
  /**
   * 里外页面。outer = 平时用的外页面（余额被偏移量修饰过），inner = 只有本人知道的里页面（真实余额）。
   * **绝不写进缓存**：冷启动必须永远是 outer，否则这个开关就没有意义了。
   * persist() 只写三张表，所以这条不用额外处理——但以后有人想「顺手把整个 store 存下来」时，
   * 这就是不能那么干的理由。
   */
  mode: Mode

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** 把待上传队列补传到云端。联网时自动调，用户也能手动点 */
  flushOutbox: () => Promise<void>
  /** 去抖写入本机缓存，从当前 state 现读，不接受外部快照 */
  persist: () => void
  /**
   * 读每日自动备份的状态。故意**不**走 refresh() 那套在途补丁 / 超时锁的机制：
   * 它不改账本，一天看一次就够，由设置页挂载时调用。
   * 但「只有最后一次的答案算数」这条必须有（backupSeq），设置页来回切就会有两次在飞。
   */
  loadBackupStatus: () => Promise<void>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>

  addTx: (t: Transaction) => Promise<boolean>
  editTx: (t: Transaction) => Promise<boolean>
  removeTx: (id: string) => Promise<boolean>

  addCategory: (kind: CatKind, parentId: string | null, name: string) => Promise<Category | null>
  updateCategory: (id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived' | 'note' | 'parent_id'>>) => Promise<boolean>
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived' | 'facade_offset' | 'defer_after_repay'>>) => Promise<boolean>
  /** 合并导入：同 id 覆盖，不删任何东西 */
  importSnapshot: (snap: Snapshot) => Promise<void>
  /**
   * 整库恢复：先清空云端再整份写入。调用方必须已经跟用户确认过，且 snap 必须过了 validate.ts。
   * 中途失败会拿操作前的快照自动回滚一次，失败时抛的是 RestoreFailed，message 可直接显示。
   */
  restoreSnapshot: (snap: Snapshot) => Promise<void>

  setMode: (m: Mode) => void
  /** 切走 App 时记一下时间点 */
  noteHidden: () => void
  /** 切回前台：离开超过 INNER_TTL_MS 就自动退回外页面 */
  noteVisible: () => void

  showToast: (msg: string, undo?: () => void | Promise<void>) => void
  hideToast: () => void
}

/**
 * 上一次切走 App 的时间点。放模块级而不是 state：它只用来算一个判断，
 * 放进 state 会让每次前后台切换都触发一轮全局重渲染。
 */
let hiddenAt: number | null = null

// ── 在途写入的补丁表 ──────────────────────────────────────────
// 一次写请求飞在路上时，refresh() 拉回的快照里还没有它。直接 set 会把它冲掉，
// 用户看到「刚记的那笔消失了」而实际上云端已经存了，很容易重记一遍。
// 所以 refresh 落地前先把在途补丁叠回去。
const pendingTx: Pending<Transaction> = new Map()
const pendingCat: Pending<Category> = new Map()

// ── 待上传队列 ────────────────────────────────────────────────
// 上面那两张补丁表管的是「请求飞在路上」，60 秒就过期；这一张管的是「请求根本没发出去」，
// 只有真的传上去才删、还要写进缓存跨会话保留。详见 outbox.ts 顶部。
const outboxTx: Outbox = new Map()
/** 补传是串行的，防止 online 事件和 refresh 各触发一次、同一条被传两遍 */
let flushing = false

// 补丁不能一写完就删，那只挡住了一个方向的时序。
// 反过来的顺序照样出事：refresh 先发出 GET（此刻服务端还没有这笔）→ 用户立刻记一笔、
// POST 后发先至并成功 → 那份「比写入更早出门」的快照这时才落地，补丁表已空，
// 于是用过期快照覆盖了正确的状态，刚记的那笔从界面消失、刚删的那条复活。
//
// 正确的退休判据不是「写完了没」，而是「有没有一次在写完之后才出门的同步回来过」。
// 所以给每次真正发出的 GET 编号，写成功时记下当时的号，只有更晚的号回来才允许丢补丁。
let fetchSeq = 0
const settledTx = new Map<string, number>()
const settledCat = new Map<string, number>()

// 备份状态这一路也编号，理由同类但简单得多：只有「最后一次问的答案」算数。
// 设置页每次挂载都发一次，来回切页就有两次在飞；退出登录也算改朝换代。
// 不编号有两种翻车：
//   1. 第一次慢且最后失败、第二次快且成功 —— 慢的那次晚回来，把「正常」覆盖成「读不到」；
//   2. 在途那次落在 signOut 之后 —— signOut 刚清掉的备份时间又被写回来。
let backupSeq = 0

/** 快照落地前淘汰已经被这次 GET 覆盖到的补丁。g < my 意味着这次 GET 出门时该写入已经落库 */
function retirePatches(my: number): void {
  for (const [id, g] of settledTx) {
    if (g >= my) continue
    pendingTx.delete(id)
    settledTx.delete(id)
  }
  for (const [id, g] of settledCat) {
    if (g >= my) continue
    pendingCat.delete(id)
    settledCat.delete(id)
  }
}

/**
 * 写成功：等一次「出门时间晚于本次写入」的同步回来再退休。
 * 兜底定时器是防止长期不同步时补丁表越攒越多；60 秒安全地大于 FETCH_TIMEOUT_MS，
 * 所以不会出现「补丁已删、更早出门的 GET 还在飞」。
 */
function settle(map: Map<string, number>, pending: Map<string, unknown>, id: string): void {
  map.set(id, fetchSeq)
  setTimeout(() => {
    if (map.get(id) === undefined) return
    map.delete(id)
    pending.delete(id)
  }, PATCH_TTL_MS)
}

/** 写失败：立刻删补丁。留着的话，那份还在飞的旧快照落地时会把一条根本没进云端的记录塞回来 */
function drop(map: Map<string, number>, pending: Map<string, unknown>, id: string): void {
  map.delete(id)
  pending.delete(id)
}

/**
 * 写失败且不是数据被拒 —— 也就是没网、网太慢、登录过期 —— 就进待传队列。
 * 补丁表那条要一并删掉：两张表管的是同一个 id 的话，队列才是权威的那个。
 */
function enqueue(id: string, v: Transaction | typeof DELETED): void {
  drop(settledTx, pendingTx, id)
  outboxTx.set(id, v)
}

/** 单次 fetchAll 的超时。没有它，iOS 后台冻结时飞在路上的请求可能永远不 settle */
const FETCH_TIMEOUT_MS = 30_000
/** 上一次同步超过这个时间还没落地就视为已死，允许重新发起。必须大于 FETCH_TIMEOUT_MS */
const STALE_SYNC_MS = 45_000
/** 在途补丁的兜底存活时间。必须大于 FETCH_TIMEOUT_MS */
const PATCH_TTL_MS = 60_000

// ── 缓存写入去抖 ────────────────────────────────────────────
// 每次增删改都同步 JSON.stringify 全量流水，数据多了会让「保存」明显卡顿，
// 而撤销路径还会连着触发两次。尾部去抖 500ms。
let persistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 导入 / 恢复之后把界面拉到云端真实状态。
 * refresh() 在 syncing 时会静默早退（手机上选文件会把 App 切后台，回来那次同步可能还在飞），
 * 直接调用有概率什么都不做，所以先等上一次同步落地，最多等 10 秒。
 */
async function pullAfterWrite(get: () => State): Promise<void> {
  for (let i = 0; i < 40 && get().syncing; i++) await new Promise((r) => setTimeout(r, 250))
  await get().refresh()
}

/**
 * 「整库恢复」失败时抛的错。message 已经是给用户看的**完整**说明——包括云端现在是什么状态、
 * 该怎么办——页面直接原样显示就行，别再往后面拼别的话，那样只会自相矛盾。
 */
export class RestoreFailed extends Error {
  constructor(msg: string) {
    super(msg)
    this.name = 'RestoreFailed'
  }
}

let toastSeq = 0
let toastTimer: ReturnType<typeof setTimeout> | null = null
let unsubAuth: (() => void) | null = null

export const useStore = create<State>((set, get) => ({
  accounts: [],
  categories: [],
  transactions: [],
  auth: 'loading',
  loaded: false,
  syncing: false,
  syncingSince: null,
  lastSync: null,
  syncFailed: false,
  toast: null,
  cacheBytes: 0,
  cacheDegraded: false,
  backup: null,
  backupFailed: false,
  outboxCount: 0,
  mode: 'outer',

  async init() {
    const cache = readCache()
    if (cache) {
      // 队列要在拉云端之前装回来，否则第一次 refresh 会把上次没传上去的那几笔冲掉
      for (const [id, v] of unpackOutbox(cache.outbox)) outboxTx.set(id, v)
      set({ accounts: cache.accounts, categories: cache.categories, transactions: cache.transactions, lastSync: cache.at, outboxCount: outboxTx.size })
      try {
        set({ cacheBytes: cacheBytes([[CACHE_KEY, localStorage.getItem(CACHE_KEY) ?? '']]) })
      } catch {
        /* 读不到就当没有 */
      }
    }
    const signedIn = await api.hasSession()
    set({ auth: signedIn ? 'in' : 'out' })
    unsubAuth?.()
    unsubAuth = api.onAuthChange((ok) => {
      const prev = get().auth
      set({ auth: ok ? 'in' : 'out' })
      if (ok && prev !== 'in') void get().refresh()
    })
    if (signedIn) await get().refresh()
  },

  async refresh() {
    if (get().auth !== 'in') return
    const since = get().syncingSince
    // 「正在同步」曾经是一把没有超时的锁：请求一旦永远不返回，此后整个会话的同步
    // 都会在这一行被静默丢掉，杀掉 App 才能恢复。超过 STALE_SYNC_MS 就当上一次已死。
    if (since !== null && Date.now() - since < STALE_SYNC_MS) return
    const my = ++fetchSeq
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
    set({ syncing: true, syncingSince: Date.now() })
    try {
      const snap = await api.fetchAll(ac.signal)
      if (my !== fetchSeq) return // 已被更新的一轮取代，这份旧快照不许落地
      // 顺序要紧：先按世代淘汰过期补丁，再把仍在途的叠回去
      retirePatches(my)
      const merged: Snapshot = {
        accounts: snap.accounts,
        categories: applyPending(snap.categories, pendingCat),
        // 两层叠加，顺序不能反：先盖在途补丁，再盖待传队列。
        // 队列在最上面，因为那是用户改完、云端至今不知道的最新状态。
        transactions: applyPending(applyPending(snap.transactions, pendingTx), outboxTx),
      }
      set({ ...merged, loaded: true, lastSync: nowIso(), syncFailed: false })
      get().persist()
      // 网通了，把欠的补上。不 await：补传失败不该让这次同步显示成失败
      void get().flushOutbox()
    } catch (e) {
      if (my !== fetchSeq) return
      // 首次加载成功之后失败也要留痕，否则断网/登录过期/项目休眠全都无声
      set({ syncFailed: true })
      if (!get().loaded) get().showToast(`同步失败：${api.friendlyError(e)}`)
    } finally {
      clearTimeout(timer)
      if (my === fetchSeq) set({ syncing: false, syncingSince: null })
    }
  },

  /**
   * 把待传队列补上去。串行、一条一条来，中途再断网就停下，剩下的留到下次。
   *
   * 三个调用点：每次 refresh 成功之后、浏览器 online 事件、用户手动点「立即上传」。
   * 所以必须能重入而不重复发送 —— flushing 那把锁就是干这个的。
   */
  async flushOutbox() {
    if (flushing || get().auth !== 'in' || outboxTx.size === 0) return
    flushing = true
    try {
      // 先拷一份再遍历：循环体里会删 outboxTx，边删边遍历行为不确定
      for (const [id, v] of [...outboxTx.entries()]) {
        try {
          if (v === DELETED) await api.deleteTx(id)
          else await api.upsertTx(v)
          // 只删「我刚传的那一版」。这一条在等响应的几百毫秒里可能又被改过
          // （改的那次也没网，于是队列里换成了新版本）；无条件 delete 会把新版本一起抹掉，
          // 结果云端是旧值、界面是新值、队列空了——再也没有东西会去纠正它。
          if (outboxTx.get(id) === v) outboxTx.delete(id)
        } catch (e) {
          if (!api.isPermanentError(e)) break // 还是没网，后面的也别试了
          // 数据被拒：重传一万次也是同样结果，只能扔掉并告诉用户。
          // 界面上也要一起撤掉，否则会留下一条「本机有、云端永远没有」的幽灵记录。
          // 同样只删我传的那一版：新版本也许是合法的，该留给下一轮试。
          if (outboxTx.get(id) !== v) continue
          outboxTx.delete(id)
          if (v !== DELETED) set((st) => ({ transactions: st.transactions.filter((x) => x.id !== id) }))
          get().showToast(`有 1 笔上传被拒绝，已从本机移除：${api.friendlyError(e)}`)
        }
      }
    } finally {
      flushing = false
      set({ outboxCount: outboxTx.size })
      get().persist()
    }
  },

  persist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const { accounts, categories, transactions } = get()
      try {
        set({ cacheBytes: writeCache({ accounts, categories, transactions }, outboxTx), cacheDegraded: false })
      } catch {
        // 配额满或被禁用。云端数据不受影响，但离线看到的会是旧的，必须让用户知道
        if (!get().cacheDegraded) {
          set({ cacheDegraded: true })
          get().showToast('本机缓存已满，离线时看到的可能是旧数据')
        }
      }
    }, 500)
  },

  async loadBackupStatus() {
    const my = ++backupSeq
    let failed = false
    const b = await api.fetchBackupStatus(() => {
      failed = true
    })
    // 已被更新的一轮（或一次 signOut）取代，这份旧答案不许落地
    if (my !== backupSeq) return
    set({ backup: b, backupFailed: failed })
  },

  async signIn(email, password) {
    await api.signIn(email, password)
    set({ auth: 'in' })
    await get().refresh()
  },

  async signOut() {
    await api.signOut()
    // 先取消在途的去抖写入，否则它会落在 removeItem 之后，缓存又被写回来
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    pendingTx.clear()
    pendingCat.clear()
    settledTx.clear()
    settledCat.clear()
    // 换个人登录进来必须是外页面
    hiddenAt = null
    set({ mode: 'outer' })
    // 推进号码，让还在飞的那次 loadBackupStatus 回来时自己作废，
    // 否则下面刚清掉的 backup 会被它写回来
    backupSeq++
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* ignore */
    }
    // 队列也要清：换个账号登进来，把上一个账号的记录补传过去是灾难。
    // 代价是退出登录会丢掉还没传上去的那几笔，所以退出前要拦一下（见 Settings.tsx）。
    outboxTx.clear()
    set({ auth: 'out', accounts: [], categories: [], transactions: [], loaded: false, lastSync: null, cacheBytes: 0, cacheDegraded: false, syncFailed: false, syncing: false, syncingSince: null, backup: null, backupFailed: false, outboxCount: 0 })
  },

  async addTx(t) {
    pendingTx.set(t.id, t)
    // 函数式 set + 按 id 打补丁：整数组快照回滚会把并发操作的结果一起抹掉
    set((s) => ({ transactions: [t, ...s.transactions] }))
    get().persist()
    try {
      await api.insertTx(t)
      // 成功不能立刻删补丁：可能有一次「比这次写入更早出门」的同步还在飞，
      // 它落地时会用一份没有这笔的快照把界面盖回去
      settle(settledTx, pendingTx, t.id)
      return true
    } catch (e) {
      // 数据被服务器拒了：立刻删干净。留着的话那份旧快照落地时会把一条根本没进云端的
      // 记录塞回来，用户明明看到「保存失败」，账本里却多出一笔幽灵记录
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, t.id)
        set((s) => ({ transactions: s.transactions.filter((x) => x.id !== t.id) }))
        get().persist()
        get().showToast(`保存失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：这笔留在界面上，进待传队列，联网后自动补。
      // 返回 true 是故意的——对用户来说这笔账**已经记下了**，页面该照常收尾。
      enqueue(t.id, t)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast('没网，已存在本机，联网后自动上传')
      return true
    }
  },

  async editTx(t) {
    const before = get().transactions.find((x) => x.id === t.id)
    pendingTx.set(t.id, t)
    set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? t : x)) }))
    get().persist()
    try {
      await api.updateTx(t)
      settle(settledTx, pendingTx, t.id)
      return true
    } catch (e) {
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, t.id)
        // 用 map 换回旧值而不是插回去：这条可能已被并发删除，插回去会让它复活
        if (before) set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? before : x)) }))
        get().persist()
        get().showToast(`修改失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：改完的样子留在界面上，队列里存最终状态。
      // 这条本来就在队列里（断网时记的）也没关系——一个 id 只有一条，直接覆盖。
      enqueue(t.id, t)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast('没网，改动已存在本机，联网后自动上传')
      return true
    }
  },

  async removeTx(id) {
    const row = get().transactions.find((x) => x.id === id)
    pendingTx.set(id, DELETED)
    set((s) => ({ transactions: s.transactions.filter((x) => x.id !== id) }))
    get().persist()
    try {
      await api.deleteTx(id)
      settle(settledTx, pendingTx, id)
      return true
    } catch (e) {
      if (api.isPermanentError(e)) {
        drop(settledTx, pendingTx, id)
        // 位置无所谓：列表都靠 groupByDay/sortTxs 重排。但要幂等，
        // 万一 refresh 已经把它拉回来了，不能插成两条
        if (row) set((s) => (s.transactions.some((x) => x.id === id) ? s : { transactions: [row, ...s.transactions] }))
        get().persist()
        get().showToast(`删除失败：${api.friendlyError(e)}`)
        return false
      }
      // 没网：界面上就当删了，队列里记一条「删除」。
      // 就算这笔本来也没传上去过（断网记的、断网又删的），补传时 delete 一个
      // 云端不存在的 id 是安全的空操作，不用额外记「它到底进没进过云端」。
      enqueue(id, DELETED)
      set({ outboxCount: outboxTx.size })
      get().persist()
      get().showToast('没网，删除已存在本机，联网后自动上传')
      return true
    }
  },

  async addCategory(kind, parentId, name) {
    const trimmed = name.trim()
    if (!trimmed) return null
    const findSame = (): Category | undefined => get().categories.find((c) => c.kind === kind && c.parent_id === parentId && c.name === trimmed)
    // 同名的分类已经在库里：直接复用它。分类只归档不删除，同名多半就是同一件事，
    // 所以归档过的要原地取消归档——但必须说一声，历史记录会跟着一起回来，
    // 不吭声的话用户以为自己建了个干干净净的新分类。
    const reuse = async (existing: Category): Promise<Category> => {
      if (existing.is_archived && (await get().updateCategory(existing.id, { is_archived: false }))) {
        get().showToast(`「${existing.name}」之前归档过，已经恢复，历史记录一起回来了`)
      }
      return existing
    }
    const existing = findSame()
    if (existing) return await reuse(existing)
    const siblings = get().categories.filter((c) => c.kind === kind && c.parent_id === parentId)
    const sort = siblings.reduce((m, c) => Math.max(m, c.sort), 0) + 1
    try {
      const created = await api.addCategory({ kind, parent_id: parentId, name: trimmed, sort })
      // 登记为在途：紧接着的一次 refresh 可能还拉不到它，会把它冲掉
      pendingCat.set(created.id, created)
      settle(settledCat, pendingCat, created.id)
      set((st) => ({ categories: [...st.categories, created] }))
      get().persist()
      return created
    } catch (e) {
      // 网慢时连点两次「确定」：两个请求都出了门，第二个被唯一索引挡下。
      // 这不是失败——分类已经建好了，弹一句红字反而让人以为没建成，再去点第三次。
      // 先看本地（第一次请求的结果可能已经落到 state 里），本地没有就同步一次再找，
      // 都找不到才是真的失败。
      if (api.isDuplicateName(e)) {
        const local = findSame()
        if (local) return await reuse(local)
        await pullAfterWrite(get)
        const synced = findSame()
        if (synced) return await reuse(synced)
      }
      get().showToast(`新增分类失败：${api.friendlyError(e)}`)
      return null
    }
  },

  async updateCategory(id, patch) {
    const before = get().categories.find((c) => c.id === id)
    const after = before ? { ...before, ...patch } : undefined
    if (after) pendingCat.set(id, after)
    set((s) => ({ categories: s.categories.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))
    try {
      await api.updateCategory(id, patch)
      settle(settledCat, pendingCat, id)
      get().persist()
      return true
    } catch (e) {
      drop(settledCat, pendingCat, id)
      if (before) set((s) => ({ categories: s.categories.map((c) => (c.id === id ? before : c)) }))
      get().showToast(`修改分类失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async updateAccount(id, patch) {
    const before = get().accounts.find((a) => a.id === id)
    set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? { ...a, ...patch } : a)) }))
    try {
      await api.updateAccount(id, patch)
      get().persist()
      return true
    } catch (e) {
      if (before) set((s) => ({ accounts: s.accounts.map((a) => (a.id === id ? before : a)) }))
      get().showToast(`修改账户失败：${api.friendlyError(e)}`)
      return false
    }
  },

  async importSnapshot(snap) {
    try {
      await api.importAll(snap)
    } finally {
      // importAll 每 500 条一批逐批提交，失败时前面的批次已经在云端了。
      // 不管成败都把界面拉到云端真实状态，否则用户看到的是「什么都没发生」。
      await pullAfterWrite(get)
    }
  },

  async restoreSnapshot(snap) {
    // 回滚底稿。wipeAll 一执行，云端就没有第二份了，所以先把「操作前的样子」留在内存里。
    // 它只是本机现在显示的样子：本次会话没同步成功过的话，它可能比云端少几条——
    // 页面在确认框里已经就这一点提醒过用户（Settings.tsx 的 exportTrustworthy 那段）。
    const before: Snapshot = { accounts: get().accounts, categories: get().categories, transactions: get().transactions }
    const hadData = before.accounts.length > 0 || before.categories.length > 0 || before.transactions.length > 0
    try {
      await api.wipeAll()
      await api.importAll(snap)
    } catch (e) {
      const why = api.friendlyError(e)
      // wipeAll 的第一句就失败 = 云端还没被动过，没什么可回滚的，也别吓唬人
      if ((e as Partial<api.WipeFailure>).step === 'transactions') {
        throw new RestoreFailed(`恢复失败：${why}。云端一条数据都没删，账本还是原来的样子，联网之后可以再试一次。`)
      }
      // 到这里云端已经被清空（或清了一半），必须立刻把底稿写回去。
      // importAll 是按 id 的 upsert，重复执行安全；每 500 条一批，不是事务。
      let rollbackErr: string | null = null
      if (hadData) {
        try {
          await api.importAll(before)
        } catch (e2) {
          rollbackErr = api.friendlyError(e2)
        }
      }
      throw new RestoreFailed(
        rollbackErr === null
          ? `恢复失败：${why}。你的账本已经退回操作前的样子，没有丢东西。`
          : `恢复失败：${why}。自动退回也没成功（${rollbackErr}），云端现在可能只有一部分数据。` +
            '别在这个页面上做别的操作：手机里那个备份文件先别删，等有网了回到这一页，用同一个文件再走一次「整库恢复」——' +
            '同一个文件重复导入是安全的，不会变成两份。',
      )
    } finally {
      await pullAfterWrite(get)
    }
  },

  setMode(m) {
    if (get().mode !== m) set({ mode: m })
  },

  noteHidden() {
    hiddenAt = Date.now()
  },

  noteVisible() {
    // 你在里页面时最常做的事恰恰是切去银行 App 查余额再切回来，所以「一切走就回外」太烦；
    // 但要是把手机放下走开了，回来时它得已经变回外页面。60 秒是这两件事的折中。
    if (get().mode === 'inner' && hiddenAt !== null && Date.now() - hiddenAt >= INNER_TTL_MS) {
      set({ mode: 'outer' })
    }
    hiddenAt = null
  },

  showToast(msg, undo) {
    if (toastTimer) clearTimeout(toastTimer)
    const id = ++toastSeq
    set({ toast: { id, msg, undo } })
    toastTimer = setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null })
    }, 5000)
  },

  hideToast() {
    if (toastTimer) clearTimeout(toastTimer)
    set({ toast: null })
  },
}))

// ---------- 便捷选择器 ----------

export function useActiveAccounts(): Account[] {
  const accounts = useStore((s) => s.accounts)
  // 不加 useMemo 的话每次 render 都产出新数组，会打穿五个页面里依赖它的 useMemo，
  // 其中 balanceSeries 每次都要整份复制并排序全部流水。
  // 注意：filter 必须在 sort 之前，否则 sort 会原地改 store 里的数组。
  return useMemo(() => accounts.filter((a) => !a.is_archived).sort((a, b) => a.sort - b.sort), [accounts])
}
