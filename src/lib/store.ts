// 全局状态。页面只从这里读数据、只调这里的动作；这里是唯一调用 api.ts 的地方。
import { useMemo } from 'react'
import { create } from 'zustand'
import type { Account, CatKind, Category, Snapshot, Transaction } from '../types'
import * as api from './api'
import { nowIso } from './date'
import { applyPending, DELETED, type Pending } from './pending'

const CACHE_KEY = 'jz_cache_v1'

interface Cache extends Snapshot {
  at: string
}

function readCache(): Cache | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as Cache
    if (!Array.isArray(c.accounts) || !Array.isArray(c.categories) || !Array.isArray(c.transactions)) return null
    return c
  } catch {
    return null
  }
}

/**
 * 写缓存。只写三张表，不要把整个 store 展开进来（否则 auth/syncing/toast 也会被写）。
 * 返回写入的字符数；浏览器按 UTF-16 计配额，字节数 = 字符数 × 2。
 * 抛错交给调用方处理，不再静默吞掉。
 */
function writeCache(s: Snapshot): number {
  const c: Cache = { accounts: s.accounts, categories: s.categories, transactions: s.transactions, at: nowIso() }
  const json = JSON.stringify(c)
  localStorage.setItem(CACHE_KEY, json)
  return CACHE_KEY.length + json.length
}

/** localStorage 的大致上限（5 MiB，按 UTF-16 字节算） */
export const CACHE_LIMIT_BYTES = 5 * 1024 * 1024

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

  init: () => Promise<void>
  refresh: () => Promise<void>
  /** 去抖写入本机缓存，从当前 state 现读，不接受外部快照 */
  persist: () => void
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>

  addTx: (t: Transaction) => Promise<boolean>
  editTx: (t: Transaction) => Promise<boolean>
  removeTx: (id: string) => Promise<boolean>

  addCategory: (kind: CatKind, parentId: string | null, name: string) => Promise<Category | null>
  updateCategory: (id: string, patch: Partial<Pick<Category, 'name' | 'icon' | 'sort' | 'is_archived' | 'note' | 'parent_id'>>) => Promise<boolean>
  updateAccount: (id: string, patch: Partial<Pick<Account, 'name' | 'sort' | 'is_archived'>>) => Promise<boolean>
  /** 合并导入：同 id 覆盖，不删任何东西 */
  importSnapshot: (snap: Snapshot) => Promise<void>
  /**
   * 整库恢复：先清空云端再整份写入。调用方必须已经跟用户确认过，且 snap 必须过了 validate.ts。
   * 中途失败会拿操作前的快照自动回滚一次，失败时抛的是 RestoreFailed，message 可直接显示。
   */
  restoreSnapshot: (snap: Snapshot) => Promise<void>

  showToast: (msg: string, undo?: () => void | Promise<void>) => void
  hideToast: () => void
}

// ── 在途写入的补丁表 ──────────────────────────────────────────
// 一次写请求飞在路上时，refresh() 拉回的快照里还没有它。直接 set 会把它冲掉，
// 用户看到「刚记的那笔消失了」而实际上云端已经存了，很容易重记一遍。
// 所以 refresh 落地前先把在途补丁叠回去。
const pendingTx: Pending<Transaction> = new Map()
const pendingCat: Pending<Category> = new Map()

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

  async init() {
    const cache = readCache()
    if (cache) {
      set({ accounts: cache.accounts, categories: cache.categories, transactions: cache.transactions, lastSync: cache.at })
      try {
        set({ cacheBytes: (CACHE_KEY.length + (localStorage.getItem(CACHE_KEY)?.length ?? 0)) * 2 })
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
        transactions: applyPending(snap.transactions, pendingTx),
      }
      set({ ...merged, loaded: true, lastSync: nowIso(), syncFailed: false })
      get().persist()
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

  persist() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      const { accounts, categories, transactions } = get()
      try {
        const bytes = writeCache({ accounts, categories, transactions }) * 2
        set({ cacheBytes: bytes, cacheDegraded: false })
      } catch {
        // 配额满或被禁用。云端数据不受影响，但离线看到的会是旧的，必须让用户知道
        if (!get().cacheDegraded) {
          set({ cacheDegraded: true })
          get().showToast('本机缓存已满，离线时看到的可能是旧数据')
        }
      }
    }, 500)
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
    try {
      localStorage.removeItem(CACHE_KEY)
    } catch {
      /* ignore */
    }
    set({ auth: 'out', accounts: [], categories: [], transactions: [], loaded: false, lastSync: null, cacheBytes: 0, cacheDegraded: false, syncFailed: false, syncing: false, syncingSince: null })
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
      // 失败必须立刻删：留着的话那份旧快照落地时会把一条根本没进云端的记录塞回来，
      // 用户明明看到「保存失败」，账本里却多出一笔幽灵记录
      drop(settledTx, pendingTx, t.id)
      set((s) => ({ transactions: s.transactions.filter((x) => x.id !== t.id) }))
      get().persist()
      get().showToast(`保存失败：${api.friendlyError(e)}`)
      return false
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
      drop(settledTx, pendingTx, t.id)
      // 用 map 换回旧值而不是插回去：这条可能已被并发删除，插回去会让它复活
      if (before) set((s) => ({ transactions: s.transactions.map((x) => (x.id === t.id ? before : x)) }))
      get().persist()
      get().showToast(`修改失败：${api.friendlyError(e)}`)
      return false
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
      drop(settledTx, pendingTx, id)
      // 位置无所谓：列表都靠 groupByDay/sortTxs 重排。但要幂等，
      // 万一 refresh 已经把它拉回来了，不能插成两条
      if (row) set((s) => (s.transactions.some((x) => x.id === id) ? s : { transactions: [row, ...s.transactions] }))
      get().persist()
      get().showToast(`删除失败：${api.friendlyError(e)}`)
      return false
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
